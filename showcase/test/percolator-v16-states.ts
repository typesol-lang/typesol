// A generator of Percolator v16 market and portfolio states (Percolator v16 at commit 7b110913, engine 5e3af07,
// aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0) for the differential tests of the port: the
// bytes of a world's market and portfolios rewritten, the same way in both VMs, into states the original's own
// validators accept most of the time (`PortfolioV16View::validate_with_market`, `MarketGroupV16View::validate_shape`),
// with open legs, PnL of either sign, reserved PnL, fee debt, the bankruptcy and unattributed-loss locks, the market's
// money totals and domain budgets, the asset's side epochs, K/F epochs and exposure, the maintenance-fee rate, the
// cranker's share and the fee carry, the Clock against the fee slot, at ordinary and extreme values (near the u128 and
// i128 limits). A state the reference refuses is still compared: the refusal is the comparison.
//
// No ported instruction can open a leg yet (trades are not ported), so this is how the settlement of open legs, the fee
// and the withdrawal paths meet portfolios with legs, PnL, claims and liens. A generated state is a list of writes (`Patch`), so the same state
// can be applied again after a probe.
import type { Address, Instruction, KeyPairSigner } from "@solana/kit";
import { send as sendTx } from "../../test/harness.js";
import { Rng } from "./fuzz-rng.js";
import { type Diff, err, marketAt, portfolioAt } from "./percolator-v16-helpers.js";
import { outcome } from "./percolator-helpers.js";
import { offsetOf, sizeOf } from "./percolator-v16-layout.js";
import { ledgerField, writeLedger, writeSourceDomains } from "./percolator-v16-primitives.js";
import type { World } from "./percolator-v16-world.js";

/** One write: `size` little-endian bytes of `value` (two's complement for a negative one) at `at` of `account`. */
export interface Write {
  account: Address;
  at: number;
  size: number;
  value: bigint;
}
export type Patch = Write[];

const U128_MAX = (1n << 128n) - 1n;
const I128_MAX = (1n << 127n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
/** Engine constants (src/lib.rs, src/v16.rs). */
const MAX_VAULT_TVL = 10_000_000_000_000_000n;
const MIN_A_SIDE = 100_000_000_000_000n;
const ADL_ONE = 1_000_000_000_000_000n;
const SOCIAL_LOSS_DEN = 1_000_000_000_000_000_000_000n;
const MAX_POSITION_ABS_Q = 100_000_000_000_000n;
const MAX_PROTOCOL_FEE_ABS = 10n ** 36n;

const LEG = sizeOf("PortfolioLeg");
const legAt = (slot: number, f: string) => portfolioAt("legs") + slot * LEG + offsetOf("PortfolioLeg", f);

/** Apply a patch in both VMs. */
export function apply(w: World, patch: Patch): void {
  const by = new Map<Address, Write[]>();
  for (const x of patch) by.set(x.account, [...(by.get(x.account) ?? []), x]);
  for (const [account, writes] of by)
    w.d.patch(account, (b) => {
      for (const x of writes) {
        let v = x.value < 0n ? (1n << BigInt(8 * x.size)) + x.value : x.value;
        for (let i = 0; i < x.size; i++) {
          b[x.at + i] = Number(v & 0xffn);
          v >>= 8n;
        }
      }
    });
}

/** What a generated state is, for the tally. */
export interface StateInfo {
  mode: "live" | "resolved" | "recovery";
  legs: number;
  pnl: "negative" | "zero" | "positive";
  feeRate: bigint;
}

/** A value of a scale picked at random: zero, small, ordinary, large, or at the type's limit. */
function scaled(rng: Rng, max: bigint): bigint {
  switch (rng.int(8)) {
    case 0:
      return 0n;
    case 1:
      return BigInt(1 + rng.int(10));
    case 2:
      return BigInt(rng.int(1_000_000));
    case 3:
      return rng.next() % (max + 1n);
    case 4:
      return max;
    case 5:
      return max - BigInt(rng.int(3)) < 0n ? 0n : max - BigInt(rng.int(3));
    default:
      return BigInt(rng.int(1_000_000_000));
  }
}

/** A random u128 at most `max` (high bits from two draws). */
function wide(rng: Rng, max: bigint): bigint {
  if (max === 0n) return 0n;
  const v = (rng.next() << 64n) | rng.next();
  return v % (max + 1n);
}

/**
 * A state of the world's main market and its two portfolios. `rng` decides everything; `info` tells what was made.
 * The Clock is the Diff's (`w.d.slot`): the fee slots, the market's slots and the assets' slots are set around it.
 */
export function generate(w: World, rng: Rng, open = false): { patch: Patch; info: StateInfo; vaultAmount: bigint } {
  const patch: Patch = [];
  const m = w.m.market;
  const b = w.d.data(m);
  const put = (account: Address, at: number, size: number, value: bigint) => patch.push({ account, at, size, value });
  const g = (path: string, size: number, v: bigint) => put(m, marketAt.group(path), size, v);
  const now = w.d.slot;

  // The market's mode: Live mostly; Resolved (with a resolved slot) or Recovery now and then.
  // With `open`, a state whose legs the fee settles: Live (nine in ten), every portfolio with legs, the fee slot behind
  // the anchor, ledgers and claims almost always.
  const r = rng.int(20);
  const mode = open ? (r < 18 ? 0 : r < 19 ? 1 : 2) : r < 16 ? 0 : r < 19 ? 1 : 2;
  g("mode", 1, BigInt(mode));
  if (mode === 1) g("resolved_slot", 8, rng.chance(50) ? now - BigInt(rng.int(1000)) : now + BigInt(rng.int(1000)));
  // The market's slots: current_slot around the Clock (ahead of it now and then), slot_last not after it.
  const current = rng.chance(85) ? now - BigInt(rng.int(100)) : now + BigInt(1 + rng.int(1000));
  g("current_slot", 8, current);
  g("slot_last", 8, current - BigInt(rng.int(50)));
  g("bankruptcy_hlock_active", 1, BigInt(rng.int(2)));

  // Money: vault ≥ c_tot + insurance (the shape check), the remaining domain budgets within the insurance.
  const vault = rng.chance(10) ? MAX_VAULT_TVL : scaled(rng, MAX_VAULT_TVL);
  const cTot = rng.chance(50) ? vault / 2n : wide(rng, vault);
  const insurance = wide(rng, vault - cTot);
  const remaining = rng.chance(30) ? insurance : wide(rng, insurance);
  g("vault", 16, vault);
  g("c_tot", 16, cTot);
  g("insurance", 16, insurance);
  g("insurance_domain_budget_remaining_total", 16, remaining);
  g("negative_pnl_account_count", 8, BigInt(rng.int(4)));

  // Asset 0's domain budgets (the maintenance fee's destination): budget ≥ spent, or not (refused).
  for (const side of ["long", "short"]) {
    const spent = scaled(rng, 1_000_000_000n);
    const budget = rng.chance(95) ? spent + scaled(rng, rng.chance(5) ? U128_MAX - spent : 1_000_000_000n) : spent - 1n;
    put(m, marketAt.engine(0, `insurance_domain_budget_${side}`), 16, budget < 0n ? 0n : budget);
    put(m, marketAt.engine(0, `insurance_domain_spent_${side}`), 16, spent);
  }

  // Each asset's exposure (what decides the fee anchor) and its slot.
  for (const asset of [0, 1]) {
    const exposed = rng.chance(60);
    put(m, marketAt.engine(asset, "asset.oi_eff_long_q"), 16, exposed && rng.chance(50) ? BigInt(1 + rng.int(1_000_000)) : 0n);
    put(m, marketAt.engine(asset, "asset.stored_pos_count_short"), 8, exposed ? BigInt(1 + rng.int(3)) : 0n);
    put(m, marketAt.engine(asset, "asset.slot_last"), 8, now - BigInt(rng.chance(open ? 85 : 50) ? rng.int(10) : rng.int(5_000_000)));
    // Now and then a pending managed mark (the raw target off the effective price): SyncMaintenanceFee refuses it.
    if (rng.chance(4)) put(m, marketAt.engine(asset, "asset.raw_oracle_target_price"), 8, BigInt(1 + rng.int(2_000_000)));
  }

  // The fee: the rate (u128, InitMarket bounds it by MAX_PROTOCOL_FEE_ABS; the wrapper's validation does not), the
  // cranker's share (at most 10,000 bps), the carry.
  const rate = rng.pick([0n, 1n, BigInt(1 + rng.int(1000)), BigInt(rng.int(1_000_000_000)), MAX_PROTOCOL_FEE_ABS, U128_MAX, wide(rng, U128_MAX)]);
  put(m, marketAt.wrapper("maintenance_fee_per_slot"), 16, rate);
  put(m, marketAt.wrapper("maintenance_cranker_fee_share_bps"), 2, BigInt(rng.pick([0, 1, rng.int(10_001), 5_000, 10_000])));
  put(m, marketAt.wrapper("_padding0"), 1, BigInt(rng.chance(97) ? rng.int(2) : 2 + rng.int(254)));
  // The market's oracle liveness: fresh mostly (a matured permissionless-resolve window refuses a Live market).
  put(m, marketAt.wrapper("last_good_oracle_slot"), 8, rng.chance(95) ? now - BigInt(rng.int(1000)) : 0n);

  const info: StateInfo = { mode: (["live", "resolved", "recovery"] as const)[mode]!, legs: 0, pnl: "zero", feeRate: rate };
  for (let k = 0; k < 2; k++) {
    const p = w.portfolios[k]!;
    const acct = w.d.reference.getAccount(p);
    if (!acct.exists || acct.data.length !== 9563) continue;
    const pp = (path: string, size: number, v: bigint) => put(p, portfolioAt(path), size, v);
    // The capital: mostly within c_tot (the engine subtracts it from c_tot), sometimes anything up to u128::MAX.
    // A tenth of the portfolios are (nearly) empty: no PnL, no fee debt, no legs, a capital of a few atoms or none
    // (what ClosePortfolio closes and what a fee empties into a close).
    const bare = !open && rng.chance(10);
    const capital = bare
      ? BigInt(rng.int(3) === 0 ? 0 : rng.int(100))
      : rng.chance(80)
        ? wide(rng, cTot)
        : rng.chance(50)
          ? U128_MAX - BigInt(rng.int(3))
          : wide(rng, U128_MAX);
    pp("capital", 16, capital);
    // The PnL: negative, zero or positive, at ordinary sizes or near the i128 limits (never i128::MIN).
    const sign = bare ? 1 : rng.int(3);
    const magnitude = rng.chance(15)
      ? I128_MAX - BigInt(rng.int(3))
      : rng.chance(50)
        ? scaled(rng, capital > I128_MAX ? I128_MAX : capital + 10n)
        : scaled(rng, 1_000_000_000n);
    const pnl = sign === 0 ? -magnitude : sign === 1 ? 0n : magnitude;
    pp("pnl", 16, pnl);
    if (k === 0) info.pnl = pnl < 0n ? "negative" : pnl === 0n ? "zero" : "positive";
    pp("reserved_pnl", 16, pnl > 0n && rng.chance(40) ? wide(rng, pnl) : 0n);
    // Fee debt (fee_credits ≤ 0, never i128::MIN).
    pp("fee_credits", 16, bare || rng.chance(60) ? 0n : -(rng.chance(10) ? I128_MAX : scaled(rng, 1_000_000_000_000n)));
    // The unattributed-loss lock only with a loss (validate_with_market).
    pp("liquidation_lock", 1, pnl < 0n && rng.chance(30) ? 1n : 0n);
    const crystallized = rng.chance(70) ? scaled(rng, 1_000_000n) : rng.chance(50) ? U128_MAX - BigInt(rng.int(3)) : wide(rng, U128_MAX);
    pp("residual_crystallized_loss_atoms_total", 16, crystallized);
    pp("residual_spent_principal_atoms_total", 16, wide(rng, crystallized));
    // The fee slot: behind the Clock by a gap of any size, at it, or ahead of it (Stale).
    const gap = rng.pick([0n, 1n, BigInt(rng.int(100)), BigInt(rng.int(1_000_000)), now]);
    pp("last_fee_slot", 8, open && rng.chance(90) ? now - 20n - BigInt(rng.int(1_000_000)) : rng.chance(8) ? now + BigInt(1 + rng.int(100)) : now - gap);
    // Legs: none (the flat portfolio) half the time, else one or two (max_portfolio_assets is 2), each on a distinct
    // asset, bound to the asset's side epochs.
    let bitmap = 0n;
    const legs = bare || (!open && rng.chance(50)) ? 0 : 1 + rng.int(2);
    const assets = rng.chance(50) ? [0, 1] : [1, 0];
    for (let slot = 0; slot < 16; slot++) {
      if (slot >= legs) {
        if (slot < 2) {
          // The EMPTY leg (a_basis ADL_ONE, everything else zero).
          put(p, portfolioAt("legs") + slot * LEG, LEG, 0n);
          put(p, legAt(slot, "a_basis"), 16, ADL_ONE);
        }
        continue;
      }
      const asset = assets[slot]!;
      const side = rng.int(2);
      const sideName = side === 0 ? "long" : "short";
      const epoch = b.readBigUInt64LE(marketAt.engine(asset, `asset.epoch_${sideName}`));
      const kfEpoch = rng.chance(70) ? 0n : BigInt(1 + rng.int(5));
      put(m, marketAt.engine(asset, `asset.kf_epoch_${sideName}`), 8, kfEpoch);
      // The side's K, F and B indices, moved from the leg's snapshots (below) by a step of any sign and size.
      const kNow = indexStep(rng);
      const fNow = indexStep(rng);
      put(m, marketAt.engine(asset, `asset.k_${sideName}`), 16, kNow);
      put(m, marketAt.engine(asset, `asset.f_${sideName}_num`), 16, fNow);
      const aBasis = rng.chance(50) ? ADL_ONE : MIN_A_SIDE + wide(rng, ADL_ONE - MIN_A_SIDE);
      const abs = rng.chance(20) ? MAX_POSITION_ABS_Q : BigInt(rng.int(1_000_000_000));
      const weight = (abs * ADL_ONE + aBasis - 1n) / aBasis;
      const lw = weight === 0n ? 1n : weight + (rng.chance(20) ? wide(rng, SOCIAL_LOSS_DEN - weight) : 0n);
      put(p, legAt(slot, "active"), 1, 1n);
      put(p, legAt(slot, "asset_index"), 4, BigInt(asset));
      put(p, legAt(slot, "market_id"), 8, b.readBigUInt64LE(marketAt.engine(asset, "asset.market_id")));
      put(p, legAt(slot, "side"), 1, BigInt(side));
      put(p, legAt(slot, "basis_pos_q"), 16, side === 0 ? abs : -abs);
      put(p, legAt(slot, "a_basis"), 16, aBasis);
      put(p, legAt(slot, "k_snap"), 16, rng.chance(5) ? -I128_MAX : clampI(kNow - indexStep(rng)));
      put(p, legAt(slot, "f_snap"), 16, rng.chance(5) ? I128_MAX : clampI(fNow - indexStep(rng)));
      const kfSnap = kfEpoch === 0n ? 0n : BigInt(rng.int(Number(kfEpoch) + 1));
      put(p, legAt(slot, "kf_epoch_snap"), 8, kfSnap);
      // A leg of an older K/F epoch is counted in its side's stale accounts (mostly).
      if (kfSnap < kfEpoch && rng.chance(85)) put(m, marketAt.engine(asset, `asset.stale_account_count_${sideName}`), 8, BigInt(1 + rng.int(2)));
      put(p, legAt(slot, "epoch_snap"), 8, epoch);
      put(p, legAt(slot, "loss_weight"), 16, lw > SOCIAL_LOSS_DEN ? SOCIAL_LOSS_DEN : lw);
      // The B snapshot at or behind the side's B index: nothing, part of a chunk, or more than one.
      const bSnap = rng.chance(70) ? BigInt(rng.int(1000)) : wide(rng, 1n << 64n);
      const bStep = rng.pick([0n, 0n, BigInt(1 + rng.int(1000)), wide(rng, 1n << 40n), wide(rng, 1n << 80n)]);
      put(m, marketAt.engine(asset, `asset.b_${sideName}_num`), 16, rng.chance(5) && bSnap > 0n ? bSnap - 1n : bSnap + bStep);
      put(p, legAt(slot, "b_snap"), 16, bSnap);
      put(p, legAt(slot, "b_rem"), 16, rng.chance(10) ? SOCIAL_LOSS_DEN - 1n : BigInt(rng.int(1000)));
      put(p, legAt(slot, "b_epoch_snap"), 8, epoch);
      put(p, legAt(slot, "b_stale"), 1, 0n);
      put(p, legAt(slot, "stale"), 1, 0n);
      bitmap |= 1n << BigInt(slot);
    }
    pp("active_bitmap", 8, bitmap);
    if (k === 0) info.legs = legs;
  }
  // The source domains: most states with legs (and some without) get ledgers for the market's four domains and
  // claims and liens for both portfolios, with the market's totals, money and positive-PnL totals made to hold them.
  let vaultNow = vault;
  if (rng.chance(open ? 90 : info.legs ? 75 : 30)) vaultNow = writeDomains(w, rng, patch, current);
  // The vault's token balance: what the market's vault says, or less (Withdraw refuses a short balance).
  const vaultAmount = rng.chance(85) ? (vaultNow > U64_MAX ? U64_MAX : vaultNow) : BigInt(rng.int(1_000_000));
  put(w.m.vault, 64, 8, vaultAmount);
  return { patch, info, vaultAmount };
}

const BOUND_SCALE = 1_000_000_000_000n;

/** A K or F index step: none, small, or up to 10^30 either way (a delta of up to millions of atoms at these bases). */
function indexStep(rng: Rng): bigint {
  if (rng.chance(25)) return 0n;
  const v = rng.chance(50) ? BigInt(rng.int(1_000_000)) : wide(rng, rng.chance(70) ? 10n ** 24n : 10n ** 30n);
  return rng.chance(50) ? v : -v;
}
function clampI(v: bigint): bigint {
  return v > I128_MAX ? I128_MAX : v < -I128_MAX ? -I128_MAX : v;
}

/** `account`'s bytes with the patch's writes to it applied. */
function patched(w: World, patch: Patch, account: Address): Buffer {
  const out = Buffer.from(w.d.data(account));
  for (const x of patch) {
    if (x.account !== account) continue;
    let v = x.value < 0n ? (1n << BigInt(8 * x.size)) + x.value : x.value;
    for (let i = 0; i < x.size; i++) {
      out[x.at + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

/** The writes that turn `before` into `after`, byte by byte. */
function diffWrites(patch: Patch, account: Address, before: Buffer, after: Buffer): void {
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) patch.push({ account, at: i, size: 1, value: BigInt(after[i]!) });
}

/**
 * Ledgers for the main market's four domains (percolator-v16-primitives.ts `writeLedger`: buckets Fresh, Expired,
 * Impaired or Empty, reservations, source credit states consistent with them), source domains for both portfolios
 * (`writeSourceDomains`: claims within the domains' bounds, liens on the buckets), a positive PnL held to the claims,
 * and the market's totals made to hold them: the claim, fresh-backing, reserved-insurance, earnings and budget totals
 * the sums over the domains, the insurance and the vault raised to cover them (the vault within its maximum), the
 * positive-PnL totals at least the portfolios', the count of negative portfolios. Returns the vault.
 */
function writeDomains(w: World, rng: Rng, patch: Patch, now: bigint): bigint {
  const m = w.m.market;
  const before = patched(w, patch, m);
  const mb = Buffer.from(before);
  const configured = 2;
  const info = { capacity: 3, configured, now };
  for (let d = 0; d < 2 * configured; d++) writeLedger(rng, mb, d, mb.readBigUInt64LE(marketAt.engine(d >> 1, "asset.market_id")), now, true);
  const u128 = (at: number) => mb.readBigUInt64LE(at) | (mb.readBigUInt64LE(at + 8) << 64n);
  const put = (at: number, v: bigint) => {
    mb.writeBigUInt64LE(v & U64_MAX, at);
    mb.writeBigUInt64LE((v >> 64n) & U64_MAX, at + 8);
  };
  let positive = 0n;
  let negatives = 0n;
  for (const p of w.portfolios) {
    const acct = w.d.reference.getAccount(p);
    if (!acct.exists || acct.data.length !== 9563) continue;
    const pb = patched(w, patch, p);
    const pbBefore = Buffer.from(pb);
    pb.fill(0, portfolioAt("source_domains"), portfolioAt("source_domains") + 32 * sizeOf("PortfolioSourceDomain"));
    const { claims } = writeSourceDomains(rng, pb, mb, info);
    // A positive PnL within the claims' attribution (at most their atoms).
    const raw = pb.readBigUInt64LE(portfolioAt("pnl")) | (pb.readBigUInt64LE(portfolioAt("pnl") + 8) << 64n);
    let pnl = raw >> 127n ? raw - (1n << 128n) : raw;
    if (pnl > 0n && pnl * BOUND_SCALE > claims) pnl = rng.chance(80) ? claims / BOUND_SCALE : 0n;
    else if (pnl <= 0n && claims !== 0n && rng.chance(40)) pnl = claims / BOUND_SCALE - (rng.chance(70) ? 0n : BigInt(rng.int(3)));
    const enc = pnl < 0n ? (1n << 128n) + pnl : pnl;
    pb.writeBigUInt64LE(enc & U64_MAX, portfolioAt("pnl"));
    pb.writeBigUInt64LE(enc >> 64n, portfolioAt("pnl") + 8);
    const reserved = pb.readBigUInt64LE(portfolioAt("reserved_pnl")) | (pb.readBigUInt64LE(portfolioAt("reserved_pnl") + 8) << 64n);
    if (reserved > (pnl > 0n ? pnl : 0n)) pb.fill(0, portfolioAt("reserved_pnl"), portfolioAt("reserved_pnl") + 16);
    if (pnl >= 0n) pb[portfolioAt("liquidation_lock")] = 0;
    if (pnl > 0n) positive += pnl;
    if (pnl < 0n) negatives++;
    diffWrites(patch, p, pbBefore, pb);
  }
  // The totals over the domains.
  let bound = 0n;
  let fresh = 0n;
  let insuranceAtoms = 0n;
  let earnings = 0n;
  let remaining = 0n;
  for (let d = 0; d < 2 * configured; d++) {
    bound += ledgerField(mb, d, "source_credit", "positive_claim_bound_num");
    fresh += ledgerField(mb, d, "source_credit", "fresh_reserved_backing_num");
    insuranceAtoms += (ledgerField(mb, d, "source_credit", "insurance_credit_reserved_num") + BOUND_SCALE - 1n) / BOUND_SCALE;
    earnings += ledgerField(mb, d, "backing", "utilization_fee_earnings");
    const side = d % 2 === 1 ? "short" : "long";
    remaining += u128(marketAt.engine(d >> 1, `insurance_domain_budget_${side}`)) - u128(marketAt.engine(d >> 1, `insurance_domain_spent_${side}`));
  }
  const g = (path: string) => marketAt.group(path);
  put(g("source_claim_bound_total_num"), bound);
  put(g("source_fresh_backing_total_num"), fresh);
  put(g("source_insurance_credit_reserved_total_atoms"), insuranceAtoms);
  put(g("backing_provider_earnings_total"), earnings);
  put(g("insurance_domain_budget_remaining_total"), remaining < 0n ? 0n : remaining);
  let insurance = u128(g("insurance"));
  const need = insuranceAtoms + (remaining < 0n ? 0n : remaining);
  if (insurance < need) insurance = need + BigInt(rng.int(1_000_000));
  put(g("insurance"), insurance);
  const cTot = u128(g("c_tot"));
  const senior = cTot + insurance + earnings + fresh / BOUND_SCALE;
  let vault = u128(g("vault"));
  if (vault < senior) vault = senior + (rng.chance(50) ? 0n : BigInt(rng.int(1_000_000)));
  if (vault > MAX_VAULT_TVL && senior <= MAX_VAULT_TVL) vault = MAX_VAULT_TVL;
  put(g("vault"), vault);
  // The positive-PnL totals: at least the portfolios' and the claims'.
  const pos = positive + (rng.chance(50) ? 0n : BigInt(rng.int(1_000_000)));
  let boundNum = pos * BOUND_SCALE;
  if (boundNum < bound) boundNum = bound;
  if (rng.chance(30)) boundNum += BigInt(rng.int(1_000_000)) * BOUND_SCALE;
  put(g("pnl_pos_tot"), pos);
  put(g("pnl_pos_bound_tot_num"), boundNum);
  put(g("pnl_pos_bound_tot"), (boundNum + BOUND_SCALE - 1n) / BOUND_SCALE);
  put(g("pnl_matured_pos_tot"), wide(rng, pos));
  mb.writeBigUInt64LE(negatives + BigInt(rng.chance(80) ? 0 : rng.int(3)), g("negative_pnl_account_count"));
  diffWrites(patch, m, before, mb);
  return vault;
}

// Struct values for the function-level comparisons live in percolator-v16-values.ts (imported by plain Node scripts too).
export { type Values, configBytes, structBytes } from "./percolator-v16-values.js";
