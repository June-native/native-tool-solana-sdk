import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  DEFAULT_CREDIT_VAULT_PROGRAM_ID,
  DEFAULT_PAMM_PROGRAM_ID,
  ENGINE_ACCOUNT_DISCRIMINATOR,
  ENGINE_ACCOUNT_SIZE,
  decodeEngineAccount,
  simulateExactIn,
  sqrtRatioAtTick,
} from "./sdk.mjs";

const readIdl = (name) =>
  JSON.parse(readFileSync(new URL(`./idl/${name}.json`, import.meta.url), "utf8"));

test("bundled IDLs match the program ids and Engine discriminator in sdk.mjs", () => {
  const pamm = readIdl("pamm");
  const creditVault = readIdl("credit_vault_v2");
  assert.equal(pamm.address, DEFAULT_PAMM_PROGRAM_ID.toBase58());
  assert.equal(creditVault.address, DEFAULT_CREDIT_VAULT_PROGRAM_ID.toBase58());
  assert.deepEqual(
    pamm.accounts.find((account) => account.name === "Engine").discriminator,
    [...ENGINE_ACCOUNT_DISCRIMINATOR],
  );
  const swap = pamm.instructions.find((ix) => ix.name === "swap_exact_in");
  const quote = pamm.instructions.find((ix) => ix.name === "quote_exact_in");
  assert.deepEqual(swap.discriminator, [104, 104, 131, 86, 161, 189, 180, 216]);
  assert.equal(swap.accounts.length, 17);
  assert.deepEqual(quote.discriminator, [55, 146, 194, 181, 17, 72, 227, 19]);
  assert.equal(quote.accounts.length, 4);
});

function writeU128LE(buffer, offset, value) {
  buffer.writeBigUInt64LE(value & ((1n << 64n) - 1n), offset);
  buffer.writeBigUInt64LE(value >> 64n, offset + 8);
}

function writeU160LE(buffer, offset, value) {
  let rest = value;
  for (let i = 0; i < 20; i++) {
    buffer[offset + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

function engineWithDecimals(baseDecimals, quoteDecimals) {
  const baseMint = Keypair.generate().publicKey;
  const quoteMint = Keypair.generate().publicKey;
  const capacity = 10n * 10n ** BigInt(baseDecimals);
  return {
    baseMint,
    quoteMint,
    baseDecimals,
    quoteDecimals,
    fairSqrtPriceX96: 1n << 96n,
    baseToQuoteFeePpm: 3_000,
    quoteToBaseFeePpm: 4_000,
    validUntilSlot: 100n,
    cursorSqrtRatioX96: sqrtRatioAtTick(0),
    tickSpacing: 100,
    minBaseInputRaw: 1n,
    minQuoteInputRaw: 1n,
    ranges: [
      {
        startTick: -10_000,
        endTick: 10_000,
        capacityBaseRaw: capacity,
        startSqrtRatioX96: sqrtRatioAtTick(-10_000),
        endSqrtRatioX96: sqrtRatioAtTick(10_000),
      },
    ],
  };
}

function encodeEngine(engine) {
  const buffer = Buffer.alloc(ENGINE_ACCOUNT_SIZE);
  ENGINE_ACCOUNT_DISCRIMINATOR.copy(buffer, 0);
  engine.baseMint.toBuffer().copy(buffer, 8);
  engine.quoteMint.toBuffer().copy(buffer, 40);
  buffer[72] = engine.baseDecimals;
  buffer[73] = engine.quoteDecimals;
  writeU160LE(buffer, 74, engine.fairSqrtPriceX96);
  buffer.writeUInt32LE(engine.baseToQuoteFeePpm, 94);
  buffer.writeUInt32LE(engine.quoteToBaseFeePpm, 98);
  buffer.writeBigUInt64LE(engine.validUntilSlot, 102);
  writeU128LE(buffer, 110, engine.cursorSqrtRatioX96);
  buffer.writeUInt32LE(engine.tickSpacing, 126);
  buffer.writeBigUInt64LE(engine.minBaseInputRaw, 130);
  buffer.writeBigUInt64LE(engine.minQuoteInputRaw, 138);
  buffer.writeUInt32LE(engine.ranges.length, 146);
  engine.ranges.forEach((range, i) => {
    const offset = 150 + i * 48;
    buffer.writeInt32LE(range.startTick, offset);
    buffer.writeInt32LE(range.endTick, offset + 4);
    buffer.writeBigUInt64LE(range.capacityBaseRaw, offset + 8);
    writeU128LE(buffer, offset + 16, range.startSqrtRatioX96);
    writeU128LE(buffer, offset + 32, range.endSqrtRatioX96);
  });
  return buffer;
}

test("tick 0 is Q96 and the published neighbors match", () => {
  assert.equal(sqrtRatioAtTick(0), 1n << 96n);
  assert.equal(sqrtRatioAtTick(-10_000), 78_833_010_602_281_291_917_264_363_597n);
  assert.equal(sqrtRatioAtTick(10_000), 79_625_295_132_455_999_614_460_088_596n);
});

test("both directions charge the fee and move the cursor", () => {
  const engine = engineWithDecimals(6, 6);
  engine.ranges[0].capacityBaseRaw = 1_000_000_000n;
  const sellBase = simulateExactIn({
    engine,
    sellerMint: engine.baseMint,
    buyerMint: engine.quoteMint,
    grossAmountIn: 1_000_000n,
    currentSlot: 100n,
  });
  assert.equal(sellBase.feeAmount, 3_000n);
  assert.equal(sellBase.amountOut, 996_990n);
  assert.equal(
    sellBase.endCursorSqrtRatioX96,
    79_227_372_614_463_083_304_573_263_392n,
  );

  const sellQuote = simulateExactIn({
    engine,
    sellerMint: engine.quoteMint,
    buyerMint: engine.baseMint,
    grossAmountIn: 1_000_000n,
    currentSlot: 100n,
  });
  assert.equal(sellQuote.feeAmount, 4_000n);
  assert.equal(sellQuote.amountOut, 995_990n);
  assert.equal(
    sellQuote.endCursorSqrtRatioX96,
    79_228_951_629_656_391_602_410_357_280n,
  );
});

test("expired price and a mint outside the pair are rejected", () => {
  const engine = engineWithDecimals(6, 6);
  engine.ranges[0].capacityBaseRaw = 1_000_000_000n;
  assert.throws(
    () =>
      simulateExactIn({
        engine,
        sellerMint: engine.baseMint,
        buyerMint: engine.quoteMint,
        grossAmountIn: 1_000_000n,
        currentSlot: 101n,
      }),
    (error) => error.code === "PriceExpired",
  );
  assert.throws(
    () =>
      simulateExactIn({
        engine,
        sellerMint: Keypair.generate().publicKey,
        buyerMint: engine.quoteMint,
        grossAmountIn: 1_000_000n,
        currentSlot: 100n,
      }),
    (error) => error.code === "InvalidPair",
  );
});

test("decoded Engine bytes quote the same as the in-memory engine", () => {
  const engine = engineWithDecimals(6, 6);
  engine.ranges[0].capacityBaseRaw = 1_000_000_000n;
  const decoded = decodeEngineAccount(encodeEngine(engine));
  const direct = simulateExactIn({
    engine,
    sellerMint: engine.baseMint,
    buyerMint: engine.quoteMint,
    grossAmountIn: 1_000_000n,
    currentSlot: 100n,
  });
  const fromBytes = simulateExactIn({
    engine: decoded,
    sellerMint: decoded.baseMint,
    buyerMint: decoded.quoteMint,
    grossAmountIn: 1_000_000n,
    currentSlot: 100n,
  });
  assert.deepEqual(fromBytes, direct);
  assert.equal(decoded.baseMint.equals(engine.baseMint), true);
  assert.equal(decoded.validUntilSlot, 100n);
});

test("a cursor in a gap uses the nearest range in the trade direction", () => {
  const engine = engineWithDecimals(6, 6);
  const range = (startTick, endTick) => ({
    startTick,
    endTick,
    capacityBaseRaw: 1_000_000_000n,
    startSqrtRatioX96: sqrtRatioAtTick(startTick),
    endSqrtRatioX96: sqrtRatioAtTick(endTick),
  });
  engine.ranges = [range(-20_000, -10_000), range(10_000, 20_000)];
  const sellBase = simulateExactIn({
    engine,
    sellerMint: engine.baseMint,
    buyerMint: engine.quoteMint,
    grossAmountIn: 1_000_000n,
    currentSlot: 100n,
  });
  assert.ok(sellBase.endCursorSqrtRatioX96 < sqrtRatioAtTick(-10_000));
  const sellQuote = simulateExactIn({
    engine,
    sellerMint: engine.quoteMint,
    buyerMint: engine.baseMint,
    grossAmountIn: 1_000_000n,
    currentSlot: 100n,
  });
  assert.ok(sellQuote.endCursorSqrtRatioX96 > sqrtRatioAtTick(10_000));
});

test("input beyond every range fails instead of partially filling", () => {
  const engine = engineWithDecimals(6, 6);
  engine.ranges[0].capacityBaseRaw = 1_000_000n;
  assert.throws(
    () =>
      simulateExactIn({
        engine,
        sellerMint: engine.baseMint,
        buyerMint: engine.quoteMint,
        grossAmountIn: 10_000_000n,
        currentSlot: 100n,
      }),
    (error) => error.code === "InsufficientDepth",
  );
});

test("decodeEngineAccount rejects a non-Engine account", () => {
  const data = encodeEngine(engineWithDecimals(6, 6));
  data[0] ^= 1;
  assert.throws(() => decodeEngineAccount(data), /not a pAMM Engine account/);
});

test("amount sweep keeps fee and cursor direction", () => {
  const engine = engineWithDecimals(6, 6);
  engine.ranges[0].capacityBaseRaw = 1_000_000_000n;
  for (let amount = 10_000n; amount <= 2_000_000n; amount += 19_919n) {
    const sellBase = simulateExactIn({
      engine,
      sellerMint: engine.baseMint,
      buyerMint: engine.quoteMint,
      grossAmountIn: amount,
      currentSlot: 100n,
    });
    const sellQuote = simulateExactIn({
      engine,
      sellerMint: engine.quoteMint,
      buyerMint: engine.baseMint,
      grossAmountIn: amount,
      currentSlot: 100n,
    });
    assert.equal(sellBase.feeAmount, amount - (amount * 997_000n) / 1_000_000n);
    assert.equal(sellQuote.feeAmount, amount - (amount * 996_000n) / 1_000_000n);
    assert.ok(sellBase.endCursorSqrtRatioX96 < engine.cursorSqrtRatioX96);
    assert.ok(sellQuote.endCursorSqrtRatioX96 > engine.cursorSqrtRatioX96);
    assert.ok(sellBase.amountOut > 0n && sellQuote.amountOut > 0n);
  }
});

test("materially different decimal pairs quote both directions", () => {
  for (const [baseDecimals, quoteDecimals] of [
    [18, 6],
    [8, 6],
    [18, 18],
    [6, 18],
  ]) {
    const engine = engineWithDecimals(baseDecimals, quoteDecimals);
    const sellBase = simulateExactIn({
      engine,
      sellerMint: engine.baseMint,
      buyerMint: engine.quoteMint,
      grossAmountIn: 10n ** BigInt(baseDecimals),
      currentSlot: 100n,
    });
    const sellQuote = simulateExactIn({
      engine,
      sellerMint: engine.quoteMint,
      buyerMint: engine.baseMint,
      grossAmountIn: 10n ** BigInt(quoteDecimals),
      currentSlot: 100n,
    });
    assert.ok(sellBase.amountOut > 0n);
    assert.ok(sellQuote.amountOut > 0n);
  }
});
