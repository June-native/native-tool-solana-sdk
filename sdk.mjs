/**
 * Native Solana Compact RFQ Swap SDK
 *
 * Converts a Native `/swap-api-v2/v1/firm-quote` response into a signed Solana
 * transaction and submits it on-chain. Targets the `trade_rfq_compact`
 * instruction:
 *
 *   - a single Ed25519 precompile instruction (native/backend signer) is placed
 *     immediately before the swap instruction (the program reads the signature
 *     from `current_instruction_index - 1` via the instructions sysvar);
 *   - replay protection is keyed by a `quote` PDA derived from `quote_id`
 *     (no per-MM nonce; the deadline is bound into the signed quote message
 *     and enforced on-chain);
 *   - the trade_rfq_compact instruction carries 26 account metas, which fit a
 *     legacy transaction, so no Address Lookup Table is required.
 *
 * The SDK is generic:
 *   - RFQ program id comes from `quoteResponse.txRequest.target`;
 *   - credit-vault program id is resolved on-chain from the RFQ `config` PDA
 *     (overridable via `options.programIds.creditVault`);
 *   - token programs (SPL Token / Token-2022) are read from the on-chain mint
 *     accounts, and the associated token accounts are derived accordingly.
 *
 * Typical usage:
 *
 *   const signature = await executeSolanaSwap({
 *     connection,
 *     quoteResponse,
 *     payerPublicKey: wallet.publicKey,
 *     signTransaction: wallet.signTransaction,
 *   });
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Native SOL marker addresses used by the EVM-style API for "native" tokens.
const NATIVE_SOL_MARKERS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);
// Wrapped SOL mint, the on-chain representation of native SOL.
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
// Ed25519 signature verification precompile.
const ED25519_PROGRAM_ID = new PublicKey(
  "Ed25519SigVerify111111111111111111111111111",
);
// Instructions sysvar: used by trade_rfq_compact to locate the Ed25519 ix.
const SYSVAR_INSTRUCTIONS_PUBKEY = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111",
);
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

// PDA seeds (mirror solana-core/programs/{rfq,credit-vault}/src/constants.rs).
const CONFIG_SEED = "config";
const POOL_AUTHORITY_SEED = "pool_authority";
const SIGNER_SEED = "signer";
const QUOTE_SEED = "quote";
const MARKET_SEED = "market";
const MARKET_AUTHORITY_SEED = "market_authority";
const POSITION_SEED = "position";
const CREDIT_POOL_SEED = "credit_pool";

// trade_rfq_compact Anchor discriminator: sha256("global:trade_rfq_compact")[0..8].
const TRADE_RFQ_COMPACT_DISCRIMINATOR = [9, 232, 94, 39, 135, 136, 245, 42];
// RFQ `Config` account discriminator (from solana-core/idl/rfq.json).
const RFQ_CONFIG_DISCRIMINATOR = [155, 12, 170, 224, 30, 250, 204, 130];

// trade_rfq_compact instruction data layout (all little-endian):
//   discriminator (8) + quote_id (16) + seller_amount (8) + buyer_amount (8)
//   + deadline (4) + seller_input_mode (1) = 45 bytes total.
const TRADE_RFQ_QUOTE_ID_OFFSET = 8;
const TRADE_RFQ_SELLER_AMOUNT_OFFSET = 8 + 16;
const TRADE_RFQ_BUYER_AMOUNT_OFFSET = 8 + 16 + 8;
const TRADE_RFQ_DEADLINE_OFFSET = 8 + 16 + 8 + 8;
const TRADE_RFQ_SELLER_INPUT_MODE_OFFSET = 8 + 16 + 8 + 8 + 4;

// SellerInputMode enum values (mirror SellerInputMode in rfq/src/lib.rs).
const SELLER_INPUT_MODE_TOKEN_ACCOUNT = 0;
const SELLER_INPUT_MODE_NATIVE_SOL = 1;

// Offset of `credit_vault_program` inside the RFQ Config account data:
// 8 (discriminator) + admin(32) + pending_admin(32) + signer(32).
const RFQ_CONFIG_CREDIT_VAULT_OFFSET = 8 + 32 * 3;

// SPL token account data layout: mint(32) + owner(32) + amount(8) -> amount at
// offset 64. Shared by SPL Token and Token-2022.
const SPL_TOKEN_ACCOUNT_AMOUNT_OFFSET = 32 + 32;

// Estimated SOL cost besides the traded amount, covering the worst case of a
// single transaction: base fee (~10k) + rent for the used_quote PDA
// (~1,064,880) + rent for the taker_seller_ata when it must be created in the
// same transaction (~2,039,280). Kept with headroom so the preflight balance
// check never passes while the actual on-chain cost would exceed it.
const SOL_FEE_BUFFER = 0.0035 * 1e9; // lamports

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

/**
 * Map an API token identifier to its Solana mint. EVM-style native SOL markers
 * (0x000...000 / 0xeee...eee) resolve to the WSOL mint.
 */
function resolveNativeMint(token) {
  if (typeof token === "string" && NATIVE_SOL_MARKERS.has(token.toLowerCase())) {
    return WSOL_MINT;
  }
  return toPublicKey(token, "token");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the backend calldata blob (ed25519_ix_data ++ trade_rfq_compact_data)
 * into its two instruction payloads plus the trade_rfq_compact scalar args.
 *
 * The Ed25519 instruction header layout is:
 *   num_signatures(1) + padding(1) + signature_offset(2) +
 *   signature_instruction_index(2) + public_key_offset(2) +
 *   public_key_instruction_index(2) + message_data_offset(2) +
 *   message_data_size(2) + message_instruction_index(2)
 */
function parseCompactCalldata(calldata) {
  if (calldata.length < 2) {
    throw new Error("calldata too short");
  }
  const numSignatures = calldata[0];
  if (numSignatures !== 1) {
    throw new Error(
      `unexpected Ed25519 signature count: ${numSignatures}; ` +
        "expected 1 (compact RFQ uses a single native signer)",
    );
  }
  const msgOffset = calldata.readUInt16LE(10);
  const msgSize = calldata.readUInt16LE(12);
  const ed25519IxData = calldata.subarray(0, msgOffset + msgSize);
  if (ed25519IxData.length >= calldata.length) {
    throw new Error(
      "invalid calldata: no trade_rfq_compact data follows the Ed25519 instruction",
    );
  }

  const tradeRfqData = calldata.subarray(ed25519IxData.length);
  if (tradeRfqData.length < TRADE_RFQ_SELLER_INPUT_MODE_OFFSET + 1) {
    throw new Error(
      `trade_rfq_compact data too short: ${tradeRfqData.length} bytes`,
    );
  }
  for (let i = 0; i < TRADE_RFQ_COMPACT_DISCRIMINATOR.length; i++) {
    if (tradeRfqData[i] !== TRADE_RFQ_COMPACT_DISCRIMINATOR[i]) {
      throw new Error(
        "trade_rfq_compact discriminator mismatch; is this a compact-RFQ quote?",
      );
    }
  }

  return {
    ed25519IxData,
    tradeRfqData,
    quoteId: tradeRfqData.subarray(
      TRADE_RFQ_QUOTE_ID_OFFSET,
      TRADE_RFQ_QUOTE_ID_OFFSET + 16,
    ),
    sellerAmount: tradeRfqData.readBigUInt64LE(TRADE_RFQ_SELLER_AMOUNT_OFFSET),
    buyerAmount: tradeRfqData.readBigUInt64LE(TRADE_RFQ_BUYER_AMOUNT_OFFSET),
    deadline: tradeRfqData.readUInt32LE(TRADE_RFQ_DEADLINE_OFFSET),
    sellerInputMode: tradeRfqData[TRADE_RFQ_SELLER_INPUT_MODE_OFFSET],
  };
}

/**
 * Read the credit-vault program id stored in the RFQ `config` PDA. This keeps
 * the SDK aligned with whatever credit-vault deployment the RFQ program was
 * initialized against (devnet / mainnet / local).
 */
async function readCreditVaultProgram(connection, rfqConfigPda) {
  const info = await connection.getAccountInfo(rfqConfigPda);
  if (!info) {
    throw new Error(
      `RFQ config account not initialized: ${rfqConfigPda.toBase58()}. ` +
        "The RFQ program may not be configured on this cluster.",
    );
  }
  if (info.data.length < RFQ_CONFIG_CREDIT_VAULT_OFFSET + 32) {
    throw new Error(
      `RFQ config account data too short: ${info.data.length} bytes`,
    );
  }
  for (let i = 0; i < RFQ_CONFIG_DISCRIMINATOR.length; i++) {
    if (info.data[i] !== RFQ_CONFIG_DISCRIMINATOR[i]) {
      throw new Error(
        `unexpected RFQ config discriminator at ${rfqConfigPda.toBase58()}`,
      );
    }
  }
  return new PublicKey(
    info.data.subarray(
      RFQ_CONFIG_CREDIT_VAULT_OFFSET,
      RFQ_CONFIG_CREDIT_VAULT_OFFSET + 32,
    ),
  );
}

/**
 * Read the token program that owns a mint (SPL Token or Token-2022).
 */
async function readTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint);
  if (!info) {
    throw new Error(`mint account not found: ${mint.toBase58()}`);
  }
  return info.owner;
}

/**
 * Read an SPL token account balance. `null` when the account does not exist.
 * Shared parsing works for both SPL Token and Token-2022 token accounts.
 */
async function readTokenBalance(connection, account) {
  const info = await connection.getAccountInfo(account);
  if (!info) {
    return null;
  }
  if (info.data.length < SPL_TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) {
    throw new Error(`token account data too short: ${account.toBase58()}`);
  }
  return info.data.readBigUInt64LE(SPL_TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

/**
 * Derive every account (PDAs, ATAs, token programs) needed by the
 * trade_rfq_compact transaction.
 */
async function deriveAccounts({ connection, order, payerPublicKey, programIds }) {
  const mmSigner = toPublicKey(order.signer, "order.signer");
  const recipient = toPublicKey(order.recipient, "order.recipient");
  const sellerMint = resolveNativeMint(order.sellerToken);
  const buyerMint = toPublicKey(order.buyerToken, "order.buyerToken");

  // RFQ program id: explicit override > txRequest.target > order.pool.
  let rfqProgramId;
  if (programIds.rfq) {
    rfqProgramId = toPublicKey(programIds.rfq, "options.programIds.rfq");
  } else if (order.pool) {
    rfqProgramId = toPublicKey(order.pool, "order.pool");
  } else {
    throw new Error(
      "RFQ program id not found: provide options.programIds.rfq or order.pool",
    );
  }

  // RFQ-program PDAs.
  const rfqConfigPda = pda([Buffer.from(CONFIG_SEED)], rfqProgramId);
  const poolAuthority = pda(
    [Buffer.from(POOL_AUTHORITY_SEED)],
    rfqProgramId,
  );
  const mmSignerConfig = pda(
    [Buffer.from(SIGNER_SEED), mmSigner.toBuffer()],
    rfqProgramId,
  );

  // Credit-vault program id: explicit override > on-chain RFQ config.
  const creditVaultProgramId = programIds.creditVault
    ? toPublicKey(programIds.creditVault, "options.programIds.creditVault")
    : await readCreditVaultProgram(connection, rfqConfigPda);

  // Credit-vault PDAs.
  const sellerMarket = pda(
    [Buffer.from(MARKET_SEED), sellerMint.toBuffer()],
    creditVaultProgramId,
  );
  const buyerMarket = pda(
    [Buffer.from(MARKET_SEED), buyerMint.toBuffer()],
    creditVaultProgramId,
  );
  const sellerMarketAuthority = pda(
    [Buffer.from(MARKET_AUTHORITY_SEED), sellerMint.toBuffer()],
    creditVaultProgramId,
  );
  const buyerMarketAuthority = pda(
    [Buffer.from(MARKET_AUTHORITY_SEED), buyerMint.toBuffer()],
    creditVaultProgramId,
  );
  const vaultConfig = pda(
    [Buffer.from(CONFIG_SEED)],
    creditVaultProgramId,
  );
  const creditPoolConfig = pda(
    [Buffer.from(CREDIT_POOL_SEED), poolAuthority.toBuffer()],
    creditVaultProgramId,
  );
  // trader_position is keyed by the mm_signer (trader), not the taker.
  const sellerTraderPosition = pda(
    [Buffer.from(POSITION_SEED), mmSigner.toBuffer(), sellerMint.toBuffer()],
    creditVaultProgramId,
  );
  const buyerTraderPosition = pda(
    [Buffer.from(POSITION_SEED), mmSigner.toBuffer(), buyerMint.toBuffer()],
    creditVaultProgramId,
  );

  // Token programs (read from on-chain mint owners).
  const sellerTokenProgram = await readTokenProgram(connection, sellerMint);
  const buyerTokenProgram = await readTokenProgram(connection, buyerMint);

  // Associated token accounts.
  const takerSellerAta = getAssociatedTokenAddressSync(
    sellerMint,
    payerPublicKey,
    false,
    sellerTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const sellerCustodyAta = getAssociatedTokenAddressSync(
    sellerMint,
    sellerMarketAuthority,
    true,
    sellerTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const buyerCustodyAta = getAssociatedTokenAddressSync(
    buyerMint,
    buyerMarketAuthority,
    true,
    buyerTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const recipientBuyerAta = getAssociatedTokenAddressSync(
    buyerMint,
    recipient,
    false,
    buyerTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  return {
    mmSigner,
    recipient,
    sellerMint,
    buyerMint,
    rfqProgramId,
    creditVaultProgramId,
    rfqConfigPda,
    poolAuthority,
    mmSignerConfig,
    sellerMarket,
    buyerMarket,
    sellerMarketAuthority,
    buyerMarketAuthority,
    vaultConfig,
    creditPoolConfig,
    sellerTraderPosition,
    buyerTraderPosition,
    sellerTokenProgram,
    buyerTokenProgram,
    takerSellerAta,
    sellerCustodyAta,
    buyerCustodyAta,
    recipientBuyerAta,
  };
}

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

/**
 * Run sanity checks before spending any transaction fees:
 *   1. the quote signer is authorized and enabled on-chain;
 *   2. the payer has enough SOL (fees + rent, plus the traded amount in
 *      NativeSol mode);
 *   3. in TokenAccount mode the taker_seller_ata holds enough tokens.
 */
async function preflightChecks({
  connection,
  parsed,
  accounts,
  payerPublicKey,
  logger,
}) {
  // 1. Quote signer authorization.
  const signerConfigInfo = await connection.getAccountInfo(accounts.mmSignerConfig);
  if (!signerConfigInfo) {
    throw new Error(
      `Quote signer ${accounts.mmSigner.toBase58()} is not authorized by Native. ` +
        "Please contact Native support.",
    );
  }
  const enabled = signerConfigInfo.data[40] === 1; // MmSignerConfig.enabled
  if (!enabled) {
    throw new Error(
      `Quote signer ${accounts.mmSigner.toBase58()} is authorized but disabled. ` +
        "Please contact Native support.",
    );
  }
  logger.log(
    `[preflight] quote signer authorized: ${accounts.mmSigner.toBase58()}`,
  );

  // 2. SOL balance.
  const balance = await connection.getBalance(payerPublicKey);
  const isNativeSol = parsed.sellerInputMode === SELLER_INPUT_MODE_NATIVE_SOL;
  const minimumRequired =
    BigInt(SOL_FEE_BUFFER) + (isNativeSol ? parsed.sellerAmount : 0n);
  if (balance < minimumRequired) {
    throw new Error(
      `Insufficient SOL balance: ${(balance / 1e9).toFixed(6)} SOL, ` +
        `need at least ${(Number(minimumRequired) / 1e9).toFixed(6)} SOL`,
    );
  }
  logger.log(`[preflight] SOL balance OK: ${(balance / 1e9).toFixed(6)} SOL`);

  // 3. Seller token balance (TokenAccount mode only).
  if (!isNativeSol) {
    const sellerBalance = await readTokenBalance(
      connection,
      accounts.takerSellerAta,
    );
    if (sellerBalance === null || sellerBalance < parsed.sellerAmount) {
      throw new Error(
        `Insufficient seller token balance in ${accounts.takerSellerAta.toBase58()}: ` +
          `${sellerBalance ?? 0} < ${parsed.sellerAmount}. ` +
          "Ensure the seller associated token account is funded before swapping.",
      );
    }
    logger.log(
      `[preflight] seller token balance OK: ${sellerBalance} (need ${parsed.sellerAmount})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Transaction construction
// ---------------------------------------------------------------------------

/**
 * Build a ready-to-sign legacy Transaction from a Native firm-quote response.
 *
 * @param {Object} params
 * @param {Connection} params.connection Solana RPC connection
 * @param {Object} params.quoteResponse Native /swap-api-v2/v1/firm-quote response
 * @param {PublicKey} params.payerPublicKey User wallet public key (also taker)
 * @param {Function} params.signTransaction Wallet callback: async (tx) => signed tx
 * @param {Object} [params.options]
 * @param {string} [params.options.commitment="confirmed"] RPC commitment level
 * @param {boolean} [params.options.preflight=true] Run preflight checks before building
 * @param {Object} [params.options.programIds] Optional program id overrides
 * @param {string} [params.options.programIds.rfq] RFQ program id (default: order.pool)
 * @param {string} [params.options.programIds.creditVault] Credit-vault program id (default: on-chain RFQ config)
 * @param {Object} [params.options.logger=console] Logger with .log/.warn/.error
 * @returns {Promise<Transaction>}
 */
export async function buildSolanaSwapTransaction({
  connection,
  quoteResponse,
  payerPublicKey,
  signTransaction,
  options = {},
}) {
  const {
    commitment = "confirmed",
    preflight = true,
    programIds = {},
    logger = console,
  } = options;

  if (typeof signTransaction !== "function") {
    throw new Error("signTransaction callback is required");
  }
  if (!connection) {
    throw new Error("connection is required");
  }
  if (!quoteResponse?.success) {
    throw new Error("quoteResponse is not successful");
  }
  const order = quoteResponse.orders?.[0];
  if (!order) {
    throw new Error("quoteResponse.orders is empty");
  }
  const calldataHex = quoteResponse.txRequest?.calldata;
  if (!calldataHex) {
    throw new Error("quoteResponse.txRequest.calldata is missing");
  }
  const calldata = Buffer.from(calldataHex.replace(/^0x/, ""), "hex");
  const parsed = parseCompactCalldata(calldata);

  logger.log(
    `[build] quote_id=${Buffer.from(parsed.quoteId).toString("hex")} ` +
      `seller_amount=${parsed.sellerAmount} buyer_amount=${parsed.buyerAmount} ` +
      `seller_input_mode=${parsed.sellerInputMode}`,
  );

  const accounts = await deriveAccounts({
    connection,
    order,
    payerPublicKey,
    programIds,
  });

  // Prepare instructions: create the taker_seller_ata when it does not exist
  // yet (rent is paid by the payer). Must run before the Ed25519 instruction so
  // that the swap instruction still sees the signature in its predecessor.
  const prepareInstructions = [];
  const sellerAtaInfo = await connection.getAccountInfo(accounts.takerSellerAta);
  if (!sellerAtaInfo) {
    logger.log(
      `[build] taker seller ATA missing, will create: ${accounts.takerSellerAta.toBase58()}`,
    );
    prepareInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payerPublicKey,
        accounts.takerSellerAta,
        payerPublicKey,
        accounts.sellerMint,
        accounts.sellerTokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  if (preflight) {
    await preflightChecks({
      connection,
      parsed,
      accounts,
      payerPublicKey,
      logger,
    });
  }

  // trade_rfq_compact account metas in strict IDL order (26 accounts).
  const accountMetas = [
    { pubkey: payerPublicKey, isSigner: true, isWritable: true }, // 1. taker
    { pubkey: accounts.mmSigner, isSigner: false, isWritable: false }, // 2. mm_signer
    { pubkey: accounts.recipient, isSigner: false, isWritable: false }, // 3. recipient
    { pubkey: accounts.rfqConfigPda, isSigner: false, isWritable: false }, // 4. config
    { pubkey: accounts.mmSignerConfig, isSigner: false, isWritable: false }, // 5. mm_signer_config
    { pubkey: quotePda(accounts, parsed), isSigner: false, isWritable: true }, // 6. used_quote
    { pubkey: accounts.poolAuthority, isSigner: false, isWritable: true }, // 7. pool_authority
    { pubkey: accounts.sellerMint, isSigner: false, isWritable: false }, // 8. seller_mint
    { pubkey: accounts.buyerMint, isSigner: false, isWritable: false }, // 9. buyer_mint
    { pubkey: accounts.sellerMarket, isSigner: false, isWritable: false }, // 10. seller_market
    { pubkey: accounts.buyerMarket, isSigner: false, isWritable: false }, // 11. buyer_market
    { pubkey: accounts.buyerMarketAuthority, isSigner: false, isWritable: false }, // 12. buyer_market_authority_pda
    { pubkey: accounts.takerSellerAta, isSigner: false, isWritable: true }, // 13. taker_seller_ata
    { pubkey: accounts.sellerCustodyAta, isSigner: false, isWritable: true }, // 14. seller_custody_ata
    { pubkey: accounts.buyerCustodyAta, isSigner: false, isWritable: true }, // 15. buyer_custody_ata
    { pubkey: accounts.recipientBuyerAta, isSigner: false, isWritable: true }, // 16. recipient_buyer_ata
    { pubkey: accounts.sellerTraderPosition, isSigner: false, isWritable: true }, // 17. seller_trader_position
    { pubkey: accounts.buyerTraderPosition, isSigner: false, isWritable: true }, // 18. buyer_trader_position
    { pubkey: accounts.vaultConfig, isSigner: false, isWritable: false }, // 19. vault_config
    { pubkey: accounts.creditPoolConfig, isSigner: false, isWritable: false }, // 20. credit_pool_config
    { pubkey: accounts.creditVaultProgramId, isSigner: false, isWritable: false }, // 21. credit_vault_program
    { pubkey: accounts.sellerTokenProgram, isSigner: false, isWritable: false }, // 22. seller_token_program
    { pubkey: accounts.buyerTokenProgram, isSigner: false, isWritable: false }, // 23. buyer_token_program
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 24. associated_token_program
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, // 25. system_program
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, // 26. instructions_sysvar
  ];

  const tradeRfqCompactIx = new TransactionInstruction({
    keys: accountMetas,
    programId: accounts.rfqProgramId,
    data: parsed.tradeRfqData,
  });
  const ed25519Ix = new TransactionInstruction({
    keys: [],
    programId: ED25519_PROGRAM_ID,
    data: parsed.ed25519IxData,
  });

  // Instruction order: ATA preparation (if any) -> Ed25519 -> trade_rfq_compact.
  // trade_rfq_compact reads the signature from `current_instruction_index - 1`,
  // so the Ed25519 instruction must be its immediate predecessor.
  const instructions = [...prepareInstructions, ed25519Ix, tradeRfqCompactIx];

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(commitment);
  const tx = new Transaction({ feePayer: payerPublicKey });
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.add(...instructions);

  logger.log(
    `[build] transaction built with ${instructions.length} instructions ` +
      `(rfq=${accounts.rfqProgramId.toBase58()}, ` +
      `creditVault=${accounts.creditVaultProgramId.toBase58()})`,
  );
  return tx;
}

// quote PDA is derived from the quote_id parsed out of the calldata, keyed by
// the RFQ program id. Kept as a small helper for readability.
function quotePda(accounts, parsed) {
  return pda(
    [Buffer.from(QUOTE_SEED), parsed.quoteId],
    accounts.rfqProgramId,
  );
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Sign, serialize, send and confirm a swap transaction, returning its
 * transaction signature.
 *
 * Retry is strictly bounded (maxTxAttempts) and only re-sends after a blockhash
 * expiry when it can be confident the previous attempt did NOT land: the
 * previous signature is polled first, "processed" (already in a block) is
 * waited on rather than re-sent, and as a final authoritative check the
 * single-use used_quote PDA is read on-chain. If that PDA exists the quote was
 * already consumed, so the previous signature is returned instead of burning
 * another fee on a transaction that could never succeed.
 *
 * @param {Object} params Same arguments as buildSolanaSwapTransaction
 * @param {Object} [params.options]
 * @param {string} [params.options.commitment="confirmed"]
 * @param {number} [params.options.maxConfirmRetries=120] Confirm poll attempts (1s apart)
 * @param {number} [params.options.maxTxAttempts=3] Send attempts on blockhash expiry
 * @param {boolean} [params.options.skipPreflight=false] Skip preflight checks
 * @returns {Promise<string>} Transaction signature
 */
export async function executeSolanaSwap({
  connection,
  quoteResponse,
  payerPublicKey,
  signTransaction,
  options = {},
}) {
  const {
    commitment = "confirmed",
    maxConfirmRetries = 120,
    maxTxAttempts = 3,
    skipPreflight = false,
    logger = console,
  } = options;

  const tx = await buildSolanaSwapTransaction({
    connection,
    quoteResponse,
    payerPublicKey,
    signTransaction,
    options: { ...options, preflight: !skipPreflight },
  });

  let lastSignature = null;
  let lastError = null;

  // Locate the used_quote PDA from the built transaction: it is the 6th
  // account (index 5) of the trade_rfq_compact instruction, which is the last
  // instruction the SDK adds. Its on-chain existence is the authoritative
  // signal of whether the single-use quote_id has already been consumed.
  const tradeIx = tx.instructions[tx.instructions.length - 1];
  const usedQuotePda = tradeIx.keys[5].pubkey;

  for (let attempt = 1; attempt <= maxTxAttempts; attempt++) {
    // Before retrying, make sure the previous attempt did not actually land.
    // A consumed quote_id cannot be replayed, so blindly re-sending after it
    // landed would only burn a fee.
    if (attempt > 1 && lastSignature) {
      logger.log(`[execute] checking whether previous tx landed...`);
      let landed = false;
      let failed = false;
      let processed = false;
      for (let check = 0; check < 30; check++) {
        const status = await connection
          .getSignatureStatus(lastSignature, { searchTransactionHistory: true })
          .catch(() => null);
        if (status?.value) {
          if (status.value.err) {
            failed = true;
            break;
          }
          if (
            status.value.confirmationStatus === "confirmed" ||
            status.value.confirmationStatus === "finalized"
          ) {
            landed = true;
            break;
          }
          // "processed" means the cluster has already accepted the tx into a
          // block; it will confirm or fail shortly. Re-sending the single-use
          // quote would only waste a fee, so wait for finality instead.
          processed = true;
          break;
        }
        await sleep(1000);
      }
      if (failed) {
        throw new Error(
          `previous transaction failed on-chain: ${JSON.stringify(status.value.err)}`,
        );
      }
      if (landed) {
        return lastSignature;
      }
      if (processed) {
        logger.log(
          `[execute] previous tx is processed but not yet confirmed, waiting for finality...`,
        );
        for (let i = 0; i < maxConfirmRetries; i++) {
          const s = await connection
            .getSignatureStatus(lastSignature, {
              searchTransactionHistory: true,
            })
            .catch(() => null);
          if (s?.value) {
            if (s.value.err) {
              throw new Error(
                `previous transaction failed on-chain: ${JSON.stringify(s.value.err)}`,
              );
            }
            if (
              s.value.confirmationStatus === "confirmed" ||
              s.value.confirmationStatus === "finalized"
            ) {
              logger.log(`[execute] previous tx confirmed: ${lastSignature}`);
              return lastSignature;
            }
          }
          await sleep(1000);
        }
        throw new Error(
          `previous transaction was processed but not confirmed within the retry budget: ${lastSignature}`,
        );
      }
      // Not indexed by getSignatureStatus within the window. Fall back to the
      // authoritative on-chain signal: if the used_quote PDA exists, the quote
      // was consumed by the previous attempt (the RPC simply lagged on the
      // signature status), so return it instead of re-sending.
      const usedQuoteInfo = await connection
        .getAccountInfo(usedQuotePda, commitment)
        .catch(() => null);
      if (usedQuoteInfo) {
        logger.log(
          `[execute] used_quote PDA exists (${usedQuotePda.toBase58()}), ` +
            `previous tx landed but RPC lagged; returning ${lastSignature}`,
        );
        return lastSignature;
      }
      // used_quote PDA absent: the quote_id was NOT consumed, so re-sending
      // with a fresh blockhash is safe and correct.
    }

    // Refresh the blockhash on retries (the signer signs over it, so we must
    // rebuild the signed payload each attempt).
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash(commitment);
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;

    const signed = await signTransaction(tx);
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      maxRetries: 5,
    });
    lastSignature = signature;
    logger.log(`[execute] tx sent: ${signature}`);

    for (let i = 0; i < maxConfirmRetries; i++) {
      let status = null;
      try {
        status = await connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });
      } catch (pollErr) {
        // Transient RPC errors must not abort polling.
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
