// The managed marks (ConfigureEwmaMark 35, PushEwmaMark 36, ConfigureAuthMark 62, PushAuthMark 63) and SetMatcherConfig
// (68) of the Percolator v16 port (showcase/mainnet/percolator-v16) against the reference: Percolator v16 at commit
// 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0;
// test/programs/percolator_v16.so is the Rust build of those commits, not a deployed program. Every transaction is
// compared whole (percolator-v16-helpers.ts `Diff`); the port must use fewer compute units on each success. Each
// instruction: its success paths across the argument space, then each refusal of its own checks in order, then a
// seeded fuzz of marks, half-lives, minimum fees and slot gaps (PERCOLATOR_V16_MARK_FUZZ, 300 pushes by default).
import { type Address, type Instruction, AccountRole } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { pda } from "../../test/harness.js";
import { Rng } from "./fuzz-rng.js";
import { Diff, HAVE_PORT, HAVE_REFERENCE, MATCHERS, type Market, PROGRAM, SLOT, err, errB, ix, marketAt, portfolioAt } from "./percolator-v16-helpers.js";
import { MARKET, PORTFOLIO } from "./percolator-v16-layout.js";

const E = {
  InvalidAccountLen: 5,
  ExpectedSigner: 6,
  ExpectedWritable: 7,
  Unauthorized: 8,
  InvalidInstruction: 9,
  EngineStale: 19,
  EngineLockActive: 21,
  EngineCounterOverflow: 24,
  OracleInvalid: 26,
  OracleStale: 27,
  AssetGenerationMismatch: 30,
} as const;
const MAX_PRICE = 1_000_000_000_000n;
const MARK_FUZZ = Number(process.env.PERCOLATOR_V16_MARK_FUZZ ?? 300);
const SEED = BigInt(process.env.PERCOLATOR_FUZZ_SEED ?? "1618");

/** The control sequences of slot `i` (AssetControlSequencesV16): oracle observation at 0, authority epoch at 16. */
const controls = (i: number) => MARKET.slots + i * MARKET.slotLen + MARKET.controlSequences;

/** An instruction with one account's role changed. */
function role(i: Instruction, at: number, r: AccountRole): Instruction {
  const accounts = [...(i.accounts ?? [])] as { address: Address; role: AccountRole }[];
  accounts[at] = { address: accounts[at]!.address, role: r };
  return { ...i, accounts: accounts as Instruction["accounts"] };
}

function setUint(b: Buffer, at: number, size: number, v: bigint): void {
  for (let i = 0; i < size; i++) b[at + i] = Number((v >> BigInt(8 * i)) & 0xffn);
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: managed marks and SetMatcherConfig", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });

  /** A market of two assets (capacity 3), the Clock at the market's slot. */
  async function twoAssets(): Promise<Market> {
    d.setClock(SLOT);
    return d.market({ capacity: 3, args: { maxPortfolioAssets: 2 } });
  }
  const seqOf = (m: Market, asset: number) => d.data(m.market).readBigUInt64LE(controls(asset));

  it("ConfigureAuthMark and PushAuthMark: both assets, marks at the bounds, same-slot and later pushes, funding transitions", async () => {
    const m = await twoAssets();
    const a = m.admin;
    for (const asset of [0, 1]) {
      const id = BigInt(asset + 1);
      await d.ok(`auth configure asset ${asset} mark 1`, a, [ix.configureAuthMark(m, a, { asset, marketId: id, mark: 1n, sequence: 1n, epoch: 0n })]);
      await d.ok(`auth configure asset ${asset} mark MAX`, a, [ix.configureAuthMark(m, a, { asset, marketId: id, mark: MAX_PRICE, sequence: 2n, epoch: 0n })]);
      await d.ok(`auth configure asset ${asset} mark 1e6`, a, [ix.configureAuthMark(m, a, { asset, marketId: id, mark: 1_000_000n, sequence: 5n, epoch: 0n })]);
      // Same slot: the funding mark moves at once (the mark's slot is the asset's).
      await d.ok(`auth push asset ${asset} same slot`, a, [ix.pushMark(63, m, a, { asset, marketId: id, mark: 2_000_000n, sequence: 6n, epoch: 0n })]);
      await d.ok(`auth push asset ${asset} unchanged`, a, [ix.pushMark(63, m, a, { asset, marketId: id, mark: 2_000_000n, sequence: 7n, epoch: 0n })]);
    }
    // Later slots: the first change becomes pending, later ones keep the first boundary, the same slot replaces it.
    let seq = 8n;
    for (const [dt, mark] of [
      [10n, 3_000_000n],
      [0n, 3_500_000n],
      [5n, 1n],
      [1000n, MAX_PRICE],
      [0n, MAX_PRICE],
      [7n, 999_999n],
    ] as const) {
      d.setClock(d.slot + dt);
      for (const asset of [0, 1])
        await d.ok(`auth push asset ${asset} +${dt} ${mark}`, a, [
          ix.pushMark(63, m, a, { asset, marketId: BigInt(asset + 1), mark, sequence: seq, epoch: 0n }),
        ]);
      seq++;
    }
    // The pending boundary activated by the asset's slot catching up (as an accrual would move it): the slot_last
    // patched past it, then a push.
    for (const asset of [0, 1]) {
      d.patch(m.market, (b) => b.writeBigUInt64LE(d.slot, marketAt.engine(asset, "asset.slot_last")));
      d.setClock(d.slot + 3n);
      await d.ok(`auth push asset ${asset} after the asset caught up`, a, [
        ix.pushMark(63, m, a, { asset, marketId: BigInt(asset + 1), mark: 4_000_000n, sequence: seq, epoch: 0n }),
      ]);
      seq++;
    }
    // Reconfiguring from AuthMark to EWMA and back.
    await d.ok("ewma configure asset 1 over auth", a, [
      ix.configureEwmaMark(m, a, { asset: 1, marketId: 2n, mark: 5n, halflife: 1n, minFee: 0n, sequence: seq, epoch: 0n }),
    ]);
    await d.ok("auth configure asset 1 over ewma", a, [ix.configureAuthMark(m, a, { asset: 1, marketId: 2n, mark: 7n, sequence: seq + 1n, epoch: 0n })]);
  });

  it("ConfigureEwmaMark and PushEwmaMark: half-lives, minimum fees, slot gaps, prices up and down", async () => {
    const m = await twoAssets();
    const a = m.admin;
    let seq = 1n;
    for (const [halflife, minFee] of [
      [1n, 0n],
      [600n, 0n],
      [600n, 5n],
      [0xffff_ffff_ffff_ffffn, 0n],
      [3n, 0xffff_ffff_ffff_ffffn],
    ] as const) {
      for (const asset of [0, 1]) {
        await d.ok(`ewma configure asset ${asset} h ${halflife} fee ${minFee}`, a, [
          ix.configureEwmaMark(m, a, { asset, marketId: BigInt(asset + 1), mark: 1_000_000n, halflife, minFee, sequence: seq, epoch: 0n }),
        ]);
        for (const [dt, mark] of [
          [0n, 9_000_000n],
          [1n, 9_000_000n],
          [1n, 1n],
          [100n, MAX_PRICE],
          [1_000_000n, 2n],
          [0n, 5n],
        ] as const) {
          d.setClock(d.slot + dt);
          seq++;
          await d.ok(`ewma push asset ${asset} h ${halflife} +${dt} ${mark}`, a, [
            ix.pushMark(36, m, a, { asset, marketId: BigInt(asset + 1), mark, sequence: seq, epoch: 0n }),
          ]);
        }
        seq++;
      }
    }
  });

  it("the managed marks' refusals, in order", async () => {
    const m = await twoAssets();
    const a = m.admin;
    const stranger = await d.funded();
    const cfgAuth = (o: Partial<{ asset: number; marketId: bigint; mark: bigint; sequence: bigint; epoch: bigint }> = {}) =>
      ix.configureAuthMark(m, a, { asset: 1, marketId: 2n, mark: 1_000_000n, sequence: seqOf(m, Math.min(o.asset ?? 1, 1)) + 1n, epoch: 0n, ...o });
    const push = (tag: 36 | 63, o: Partial<{ asset: number; marketId: bigint; mark: bigint; sequence: bigint; epoch: bigint }> = {}) =>
      ix.pushMark(tag, m, a, { asset: 1, marketId: 2n, mark: 1_000_000n, sequence: seqOf(m, Math.min(o.asset ?? 1, 1)) + 1n, epoch: 0n, ...o });
    // Accounts.
    await d.fails("configure: no accounts", a, [{ ...cfgAuth(), accounts: [] }], errB("NotEnoughAccountKeys"));
    await d.fails("configure: one account", a, [{ ...cfgAuth(), accounts: cfgAuth().accounts!.slice(0, 1) }], errB("NotEnoughAccountKeys"));
    await d.fails("configure: unsigned", stranger, [role(cfgAuth(), 0, AccountRole.READONLY)], err(E.ExpectedSigner));
    await d.fails("configure: market read-only", a, [role(cfgAuth(), 1, AccountRole.READONLY)], err(E.ExpectedWritable));
    await d.fails("push: market read-only", a, [role(push(63), 1, AccountRole.READONLY)], err(E.ExpectedWritable));
    // Arguments.
    await d.fails("configure: mark 0", a, [cfgAuth({ mark: 0n })], err(E.InvalidInstruction));
    await d.fails("configure: mark above MAX", a, [cfgAuth({ mark: MAX_PRICE + 1n })], err(E.InvalidInstruction));
    await d.fails(
      "configure ewma: half-life 0",
      a,
      [ix.configureEwmaMark(m, a, { asset: 1, marketId: 2n, mark: 5n, halflife: 0n, minFee: 0n, sequence: 9n, epoch: 0n })],
      err(E.InvalidInstruction),
    );
    await d.fails("push: mark 0", a, [push(63, { mark: 0n })], err(E.OracleInvalid));
    await d.fails("push: mark above MAX", a, [push(63, { mark: MAX_PRICE + 1n })], err(E.OracleInvalid));
    // The asset and its generation.
    await d.fails("configure: asset 2 (not configured)", a, [cfgAuth({ asset: 2, marketId: 3n })], err(E.InvalidInstruction));
    await d.fails("configure: asset 0xffff", a, [cfgAuth({ asset: 0xffff, marketId: 3n })], err(E.InvalidInstruction));
    await d.fails("configure: wrong generation", a, [cfgAuth({ marketId: 1n })], err(E.AssetGenerationMismatch));
    await d.fails("push: wrong generation", a, [push(63, { marketId: 3n })], err(E.AssetGenerationMismatch));
    // The profile of the instruction's mode: a Manual asset refuses both pushes.
    await d.fails("push auth on a Manual asset", a, [push(63)], err(E.Unauthorized));
    await d.fails("push ewma on a Manual asset", a, [push(36)], err(E.Unauthorized));
    await d.ok("configure auth asset 1", a, [cfgAuth()]);
    await d.fails("push ewma on an AuthMark asset", a, [push(36)], err(E.Unauthorized));
    // Authorities, epochs, sequences.
    await d.fails(
      "configure: another signer",
      stranger,
      [ix.configureAuthMark(m, stranger, { asset: 1, marketId: 2n, mark: 5n, sequence: 99n, epoch: 0n })],
      err(E.Unauthorized),
    );
    await d.fails(
      "push: another signer",
      stranger,
      [ix.pushMark(63, m, stranger, { asset: 1, marketId: 2n, mark: 5n, sequence: 99n, epoch: 0n })],
      err(E.Unauthorized),
    );
    await d.fails("configure: wrong epoch", a, [cfgAuth({ epoch: 1n })], err(E.EngineStale));
    await d.fails("push: wrong epoch", a, [push(63, { epoch: 1n })], err(E.EngineStale));
    await d.fails("configure: stale sequence", a, [cfgAuth({ sequence: seqOf(m, 1) })], err(E.EngineStale));
    await d.fails("push: stale sequence", a, [push(63, { sequence: seqOf(m, 1) })], err(E.EngineStale));
    // The Clock behind the market's slot, and behind the mark's.
    d.setClock(SLOT - 1n);
    await d.fails("configure: the Clock behind the market", a, [cfgAuth()], err(E.EngineStale));
    await d.fails("push: the Clock behind the mark", a, [push(63)], err(E.EngineStale));
    d.setClock(SLOT + 10n);
    await d.ok("push auth asset 1 later", a, [push(63, { mark: 2n })]);
    // The market's mode, the asset's lifecycle and state, the market's stress flags (patched, then restored).
    const before = d.data(m.market);
    const restore = () => d.patch(m.market, (b) => before.copy(b));
    // `expected` null: compared with the reference only.
    const patched = async (label: string, at: number, size: number, v: bigint, tx: () => Instruction, expected: string | null) => {
      d.patch(m.market, (b) => setUint(b, at, size, v));
      const got = await d.send(label, a, [tx()]);
      if (expected !== null) expect(got, label).toBe(expected);
      restore();
    };
    await patched("configure: market Resolved", marketAt.group("mode"), 1, 1n, () => cfgAuth(), err(E.EngineLockActive));
    await patched("push: market Resolved", marketAt.group("mode"), 1, 1n, () => push(63), err(E.EngineLockActive));
    await patched("configure: market mode 7", marketAt.group("mode"), 1, 7n, () => cfgAuth(), err(E.EngineLockActive));
    for (const life of [0n, 1n, 3n, 4n, 5n, 6n])
      await patched(`configure: lifecycle ${life}`, marketAt.engine(1, "asset.lifecycle"), 1, life, () => cfgAuth(), err(E.EngineLockActive));
    for (const life of [0n, 1n, 4n, 5n])
      await patched(`push: lifecycle ${life}`, marketAt.engine(1, "asset.lifecycle"), 1, life, () => push(63), err(E.EngineLockActive));
    await patched("push: lifecycle DrainOnly", marketAt.engine(1, "asset.lifecycle"), 1, 3n, () => push(63, { mark: 3n }), "ok");
    for (const f of [
      "asset.oi_eff_long_q",
      "asset.stored_pos_count_short",
      "asset.b_short_num",
      "asset.social_loss_dust_long_num",
      "asset.mode_long",
      "pending_domain_loss_barrier_short",
    ])
      await patched(`configure: ${f} nonzero`, marketAt.engine(1, f), 1, 1n, () => cfgAuth(), err(E.EngineLockActive));
    await patched("configure: bankruptcy h-lock", marketAt.group("bankruptcy_hlock_active"), 1, 1n, () => cfgAuth(), err(E.EngineLockActive));
    await patched("configure: threshold stress", marketAt.group("threshold_stress_active"), 1, 1n, () => cfgAuth(), err(E.EngineLockActive));
    await patched("configure: recovery reason present", marketAt.group("recovery_reason.present"), 1, 1n, () => cfgAuth(), err(E.EngineLockActive));
    await patched("configure: recovery reason byte 2", marketAt.group("recovery_reason.present"), 1, 2n, () => cfgAuth(), null);
    await patched(
      "configure asset 0: a stale certificate",
      marketAt.group("stale_certificate_count"),
      8,
      1n,
      () => cfgAuth({ asset: 0, marketId: 1n }),
      err(E.EngineLockActive),
    );
    await patched(
      "configure asset 0: loss stale",
      marketAt.group("loss_stale_active"),
      1,
      1n,
      () => cfgAuth({ asset: 0, marketId: 1n }),
      err(E.EngineLockActive),
    );
    await patched("configure asset 1: loss stale (asset 1 is target-scoped)", marketAt.group("loss_stale_active"), 1, 1n, () => cfgAuth(), null);
    await patched(
      "push: oracle epoch at u64::MAX",
      marketAt.group("oracle_epoch"),
      8,
      0xffff_ffff_ffff_ffffn,
      () => push(63, { mark: 77n }),
      err(E.EngineCounterOverflow),
    );
    await patched(
      "push: unchanged target with the oracle epoch at u64::MAX",
      marketAt.group("oracle_epoch"),
      8,
      0xffff_ffff_ffff_ffffn,
      () => push(63, { mark: 2n }),
      "ok",
    );
    await patched(
      "push: one blocker count at u64::MAX",
      marketAt.engine(1, "asset.stored_pos_count_long"),
      8,
      0xffff_ffff_ffff_ffffn,
      () => push(63, { mark: 9n }),
      "ok",
    );
    d.patch(m.market, (b) => b.writeBigUInt64LE(1n, marketAt.engine(1, "pending_domain_loss_barrier_short")));
    await patched(
      "push: the blocker counts overflow",
      marketAt.engine(1, "asset.stored_pos_count_long"),
      8,
      0xffff_ffff_ffff_ffffn,
      () => push(63, { mark: 9n }),
      err(E.EngineCounterOverflow),
    );
    // The funding transition refused: the pending boundary (set by the push above) later than the push's slot.
    await patched(
      "push: pending funding boundary ahead",
      marketAt.profile(1, "funding_mark_pending_slot"),
      8,
      SLOT + 1000n,
      () => push(63, { mark: 11n }),
      err(E.EngineStale),
    );
    // The stale window matured: asset 1 refused, asset 0 not.
    await d.ok("permissionless resolve window", a, [ix.permissionlessResolve(m, a, 3n, 100n, 1n, 1n, 0n)]);
    d.setClock(d.slot + 200n);
    await d.fails("configure asset 1 after the stale window", a, [cfgAuth()], err(E.OracleStale));
    await d.fails("push asset 1 after the stale window", a, [push(63)], err(E.OracleStale));
    await d.ok("configure asset 0 after the stale window", a, [cfgAuth({ asset: 0, marketId: 1n })]);
    await d.ok("push asset 0 after the stale window", a, [push(63, { asset: 0, marketId: 1n, mark: 3n })]);
    const other = await d.newMarket();
    await d.fails(
      "configure on an uninitialized market",
      a,
      [ix.configureAuthMark(other, a, { asset: 0, marketId: 1n, mark: 1n, sequence: 1n, epoch: 0n })],
      errB("InstructionErrorCustom { code: 3 }"),
    );
  });

  it(`a seeded fuzz of ${MARK_FUZZ} pushes: random marks, half-lives, minimum fees and slot gaps, with state patches`, async () => {
    const rng = new Rng(SEED + 35n);
    const m = await twoAssets();
    const a = m.admin;
    const pick = <T>(xs: readonly T[]) => xs[rng.int(xs.length)]!;
    const price = () => pick([1n, 2n, 999_999n, 1_000_000n, 1_000_001n, MAX_PRICE - 1n, MAX_PRICE, BigInt(1 + rng.int(2_000_000_000)), MAX_PRICE + 1n, 0n]);
    const life = [0n, 1n, 2n, 3n, 600n, 1_000_000n, 0xffff_ffff_ffff_ffffn];
    let ok = 0;
    for (let n = 0; n < MARK_FUZZ; n++) {
      const asset = rng.int(2);
      const id = BigInt(asset + 1);
      const roll = rng.int(100);
      if (roll < 8) {
        const ewma = rng.chance(60);
        const tx = ewma
          ? ix.configureEwmaMark(m, a, {
              asset,
              marketId: id,
              mark: price(),
              halflife: pick(life),
              minFee: pick([0n, 0n, 1n, 1000n, 0xffff_ffff_ffff_ffffn]),
              sequence: seqOf(m, asset) + 1n,
              epoch: 0n,
            })
          : ix.configureAuthMark(m, a, { asset, marketId: id, mark: price(), sequence: seqOf(m, asset) + 1n, epoch: 0n });
        if ((await d.send(`fuzz ${n} configure ${ewma ? "ewma" : "auth"} ${asset}`, a, [tx])) === "ok") ok++;
        continue;
      }
      // The asset's slot moved (as an accrual moves it: kept), or a funding field set to a boundary for one push.
      let undo: Buffer | null = null;
      if (roll < 20) {
        const f = pick([
          "asset.slot_last",
          "asset.slot_last",
          "funding_mark_pending_slot",
          "funding_mark_pending_e6",
          "funding_mark_e6",
          "mark_ewma_last_slot",
        ]);
        const v = pick([0n, d.slot - 5n, d.slot, d.slot + 5n, BigInt(rng.int(1_000_000))]);
        if (!f.startsWith("asset.")) undo = d.data(m.market);
        d.patch(m.market, (b) => b.writeBigUInt64LE(v, f.startsWith("asset.") ? marketAt.engine(asset, f) : marketAt.profile(asset, f)));
      }
      if (rng.chance(40)) d.setClock(d.slot + BigInt(pick([0, 1, 2, 7, 100, 10_000, 1_000_000, rng.int(5000)])));
      // The push of the asset's own mode most of the time.
      const mode = d.data(m.market)[marketAt.profile(asset, "oracle_mode")]!;
      const tag = rng.chance(85) ? (mode === 2 ? 36 : 63) : rng.chance(50) ? 36 : 63;
      if (
        (await d.send(`fuzz ${n} push ${tag} ${asset}`, a, [
          ix.pushMark(tag, m, a, { asset, marketId: id, mark: price(), sequence: seqOf(m, asset) + 1n, epoch: 0n }),
        ])) === "ok"
      )
        ok++;
      const saved = undo;
      if (saved) d.patch(m.market, (b) => saved.copy(b));
    }
    console.log(`mark fuzz: ${MARK_FUZZ} transactions compared, ${ok} succeeded in both`);
    expect(ok).toBeGreaterThan(MARK_FUZZ / 5);
  }, 600_000);

  it("SetMatcherConfig (68): enable, disable, legacy lengths, every check", async () => {
    d.setClock(SLOT);
    const m = await d.market({ capacity: 1 });
    const { owner, portfolio } = await d.newPortfolio();
    await d.ok("init portfolio", owner, [ix.initPortfolio(m, owner, portfolio)]);
    const program = MATCHERS.auth.id;
    const context = await d.address();
    d.write(context, program, new Uint8Array(64));
    const [delegate] = await pda(PROGRAM, ["matcher", m.market, portfolio, owner.address, program, context]);
    const frontier = () => d.data(m.market).readBigUInt64LE(marketAt.group("next_market_id"));
    const epochOf = () => (d.data(portfolio).readBigUInt64LE(PORTFOLIO.matcherConfig + 96) >> 1n) & 0x1_ffff_ffff_ffffn;
    const args = (o: Partial<{ id: bigint; sequence: bigint; epoch: bigint; frontier: bigint; enabled: number; cap: number; expiry: bigint }> = {}) => ({
      id: d.portfolioId(portfolio),
      sequence: d.portfolioSequence(portfolio),
      epoch: epochOf(),
      frontier: frontier(),
      enabled: 1,
      cap: 10_000,
      expiry: 0xffff_ffff_ffff_ffffn,
      ...o,
    });
    const matcher = { program, context, delegate };
    const tx = (o: Parameters<typeof args>[0] = {}, mm: typeof matcher | undefined = matcher) => ix.setMatcherConfig(m, owner, portfolio, args(o), mm);
    await d.ok("enable, cap 10000, expiry u64::MAX", owner, [tx()]);
    await d.ok("enable, cap 0, expiry next slot", owner, [tx({ cap: 0, expiry: SLOT + 1n })]);
    await d.ok("enable, cap 1234", owner, [tx({ cap: 1234 })]);
    await d.ok("disable", owner, [tx({ enabled: 0, cap: 0, expiry: 0n }, undefined)]);
    await d.ok("disable again, with the matcher accounts", owner, [tx({ enabled: 0, cap: 0, expiry: 0n })]);
    await d.ok("enable again", owner, [tx()]);
    // The shape against the Clock, before any account.
    for (const [label, o] of [
      ["enabled 2", { enabled: 2 }],
      ["enabled 255", { enabled: 255 }],
      ["cap 10001", { cap: 10_001 }],
      ["expiry 0", { expiry: 0n }],
      ["expiry at the Clock", { expiry: SLOT }],
      ["disabled with a cap", { enabled: 0, cap: 1, expiry: 0n }],
      ["disabled with an expiry", { enabled: 0, cap: 0, expiry: 1n }],
    ] as const) {
      await d.fails(`shape: ${label}`, owner, [tx(o)], err(E.InvalidInstruction));
      await d.fails(`shape: ${label}, no accounts`, owner, [{ ...tx(o), accounts: [] }], err(E.InvalidInstruction));
    }
    await d.fails("no accounts", owner, [{ ...tx(), accounts: [] }], errB("NotEnoughAccountKeys"));
    await d.fails("two accounts", owner, [{ ...tx(), accounts: tx().accounts!.slice(0, 2) }], errB("NotEnoughAccountKeys"));
    await d.fails("three accounts, enabled", owner, [{ ...tx(), accounts: tx().accounts!.slice(0, 3) }], errB("NotEnoughAccountKeys"));
    await d.fails("five accounts, enabled", owner, [{ ...tx(), accounts: tx().accounts!.slice(0, 5) }], errB("NotEnoughAccountKeys"));
    const payer = await d.funded();
    await d.fails("unsigned", payer, [role(tx(), 0, AccountRole.WRITABLE)], err(E.ExpectedSigner));
    await d.fails("portfolio read-only", owner, [role(tx(), 2, AccountRole.READONLY)], err(E.ExpectedWritable));
    await d.ok("market writable is accepted", owner, [role(tx(), 1, AccountRole.WRITABLE)]);
    const stranger = await d.funded();
    await d.fails("another signer", stranger, [ix.setMatcherConfig(m, stranger, portfolio, args(), matcher)], err(E.Unauthorized));
    const m2 = await d.market({ capacity: 1, label: "second market" });
    await d.fails("another market", owner, [ix.setMatcherConfig(m2, owner, portfolio, args({ frontier: 2n }), matcher)], err(E.Unauthorized));
    await d.fails("wrong frontier", owner, [tx({ frontier: frontier() + 1n })], err(E.EngineStale));
    await d.fails("wrong id", owner, [tx({ id: d.portfolioId(portfolio) + 1n })], err(E.EngineStale));
    await d.fails("wrong sequence", owner, [tx({ sequence: d.portfolioSequence(portfolio) + 1n })], err(E.EngineStale));
    await d.fails("wrong epoch", owner, [tx({ epoch: 1n })], err(E.EngineStale));
    await d.fails("the program itself as the matcher", owner, [tx({}, { ...matcher, program: PROGRAM })], err(E.InvalidInstruction));
    await d.fails("a non-executable matcher", owner, [tx({}, { ...matcher, program: context })], err(E.InvalidInstruction));
    const shortCtx = await d.address();
    d.write(shortCtx, program, new Uint8Array(63));
    const [shortDelegate] = await pda(PROGRAM, ["matcher", m.market, portfolio, owner.address, program, shortCtx]);
    await d.fails("a 63-byte context", owner, [tx({}, { program, context: shortCtx, delegate: shortDelegate })], err(E.InvalidInstruction));
    await d.fails("a context of another owner", owner, [tx({}, { program: MATCHERS.match.id, context, delegate })], err(E.InvalidInstruction));
    await d.fails("an executable context", owner, [tx({}, { program, context: MATCHERS.hostile.id, delegate })], err(E.InvalidInstruction));
    await d.fails("the wrong delegate", owner, [tx({}, { ...matcher, delegate: context })], errB("InvalidArgument"));
    // The portfolio's words: an owner-state sequence at u64::MAX, a fee cap above 10,000, the provenance.
    const before = d.data(portfolio);
    const restore = () => d.patch(portfolio, (b) => before.copy(b));
    d.patch(portfolio, (b) => b.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 9547));
    await d.fails("sequence at u64::MAX", owner, [tx()], err(E.EngineCounterOverflow));
    restore();
    d.patch(portfolio, (b) => b.writeBigUInt64LE(10_001n << 50n, PORTFOLIO.matcherConfig + 96));
    await d.fails("a stored fee cap above 10000", owner, [tx({ epoch: 0n })], errB("InvalidAccountData"));
    restore();
    d.patch(portfolio, (b) => b.writeUInt16LE(2, portfolioAt("provenance_header.version")));
    await d.fails("provenance version 2", owner, [tx()], errB("InvalidAccountData"));
    restore();
    d.patch(portfolio, (b) => (b[portfolioAt("owner")] ^= 1));
    await d.fails("the portfolio's owner field differs", owner, [tx()], errB("InvalidAccountData"));
    restore();
    // Legacy lengths: an account ending before the expiry (9,555) or the sequence (9,547) is grown to its length.
    for (const len of [9555, 9547]) {
      const p = await d.newPortfolio();
      await d.ok(`init portfolio for ${len}`, p.owner, [ix.initPortfolio(m, p.owner, p.portfolio)]);
      const bytes = d.data(p.portfolio).subarray(0, len);
      d.write(p.portfolio, PROGRAM, bytes, d.reference.minimumBalanceForRentExemption(9563n));
      const [dl] = await pda(PROGRAM, ["matcher", m.market, p.portfolio, p.owner.address, program, context]);
      const id = d.data(p.portfolio).readBigUInt64LE(9539);
      const sequence = len === 9547 ? 0n : d.data(p.portfolio).readBigUInt64LE(9547);
      await d.ok(`a ${len}-byte portfolio`, p.owner, [
        ix.setMatcherConfig(
          m,
          p.owner,
          p.portfolio,
          { id, sequence, epoch: 0n, frontier: frontier(), enabled: 1, cap: 10_000, expiry: SLOT + 9n },
          { program, context, delegate: dl },
        ),
      ]);
    }
    const long = await d.newPortfolio();
    await d.ok("init portfolio for 9564", long.owner, [ix.initPortfolio(m, long.owner, long.portfolio)]);
    d.write(long.portfolio, PROGRAM, Buffer.concat([d.data(long.portfolio), Buffer.alloc(1)]));
    const [longDelegate] = await pda(PROGRAM, ["matcher", m.market, long.portfolio, long.owner.address, program, context]);
    await d.fails(
      "a portfolio longer than its length",
      long.owner,
      [
        ix.setMatcherConfig(
          m,
          long.owner,
          long.portfolio,
          { id: d.portfolioId(long.portfolio), sequence: 0n, epoch: 0n, frontier: frontier(), enabled: 1, cap: 1, expiry: SLOT + 9n },
          { program, context, delegate: longDelegate },
        ),
      ],
      err(E.InvalidAccountLen),
    );
  });
});
