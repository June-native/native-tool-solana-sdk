# Native Solana Swap SDK

Turns a Native `/swap-api-v2/v1/firm-quote` response into a signed Solana transaction and submits it on-chain.

## Install

```bash
npm install
```

## Usage

```javascript
import { Connection } from "@solana/web3.js";
import { executeSolanaSwap, signTransactionWithKeypair } from "./sdk.mjs";

const quoteResponse = await fetch(url, {
  headers: { api_key: process.env.API_KEY },
}).then((r) => r.json());

const signature = await executeSolanaSwap({
  connection: new Connection("https://api.devnet.solana.com"),
  quoteResponse,
  payerPublicKey: wallet.publicKey,
  signTransaction: signTransactionWithKeypair(wallet),
  // Wallet adapters can pass: signTransaction: wallet.signTransaction
});

console.log(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
```

`executeSolanaSwap` is the only on-chain step. The wallet only needs to provide `signTransaction`.

## Environments

| | Devnet | Mainnet |
| --- | --- | --- |
| Swap API | `https://api-uat.native.org` | `https://v2.api.native.org` |
| Solana RPC | `https://api.devnet.solana.com` | `https://api.mainnet-beta.solana.com` |
| `src_chain` / `dst_chain` | `solana-devnet` | `solana` |
| Auth | Header `api_key` | Header `api_key` |

## Firm quote

```bash
curl --location --request GET \
  'https://api-uat.native.org/swap-api-v2/v1/firm-quote\
?from_address=YOUR_WALLET\
&src_chain=solana-devnet\
&dst_chain=solana-devnet\
&token_in=So11111111111111111111111111111111111111112\
&token_out=ApUXPfRZ5N5yLEx5ncaNVANJvDfqE5R2QwdqDyPCZCSu\
&amount=0.13\
&version=4' \
  --header 'api_key: YOUR_API_KEY'
```

Pass the JSON response to `executeSolanaSwap`. Native SOL as `token_in` uses `0x0000000000000000000000000000000000000000`; the contract deducts SOL directly (no manual wrap).

## Exports

- `executeSolanaSwap` — build, sign, send, and confirm
- `buildSolanaSwapTransaction` — build a ready-to-sign legacy transaction
- `signTransactionWithKeypair` — `signTransaction` helper for a `Keypair`
