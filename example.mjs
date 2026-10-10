// example.mjs: quote + swap via the pAMM Solana SDK.
// Parameters come from `.env` (see `.env.example`) or the process environment.
//
//   node example.mjs          # quote then swap
//   node example.mjs quote    # on-chain quote and local quote; exit if they differ
//
// pAMM has no HTTP API / API_KEY: quoting is an on-chain view call and the
// swap is submitted directly, so API_KEY is intentionally absent.
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DEFAULT_CREDIT_VAULT_PROGRAM_ID,
  DEFAULT_PAMM_PROGRAM_ID,
  applySlippage,
  executeSwapExactIn,
  quoteExactIn,
  quoteExactInOffchain,
  signTransactionWithKeypair,
} from "./sdk.mjs";

try {
  process.loadEnvFile(fileURLToPath(new URL("./.env", import.meta.url)));
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const NETWORKS = {
  devnet: {
    rpc: "https://api.devnet.solana.com",
    cluster: "devnet",
    pamm: DEFAULT_PAMM_PROGRAM_ID.toBase58(),
    creditVault: DEFAULT_CREDIT_VAULT_PROGRAM_ID.toBase58(),
  },
  mainnet: {
    rpc: "https://solana-rpc.publicnode.com",
    cluster: "mainnet-beta",
    pamm: DEFAULT_PAMM_PROGRAM_ID.toBase58(),
    creditVault: DEFAULT_CREDIT_VAULT_PROGRAM_ID.toBase58(),
  },
};

const NETWORK = process.env.NETWORK ?? "devnet";
const net = NETWORKS[NETWORK];
if (!net) {
  console.error(`unknown NETWORK: ${NETWORK} (supported: ${Object.keys(NETWORKS).join(", ")})`);
  process.exit(1);
}
const MODE = process.argv[2] ?? "swap";
if (!["quote", "swap"].includes(MODE)) {
  console.error("usage: node example.mjs [quote|swap]");
  process.exit(1);
}
if (!net.pamm || !net.creditVault) {
  console.error(
    `NETWORK=${NETWORK} requires PAMM_PROGRAM_ID and CREDIT_VAULT_PROGRAM_ID env vars`,
  );
  process.exit(1);
}

const TAKER_PRIVATE_KEY = process.env.TAKER_PRIVATE_KEY?.trim();
const TOKEN_IN = process.env.TOKEN_IN;
const TOKEN_OUT = process.env.TOKEN_OUT;
const AMOUNT = process.env.AMOUNT ?? "0.01";
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS ?? "100";

if (!TAKER_PRIVATE_KEY) {
  console.error(
    "TAKER_PRIVATE_KEY is missing. Paste a base58 secret key into .env (see .env.example).",
  );
  process.exit(1);
}
if (!TOKEN_IN || !TOKEN_OUT) {
  console.error("TOKEN_IN and TOKEN_OUT env vars are required (mint addresses)");
  process.exit(1);
}

const rpcUrl = process.env.SOLANA_RPC_URL?.trim() || net.rpc;
const connection = new Connection(rpcUrl, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(TAKER_PRIVATE_KEY));
const options = {
  programIds: { pamm: net.pamm, creditVault: net.creditVault },
  simulationPayer: wallet.publicKey,
  logger: console,
};

// Mint layout: decimals is the u8 at offset 44.
async function mintDecimals(mint) {
  const info = await connection.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error(`mint not found: ${mint}`);
  return info.data[44];
}

async function main() {
  console.log(`network: ${NETWORK} | payer: ${wallet.publicKey.toBase58()}`);
  console.log(`token_in: ${TOKEN_IN} -> token_out: ${TOKEN_OUT} | amount: ${AMOUNT}`);

  const inDecimals = await mintDecimals(TOKEN_IN);
  // Human AMOUNT -> raw units exactly (no float precision loss).
  const [intPart, fracPart = ""] = AMOUNT.split(".");
  if (fracPart.length > inDecimals) {
    throw new Error(`AMOUNT has more than ${inDecimals} decimals for TOKEN_IN`);
  }
  const grossAmountIn =
    BigInt(intPart || "0") * 10n ** BigInt(inDecimals) +
    BigInt(fracPart.padEnd(inDecimals, "0") || "0");

  const amountOut = await quoteExactIn({
    connection,
    sellerMint: TOKEN_IN,
    buyerMint: TOKEN_OUT,
    grossAmountIn,
    options,
  });
  const outDecimals = await mintDecimals(TOKEN_OUT);
  console.log(
    `quote: ${AMOUNT} in -> ${amountOut} raw out (${Number(amountOut) / 10 ** outDecimals})`,
  );
  if (MODE === "quote") {
    const offchain = await quoteExactInOffchain({
      connection,
      sellerMint: TOKEN_IN,
      buyerMint: TOKEN_OUT,
      grossAmountIn,
      options,
    });
    console.log(
      `offchain: ${offchain.amountOut} raw out, fee ${offchain.feeAmount}, ` +
        `slot ${offchain.currentSlot}/${offchain.validUntilSlot}, ` +
        `buyer spendable ${offchain.buyerSpendableRaw}`,
    );
    if (offchain.amountOut !== amountOut) {
      throw new Error(
        `offchain quote ${offchain.amountOut} != on-chain quote ${amountOut}`,
      );
    }
    return;
  }

  const signature = await executeSwapExactIn({
    connection,
    payerPublicKey: wallet.publicKey,
    signTransaction: signTransactionWithKeypair(wallet),
    sellerMint: TOKEN_IN,
    buyerMint: TOKEN_OUT,
    grossAmountIn,
    minAmountOut: applySlippage(amountOut, Number(SLIPPAGE_BPS)), // from the fresh quote above
    options,
  });
  const clusterQs =
    net.cluster === "mainnet-beta" || net.cluster === "mainnet"
      ? ""
      : `?cluster=${net.cluster}`;
  console.log(
    `swap confirmed: https://explorer.solana.com/tx/${signature}${clusterQs}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
