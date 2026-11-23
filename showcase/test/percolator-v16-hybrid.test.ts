// ConfigureHybridOracle (tag 34) of the Percolator v16 port (showcase/mainnet/percolator-v16/oracle.ts and external.ts)
// against the reference: Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so is the Rust build of those commits, not a deployed
// program. Every transaction is compared whole (percolator-v16-helpers.ts `Diff`); the port must use fewer compute units
// on each success. The oracle accounts are synthetic (percolator-v16-oracles.ts): Pyth PriceUpdateV2, Switchboard
// On-Demand (mainnet and devnet owners) and Chainlink OCR2, alone and as composites of two and three legs.
//
// Success paths across the argument space; every refusal in order, of the instruction's own checks and of each
// source's reader field by field; then a seeded fuzz (PERCOLATOR_V16_HYBRID_FUZZ, 400 by default) of legs with one
// field at or past a boundary, composites, flags, inversions, unit scales, confidence filters, staleness limits and the
// Clock's unix time around them.
import { type Address, type Instruction, AccountRole } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { Diff, HAVE_PORT, HAVE_REFERENCE, type HybridArgs, type Market, SLOT, err, errB, ix, marketAt } from "./percolator-v16-helpers.js";
import { MARKET } from "./percolator-v16-layout.js";
import {
  MAX_PRICE,
  type OracleAccount,
  PYTH_RECEIVER,
  chainlinkData,
  keyBytes,
  legAt,
  pythData,
  randomLeg,
  switchboardData,
} from "./percolator-v16-oracles.js";

const E = {
  ExpectedSigner: 6,
  ExpectedWritable: 7,
  Unauthorized: 8,
  InvalidInstruction: 9,
  EngineInvalidConfig: 14,
  EngineArithmeticOverflow: 15,
  EngineStale: 19,
  EngineLockActive: 21,
  OracleInvalid: 26,
  OracleStale: 27,
  OracleConfTooWide: 28,
  InvalidOracleKey: 29,
  AssetGenerationMismatch: 30,
} as const;
const FUZZ = Number(process.env.PERCOLATOR_V16_HYBRID_FUZZ ?? 400);
const SEED = BigInt(process.env.PERCOLATOR_FUZZ_SEED ?? "1618");
const controls = (i: number) => MARKET.slots + i * MARKET.slotLen + MARKET.controlSequences;
const KINDS = ["pyth", "switchboard", "chainlink"] as const;

function role(i: Instruction, at: number, r: AccountRole): Instruction {
  const accounts = [...(i.accounts ?? [])] as { address: Address; role: AccountRole }[];
  accounts[at] = { address: accounts[at]!.address, role: r };
  return { ...i, accounts: accounts as Instruction["accounts"] };
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: ConfigureHybridOracle and the external oracles", () => {
  let d: Diff;
  const rng = new Rng(SEED);
  beforeAll(async () => {
    d = await Diff.create();
  });

  async function twoAssets(): Promise<Market> {
    d.setClock(SLOT);
    return d.market({ capacity: 3, args: { maxPortfolioAssets: 2, maxAbsFundingE9PerSlot: 1_000n } });
  }
  const seqOf = (m: Market, asset: number) => d.data(m.market).readBigUInt64LE(controls(asset));
  const put = (l: OracleAccount) => d.write(l.key, l.owner, l.data);
  /** The tag-34 instruction for `legs` (written into both VMs), the defaults overridden by `o`. */
  function hybrid(m: Market, legs: OracleAccount[], o: Partial<HybridArgs> = {}, accounts?: Address[], signer = m.admin): Instruction {
    for (const l of legs) put(l);
    const asset = o.asset ?? 1;
    const a: HybridArgs = {
      asset,
      marketId: BigInt(asset + 1),
      count: legs.length,
      flags: 0,
      maxStaleness: 60n,
      softStale: 100n,
      halflife: 600n,
      minFee: 0n,
      invert: 0,
      unitScale: 0n,
      confBps: 0n,
      feeds: legs.map((l) => l.feed),
      sequence: seqOf(m, Math.min(asset, 1)) + 1n,
      epoch: 0n,
      ...o,
    };
    return ix.configureHybridOracle(m, signer, a, accounts ?? legs.map((l) => l.key));
  }
  const now = () => d.unixTimestamp;

  it("successes: each source alone on both assets at the price bounds, composites of two and three legs, reconfigurations", async () => {
    const m = await twoAssets();
    const a = m.admin;
    let ok = 0;
    for (const asset of [0, 1])
      for (const kind of KINDS)
        for (const devnet of kind === "switchboard" ? [false, true] : [false])
          for (const e6 of [1n, 1_000_000n, MAX_PRICE]) {
            await d.ok(`${kind}${devnet ? " devnet" : ""} asset ${asset} ${e6}`, a, [hybrid(m, [legAt(rng, kind, e6, now() - 1n, { devnet })], { asset })]);
            ok++;
          }
    // Composites: every flag the leg count allows, inverted or not, unit scales; mixed sources. Some leave the range
    // (compared, refused by both).
    for (const count of [2, 3])
      for (const flags of count === 2 ? [0, 1] : [0, 1, 2, 3])
        for (const invert of [0, 1])
          for (const unitScale of [0n, 1n, 7n, 1_000_000n]) {
            const legs = [2_000_000n, 3_000_000n, 500_000n].slice(0, count).map((e6, i) => legAt(rng, KINDS[(i + flags) % 3]!, e6, now() - 2n));
            if (
              (await d.send(`composite ${count} flags ${flags} invert ${invert} scale ${unitScale}`, a, [hybrid(m, legs, { flags, invert, unitScale })])) ===
              "ok"
            )
              ok++;
          }
    // The staleness limit (inclusive), the confidence filter at its exact boundary, the soft-stale and EWMA fields.
    await d.ok("pyth published exactly max_staleness ago", a, [hybrid(m, [legAt(rng, "pyth", 5n, now() - 60n)])]);
    await d.ok("chainlink published now", a, [hybrid(m, [legAt(rng, "chainlink", 5n, now())], { maxStaleness: 1n })]);
    const feedId = rng.bytes(32);
    const exact = { key: (await d.address()) as Address, owner: PYTH_RECEIVER, feed: feedId, kind: "pyth" as const, what: "conf at the boundary" };
    await d.ok("pyth conf exactly at the filter", a, [
      hybrid(m, [{ ...exact, data: pythData({ feedId, price: 1_000_000n, conf: 5_000n, expo: -6, publishTime: now() }) }], { confBps: 50n }),
    ]);
    await d.ok("u64::MAX staleness, soft-stale, half-life and minimum fee", a, [
      hybrid(m, [legAt(rng, "switchboard", 77n, now() - 5n)], {
        maxStaleness: (1n << 64n) - 1n,
        softStale: (1n << 64n) - 1n,
        halflife: (1n << 64n) - 1n,
        minFee: (1n << 64n) - 1n,
      }),
    ]);
    // Reconfiguring: hybrid again, then AuthMark and EWMA over a hybrid asset and hybrid over them; the pushes refuse a
    // hybrid asset.
    for (const asset of [0, 1]) {
      d.setClock(d.slot + 10n);
      await d.ok(`hybrid again asset ${asset}`, a, [hybrid(m, [legAt(rng, "pyth", 9_999n, now())], { asset })]);
      await d.fails(
        `push auth on hybrid asset ${asset}`,
        a,
        [ix.pushMark(63, m, a, { asset, marketId: BigInt(asset + 1), mark: 5n, sequence: seqOf(m, asset) + 1n, epoch: 0n })],
        err(E.Unauthorized),
      );
      await d.fails(
        `push ewma on hybrid asset ${asset}`,
        a,
        [ix.pushMark(36, m, a, { asset, marketId: BigInt(asset + 1), mark: 5n, sequence: seqOf(m, asset) + 1n, epoch: 0n })],
        err(E.Unauthorized),
      );
      await d.ok(`auth over hybrid asset ${asset}`, a, [
        ix.configureAuthMark(m, a, { asset, marketId: BigInt(asset + 1), mark: 3n, sequence: seqOf(m, asset) + 1n, epoch: 0n }),
      ]);
      await d.ok(`hybrid over auth asset ${asset}`, a, [hybrid(m, [legAt(rng, "chainlink", 12n, now())], { asset })]);
      await d.ok(`ewma over hybrid asset ${asset}`, a, [
        ix.configureEwmaMark(m, a, { asset, marketId: BigInt(asset + 1), mark: 3n, halflife: 5n, minFee: 0n, sequence: seqOf(m, asset) + 1n, epoch: 0n }),
      ]);
      await d.ok(`hybrid over ewma asset ${asset}`, a, [hybrid(m, [legAt(rng, "switchboard", 13n, now())], { asset })]);
    }
    // A hybrid asset shut down (its committed funding accrued with the hybrid profile as the price-managed one, its marks
    // frozen), then refused by ConfigureHybridOracle; the restart and asset 0's shutdown compared whatever they answer.
    await d.ok("force-close delay", a, [ix.permissionlessResolve(m, a, 3n, 6_000_000n, 10n, 1n, 0n)]);
    d.setClock(d.slot + 3n);
    await d.ok("shutdown hybrid asset 1", a, [ix.assetLifecycle(m, a, { action: 2, asset: 1, marketId: 2n, epoch: 0n, nowSlot: 1n })]);
    await d.fails("configure hybrid on a Recovery asset", a, [hybrid(m, [legAt(rng, "pyth", 5n, now())])], err(E.EngineLockActive));
    d.setClock(d.slot + 20n);
    await d.send("restart asset 1", a, [ix.restartAssetOracle(m, a, { asset: 1, marketId: 2n, price: 4n, sequence: seqOf(m, 1) + 1n, epoch: 0n })]);
    await d.send("hybrid on the restarted asset", a, [hybrid(m, [legAt(rng, "chainlink", 6n, now())], { marketId: 3n })]);
    await d.send("shutdown hybrid asset 0", a, [ix.assetLifecycle(m, a, { action: 2, asset: 0, marketId: 1n, epoch: 0n, nowSlot: 1n })]);
    expect(ok).toBeGreaterThan(30);
  });

  it("refusals of the instruction, in order", async () => {
    const m = await twoAssets();
    const a = m.admin;
    const stranger = await d.funded();
    const leg = () => legAt(rng, "pyth", 1_000_000n, now() - 1n);
    const base = () => hybrid(m, [leg()]);
    await d.fails("no accounts", a, [{ ...base(), accounts: [] }], errB("NotEnoughAccountKeys"));
    await d.fails("one account", a, [{ ...base(), accounts: base().accounts!.slice(0, 1) }], errB("NotEnoughAccountKeys"));
    await d.fails("unsigned", stranger, [role(base(), 0, AccountRole.READONLY)], err(E.ExpectedSigner));
    await d.fails("market read-only", a, [role(base(), 1, AccountRole.READONLY)], err(E.ExpectedWritable));
    const notOwned = await d.address();
    d.write(notOwned, PYTH_RECEIVER, d.data(m.market));
    const other = base();
    await d.fails(
      "market of another owner",
      a,
      [{ ...other, accounts: [other.accounts![0]!, { address: notOwned, role: AccountRole.WRITABLE }, other.accounts![2]!] }],
      errB("IncorrectProgramId"),
    );
    // The arguments (InvalidInstruction), before the oracle accounts are looked at.
    const z = new Uint8Array(32);
    const [l1, l2, l3] = [leg(), leg(), leg()];
    for (const [label, o] of [
      ["count 0", { count: 0 }],
      ["count 4", { count: 4 }],
      ["count 255", { count: 255 }],
      ["unknown flag", { flags: 4 }],
      ["one leg with a divide flag", { flags: 1 }],
      ["two legs dividing leg 3", { count: 2, flags: 2, feeds: [l1.feed, l2.feed] }],
      ["feed 0 zero", { feeds: [z] }],
      ["one leg with a second feed", { feeds: [l1.feed, l2.feed] }],
      ["two legs, feed 1 zero", { count: 2, feeds: [l1.feed, z] }],
      ["two legs, the same feed", { count: 2, feeds: [l1.feed, l1.feed] }],
      ["two legs with a third feed", { count: 2, feeds: [l1.feed, l2.feed, l3.feed] }],
      ["three legs, feed 2 zero", { count: 3, feeds: [l1.feed, l2.feed, z] }],
      ["three legs, feed 2 = feed 0", { count: 3, feeds: [l1.feed, l2.feed, l1.feed] }],
      ["three legs, feed 2 = feed 1", { count: 3, feeds: [l1.feed, l2.feed, l2.feed] }],
      ["max staleness 0", { maxStaleness: 0n }],
      ["soft-stale 0", { softStale: 0n }],
      ["invert 2", { invert: 2 }],
    ] as [string, Partial<HybridArgs>][])
      await d.fails(`argument: ${label}`, a, [hybrid(m, [l1, l2, l3].slice(0, Math.min(3, o.count ?? 1) || 1), o)], err(E.InvalidInstruction));
    await d.fails("two legs, one account", a, [hybrid(m, [l1, l2], {}, [l1.key])], errB("NotEnoughAccountKeys"));
    // The market view.
    await d.fails("asset 2 (not configured)", a, [hybrid(m, [leg()], { asset: 2, marketId: 3n })], err(E.InvalidInstruction));
    await d.fails("asset 0xffff", a, [hybrid(m, [leg()], { asset: 0xffff, marketId: 3n, sequence: 1n })], err(E.InvalidInstruction));
    await d.fails("wrong generation", a, [hybrid(m, [leg()], { marketId: 1n })], err(E.AssetGenerationMismatch));
    d.setClock(SLOT - 1n);
    await d.fails("the Clock behind the market", a, [hybrid(m, [leg()])], err(E.EngineStale));
    d.setClock(SLOT + 5n);
    const before = d.data(m.market);
    const restore = () => d.patch(m.market, (b) => before.copy(b));
    for (const [label, edit] of [
      ["market resolved", (b: Buffer) => (b[marketAt.group("mode")] = 1)],
      ["asset 1 DrainOnly", (b: Buffer) => (b[marketAt.engine(1, "asset.lifecycle")] = 3)],
      ["asset 1 with open interest", (b: Buffer) => b.writeBigUInt64LE(1n, marketAt.engine(1, "asset.oi_eff_long_q"))],
      ["threshold stress", (b: Buffer) => (b[marketAt.group("threshold_stress_active")] = 1)],
    ] as [string, (b: Buffer) => void][]) {
      d.patch(m.market, edit);
      await d.send(`state: ${label}`, a, [hybrid(m, [leg()])]);
      restore();
    }
    // The stale window matured: refused for an asset other than 0, accepted for asset 0.
    await d.ok("stale window", a, [ix.permissionlessResolve(m, a, 3n, 50n, 10n, 1n, 0n)]);
    d.setClock(d.slot + 60n);
    await d.fails("asset 1 after the stale window", a, [hybrid(m, [leg()])], err(E.OracleStale));
    await d.send("asset 0 after the stale window", a, [hybrid(m, [leg()], { asset: 0 })]);
    const m2 = await twoAssets();
    const hyb2 = (legs: OracleAccount[], o: Partial<HybridArgs> = {}, accounts?: Address[]) => hybrid(m2, legs, o, accounts);
    await d.fails("another signer", stranger, [hybrid(m2, [leg()], {}, undefined, stranger)], err(E.Unauthorized));
    await d.fails("wrong epoch", m2.admin, [hyb2([leg()], { epoch: 1n })], err(E.EngineStale));
    await d.fails("stale sequence", m2.admin, [hyb2([leg()], { sequence: seqOf(m2, 1) })], err(E.EngineStale));
    // After the reads: the profile's own validation.
    await d.fails("half-life 0", m2.admin, [hyb2([leg()], { halflife: 0n })], errB("InvalidAccountData"));
    await d.fails("confidence filter 10,001 bps", m2.admin, [hyb2([leg()], { confBps: 10_001n })], errB("InvalidAccountData"));
    await d.fails("confidence filter u16::MAX", m2.admin, [hyb2([leg()], { confBps: 0xffffn })], errB("InvalidAccountData"));
    // Repeated accounts: the market as a leg (its data held: AccountBorrowFailed), the admin as a leg (system-owned:
    // IllegalOwner), one oracle account for two legs (two feeds, so the second leg's feed or key does not match).
    const l = leg();
    await d.fails("the market as the leg", m2.admin, [hyb2([l], {}, [m2.market])], errB("AccountBorrowFailed"));
    await d.fails("the admin as the leg", m2.admin, [hyb2([l], {}, [m2.admin.address])], errB("IllegalOwner"));
    const sb = legAt(rng, "switchboard", 7n, now());
    await d.fails("one account for two legs", m2.admin, [hyb2([sb, legAt(rng, "chainlink", 7n, now())], {}, [sb.key, sb.key])], err(E.InvalidOracleKey));
    await d.ok("the same leg account named twice beyond the legs", m2.admin, [hyb2([sb], {}, [sb.key, sb.key, m2.market])]);
  });

  it("refusals of each source's reader, field by field", async () => {
    const m = await twoAssets();
    const a = m.admin;
    const key = async () => (await d.address()) as Address;
    const pyth = async (o: Partial<Parameters<typeof pythData>[0]>, owner: Address = PYTH_RECEIVER): Promise<OracleAccount> => {
      const feedId = new Uint8Array(32).fill(7);
      const p = { feedId, price: 100_000_000n, conf: 1n, expo: -8, publishTime: now() - 1n, ...o };
      return { key: await key(), owner, data: pythData(p), feed: feedId, kind: "pyth", what: "pyth" };
    };
    const sw = async (o: Partial<Parameters<typeof switchboardData>[0]>, feedOther = false): Promise<OracleAccount> => {
      const k = await key();
      const data = switchboardData({ value: 2_000_000n * 1_000_000_000_000n, stdDev: 1n, publishTime: now() - 1n, ...o });
      return {
        key: k,
        owner: "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv" as Address,
        data,
        feed: feedOther ? new Uint8Array(32).fill(9) : keyBytes(k),
        kind: "switchboard",
        what: "sb",
      };
    };
    const cl = async (o: Partial<Parameters<typeof chainlinkData>[0]>, feedOther = false): Promise<OracleAccount> => {
      const k = await key();
      const data = chainlinkData({ answer: 300_000_000n, decimals: 8, timestamp: now() - 1n, ...o });
      return {
        key: k,
        owner: "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny" as Address,
        data,
        feed: feedOther ? new Uint8Array(32).fill(9) : keyBytes(k),
        kind: "chainlink",
        what: "cl",
      };
    };
    const I64_MAX = (1n << 63n) - 1n;
    const cases: [string, OracleAccount, string, Partial<HybridArgs>?][] = [
      ["pyth 133 bytes", await pyth({ len: 133 }), errB("InvalidAccountData")],
      ["pyth 0 bytes", await pyth({ len: 0 }), errB("InvalidAccountData")],
      ["pyth discriminator", await pyth({ badDiscriminator: true }), err(E.OracleInvalid)],
      ["pyth partial verification", await pyth({ level: 0 }), err(E.OracleInvalid)],
      ["pyth verification 2", await pyth({ level: 2 }), err(E.OracleInvalid)],
      ["pyth another feed", { ...(await pyth({})), feed: new Uint8Array(32).fill(8) }, err(E.InvalidOracleKey)],
      ["pyth price 0", await pyth({ price: 0n }), err(E.OracleInvalid)],
      ["pyth price -1", await pyth({ price: -1n }), err(E.OracleInvalid)],
      ["pyth exponent 19", await pyth({ expo: 19 }), err(E.OracleInvalid)],
      ["pyth exponent -19", await pyth({ expo: -19 }), err(E.OracleInvalid)],
      ["pyth one second too old", await pyth({ publishTime: now() - 61n }), err(E.OracleStale)],
      ["pyth one second ahead", await pyth({ publishTime: now() + 1n }), err(E.OracleStale)],
      ["pyth i64::MIN publish time", await pyth({ publishTime: -(1n << 63n) }), err(E.OracleStale)],
      ["pyth conf one past the filter", await pyth({ price: 1_000_000n, conf: 5_001n, expo: -6 }), err(E.OracleConfTooWide), { confBps: 50n }],
      ["pyth scaled past u128", await pyth({ price: I64_MAX, expo: 18 }), err(E.EngineArithmeticOverflow)],
      ["pyth above MAX_ORACLE_PRICE", await pyth({ price: 1_000_001n, expo: 0 }), err(E.OracleInvalid)],
      ["pyth exactly MAX_ORACLE_PRICE", await pyth({ price: 1_000_000n, expo: 0 }), "ok"],
      ["pyth scaled to 0", await pyth({ price: 1n, expo: -18 }), err(E.OracleInvalid)],
      ["pyth not owned by the receiver", await pyth({}, "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2" as Address), err(E.InvalidOracleKey)],
      ["pyth owned by Chainlink", await pyth({}, "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny" as Address), err(E.InvalidOracleKey)],
      ["pyth owned by another program", await pyth({}, "11111111111111111111111111111112" as Address), errB("IllegalOwner")],
      ["switchboard another key", await sw({}, true), err(E.InvalidOracleKey)],
      ["switchboard 3,207 bytes", await sw({ len: 3207 }), errB("InvalidAccountData")],
      ["switchboard discriminator", await sw({ badDiscriminator: true }), err(E.OracleInvalid)],
      ["switchboard submission 32", await sw({ submissionIdx: 32 }), err(E.OracleInvalid)],
      ["switchboard submission 31", await sw({ submissionIdx: 31 }), "ok"],
      ["switchboard zero feed hash", await sw({ feedHash: new Uint8Array(32) }), err(E.OracleInvalid)],
      ["switchboard min samples 0", await sw({ minSampleSize: 0 }), err(E.OracleInvalid)],
      ["switchboard fewer samples than the minimum", await sw({ minSampleSize: 4, numSamples: 3 }), err(E.OracleInvalid)],
      ["switchboard result slot 0", await sw({ resultSlot: 0n }), err(E.OracleInvalid)],
      ["switchboard account update time 0", await sw({ lastUpdate: 0n }), err(E.OracleInvalid)],
      ["switchboard value 0", await sw({ value: 0n }), err(E.OracleInvalid)],
      ["switchboard std dev -1", await sw({ stdDev: -1n }), err(E.OracleInvalid)],
      ["switchboard publish time 0", await sw({ publishTime: 0n, lastUpdate: now() }), err(E.OracleStale)],
      ["switchboard too old", await sw({ publishTime: now() - 61n }), err(E.OracleStale)],
      ["switchboard fresh account write, stale result", await sw({ publishTime: now() - 61n, lastUpdate: now() }), err(E.OracleStale)],
      ["switchboard std dev past the filter", await sw({ value: 10n ** 18n, stdDev: 10n ** 16n + 1n }), err(E.OracleConfTooWide), { confBps: 100n }],
      ["switchboard std dev at the filter", await sw({ value: 10n ** 18n, stdDev: 10n ** 16n }), "ok", { confBps: 100n }],
      ["switchboard below 10^-6", await sw({ value: 999_999_999_999n }), err(E.OracleInvalid)],
      ["chainlink another key", await cl({}, true), err(E.InvalidOracleKey)],
      ["chainlink 247 bytes", await cl({ len: 247 }), errB("InvalidAccountData")],
      ["chainlink discriminator", await cl({ badDiscriminator: true }), err(E.OracleInvalid)],
      ["chainlink version 0", await cl({ version: 0 }), err(E.OracleInvalid)],
      ["chainlink round 0", await cl({ latestRoundId: 0 }), err(E.OracleInvalid)],
      ["chainlink live length 2", await cl({ liveLength: 2 }), err(E.OracleInvalid)],
      ["chainlink slot 0", await cl({ slot: 0n }), err(E.OracleInvalid)],
      ["chainlink timestamp 0", await cl({ timestamp: 0n }), err(E.OracleInvalid)],
      ["chainlink too old", await cl({ timestamp: now() - 61n }), err(E.OracleStale)],
      ["chainlink answer 0", await cl({ answer: 0n }), err(E.OracleInvalid)],
      ["chainlink answer -5", await cl({ answer: -5n }), err(E.OracleInvalid)],
      ["chainlink 19 decimals", await cl({ decimals: 19 }), err(E.OracleInvalid)],
      ["chainlink 0 decimals past u128", await cl({ decimals: 0, answer: (1n << 127n) - 1n }), err(E.EngineArithmeticOverflow)],
      ["chainlink 0 decimals", await cl({ decimals: 0, answer: 5n }), "ok"],
    ];
    for (const [label, l, want, o] of cases) await d.fails(`reader: ${label}`, a, [hybrid(m, [l], o ?? {})], want);
    // Composites: publish times that differ (OracleStale), a partial quotient out of range, the unit scale to 0.
    const t = now() - 3n;
    await d.fails("legs at different publish times", a, [hybrid(m, [legAt(rng, "pyth", 5n, t), legAt(rng, "chainlink", 5n, t - 1n)])], err(E.OracleStale));
    await d.fails(
      "a partial product above MAX",
      a,
      [hybrid(m, [legAt(rng, "pyth", MAX_PRICE, t), legAt(rng, "chainlink", 2_000_000n, t), legAt(rng, "switchboard", 1n, t)], { flags: 2 })],
      err(E.OracleInvalid),
    );
    await d.fails(
      "a partial quotient of 0",
      a,
      [hybrid(m, [legAt(rng, "pyth", 1n, t), legAt(rng, "chainlink", MAX_PRICE, t)], { flags: 1 })],
      err(E.OracleInvalid),
    );
    await d.fails("the unit scale to 0", a, [hybrid(m, [legAt(rng, "pyth", 5n, t)], { unitScale: 6n })], err(E.OracleInvalid));
    await d.ok("inverted 1 is MAX", a, [hybrid(m, [legAt(rng, "pyth", 1n, t)], { invert: 1 })]);
    await d.fails("the first leg's error first", a, [hybrid(m, [await pyth({ price: 0n }), await cl({ answer: 0n })])], err(E.OracleInvalid));
    // A read that does not advance (a publish time of 0 or below, fresh because the Clock's unix time is small):
    // OracleInvalid after the reads.
    d.setClock(d.slot + 1n, 30n);
    await d.fails("pyth published at 0", a, [hybrid(m, [await pyth({ publishTime: 0n })])], err(E.OracleInvalid));
    await d.fails("pyth published at -5", a, [hybrid(m, [await pyth({ publishTime: -5n })])], err(E.OracleInvalid));
    await d.ok("pyth published at 1", a, [hybrid(m, [await pyth({ publishTime: 1n })])]);
    d.setClock(d.slot + 1n, SLOT_TS);
  });

  it(`a seeded fuzz of ${FUZZ} configurations: legs at their boundaries, composites, arguments, the Clock's unix time`, async () => {
    const m = await twoAssets();
    const a = m.admin;
    const r = new Rng(SEED + 34n);
    let ok = 0;
    const byLegs: Record<string, [number, number]> = {};
    for (let i = 0; i < FUZZ; i++) {
      if (r.chance(20)) d.setClock(d.slot + BigInt(r.int(50)), d.unixTimestamp + BigInt(r.int(120)));
      const count = r.chance(5) ? r.pick([0, 4]) : 1 + r.int(3);
      const maxStaleness = r.pick([60n, 60n, 1n, 3600n, (1n << 64n) - 1n]);
      const confBps = r.pick([0n, 0n, 1n, 100n, 10_000n]);
      const t = r.pick([now(), now() - 1n, now() - maxStaleness, now() - 30n]);
      const legs: OracleAccount[] = [];
      for (let k = 0; k < Math.max(1, Math.min(count, 3)); k++) {
        const kt = r.chance(5) ? t - 1n : t;
        legs.push(
          r.chance(60)
            ? legAt(r, r.pick(KINDS), r.chance(80) ? 100_000n + (r.next() % 3_000_000n) : 1n + (r.next() % MAX_PRICE), kt, { devnet: r.chance(10) })
            : randomLeg(r, now(), kt, maxStaleness, confBps, r.chance(70)),
        );
      }
      const validFlags = count === 1 ? [0] : count === 2 ? [0, 1] : [0, 1, 2, 3];
      const asset = r.int(2);
      const o: Partial<HybridArgs> = {
        asset,
        count,
        flags: r.chance(5) ? r.pick([2, 4, 0xff]) : r.pick(validFlags),
        invert: r.chance(3) ? 2 : r.int(2),
        unitScale: r.chance(75) ? r.pick([0n, 1n]) : r.pick([2n, 1000n, 0xffff_ffffn]),
        confBps: r.chance(3) ? 10_001n : confBps,
        maxStaleness: r.chance(2) ? 0n : maxStaleness,
        softStale: r.chance(2) ? 0n : r.pick([1n, 100n, (1n << 64n) - 1n]),
        halflife: r.chance(3) ? 0n : r.pick([1n, 600n, (1n << 64n) - 1n]),
        minFee: r.pick([0n, 5n, (1n << 64n) - 1n]),
        sequence: seqOf(m, asset) + (r.chance(95) ? 1n : 0n),
      };
      let accounts = legs.map((l) => l.key);
      if (r.chance(4)) accounts = accounts.slice(0, -1);
      if (r.chance(3)) accounts[r.int(accounts.length || 1)] = r.pick([m.market, a.address]);
      const label = `fuzz ${i}: ${legs.map((l) => l.what).join(" + ")} ${JSON.stringify(o, (_, v) => (typeof v === "bigint" ? String(v) : v))}`;
      const got = await d.send(label, a, [hybrid(m, legs, o, accounts)]);
      const kinds = legs.length === 1 ? legs[0]!.kind : `composite of ${legs.length}`;
      byLegs[kinds] ??= [0, 0];
      byLegs[kinds]![1]++;
      if (got === "ok") {
        ok++;
        byLegs[kinds]![0]++;
      }
    }
    console.log(`hybrid fuzz: ${FUZZ} configurations, ${ok} succeeded in both; by legs (successes/attempts):`, JSON.stringify(byLegs));
    expect(ok).toBeGreaterThan(FUZZ / 10);
  }, 600_000);
});

/** The unix time Diff starts with (percolator-v16-helpers.ts UNIX_TIMESTAMP). */
const SLOT_TS = 1_770_000_000n;
