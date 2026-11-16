// showcase/mainnet/percolator against Percolator v12.20 as deployed on mainnet (test/programs/percolator_v12.so): the
// environment fuzzer. The valid transactions of percolator-mutate.ts, in every market state, sent:
//
// - several to a transaction: two or three Percolator instructions of one market, of two markets, the same one twice
//   (orderings that succeed and ones that fail part-way);
// - through a relay (fixtures/percolator-relay.ts), at stack height 2, once or twice in one instruction (TradeCpi's
//   matcher then runs at height 3; its reentrancy flag is set and cleared inside the relayed call);
// - under a compute-unit limit below what the original needs (both must fail and change nothing, except where the
//   original runs out and the port, needing fewer units, finishes: counted apart and listed);
// - at Clocks of slot 0, u64::MAX, 2^63, before the market's slots, a timestamp of 0, -1, i64::MIN and i64::MAX, and
//   with the Clock moved backwards between two transactions;
// - with the oracle at extremes: Pyth price 0, negative, 1, i64::MAX; exponents from i32::MIN to i32::MAX; confidence
//   0, at and past the market's limit, u64::MAX; publish times in the future, at 0, i64::MIN and i64::MAX, just stale;
//   another feed id; every verification tag; the account truncated or long; Chainlink decimals 0 to 255, answers 0,
//   negative and huge, timestamps at the extremes, the account truncated.
//
// (Sysvar accounts substituted for the Clock and Rent are in the account-list fuzzer, percolator-mutate-accounts.)
// Every transaction is compared as `both()` compares; every account is put back afterwards.
// PERCOLATOR_MUTATE_SCALE=<n> multiplies the random parts by n.
import { type Address, type Instruction, AccountRole, address } from "@solana/kit";
import { Clock } from "litesvm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAINLINK, HAVE_ORIGINAL, meta, PROGRAM, PYTH_RECEIVER, computeUnits, fixtureBinary, pythBytes, writeU128 } from "./percolator-helpers.js";
import { type Base, SCALE, SEED, Tally, World, bases, trial } from "./percolator-mutate.js";

const RELAY = address("8ZkPArZsFAcB4gVSPNv8TxYyJPLMAFb8Bi44DVxQRe1y");
const RELAY_SRC = new URL("./fixtures/percolator-relay.ts", import.meta.url).pathname;

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: the environment", () => {
  let w: World;
  const t = new Tally();
  beforeAll(async () => {
    w = await World.create(SEED ^ 0xe7an);
    for (const vm of w.d.vms) vm.addProgram(RELAY, fixtureBinary(RELAY_SRC, RELAY));
    await w.build();
  }, 600_000);
  afterAll(() => {
    t.print("environment");
    if (t.exceptions.length > 0)
      console.log(`the original out of units, the port finishing (${t.exceptions.length}):\n${t.exceptions.slice(0, 20).join("\n")}`);
  });

  const percolatorOf = (b: Base) => b.ixs[b.at]!;
  const done = (t0: number) => expect(t.divergences.slice(t0), t.divergences.slice(t0, t0 + 20).join("\n\n")).toEqual([]);

  it("several instructions in one transaction", async () => {
    const t0 = t.divergences.length;
    const per = Math.max(1, Math.round(60 * SCALE));
    for (const s of w.states) {
      const all = bases(s);
      for (let k = 0; k < per; k++) {
        const n = 2 + w.rng.int(2);
        const picks: Base[] = [];
        const what: string[] = [];
        for (let i = 0; i < n; i++) {
          // Mostly this market; sometimes another state's market; sometimes the same instruction again.
          const from = w.rng.chance(20) ? w.rng.pick(w.states) : s;
          const b = i > 0 && w.rng.chance(20) ? picks[i - 1]! : w.rng.pick(bases(from));
          picks.push(b);
          what.push(`${from === s ? "" : `${from.name}:`}${b.name}`);
        }
        await trial(w, t, "several", what.join(" + "), `${s.name}: ${what.join(" + ")}`, [computeUnits(1_400_000), ...picks.map(percolatorOf)]);
      }
      // Orderings chosen to succeed: the end of a market in one transaction.
      if (s.name === "resolved-empty") {
        const by = (tag: number) => percolatorOf(all.find((b) => b.tag === tag)!);
        await trial(w, t, "several", "WithdrawInsurance + CloseSlab", `${s.name}: WithdrawInsurance + CloseSlab`, [by(20), by(13)]);
        await trial(w, t, "several", "WithdrawInsurance + CloseSlab + CloseSlab", `${s.name}: WithdrawInsurance + CloseSlab twice`, [by(20), by(13), by(13)]);
      }
      if (s.name === "positions") {
        const by = (tag: number) => percolatorOf(all.find((b) => b.tag === tag)!);
        await trial(w, t, "several", "Deposit + TradeNoCpi + TradeCpi + Settle + Withdraw", `${s.name}: a session`, [
          computeUnits(1_400_000),
          by(3),
          by(6),
          by(10),
          by(26),
          by(4),
        ]);
        await trial(w, t, "several", "TradeCpi x3", `${s.name}: TradeCpi three times`, [computeUnits(1_400_000), by(10), by(10), by(10)]);
        await trial(w, t, "several", "Crank + Resolve + ForceClose", `${s.name}: crank, resolve, close`, [computeUnits(1_400_000), by(5), by(19), by(8)]);
      }
    }
    done(t0);
  }, 3_600_000);

  it("through a relay (stack height 2), once and twice", async () => {
    const t0 = t.divergences.length;
    for (const s of w.states)
      for (const b of bases(s)) {
        const p = percolatorOf(b);
        for (const times of [1, 2]) {
          const relayed: Instruction = {
            programAddress: RELAY,
            accounts: [{ address: PROGRAM, role: AccountRole.READONLY }, ...(p.accounts ?? [])] as Instruction["accounts"],
            data: new Uint8Array([times, ...p.data!]),
          };
          await trial(w, t, "relay", b.name, `${s.name}: ${b.name} relayed ${times === 1 ? "once" : "twice"}`, [computeUnits(1_400_000), relayed]);
        }
      }
    done(t0);
  }, 3_600_000);

  it("compute-unit limits below the original's", async () => {
    const t0 = t.divergences.length;
    for (const s of w.states)
      for (const b of bases(s)) {
        const p = percolatorOf(b);
        // What the original takes, then limits around and below it.
        const r = await trial(w, t, "budget", b.name, `${s.name}: ${b.name} (measured)`, [computeUnits(1_400_000), p]);
        if (r === null) continue;
        const used = Number(meta(w.d.last!).computeUnitsConsumed());
        for (const f of [0.02, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 1.0, 1.01])
          await trial(
            w,
            t,
            "budget",
            b.name,
            `${s.name}: ${b.name} under ${Math.max(1, Math.floor(used * f))} units`,
            [computeUnits(Math.max(1, Math.floor(used * f))), p],
            {
              budget: true,
            },
          );
      }
    done(t0);
  }, 3_600_000);

  it("the Clock at its extremes and moved backwards", async () => {
    const t0 = t.divergences.length;
    const U64 = (1n << 64n) - 1n;
    const I64_MAX = (1n << 63n) - 1n;
    const clocks: [string, bigint, bigint][] = [
      ["slot 0", 0n, w.unixTimestamp],
      ["slot 1", 1n, w.unixTimestamp],
      ["slot before the market's", w.slot - 200n, w.unixTimestamp],
      ["slot - 1", w.slot - 1n, w.unixTimestamp],
      ["slot u64::MAX", U64, w.unixTimestamp],
      ["slot u64::MAX - 1", U64 - 1n, w.unixTimestamp],
      ["slot 2^63", 1n << 63n, w.unixTimestamp],
      ["slot + max_accrual_dt", w.slot + 10_000_000n, w.unixTimestamp],
      ["timestamp 0", w.slot, 0n],
      ["timestamp -1", w.slot, -1n],
      ["timestamp i64::MIN", w.slot, -(1n << 63n)],
      ["timestamp i64::MAX", w.slot, I64_MAX],
      ["timestamp one hour back", w.slot, w.unixTimestamp - 3601n],
      ["timestamp one hour on", w.slot + 1n, w.unixTimestamp + 3601n],
    ];
    for (const s of w.states)
      for (const b of bases(s))
        for (const [what, slot, ts] of clocks) {
          // Set as it is (Diff.setClock derives the epoch's start from the timestamp, which overflows at i64::MIN).
          for (const vm of w.d.vms) vm.setClock(new Clock(slot, ts, 700n, 701n, ts));
          w.d.slot = slot;
          w.d.unixTimestamp = ts;
          await trial(w, t, "clock", b.name, `${s.name}: ${b.name} at ${what}`, b.ixs);
        }
    // Backwards between two transactions: a random instruction at the world's slot + 40, then another 30 slots
    // earlier (and the oracle published at the later time).
    const per = Math.max(1, Math.round(30 * SCALE));
    for (const s of w.states) {
      const all = bases(s);
      for (let k = 0; k < per; k++) {
        const [x, y] = [w.rng.pick(all), w.rng.pick(all)];
        const named = new Set<Address>();
        for (const b of [x, y]) for (const i of b.ixs) for (const m of i.accounts ?? []) named.add(m.address);
        w.d.setClock(w.slot + 40n, w.unixTimestamp + 20n);
        await trial(w, t, "clock", `${x.name} then ${y.name}`, `${s.name}: ${x.name} at +40`, x.ixs, { restore: false });
        w.d.setClock(w.slot + 10n, w.unixTimestamp + 5n);
        await trial(w, t, "clock", `${x.name} then ${y.name}`, `${s.name}: then ${y.name} at +10 (backwards)`, y.ixs, { restore: false });
        w.restore(named);
      }
    }
    done(t0);
  }, 3_600_000);

  it("the oracle at its extremes", async () => {
    const t0 = t.divergences.length;
    const ts = () => w.unixTimestamp;
    const I64_MAX = (1n << 63n) - 1n;
    const I64_MIN = -(1n << 63n);
    type Pyth = { price?: bigint; expo?: number; conf?: bigint; publishTime?: bigint; verification?: number; len?: number; feed?: Buffer };
    const pyth: [string, Pyth][] = [
      ["price 0", { price: 0n }],
      ["price -1", { price: -1n }],
      ["price i64::MIN", { price: I64_MIN }],
      ["price 1", { price: 1n }],
      ["price i64::MAX", { price: I64_MAX }],
      ["price 10^12 e6", { price: 10n ** 12n * 10n ** 6n }],
      ["price 10^12 e6 + 1", { price: 10n ** 12n * 10n ** 6n + 1n }],
      ...[-2147483648, -100, -38, -20, -19, -18, -13, -12, -7, -1, 0, 1, 2, 6, 12, 18, 19, 38, 2147483647].map((e): [string, Pyth] => [
        `expo ${e}`,
        { expo: e },
      ]),
      ...[-12, -6, 0, 6].map((e): [string, Pyth] => [`expo ${e}, price i64::MAX`, { expo: e, price: I64_MAX }]),
      ["expo 18, price 3.4 · 10^14", { expo: 18, price: 340_000_000_000_000n }],
      ["expo 18, price 2", { expo: 18, price: 2n }],
      ["conf 0", { conf: 0n }],
      ["conf at 5%", { conf: 5_000_000n }],
      ["conf past 5%", { conf: 5_000_001n }],
      ["conf u64::MAX", { conf: (1n << 64n) - 1n }],
      ["published in a second", { publishTime: 1n }],
      ["published in an hour", { publishTime: 3600n }],
      ["published at i64::MAX", { publishTime: I64_MAX - ts() }],
      ["published at 0", { publishTime: -ts() }],
      ["published at i64::MIN", { publishTime: I64_MIN - ts() }],
      ["published 3,600 s ago", { publishTime: -3600n }],
      ["published 3,601 s ago", { publishTime: -3601n }],
      ["another feed", { feed: Buffer.alloc(32, 0xcd) }],
      ...[0, 2, 3, 255].map((v): [string, Pyth] => [`verification ${v}`, { verification: v }]),
      ...[0, 40, 41, 73, 89, 93, 100, 101, 133].map((n): [string, Pyth] => [`${n} bytes`, { len: n }]),
      ["200 bytes", { len: 200 }],
    ];
    const chain: [string, { decimals?: number; answer?: bigint; when?: bigint; at?: bigint; len?: number }][] = [
      ...[0, 1, 6, 8, 18, 19, 20, 38, 39, 40, 255].map((n): [string, { decimals: number }] => [`decimals ${n}`, { decimals: n }]),
      ["answer 0", { answer: 0n }],
      ["answer -1", { answer: (1n << 128n) - 1n }],
      ["answer i128::MAX", { answer: (1n << 127n) - 1n }],
      ["answer u64::MAX", { answer: (1n << 64n) - 1n }],
      ["answer 10^20, decimals 0", { answer: 10n ** 20n, decimals: 0 }],
      ["answer 10^30, decimals 0", { answer: 10n ** 30n, decimals: 0 }],
      ["answer i128::MAX, decimals 0 (· 10^6 past u128)", { answer: (1n << 127n) - 1n, decimals: 0 }],
      ["answer 10^33, decimals 0 (· 10^6 within u128, past u64)", { answer: 10n ** 33n, decimals: 0 }],
      ["answer 1, decimals 18", { answer: 1n, decimals: 18 }],
      ["timestamp 0", { at: 0n }],
      ["timestamp in an hour", { when: 3600n }],
      ["timestamp above i64::MAX", { at: 1n << 63n }],
      ["timestamp u64::MAX", { at: (1n << 64n) - 1n }],
      ["timestamp 3,601 s ago", { when: -3601n }],
      ...[0, 138, 139, 208, 216, 231].map((n): [string, { len: number }] => [`${n} bytes`, { len: n }]),
      ["300 bytes", { len: 300 }],
    ];
    for (const s of w.states) {
      if (s.kind === "hyperp") continue;
      const all = bases(s);
      const write = (oracle: Address, _feedId: Buffer, data: Buffer, owner: Address) => w.d.write(oracle, owner, data);
      if (s.kind === "chainlink")
        for (const [what, c] of chain) {
          const data = Buffer.alloc(232);
          data[138] = c.decimals ?? 8;
          data.writeBigUInt64LE(BigInt.asUintN(64, c.at ?? ts() + (c.when ?? 0n)), 208);
          writeU128(data, 216, c.answer ?? s.price * 100n);
          const bytes = c.len !== undefined ? Buffer.concat([data, Buffer.alloc(Math.max(0, c.len - 232))]).subarray(0, c.len) : data;
          for (const b of all) {
            write(s.m.oracle, s.m.feedId, bytes, CHAINLINK);
            write(s.spare.oracle, s.spare.feedId, bytes, CHAINLINK);
            await trial(w, t, "oracle", b.name, `${s.name}: ${b.name}: Chainlink ${what}`, b.ixs);
            w.restore([s.m.oracle, s.spare.oracle]);
          }
        }
      else
        for (const [what, p] of pyth) {
          const expo = p.expo ?? -6;
          const raw = p.price ?? (expo <= -6 ? s.price * 10n ** BigInt(Math.min(-6 - expo, 30)) : s.price / 10n ** BigInt(Math.min(expo + 6, 30)));
          const mk = (feed: Buffer) => {
            const b = pythBytes({
              feedId: p.feed ?? feed,
              price: BigInt.asIntN(64, raw),
              expo,
              conf: p.conf ?? 0n,
              publishTime: ts() + (p.publishTime ?? 0n),
              verification: p.verification,
            });
            return p.len !== undefined ? Buffer.concat([b, Buffer.alloc(Math.max(0, p.len - b.length))]).subarray(0, p.len) : b;
          };
          for (const b of all) {
            write(s.m.oracle, s.m.feedId, mk(s.m.feedId), PYTH_RECEIVER);
            write(s.spare.oracle, s.spare.feedId, mk(s.spare.feedId), PYTH_RECEIVER);
            await trial(w, t, "oracle", b.name, `${s.name}: ${b.name}: Pyth ${what}`, b.ixs);
            w.restore([s.m.oracle, s.spare.oracle]);
          }
        }
    }
    done(t0);
  }, 3_600_000);
});
