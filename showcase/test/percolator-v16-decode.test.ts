// The instruction decode of the Percolator v16 port (showcase/mainnet/percolator-v16/percolator.ts) against the
// reference (Percolator v16 at commit 7b110913, engine 5e3af07, aeyakovenko/percolator-prog and aeyakovenko/percolator,
// Apache-2.0; test/programs/percolator_v16.so, the Rust build of those commits, not a deployed program).
//
// What is compared, and what is not. The original's processor runs `Instruction::decode` first, before any account is
// looked at, and every refusal of decode is InvalidInstructionData. The port mirrors decode for all 50 tags and then
// dispatches to the tag's handler. So:
//
// - Where the port refuses (InvalidInstructionData), the reference must refuse the same way: the same outcome, log
//   lines, inner instructions, return data and accounts (the harness's full comparison, `Diff.compare`).
// - Where a ported tag decodes, its handler runs in both and the whole result is compared as for a refusal (with no
//   account, the handler's first refusal).
// - Where an input decodes, the reference must NOT have refused in decode: its result must be anything but
//   InvalidInstructionData (an error of its handler, a panic, or success). That is decidable because the original's
//   processor returns InvalidInstructionData only from decode (src/v16_program.rs has no other site) and, with no
//   account passed, no handler gets as far as a CPI whose callee could return it. With accounts, it would not always be
//   decidable: a matcher called by TradeCpi / BatchTradeCpi, or SPL Token, could fail with InvalidInstructionData of
//   its own after decode. The boundary inputs are therefore sent with no account.
//
// The inputs: per tag, its well-formed body; every truncation at a field boundary and inside each field; one, two and
// 32 trailing bytes; the enum, bool and flag bytes at out-of-range values (decode does not judge them: both decode);
// for the three vector bodies, counts 0, 1, 16, 17 and 255 with and without matching data; and a seeded random fuzz.
// The body layouts below are transcribed from `Instruction::decode` independently of the port's own table.
import { type Address, type KeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { send as sendTx } from "../../test/harness.js";
import { Rng } from "./fuzz-rng.js";
import { Diff, HAVE_PORT, HAVE_REFERENCE, builtin, instruction, outcome, meta } from "./percolator-v16-helpers.js";

const SEED = BigInt(process.env.PERCOLATOR_FUZZ_SEED ?? "1618");
const FUZZ_PER_TAG = Number(process.env.PERCOLATOR_DECODE_FUZZ ?? 200);

type Width = "u8" | "u16" | "u32" | "u64" | "i64" | "u128" | "i128" | "b32";
const WIDTH: Record<Width, number> = { u8: 1, u16: 2, u32: 4, u64: 8, i64: 8, u128: 16, i128: 16, b32: 32 };
/** A field: its name in `Instruction`, its reader, and whether it is an enum / bool / flag byte decode leaves alone. */
type Field = readonly [name: string, width: Width, judged?: "enum"];

const u64s = (...names: string[]): Field[] => names.map((n) => [n, "u64"] as const);

/** Tag → its name and fields, in the order `Instruction::decode` reads them (bodies without a vector). */
const FIXED: Record<number, { name: string; fields: readonly Field[] }> = {
  0: {
    name: "InitMarket",
    fields: [
      ["max_portfolio_assets", "u16"],
      ...u64s("h_min", "h_max", "initial_price"),
      ["min_nonzero_mm_req", "u128"],
      ["min_nonzero_im_req", "u128"],
      ...u64s("maintenance_margin_bps", "initial_margin_bps", "max_trading_fee_bps", "trade_fee_base_bps", "liquidation_fee_bps"),
      ["liquidation_fee_cap", "u128"],
      ["min_liquidation_abs", "u128"],
      ...u64s(
        "max_price_move_bps_per_slot",
        "max_accrual_dt_slots",
        "max_abs_funding_e9_per_slot",
        "min_funding_lifetime_slots",
        "max_account_b_settlement_chunks",
        "max_bankrupt_close_chunks",
        "max_bankrupt_close_lifetime_slots",
      ),
      ["public_b_chunk_atoms", "u128"],
      ["maintenance_fee_per_slot", "u128"],
    ],
  },
  1: { name: "InitPortfolio", fields: [] },
  3: { name: "Deposit", fields: [...u64s("portfolio_id", "expected_sequence"), ["amount", "u128"]] },
  4: { name: "Withdraw", fields: [...u64s("portfolio_id", "expected_sequence"), ["amount", "u128"]] },
  6: {
    name: "TradeNoCpi",
    fields: [
      ...u64s("account_a_portfolio_id", "account_a_position_epoch", "account_b_portfolio_id", "account_b_position_epoch"),
      ["asset_index", "u16"],
      ["market_id", "u64"],
      ["size_q", "i128"],
      ...u64s("exec_price", "fee_bps"),
      ["backing_fee_cap_bps", "u16"],
    ],
  },
  8: { name: "ClosePortfolio", fields: u64s("portfolio_id", "expected_sequence", "position_epoch") },
  9: { name: "TopUpInsurance", fields: [...u64s("market_id", "intent_id", "authority_epoch"), ["amount", "u128"]] },
  10: {
    name: "TradeCpi",
    fields: [
      ...u64s("account_a_portfolio_id", "account_a_position_epoch", "account_b_portfolio_id", "account_b_position_epoch", "account_b_matcher_sequence"),
      ["asset_index", "u16"],
      ["market_id", "u64"],
      ["size_q", "i128"],
      ...u64s("fee_bps", "limit_price"),
      ["backing_fee_cap_bps", "u16"],
    ],
  },
  13: { name: "CloseSlab", fields: u64s("authority_epoch") },
  19: { name: "ResolveMarket", fields: u64s("asset_generation_frontier", "authority_epoch") },
  24: {
    name: "TopUpBackingBucket",
    fields: [
      ["domain", "u16"],
      ...u64s("market_id", "intent_id", "authority_epoch"),
      ["backing_fee_bps", "u16"],
      ["insurance_share_bps", "u16"],
      ["amount", "u128"],
      ["expiry_slot", "u64"],
    ],
  },
  28: { name: "ConvertReleasedPnl", fields: [...u64s("portfolio_id", "position_epoch"), ["amount", "u128"]] },
  30: { name: "CloseResolved", fields: [["fee_rate_per_slot", "u128"]] },
  32: {
    name: "UpdateAuthority",
    fields: [
      ["authority_epoch", "u64"],
      ["new_pubkey", "b32"],
    ],
  },
  34: {
    name: "ConfigureHybridOracle",
    fields: [
      ["asset_index", "u16"],
      ...u64s("market_id", "now_slot"),
      ["now_unix_ts", "i64"],
      ["oracle_leg_count", "u8", "enum"],
      ["oracle_leg_flags", "u8", "enum"],
      ...u64s("max_staleness_secs", "hybrid_soft_stale_slots", "mark_ewma_halflife_slots", "mark_min_fee"),
      ["invert", "u8", "enum"],
      ["unit_scale", "u32"],
      ["conf_filter_bps", "u16"],
      ["oracle_leg_feed_0", "b32"],
      ["oracle_leg_feed_1", "b32"],
      ["oracle_leg_feed_2", "b32"],
      ...u64s("observation_sequence", "authority_epoch"),
    ],
  },
  35: {
    name: "ConfigureEwmaMark",
    fields: [
      ["asset_index", "u16"],
      ...u64s("market_id", "now_slot", "initial_mark_e6", "mark_ewma_halflife_slots", "mark_min_fee", "observation_sequence", "authority_epoch"),
    ],
  },
  36: { name: "PushEwmaMark", fields: [["asset_index", "u16"], ...u64s("market_id", "now_slot", "mark_e6", "observation_sequence", "authority_epoch")] },
  37: { name: "UpdateLiquidationFeePolicy", fields: [["cranker_share_bps", "u16"], ...u64s("policy_sequence", "authority_epoch")] },
  38: {
    name: "ConfigurePermissionlessResolve",
    fields: u64s("asset_generation_frontier", "stale_slots", "force_close_delay_slots", "policy_sequence", "authority_epoch"),
  },
  39: { name: "ResolveStalePermissionless", fields: u64s("now_slot") },
  40: {
    name: "UpdateAssetLifecycle",
    fields: [
      ["action", "u8", "enum"],
      ["asset_index", "u16"],
      ...u64s("market_id", "authority_epoch", "now_slot", "initial_price"),
      ["max_init_fee", "u128"],
      ["insurance_authority", "b32"],
      ["insurance_operator", "b32"],
      ["backing_bucket_authority", "b32"],
      ["oracle_authority", "b32"],
    ],
  },
  42: { name: "CureAndCancelClose", fields: [...u64s("portfolio_id", "position_epoch"), ["optional_deposit", "u128"]] },
  43: { name: "ForfeitRecoveryLeg", fields: [...u64s("portfolio_id", "position_epoch"), ["asset_index", "u16"], ["b_delta_budget", "u128"]] },
  44: { name: "RebalanceReduce", fields: [...u64s("portfolio_id", "position_epoch"), ["asset_index", "u16"], ["reduce_q", "u128"]] },
  45: {
    name: "FinalizeResetSide",
    fields: [
      ["asset_index", "u16"],
      ["side", "u8", "enum"],
    ],
  },
  46: { name: "ClaimResolvedPayoutTopup", fields: [] },
  48: { name: "SyncMaintenanceFee", fields: u64s("now_slot") },
  49: { name: "UpdateMaintenanceFeePolicy", fields: [["cranker_share_bps", "u16"], ...u64s("policy_sequence", "authority_epoch")] },
  50: { name: "WithdrawBackingBucket", fields: [["domain", "u16"], ...u64s("market_id", "authority_epoch"), ["amount", "u128"]] },
  51: {
    name: "UpdateBackingFeePolicy",
    fields: [["domain", "u16"], ["market_id", "u64"], ["fee_bps", "u16"], ["insurance_share_bps", "u16"], ...u64s("policy_sequence", "authority_epoch")],
  },
  52: { name: "WithdrawBackingBucketEarnings", fields: [["domain", "u16"], ...u64s("market_id", "authority_epoch"), ["amount", "u128"]] },
  53: { name: "SyncBackingDomainLedger", fields: [["domain", "u16"]] },
  54: { name: "SyncInsuranceLedger", fields: [] },
  55: { name: "UpdateTradeFeePolicy", fields: u64s("trade_fee_base_bps", "policy_sequence", "authority_epoch") },
  56: { name: "TopUpInsuranceDomain", fields: [["domain", "u16"], ...u64s("market_id", "intent_id", "authority_epoch"), ["amount", "u128"]] },
  57: { name: "WithdrawInsuranceAsset", fields: [["asset_index", "u16"], ...u64s("market_id", "authority_epoch"), ["amount", "u128"]] },
  58: { name: "UpdateFeeRedirectPolicy", fields: [["redirect_bps", "u16"], ...u64s("policy_sequence", "authority_epoch")] },
  59: { name: "UpdateMarketInitFeePolicy", fields: [["min_init_fee", "u128"], ...u64s("policy_sequence", "authority_epoch")] },
  60: {
    name: "UpdateBaseUnitMints",
    fields: [
      ["primary_mint", "b32"],
      ["secondary_mint", "b32"],
      ["authority_epoch", "u64"],
    ],
  },
  61: {
    name: "SwapSecondaryForPrimary",
    fields: [
      ["amount", "u128"],
      ["authority_epoch", "u64"],
    ],
  },
  62: {
    name: "ConfigureAuthMark",
    fields: [["asset_index", "u16"], ...u64s("market_id", "now_slot", "initial_mark_e6", "observation_sequence", "authority_epoch")],
  },
  63: { name: "PushAuthMark", fields: [["asset_index", "u16"], ...u64s("market_id", "now_slot", "mark_e6", "observation_sequence", "authority_epoch")] },
  64: {
    name: "ForceCloseAbandonedAsset",
    fields: [
      ["asset_index", "u16"],
      ["now_slot", "u64"],
      ["close_q", "u128"],
    ],
  },
  65: {
    name: "UpdateAssetAuthority",
    fields: [["asset_index", "u16"], ...u64s("market_id", "authority_epoch"), ["kind", "u8", "enum"], ["new_pubkey", "b32"]],
  },
  68: {
    name: "SetMatcherConfig",
    fields: [
      ...u64s("portfolio_id", "expected_sequence", "position_epoch", "asset_generation_frontier"),
      ["enabled", "u8", "enum"],
      ["trade_fee_cap_bps", "u16"],
      ["expiry_slot", "u64"],
    ],
  },
  69: {
    name: "RestartAssetOracle",
    fields: [["asset_index", "u16"], ...u64s("market_id", "now_slot", "initial_price", "observation_sequence", "authority_epoch")],
  },
  70: { name: "CanonicalizeSpentBackingHistory", fields: [["asset_index", "u16"], ...u64s("market_id", "authority_epoch")] },
};

/** The three bodies with a vector: the fields before the count, one element, the fields after the elements. */
const VECTOR: Record<number, { name: string; before: readonly Field[]; elem: readonly Field[]; after: readonly Field[] }> = {
  5: {
    name: "PermissionlessCrank",
    before: u64s("now_slot"),
    elem: [
      ["asset_index", "u16"],
      ["oracle_accounts", "u8"],
    ],
    after: [],
  },
  66: {
    name: "BatchTradeNoCpi",
    before: [],
    elem: [["asset_index", "u16"], ["market_id", "u64"], ["size_q", "i128"], ...u64s("exec_price", "fee_bps")],
    after: u64s("account_a_portfolio_id", "account_a_position_epoch", "account_b_portfolio_id", "account_b_position_epoch"),
  },
  67: {
    name: "BatchTradeCpi",
    before: [],
    elem: [["asset_index", "u16"], ["market_id", "u64"], ["size_q", "i128"], ...u64s("fee_bps", "limit_price")],
    after: [
      ...u64s("account_a_portfolio_id", "account_a_position_epoch", "account_b_portfolio_id", "account_b_position_epoch", "account_b_matcher_sequence"),
      ["max_slippage_atoms", "u128"],
      ["max_fee_atoms", "u128"],
    ],
  },
};
const MAX_COUNT = 16;

const size = (fields: readonly Field[]) => fields.reduce((n, [, w]) => n + WIDTH[w], 0);
const TAGS = [...Object.keys(FIXED), ...Object.keys(VECTOR)].map(Number).sort((a, b) => a - b);

/** Whether `Instruction::decode` accepts `body` after `tag` (the model the inputs are labelled with). */
function decodes(tag: number, body: Uint8Array): boolean {
  const f = FIXED[tag];
  if (f) return body.length === size(f.fields);
  const v = VECTOR[tag]!;
  const before = size(v.before);
  if (body.length < before + 1) return false;
  const n = body[before]!;
  if (n > MAX_COUNT) return false;
  return body.length === before + 1 + n * size(v.elem) + size(v.after);
}

/** A vector body of `n` elements, random bytes, the count byte set (`count` overrides what it says). */
function vectorBody(rng: Rng, tag: number, n: number, count = n): Uint8Array {
  const v = VECTOR[tag]!;
  const b = rng.bytes(size(v.before) + 1 + n * size(v.elem) + size(v.after));
  b[size(v.before)] = count;
  return b;
}

/** The labelled inputs of one tag: the boundary cases (deterministic but for the random filler bytes). */
function boundaryCases(rng: Rng, tag: number): { label: string; body: Uint8Array }[] {
  const out: { label: string; body: Uint8Array }[] = [];
  const f = FIXED[tag];
  if (f) {
    const full = rng.bytes(size(f.fields));
    out.push({ label: "well-formed", body: full });
    out.push({ label: "all zero", body: new Uint8Array(full.length) });
    out.push({ label: "all 0xff", body: new Uint8Array(full.length).fill(0xff) });
    // Each field cut: before it, one byte into it, one byte short of its end.
    let at = 0;
    const cuts = new Set<number>();
    for (const [, w] of f.fields) {
      cuts.add(at);
      if (WIDTH[w] > 1) {
        cuts.add(at + 1);
        cuts.add(at + WIDTH[w] - 1);
      }
      at += WIDTH[w];
    }
    for (const c of [...cuts].sort((a, b) => a - b)) out.push({ label: `cut at ${c} of ${at}`, body: full.slice(0, c) });
    for (const extra of [1, 2, 32]) out.push({ label: `${extra} trailing`, body: new Uint8Array([...full, ...rng.bytes(extra)]) });
    // Enum, bool and flag bytes decode leaves to the handler: out-of-range values still decode.
    at = 0;
    for (const [name, w, judged] of f.fields) {
      if (judged)
        for (const value of [2, 3, 7, 0x80, 0xff]) {
          const b = full.slice();
          b[at] = value;
          out.push({ label: `${name} = ${value}`, body: b });
        }
      at += WIDTH[w];
    }
  } else {
    const v = VECTOR[tag]!;
    const before = size(v.before);
    for (const n of [0, 1, 2, 15, 16]) out.push({ label: `${n} elements`, body: vectorBody(rng, tag, n) });
    // Counts above 16, with as much data as the count asks for and with none.
    for (const n of [17, 18, 255]) {
      out.push({ label: `count ${n}, data for ${n}`, body: vectorBody(rng, tag, n) });
      out.push({ label: `count ${n}, no elements`, body: vectorBody(rng, tag, 0, n) });
      out.push({ label: `count ${n}, data for 16`, body: vectorBody(rng, tag, 16, n) });
    }
    // The count disagreeing with the data by one element either way.
    out.push({ label: "count 3, data for 2", body: vectorBody(rng, tag, 2, 3) });
    out.push({ label: "count 2, data for 3", body: vectorBody(rng, tag, 3, 2) });
    // Cuts: inside the fields before the count, at the count, inside the first element, inside the fields after.
    const two = vectorBody(rng, tag, 2);
    const cuts = new Set<number>([0, 1, before, before + 1, before + 2, two.length - 1]);
    if (before > 1) cuts.add(before - 1);
    let at = before + 1;
    for (const [, w] of v.elem) {
      cuts.add(at);
      if (WIDTH[w] > 1) cuts.add(at + WIDTH[w] - 1);
      at += WIDTH[w];
    }
    at = two.length - size(v.after);
    for (const [, w] of v.after) {
      cuts.add(at);
      if (WIDTH[w] > 1) cuts.add(at + WIDTH[w] - 1);
      at += WIDTH[w];
    }
    for (const c of [...cuts].filter((c) => c < two.length).sort((a, b) => a - b))
      out.push({ label: `2 elements, cut at ${c} of ${two.length}`, body: two.slice(0, c) });
    for (const extra of [1, 2, 32]) out.push({ label: `2 elements, ${extra} trailing`, body: new Uint8Array([...two, ...rng.bytes(extra)]) });
    out.push({ label: "16 elements, 1 trailing", body: new Uint8Array([...vectorBody(rng, tag, 16), 0]) });
  }
  return out;
}

/** Random inputs of one tag, around its well-formed lengths. */
function fuzzCases(rng: Rng, tag: number, count: number): { label: string; body: Uint8Array }[] {
  const out: { label: string; body: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    let body: Uint8Array;
    const f = FIXED[tag];
    if (f) {
      const len = size(f.fields);
      const pick = rng.int(4);
      body = rng.bytes(pick === 0 ? len : pick === 1 ? Math.max(0, len + rng.int(5) - 2) : rng.int(len + 40));
    } else {
      const v = VECTOR[tag]!;
      const n = rng.chance(70) ? rng.int(MAX_COUNT + 1) : rng.int(256);
      const pick = rng.int(4);
      if (pick === 0) body = vectorBody(rng, tag, Math.min(n, 20), n);
      else if (pick === 1) body = vectorBody(rng, tag, rng.int(MAX_COUNT + 2), n);
      else {
        const full = vectorBody(rng, tag, Math.min(n, 20), n);
        body = full.slice(0, Math.max(0, full.length + rng.int(7) - 3));
        if (body.length < full.length && rng.chance(30)) body = new Uint8Array([...body, ...rng.bytes(rng.int(3))]);
      }
      void v;
    }
    out.push({ label: `fuzz ${i}`, body });
  }
  return out;
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 decode: the port against the reference", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let market: Address;
  let mint: Address;
  /** Per tag: the reference's outcomes for inputs that decode (its handler's first refusal with no account). */
  const decodedOutcomes = new Map<number, Set<string>>();
  /** Per tag: the compute units of two refusals, reference and port (whole transactions, preamble included). */
  const refusalCu = new Map<number, { short: [bigint, bigint]; trailing: [bigint, bigint] }>();
  const counts = { refused: 0, decoded: 0 };

  beforeAll(async () => {
    d = await Diff.create();
    const m = await d.newMarket();
    payer = m.admin;
    market = m.market;
    mint = m.mint;
  });

  const invalid = builtin("InvalidInstructionData", 2);

  /** One input, no account: the comparison above. Returns whether the port refused it. */
  async function check(tag: number, label: string, body: Uint8Array): Promise<boolean> {
    const data = Buffer.from([tag, ...body]);
    const name = `${FIXED[tag]?.name ?? VECTOR[tag]!.name} (${tag}), ${label}, ${body.length} bytes`;
    const tx = d.transaction([instruction(data, [])]);
    const [a, b] = [await sendTx(d.reference, payer, tx), await sendTx(d.port, payer, tx)];
    const want = decodes(tag, body);
    if (outcome(b) === invalid) {
      // Refused by the port: the reference refuses identically (outcome, logs, inner instructions, return data,
      // the payer's account), and the model agrees that decode refuses it.
      d.compare(name, payer, tx, a, b);
      expect(want, `${name}: the model says it decodes`).toBe(false);
      counts.refused++;
      return true;
    }
    // Its handler runs in both, so the whole result is compared (with no account, its first refusal).
    d.compare(name, payer, tx, a, b);
    expect(outcome(a), `${name}: the reference decoded it (its handler's outcome)\n${meta(a).logs().join("\n")}`).not.toBe(invalid);
    expect(want, `${name}: the model says decode refuses it`).toBe(true);
    const seen = decodedOutcomes.get(tag) ?? new Set<string>();
    seen.add(
      outcome(a)
        .replace(/^error: TransactionErrorInstructionError \{ index: 2, error: /, "")
        .replace(/ \}$/, ""),
    );
    decodedOutcomes.set(tag, seen);
    counts.decoded++;
    return false;
  }

  it("tags with a fixed body: well-formed, cut at every field, trailing bytes, enum bytes out of range", async () => {
    const rng = new Rng(SEED);
    for (const tag of TAGS) {
      if (!FIXED[tag]) continue;
      for (const c of boundaryCases(rng, tag)) await check(tag, c.label, c.body);
    }
  }, 600_000);

  it("the three vector bodies: counts 0 to 16 decode, 17 and more are refused, cuts and trailing bytes", async () => {
    const rng = new Rng(SEED + 1n);
    for (const tag of TAGS) {
      if (!VECTOR[tag]) continue;
      for (const c of boundaryCases(rng, tag)) await check(tag, c.label, c.body);
    }
  }, 600_000);

  it(`random bodies, ${FUZZ_PER_TAG} per tag (seed ${SEED})`, async () => {
    const rng = new Rng(SEED + 2n);
    for (const tag of TAGS) for (const c of fuzzCases(rng, tag, FUZZ_PER_TAG)) await check(tag, c.label, c.body);
  }, 600_000);

  it("refusals with accounts: nothing touched, the same everywhere; compute units recorded", async () => {
    const rng = new Rng(SEED + 3n);
    const accounts = [{ address: payer.address, signer: payer, writable: true }, { address: market, writable: true }, { address: mint }];
    for (const tag of TAGS) {
      const f = FIXED[tag];
      const full = f ? rng.bytes(size(f.fields)) : vectorBody(rng, tag, 1);
      const short = full.slice(0, full.length - 1);
      const trailing = new Uint8Array([...full, 0]);
      const cu = { short: [0n, 0n] as [bigint, bigint], trailing: [0n, 0n] as [bigint, bigint] };
      for (const [which, body] of [
        ["short", short],
        ["trailing", trailing],
      ] as const) {
        if (body.length === 0 && which === "short") {
          // A body of nothing cannot be one byte short: the tag alone is the well-formed instruction.
          cu.short = cu.trailing;
          continue;
        }
        const label = `${tag} ${which}, 3 accounts`;
        await d.fails(label, payer, [instruction(Buffer.from([tag, ...body]), accounts)], invalid);
        cu[which] = d.cu[label]!;
      }
      if (cu.short[0] === 0n) cu.short = cu.trailing;
      refusalCu.set(tag, cu);
    }
    if (process.env.PERCOLATOR_TRACE) {
      for (const [tag, c] of refusalCu)
        console.log(`cu ${tag} ${FIXED[tag]?.name ?? VECTOR[tag]!.name}: short ${c.short[0]} / ${c.short[1]}, trailing ${c.trailing[0]} / ${c.trailing[1]}`);
    }
    // The port is cheaper on every decode refusal (refusals are not required to be; recorded in the README).
    for (const [tag, c] of refusalCu) {
      expect(c.short[1] < c.short[0], `${tag} short: ${c.short[1]} < ${c.short[0]}`).toBe(true);
      expect(c.trailing[1] < c.trailing[0], `${tag} trailing: ${c.trailing[1]} < ${c.trailing[0]}`).toBe(true);
    }
  }, 600_000);

  it("every tag was seen both decoded and refused, and the reference's decoded outcomes are its handlers'", () => {
    for (const tag of TAGS) expect(decodedOutcomes.has(tag), `tag ${tag} decoded at least once`).toBe(true);
    expect(TAGS.length).toBe(50);
    if (process.env.PERCOLATOR_TRACE) {
      for (const [tag, s] of decodedOutcomes) console.log(`decoded ${tag}: ${[...s].join(" | ")}`);
      console.log(`inputs: ${counts.refused} refused by both, ${counts.decoded} decoded by both`);
    }
    expect(counts.refused).toBeGreaterThan(0);
    for (const s of decodedOutcomes.values()) for (const o of s) expect(o).not.toBe("InvalidInstructionData");
  });
});
