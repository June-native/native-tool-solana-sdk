/**
 * Native pAMM Solana Swap SDK
 *
 * External taker-side integration for the Native pAMM (Solana) program:
 * turn a token pair + amount into an on-chain `quote_exact_in` view call or a
 * signed `swap_exact_in` transaction and submit it.
 *
 * Target instructions (from pamm_solana/pamm.json IDL, program
 * 7peHVBaaUoTikbuWKn8j2JtNz5dq6AXvQVkaLTgnKVME):
 *
 *   - `quote_exact_in` (read-only view, u64 gross_amount_in):
 *       simulates the instruction and decodes the u64 amount-out return data;
 *   - `swap_exact_in` (u64 gross_amount_in, u64 min_amount_out):
 *       17 accounts in strict IDL order; direction is decided by the
 *       seller/buyer mint accounts, never by the amount.
 *
 * The SDK is generic:
 *   - pAMM / credit-vault program ids default to the devnet deployment and
 *     are overridable via `options.programIds`;
 *   - all PDAs (config, pool authority, engine, markets, market authorities,
 *     credit pool config) and both custody / user token accounts are derived
 *     locally, mirroring the PDA layout of the backend interaction doc;
 *   - missing user token accounts (including wSOL wrap + syncNative) are
 *     prepared inside the same transaction, so a funded wallet is enough.
 *
 * Typical usage:
 *
 *   const out = await quoteExactIn({ connection, sellerMint, buyerMint, grossAmountIn });
 *   const signature = await executeSwapExactIn({
 *     connection,
 *     payerPublicKey: wallet.publicKey,
 *     signTransaction: signTransactionWithKeypair(walletKeypair),
 *     sellerMint, buyerMint, grossAmountIn,
 *     minAmountOut,               // or slippageBps
 *   });
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Devnet deployments (see pamm_solana/CreditVault V2 pAMM 后端交互文档.md §1).
export const DEFAULT_PAMM_PROGRAM_ID = new PublicKey(
  "7peHVBaaUoTikbuWKn8j2JtNz5dq6AXvQVkaLTgnKVME",
);
export const DEFAULT_CREDIT_VAULT_PROGRAM_ID = new PublicKey(
  "HbKHd4zbjhyiAxGunPfVpvNVVfv8ohN7NfcyfuybND1U",
);

// Wrapped SOL mint: native SOL trades through the wSOL mint on pAMM.
export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112",
);

// Fee-payer placeholder for wallet-less quote simulations: any funded
// system-owned on-curve account satisfies the simulation runtime. This is the
// Native devnet demo wallet; nothing is ever signed with it.
const DEFAULT_SIMULATION_PAYER = new PublicKey(
  "5tWEJXrdQdYReTN7uenQVrRzwuro1X7DFtS1VxEicwrN",
);

// PDA seeds (mirror the pAMM / credit-vault on-chain constants).
const CONFIG_SEED = "config";
const POOL_AUTHORITY_SEED = "pool_authority";
const ENGINE_SEED = "engine";
const MARKET_SEED = "market";
const MARKET_AUTHORITY_SEED = "market_authority";
const CREDIT_POOL_SEED = "credit_pool";

// Anchor discriminators: sha256("global:<ix_name>")[0..8] from the IDL.
const QUOTE_EXACT_IN_DISCRIMINATOR = [55, 146, 194, 181, 17, 72, 227, 19];
const SWAP_EXACT_IN_DISCRIMINATOR = [104, 104, 131, 86, 161, 189, 180, 216];

// Instruction data layouts (all little-endian borsh):
//   quote_exact_in: discriminator (8) + gross_amount_in (u64)
//   swap_exact_in:  discriminator (8) + gross_amount_in (u64) + min_amount_out (u64)
const U64_SIZE = 8;

// Engine account data offsets (8-byte discriminator + fields in IDL order):
//   base_mint(32) + quote_mint(32) + base_decimals(1) + quote_decimals(1)
//   + fair_sqrt_price_x96(20) + fees(4+4) + valid_until_slot(8) + ...
const ENGINE_VALID_UNTIL_SLOT_OFFSET = 8 + 32 + 32 + 1 + 1 + 20 + 4 + 4;
const ENGINE_VALID_UNTIL_SLOT_SIZE = 8;

// Base-fee headroom for one swap transaction (legacy tx base fee is 5,000
// lamports; headroom covers signature-verify costs of the extra prepare
// instructions). ATA rent is budgeted separately per created account.
const SOL_FEE_BUFFER = 20_000n; // lamports
// Lamports wrapped on top of the exact input when topping up wSOL, so
// rounding/rent movements cannot underfund the swap. Stays in the wSOL ATA as
// the user's balance (not a fee).
const WRAP_BUFFER_LAMPORTS = 5_000_000n;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pda(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function toPublicKey(value, label) {
  try {
    return new PublicKey(value);
  } catch (err) {
    throw new Error(`invalid ${label} public key: ${value} (${err.message})`);
  }
}

function toBigInt(value, label) {
  const v = BigInt(value);
  if (v <= 0n) {
    throw new Error(`${label} must be a positive integer, got ${value}`);
  }
  return v;
}

function writeU64LE(buffer, offset, value) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveProgramIds(programIds = {}) {
  const pammProgramId = programIds.pamm
    ? toPublicKey(programIds.pamm, "options.programIds.pamm")
    : DEFAULT_PAMM_PROGRAM_ID;
  const creditVaultProgramId = programIds.creditVault
    ? toPublicKey(programIds.creditVault, "options.programIds.creditVault")
    : DEFAULT_CREDIT_VAULT_PROGRAM_ID;
  return { pammProgramId, creditVaultProgramId };
}

/**
 * Derive every account needed by quote_exact_in / swap_exact_in:
 * pAMM PDAs, credit-vault PDAs, custody ATAs (held by the per-mint market
 * authority) and the user's associated token accounts.
 */
export function derivePammAccounts({
  takerPublicKey,
  sellerMint,
  buyerMint,
  destinationOwner,
  programIds = {},
}) {
  const { pammProgramId, creditVaultProgramId } = resolveProgramIds(programIds);
  const seller = toPublicKey(sellerMint, "sellerMint");
  const buyer = toPublicKey(buyerMint, "buyerMint");
  if (seller.equals(buyer)) {
    throw new Error("sellerMint and buyerMint must differ");
  }
  const taker = toPublicKey(takerPublicKey, "takerPublicKey");
  const destinationOwnerKey = destinationOwner
    ? toPublicKey(destinationOwner, "destinationOwner")
    : taker;

  // pAMM program PDAs. The engine PDA depends on the pair's base/quote
  // convention, which is resolved asynchronously by the callers (see
  // resolveEngine) and assigned onto the returned object.
  const pammConfig = pda([Buffer.from(CONFIG_SEED)], pammProgramId);
  const poolAuthority = pda(
    [Buffer.from(POOL_AUTHORITY_SEED)],
    pammProgramId,
  );

  // Credit-vault PDAs and custody ATAs.
  const marketOf = (mint) =>
    pda([Buffer.from(MARKET_SEED), mint.toBuffer()], creditVaultProgramId);
  const marketAuthorityOf = (mint) =>
    pda(
      [Buffer.from(MARKET_AUTHORITY_SEED), mint.toBuffer()],
      creditVaultProgramId,
    );
  // Custody ATA: the market authority's token account is a PDA-owner ATA, so
  // allowOwnerOffCurve is required for the derivation.
  const custodyOf = (mint) =>
    getAssociatedTokenAddressSync(
      mint,
      marketAuthorityOf(mint),
      true,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );

  return {
    pammProgramId,
    creditVaultProgramId,
    pammConfig,
    poolAuthority,
    sellerMint: seller,
    buyerMint: buyer,
    sellerMarket: marketOf(seller),
    buyerMarket: marketOf(buyer),
    buyerMarketAuthority: marketAuthorityOf(buyer),
    sellerCustody: custodyOf(seller),
    buyerCustody: custodyOf(buyer),
    vaultConfig: pda([Buffer.from(CONFIG_SEED)], creditVaultProgramId),
    vaultCreditPoolConfig: pda(
      [Buffer.from(CREDIT_POOL_SEED), poolAuthority.toBuffer()],
      creditVaultProgramId,
    ),
    // User token accounts (legacy SPL Token only; pAMM does not accept
    // Token-2022 accounts).
    takerSellerTokenAccount: getAssociatedTokenAddressSync(
      seller,
      taker,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    destinationTokenAccount: getAssociatedTokenAddressSync(
      buyer,
      destinationOwnerKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  };
}

/**
 * Engine base/quote ordering cannot be inferred from the mints alone (the
 * engine PDA is keyed by the pair's initialization convention, e.g. SOL=base /
 * USDC=quote on devnet). The SDK resolves it in this order:
 *
 *   1. explicit `options.pair { baseMint, quoteMint }` (must match the mints);
 *   2. on-chain probe: exactly one of the two candidate engine PDAs exists.
 */
function enginePda(baseMint, quoteMint, pammProgramId) {
  return pda(
    [Buffer.from(ENGINE_SEED), baseMint.toBuffer(), quoteMint.toBuffer()],
    pammProgramId,
  );
}

/**
 * Resolve the engine address for a trade direction. Returns
 * { engine, engineBase, engineQuote }.
 */
async function resolveEngine(connection, seller, buyer, pair, pammProgramId) {
  if (pair?.baseMint && pair?.quoteMint) {
    const base = toPublicKey(pair.baseMint, "options.pair.baseMint");
    const quote = toPublicKey(pair.quoteMint, "options.pair.quoteMint");
    const sellerIsBase = base.equals(seller) && quote.equals(buyer);
    const buyerIsBase = base.equals(buyer) && quote.equals(seller);
    if (!sellerIsBase && !buyerIsBase) {
      throw new Error(
        "options.pair {baseMint, quoteMint} does not match the traded mints",
      );
    }
    return { engine: enginePda(base, quote, pammProgramId), engineBase: base, engineQuote: quote };
  }

  const forward = enginePda(seller, buyer, pammProgramId);
  const reverse = enginePda(buyer, seller, pammProgramId);
  const [forwardInfo, reverseInfo] = await Promise.all([
    connection.getAccountInfo(forward).catch(() => null),
    connection.getAccountInfo(reverse).catch(() => null),
  ]);
  if (forwardInfo && !reverseInfo) {
    return { engine: forward, engineBase: seller, engineQuote: buyer };
  }
  if (reverseInfo && !forwardInfo) {
    return { engine: reverse, engineBase: buyer, engineQuote: seller };
  }
  if (forwardInfo && reverseInfo) {
    throw new Error(
      `ambiguous pair: engines exist for both base/quote orders ` +
        `(${forward.toBase58()} / ${reverse.toBase58()}); pass options.pair explicitly`,
    );
  }
  throw new Error(
    `no engine found for mints ${seller.toBase58()} / ${buyer.toBase58()}; ` +
      "the pair may not be initialized on this program",
  );
}

// ---------------------------------------------------------------------------
// Instruction data encoding
// ---------------------------------------------------------------------------

function encodeQuoteExactInData(grossAmountIn) {
  const data = Buffer.alloc(QUOTE_EXACT_IN_DISCRIMINATOR.length + U64_SIZE);
  Buffer.from(QUOTE_EXACT_IN_DISCRIMINATOR).copy(data, 0);
  writeU64LE(data, QUOTE_EXACT_IN_DISCRIMINATOR.length, grossAmountIn);
  return data;
}

function encodeSwapExactInData(grossAmountIn, minAmountOut) {
  const data = Buffer.alloc(SWAP_EXACT_IN_DISCRIMINATOR.length + U64_SIZE * 2);
  Buffer.from(SWAP_EXACT_IN_DISCRIMINATOR).copy(data, 0);
  writeU64LE(data, SWAP_EXACT_IN_DISCRIMINATOR.length, grossAmountIn);
  writeU64LE(
    data,
    SWAP_EXACT_IN_DISCRIMINATOR.length + U64_SIZE,
    minAmountOut,
  );
  return data;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Read the engine's `valid_until_slot` (the price TTL). A swap after this slot
 * fails with PriceExpired; the upstream should surface this to the user.
 */
export async function fetchEngineValidUntilSlot(connection, engine) {
  const info = await connection.getAccountInfo(toPublicKey(engine, "engine"));
  if (!info) {
    throw new Error(`engine account not found: ${engine.toBase58?.() ?? engine}`);
  }
  if (info.data.length < ENGINE_VALID_UNTIL_SLOT_OFFSET + ENGINE_VALID_UNTIL_SLOT_SIZE) {
    throw new Error(`engine account data too short: ${info.data.length} bytes`);
  }
  return info.data.readBigUInt64LE(ENGINE_VALID_UNTIL_SLOT_OFFSET);
}

async function readTokenBalance(connection, account) {
  const info = await connection.getAccountInfo(account);
  if (!info) {
    return null;
  }
  // SPL token account layout: mint(32) + owner(32) + amount(8).
  return info.data.readBigUInt64LE(64);
}

// ---------------------------------------------------------------------------
// quote_exact_in (view)
// ---------------------------------------------------------------------------

/**
 * Simulate `quote_exact_in` and return the buyer-token raw amount out.
 *
 * The quote does not modify the cursor and is not an execution guarantee:
 * another swap or an updater between quote and swap can move the price; always
 * protect the subsequent swap with `minAmountOut` (see `applySlippage`).
 *
 * @param {Object} params
 * @param {Connection} params.connection Solana RPC connection
 * @param {string|PublicKey} params.sellerMint
 * @param {string|PublicKey} params.buyerMint
 * @param {bigint|number|string} params.grossAmountIn seller token raw amount (incl. fee)
 * @param {Object} [params.options]
 * @param {Object} [params.options.programIds] { pamm, creditVault } overrides
 * @param {{baseMint: string, quoteMint: string}} [params.options.pair] explicit engine pair order
 * @returns {Promise<bigint>} buyer token raw amount out
 */
export async function quoteExactIn({
  connection,
  sellerMint,
  buyerMint,
  grossAmountIn,
  options = {},
}) {
  if (!connection) {
    throw new Error("connection is required");
  }
  const amount = toBigInt(grossAmountIn, "grossAmountIn");
  const seller = toPublicKey(sellerMint, "sellerMint");
  const buyer = toPublicKey(buyerMint, "buyerMint");

  const accounts = derivePammAccounts({
    // The taker is irrelevant for a view call; a throwaway on-curve key lets
    // the ATA derivations run without a wallet.
    takerPublicKey: Keypair.generate().publicKey,
    sellerMint: seller,
    buyerMint: buyer,
    programIds: options.programIds,
  });
  const resolvedEngine = await resolveEngine(
    connection,
    seller,
    buyer,
    options.pair,
    accounts.pammProgramId,
  );
  accounts.engine = resolvedEngine.engine;

  const ix = new TransactionInstruction({
    programId: accounts.pammProgramId,
    keys: [
      { pubkey: accounts.pammConfig, isSigner: false, isWritable: false },
      { pubkey: seller, isSigner: false, isWritable: false },
      { pubkey: buyer, isSigner: false, isWritable: false },
      { pubkey: accounts.engine, isSigner: false, isWritable: false },
    ],
    data: encodeQuoteExactInData(amount),
  });

  // View-style simulation: a VersionedTransaction is required by web3.js when
  // passing a config, and the runtime requires the fee payer to exist on-chain
  // (on-curve, system-owned). sigVerify=false means no real signature is
  // needed, so an arbitrary funded system account works as the simulation-only
  // payer; prefer passing options.simulationPayer (e.g. the user wallet) on
  // clusters where the devnet default below does not exist.
  const simulationPayer = options.simulationPayer
    ? toPublicKey(options.simulationPayer, "options.simulationPayer")
    : DEFAULT_SIMULATION_PAYER;
  const message = new TransactionMessage({
    payerKey: simulationPayer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [ix],
  }).compileToLegacyMessage();
  const simulation = await connection.simulateTransaction(
    new VersionedTransaction(message),
    { sigVerify: false, replaceRecentBlockhash: true },
  );
  if (simulation.value.err) {
    throw new Error(
      `quote_exact_in failed: ${JSON.stringify(simulation.value.err)} ` +
        (simulation.value.logs ?? []).join(" | "),
    );
  }
  const returnData = simulation.value.returnData?.data?.[0];
  if (!returnData) {
    throw new Error("quote_exact_in returned no data");
  }
  const raw = Buffer.from(returnData, "base64");
  if (raw.length !== U64_SIZE) {
    throw new Error(`unexpected quote return size: ${raw.length} bytes`);
  }
  return raw.readBigUInt64LE(0);
}

/**
 * Apply a slippage bound to a quoted amount:
 * minAmountOut = floor(quotedAmountOut * (10_000 - slippageBps) / 10_000).
 */
export function applySlippage(quotedAmountOut, slippageBps) {
  const out = BigInt(quotedAmountOut);
  const bps = BigInt(slippageBps);
  if (bps < 0n || bps >= 10_000n) {
    throw new Error(`slippageBps out of range: ${slippageBps}`);
  }
  return (out * (10_000n - bps)) / 10_000n;
}

// ---------------------------------------------------------------------------
// swap_exact_in: transaction construction
// ---------------------------------------------------------------------------

/**
 * Build a ready-to-sign legacy `swap_exact_in` Transaction.
 *
 * Included preparation (before the swap instruction, in this order):
 *   1. idempotent creation of the destination ATA when missing;
 *   2. idempotent creation of the taker seller ATA when missing;
 *   3. when selling native SOL (seller mint = wSOL): transfer enough lamports
 *      into the wSOL ATA and syncNative so the wrapped balance covers the
 *      gross input.
 *
 * @param {Object} params
 * @param {Connection} params.connection Solana RPC connection
 * @param {string|PublicKey} params.payerPublicKey taker / fee payer
 * @param {string|PublicKey} params.sellerMint
 * @param {string|PublicKey} params.buyerMint
 * @param {bigint|number|string} params.grossAmountIn seller token raw amount (incl. fee)
 * @param {bigint|number|string} [params.minAmountOut] explicit slippage bound (required unless slippageBps given)
 * @param {number|string|bigint} [params.slippageBps=100] used to derive minAmountOut from a fresh quote when minAmountOut is omitted
 * @param {string|PublicKey} [params.destinationOwner] output token owner (default: payer)
 * @param {Object} [params.options]
 * @param {string} [params.options.commitment="confirmed"]
 * @param {boolean} [params.options.preflight=true] balance/TTL checks before building
 * @param {Object} [params.options.programIds] { pamm, creditVault } overrides
 * @param {{baseMint: string, quoteMint: string}} [params.options.pair] explicit engine pair order
 * @param {Object} [params.options.logger=console]
 * @returns {Promise<{transaction: Transaction, quotedAmountOut: bigint, minAmountOut: bigint, accounts: Object}>}
 */
export async function buildSwapExactInTransaction({
  connection,
  payerPublicKey,
  sellerMint,
  buyerMint,
  grossAmountIn,
  minAmountOut,
  slippageBps = 100,
  destinationOwner,
  options = {},
}) {
  const {
    commitment = "confirmed",
    preflight = true,
    programIds = {},
    logger = console,
  } = options;
  if (!connection) {
    throw new Error("connection is required");
  }

  const amountIn = toBigInt(grossAmountIn, "grossAmountIn");
  const seller = toPublicKey(sellerMint, "sellerMint");
  const buyer = toPublicKey(buyerMint, "buyerMint");
  const payer = toPublicKey(payerPublicKey, "payerPublicKey");

  const accounts = derivePammAccounts({
    takerPublicKey: payer,
    sellerMint: seller,
    buyerMint: buyer,
    destinationOwner,
    programIds,
  });
  const resolvedEngine = await resolveEngine(
    connection,
    seller,
    buyer,
    options.pair,
    accounts.pammProgramId,
  );
  accounts.engine = resolvedEngine.engine;

  // Resolve minAmountOut: explicit bound wins; otherwise quote now and apply
  // the slippage bound (the quote is only advisory -- the swap re-prices
  // on-chain against the current engine state).
  let quotedAmountOut = null;
  let minOut;
  if (minAmountOut !== undefined && minAmountOut !== null) {
    minOut = toBigInt(minAmountOut, "minAmountOut");
  } else {
    quotedAmountOut = await quoteExactIn({
      connection,
      sellerMint: seller,
      buyerMint: buyer,
      grossAmountIn: amountIn,
      options,
    });
    minOut = applySlippage(quotedAmountOut, slippageBps);
    if (minOut <= 0n) {
      throw new Error(
        `minAmountOut rounds to zero (quoted ${quotedAmountOut}, slippage ${slippageBps} bps); increase the input amount`,
      );
    }
  }
  logger.log(
    `[build] swap_exact_in gross_in=${amountIn} min_out=${minOut}` +
      (quotedAmountOut !== null ? ` (quoted ${quotedAmountOut})` : ""),
  );

  // --- Preparation instructions -------------------------------------------
  const prepareInstructions = [];
  // Cold-start budgeting: every ATA this transaction creates charges rent
  // (kept in the account, recoverable by closing it) on top of the base fee.
  let atasToCreate = 0n;

  const destinationInfo = await connection.getAccountInfo(
    accounts.destinationTokenAccount,
  );
  if (!destinationInfo) {
    atasToCreate += 1n;
    logger.log(
      `[build] destination ATA missing, will create: ${accounts.destinationTokenAccount.toBase58()}`,
    );
    prepareInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        accounts.destinationTokenAccount,
        destinationOwner ? toPublicKey(destinationOwner, "destinationOwner") : payer,
        buyer,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  const sellerAtaInfo = await connection.getAccountInfo(
    accounts.takerSellerTokenAccount,
  );
  const isNativeSol = seller.equals(WSOL_MINT);
  if (!sellerAtaInfo) {
    atasToCreate += 1n;
    logger.log(
      `[build] seller ATA missing, will create: ${accounts.takerSellerTokenAccount.toBase58()}`,
    );
    prepareInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        accounts.takerSellerTokenAccount,
        payer,
        seller,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  if (isNativeSol) {
    // Top up wrapped SOL to cover the gross input (plus a small wrap buffer)
    // and syncNative so the token balance reflects the lamports.
    const wrapped =
      sellerAtaInfo === null ? 0n : await readTokenBalance(connection, accounts.takerSellerTokenAccount).then((b) => b ?? 0n);
    if (wrapped < amountIn) {
      const topUp = amountIn - wrapped + WRAP_BUFFER_LAMPORTS;
      logger.log(
        `[build] wrapping ${topUp} lamports into wSOL ATA (have ${wrapped}, need ${amountIn})`,
      );
      prepareInstructions.push(
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: accounts.takerSellerTokenAccount,
          lamports: topUp,
        }),
        createSyncNativeInstruction(accounts.takerSellerTokenAccount),
      );
    } else {
      // Existing wrapped balance must be synced only if lamports were added
      // outside this transaction; a plain sync is harmless and cheap.
      prepareInstructions.push(
        createSyncNativeInstruction(accounts.takerSellerTokenAccount),
      );
    }
  }

  // --- Preflight checks ----------------------------------------------------
  if (preflight) {
    // Price TTL: reject swaps that can only land expired.
    const [slot, validUntil] = await Promise.all([
      connection.getSlot(commitment),
      fetchEngineValidUntilSlot(connection, accounts.engine),
    ]);
    if (BigInt(slot) >= validUntil) {
      throw new Error(
        `engine price expired at slot ${validUntil}, current slot ${slot}; ` +
          "wait for the updater to refresh the market",
      );
    }
    logger.log(
      `[preflight] engine price valid for ${validUntil - BigInt(slot)} more slots`,
    );

    // SOL balance for the base fee, ATA rent for accounts this transaction
    // creates, and (native-SOL sells) the wrapped input + wrap buffer.
    const [balance, ataRent] = await Promise.all([
      connection.getBalance(payer, commitment).then(BigInt),
      atasToCreate > 0n
        ? connection.getMinimumBalanceForRentExemption(165).then(BigInt)
        : Promise.resolve(0n),
    ]);
    const minimumRequired =
      SOL_FEE_BUFFER +
      ataRent * atasToCreate +
      (isNativeSol ? amountIn + WRAP_BUFFER_LAMPORTS : 0n);
    if (balance < minimumRequired) {
      throw new Error(
        `insufficient SOL: ${(Number(balance) / 1e9).toFixed(6)} SOL, ` +
          `need at least ${(Number(minimumRequired) / 1e9).toFixed(6)} SOL ` +
          `(base fee + rent for ${atasToCreate} new token account(s)` +
          (isNativeSol ? " + wrapped input" : "") + ")",
      );
    }
    logger.log(
      `[preflight] SOL balance OK: ${(Number(balance) / 1e9).toFixed(6)} SOL ` +
        `(minimum ${(Number(minimumRequired) / 1e9).toFixed(9)} incl. ` +
        `${atasToCreate} ATA rent)`,
    );

    // Seller token balance (non-native sells only; wrapped SOL handled above).
    if (!isNativeSol) {
      const sellerBalance = await readTokenBalance(
        connection,
        accounts.takerSellerTokenAccount,
      );
      if (sellerBalance === null) {
        throw new Error(
          `seller token account does not exist: ${accounts.takerSellerTokenAccount.toBase58()}; ` +
            "fund the wallet's associated token account for the seller mint first " +
            "(native SOL is wrapped automatically; SPL tokens must be held)",
        );
      }
      if (sellerBalance < amountIn) {
        throw new Error(
          `insufficient seller token balance in ${accounts.takerSellerTokenAccount.toBase58()}: ` +
            `${sellerBalance} < ${amountIn}`,
        );
      }
      logger.log(
        `[preflight] seller token balance OK: ${sellerBalance} (need ${amountIn})`,
      );
    }
  }

  // --- swap_exact_in instruction: 17 accounts in strict IDL order ----------
  const swapIx = new TransactionInstruction({
    programId: accounts.pammProgramId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },                     // 1. taker
      { pubkey: accounts.pammConfig, isSigner: false, isWritable: false },     // 2. config
      { pubkey: accounts.poolAuthority, isSigner: false, isWritable: false },  // 3. pool_authority
      { pubkey: seller, isSigner: false, isWritable: false },                  // 4. seller_mint
      { pubkey: buyer, isSigner: false, isWritable: false },                   // 5. buyer_mint
      { pubkey: accounts.engine, isSigner: false, isWritable: true },          // 6. engine
      { pubkey: accounts.takerSellerTokenAccount, isSigner: false, isWritable: true }, // 7. taker_seller_token_account
      { pubkey: accounts.sellerCustody, isSigner: false, isWritable: true },   // 8. seller_custody
      { pubkey: accounts.buyerCustody, isSigner: false, isWritable: true },    // 9. buyer_custody
      { pubkey: accounts.destinationTokenAccount, isSigner: false, isWritable: true }, // 10. destination_token_account
      { pubkey: accounts.vaultConfig, isSigner: false, isWritable: false },    // 11. vault_config
      { pubkey: accounts.vaultCreditPoolConfig, isSigner: false, isWritable: false }, // 12. vault_credit_pool_config
      { pubkey: accounts.sellerMarket, isSigner: false, isWritable: true },    // 13. seller_market
      { pubkey: accounts.buyerMarket, isSigner: false, isWritable: true },     // 14. buyer_market
      { pubkey: accounts.buyerMarketAuthority, isSigner: false, isWritable: false }, // 15. buyer_market_authority
      { pubkey: accounts.creditVaultProgramId, isSigner: false, isWritable: false }, // 16. credit_vault_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // 17. token_program
    ],
    data: encodeSwapExactInData(amountIn, minOut),
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(commitment);
  const tx = new Transaction({ feePayer: payer });
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  // Optional compute budget: priority fee (micro-lamports per CU) and/or an
  // explicit CU limit. Compute-budget instructions must be first.
  const computeBudgetInstructions = [];
  if (options.computeUnitLimit) {
    computeBudgetInstructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: Number(options.computeUnitLimit),
      }),
    );
  }
  if (options.priorityFeeMicroLamports) {
    computeBudgetInstructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Number(options.priorityFeeMicroLamports),
      }),
    );
  }
  tx.add(...computeBudgetInstructions, ...prepareInstructions, swapIx);

  logger.log(
    `[build] transaction built with ${tx.instructions.length} instructions ` +
      `(pamm=${accounts.pammProgramId.toBase58()}, ` +
      `creditVault=${accounts.creditVaultProgramId.toBase58()}, ` +
      `engine=${accounts.engine.toBase58()})`,
  );
  return { transaction: tx, quotedAmountOut, minAmountOut: minOut, accounts };
}

// ---------------------------------------------------------------------------
// swap_exact_in: execution
// ---------------------------------------------------------------------------

/**
 * Sign, send and confirm a `swap_exact_in` transaction, returning its
 * signature.
 *
 * Retry is bounded (maxTxAttempts) and only re-sends after a blockhash expiry
 * when the previous attempt provably did NOT land: the previous signature is
 * polled via getSignatureStatus with history search first. swap_exact_in has
 * no replay-protection account, so a landed-but-unconfirmed transaction is
 * waited on rather than re-sent.
 *
 * @param {Object} params Same arguments as buildSwapExactInTransaction plus
 * @param {Function} params.signTransaction wallet callback: async (tx) => signed tx
 * @param {Object} [params.options]
 * @param {number} [params.options.maxConfirmRetries=120] confirm poll attempts (1s apart)
 * @param {number} [params.options.maxTxAttempts=3] send attempts on blockhash expiry
 * @param {boolean} [params.options.skipPreflight=false]
 * @returns {Promise<string>} transaction signature
 */
export async function executeSwapExactIn({
  connection,
  signTransaction,
  payerPublicKey,
  sellerMint,
  buyerMint,
  grossAmountIn,
  minAmountOut,
  slippageBps,
  destinationOwner,
  options = {},
}) {
  const {
    commitment = "confirmed",
    maxConfirmRetries = 120,
    maxTxAttempts = 3,
    skipPreflight = false,
    simulateFirst = true,
    logger = console,
  } = options;
  if (typeof signTransaction !== "function") {
    throw new Error("signTransaction callback is required");
  }

  const built = await buildSwapExactInTransaction({
    connection,
    payerPublicKey,
    sellerMint,
    buyerMint,
    grossAmountIn,
    minAmountOut,
    slippageBps,
    destinationOwner,
    options: { ...options, preflight: !skipPreflight },
  });
  const tx = built.transaction;
  logger.log(
    `[execute] min_amount_out=${built.minAmountOut}` +
      (built.quotedAmountOut !== null ? ` (quoted ${built.quotedAmountOut})` : ""),
  );

  let lastSignature = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxTxAttempts; attempt++) {
    if (attempt > 1 && lastSignature) {
      logger.log(`[execute] checking whether previous tx landed...`);
      let resolved = false;
      for (let check = 0; check < 30 && !resolved; check++) {
        const status = await connection
          .getSignatureStatus(lastSignature, { searchTransactionHistory: true })
          .catch(() => null);
        if (status?.value) {
          if (status.value.err) {
            throw new Error(
              `previous transaction failed on-chain: ${JSON.stringify(status.value.err)}`,
            );
          }
          if (
            status.value.confirmationStatus === "confirmed" ||
            status.value.confirmationStatus === "finalized"
          ) {
            logger.log(`[execute] previous tx confirmed: ${lastSignature}`);
            return lastSignature;
          }
          // processed: already in a block; re-sending could double-swap.
          resolved = true;
        } else {
          await sleep(1000);
        }
      }
      if (!resolved) {
        lastError = new Error(
          `previous tx status unknown within the poll window: ${lastSignature}`,
        );
        throw lastError;
      }
      // A "processed" tx that dropped out of the poll above falls through to
      // the confirm wait below; only an expired-blockhash absence re-sends.
    }

    // Fresh blockhash per attempt (the signature covers it).
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash(commitment);
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;

    const signed = await signTransaction(tx);

    // Estimate gate (mirror of the pammengine send path): simulate the exact
    // signed payload BEFORE broadcasting. A simulation failure (expired price,
    // slippage, unfunded account, ...) means the tx would revert on-chain and
    // burn the base fee -- it is never sent. unitsConsumed is surfaced so the
    // caller can size computeUnitLimit / priority fees.
    if (simulateFirst) {
      const wireTx = VersionedTransaction.deserialize(signed.serialize());
      const simulation = await connection
        .simulateTransaction(wireTx, { sigVerify: true })
        .catch((err) => {
          logger.log(`[execute] simulate RPC error (continuing): ${err.message}`);
          return null;
        });
      if (simulation?.value?.err) {
        throw new Error(
          `simulation failed, not broadcasting (no fee spent): ` +
            `${JSON.stringify(simulation.value.err)} ` +
            (simulation.value.logs ?? []).slice(-5).join(" | "),
        );
      }
      if (simulation?.value?.unitsConsumed) {
        logger.log(
          `[execute] simulated OK, compute units: ${simulation.value.unitsConsumed}`,
        );
      }
    }

    let signature;
    try {
      signature = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
        maxRetries: 5,
      });
    } catch (sendErr) {
      // RPC preflight rejection (e.g. the engine TTL lapsed between our
      // simulate gate and this send): nothing was broadcast, no fee spent.
      const logs = sendErr.transactionLogs ?? sendErr.logs ?? [];
      throw new Error(
        `send rejected by RPC preflight (not broadcast, no fee spent): ` +
          `${sendErr.transactionMessage ?? sendErr.message}` +
          (logs.length ? `\n${logs.join("\n")}` : ""),
        { cause: sendErr },
      );
    }
    lastSignature = signature;
    logger.log(`[execute] tx sent: ${signature}`);

    for (let i = 0; i < maxConfirmRetries; i++) {
      let status = null;
      try {
        status = await connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });
      } catch (pollErr) {
        logger.log(`[execute] poll error (retrying): ${pollErr.message}`);
      }

      if (status?.value) {
        if (status.value.err) {
          throw new Error(
            `transaction failed on-chain: ${JSON.stringify(status.value.err)}`,
          );
        }
        if (
          status.value.confirmationStatus === "confirmed" ||
          status.value.confirmationStatus === "finalized"
        ) {
          logger.log(
            `[execute] confirmed at slot ${status.value.slot}: ${signature}`,
          );
          return signature;
        }
      }

      const currentHeight = await connection
        .getBlockHeight(commitment)
        .catch(() => 0);
      if (currentHeight > lastValidBlockHeight) {
        lastError = new Error(
          `blockhash expired: currentHeight=${currentHeight}, lastValidBlockHeight=${lastValidBlockHeight}`,
        );
        break;
      }
      await sleep(1000);
    }
    logger.log(
      `[execute] attempt ${attempt}/${maxTxAttempts} not confirmed, will retry`,
    );
  }

  throw lastError ?? new Error("transaction not confirmed within retry budget");
}

// ---------------------------------------------------------------------------
// Wallet helpers
// ---------------------------------------------------------------------------

/**
 * Create a `signTransaction` callback from a Keypair.
 *
 * @param {Keypair} keypair
 * @returns {(tx: Transaction) => Promise<Transaction>}
 */
export function signTransactionWithKeypair(keypair) {
  return async (tx) => {
    tx.sign(keypair);
    return tx;
  };
}
