// showcase/mainnet/percolator against Percolator v12.20 as deployed on mainnet (test/programs/percolator_v12.so): the
// instruction-data mutation fuzzer. For each of the 27 instructions, its valid transaction in each market state of
// percolator-mutate.ts (InitMarket once per oracle kind) is sent with its data mutated:
//
// - truncated at every length from 0 to one short of the whole, and with 1 to 9 bytes appended;
// - each field set to boundary values: 0, 1, 2, the type's maximum and one below it, the sign boundaries of its width
//   (2^(n-1) - 1, 2^(n-1); for a signed field -1, MIN, MIN + 1), the field's own value and one either side of it, and
//   values on either side of the limits the program checks (account indexes 4,095 / 4,096 / 65,535, basis points
//   10,000 / 10,001, prices 10^12, TVL 10^16, position sizes 10^14, A's 10^15, funding 10^4 per slot, …), a key
//   field to zero, all ones, and the keys of the world;
// - one to three random bytes changed (the tag included now and then);
// - every tag from 0 to 255 (the gaps between the 27 included) with no payload and with this instruction's payload;
// - KeeperCrank: random candidate lists (0 to 130 candidates, valid and free slots, 4,095 to 65,535, every policy byte,
//   partial sizes at their bounds) and every format byte.
//
// Every mutated transaction goes to both programs and is compared as `both()` compares; every account is put back
// afterwards. PERCOLATOR_MUTATE_SCALE=<n> multiplies the random parts (flips, crank lists) by n and, from 4, sends
// every tag in every state; PERCOLATOR_MUTATE_SEED another seed, PERCOLATOR_MUTATE_VERBOSE=1 the tally by instruction.
import { type Instruction, getAddressEncoder } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { HAVE_ORIGINAL, u128 as le128 } from "./percolator-helpers.js";
import { type Base, NAMES, SCALE, SEED, type State, Tally, World, bases, swapIx, trial } from "./percolator-mutate.js";

type Field = [name: string, size: number, signed?: boolean];

/** Each instruction's fields after the tag, in order (src/percolator.rs `Instruction::decode`). */
const LAYOUT: Record<number, Field[]> = {
  0: [
    ["admin", 32],
    ["collateral_mint", 32],
    ["index_feed_id", 32],
    ["max_staleness_secs", 8],
    ["conf_filter_bps", 2],
    ["invert", 1],
    ["unit_scale", 4],
    ["initial_mark_price_e6", 8],
    ["maintenance_fee_per_slot", 16],
    ["min_oracle_price_cap_e2bps", 8],
    ["h_min", 8],
    ["maintenance_margin_bps", 8],
    ["initial_margin_bps", 8],
    ["trading_fee_bps", 8],
    ["max_accounts", 8],
    ["new_account_fee", 16],
    ["h_max", 8],
    ["max_crank_staleness_slots", 8],
    ["liquidation_fee_bps", 8],
    ["liquidation_fee_cap", 16],
    ["resolve_price_deviation_bps", 8],
    ["min_liquidation_abs", 16],
    ["min_nonzero_mm_req", 16],
    ["min_nonzero_im_req", 16],
    ["insurance_withdraw_max_bps", 2],
    ["insurance_withdraw_cooldown_slots", 8],
    ["permissionless_resolve_stale_slots", 8],
    ["funding_horizon_slots", 8],
    ["funding_k_bps", 8],
    ["funding_max_premium_bps", 8, true],
    ["funding_max_e9_per_slot", 8, true],
    ["mark_min_fee", 8],
    ["force_close_delay_slots", 8],
  ],
  1: [["fee_payment", 8]],
  2: [
    ["matcher_program", 32],
    ["matcher_context", 32],
    ["fee_payment", 8],
  ],
  3: [
    ["user_idx", 2],
    ["amount", 8],
  ],
  4: [
    ["user_idx", 2],
    ["amount", 8],
  ],
  5: [
    ["caller_idx", 2],
    ["format", 1],
    ["candidate0_idx", 2],
    ["candidate0_policy", 1],
    ["candidate1_idx", 2],
    ["candidate1_policy", 1],
  ],
  6: [
    ["lp_idx", 2],
    ["user_idx", 2],
    ["size", 16, true],
  ],
  7: [["target_idx", 2]],
  8: [["user_idx", 2]],
  9: [["amount", 8]],
  10: [
    ["lp_idx", 2],
    ["user_idx", 2],
    ["size", 16, true],
    ["limit_price_e6", 8],
  ],
  13: [],
  14: [
    ["funding_horizon_slots", 8],
    ["funding_k_bps", 8],
    ["funding_max_premium_bps", 8, true],
    ["funding_max_e9_per_slot", 8, true],
    ["tvl_insurance_cap_mult", 2],
  ],
  17: [
    ["mark_price_e6", 8],
    ["timestamp", 8, true],
  ],
  18: [["max_change_e2bps", 8]],
  19: [],
  20: [],
  21: [["user_idx", 2]],
  23: [["amount", 8]],
  25: [["user_idx", 2]],
  26: [["user_idx", 2]],
  27: [
    ["user_idx", 2],
    ["amount", 8],
  ],
  28: [
    ["user_idx", 2],
    ["amount", 8],
  ],
  29: [],
  30: [["user_idx", 2]],
  31: [],
  32: [
    ["kind", 1],
    ["new_pubkey", 32],
  ],
};

/** Values on either side of the limits the program checks, cut to each field's width. */
const LIMITS = [
  3n,
  4n,
  5n,
  63n,
  64n,
  65n,
  127n,
  128n,
  129n,
  255n,
  256n,
  1000n,
  1001n,
  4095n,
  4096n,
  4097n,
  9_999n,
  10_000n,
  10_001n,
  65_535n,
  100_000n,
  1_000_000n,
  1_000_001n,
  10_000_000n,
  10_000_001n,
  1n << 32n,
  10n ** 12n,
  10n ** 12n + 1n,
  10n ** 14n,
  10n ** 14n + 1n,
  10n ** 15n,
  10n ** 15n + 1n,
  10n ** 16n,
  10n ** 16n + 1n,
  10n ** 18n,
  10n ** 20n,
  10n ** 20n + 1n,
  10n ** 32n,
  10n ** 32n + 1n,
  10n ** 36n,
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

/** The boundary values of a field of `size` bytes holding `current`. */
function boundaries(size: number, signed: boolean, current: bigint): bigint[] {
  const bits = BigInt(size * 8);
  const max = (1n << bits) - 1n;
  const half = 1n << (bits - 1n);
  const vs = new Set<bigint>([0n, 1n, 2n, max, max - 1n, half - 1n, half, half + 1n, current, current + 1n, current - 1n]);
  if (signed) for (const v of [-1n, -2n, -half, -half + 1n, -current, -(current + 1n)]) vs.add(v);
  for (const l of LIMITS)
    if (l <= max) {
      vs.add(l);
      if (signed) vs.add(-l);
    }
  return [...vs].map((v) => BigInt.asUintN(Number(bits), v)).filter((v, i, a) => a.indexOf(v) === i);
}

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: instruction-data mutations", () => {
  let w: World;
  const t = new Tally();
  beforeAll(async () => {
    w = await World.create(SEED ^ 0xda7an);
    await w.build();
  }, 600_000);

  const send = (s: State, b: Base, what: string, data: Buffer, category = "data") =>
    trial(w, t, category, b.name, `${s.name}: ${b.name}: ${what}`, swapIx(b, { ...b.ixs[b.at]!, data: new Uint8Array(data) } as Instruction));

  /** InitMarket once per oracle kind (its slab is the spare one, the same in every state of a kind). */
  function states(b: Base): State[] {
    if (b.tag !== 0) return w.states;
    const seen = new Set<string>();
    return w.states.filter((s) => !seen.has(s.kind) && seen.add(s.kind));
  }

  it("truncations and appended bytes", async () => {
    for (const s0 of w.states)
      for (const b of bases(s0)) {
        if (!states(b).includes(s0)) continue;
        const data = Buffer.from(b.ixs[b.at]!.data!);
        // InitMarket: every length in one state of each kind would be 362 transactions; every length in the first,
        // the lengths around its two valid ones elsewhere.
        const lengths = Array.from({ length: data.length }, (_, n) => n).filter((n) => b.tag !== 0 || s0 === w.states[0] || n < 4 || Math.abs(n - 296) < 3);
        for (const n of lengths) await send(s0, b, `truncated to ${n}`, data.subarray(0, n));
        for (let n = 1; n <= 9; n++) await send(s0, b, `${n} bytes appended`, Buffer.concat([data, Buffer.alloc(n, n === 9 ? 0xff : 0)]));
        if (b.tag === 0) await send(s0, b, "the short form (no extended tail)", data.subarray(0, 296));
      }
    t.print("truncations and appends");
    expect(t.divergences, t.divergences.slice(0, 20).join("\n\n")).toEqual([]);
  }, 3_600_000);

  it("every field at its boundaries", async () => {
    const t0 = t.divergences.length;
    const keys = (s: State) => [
      Buffer.alloc(32),
      Buffer.alloc(32, 0xff),
      ...[s.m.slab, s.m.admin.address, s.m.mint, s.m.oracle, s.alice.key.address, s.newAuthority.address, s.lp.ctx, w.payer.address].map((a) =>
        Buffer.from(getAddressEncoder().encode(a)),
      ),
      ...w.extra.slice(-12).map((e) => Buffer.from(getAddressEncoder().encode(e.address))),
    ];
    for (const s0 of w.states)
      for (const b of bases(s0)) {
        if (!states(b).includes(s0)) continue;
        const data = Buffer.from(b.ixs[b.at]!.data!);
        let at = 1;
        for (const [name, size, signed] of LAYOUT[b.tag]!) {
          if (size === 32) {
            for (const [k, v] of keys(s0).entries()) {
              const d = Buffer.from(data);
              v.copy(d, at);
              await send(s0, b, `${name} = key ${k}`, d, "fields");
            }
          } else
            for (const v of boundaries(size, signed ?? false, readLe(data, at, size))) {
              const d = Buffer.from(data);
              writeLe(d, at, size, v);
              await send(s0, b, `${name} = ${signed ? BigInt.asIntN(size * 8, v) : v}`, d, "fields");
            }
          at += size;
        }
        if (at !== data.length) throw new Error(`${b.name}: the layout covers ${at} of ${data.length} bytes`);
      }
    t.print("fields");
    expect(t.divergences.slice(t0), t.divergences.slice(t0, t0 + 20).join("\n\n")).toEqual([]);
  }, 3_600_000);

  it("random byte changes", async () => {
    const t0 = t.divergences.length;
    const per = Math.max(1, Math.round(25 * SCALE));
    for (const s0 of w.states)
      for (const b of bases(s0)) {
        if (!states(b).includes(s0)) continue;
        const data = Buffer.from(b.ixs[b.at]!.data!);
        if (data.length < 2) continue;
        for (let k = 0; k < per; k++) {
          const d = Buffer.from(data);
          const what: string[] = [];
          for (let n = 1 + w.rng.int(3); n > 0; n--) {
            const i = w.rng.chance(5) ? 0 : 1 + w.rng.int(d.length - 1);
            d[i] = w.rng.chance(30) ? d[i]! ^ (1 << w.rng.int(8)) : w.rng.int(256);
            what.push(`[${i}]=${d[i]}`);
          }
          await send(s0, b, `bytes ${what.join(" ")}`, d, "flips");
        }
      }
    t.print("flips");
    expect(t.divergences.slice(t0), t.divergences.slice(t0, t0 + 20).join("\n\n")).toEqual([]);
  }, 3_600_000);

  it("every tag, with no payload and with each instruction's payload", async () => {
    const t0 = t.divergences.length;
    // Every tag in three states (live with positions, resolved, Hyperp), each with the payload of every instruction;
    // with PERCOLATOR_MUTATE_SCALE of 4 or more, in every state.
    const chosen = SCALE >= 4 ? w.states : w.states.filter((s) => ["positions", "resolved", "hyperp"].includes(s.name));
    for (const s0 of chosen) {
      const all = bases(s0);
      for (const b of all)
        for (let tag = 0; tag < 256; tag++) {
          if (tag === b.tag) continue;
          const payload = Buffer.from(b.ixs[b.at]!.data!.subarray(1));
          // The empty payload once per tag (with the first base's accounts), the payload with every base.
          if (b === all[0]) await send(s0, b, `tag ${tag} (${NAMES[tag] ?? "unknown"}), no payload`, Buffer.from([tag]), "tags");
          if (payload.length > 0)
            await send(s0, b, `tag ${tag} (${NAMES[tag] ?? "unknown"}) with ${b.name}'s payload`, Buffer.concat([Buffer.from([tag]), payload]), "tags");
        }
    }
    t.print("tags");
    expect(t.divergences.slice(t0), t.divergences.slice(t0, t0 + 20).join("\n\n")).toEqual([]);
  }, 3_600_000);

  it("KeeperCrank: candidate lists and formats", async () => {
    const t0 = t.divergences.length;
    const per = Math.max(1, Math.round(40 * SCALE));
    for (const s0 of w.states) {
      const b = bases(s0).find((x) => x.tag === 5)!;
      const used = [s0.idx.alice, s0.idx.bob, s0.idx.lp, s0.idx.dust];
      const caller = Buffer.from(b.ixs[b.at]!.data!.subarray(1, 3));
      for (const format of [0, 1, 2, 3, 0x7f, 0x80, 0xff]) await send(s0, b, `format ${format}, no candidates`, Buffer.from([5, ...caller, format]), "crank");
      for (let k = 0; k < per; k++) {
        const n = w.rng.pick([0, 1, 2, 3, 4, 5, 8, 16, 63, 64, 65, 127, 128, 129, 130]);
        const parts: Buffer[] = [
          Buffer.from([5]),
          w.rng.chance(15) ? Buffer.from([0xff, 0xff]) : caller,
          Buffer.from([w.rng.chance(95) ? 1 : w.rng.pick([0, 2, 0xff])]),
        ];
        for (let c = 0; c < n; c++) {
          const idx = w.rng.chance(70) ? w.rng.pick(used) : w.rng.pick([5, 100, 4095, 4096, 4097, 65_534, 65_535]);
          const policy = w.rng.pick([0, 0, 1, 1, 0xff, 0xff, 2, 3, 0xfe]);
          const p = Buffer.alloc(3);
          p.writeUInt16LE(idx);
          p[2] = policy;
          parts.push(p);
          if (policy === 1) parts.push(le128(w.rng.pick([0n, 1n, 1000n, 1_000_000n, 10n ** 14n, 10n ** 14n + 1n, (1n << 127n) - 1n, (1n << 128n) - 1n])));
        }
        // Now and then a truncated last candidate.
        let data = Buffer.concat(parts);
        if (n > 0 && w.rng.chance(10)) data = data.subarray(0, data.length - 1 - w.rng.int(2));
        await send(s0, b, `${n} candidates (${data.toString("hex").slice(6, 70)}…)`, data, "crank");
      }
    }
    t.print("crank");
    expect(t.divergences.slice(t0), t.divergences.slice(t0, t0 + 20).join("\n\n")).toEqual([]);
  }, 3_600_000);
});
