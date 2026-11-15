// showcase/mainnet/percolator against Percolator v12.20 as deployed on mainnet (test/programs/percolator_v12.so): the
// slab-state mutation fuzzer. A field of the slab is written into both slabs the same way (`Diff.patch`), then an
// instruction runs, compared as `both()` compares; then the slab is put back. These are states no instruction makes
// (a corrupt slab): the original's behaviour on them is still its behaviour, and the port must match it.
//
// The fields: every field of the header (magic, version, bump, the flags byte and its padding, admin, the request
// nonce, the materialization counter, the insurance authorities), of the config, of the engine (balances, the
// parameters, slots, the market mode, the resolved figures, the A / K / F indices and epochs, open interest, the side
// modes and counts, the dust bounds, the oracle price) and of the account entries (used and free slots: capital,
// kind, PnL, reserves, position basis, the A / K / F snapshots, the epoch, the matcher binding, owner, fee credits,
// the warm-up buckets); the free list (its head, links of used and free slots, the used count), the used bitmap
// (a used slot's bit cleared, a free slot's set), the risk buffer and the generation table. Each is set to boundary
// values of its width (0, 1, 2, max, max - 1, the sign boundaries, its own value ± 1, limits the program checks) or
// to random bytes.
//
// Two passes: every field at every boundary value with one instruction drawn for it, in three states (open
// positions, resolved, Hyperp); and random fields under each of the 27 instructions in every state. Differences
// that are pinned and documented (pinnedFreelist in percolator-mutate.ts) are counted apart; their account bytes are
// still compared. PERCOLATOR_MUTATE_SCALE=<n> multiplies both passes' sizes by n (the first: more instructions per
// value and more states).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { A, ACCOUNT_LEN, C, CONFIG_LEN, E, GEN_TABLE_OFF, H, HAVE_ORIGINAL, HEADER_LEN, P, RISK_BUF_OFF, accountAt } from "./percolator-helpers.js";
import { type Base, SCALE, SEED, type State, Tally, World, bases, trial } from "./percolator-mutate.js";

/** A patchable field: its absolute offset in the slab and width in bytes. */
interface Field {
  name: string;
  at: number;
  size: number;
  signed?: boolean;
}

/** Fields from an offset table: each one's width is the distance to the next, cut to 1 / 2 / 4 / 8 / 16 / 32. */
function table(prefix: string, t: Record<string, number>, end: number, signed: string[] = []): Field[] {
  const entries = Object.entries(t).sort(([, a], [, b]) => a - b);
  return entries.map(([name, at], i) => {
    const gap = (entries[i + 1]?.[1] ?? end) - at;
    const size = [32, 16, 8, 4, 2, 1].find((s) => s <= gap)!;
    return { name: `${prefix}.${name}`, at, size, signed: signed.includes(name) };
  });
}

const SIGNED_ENGINE = [
  "adlCoeffLong",
  "adlCoeffShort",
  "adlEpochStartKLong",
  "adlEpochStartKShort",
  "fLongNum",
  "fShortNum",
  "fEpochStartLongNum",
  "fEpochStartShortNum",
  "resolvedKLongTerminalDelta",
  "resolvedKShortTerminalDelta",
];
const SIGNED_ACCOUNT = ["pnl", "positionBasisQ", "adlKSnap", "fSnap", "feeCredits"];

function fields(s: State): Field[] {
  const header = table("header", H, HEADER_LEN);
  // The flags byte's padding (14, 15) and the reserved tail of the header.
  header.push({ name: "header.padding1", at: 14, size: 1 }, { name: "header.padding2", at: 15, size: 1 }, { name: "header.reserved", at: 64, size: 8 });
  const config = table("config", C, HEADER_LEN + CONFIG_LEN, ["fundingMaxPremiumBps", "fundingMaxE9PerSlot"]);
  const engineTop = Object.fromEntries(Object.entries(E).filter(([k]) => !["nextFree", "prevFree", "accounts"].includes(k)));
  const engine = table("engine", engineTop, E.nextFree, SIGNED_ENGINE).filter((f) => f.name !== "engine.params" && f.name !== "engine.used");
  const params = table("params", Object.fromEntries(Object.entries(P).map(([k, v]) => [k, E.params + v])), E.currentSlot);
  const out = [...header, ...config, ...engine, ...params];
  // The account entries of the used slots and of one free slot.
  const free = 7;
  for (const [who, idx] of [...Object.entries(s.idx), ["free", free] as [string, number]]) {
    out.push(
      ...table(
        `accounts[${idx}:${who}]`,
        Object.fromEntries(Object.entries(A).map(([k, v]) => [k, accountAt(idx) + v])),
        accountAt(idx) + ACCOUNT_LEN,
        SIGNED_ACCOUNT,
      ),
    );
    out.push({ name: `nextFree[${idx}]`, at: E.nextFree + 2 * idx, size: 2 }, { name: `prevFree[${idx}]`, at: E.prevFree + 2 * idx, size: 2 });
    out.push({ name: `generation[${idx}]`, at: GEN_TABLE_OFF + 8 * idx, size: 8 });
    out.push({ name: `used word of ${idx}`, at: E.used + 8 * (idx >> 6), size: 8 });
  }
  // The risk buffer: cursor, count, min notional, each entry's index and notional.
  out.push(
    { name: "riskBuffer.scanCursor", at: RISK_BUF_OFF, size: 2 },
    { name: "riskBuffer.count", at: RISK_BUF_OFF + 2, size: 1 },
    { name: "riskBuffer.pad", at: RISK_BUF_OFF + 3, size: 1 },
  );
  out.push({ name: "riskBuffer.minNotional", at: RISK_BUF_OFF + 16, size: 16 });
  for (let i = 0; i < 4; i++)
    out.push(
      { name: `riskBuffer.entries[${i}].idx`, at: RISK_BUF_OFF + 32 + 32 * i, size: 2 },
      { name: `riskBuffer.entries[${i}].notional`, at: RISK_BUF_OFF + 48 + 32 * i, size: 16 },
    );
  // The last free slot's links (the end of the free list).
  out.push({ name: "nextFree[4095]", at: E.nextFree + 2 * 4095, size: 2 }, { name: "prevFree[4095]", at: E.prevFree + 2 * 4095, size: 2 });
  return out;
}

const LIMITS = [
  3n,
  4n,
  64n,
  255n,
  4095n,
  4096n,
  4097n,
  10_000n,
  65_535n,
  10n ** 6n,
  10n ** 12n,
  10n ** 12n + 1n,
  10n ** 14n,
  10n ** 14n + 1n,
  10n ** 15n,
  10n ** 16n,
  10n ** 16n + 1n,
  10n ** 20n,
  10n ** 32n,
  10n ** 38n,
];

function readLe(b: Buffer, at: number, size: number): bigint {
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i]!);
  return v;
}
function writeLe(b: Buffer, at: number, size: number, v: bigint): void {
  let x = BigInt.asUintN(size * 8, v);
  for (let i = 0; i < size; i++) {
    b[at + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

/** A field's boundary values (as unsigned bit patterns of its width). */
function values(f: Field, current: bigint): bigint[] {
  if (f.size === 32) return [0n, (1n << 256n) - 1n, current ^ 1n];
  const bits = BigInt(f.size * 8);
  const max = (1n << bits) - 1n;
  const half = 1n << (bits - 1n);
  const vs = new Set<bigint>([0n, 1n, 2n, max, max - 1n, half - 1n, half, current + 1n, current - 1n]);
  if (f.signed) for (const v of [-1n, -half + 1n, -current]) vs.add(v);
  for (const l of LIMITS) if (l <= max) vs.add(l);
  const cur = BigInt.asUintN(Number(bits), current);
  return [...vs].map((v) => BigInt.asUintN(Number(bits), v)).filter((v, i, a) => a.indexOf(v) === i && v !== cur);
}

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: slab-state mutations", () => {
  let w: World;
  const t = new Tally();
  beforeAll(async () => {
    w = await World.create(SEED ^ 0x51abn);
    await w.build();
  }, 600_000);
  afterAll(() => t.print("slab-state mutations"));

  /** Patch `f` to `v` in both slabs, send the base, put the slab back. */
  async function run(s: State, b: Base, f: Field, v: bigint | Buffer, category: string): Promise<void> {
    w.d.patch(s.m.slab, (data) => (Buffer.isBuffer(v) ? v.copy(data, f.at) : writeLe(data, f.at, f.size, v)));
    const shown = Buffer.isBuffer(v) ? `0x${v.toString("hex")}` : f.signed ? `${BigInt.asIntN(f.size * 8, v)}` : `${v}`;
    await trial(w, t, category, b.name, `${s.name}: ${f.name} = ${shown}: ${b.name}`, b.ixs);
    // trial put back the accounts the transaction names; the slab is among them unless a mutation dropped it.
    w.restore([s.m.slab]);
  }

  it("every field at its boundary values", async () => {
    const chosen = SCALE >= 4 ? w.states : w.states.filter((s) => ["positions", "resolved", "hyperp"].includes(s.name));
    const perValue = Math.max(1, Math.round(Math.min(SCALE, 9)));
    for (const s of chosen) {
      const all = bases(s).filter((b) => b.tag !== 0);
      const slab = w.d.data(s.m.slab);
      for (const f of fields(s)) {
        const current = f.size === 32 ? readLe(slab, f.at, 32) : readLe(slab, f.at, f.size);
        for (const v of values(f, f.signed ? BigInt.asIntN(f.size * 8, current) : current))
          for (let k = 0; k < perValue; k++) await run(s, w.rng.pick(all), f, v, "fields");
      }
    }
    expect(t.divergences, t.divergences.slice(0, 20).join("\n\n")).toEqual([]);
  }, 7_200_000);

  it("random fields and bytes under every instruction in every state", async () => {
    const t0 = t.divergences.length;
    const per = Math.max(1, Math.round(12 * SCALE));
    for (const s of w.states) {
      const fs = fields(s);
      for (const b of bases(s)) {
        if (b.tag === 0) continue;
        for (let k = 0; k < per; k++) {
          const f = w.rng.pick(fs);
          const slab = w.d.data(s.m.slab);
          if (w.rng.chance(25)) {
            await run(s, b, f, Buffer.from(w.rng.bytes(f.size)), "random");
          } else {
            const current = readLe(slab, f.at, f.size);
            await run(s, b, f, w.rng.pick(values(f, f.signed ? BigInt.asIntN(f.size * 8, current) : current)), "random");
          }
        }
      }
    }
    expect(t.divergences.slice(t0), t.divergences.slice(t0, t0 + 20).join("\n\n")).toEqual([]);
  }, 7_200_000);

  it("the free list and the used bitmap made inconsistent", async () => {
    const t0 = t.divergences.length;
    for (const s of w.states.filter((x) => !x.name.startsWith("resolved-"))) {
      const all = bases(s).filter((b) => b.tag !== 0);
      const head = w.d.data(s.m.slab).readUInt16LE(E.freeHead);
      const cases: [string, (d: Buffer) => void][] = [
        ["the free head pointing at a used slot", (d) => d.writeUInt16LE(s.idx.alice, E.freeHead)],
        ["the free head's bit set", (d) => (d[E.used + (head >> 3)] = d[E.used + (head >> 3)]! | (1 << (head & 7)))],
        ["a used slot's bit cleared", (d) => (d[E.used + (s.idx.bob >> 3)] = d[E.used + (s.idx.bob >> 3)]! & ~(1 << (s.idx.bob & 7)))],
        ["the free head's next link to itself", (d) => d.writeUInt16LE(head, E.nextFree + 2 * head)],
        ["the free head's next link to a used slot", (d) => d.writeUInt16LE(s.idx.alice, E.nextFree + 2 * head)],
        ["the free head's next link past the slots", (d) => d.writeUInt16LE(4096, E.nextFree + 2 * head)],
        ["the free head's next link at u16::MAX - 1", (d) => d.writeUInt16LE(65_534, E.nextFree + 2 * head)],
        ["no free slot (head u16::MAX)", (d) => d.writeUInt16LE(65_535, E.freeHead)],
        ["the used count 0", (d) => d.writeUInt16LE(0, E.numUsedAccounts)],
        ["the used count 4,096", (d) => d.writeUInt16LE(4096, E.numUsedAccounts)],
        ["the used count u16::MAX", (d) => d.writeUInt16LE(65_535, E.numUsedAccounts)],
        ["a used slot's prev link past the slots", (d) => d.writeUInt16LE(5000, E.prevFree + 2 * s.idx.alice)],
        ["every bit of the used bitmap set", (d) => d.fill(0xff, E.used, E.used + 512)],
        ["the used bitmap cleared", (d) => d.fill(0, E.used, E.used + 512)],
        ["the free head past the slots", (d) => d.writeUInt16LE(4096, E.freeHead)],
        ["the materialized count 0", (d) => d.writeBigUInt64LE(0n, E.materializedAccountCount)],
        ["the materialized count u64::MAX", (d) => d.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, E.materializedAccountCount)],
        ["the stored long count 0", (d) => d.writeBigUInt64LE(0n, E.storedPosCountLong)],
        ["the stale short count u64::MAX", (d) => d.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, E.staleAccountCountShort)],
        [
          "the risk buffer naming a free slot",
          (d) => {
            d[RISK_BUF_OFF + 2] = 1;
            d.writeUInt16LE(head, RISK_BUF_OFF + 32);
            d.writeBigUInt64LE(1000n, RISK_BUF_OFF + 48);
          },
        ],
        [
          "the risk buffer naming one slot twice",
          (d) => {
            d[RISK_BUF_OFF + 2] = 2;
            d.writeUInt16LE(s.idx.alice, RISK_BUF_OFF + 32);
            d.writeUInt16LE(s.idx.alice, RISK_BUF_OFF + 64);
          },
        ],
      ];
      for (const [what, edit] of cases)
        for (const b of all) {
          w.d.patch(s.m.slab, edit);
          await trial(w, t, "freelist", b.name, `${s.name}: ${what}: ${b.name}`, b.ixs);
          w.restore([s.m.slab]);
        }
    }
    expect(t.divergences.slice(t0), t.divergences.slice(t0, t0 + 20).join("\n\n")).toEqual([]);
  }, 7_200_000);
});
