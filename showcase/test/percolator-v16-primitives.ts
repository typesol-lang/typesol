// The market-view accessors and the backing and lien primitives of Percolator v16 at commit 7b110913 (engine 5e3af07;
// aeyakovenko/percolator, Apache-2.0) that the settlement of a portfolio's open legs is built from, compared one
// function at a time on whole markets and portfolios: the table both sides share
// (scripts/percolator-v16-reference/kernels/typesol_harness.rs `call_market` on the original's side,
// fixtures/percolator-v16-primitives.ts on the port's), and a generator of the market and portfolio bytes.
//
// A vector is a function id, eight 16-byte arguments, a market account (the account header and wrapper config, zero
// here: the engine never reads them, the group header, then `capacity` asset slots) and, for the functions that take
// a portfolio, a portfolio account (its header, zero, then the engine's portfolio). The original builds its views over
// the same bytes (`MarketGroupV16ViewMut` from the header and the slots, `PortfolioV16ViewMut` directly, without
// `new()`'s compaction: no function here is reached through `new()`), the port loads them as accounts; both answer
// with their outputs and every changed byte of both accounts.
//
// The states. The group header's config is `configBytes`' with a consistent slot count; each slot's asset is
// `structBytes`' with decodable enum bytes; each domain's ledger (source credit state, backing bucket, insurance
// reservation, provider principal, insurance budget) is generated consistent with itself (the bucket's status and
// amounts, the source's amounts equal to the bucket's and the reservation's, the claim bound and its exact part, the
// spent backing at least the receivable, the credit rate the state implies) at ordinary sizes and near the limits, and
// the header's totals are the sums over the slots, with the vault covering the senior claims. Then, one state in five,
// a field is broken (a total or an amount off by one, a status or rate out of place, a bound or an alignment missed),
// and some scales are chosen beyond what the vault can cover: those states are deliberately invalid. Function 68 (the
// two validators) measures how many the original accepts.
import { createHash } from "node:crypto";
import { Rng } from "./fuzz-rng.ts";
import { MARKET, offsetOf, sizeOf } from "./percolator-v16-layout.ts";
import { type Values, configBytes, structBytes } from "./percolator-v16-values.ts";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const BOUND_SCALE = 1_000_000_000_000n;
const CREDIT_RATE_SCALE = 1_000_000_000_000n;
const MAX_VAULT_TVL = 10_000_000_000_000_000n;
const ADL_ONE = 1_000_000_000_000_000n;
const SOCIAL_LOSS_DEN = 1_000_000_000_000_000_000_000n;
const SLOT_LEN = sizeOf("AssetSlot");
const ENGINE_AT = 512;
export const PORTFOLIO_LEN = 16 + sizeOf("Portfolio");
const NO_PORTFOLIO_LEN = 16;

export interface MarketVector {
  fn: number;
  args: bigint[];
  market: Buffer;
  portfolio: Buffer;
}

/** A little-endian write of `size` bytes (two's complement for negative values). */
function put(b: Buffer, at: number, size: number, value: bigint): void {
  let x = value < 0n ? (1n << BigInt(8 * size)) + value : value;
  for (let i = 0; i < size; i++) {
    b[at + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}
function get(b: Buffer, at: number, size: number): bigint {
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i]!);
  return v;
}

const groupAt = (path: string) => MARKET.group + offsetOf("GroupHeader", path);
const engineAt = (asset: number, path: string) => MARKET.slots + asset * SLOT_LEN + ENGINE_AT + offsetOf("EngineAssetSlot", path);
const sideName = (domain: number) => (domain % 2 === 1 ? "short" : "long");
const domainAt = (domain: number, struct: string, field: string) => engineAt(Math.floor(domain / 2), `${struct}_${sideName(domain)}.${field}`);
export const portfolioAt = (path: string) => 16 + offsetOf("Portfolio", path);
const sourceDomainAt = (slot: number, field: string) =>
  16 + offsetOf("Portfolio", "source_domains") + slot * sizeOf("PortfolioSourceDomain") + offsetOf("PortfolioSourceDomain", field);
const legAt = (slot: number, field: string) => 16 + offsetOf("Portfolio", "legs") + slot * sizeOf("PortfolioLeg") + offsetOf("PortfolioLeg", field);

/** A random u128 at most `max`. */
function wide(rng: Rng, max: bigint): bigint {
  if (max <= 0n) return 0n;
  return ((rng.next() << 64n) | rng.next()) % (max + 1n);
}

/** An amount (a bound number) of a scale picked at random; `vaultSafe` keeps it within what a vault can cover. */
function amount(rng: Rng, vaultSafe: boolean): bigint {
  const r = rng.int(10);
  if (r < 2) return 0n;
  if (r < 4) return BigInt(1 + rng.int(1000)) * BOUND_SCALE;
  if (r < 6) return wide(rng, 1_000_000n * BOUND_SCALE);
  if (r < 7) return BigInt(1 + rng.int(1_000_000));
  if (vaultSafe || r < 9) return wide(rng, 100_000_000_000n * BOUND_SCALE);
  return rng.chance(50) ? U128_MAX - BigInt(rng.int(3)) : wide(rng, U128_MAX >> 1n);
}
const align = (v: bigint) => (v / BOUND_SCALE) * BOUND_SCALE;

/** `expected_source_credit_rate_num_for_state` for a shape-valid state. */
function expectedRate(s: Record<string, bigint>): bigint {
  if (s.positive_claim_bound_num === 0n) return CREDIT_RATE_SCALE;
  const available =
    s.fresh_reserved_backing_num! -
    s.valid_liened_backing_num! +
    (s.insurance_credit_reserved_num! - s.valid_liened_insurance_num! - s.impaired_liened_insurance_num!);
  if (available <= 0n) return 0n;
  const covered = s.valid_liened_backing_num! + s.valid_liened_insurance_num!;
  const unliened = s.positive_claim_bound_num! > covered ? s.positive_claim_bound_num! - covered : 0n;
  if (available >= unliened) return CREDIT_RATE_SCALE;
  return (available * CREDIT_RATE_SCALE) / unliened;
}

/** One domain's ledger, written into the market: consistent with itself (see the head of the file). */
export function writeLedger(rng: Rng, b: Buffer, domain: number, marketId: bigint, now: bigint, safe: boolean): void {
  const r = rng.int(20);
  const status = r < 3 ? 0 : r < 13 ? 1 : r < 16 ? 2 : 3;
  let fresh = 0n;
  let valid = 0n;
  let impaired = 0n;
  let expiry = 0n;
  const consumed = status === 0 ? 0n : rng.chance(50) ? 0n : amount(rng, safe);
  const earnings = status === 0 ? 0n : rng.chance(50) ? 0n : wide(rng, rng.chance(80) ? 1_000_000n : 1_000_000_000_000n);
  if (status === 1) {
    fresh = amount(rng, safe);
    valid = rng.chance(40) ? 0n : rng.chance(50) ? wide(rng, fresh) : amount(rng, safe);
    if (fresh + valid === 0n) fresh = BOUND_SCALE;
    impaired = rng.chance(70) ? 0n : amount(rng, safe);
    expiry = rng.chance(60) ? now + 1n + BigInt(rng.int(1000)) : rng.chance(50) ? now - BigInt(rng.int(100)) : now;
    if (expiry <= 0n) expiry = 1n;
  } else if (status === 3) impaired = amount(rng, safe) || BOUND_SCALE;
  else if (status === 2) expiry = rng.chance(50) ? 0n : now - BigInt(rng.int(1000));
  const bucket = (f: string, size: number, v: bigint) => put(b, domainAt(domain, "backing", f), size, v);
  bucket("market_id", 8, status === 0 && rng.chance(50) ? 0n : marketId);
  bucket("fresh_unliened_backing_num", 16, fresh);
  bucket("valid_liened_backing_num", 16, valid);
  bucket("consumed_liened_backing_num", 16, consumed);
  bucket("impaired_liened_backing_num", 16, impaired);
  bucket("utilization_fee_earnings", 16, earnings);
  bucket("expiry_slot", 8, expiry < 0n ? 0n : expiry);
  bucket("status", 1, BigInt(status));
  // The insurance reservation, atom-aligned, covering its liens.
  const reserved = rng.chance(40) ? 0n : align(amount(rng, safe));
  const validIns = align(wide(rng, reserved));
  const impairedIns = align(wide(rng, reserved - validIns));
  const res = (f: string, size: number, v: bigint) => put(b, domainAt(domain, "insurance_reservation", f), size, v);
  res("insurance_credit_reserved_num", 16, reserved);
  res("valid_liened_insurance_num", 16, validIns);
  res("impaired_liened_insurance_num", 16, impairedIns);
  res("consumed_insurance_num", 16, rng.chance(50) ? 0n : align(amount(rng, safe)));
  res("source_credit_epoch", 8, reserved === 0n && rng.chance(50) ? 0n : BigInt(rng.int(100)));
  // The source credit state: its amounts the bucket's and the reservation's, a claim bound, the implied rate.
  const s: Record<string, bigint> = {
    fresh_reserved_backing_num: fresh + valid,
    spent_backing_num: consumed + (rng.chance(50) ? 0n : amount(rng, safe)),
    provider_receivable_num: consumed,
    valid_liened_backing_num: valid,
    impaired_liened_backing_num: impaired,
    insurance_credit_reserved_num: reserved,
    valid_liened_insurance_num: validIns,
    impaired_liened_insurance_num: impairedIns,
    positive_claim_bound_num: rng.chance(30) ? 0n : rng.chance(50) ? valid + validIns + amount(rng, safe) : amount(rng, safe),
  };
  s.exact_positive_claim_num = wide(rng, s.positive_claim_bound_num!);
  s.credit_rate_num = expectedRate(s);
  s.credit_epoch = rng.chance(30) ? 0n : BigInt(rng.int(1000));
  const empty = Object.entries(s).every(([k, v]) => k === "credit_rate_num" || k === "credit_epoch" || v === 0n);
  if (empty && rng.chance(50)) s.credit_epoch = 0n;
  for (const [f, v] of Object.entries(s)) put(b, domainAt(domain, "source_credit", f), f === "credit_epoch" ? 8 : 16, v);
  // Provider principal near the fresh backing; the insurance budget and its spent part.
  const principal = rng.pick([0n, fresh + valid, wide(rng, fresh + valid), fresh + valid + BigInt(rng.int(10)), amount(rng, safe)]);
  put(b, engineAt(Math.floor(domain / 2), `provider_principal_${sideName(domain)}_num`), 16, principal);
  const spent = rng.chance(50) ? 0n : BigInt(rng.int(1_000_000));
  put(b, engineAt(Math.floor(domain / 2), `insurance_domain_spent_${sideName(domain)}`), 16, spent);
  put(b, engineAt(Math.floor(domain / 2), `insurance_domain_budget_${sideName(domain)}`), 16, spent + (rng.chance(80) ? BigInt(rng.int(1_000_000)) : 0n));
  if (rng.chance(15)) put(b, engineAt(Math.floor(domain / 2), `pending_domain_loss_barrier_${sideName(domain)}`), 8, BigInt(1 + rng.int(3)));
}

/** The fields of one domain a vector's arguments are drawn near. */
export function ledgerField(b: Buffer, domain: number, struct: string, field: string, size = 16): bigint {
  if (domain < 0 || MARKET.slots + Math.floor(domain / 2) * SLOT_LEN + SLOT_LEN > b.length) return 0n;
  return get(b, domainAt(domain, struct, field), size);
}

export interface MarketInfo {
  capacity: number;
  configured: number;
  now: bigint;
}

/** A market account (see the head of the file). */
export function marketBytes(rng: Rng): { market: Buffer; info: MarketInfo } {
  const capacity = 1 + rng.int(4);
  const configured = rng.chance(10) ? capacity : 1 + rng.int(capacity);
  const b = Buffer.alloc(MARKET.slots + capacity * SLOT_LEN);
  const safe = rng.chance(92);
  const now = rng.chance(5) ? U64_MAX - BigInt(rng.int(1000)) : BigInt(1000 + rng.int(1_000_000_000));
  const pool: Values = { magnitudes: [wide(rng, 1_000_000n * BOUND_SCALE), BigInt(rng.int(1_000_000)), wide(rng, U128_MAX)] };
  // The slots.
  for (let a = 0; a < capacity; a++) {
    const asset = structBytes(rng, "AssetState", pool);
    asset.copy(b, engineAt(a, "asset"));
    const life = rng.chance(5) ? rng.int(6) : rng.pick([2, 2, 2, 3, 5, 4]);
    put(b, engineAt(a, "asset.lifecycle"), 1, BigInt(life));
    put(b, engineAt(a, "asset.mode_long"), 1, BigInt(rng.chance(80) ? 0 : rng.int(3)));
    put(b, engineAt(a, "asset.mode_short"), 1, BigInt(rng.chance(80) ? 0 : rng.int(3)));
    // An unassigned slot (market id 0): past the configured ones half the time, a configured one now and then.
    const marketId = (a >= configured && rng.chance(50)) || rng.chance(4) ? 0n : BigInt(a + 1);
    if (rng.chance(20)) {
      put(b, engineAt(a, "asset.stored_pos_count_long"), 8, 0n);
      put(b, engineAt(a, "asset.stored_pos_count_short"), 8, 0n);
    }
    put(b, engineAt(a, "asset.market_id"), 8, marketId);
    if (rng.chance(60)) {
      put(b, engineAt(a, "asset.stale_account_count_long"), 8, 0n);
      put(b, engineAt(a, "asset.stale_account_count_short"), 8, 0n);
    }
    for (const side of [0, 1]) {
      const domain = 2 * a + side;
      if (marketId === 0n && rng.chance(70)) {
        // The EMPTY ledger of an unassigned slot.
        put(b, domainAt(domain, "source_credit", "credit_rate_num"), 16, CREDIT_RATE_SCALE);
        continue;
      }
      writeLedger(rng, b, domain, marketId === 0n ? 1n : marketId, now, safe);
    }
  }
  // The header: the config with a consistent slot count, the totals over the slots, money covering them.
  configBytes(rng).copy(b, groupAt("config"));
  // Nine markets in ten keep the three backing-fee rates within their summed maximum (configBytes draws each alone).
  if (rng.chance(90)) {
    const rates = ["backing_fee_base_rate_e9_per_slot", "backing_fee_slope_at_kink_e9_per_slot", "backing_fee_slope_above_kink_e9_per_slot"];
    for (const f of rates) put(b, groupAt(`config.${f}`), 8, get(b, groupAt(`config.${f}`), 8) / 3n);
  }
  put(b, groupAt("config.max_market_slots"), 4, BigInt(configured));
  // The backing freshness horizon from h_max or the bankrupt-close lifetime now and then (configBytes keeps both below
  // the accrual window).
  if (rng.chance(15)) put(b, groupAt("config.h_max"), 8, BigInt(101 + rng.int(1000)));
  if (rng.chance(15)) put(b, groupAt("config.max_bankrupt_close_lifetime_slots"), 8, BigInt(101 + rng.int(1000)));
  put(b, groupAt("config.max_portfolio_assets"), 2, BigInt(Math.min(2, configured)));
  for (let i = 0; i < 32; i++) b[groupAt("market_group_id") + i] = 7 + i;
  put(b, groupAt("asset_slot_capacity"), 4, BigInt(rng.chance(3) ? capacity + 1 : capacity));
  let bound = 0n;
  let freshTotal = 0n;
  let insuranceAtoms = 0n;
  let earnings = 0n;
  let remaining = 0n;
  for (let d = 0; d < 2 * capacity; d++) {
    bound += ledgerField(b, d, "source_credit", "positive_claim_bound_num");
    freshTotal += ledgerField(b, d, "source_credit", "fresh_reserved_backing_num");
    const ins = ledgerField(b, d, "source_credit", "insurance_credit_reserved_num");
    insuranceAtoms += (ins + BOUND_SCALE - 1n) / BOUND_SCALE;
    earnings += ledgerField(b, d, "backing", "utilization_fee_earnings");
    remaining +=
      get(b, engineAt(Math.floor(d / 2), `insurance_domain_budget_${sideName(d)}`), 16) -
      get(b, engineAt(Math.floor(d / 2), `insurance_domain_spent_${sideName(d)}`), 16);
  }
  const clamp = (v: bigint) => (v > U128_MAX ? U128_MAX : v);
  const freshAtoms = freshTotal / BOUND_SCALE;
  const insurance = insuranceAtoms + remaining + BigInt(rng.int(1_000_000));
  const cTot = rng.chance(30) ? 0n : BigInt(rng.int(1_000_000_000));
  const senior = cTot + insurance + earnings + freshAtoms;
  const vault = senior > MAX_VAULT_TVL ? senior : senior + (rng.chance(50) ? 0n : wide(rng, MAX_VAULT_TVL - senior));
  put(b, groupAt("vault"), 16, clamp(vault));
  put(b, groupAt("insurance"), 16, clamp(insurance));
  put(b, groupAt("c_tot"), 16, cTot);
  put(b, groupAt("backing_provider_earnings_total"), 16, clamp(earnings));
  put(b, groupAt("source_claim_bound_total_num"), 16, clamp(bound));
  put(b, groupAt("source_fresh_backing_total_num"), 16, clamp(freshTotal));
  put(b, groupAt("source_insurance_credit_reserved_total_atoms"), 16, clamp(insuranceAtoms));
  put(b, groupAt("insurance_domain_budget_remaining_total"), 16, clamp(remaining));
  const boundTot = clamp(bound + (rng.chance(50) ? 0n : wide(rng, 1_000_000n * BOUND_SCALE)));
  put(b, groupAt("pnl_pos_bound_tot_num"), 16, boundTot);
  put(b, groupAt("pnl_pos_bound_tot"), 16, (boundTot + BOUND_SCALE - 1n) / BOUND_SCALE);
  const pos = boundTot / BOUND_SCALE;
  put(b, groupAt("pnl_pos_tot"), 16, pos);
  put(b, groupAt("pnl_matured_pos_tot"), 16, wide(rng, pos));
  put(b, groupAt("risk_epoch"), 8, rng.chance(3) ? U64_MAX - BigInt(rng.int(2)) : BigInt(rng.int(1_000_000)));
  put(b, groupAt("next_market_id"), 8, BigInt(capacity + 1));
  put(b, groupAt("current_slot"), 8, now);
  put(b, groupAt("slot_last"), 8, now - BigInt(rng.int(100)));
  const mode = rng.int(100) < 70 ? 0 : rng.int(100) < 85 ? 1 : rng.chance(80) ? 2 : 3;
  put(b, groupAt("mode"), 1, BigInt(mode));
  if (mode === 1) put(b, groupAt("resolved_slot"), 8, rng.chance(10) ? U64_MAX - BigInt(rng.int(3)) : now - BigInt(rng.int(2000)));
  if (rng.chance(30)) {
    put(b, groupAt("payout_snapshot_captured"), 1, 1n);
    const ledger = structBytes(rng, "ResolvedPayoutLedger", pool);
    ledger.copy(b, groupAt("resolved_payout_ledger"));
    put(b, groupAt("resolved_payout_ledger.payout_halted"), 1, BigInt(rng.int(2)));
    put(b, groupAt("resolved_payout_ledger.finalized"), 1, BigInt(rng.int(2)));
    put(b, groupAt("payout_snapshot"), 16, wide(rng, rng.chance(90) ? 1_000_000_000_000n : U128_MAX));
  }
  // One state in eight: a field broken.
  if (rng.chance(12)) breakOne(rng, b, capacity);
  return { market: b, info: { capacity, configured, now } };
}

/** A deliberate invalidity: a total or an amount one off, a status or rate out of place, a byte that does not decode. */
function breakOne(rng: Rng, b: Buffer, capacity: number): void {
  const d = rng.int(2 * capacity);
  const nudge = (at: number) => put(b, at, 16, (get(b, at, 16) + (rng.chance(50) ? 1n : -1n)) & U128_MAX);
  switch (rng.int(9)) {
    case 0:
      return nudge(
        groupAt(
          rng.pick([
            "source_claim_bound_total_num",
            "source_fresh_backing_total_num",
            "source_insurance_credit_reserved_total_atoms",
            "backing_provider_earnings_total",
          ]),
        ),
      );
    case 1:
      return nudge(
        domainAt(
          d,
          "source_credit",
          rng.pick(["fresh_reserved_backing_num", "provider_receivable_num", "valid_liened_backing_num", "credit_rate_num", "positive_claim_bound_num"]),
        ),
      );
    case 2:
      return nudge(
        domainAt(
          d,
          "backing",
          rng.pick(["fresh_unliened_backing_num", "valid_liened_backing_num", "consumed_liened_backing_num", "impaired_liened_backing_num"]),
        ),
      );
    case 3:
      return nudge(domainAt(d, "insurance_reservation", rng.pick(["insurance_credit_reserved_num", "valid_liened_insurance_num"])));
    case 4:
      return put(b, domainAt(d, "backing", "status"), 1, BigInt(rng.int(5)));
    case 5:
      return put(b, groupAt("payout_snapshot_captured"), 1, 2n);
    case 6:
      return put(b, groupAt("vault"), 16, 0n);
    case 7:
      return put(b, domainAt(d, "source_credit", "credit_rate_num"), 16, CREDIT_RATE_SCALE + 1n);
    default:
      return put(b, engineAt(Math.floor(d / 2), `insurance_domain_spent_${sideName(d)}`), 16, U128_MAX);
  }
}

/**
 * A portfolio's source domains (the bytes `b` of a portfolio account), bound to `market`: some occupied slots (sorted,
 * distinct, of configured domains, their claims within the domain's bound, the lien fields consistent with the
 * domain's bucket and reservation; see portfolioBytes). Returns the sum of their claim bounds and their count.
 */
export function writeSourceDomains(rng: Rng, b: Buffer, market: Buffer, info: MarketInfo): { claims: bigint; count: number } {
  // Domains whose bucket holds backing a lien can sit on (Fresh with valid liened backing, Impaired), drawn more often.
  const lienable = Array.from({ length: 2 * info.configured }, (_, d) => d).filter((d) => {
    const st = ledgerField(market, d, "backing", "status", 1);
    const held = ledgerField(market, d, "backing", st === 3n ? "impaired_liened_backing_num" : "valid_liened_backing_num");
    return (st === 1n || st === 3n) && held >= BOUND_SCALE;
  });
  const domainPick = () => (lienable.length && rng.chance(60) ? rng.pick(lienable) : rng.int(2 * info.configured));
  const domains = [...new Set(Array.from({ length: rng.int(5) }, domainPick))].sort((x, y) => x - y);
  let claims = 0n;
  domains.forEach((d, slot) => {
    const at = (f: string) => sourceDomainAt(slot, f);
    put(b, at("domain"), 4, BigInt(d));
    put(b, at("source_claim_market_id"), 8, ledgerField(market, d, "backing", "market_id", 8) || BigInt(Math.floor(d / 2) + 1));
    const creditBound = ledgerField(market, d, "source_credit", "positive_claim_bound_num");
    const bound = rng.chance(96) ? wide(rng, creditBound) : amount(rng, true);
    put(b, at("source_claim_bound_num"), 16, bound);
    claims += bound;
    // The lien's backing within what the domain holds for liens: a Fresh bucket's valid liened backing, an Impaired
    // one's impaired backing (what reconciliation retires), the reservation's valid liened insurance; each at most its
    // face, so the effective reserve (their atoms) is within the face's. Where the domain holds a whole atom of it,
    // seven slots in ten carry a counterparty lien of at least an atom. Now and then backing unrelated to the bucket,
    // or an effective reserve one off (the proof refuses it).
    const status = ledgerField(market, d, "backing", "status", 1);
    const held =
      status === 1n
        ? ledgerField(market, d, "backing", "valid_liened_backing_num")
        : status === 3n
          ? ledgerField(market, d, "backing", "impaired_liened_backing_num")
          : 0n;
    let liened: bigint;
    let cp: bigint;
    if (held >= BOUND_SCALE && bound >= BOUND_SCALE && rng.chance(70)) {
      const top = (held < bound ? held : bound) / BOUND_SCALE;
      cp = (1n + wide(rng, top - 1n)) * BOUND_SCALE + (rng.chance(50) ? 0n : wide(rng, BOUND_SCALE - 1n));
      if (cp > bound) cp = bound;
      liened = cp + (rng.chance(50) ? 0n : wide(rng, bound - cp));
    } else {
      liened = rng.chance(30) ? 0n : wide(rng, bound);
      cp = wide(rng, liened);
    }
    put(b, at("source_claim_liened_num"), 16, liened);
    put(b, at("source_claim_counterparty_liened_num"), 16, cp);
    put(b, at("source_claim_insurance_liened_num"), 16, liened - cp);
    const insHeld = ledgerField(market, d, "insurance_reservation", "valid_liened_insurance_num");
    const pick = (face: bigint, cap: bigint) => {
      const top = face < cap ? face : cap;
      return align(rng.chance(30) ? top : wide(rng, top));
    };
    let cpBacking = cp === 0n ? 0n : rng.chance(85) ? pick(cp, held) : align(wide(rng, cp));
    if (cp !== 0n && cpBacking === 0n && cp >= BOUND_SCALE && held >= BOUND_SCALE && rng.chance(70)) cpBacking = BOUND_SCALE;
    const insBacking = liened - cp === 0n || rng.chance(30) ? 0n : pick(liened - cp, rng.chance(85) ? insHeld : liened - cp);
    let effective = (cpBacking + insBacking) / BOUND_SCALE;
    put(b, at("source_lien_counterparty_backing_num"), 16, cpBacking);
    put(b, at("source_lien_insurance_backing_num"), 16, insBacking);
    if (rng.chance(5)) effective += 1n;
    put(b, at("source_lien_effective_reserved"), 16, effective);
    const last = info.now - BigInt(rng.int(100_000));
    put(b, at("source_lien_fee_last_slot"), 8, cpBacking === 0n || rng.chance(20) || last < 1n ? 0n : last);
    const impaired = rng.chance(60) ? 0n : wide(rng, bound - liened);
    put(b, at("source_claim_impaired_num"), 16, impaired);
    put(b, at("source_lien_impaired_effective_reserved"), 16, impaired === 0n ? 0n : wide(rng, impaired / BOUND_SCALE));
    // Occupied whatever the claims (an unoccupied slot with a tag is a hidden domain): fee revenue at least.
    put(
      b,
      at("source_lien_capital_at_risk_fee_revenue"),
      16,
      rng.chance(2) ? U128_MAX - BigInt(rng.int(10)) : rng.chance(50) && bound !== 0n ? 0n : BigInt(1 + rng.int(1_000_000)),
    );
    if (rng.chance(10)) put(b, at("source_lien_impaired_capital_at_risk_fee_revenue"), 16, BigInt(rng.int(1000)));
  });
  return { claims, count: domains.length };
}

/**
 * A portfolio account bound to `market`: the provenance of its group, capital and PnL, some occupied source domains
 * (sorted, distinct, of configured domains, their claims within the domain's bound, the lien fields consistent),
 * sometimes a leg or two, and one state in five broken (a slot out of order or duplicated, a lien field off, a
 * hidden leg, a garbage tail).
 */
export function portfolioBytes(rng: Rng, market: Buffer, info: MarketInfo, minLegs = 0): Buffer {
  const b = Buffer.alloc(PORTFOLIO_LEN);
  for (let i = 0; i < 32; i++) b[portfolioAt("provenance_header.market_group_id") + i] = 7 + i;
  for (let i = 0; i < 32; i++) {
    b[portfolioAt("provenance_header.owner") + i] = 3;
    b[portfolioAt("owner") + i] = 3;
  }
  put(b, portfolioAt("provenance_header.version"), 2, 1n);
  put(b, portfolioAt("provenance_header.layout_discriminator"), 2, 18n);
  put(b, portfolioAt("capital"), 16, rng.chance(20) ? 0n : rng.chance(80) ? BigInt(rng.int(1_000_000_000)) : U128_MAX - BigInt(rng.int(3)));
  const { claims, count: held } = writeSourceDomains(rng, b, market, info);
  // A positive PnL within the claims' attribution, or a loss.
  const pnl = rng.chance(40) ? claims / BOUND_SCALE - (rng.chance(80) ? 0n : 1n) : rng.chance(50) ? -BigInt(rng.int(1_000_000)) : 0n;
  put(b, portfolioAt("pnl"), 16, pnl < 0n || claims !== 0n || rng.chance(20) ? pnl : 0n);
  // Legs: none mostly, else one or two on distinct configured assets, bound to their sides' epochs.
  let bitmap = 0n;
  // Legs go on assets that can hold one (Active, DrainOnly or Recovery) nine times in ten.
  const open = Array.from({ length: info.configured }, (_, a) => a).filter((a) => [2n, 3n, 5n].includes(get(market, engineAt(a, "asset.lifecycle"), 1)));
  const assets = open.length && rng.chance(90) ? open : Array.from({ length: info.configured }, (_, a) => a);
  const legs = minLegs === 0 && rng.chance(60) ? 0 : 1 + rng.int(Math.min(2, assets.length));
  const first = rng.int(assets.length);
  for (let slot = 0; slot < 16; slot++) {
    if (slot >= legs) {
      put(b, legAt(slot, "a_basis"), 16, ADL_ONE);
      continue;
    }
    const asset = assets[(first + slot) % assets.length]!;
    const side = rng.int(2);
    const sideN = side === 0 ? "long" : "short";
    const epoch = get(market, engineAt(asset, `asset.epoch_${sideN}`), 8);
    put(b, legAt(slot, "active"), 1, 1n);
    put(b, legAt(slot, "asset_index"), 4, BigInt(asset));
    put(b, legAt(slot, "market_id"), 8, get(market, engineAt(asset, "asset.market_id"), 8));
    put(b, legAt(slot, "side"), 1, BigInt(side));
    const abs = BigInt(1 + rng.int(1_000_000));
    put(b, legAt(slot, "basis_pos_q"), 16, side === 0 ? abs : -abs);
    put(b, legAt(slot, "a_basis"), 16, ADL_ONE);
    put(b, legAt(slot, "loss_weight"), 16, abs * 1000n);
    // K and F snapshots a modest delta from the side's (whole atoms to a few million of them at this basis), the K/F
    // epoch snapshot the side's or older (a stale cohort, counted in the side's stale accounts).
    const signedAt = (path: string) => {
      const v = get(market, engineAt(asset, path), 16);
      return v >> 127n ? v - (1n << 128n) : v;
    };
    const clampI = (v: bigint) => (v > (1n << 127n) - 1n ? (1n << 127n) - 1n : v < -(1n << 127n) + 1n ? -(1n << 127n) + 1n : v);
    const kfStep = () => (rng.chance(20) ? 0n : (rng.chance(50) ? 1n : -1n) * wide(rng, rng.chance(80) ? 10n ** 24n : 10n ** 30n));
    put(b, legAt(slot, "k_snap"), 16, clampI(signedAt(`asset.k_${sideN}`) - kfStep()));
    put(b, legAt(slot, "f_snap"), 16, clampI(signedAt(`asset.f_${sideN}_num`) - kfStep()));
    const kfEpoch = get(market, engineAt(asset, `asset.kf_epoch_${sideN}`), 8);
    put(b, legAt(slot, "kf_epoch_snap"), 8, rng.chance(60) || kfEpoch === 0n ? kfEpoch : kfEpoch - 1n - wide(rng, kfEpoch - 1n));
    put(b, legAt(slot, "epoch_snap"), 8, epoch);
    put(b, legAt(slot, "b_epoch_snap"), 8, epoch);
    put(b, legAt(slot, "b_rem"), 16, wide(rng, SOCIAL_LOSS_DEN - 1n));
    // The B snapshot at the side's B index or a little behind it (a chunk or a few of B loss to settle).
    const bNow = get(market, engineAt(asset, `asset.b_${sideN}_num`), 16);
    const bStep = rng.chance(30) ? 0n : wide(rng, rng.chance(70) ? 10n ** 18n : 10n ** 24n);
    put(b, legAt(slot, "b_snap"), 16, rng.chance(5) && bNow < U128_MAX ? bNow + 1n : bNow > bStep ? bNow - bStep : rng.chance(50) ? 0n : bNow);
    put(b, legAt(slot, "b_stale"), 1, BigInt(rng.chance(30) ? 1 : 0));
    bitmap |= 1n << BigInt(slot);
  }
  // One leg now and then in a later slot; the account's B-stale mark (its market count around it); reserved PnL (a
  // Resolved market attributes only the unreserved part to claims); counters near their limits.
  if (legs === 1 && rng.chance(20)) {
    const k = 1 + rng.int(15);
    b.copy(b, legAt(k, "active"), legAt(0, "active"), legAt(0, "active") + sizeOf("PortfolioLeg"));
    b.fill(0, legAt(0, "active"), legAt(0, "active") + sizeOf("PortfolioLeg"));
    put(b, legAt(0, "a_basis"), 16, ADL_ONE);
    bitmap = 1n << BigInt(k);
  }
  put(b, portfolioAt("active_bitmap"), 8, bitmap);
  if (rng.chance(30)) put(b, portfolioAt("b_stale_state"), 1, 1n);
  put(market, groupAt("b_stale_account_count"), 8, BigInt(rng.chance(20) ? 0 : 1 + rng.int(5)));
  const finalPnl = get(b, portfolioAt("pnl"), 16);
  if (finalPnl !== 0n && finalPnl >> 127n === 0n && rng.chance(30)) put(b, portfolioAt("reserved_pnl"), 16, rng.chance(50) ? finalPnl : wide(rng, finalPnl));
  if (rng.chance(3)) put(b, portfolioAt("residual_crystallized_loss_atoms_total"), 16, U128_MAX - BigInt(rng.int(1000)));
  if (rng.chance(12)) {
    switch (rng.int(5)) {
      case 0:
        if (held > 1) put(b, sourceDomainAt(0, "domain"), 4, get(b, sourceDomainAt(held - 1, "domain"), 4));
        break;
      case 1:
        put(b, sourceDomainAt(rng.int(4), "source_claim_liened_num"), 16, BigInt(rng.int(1000)));
        break;
      case 2:
        put(b, portfolioAt("active_bitmap"), 8, bitmap ^ (1n << BigInt(rng.int(3))));
        break;
      case 3:
        put(b, sourceDomainAt(20 + rng.int(12), "source_claim_bound_num"), 16, BigInt(1 + rng.int(1000)));
        break;
      default:
        put(b, sourceDomainAt(held, "domain"), 4, BigInt(1 + rng.int(2 * info.configured)));
    }
  }
  return b;
}

/** One function of the table: id, the engine's name, whether it takes a portfolio, how its arguments are drawn. */
interface Primitive {
  id: number;
  name: string;
  portfolio?: boolean;
  args: (rng: Rng, m: Buffer, p: Buffer, info: MarketInfo) => bigint[];
}

/** A domain argument: a configured one mostly, at the edges or far out now and then. */
function domainArg(rng: Rng, info: MarketInfo): number {
  const r = rng.int(20);
  if (r < 16) return rng.int(2 * info.configured);
  if (r < 18) return 2 * info.configured + rng.int(2);
  return r < 19 ? 2 * info.capacity : rng.int(1 << 20);
}
const assetArg = (rng: Rng, info: MarketInfo) => (rng.chance(90) ? rng.int(info.configured) : info.configured + rng.int(3));
const sideArg = (rng: Rng) => BigInt(rng.chance(95) ? rng.int(2) : 2);

/** A value near `ref`: itself, one either side, a part of it, zero, an atom multiple, or unrelated. */
function near(rng: Rng, ref: bigint): bigint {
  const v = rng.pick([ref, ref, ref + 1n, ref - 1n, wide(rng, ref), 0n, align(wide(rng, ref)), BOUND_SCALE, amount(rng, true)]);
  return v < 0n ? 0n : v > U128_MAX ? U128_MAX : v;
}

/** The portfolio's slots that hold something (their domain byte nonzero or a claim). */
function heldSlots(p: Buffer): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < 6; slot++)
    if (get(p, sourceDomainAt(slot, "source_claim_bound_num"), 16) !== 0n || get(p, sourceDomainAt(slot, "source_lien_capital_at_risk_fee_revenue"), 16) !== 0n)
      out.push(slot);
  return out;
}
/** A domain the portfolio holds (most of the time), else any domain argument. */
function heldDomain(rng: Rng, p: Buffer, info: MarketInfo): number {
  const held = heldSlots(p);
  if (held.length && rng.chance(80)) return Number(get(p, sourceDomainAt(rng.pick(held), "domain"), 4));
  return domainArg(rng, info);
}
/** A domain whose bucket is Fresh and not expired (most of the time, where there is one), else any domain argument. */
function liveFreshDomain(rng: Rng, m: Buffer, info: MarketInfo): number {
  const now = get(m, groupAt("current_slot"), 8);
  const live = Array.from({ length: 2 * info.configured }, (_, d) => d).filter(
    (d) => ledgerField(m, d, "backing", "status", 1) === 1n && ledgerField(m, d, "backing", "expiry_slot", 8) > now,
  );
  return live.length && rng.chance(80) ? rng.pick(live) : domainArg(rng, info);
}
/** The portfolio's slots with counterparty lien backing. */
function lienSlots(p: Buffer): number[] {
  return heldSlots(p).filter((slot) => get(p, sourceDomainAt(slot, "source_lien_counterparty_backing_num"), 16) !== 0n);
}
/** A domain the portfolio holds a counterparty lien on (most of the time), else as `heldDomain`. */
function lienDomain(rng: Rng, p: Buffer, info: MarketInfo): number {
  const liens = lienSlots(p);
  if (liens.length && rng.chance(85)) return Number(get(p, sourceDomainAt(rng.pick(liens), "domain"), 4));
  return heldDomain(rng, p, info);
}
/** A slot with a counterparty lien (most of the time), else as `heldSlot`. */
function lienSlot(rng: Rng, p: Buffer): number {
  const liens = lienSlots(p);
  if (liens.length && rng.chance(85)) return rng.pick(liens);
  return heldSlot(rng, p);
}
/** A portfolio slot's field (zero past the domains). */
function slotField(p: Buffer, slot: number, f: string): bigint {
  return slot < 32 ? get(p, sourceDomainAt(slot, f), 16) : 0n;
}
/** The domain of a portfolio slot most of the time, else any domain argument. */
function slotDomain(rng: Rng, p: Buffer, slot: number, info: MarketInfo): number {
  return slot < 32 && rng.chance(90) ? Number(get(p, sourceDomainAt(slot, "domain"), 4)) : domainArg(rng, info);
}
/** The claim bounds of the portfolio's slots. */
function claimSum(p: Buffer): bigint {
  let sum = 0n;
  for (let slot = 0; slot < 32; slot++) sum += get(p, sourceDomainAt(slot, "source_claim_bound_num"), 16);
  return sum;
}
/** An amount in atoms near a bound number's. */
function atomsNear(rng: Rng, bound: bigint): bigint {
  return rng.pick([
    bound / BOUND_SCALE,
    wide(rng, bound / BOUND_SCALE),
    BigInt(1 + rng.int(10)),
    (bound + BOUND_SCALE - 1n) / BOUND_SCALE,
    0n,
    amount(rng, false) / BOUND_SCALE,
  ]);
}
/** The portfolio's PnL (signed). */
function pnlOf(p: Buffer): bigint {
  const v = get(p, portfolioAt("pnl"), 16);
  return v >> 127n ? v - (1n << 128n) : v;
}
/** A new PnL near the portfolio's: lower (`dir` −1), higher (1) or either, across zero now and then, at the limits. */
function pnlNear(rng: Rng, p: Buffer, dir = 0): bigint {
  const pnl = pnlOf(p);
  const step = rng.pick([1n, BigInt(1 + rng.int(1000)), pnl < 0n ? -pnl : pnl, wide(rng, pnl < 0n ? -pnl : pnl), BigInt(rng.int(1_000_000_000))]);
  const d = dir !== 0 ? dir : rng.chance(50) ? 1 : -1;
  if (rng.chance(4)) return rng.pick([-(1n << 127n), (1n << 127n) - 1n, -(1n << 127n) + 1n, 0n]);
  if (rng.chance(10)) return 0n;
  return d > 0 ? pnl + step : pnl - step;
}
/** A preburned claim for moving the PnL to `pnl`: the decrease of its positive part as a bound number. */
function preburnFor(p: Buffer, pnl: bigint): bigint {
  const oldPos = pnlOf(p) > 0n ? pnlOf(p) : 0n;
  const newPos = pnl > 0n ? pnl : 0n;
  return oldPos > newPos ? (oldPos - newPos) * BOUND_SCALE : 0n;
}
/** A K/F loss payment's arguments (present, the loss's domain, its side's code, the atoms consumed so far), the loss
 * owed to another domain than `face` most of the time: its twin, the other asset's, now and then itself. */
function kfArgs(rng: Rng, _m: Buffer, face: number, info: MarketInfo): bigint[] {
  if (rng.chance(40)) return [0n, 0n, 0n, 0n];
  const loss = rng.chance(15) ? face : rng.chance(50) ? face ^ 1 : rng.int(2 * info.configured);
  return [1n, BigInt(loss), BigInt(rng.pick([0, 0, 0, 1, 2])), rng.chance(70) ? 0n : BigInt(rng.int(1_000_000))];
}
/** A side whose effective OI is gone with stored positions left, nothing pending and no reset under way (what a
 * full-drain reset needs); the counts it moves stay small. */
function exhaust(rng: Rng, m: Buffer, asset: number, side: string): void {
  put(m, engineAt(asset, `asset.oi_eff_${side}_q`), 16, 0n);
  put(m, engineAt(asset, `asset.pending_obligation_count_${side}`), 8, 0n);
  put(m, engineAt(asset, `asset.mode_${side}`), 1, 0n);
  if (rng.chance(80)) put(m, engineAt(asset, `asset.stored_pos_count_${side}`), 8, BigInt(1 + rng.int(3)));
}
/** A leg slot (an active one mostly) and the normalization flag; now and then the leg's side exhausted. */
function legArgs(rng: Rng, m: Buffer, p: Buffer): bigint[] {
  const slot = rng.chance(90) ? rng.int(2) : rng.int(17);
  if (slot < 16 && get(p, legAt(slot, "active"), 1) === 1n && rng.chance(25)) {
    const asset = Number(get(p, legAt(slot, "asset_index"), 4));
    exhaust(rng, m, asset, get(p, legAt(slot, "side"), 1) === 1n ? "short" : "long");
  }
  return [BigInt(slot), BigInt(rng.int(2))];
}
/** The asset of an active leg (most of the time) and that leg's slot, else any asset and slot. */
function legAsset(rng: Rng, p: Buffer, info: MarketInfo): bigint[] {
  const active = Array.from({ length: 16 }, (_, s) => s).filter((s) => get(p, legAt(s, "active"), 1) === 1n);
  if (active.length && rng.chance(85)) {
    const s = rng.pick(active);
    return [get(p, legAt(s, "asset_index"), 4), BigInt(s)];
  }
  return [BigInt(assetArg(rng, info)), BigInt(rng.int(16))];
}
/** A B loss budget: the config's public chunk mostly, small or none now and then. */
function bBudget(rng: Rng, m: Buffer): bigint {
  return rng.pick([
    get(m, groupAt("config.public_b_chunk_atoms"), 16),
    get(m, groupAt("config.public_b_chunk_atoms"), 16),
    BigInt(rng.int(1000)),
    0n,
    U128_MAX >> 1n,
  ]);
}
/** A loss's domain: the twin of a domain the portfolio holds (so that the twin's face nets), a held one, or any. */
function lossDomain(rng: Rng, p: Buffer, info: MarketInfo): number {
  const d = heldDomain(rng, p, info);
  return rng.chance(50) ? d ^ 1 : d;
}
/** A loss in atoms near the portfolio's positive PnL or capital. */
function lossNear(rng: Rng, p: Buffer): bigint {
  const pnl = pnlOf(p);
  const pos = pnl > 0n ? pnl : 0n;
  const v = rng.pick([
    pos,
    wide(rng, pos),
    pos + BigInt(rng.int(1000)),
    BigInt(1 + rng.int(1000)),
    get(p, portfolioAt("capital"), 16),
    BigInt(rng.int(1_000_000_000)),
    0n,
  ]);
  return v > (1n << 127n) - 1n ? (1n << 127n) - 1n : v;
}
/** A slot the portfolio holds, now and then one past them or past the domains. */
function heldSlot(rng: Rng, p: Buffer): number {
  const held = heldSlots(p);
  if (held.length && rng.chance(85)) return rng.pick(held);
  return rng.chance(80) ? rng.int(6) : 32;
}

const d1 = (f: (rng: Rng, m: Buffer, d: number, info: MarketInfo) => bigint[]) => (rng: Rng, m: Buffer, _p: Buffer, info: MarketInfo) => {
  const d = domainArg(rng, info);
  return [BigInt(d), ...f(rng, m, d, info)];
};
const domainOnly = d1(() => []);
const field = (m: Buffer, d: number, s: string, f: string) => ledgerField(m, d, s, f);
const budgetOf = (m: Buffer, d: number) =>
  MARKET.slots + Math.floor(d / 2) * SLOT_LEN + SLOT_LEN > m.length ? 0n : get(m, engineAt(Math.floor(d / 2), `insurance_domain_budget_${sideName(d)}`), 16);

export const PRIMITIVES: Primitive[] = [
  { id: 0, name: "domain_asset_side", args: domainOnly },
  { id: 1, name: "insurance_domain_index", args: (rng, _m, _p, i) => [BigInt(assetArg(rng, i)), sideArg(rng)] },
  { id: 2, name: "source_credit_for_domain", args: domainOnly },
  { id: 3, name: "source_credit_for_domain_shape", args: domainOnly },
  { id: 4, name: "stored_source_credit_rate_num", args: domainOnly },
  { id: 5, name: "provider_principal_num", args: domainOnly },
  { id: 6, name: "loser_paid_backing_num", args: domainOnly },
  { id: 7, name: "backing_bucket_for_domain (effective expiry)", args: domainOnly },
  { id: 8, name: "backing_bucket_raw_status_expiry_for_domain", args: domainOnly },
  { id: 9, name: "insurance_reservation_for_domain", args: domainOnly },
  { id: 10, name: "fresh_counterparty_backing_expiry_slot", args: domainOnly },
  { id: 11, name: "domain_insurance_budget_spent", args: domainOnly },
  { id: 12, name: "residual, junior_claim_bound, backing_provider_earnings_total, source_fresh_backing_total_atoms", args: () => [] },
  {
    id: 13,
    name: "domain_budget_remaining_parts",
    args: (rng) => {
      const s = amount(rng, true);
      return [near(rng, s), s];
    },
  },
  {
    id: 15,
    name: "set_source_credit_for_domain (update_source_credit_aggregate_totals)",
    args: d1((rng, m, d) => [
      near(rng, field(m, d, "source_credit", "positive_claim_bound_num")),
      near(rng, field(m, d, "source_credit", "insurance_credit_reserved_num")),
      near(rng, field(m, d, "source_credit", "fresh_reserved_backing_num")),
    ]),
  },
  {
    id: 16,
    name: "set_backing_bucket_for_domain (update_backing_aggregate_totals)",
    args: d1((rng, m, d) => [near(rng, field(m, d, "backing", "utilization_fee_earnings"))]),
  },
  { id: 17, name: "set_insurance_reservation_for_domain", args: d1((rng) => [amount(rng, true)]) },
  { id: 18, name: "adjust_provider_principal_num", args: d1((rng) => [rng.chance(10) ? U128_MAX : amount(rng, false), BigInt(rng.int(2))]) },
  {
    id: 19,
    name: "release_provider_principal_after",
    args: d1((rng, m, d) => {
      const f = field(m, d, "source_credit", "fresh_reserved_backing_num");
      return [near(rng, f), near(rng, f)];
    }),
  },
  {
    id: 20,
    name: "set_domain_insurance_spent_delta",
    args: (rng) => {
      const budget = amount(rng, true);
      const ins = amount(rng, true);
      return [near(rng, ins), ins, budget, near(rng, budget), near(rng, budget)];
    },
  },
  { id: 21, name: "set_domain_insurance_spent_core", args: d1((rng, m, d) => [near(rng, budgetOf(m, d))]) },
  { id: 22, name: "validate_source_domain_ledger", args: domainOnly },
  { id: 23, name: "validate_source_domain_ledger_current", args: domainOnly },
  { id: 24, name: "recompute_source_credit_domain_after_mutation", args: domainOnly },
  { id: 25, name: "recompute_source_credit_domain_after_mutations", args: d1((rng) => [rng.pick([0n, 1n, 2n, BigInt(rng.int(100)), U64_MAX])]) },
  { id: 26, name: "refresh_source_credit_domain_after_mutation", args: domainOnly },
  { id: 27, name: "reservation_encumbrance_proof_for_domain + validate", args: domainOnly },
  { id: 28, name: "reservation_encumbrance_proof_for_domain_parts + validate", args: domainOnly },
  ...[29, 30, 31, 32].map((id) => ({
    id,
    name: [
      "add_fresh_counterparty_backing_unchecked",
      "add_fresh_counterparty_backing_steps_unchecked",
      "add_loser_paid_counterparty_backing_unchecked",
      "add_loser_paid_counterparty_backing_payments_unchecked",
    ][id - 29]!,
    args: d1((rng, m, d, info) => {
      const expiry = field(m, d, "backing", "expiry_slot") & U64_MAX;
      return [
        rng.chance(80) ? amount(rng, true) || BOUND_SCALE : near(rng, field(m, d, "source_credit", "provider_receivable_num")),
        rng.chance(60) ? (expiry > info.now ? expiry : info.now + 1n + BigInt(rng.int(1000))) : rng.pick([expiry, info.now, 0n, U64_MAX]),
        BigInt(rng.pick([1, 1, 2, 3, 0])),
      ];
    }),
  })),
  {
    id: 33,
    name: "expire_source_backing_bucket_not_atomic",
    args: d1((rng, m, d, info) => {
      const expiry = field(m, d, "backing", "expiry_slot") & U64_MAX;
      return [rng.pick([info.now, expiry, expiry + BigInt(rng.int(2000)), expiry > info.now ? expiry : info.now, BigInt(rng.int(1000))])];
    }),
  },
  { id: 34, name: "credit_post_snapshot_residual_not_atomic", args: (rng) => [rng.pick([0n, BigInt(1 + rng.int(1_000_000)), amount(rng, false), U128_MAX])] },
  {
    id: 35,
    name: "release_source_credit_lien_from_counterparty_terminal_not_atomic",
    args: d1((rng, m, d) => [near(rng, field(m, d, "backing", "valid_liened_backing_num"))]),
  },
  {
    id: 36,
    name: "consume_source_credit_lien_from_counterparty_core_not_atomic",
    args: d1((rng, m, d) => [near(rng, field(m, d, "backing", "valid_liened_backing_num"))]),
  },
  {
    id: 37,
    name: "release_source_credit_lien_from_insurance_core_not_atomic",
    args: d1((rng, m, d) => [near(rng, field(m, d, "insurance_reservation", "valid_liened_insurance_num"))]),
  },
  {
    id: 38,
    name: "release_source_credit_lien_from_insurance_terminal_not_atomic",
    args: d1((rng, m, d) => [near(rng, field(m, d, "insurance_reservation", "insurance_credit_reserved_num"))]),
  },
  {
    id: 39,
    name: "create_and_consume_source_credit_from_counterparty_core_not_atomic",
    args: d1((rng, m, d) => [near(rng, field(m, d, "backing", "fresh_unliened_backing_num"))]),
  },
  {
    id: 40,
    name: "create_and_consume_source_credit_from_counterparty_parts_not_atomic",
    args: d1((rng, m, d) => [
      near(rng, field(m, d, "backing", "fresh_unliened_backing_num")),
      rng.chance(40) ? 0n : near(rng, field(m, d, "source_credit", "positive_claim_bound_num")),
    ]),
  },
  {
    id: 41,
    name: "create_and_consume_source_credit_from_insurance_core_not_atomic",
    args: d1((rng, m, d) => [align(near(rng, field(m, d, "insurance_reservation", "insurance_credit_reserved_num")))]),
  },
  {
    id: 42,
    name: "create_and_consume_source_credit_from_insurance_parts_not_atomic",
    args: d1((rng, m, d) => [
      rng.chance(80) ? align(near(rng, field(m, d, "insurance_reservation", "insurance_credit_reserved_num") / 2n)) : near(rng, BOUND_SCALE),
      rng.chance(40) ? 0n : near(rng, field(m, d, "source_credit", "positive_claim_bound_num")),
    ]),
  },
  {
    id: 43,
    name: "TokenValueFlowProofV16::validate_insurance_to_close_insurance_spent",
    args: (rng) => {
      const v = amount(rng, true);
      return [amount(rng, false), v, rng.chance(80) ? v : near(rng, v)];
    },
  },
  { id: 44, name: "source_credit_available_backing_num", args: domainOnly },
  {
    id: 45,
    name: "face_claim_to_burn_for_support",
    args: (rng) => {
      const j = amount(rng, false);
      return [rng.chance(10) ? 0n : amount(rng, false), rng.chance(10) ? 0n : near(rng, j), j];
    },
  },
  {
    id: 46,
    name: "twin_loser_paid_share_num",
    args: d1((rng, m, d) => [amount(rng, false), near(rng, field(m, d, "source_credit", "fresh_reserved_backing_num"))]),
  },
  { id: 47, name: "loss_bucket_accepts_fresh", args: domainOnly },
  { id: 48, name: "resolved_loss_backing_capacity_num", args: domainOnly },
  { id: 49, name: "pending_domain_loss_barrier_count, has_pending_domain_loss_barrier", args: (rng, _m, _p, i) => [BigInt(assetArg(rng, i)), sideArg(rng)] },
  {
    id: 50,
    name: "kf_loss_lien_backing_to_consume_num",
    args: (rng, m, _p, info) => {
      const face = domainArg(rng, info);
      const loss = rng.chance(20) ? face : rng.chance(50) ? face ^ 1 : domainArg(rng, info);
      const release = near(rng, field(m, face, "backing", "valid_liened_backing_num"));
      return [BigInt(face), BigInt(loss), BigInt(rng.pick([0, 0, 1, 2, 3])), amount(rng, true), near(rng, release), release];
    },
  },
  {
    id: 51,
    name: "add_account_u128_counter",
    args: (rng) => {
      const c = amount(rng, false);
      return [c, rng.chance(10) ? U128_MAX - c + BigInt(rng.int(2)) : amount(rng, false)];
    },
  },
  { id: 52, name: "PortfolioV16View::source_domain_slot", portfolio: true, args: domainOnly },
  {
    id: 53,
    name: "PortfolioV16ViewMut::source_domain_slot",
    portfolio: true,
    args: (rng, m, p, i) => [rng.chance(5) ? (1n << 32n) + BigInt(rng.int(4)) : BigInt(domainArg(rng, i))],
  },
  { id: 54, name: "PortfolioV16ViewMut::source_domain_slot_or_insert", portfolio: true, args: domainOnly },
  {
    id: 55,
    name: "PortfolioV16ViewMut::reset_source_domain_slot_if_empty",
    portfolio: true,
    args: (rng) => [BigInt(rng.chance(90) ? rng.int(8) : 30 + rng.int(4))],
  },
  { id: 56, name: "account_source_claim_bound_sum_num, account_has_source_claims", portfolio: true, args: () => [] },
  { id: 57, name: "source_claim_unliened_num", portfolio: true, args: (rng, _m, p, i) => [BigInt(heldDomain(rng, p, i))] },
  { id: 58, name: "slot_unliened_claim_num", portfolio: true, args: (rng) => [BigInt(rng.int(6))] },
  { id: 59, name: "PortfolioSourceDomainV16Account::is_sparse_tail_default", portfolio: true, args: (rng) => [BigInt(rng.int(8))] },
  { id: 60, name: "has_b_stale_leg", portfolio: true, args: () => [] },
  { id: 61, name: "active_leg_slot_for_asset", portfolio: true, args: (rng, _m, _p, i) => [BigInt(assetArg(rng, i))] },
  { id: 62, name: "require_active_leg_slot_for_asset", portfolio: true, args: (rng, _m, _p, i) => [BigInt(assetArg(rng, i))] },
  { id: 63, name: "active_leg_for_asset", portfolio: true, args: (rng, _m, _p, i) => [BigInt(assetArg(rng, i))] },
  { id: 64, name: "asset_state", args: (rng, _m, _p, i) => [BigInt(assetArg(rng, i))] },
  { id: 65, name: "CloseProgressLedgerV16::has_pending_residual", portfolio: true, args: () => [] },
  {
    id: 66,
    name: "ensure_account_source_claim_market_id",
    portfolio: true,
    args: (rng, _m, p, i) => [BigInt(rng.chance(50) ? heldDomain(rng, p, i) : domainArg(rng, i))],
  },
  { id: 67, name: "collect_account_backing_utilization_fee_for_domain_not_atomic", portfolio: true, args: (rng, _m, p, i) => [BigInt(lienDomain(rng, p, i))] },
  { id: 69, name: "V16Core::prepare_account_counterparty_lien_impairment", portfolio: true, args: (rng) => [BigInt(rng.int(6))] },
  {
    id: 70,
    name: "V16Core::prepare_counterparty_impaired_lien_retirement_delta",
    args: d1((rng, m, d) => [
      rng.chance(70)
        ? align(near(rng, field(m, d, "backing", "impaired_liened_backing_num")))
        : near(rng, field(m, d, "backing", "impaired_liened_backing_num")),
    ]),
  },
  {
    id: 71,
    name: "retire_source_credit_lien_from_counterparty_impaired_not_atomic",
    args: d1((rng, m, d) => [align(near(rng, field(m, d, "backing", "impaired_liened_backing_num")))]),
  },
  {
    id: 72,
    name: "release_or_retire_counterparty_lien_backing_not_atomic",
    args: d1((rng, m, d) => [align(near(rng, field(m, d, "backing", rng.chance(50) ? "impaired_liened_backing_num" : "valid_liened_backing_num")))]),
  },
  {
    id: 73,
    name: "burn_impaired_account_source_claim_fields",
    portfolio: true,
    args: (rng, _m, p) => {
      const slot = heldSlot(rng, p);
      return [BigInt(slot), near(rng, slot < 32 ? get(p, sourceDomainAt(slot, "source_claim_impaired_num"), 16) : 1n)];
    },
  },
  { id: 74, name: "impair_account_source_credit_counterparty_lien_fields", portfolio: true, args: (rng, _m, p, i) => [BigInt(lienDomain(rng, p, i))] },
  { id: 75, name: "reconcile_account_impaired_counterparty_lien_at_slot_not_atomic", portfolio: true, args: (rng, _m, p) => [BigInt(lienSlot(rng, p))] },
  { id: 76, name: "reconcile_account_impaired_counterparty_liens_not_atomic", portfolio: true, args: () => [] },
  // Layer 4: the source-claim burns and the PnL setters.
  {
    id: 77,
    name: "decrement_account_source_claim_for_domain_not_atomic",
    portfolio: true,
    args: (rng, _m, p, i) => {
      const slot = heldSlot(rng, p);
      return [
        BigInt(slot),
        BigInt(slotDomain(rng, p, slot, i)),
        near(rng, slotField(p, slot, rng.chance(50) ? "source_claim_bound_num" : "source_claim_liened_num")),
      ];
    },
  },
  {
    id: 78,
    name: "burn_account_source_lien_face_not_atomic",
    portfolio: true,
    args: (rng, m, p, i) => {
      const slot = lienSlot(rng, p);
      const d = slotDomain(rng, p, slot, i);
      return [BigInt(slot), BigInt(d), near(rng, slotField(p, slot, "source_claim_liened_num")), 0n, ...kfArgs(rng, m, d, i)];
    },
  },
  {
    id: 79,
    name: "burn_account_source_claim_at_slot_up_to",
    portfolio: true,
    args: (rng, m, p, i) => {
      const slot = rng.chance(60) ? lienSlot(rng, p) : heldSlot(rng, p);
      const d = slotDomain(rng, p, slot, i);
      return [BigInt(slot), BigInt(d), near(rng, slotField(p, slot, "source_claim_bound_num")), 0n, ...kfArgs(rng, m, d, i)];
    },
  },
  {
    id: 80,
    name: "burn_account_source_claim_bound_num",
    portfolio: true,
    args: (rng, m, p, i) => [near(rng, claimSum(p)), 0n, 0n, 0n, ...kfArgs(rng, m, heldDomain(rng, p, i), i)],
  },
  {
    id: 81,
    name: "burn_account_source_claim_bound_num_domain_first",
    portfolio: true,
    args: (rng, _m, p, i) => [BigInt(heldDomain(rng, p, i)), near(rng, rng.chance(50) ? claimSum(p) : wide(rng, claimSum(p)))],
  },
  {
    id: 82,
    name: "source_domain_prospective_support_for_face",
    args: (rng, m, _p, i) => {
      const d = liveFreshDomain(rng, m, i);
      return [BigInt(d), rng.pick([BigInt(1 + rng.int(1000)), field(m, d, "backing", "fresh_unliened_backing_num") / BOUND_SCALE, amount(rng, false)])];
    },
  },
  {
    id: 83,
    name: "consume_source_domain_credit_for_effective_not_atomic",
    args: (rng, m, _p, i) => {
      const d = liveFreshDomain(rng, m, i);
      return [
        BigInt(d),
        atomsNear(
          rng,
          rng.chance(60) ? field(m, d, "backing", "fresh_unliened_backing_num") : field(m, d, "insurance_reservation", "insurance_credit_reserved_num"),
        ),
      ];
    },
  },
  {
    id: 84,
    name: "consume_validated_account_source_credit_not_atomic",
    portfolio: true,
    args: (rng, _m, p) => [atomsNear(rng, claimSum(p)), BigInt(rng.int(2)), BigInt(rng.int(2))],
  },
  { id: 85, name: "set_account_pnl", portfolio: true, args: (rng, _m, p) => [pnlNear(rng, p)] },
  {
    id: 86,
    name: "set_account_pnl_with_source",
    portfolio: true,
    args: (rng, _m, p, i) => [pnlNear(rng, p, 1), BigInt(rng.chance(50) ? heldDomain(rng, p, i) : domainArg(rng, i))],
  },
  {
    id: 87,
    name: "set_account_pnl_after_source_claim_burn",
    portfolio: true,
    args: (rng, _m, p) => {
      const pnl = pnlNear(rng, p, -1);
      return [pnl, rng.chance(50) ? 0n : near(rng, preburnFor(p, pnl))];
    },
  },
  {
    id: 88,
    name: "set_account_pnl_after_kf_loss_claim_burn",
    portfolio: true,
    args: (rng, m, p, i) => {
      const pnl = pnlNear(rng, p, -1);
      return [pnl, rng.chance(60) ? 0n : near(rng, preburnFor(p, pnl)), 0n, 0n, ...kfArgs(rng, m, heldDomain(rng, p, i), i)];
    },
  },
  {
    id: 89,
    name: "set_account_pnl_after_domain_first_source_claim_burn",
    portfolio: true,
    args: (rng, _m, p, i) => [pnlNear(rng, p, -1), BigInt(heldDomain(rng, p, i))],
  },
  // Layer 5: the K/F settlement entries.
  {
    id: 90,
    name: "record_account_funding_flow",
    portfolio: true,
    args: (rng) => [
      BigInt(rng.int(2)),
      rng.pick([0n, BigInt(rng.int(1_000_000)), -BigInt(rng.int(1_000_000)), (1n << 127n) - 1n, -(1n << 127n) + 1n, -wide(rng, 1n << 100n)]),
    ],
  },
  { id: 91, name: "settle_kf_loss_before_support_not_atomic", portfolio: true, args: (rng, _m, p, i) => [BigInt(lossDomain(rng, p, i)), lossNear(rng, p)] },
  {
    id: 92,
    name: "net_slot_face_at_par_not_atomic",
    portfolio: true,
    args: (rng, _m, p, i) => {
      const slot = heldSlot(rng, p);
      const pnl = pnlOf(p);
      const face = rng.chance(80) && pnl > 0n ? pnl : amount(rng, true) / BOUND_SCALE;
      return [
        BigInt(slot),
        BigInt(rng.chance(30) ? slotDomain(rng, p, slot, i) : lossDomain(rng, p, i)),
        BigInt(rng.int(2)),
        BigInt(rng.int(2)),
        face,
        lossNear(rng, p),
        rng.chance(70) ? U64_MAX : BigInt(rng.int(1 << 30)),
      ];
    },
  },
  {
    id: 93,
    name: "cancel_loss_domain_face_at_par_not_atomic",
    portfolio: true,
    args: (rng, _m, p) => {
      const slot = heldSlot(rng, p);
      const atoms = slotField(p, slot, "source_claim_bound_num") / BOUND_SCALE;
      return [BigInt(slot), rng.chance(70) ? atoms || 1n : BigInt(1 + rng.int(1000)), 0n, 0n, atoms + BigInt(rng.int(10)), lossNear(rng, p), U64_MAX];
    },
  },
  {
    id: 94,
    name: "pay_kf_loss_from_free_capital_not_atomic",
    portfolio: true,
    args: (rng, _m, p, i) => [
      BigInt(lossDomain(rng, p, i)),
      lossNear(rng, p),
      rng.chance(50) ? 0n : amount(rng, true),
      BigInt(rng.int(1 << 30)),
      BigInt(rng.int(2)),
    ],
  },
  {
    id: 95,
    name: "apply_haircut_bounded_close_loss_to_pnl",
    portfolio: true,
    args: (rng, _m, p, i) => [lossNear(rng, p), BigInt(rng.int(2)), BigInt(lossDomain(rng, p, i))],
  },
  {
    id: 96,
    name: "apply_signed_kf_delta_to_pnl",
    portfolio: true,
    args: (rng, _m, p, i) => [
      rng.chance(50) ? lossNear(rng, p) : -lossNear(rng, p),
      BigInt(rng.chance(70) ? 1 : 0),
      BigInt(rng.chance(50) ? lossDomain(rng, p, i) : heldDomain(rng, p, i)),
    ],
  },
  {
    id: 97,
    name: "reserve_new_capital_backed_loss_for_source_domain_not_atomic",
    portfolio: true,
    args: (rng, _m, p, i) => {
      const before = rng.chance(50) ? 0n : BigInt(rng.int(1_000_000));
      return [BigInt(lossDomain(rng, p, i)), before, before + rng.pick([0n, 1n, BigInt(rng.int(1_000_000)), get(p, portfolioAt("capital"), 16)])];
    },
  },
  {
    id: 98,
    name: "book_kf_loss_support_for_source_domain_not_atomic",
    args: d1((rng) => [rng.pick([0n, 1n, BigInt(rng.int(1_000_000)), amount(rng, true) / BOUND_SCALE])]),
  },
  {
    id: 99,
    name: "book_realized_kf_loss_for_source_domain_not_atomic",
    args: d1((rng) => [rng.pick([0n, 1n, BigInt(rng.int(1_000_000)), amount(rng, true) / BOUND_SCALE, U128_MAX >> 30n])]),
  },
  { id: 100, name: "prepare_account_kf_settlement_entry", portfolio: true, args: (rng, m, p) => legArgs(rng, m, p) },
  { id: 101, name: "prepare_account_kf_settlement_entry + apply_account_kf_settlement_entry", portfolio: true, args: (rng, m, p) => legArgs(rng, m, p) },
  {
    id: 102,
    name: "begin_full_drain_reset_inner",
    args: (rng, m, _p, i) => {
      const asset = assetArg(rng, i);
      const side = sideArg(rng);
      if (side <= 1n && asset < i.capacity && rng.chance(70)) exhaust(rng, m, asset, side === 1n ? "short" : "long");
      return [BigInt(asset), side];
    },
  },
  // Layers 6 and 7: the B chunks and the driver.
  { id: 103, name: "b_target_for_leg", portfolio: true, args: (rng, _m, p, i) => legAsset(rng, p, i) },
  { id: 104, name: "mark_account_b_stale", portfolio: true, args: () => [] },
  { id: 105, name: "clear_account_b_stale", portfolio: true, args: () => [] },
  { id: 106, name: "mark_leg_b_stale", portfolio: true, args: (rng, _m, p, i) => legAsset(rng, p, i).slice(0, 1) },
  { id: 107, name: "account_b_settlement_chunk", portfolio: true, args: (rng, m, p, i) => [legAsset(rng, p, i)[0]!, bBudget(rng, m)] },
  { id: 108, name: "settle_account_b_chunk", portfolio: true, args: (rng, m, p, i) => [legAsset(rng, p, i)[0]!, bBudget(rng, m)] },
  { id: 109, name: "settle_account_kf_effects_not_atomic", portfolio: true, args: (rng) => [BigInt(rng.int(2))] },
  { id: 110, name: "settle_account_side_effects_not_atomic", portfolio: true, args: (rng, m) => [bBudget(rng, m)] },
  { id: 68, name: "validate_shape and validate_with_market (the validity of the generated states)", portfolio: true, args: () => [] },
];

/** The close-progress ledger of a portfolio, now and then active with a residual (function 65). */
function closeProgress(rng: Rng, p: Buffer): void {
  if (!rng.chance(50)) return;
  const at = (f: string) => portfolioAt(`close_progress.${f}`);
  put(p, at("active"), 1, BigInt(rng.chance(90) ? 1 : 2));
  put(p, at("finalized"), 1, BigInt(rng.int(2)));
  put(p, at("canceled"), 1, BigInt(rng.chance(80) ? 0 : 1));
  put(p, at("residual_remaining"), 16, rng.chance(30) ? 0n : BigInt(rng.int(1000)));
}

/** `count` vectors of every function, from `seed`. */
export function marketVectors(seed: bigint, count: number): MarketVector[] {
  const rng = new Rng(seed);
  const out: MarketVector[] = [];
  for (const k of PRIMITIVES)
    for (let n = 0; n < count; n++) {
      const { market, info } = marketBytes(rng);
      const portfolio = k.portfolio ? portfolioBytes(rng, market, info, k.id >= 100 && k.id <= 110 && k.id !== 102 ? 1 : 0) : Buffer.alloc(NO_PORTFOLIO_LEN);
      if (k.id === 65) closeProgress(rng, portfolio);
      const args = k.args(rng, market, portfolio, info).map((v) => (v < 0n ? (1n << 128n) + v : v) & U128_MAX);
      while (args.length < 8) args.push(0n);
      out.push({ fn: k.id, args, market, portfolio });
    }
  return out;
}

/** The host program's input: count, then per vector the id, the arguments, both lengths, both accounts. */
export function marketVectorInput(vs: MarketVector[]): Buffer {
  const parts: Buffer[] = [];
  const n = Buffer.alloc(4);
  n.writeUInt32LE(vs.length);
  parts.push(n);
  for (const v of vs) {
    const head = Buffer.alloc(1 + 8 * 16 + 8);
    head[0] = v.fn;
    v.args.forEach((a, i) => put(head, 1 + i * 16, 16, a));
    head.writeUInt32LE(v.market.length, 1 + 8 * 16);
    head.writeUInt32LE(v.portfolio.length, 1 + 8 * 16 + 4);
    parts.push(head, v.market, v.portfolio);
  }
  return Buffer.concat(parts);
}

export function marketVectorDigest(vs: MarketVector[]): string {
  return createHash("sha256").update(marketVectorInput(vs)).digest("hex");
}

export const primitiveName = (id: number) => PRIMITIVES.find((k) => k.id === id)!.name;
