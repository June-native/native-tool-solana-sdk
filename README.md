# Native pAMM Solana Swap SDK

External taker-side SDK for the Native pAMM on Solana: turns a token pair and
amount into an on-chain `quote_exact_in` view call or a signed `swap_exact_in`
transaction and submits it. Structured after `native-tool-solana-sdk`
(plain `@solana/web3.js`, no anchor dependency at runtime).

External integrators only quote and swap; market (price/curve) updates are
performed by Native's updater service and are intentionally NOT part of this
SDK.

## Install

```bash
npm install
```

## Usage

```javascript
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  executeSwapExactIn,
  quoteExactIn,
  signTransactionWithKeypair,
} from "./sdk.mjs";

const connection = new Connection("https://api.devnet.solana.com");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.TAKER_PRIVATE_KEY));

const WSOL = "So11111111111111111111111111111111111111112";
const QUOTE = "ApUXPfRZ5N5yLEx5ncaNVANJvDfqE5R2QwdqDyPCZCSu";

// 1. Quote (view; raw units, includes the fee in the input side)
const amountOut = await quoteExactIn({
  connection,
  sellerMint: WSOL,
  buyerMint: QUOTE,
  grossAmountIn: 10_000_000n, // 0.01 SOL
});

// 2. Swap (the only on-chain step; the wallet only provides signTransaction)
const signature = await executeSwapExactIn({
  connection,
  payerPublicKey: wallet.publicKey,
  signTransaction: signTransactionWithKeypair(wallet),
  // wallet adapters can pass: signTransaction: wallet.signTransaction
  sellerMint: WSOL,
  buyerMint: QUOTE,
  grossAmountIn: 10_000_000n, // 0.01 SOL
  slippageBps: 100, // or pass minAmountOut explicitly
});

console.log(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
```

Or via the demo CLI, run exactly like the Relay API test script
(`test-api-trade.mjs`) — all parameters via environment variables:

```bash
# TAKER_PRIVATE_KEY must be set for real usage; when unset the script falls
# back to an built-in devnet demo wallet and still submits a real swap.
TAKER_PRIVATE_KEY="YOUR_PRIVATE_KEY_BASE58" NETWORK=devnet \
  TOKEN_IN="So11111111111111111111111111111111111111112" \
  TOKEN_OUT="ApUXPfRZ5N5yLEx5ncaNVANJvDfqE5R2QwdqDyPCZCSu" \
  AMOUNT="0.01" \
  node example.mjs   # always: quote first, then submit the swap
```

`AMOUNT` is in human token units (decimals are read from the on-chain mints).
Native SOL is traded via the wSOL mint `So1111...112` — pAMM submits directly
on-chain, so there is no EVM-style `0x0` marker; the SDK wraps and syncs the
wSOL balance inside the swap transaction. Optional: `SLIPPAGE_BPS` (default
100), `SOLANA_RPC_URL`. There is no `API_KEY` — pAMM has no HTTP API;
everything is submitted on-chain directly. The full demo matrix is in
[TEST-SUITE.md](./TEST-SUITE.md).

## Environments

| | Devnet (default) |
| --- | --- |
| pAMM program | `7peHVBaaUoTikbuWKn8j2JtNz5dq6AXvQVkaLTgnKVME` |
| CreditVault V2 program | `HbKHd4zbjhyiAxGunPfVpvNVVfv8ohN7NfcyfuybND1U` |
| Solana RPC | `https://api.devnet.solana.com` (override via `SOLANA_RPC_URL`) |
| Base / quote mints | SOL `So111...112` / USDC `ApUX...CSu` |

Program ids are overridable via `options.programIds = { pamm, creditVault }`.

## How requests are packaged

- `quote_exact_in`: 8-byte Anchor discriminator + `u64 gross_amount_in`
  (little-endian), simulated with `sigVerify: false`; the `u64` return data is
  decoded as the buyer-token raw amount out. The simulation fee payer is an
  arbitrary funded account (no signature needed); override it with
  `options.simulationPayer` on clusters where the devnet default is absent.
- `swap_exact_in`: discriminator + `gross_amount_in` + `min_amount_out`, with
  17 accounts in strict IDL order (taker, pAMM config, pool authority, mints,
  engine, user seller token account, custodies, destination token account,
  vault config, credit pool config, markets, buyer market authority,
  credit-vault program, SPL Token program).
- All PDAs are derived locally (config / pool_authority / engine on the pAMM
  program; market / market_authority / credit_pool + custody ATAs on
  credit-vault), mirroring `pamm_solana/CreditVault V2 pAMM 后端交互文档.md`.
- The engine PDA is keyed by the pair's base/quote convention (e.g. SOL=base,
  USDC=quote). The SDK resolves it by probing which candidate engine exists
  on-chain; pass `options.pair = { baseMint, quoteMint }` to skip the probe
  (required if both orders are ever initialized).
- Missing destination / seller ATAs are created idempotently in the same
  transaction; selling native SOL wraps + `syncNative`s automatically.
- Preflight checks (skippable via `options.skipPreflight`): engine price TTL
  (`valid_until_slot`), payer SOL budgeted as base fee + rent for every token
  account this transaction will create + wrapped input when selling native SOL,
  and seller token balance (with a distinct error when the seller token account
  does not exist yet).
- Estimate-then-send (like the Native pammengine submit path): before
  broadcasting, `executeSwapExactIn` simulates the exact signed payload
  (`options.simulateFirst`, default on); a failed simulation (expired price,
  slippage, unfunded account, ...) is never broadcast, so no fee is burnt. The
  measured compute units are logged so you can size
  `options.computeUnitLimit` / `options.priorityFeeMicroLamports` (both
  optional; without them the transaction pays only the 5,000-lamport base fee
  and lands at default priority).

## Cold-start wallets & costs

A brand-new wallet can swap in a single transaction — verified on devnet:
fund → swap (with a fresh quote inside the build) created both ATAs, wrapped SOL and executed atomically.
Cost breakdown of that exact transaction (payer outflow 12,981,880 lamports
for a 5,000,000-lamport input):

| Component | Lamports | Recoverable? |
| --- | --- | --- |
| Network fee | 5,000 | no |
| Rent: destination ATA | 1,488,440¹ | yes (close account) |
| Rent: wSOL seller ATA | 1,488,440¹ | yes (close account) |
| Wrapped SOL input | 5,000,000 | consumed by the swap |
| Wrap buffer kept as wSOL | 5,000,000 | yes (user's wSOL balance) |

¹ rent-exempt minimum at the measured epoch; it can adjust over epochs.

There is no estimate/gas oracle on Solana: the only irreducible cost is the
base fee, plus priority fee only if you opt in. Failed transactions caught by
the simulate gate or the RPC preflight cost nothing.

## Integration notes (from the backend interaction doc)

- Amounts are token **raw units** (SOL 9 decimals, USDC 6). Direction is
  decided by the seller/buyer mints, never by the amount.
- A quote is advisory only: the swap re-prices on-chain and enforces
  `amountOut >= min_amount_out`. Always derive `minAmountOut` from a fresh
  quote with your slippage bound (`applySlippage`).
- Prices expire (`valid_until_slot`, max 32 slots ahead); a swap landing after
  expiry fails with PriceExpired — retry with a fresh quote, never replay the
  old transaction blindly.
- Legacy SPL Token only; Token-2022 accounts are not supported.
- Failed swaps revert atomically (single transaction).

## Exports

- `DEFAULT_PAMM_PROGRAM_ID` / `DEFAULT_CREDIT_VAULT_PROGRAM_ID` / `WSOL_MINT` — devnet defaults
- `quoteExactIn` — simulate `quote_exact_in`, return raw amount out
- `buildSwapExactInTransaction` — build a ready-to-sign swap transaction
- `executeSwapExactIn` — build, sign, send and confirm
- `applySlippage` — `floor(quoted * (10_000 - bps) / 10_000)`
- `derivePammAccounts` — every PDA / token account for a trade direction
- `fetchEngineValidUntilSlot` — engine price TTL read
- `signTransactionWithKeypair` — `signTransaction` helper for a `Keypair`
