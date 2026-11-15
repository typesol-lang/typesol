// showcase/mainnet/percolator against Percolator v12.20 as deployed on mainnet (test/programs/percolator_v12.so): the
// divergences found after the port first matched every hand-written case and the random walks, each as its minimal
// case. Each one differed (the port's outcome is in the comment); the port now does what the original does, and these
// compare it through `both()` as every other test does. One difference remains, pinned: a panic after TradeCpi's
// matcher call when the call has left the original's heap too little to format the panic line.
import { type Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { send } from "../../test/harness.js";
import {
  A,
  C,
  CLOCK,
  Diff,
  HAVE_ORIGINAL,
  type Lp,
  MATCHER_CTX_LEN,
  type Market,
  ROGUE,
  SOL,
  type User,
  builtin,
  i128,
  ix,
  lpPda,
  r,
  u32,
  u64,
  accounts,
  accountAt,
  lines,
  outcome,
  writeU128,
} from "./percolator-helpers.js";

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: divergences found by the mutation fuzzers and the error-site review", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });

  async function funded(m: Market, amount: bigint, label: string): Promise<User> {
    const u = await d.user(m);
    await d.ok(`${label}: InitUser`, u.key, [ix.initUser(m, u, amount)]);
    return u;
  }

  it("CloseSlab with an empty vault and the slab or the admin again as the unused destination token account", async () => {
    // The fifth account (the admin's token account) is read only when stranded tokens are drained. The original's
    // last lamport moves are plain `borrow_mut` writes: an account named twice is one AccountInfo record, and it
    // succeeds. The port failed with 2040 (TypeSOL's alias check on a remaining account's lamports, now lifted under
    // NATIVE_ACCOUNT_WRITES).
    for (const which of ["the slab", "the admin"]) {
      const m = await d.market();
      await d.ok(`${which}: ResolveMarket`, m.admin, [ix.resolveMarket(m, m.admin)]);
      const close = accounts(ix.closeSlab(m, m.admin.address), (l) => {
        l[4] = { ...l[4]!, address: which === "the slab" ? m.slab : m.admin.address };
      });
      await d.ok(`CloseSlab: #4 = ${which}`, m.admin, [close]);
    }
  });

  it("TradeCpi: the matcher shrinks its context below the 64-byte answer", async () => {
    // read_matcher_return refuses a context shorter than 64 bytes (InvalidAccountData) before reading a field; the
    // port read the fields first (TypeSOL's out-of-bounds read, 3003, for a context under 32 bytes).
    const m = await d.market();
    const alice = await funded(m, 10n * SOL, "alice");
    const u = await d.user(m);
    const ctx = await d.address();
    d.write(ctx, ROGUE, Buffer.alloc(MATCHER_CTX_LEN));
    const idx = d.freeHead(m);
    await d.ok("rogue LP: InitLP", u.key, [ix.initLp(m, u, ROGUE, ctx, 100n * SOL)]);
    const lp: Lp = { idx, matcher: ROGUE, ctx, pda: await lpPda(m, idx) };
    for (const len of [0n, 16n, 40n, 63n, 64n]) {
      d.write(ctx, ROGUE, Buffer.alloc(MATCHER_CTX_LEN));
      d.patch(ctx, (b) => {
        // Echo the request, fill it whole at the oracle price, then resize the context to `len`.
        b.writeBigUInt64LE(1n | 2n | 4n | 8n | 256n, 128);
        b.writeBigUInt64LE(len, 64);
        Buffer.concat([u32(2), u32(1), u64(100_000_000n), i128(0n), u64(0n), u64(0n), u64(0n), u64(0n)]).copy(b, 144);
      });
      const res = await d.both(`TradeCpi: the context resized to ${len}`, alice.key, [ix.tradeCpi(m, alice.key, u.key.address, lp, 0, 1_000_000n)]);
      expect(res).toBe(len < 64n ? builtin("InvalidAccountData") : "ok");
    }
  });

  it("TradeCpi with long tails: 126 and 127 accounts, and the original's heap running out", async () => {
    // The original passes 3 + T account infos to invoke_signed (the LP PDA, the context, the matcher program and the
    // tail); the port passes 2 + T. Both are compared at the lengths around the runtime's limit on CPI account infos
    // (the TypeSOL matcher then refuses more than 32 accounts under both). Longer tails exhaust the original's 32 KiB
    // heap before the call ("Error: memory allocation failed, out of memory", then abort: at a tail of 192 with one
    // distinct account in it, 184 with twenty), which the port reached the matcher past (5113 there); the port now
    // counts the same bytes (percolator.ts `cpiHeap`).
    const m = await d.market();
    const alice = await funded(m, 10n * SOL, "alice");
    const lpOwner = await d.user(m);
    const lp = await d.lp(m, lpOwner, 100n * SOL);
    const keys: Address[] = [CLOCK];
    for (let i = 0; i < 25; i++) keys.push(await d.address());
    const cases: [number, number][] = [1, 31, 32, 60, 124, 125, 126, 127, 128, 150, 200, 246].map((n) => [1, n]);
    // Every distinct count from 1 to 26 at every length from 176 to 194 (the heap runs out between 180 and 192).
    for (let distinct = 1; distinct <= 26; distinct++) for (let n = 176; n <= 194; n++) cases.push([distinct, n]);
    for (const [distinct, n] of cases) {
      const tail = Array.from({ length: n }, (_, k) => r(keys[k % distinct]!));
      await d.both(`TradeCpi: ${n} tail accounts, ${distinct} distinct`, alice.key, [
        ix.tradeCpi(m, alice.key, lpOwner.key.address, lp, 0, 1_000_000n, 0n, tail),
      ]);
    }
    // A tail with the instruction's own accounts repeated (the slab, the user, the oracle): repeats cost no RefCells.
    for (const n of [188, 189, 190, 191, 192]) {
      const own = [m.slab, alice.key.address, m.oracle, lp.ctx];
      const tail = Array.from({ length: n }, (_, k) => r(own[k % own.length]!));
      await d.both(`TradeCpi: ${n} tail accounts repeating the instruction's own`, alice.key, [
        ix.tradeCpi(m, alice.key, lpOwner.key.address, lp, 0, 1_000_000n, 0n, tail),
      ]);
    }
  });

  it("TradeCpi past the matcher call with nearly full heaps: a matcher taking any tail, and a panic there (pinned)", async () => {
    // The TypeSOL matcher refuses more than 32 accounts (5113), so the case above compares nothing after the call at
    // the lengths where the original's heap is nearly full. The rogue matcher takes up to 255: here the answer is
    // read, refused or traded at every tail length around exhaustion, with 1 to 26 distinct accounts, and a panic
    // after the call (a position basis whose arithmetic overflows, written into both slabs) formats its message on
    // whatever heap is left.
    const m = await d.market();
    const alice = await funded(m, 100n * SOL, "alice");
    const u = await d.user(m);
    const ctx = await d.address();
    d.write(ctx, ROGUE, Buffer.alloc(MATCHER_CTX_LEN));
    const idx = d.freeHead(m);
    await d.ok("rogue LP: InitLP", u.key, [ix.initLp(m, u, ROGUE, ctx, 1_000n * SOL)]);
    const lp: Lp = { idx, matcher: ROGUE, ctx, pda: await lpPda(m, idx) };
    const keys: Address[] = [CLOCK];
    for (let i = 0; i < 25; i++) keys.push(await d.address());
    const answers: [string, bigint, number, number][] = [
      ["a fill", 1n | 2n | 4n | 8n | 16n, 2, 1],
      ["a zero fill", 1n | 2n | 4n | 16n, 2, 3],
      ["a refused answer", 1n | 2n | 4n | 8n | 16n, 3, 1],
    ];
    const answer = (mode: bigint, abi: number, flags: number) =>
      d.patch(ctx, (b) => {
        b.writeBigUInt64LE(mode, 128);
        Buffer.concat([u32(abi), u32(flags), u64(0n), i128(0n), u64(0n), u64(0n), u64(0n), u64(0n)]).copy(b, 144);
      });
    const outcomes = new Map<string, number>();
    const trade = async (label: string, n: number, distinct: number) => {
      const tail = Array.from({ length: n }, (_, k) => r(keys[k % distinct]!));
      const got = await d.both(label, alice.key, [ix.tradeCpi(m, alice.key, u.key.address, lp, 0, 1_000_000n, 0n, tail)]);
      const key = `${label.split(": ")[1]!.split(",")[0]} ${got === "ok" ? "ok" : d.lastLogs.includes("out of memory") ? "out of memory" : got.replace(/.*error: /, "")}`;
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    };
    for (let distinct = 1; distinct <= 26; distinct++)
      for (let n = 170; n <= 194; n++)
        for (const [what, mode, abi, flags] of answers) {
          answer(mode, abi, flags);
          await trade(`TradeCpi: ${what}, ${n} tail accounts, ${distinct} distinct`, n, distinct);
        }
    if (process.env.PERCOLATOR_TRACE) console.log(Object.fromEntries(outcomes));
    // Every kind of answer met a heap that held (the answer read, refused or traded) and one that ran out.
    for (const what of ["a fill", "a zero fill", "a refused answer"]) {
      expect(outcomes.get(`${what} out of memory`) ?? 0, what).toBeGreaterThan(0);
      expect([...outcomes.keys()].filter((k) => k.startsWith(what) && !k.endsWith("out of memory")).length, what).toBeGreaterThan(0);
    }

    // A panic after the call: a DIFFERENCE, pinned. The user's position basis is written at 2^120, so |basis| · A
    // overflows in the trade's touch and the engine panics (src/wide_math.rs:1554:30). solana-program 1.18's panic
    // handler formats its line on the heap (`msg!("{}", info)`: a String grown as Rust grows one, 12, 28, 56 and 112
    // bytes for this line, 208 in all). Where the call has left fewer than 208 bytes above the allocator's 8-byte
    // position word, the original logs "Error: memory allocation failed, out of memory" in place of the panic line and
    // aborts; the port, which has no heap to format on, logs the panic line. The outcome
    // (ProgramFailedToComplete) and every account are the same. It takes the last tail length or two before the
    // original's heap runs out (191 tail accounts with one distinct among them, 180 with 26) and a state no instruction
    // makes: every panic of the engine the tests reach needs a slab written in.
    answer(1n | 2n | 4n | 8n | 16n, 2, 1);
    const before = Buffer.from(d.data(m.slab));
    d.patch(m.slab, (b) => writeU128(b, accountAt(0) + A.positionBasisQ, 1n << 120n));
    /** The original's heap position after the call (cpiHeap's count in percolator.ts), or -1 where it ran out before. */
    const heapLeft = (n: number, unique: number) => {
      const tail = n - 8;
      let pos = 32768;
      for (const [size, align] of [
        [48 * n, 8],
        [72 * unique, 8],
        [34 * (2 + tail), 1],
        [67, 1],
        [48 * (3 + tail), 8],
        [34 * (2 + tail), 1],
        [67, 1],
      ] as const) {
        pos = (pos >= size ? pos - size : 0) & ~(align - 1);
        if (pos < 8) return -1;
      }
      return pos;
    };
    let pinned = 0;
    for (let distinct = 1; distinct <= 26; distinct++)
      for (let n = 150; n <= 200; n++) {
        const label = `TradeCpi: a panic after the call, ${n} tail accounts, ${distinct} distinct`;
        const tail = Array.from({ length: n }, (_, k) => r(keys[k % distinct]!));
        const all = [ix.tradeCpi(m, alice.key, u.key.address, lp, 0, 1_000_000n, 0n, tail)];
        // The eight accounts before the tail are distinct; the tail's first key is the Clock, one of them.
        const left = heapLeft(8 + n, 8 + distinct - 1);
        if (left === -1 || left >= 8 + 208) {
          await d.both(label, alice.key, all);
          expect(d.lastLogs, label).toContain(left === -1 ? "out of memory" : "panicked at src/wide_math.rs:1554:30:");
          continue;
        }
        const [a, b] = [await send(d.original, alice.key, all), await send(d.port, alice.key, all)];
        expect(outcome(b), label).toBe(outcome(a));
        expect(outcome(a), label).toBe(builtin("ProgramFailedToComplete"));
        expect(lines(a), label).toContain("Program log: Error: memory allocation failed, out of memory");
        expect(lines(b), label).toContain("Program log: panicked at src/wide_math.rs:1554:30:\nmul_div_floor_u128: a*b overflow");
        d.expectSame(m.slab, label);
        d.expectSame(ctx, label);
        pinned++;
      }
    // One or two lengths per distinct count: 1 distinct at 191, 26 at 180.
    expect(pinned).toBe(32);
    d.patch(m.slab, (b) => before.copy(b));
  });

  it("the funding rate of a patched config: i128::clamp's assertion and saturating_mul", async () => {
    // compute_current_funding_rate_e9 clamps with i128::clamp, which panics when min > max (a negative
    // funding_max_premium_bps or funding_max_e9_per_slot), and multiplies the premium by funding_k_bps with
    // saturating_mul. InitMarket and UpdateConfig refuse such values; a patched config holds them. The port used `if`
    // clamps (no panic) and a checked multiply (5100).
    const m = await d.market({ edit: (a) => (a.minOraclePriceCapE2bps = 1_000_000n) });
    const alice = await funded(m, 10n * SOL, "alice");
    const bob = await funded(m, 10n * SOL, "bob");
    await d.ok("TradeNoCpi", alice.key, [ix.tradeNoCpi(m, alice.key, bob.key, 1, 0, 10_000_000n)]);
    const markTwice = (b: Buffer) => b.writeBigUInt64LE(b.readBigUInt64LE(C.lastEffectivePriceE6) * 2n, C.markEwmaE6);
    const before = Buffer.from(d.data(m.slab));
    const cases: [string, (b: Buffer) => void, string][] = [
      ["max premium -1 bps", (b) => (markTwice(b), b.writeBigInt64LE(-1n, C.fundingMaxPremiumBps)), builtin("ProgramFailedToComplete")],
      ["max rate -1 per slot", (b) => (markTwice(b), b.writeBigInt64LE(-1n, C.fundingMaxE9PerSlot)), builtin("ProgramFailedToComplete")],
      ["max rate i64::MIN", (b) => (markTwice(b), b.writeBigInt64LE(-(1n << 63n), C.fundingMaxE9PerSlot)), builtin("ProgramFailedToComplete")],
      [
        "k at u64::MAX, premium at i64::MAX bps (saturates)",
        (b) => (markTwice(b), b.writeBigUInt64LE((1n << 64n) - 1n, C.fundingKBps), b.writeBigInt64LE((1n << 63n) - 1n, C.fundingMaxPremiumBps)),
        "ok",
      ],
      [
        "k at u64::MAX, the mark below the index (saturates negative)",
        (b) => {
          b.writeBigUInt64LE(b.readBigUInt64LE(C.lastEffectivePriceE6) / 2n, C.markEwmaE6);
          b.writeBigUInt64LE((1n << 64n) - 1n, C.fundingKBps);
          b.writeBigInt64LE((1n << 63n) - 1n, C.fundingMaxPremiumBps);
        },
        "ok",
      ],
    ];
    for (const [label, edit, want] of cases) {
      d.patch(m.slab, edit);
      d.setClock(d.slot + 2n);
      d.setPrice(m, 100_000_000n);
      const got = await d.both(`SettleAccount: ${label}`, alice.key, [ix.settleAccount(m, 0)]);
      if (want !== "ok") {
        expect(got).toBe(want);
        expect(d.lastLogs).toContain("cmp.rs:1031:9:\nassertion failed: min <= max");
      }
      d.patch(m.slab, (b) => before.copy(b));
    }
  });
  it("SetOraclePriceCap on a Hyperp market: fewer compute units than the original with any funding config", async () => {
    // The slab fuzzer's 20-fold run found SetOraclePriceCap on a Hyperp market with a patched funding config (a horizon
    // of 0, k at 10^15) costing the port 2 to 4 units more than the original: the port copied the 400-byte config in
    // and out three times. It now changes it in place, as UpdateConfig does.
    const m = await d.market({
      edit: (a) => {
        a.feedId = Buffer.alloc(32);
        a.initialMarkPriceE6 = 1_000_000n;
        a.tail!.markMinFee = 10n;
      },
    });
    const before = Buffer.from(d.data(m.slab));
    for (const [label, edit] of [
      ["as initialized", () => {}],
      ["funding horizon 0", (b: Buffer) => b.writeBigUInt64LE(0n, C.fundingHorizonSlots)],
      ["funding k 10^15", (b: Buffer) => b.writeBigUInt64LE(10n ** 15n, C.fundingKBps)],
      ["oracle cap 0", (b: Buffer) => b.writeBigUInt64LE(0n, C.oraclePriceCapE2bps)],
      ["index slot 10^12 + 1", (b: Buffer) => b.writeBigUInt64LE(10n ** 12n + 1n, C.lastHyperpIndexSlot)],
    ] as [string, (b: Buffer) => void][]) {
      d.patch(m.slab, edit);
      d.setClock(d.slot + 3n);
      await d.ok(`SetOraclePriceCap: ${label}`, m.admin, [ix.setOraclePriceCap(m, m.admin, 5_000n)]);
      d.patch(m.slab, (b) => before.copy(b));
    }
  });
});
