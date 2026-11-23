// A random walk and a mutation fuzzer over the ported instructions of the Percolator v16 port, against the reference
// (Percolator v16 at commit 7b110913, engine 5e3af07, aeyakovenko/percolator-prog and aeyakovenko/percolator,
// Apache-2.0; test/programs/percolator_v16.so, the Rust build of those commits, not a deployed program). Every
// transaction is compared whole at every step (outcome, logs, inner instructions, return data, every named account's
// bytes; fewer compute units on success).
//
// - The walk: per seed, steps that each send one of the ported instructions, valid for the state the walk has reached,
//   or with its data or accounts corrupted, while the Clock moves; the state carries over from step to step.
//   PERCOLATOR_V16_WALK_STEPS (2,000) and PERCOLATOR_V16_WALK_SEEDS (3) size it. A keeper refreshes the external oracle
//   accounts at most steps (their prices moving, published at the Clock's unix time; now and then left to go stale),
//   and keeps the market live (asset 0's mark pushed, or its hybrid oracle configured again).
// - The mutation fuzzer (the v12.20 port's percolator-mutate.ts idea): from one snapshot of the world, a valid
//   transaction of a random instruction with one mutation, then the snapshot restored: its accounts (a position
//   replaced by another account of the world, repeated, its flags changed, the list cut or lengthened), its data
//   (bytes of the body changed, fields set to boundary values), or the state (a field of the market's wrapper config,
//   group header or slots, or of a portfolio, set to a boundary value before the transaction). PERCOLATOR_V16_MUTATIONS
//   (2,000) sizes it.
import { AccountRole, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { HAVE_PORT, HAVE_REFERENCE, PROGRAM, ix } from "./percolator-v16-helpers.js";
import { MARKET, PORTFOLIO, layout, offsetOf, sizeOf } from "./percolator-v16-layout.js";
import { NAMES, SEED, TAGS, World, withAccount } from "./percolator-v16-world.js";
import { apply, generate } from "./percolator-v16-states.js";

const STEPS = Number(process.env.PERCOLATOR_V16_WALK_STEPS ?? 2000);
const SEEDS = Number(process.env.PERCOLATOR_V16_WALK_SEEDS ?? 3);
const MUTATIONS = Number(process.env.PERCOLATOR_V16_MUTATIONS ?? 2000);

const BOUNDARY = [
  0n,
  1n,
  2n,
  0x7fn,
  0xffn,
  0x7fffn,
  0xffffn,
  10_000n,
  10_001n,
  0x7fff_ffffn,
  0xffff_ffffn,
  1n << 63n,
  (1n << 64n) - 1n,
  1n << 127n,
  (1n << 128n) - 1n,
];

function setUint(b: Buffer, at: number, size: number, v: bigint): void {
  for (let i = 0; i < size && at + i < b.length; i++) b[at + i] = Number((v >> BigInt(8 * i)) & 0xffn);
}

/** The instruction's data with a few bytes of its body changed, or one aligned field set to a boundary value. */
function mutateData(rng: Rng, i: Instruction): Instruction {
  const data = Buffer.from(i.data ?? new Uint8Array());
  if (data.length <= 1) return i;
  if (rng.chance(50)) {
    const k = 1 + rng.int(3);
    for (let n = 0; n < k; n++) data[1 + rng.int(data.length - 1)] = rng.int(256);
  } else {
    const size = [1, 2, 8, 16][rng.int(4)]!;
    const at = 1 + rng.int(Math.max(1, data.length - size));
    setUint(data, at, size, BOUNDARY[rng.int(BOUNDARY.length)]!);
  }
  return { ...i, data: new Uint8Array(data) };
}

/** One change to the accounts: a position replaced or repeated, a flag dropped, the list cut or one longer. */
function mutateAccounts(w: World, rng: Rng, i: Instruction): Instruction {
  const accounts = i.accounts ?? [];
  const n = accounts.length;
  const at = rng.int(n);
  const a = accounts[at]!;
  const writable = a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER;
  switch (rng.int(5)) {
    case 0: {
      const pool = w.pool().filter((p) => !(p === PROGRAM && writable));
      return withAccount(w, i, at, pool[rng.int(pool.length)]!, a.role);
    }
    case 1: {
      const from = accounts[rng.int(n)]!;
      if (from.address === PROGRAM && writable) return i;
      return withAccount(w, i, at, from.address, a.role);
    }
    case 2:
      return withAccount(
        w,
        i,
        at,
        a.address,
        writable ? AccountRole.READONLY : a.role === AccountRole.READONLY_SIGNER ? AccountRole.READONLY : AccountRole.WRITABLE,
      );
    case 3:
      return { ...i, accounts: accounts.slice(0, rng.int(n)) };
    default:
      return { ...i, accounts: [...accounts, { address: w.pool()[rng.int(w.accounts.length)]!, role: AccountRole.READONLY }] };
  }
}

/**
 * A field of one of the world's program accounts set to a boundary value (in both VMs): the market's wrapper config,
 * group header, oracle profiles, control sequences or engine slots; a portfolio's engine state or its tail words (the
 * matcher config's keys and control word, the id, the owner-state sequence, the matcher expiry); either ledger.
 * Returns its description.
 */
function mutateState(w: World, rng: Rng): string {
  const p = rng.int(7);
  const target = p < 3 ? w.m.market : p < 5 ? w.portfolios[rng.int(2)]! : p === 5 ? w.ledgers.backing : w.ledgers.insurance;
  if (!w.d.reference.getAccount(target).exists) return "none";
  let struct: string;
  let base: number;
  if (p === 3) [struct, base] = ["Portfolio", PORTFOLIO.state];
  else if (p === 4) {
    // The tail after the engine state: the matcher config (104 bytes), then the id, sequence and expiry words.
    const word = rng.int(4);
    if (word === 0) [struct, base] = ["PortfolioMatcherConfig", PORTFOLIO.matcherConfig];
    else {
      const at = [PORTFOLIO.id, PORTFOLIO.sequence, PORTFOLIO.expiry][word - 1]!;
      const v = rng.chance(50) ? BOUNDARY[rng.int(BOUNDARY.length)]! : w.d.data(target).readBigUInt64LE(at) + BigInt(rng.int(3)) - 1n;
      w.d.patch(target, (b) => setUint(b, at, 8, v));
      return `portfolio word @${at}=${v}`;
    }
  } else if (p === 5) [struct, base] = ["BackingDomainLedger", 16];
  else if (p === 6) [struct, base] = ["InsuranceLedger", 16];
  else if (p === 0) [struct, base] = ["WrapperConfig", MARKET.wrapper];
  else if (p === 1) [struct, base] = ["GroupHeader", MARKET.group];
  else {
    const slot = rng.int(3);
    const r = rng.int(10);
    [struct, base] =
      r < 3
        ? ["AssetOracleProfile", MARKET.slots + slot * MARKET.slotLen]
        : r < 4
          ? ["AssetControlSequences", MARKET.slots + slot * MARKET.slotLen + MARKET.controlSequences]
          : ["EngineAssetSlot", MARKET.slots + slot * MARKET.slotLen + 512];
  }
  // A leaf field: descend through nested structs.
  let rows = layout(struct);
  let row = rows[rng.int(rows.length)]!;
  let at = base + row.offset;
  for (let depth = 0; depth < 4; depth++) {
    let nested: ReturnType<typeof layout> | undefined;
    try {
      nested = layout(row.type);
    } catch {
      nested = undefined;
    }
    if (!nested || nested.length === 0) break;
    rows = nested;
    row = rows[rng.int(rows.length)]!;
    at += row.offset;
  }
  let size: number;
  try {
    size = Math.min(16, sizeOf(row.type));
  } catch {
    size = 8;
  }
  const v = BOUNDARY[rng.int(BOUNDARY.length)]!;
  w.d.patch(target, (b) => setUint(b, at, size, v));
  return `${struct}.${row.name}@${at}=${v}`;
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: random walk and mutations over the ported instructions", () => {
  for (let k = 0; k < SEEDS; k++) {
    const seed = SEED + BigInt(k) * 1009n;
    it(`random walk, seed ${seed}, ${STEPS} steps`, async () => {
      const w = await World.build(seed);
      const rng = new Rng(seed);
      const tally = {
        sent: 0,
        ok: 0,
        keeper: 0,
        keeperOk: 0,
        fresh: 0,
        byTag: new Map<number, [number, number]>(),
        byLegs: new Map<string, [number, number]>(),
      };
      for (let step = 0; step < STEPS; step++) {
        // The Clock moves in bounded steps (a long gap now and then); the keeper keeps the market live.
        if (rng.chance(30)) w.d.setClock(w.d.slot + BigInt(rng.chance(95) ? rng.int(30) : rng.int(5_000)));
        // A main market that can no longer make progress is replaced by a fresh one.
        if (w.stuck()) {
          await w.mainMarket();
          tally.fresh++;
        }
        if (rng.chance(80)) w.refreshOracles(rng);
        const kept = await w.keepLive(rng, `walk ${seed} step ${step}`);
        if (kept !== null) {
          tally.keeper++;
          if (kept === "ok") tally.keeperOk++;
        }
        const tag = TAGS[rng.int(TAGS.length)]!;
        // A closed portfolio's address made a fresh account again, for InitPortfolio to take.
        const { payer, ix: base } = await w.base(tag, rng);
        let tx = base;
        const roll = rng.int(100);
        if (roll < 20) tx = mutateData(rng, tx);
        else if (roll < 32) tx = mutateAccounts(w, rng, tx);
        const label = `walk ${seed} step ${step} ${NAMES[tag]}${tx === base ? "" : " (mutated)"}`;
        const got = await w.d.send(label, payer, [tx]);
        tally.sent++;
        const t = tally.byTag.get(tag) ?? [0, 0];
        t[0]++;
        if (got === "ok") {
          tally.ok++;
          t[1]++;
          await w.afterSuccess(tag, tx);
        }
        tally.byTag.set(tag, t);
        if (tag === 34) {
          const l = tally.byLegs.get(w.lastLegs) ?? [0, 0];
          l[0]++;
          if (got === "ok") l[1]++;
          tally.byLegs.set(w.lastLegs, l);
        }
      }
      const per = [...tally.byTag].map(([tag, [n, ok]]) => `${NAMES[tag]} ${ok}/${n}`).join(", ");
      const legs = [...tally.byLegs].map(([k, [n, ok]]) => `${k} ${ok}/${n}`).join(", ");
      console.log(
        `walk seed ${seed}: ${tally.sent} transactions compared, ${tally.ok} succeeded in both (${per}); ConfigureHybridOracle by legs: ${legs}; keeper ${tally.keeperOk}/${tally.keeper}, fresh markets ${tally.fresh}`,
      );
      // Every instruction succeeds in a healthy share of its attempts (a valid one most of the time).
      // CanonicalizeSpentBackingHistory needs spent-backing history, which no ported instruction makes: it is
      // refused (EngineNonProgress or EngineLockActive) in the walk; its successes are in percolator-v16-lifecycle.test.ts.
      for (const [tag, [n, ok]] of tally.byTag) if (n >= 20 && tag !== 70) expect(ok, `${NAMES[tag]} ${ok}/${n}`).toBeGreaterThan(n / 10);
    }, 1_800_000);
  }

  it(`mutation fuzzer, ${MUTATIONS} mutated transactions from one snapshot`, async () => {
    const w = await World.build(SEED + 77n);
    // Both ledgers created, so that their fields are live state for the mutations (the sweeps keep them uncreated).
    await w.d.ok("mutation world: backing ledger", w.m.admin, [ix.syncBackingLedger(w.m, w.m.admin, w.ledgers.backing, 0)]);
    await w.d.ok("mutation world: insurance ledger", w.m.admin, [ix.syncInsuranceLedger(w.m, w.m.admin, w.ledgers.insurance)]);
    const rng = new Rng(SEED + 77n);
    w.accounts.push(w.m.vault);
    w.take();
    const tally = { sent: 0, ok: 0, kinds: { accounts: 0, data: 0, state: 0, generated: 0 } };
    for (let n = 0; n < MUTATIONS; n++) {
      // A fifth of the mutations start from a generated state (percolator-v16-states.ts: legs, PnL, fee debt, money
      // totals, the fee rate, the domains' ledgers, claims and liens), mostly with the instructions that read a
      // portfolio's value.
      const kind = rng.int(5) === 4 ? 3 : rng.int(3);
      const tag = kind === 3 && rng.chance(70) ? rng.pick([3, 4, 8, 48]) : TAGS[rng.int(TAGS.length)]!;
      let what = "";
      if (kind === 2) what = mutateState(w, rng);
      if (kind === 3) {
        // Six in ten with open legs the fee settles; now and then a field of the generated state mutated too.
        apply(w, generate(w, rng, rng.chance(60)).patch);
        if (rng.chance(30)) what = mutateState(w, rng);
      }
      const { payer, ix: base } = await w.base(tag, rng);
      const tx = kind === 0 ? mutateAccounts(w, rng, base) : kind === 1 ? mutateData(rng, base) : base;
      const label = `mutation ${n} ${NAMES[tag]} ${["accounts", "data", "state " + what, "generated state " + what][kind]}`;
      const got = await w.d.send(label, payer, [tx]);
      tally.sent++;
      tally.kinds[(["accounts", "data", "state", "generated"] as const)[kind]]++;
      if (got === "ok") tally.ok++;
      w.restore();
    }
    console.log(
      `mutations: ${tally.sent} transactions compared (${tally.kinds.accounts} accounts, ${tally.kinds.data} data, ${tally.kinds.state} state, ${tally.kinds.generated} from generated states), ${tally.ok} succeeded in both`,
    );
    expect(tally.sent).toBe(MUTATIONS);
  }, 1_800_000);
});

export { ix, offsetOf };
