// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The K/F settlement entries of the settlement of open legs (layer 5 of the map in NOTES.md, section 10): a leg's K/F
// delta prepared (a side whose effective OI is exhausted first moved behind a reset epoch) and applied: a gain through
// `apply_signed_kf_delta_to_pnl` (attributed to the source domain, curing a loss with the domain's prospective support),
// a loss netted at par against the account's own face first (`settle_kf_loss_before_support_not_atomic`: the twin
// domain's face, fully backed face elsewhere, the loss domain's own face, the rest from free capital where partially
// backed face is kept), then through the haircut-bounded close loss (the account's source credit consumed, liened face
// burned with its backing paid to the loss's domain), the support booked for that domain and the capital-backed part
// of a new loss reserved; the funding flow recorded, the stale K/F cohort settled, the leg's snapshots written.
//
// Wired through `settle_account_side_effects_not_atomic` (settlement.ts) into SyncMaintenanceFee and Withdraw, compared
// with the reference binary on generated states with open legs (percolator-v16-refresh.test.ts,
// percolator-v16-walk.test.ts); each function is also compared alone with the original's own function compiled for the
// host on generated markets and portfolios (percolator-v16-primitives.test.ts).
//
// Copies. `apply_account_kf_settlement_entry` reads the leg and the asset into values at its start and writes both
// back at its end (`from_runtime`, `set_asset_state`); nothing in between writes either (the PnL paths change the
// portfolio's PnL, claims and counters and the market's domains and totals, never a leg or an asset state), so the
// port changes the leg's three snapshots and the asset's stale cohort in place, with `set_asset_state`'s blocker count
// taken just before the change, as the original takes it from the stored asset. `net_slot_face_at_par_not_atomic`
// passes `create_and_consume_source_credit_from_counterparty_parts_not_atomic` the bucket, source state and reservation
// it read at its start, with only reads in between: in place they are the slots. The batch and the domain credit are
// the original's `&mut` structs (`Inout`). Every caller propagates every error here (NOTES.md section 10).
import { type Inout, type RemainingAccount, type i128, type u8, type u64, type u128, type u256, loadRawAt, loadRawMutAt, i128 as toI128, u64 as toU64, u128 as toU128, u256 as toU256 } from "typesol";
import {
  V16_ARITHMETIC_OVERFLOW,
  V16_COUNTER_OVERFLOW,
  V16_COUNTER_UNDERFLOW,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  checkV16,
  failV16,
} from "./errors.js";
import { type AssetState, type BackingBucket, type EngineAssetSlot, type GroupHeader, type Portfolio, type SourceCreditState, HEADER_LEN, MARKET_GROUP_OFF } from "./state.js";
import { BOUND_SCALE, closeProgressErr, marketModeErr } from "./wire.js";
import { CREDIT_RATE_SCALE, PORTFOLIO_SOURCE_DOMAIN_CAP, amountFromBoundNum, compactSourceDomains, engineSlotAt, legErr, slotBlockers, blockersAfter } from "./engine.js";
import {
  assetIsLossStaleAt,
  beginFullDrainReset,
  boundNumFromAmount,
  decodePlanKey,
  haircutEffectiveSupport,
  kfTargetForLeg,
  legHasExhaustedEffectiveOi,
  legKfDeltaComponents,
  planKey,
  settleKfStaleCohort,
  settlePositiveFaceAfterSupport,
} from "./kernels.js";
import {
  type KfLossLienPayment,
  accountHasSourceClaims,
  addAccountCounter,
  addFreshCounterpartyBacking,
  assetStateOf,
  bucketAt,
  bucketForDomain,
  bucketRawStatusExpiry,
  closeHasPendingResidual,
  creditPostSnapshotResidualMarket,
  domainAssetSide,
  domainIsOccupied,
  domainIsSparseTailDefault,
  expireSourceBackingBucket,
  faceClaimToBurnForSupport,
  freshCounterpartyBackingExpiry,
  hasPendingDomainLossBarrier,
  insuranceDomainIndex,
  juniorClaimBound,
  lossBucketAcceptsFresh,
  providerPrincipal,
  reservationForDomain,
  resetSourceDomainSlotIfEmpty,
  residual,
  resolvedLossBackingCapacity,
  slotUnlienedClaim,
  sourceAt,
  sourceForDomain,
  storedSourceCreditRate,
  twinLoserPaidShare,
  createAndConsumeCounterpartyParts,
} from "./primitives.js";
import {
  NO_DOMAIN,
  availableBacking,
  consumeSourceDomainCreditForEffective,
  marketMode,
  consumeValidatedAccountSourceCredit,
  decrementSourceClaim,
  setAccountPnl,
  setAccountPnlAfterKfLossClaimBurn,
  setAccountPnlAfterSourceClaimBurn,
  setAccountPnlWithSource,
  sourceDomainProspectiveSupport,
} from "./claims.js";

const U128_MAX_KF: u128 = 0xffffffffffffffffffffffffffffffffn;
const U128_MAX_KFW: u256 = 340282366920938463463374607431768211455n;
const I128_MAX_KF: u128 = 0x7fffffffffffffffffffffffffffffffn;
const I128_MIN_KF: i128 = -170141183460469231731687303715884105728n;
const U64_MAX_KF: u64 = 0xffffffffffffffffn;
const BUCKET_FRESH_KF = 1n;
const BUCKET_IMPAIRED_KF = 3n;
const MODE_LIVE_KF = 0n;
const MODE_RESOLVED_KF = 1n;

/** `ParNettingBatchV16`: the face and loss left, what was netted (atoms and bound), the backing to move, its expiry. */
export interface ParNettingBatch {
  face_left: u128;
  loss_left: u128;
  netted: u128;
  netted_num: u128;
  transfer_num: u128;
  expiry_slot: u64;
}

/** `KfLossDomainCreditV16`: what a loss pays into its domain, booked once. */
export interface KfLossDomainCredit {
  amount_num: u128;
  expiry_slot: u64;
  payments: u64;
}

/** `SupportLossApplicationV16`. */
export interface SupportLossApplication {
  support_consumed: u128;
  junior_face_burned: u128;
  counterparty_support_consumed: u128;
}

/** `AccountKfSettlementPreparedV16`, with the plan key. */
export interface KfPrepared {
  entry: u64;
  k_now: i128;
  f_now: i128;
  f_snap_next: i128;
  f_delta: i128;
  net: i128;
}

/** |v| of an i128 as a u128 (`unsigned_abs`). */
function absU(v: i128): u128 {
  return v < 0n ? toU128(-(v + 1n)) + 1n : toU128(v);
}

/** An u128 as an i128 (`i128::try_from`: ArithmeticOverflow above i128::MAX). */
function toSigned(v: u128): i128 {
  if (v > I128_MAX_KF) failV16(V16_ARITHMETIC_OVERFLOW);
  return toI128(v);
}

/** `record_account_residual_crystallized_loss(account, atoms)` (CounterOverflow). */
function recordResidualCrystallizedLoss(pa: RemainingAccount, atoms: u128): void {
  if (atoms === 0n) return;
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  if (p.residual_crystallized_loss_atoms_total > U128_MAX_KF - atoms) failV16(V16_COUNTER_OVERFLOW);
  p.residual_crystallized_loss_atoms_total += atoms;
}

/** `record_account_funding_flow(account, side, f_delta)`: a negative delta added to the side's paid total, a positive
 * one to its received total (CounterOverflow). */
export function recordAccountFundingFlow(pa: RemainingAccount, short: boolean, fDelta: i128): void {
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  if (fDelta < 0n) {
    const atoms = absU(fDelta);
    if (short) p.funding_short_paid_atoms_total = addAccountCounter(p.funding_short_paid_atoms_total, atoms);
    else p.funding_long_paid_atoms_total = addAccountCounter(p.funding_long_paid_atoms_total, atoms);
  } else if (fDelta > 0n) {
    const atoms = toU128(fDelta);
    if (short) p.funding_short_received_atoms_total = addAccountCounter(p.funding_short_received_atoms_total, atoms);
    else p.funding_long_received_atoms_total = addAccountCounter(p.funding_long_received_atoms_total, atoms);
  }
}

/** The batch moved by one netting. The sums are bounded by the loss and by the account's claims (each at most what a
 * slot holds), so they cannot overflow. */
function batchNetted(batch: Inout<ParNettingBatch>, netted: u128, nettedNum: u128, transfer: u128): void {
  batch.netted += netted;
  batch.netted_num += nettedNum;
  batch.transfer_num += transfer;
  batch.loss_left -= netted;
  batch.face_left -= netted;
}

/**
 * `cancel_loss_domain_face_at_par_not_atomic(account, slot, netted, batch)`: face held in the loss's own domain; nothing
 * for a lapsed Fresh bucket (raw status, effective expiry) or a stored credit rate below one; else the claim decremented
 * by the netted atoms and the batch moved, nothing transferred.
 */
export function cancelLossDomainFaceAtPar(m: RemainingAccount, markets: u64, pa: RemainingAccount, slot: u64, netted: u128, batch: Inout<ParNettingBatch>): void {
  const domain = toU64(loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot).domain);
  const raw = bucketRawStatusExpiry(m, markets, domain);
  if ((raw.status === BUCKET_FRESH_KF && raw.expiry <= loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot) || storedSourceCreditRate(m, markets, domain) !== CREDIT_RATE_SCALE)
    return;
  const nettedNum = boundNumFromAmount(netted);
  decrementSourceClaim(m, markets, pa, slot, domain, nettedNum);
  batchNetted(batch, netted, nettedNum, 0n);
}

/**
 * `net_slot_face_at_par_not_atomic(account, slot, loss_domain, loss_side_open, require_full_backing, batch)`: the slot's
 * unliened face, in whole atoms, cancelled against the batch's loss: in the loss's own domain by
 * `cancel_loss_domain_face_at_par_not_atomic`; elsewhere the backing behind it (at rate one all of it, else its share of
 * the available backing, rounded up; for the twin, no more than the loser-paid share) moved to the loss's domain by a
 * create-and-consume that also burns the domain's claim, where the face's bucket is live Fresh and the loss side and
 * the face's asset are open; with `require_full_backing` only face at rate one whose backing moves in full. Without a
 * transfer the claim is just decremented.
 */
export function netSlotFaceAtPar(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  slot: u64,
  lossDomain: u64,
  lossSideOpen: boolean,
  requireFull: boolean,
  batch: Inout<ParNettingBatch>,
): void {
  const src = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
  const faceDomain = toU64(src.domain);
  const claimBefore = src.source_claim_bound_num;
  const unliened = slotUnlienedClaim(src);
  let netted = batch.loss_left < batch.face_left ? batch.loss_left : batch.face_left;
  const unlienedAtoms = unliened / BOUND_SCALE;
  if (unlienedAtoms < netted) netted = unlienedAtoms;
  if (netted === 0n) return;
  if (faceDomain === lossDomain) {
    cancelLossDomainFaceAtPar(m, markets, pa, slot, netted, batch);
    return;
  }
  const now = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot;
  const expiry = bucketForDomain(m, markets, faceDomain);
  sourceForDomain(m, markets, faceDomain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(faceDomain));
  const credit = loadRawAt<SourceCreditState>(m, sourceAt(faceDomain));
  const fresh = b.status === BUCKET_FRESH_KF && expiry > now;
  const rate = b.status === BUCKET_FRESH_KF && !fresh ? 0n : credit.credit_rate_num;
  const faceAsset = domainAssetSide(m, markets, faceDomain);
  let movable: u128 = 0n;
  if (lossSideOpen && fresh && !hasPendingDomainLossBarrier(m, markets, faceAsset, false) && !hasPendingDomainLossBarrier(m, markets, faceAsset, true))
    movable = b.fresh_unliened_backing_num < credit.fresh_reserved_backing_num ? b.fresh_unliened_backing_num : credit.fresh_reserved_backing_num;
  if (requireFull) {
    if (rate !== CREDIT_RATE_SCALE) return;
    const movableAtoms = movable / BOUND_SCALE;
    if (movableAtoms < netted) netted = movableAtoms;
    if (netted === 0n) return;
  }
  const nettedNum = boundNumFromAmount(netted);
  let owed: u128 = 0n;
  if (rate === 0n || movable === 0n) owed = 0n;
  else if (rate === CREDIT_RATE_SCALE) owed = nettedNum;
  else {
    const available = availableBacking(credit);
    const claims = credit.positive_claim_bound_num;
    if (claims === 0n) owed = nettedNum;
    else {
      // checked_mul_div_ceil_u256(netted_num, available, claims · BOUND_SCALE): claims · BOUND_SCALE fits 256 bits and
      // is nonzero; a quotient above u128 is ArithmeticOverflow.
      const p = toU256(nettedNum) * toU256(available);
      const d = toU256(claims) * toU256(BOUND_SCALE);
      const q = p / d;
      const c = p % d === 0n ? q : q + 1n;
      if (c > U128_MAX_KFW) failV16(V16_ARITHMETIC_OVERFLOW);
      const atoms = boundNumFromAmount(toU128(c));
      owed = atoms < nettedNum ? atoms : nettedNum;
    }
  }
  const loserCap = requireFull || owed === 0n ? owed : twinLoserPaidShare(m, markets, faceDomain, nettedNum, credit.positive_claim_bound_num);
  let transfer = owed < movable ? owed : movable;
  if (loserCap < transfer) transfer = loserCap;
  if (requireFull && transfer !== nettedNum) return;
  if (transfer !== 0n) {
    reservationForDomain(m, markets, faceDomain);
    createAndConsumeCounterpartyParts(m, markets, faceDomain, expiry, transfer, nettedNum);
    if (claimBefore < nettedNum) failV16(V16_COUNTER_UNDERFLOW);
    const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
    p.source_domains.get(slot).source_claim_bound_num = claimBefore - nettedNum;
    resetSourceDomainSlotIfEmpty(pa, slot);
    if (expiry < batch.expiry_slot) batch.expiry_slot = expiry;
  } else decrementSourceClaim(m, markets, pa, slot, faceDomain, nettedNum);
  batchNetted(batch, netted, nettedNum, transfer);
}

/**
 * `pay_kf_loss_from_free_capital_not_atomic(account, loss_domain, loss, credit)`: up to the loss from the capital
 * (c_tot with it, CounterUnderflow) into the domain credit (its expiry the domain's fresh backing expiry when it is the
 * first payment; CounterOverflow), the residual crystallized loss raised, the health certificate invalidated. Returns
 * the amount paid. (The token-flow proof moves one amount from capital to realized loss with the vault unchanged: it
 * holds.)
 */
export function payKfLossFromFreeCapital(m: RemainingAccount, markets: u64, pa: RemainingAccount, lossDomain: u64, loss: u128, credit: Inout<KfLossDomainCredit>): u128 {
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const paid = loss < p.capital ? loss : p.capital;
  if (paid === 0n) return 0n;
  const paidNum = boundNumFromAmount(paid);
  p.capital -= paid;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.c_tot < paid) failV16(V16_COUNTER_UNDERFLOW);
  h.c_tot -= paid;
  if (credit.payments === 0n) credit.expiry_slot = freshCounterpartyBackingExpiry(m, markets, lossDomain);
  if (credit.amount_num > U128_MAX_KF - paidNum) failV16(V16_COUNTER_OVERFLOW);
  credit.amount_num += paidNum;
  // payments counts the loss's payments (two at most): no overflow.
  credit.payments += 1n;
  recordResidualCrystallizedLoss(pa, paid);
  p.health_cert.valid = 0n;
  return paid;
}

/**
 * `settle_kf_loss_before_support_not_atomic(account, loss_domain, loss)` → the loss settled here: nothing for no loss, a
 * PnL that is not positive or a market that is not Live. The twin domain's face first (backing moved only as far as
 * its losers paid it in), then each other slot's unliened face: at a stored rate of one netted (backing moved in full),
 * below it counted as partially backed. Netted face: the slots compacted, the moved backing's credit (its expiry the
 * loss bucket's when Fresh, else the earliest moved), the PnL lowered by the netted atoms (the reserved PnL held to it)
 * with the netted claim preburned. Then, where the loss side is open and partially backed face is kept, the whole rest
 * from free capital. The credit booked to the loss's domain once.
 */
export function settleKfLossBeforeSupport(m: RemainingAccount, markets: u64, pa: RemainingAccount, lossDomain: u64, lossAbs: u128): u128 {
  const startPnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  if (lossAbs === 0n || startPnl <= 0n || marketMode(m) !== MODE_LIVE_KF) return 0n;
  const asset = domainAssetSide(m, markets, lossDomain);
  const twin = insuranceDomainIndex(m, markets, asset, lossDomain % 2n === 0n);
  const open =
    !hasPendingDomainLossBarrier(m, markets, asset, false) && !hasPendingDomainLossBarrier(m, markets, asset, true) && lossBucketAcceptsFresh(m, markets, lossDomain);
  let end = 0n;
  let twinSlot = PORTFOLIO_SOURCE_DOMAIN_CAP;
  for (; end < PORTFOLIO_SOURCE_DOMAIN_CAP; end++) {
    const s = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(end);
    if (domainIsSparseTailDefault(s)) break;
    if (domainIsOccupied(s) && toU64(s.domain) === twin) twinSlot = end;
  }
  const batch: ParNettingBatch = { face_left: toU128(startPnl), loss_left: lossAbs, netted: 0n, netted_num: 0n, transfer_num: 0n, expiry_slot: U64_MAX_KF };
  if (twinSlot !== PORTFOLIO_SOURCE_DOMAIN_CAP) netSlotFaceAtPar(m, markets, pa, twinSlot, lossDomain, open, false, batch);
  let partial: u128 = 0n;
  for (let slot = 0n; slot < end && batch.loss_left !== 0n && batch.face_left !== 0n; slot++) {
    const s = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
    if (!domainIsOccupied(s) || slot === twinSlot) continue;
    const unliened = slotUnlienedClaim(s);
    if (unliened === 0n) continue;
    if (storedSourceCreditRate(m, markets, toU64(s.domain)) === CREDIT_RATE_SCALE) netSlotFaceAtPar(m, markets, pa, slot, lossDomain, open, true, batch);
    else {
      if (partial > U128_MAX_KF - unliened) failV16(V16_ARITHMETIC_OVERFLOW);
      partial += unliened;
    }
  }
  const credit: KfLossDomainCredit = { amount_num: 0n, expiry_slot: 0n, payments: 0n };
  if (batch.netted !== 0n) {
    const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
    compactSourceDomains(p.source_domains);
    if (batch.transfer_num !== 0n) {
      const expiry = bucketForDomain(m, markets, lossDomain);
      credit.expiry_slot = loadRawAt<BackingBucket>(m, bucketAt(lossDomain)).status === BUCKET_FRESH_KF ? expiry : batch.expiry_slot;
      credit.amount_num = batch.transfer_num;
      credit.payments = 1n;
    }
    const netted = toSigned(batch.netted);
    // start_pnl > 0 and netted ≥ 0: the CounterUnderflow of the subtraction cannot fire.
    const newPnl: i128 = startPnl - netted;
    const pos: u128 = newPnl > 0n ? toU128(newPnl) : 0n;
    if (p.reserved_pnl > pos) p.reserved_pnl = pos;
    setAccountPnlAfterSourceClaimBurn(m, markets, pa, newPnl, batch.netted_num);
  }
  let remaining = batch.loss_left;
  if (remaining !== 0n && batch.face_left !== 0n && open && partial !== 0n) remaining -= payKfLossFromFreeCapital(m, markets, pa, lossDomain, remaining, credit);
  if (credit.payments !== 0n) addFreshCounterpartyBacking(m, markets, lossDomain, credit.amount_num, credit.expiry_slot, credit.payments);
  // remaining ≤ loss_left ≤ loss: the CounterUnderflow cannot fire.
  return lossAbs - remaining;
}

/**
 * `book_realized_kf_loss_for_source_domain_not_atomic(domain, backing)` → the atoms left to the junior residual. Live:
 * all of it joins the domain's backing as loser-paid principal unless the bucket is Impaired. Resolved: an Impaired
 * domain takes nothing; one without claims or creditor legs takes, before the payout snapshot, what repays its provider;
 * else what `resolved_loss_backing_capacity_num` allows. A lapsed Fresh bucket is expired first; the backing is added
 * at the domain's fresh expiry unless the bucket is Impaired or that expiry has passed.
 */
export function bookRealizedKfLoss(m: RemainingAccount, markets: u64, domain: u64, backing: u128): u128 {
  if (backing === 0n) return 0n;
  const backingNum = boundNumFromAmount(backing);
  const resolved = marketMode(m) === MODE_RESOLVED_KF;
  let terminal = U128_MAX_KF;
  let hasTerminal = false;
  if (resolved) {
    const asset = domainAssetSide(m, markets, domain);
    assetStateOf(m, markets, asset);
    const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
    // The creditor side is the loss side's opposite.
    const lossShort = domain % 2n === 1n;
    const stored = lossShort ? a.stored_pos_count_long : a.stored_pos_count_short;
    const stale = lossShort ? a.stale_account_count_long : a.stale_account_count_short;
    sourceForDomain(m, markets, domain);
    const s = loadRawAt<SourceCreditState>(m, sourceAt(domain));
    bucketForDomain(m, markets, domain);
    if (loadRawAt<BackingBucket>(m, bucketAt(domain)).status === BUCKET_IMPAIRED_KF) {
      terminal = 0n;
      hasTerminal = true;
    } else if (s.positive_claim_bound_num === 0n && stored === 0n && stale === 0n) {
      const captured = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).payout_snapshot_captured;
      if (captured > 1n) failV16(V16_INVALID_CONFIG);
      hasTerminal = true;
      if (captured === 1n) terminal = 0n;
      else {
        const principal = providerPrincipal(m, markets, domain);
        const out = principal > s.fresh_reserved_backing_num ? principal - s.fresh_reserved_backing_num : 0n;
        terminal = s.provider_receivable_num < out ? s.provider_receivable_num : out;
      }
    }
  }
  if (hasTerminal && terminal === 0n) return backing;
  let sourceBacking = backingNum;
  let left: u128 = 0n;
  if (resolved) {
    const capacity = hasTerminal ? terminal : resolvedLossBackingCapacity(m, markets, domain);
    sourceBacking = backingNum < capacity ? backingNum : capacity;
    left = amountFromBoundNum(backingNum - sourceBacking);
  }
  if (sourceBacking === 0n) return left;
  const raw = bucketRawStatusExpiry(m, markets, domain);
  const now = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot;
  let impaired = raw.status === BUCKET_IMPAIRED_KF;
  if (raw.status === BUCKET_FRESH_KF && raw.expiry <= now) {
    expireSourceBackingBucket(m, markets, domain, now);
    impaired = bucketRawStatusExpiry(m, markets, domain).status === BUCKET_IMPAIRED_KF;
  }
  if (!impaired) {
    const expiry = freshCounterpartyBackingExpiry(m, markets, domain);
    if (expiry > now) {
      addFreshCounterpartyBacking(m, markets, domain, sourceBacking, expiry, 1n);
      return left;
    }
  }
  return backing;
}

/** `book_kf_loss_support_for_source_domain_not_atomic(domain, support)`: nothing for none or once the payout snapshot
 * is captured (the flag decoded: InvalidConfig); else booked as a realized loss. */
export function bookKfLossSupport(m: RemainingAccount, markets: u64, domain: u64, support: u128): void {
  if (support === 0n) return;
  const captured = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).payout_snapshot_captured;
  if (captured > 1n) failV16(V16_INVALID_CONFIG);
  if (captured === 1n) return;
  bookRealizedKfLoss(m, markets, domain, support);
}

/**
 * `reserve_new_capital_backed_loss_for_source_domain_not_atomic(account, domain, negative_before, negative_after)`: the
 * domain checked; of the new negative PnL, what the capital not already encumbered covers moves from the capital (and
 * c_tot, CounterUnderflow) into the PnL, is booked for the domain (the rest credited to the post-snapshot residual), and
 * raises the residual crystallized loss; the health certificate invalidated. (The token-flow proof holds, as above.)
 */
export function reserveNewCapitalBackedLoss(m: RemainingAccount, markets: u64, pa: RemainingAccount, domain: u64, negBefore: u128, negAfter: u128): void {
  domainAssetSide(m, markets, domain);
  const fresh = negAfter > negBefore ? negAfter - negBefore : 0n;
  if (fresh === 0n) return;
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const free = p.capital > negBefore ? p.capital - negBefore : 0n;
  const backing = fresh < free ? fresh : free;
  if (backing === 0n) return;
  // backing ≤ capital: its CounterUnderflow cannot fire.
  p.capital -= backing;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.c_tot < backing) failV16(V16_COUNTER_UNDERFLOW);
  h.c_tot -= backing;
  const b = toSigned(backing);
  if (p.pnl > toI128(I128_MAX_KF) - b) failV16(V16_ARITHMETIC_OVERFLOW);
  setAccountPnl(m, markets, pa, p.pnl + b);
  const junior = bookRealizedKfLoss(m, markets, domain, backing);
  creditPostSnapshotResidualMarket(m, junior);
  recordResidualCrystallizedLoss(pa, backing);
  p.health_cert.valid = 0n;
}

/** No support (the zero `SupportLossApplicationV16`). */
function noSupport(): SupportLossApplication {
  return { support_consumed: 0n, junior_face_burned: 0n, counterparty_support_consumed: 0n };
}

/**
 * `apply_haircut_bounded_close_loss_to_pnl(account, loss, kf_loss_domain)`: nothing for no loss; without positive face
 * the PnL lowered by it (ArithmeticOverflow). Else the support: with source claims the account's source credit consumed
 * up to the loss and the face (its claims burned, partial allowed); without, outside Live the haircut support of the
 * junior pool and the face burned for it. The face settled after support, the reserved PnL held to the new positive
 * part, the PnL set with the consumed claim preburned (the backing behind burned liens paid to `kfDomain` when given).
 */
export function applyHaircutBoundedCloseLoss(m: RemainingAccount, markets: u64, pa: RemainingAccount, loss: u128, kfDomain: u64): SupportLossApplication {
  if (loss === 0n) return noSupport();
  const pnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  const oldPos: u128 = pnl > 0n ? toU128(pnl) : 0n;
  if (oldPos === 0n) {
    const l = toSigned(loss);
    if (pnl < I128_MIN_KF + l) failV16(V16_ARITHMETIC_OVERFLOW);
    setAccountPnl(m, markets, pa, pnl - l);
    return noSupport();
  }
  let cpSupport: u128 = 0n;
  let support: u128 = 0n;
  let faceBurned: u128 = 0n;
  let preburned: u128 = 0n;
  if (accountHasSourceClaims(pa)) {
    const limit = loss < oldPos ? loss : oldPos;
    const c = consumeValidatedAccountSourceCredit(m, markets, pa, limit, true, false);
    cpSupport = c.counterparty_credit_consumed;
    support = c.consumed;
    faceBurned = c.face_burn < oldPos ? c.face_burn : oldPos;
    preburned = c.burned_num;
  } else {
    const eff = marketMode(m) === MODE_LIVE_KF ? 0n : haircutEffectiveSupport(oldPos, residual(m), juniorClaimBound(m));
    support = eff < loss ? eff : loss;
    faceBurned = support === 0n ? 0n : faceClaimToBurnForSupport(support, residual(m), juniorClaimBound(m));
  }
  if (loss < support) failV16(V16_ARITHMETIC_OVERFLOW);
  const settled = settlePositiveFaceAfterSupport(oldPos, faceBurned, loss - support);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const pos: u128 = settled.pnl > 0n ? toU128(settled.pnl) : 0n;
  if (p.reserved_pnl > pos) p.reserved_pnl = pos;
  const hasKf = kfDomain !== NO_DOMAIN;
  const payment: KfLossLienPayment = { loss_domain: hasKf ? kfDomain : 0n, loss_side_open: 0n, consumed_atoms: 0n };
  setAccountPnlAfterKfLossClaimBurn(m, markets, pa, settled.pnl, preburned, payment, hasKf);
  if (hasKf) {
    if (cpSupport > U128_MAX_KF - payment.consumed_atoms) failV16(V16_ARITHMETIC_OVERFLOW);
    cpSupport += payment.consumed_atoms;
  }
  return { support_consumed: support, junior_face_burned: settled.face_burned, counterparty_support_consumed: cpSupport };
}

/** `set_account_pnl_with_source` for a domain, `set_account_pnl` without one. */
function setPnlMaybeSource(m: RemainingAccount, markets: u64, pa: RemainingAccount, pnl: i128, domain: u64): void {
  if (domain !== NO_DOMAIN) setAccountPnlWithSource(m, markets, pa, pnl, domain);
  else setAccountPnl(m, markets, pa, pnl);
}

/**
 * `apply_signed_kf_delta_to_pnl(account, delta, source_domain)`: the delta not i128::MIN; nothing for zero; a loss
 * through the haircut-bounded close loss. A gain on a PnL that is not negative is added (on a Live market it needs a
 * source domain: InvalidLeg). A gain curing a loss: its support (the source domain's prospective support, consumed
 * from the domain; none on a Live market without a domain; else the junior pool's haircut support with the gain added to
 * the junior bound), the face burned for it (all of the gain when unsupported on Live or when loss remains), the PnL
 * the retained face less the remaining loss.
 */
export function applySignedKfDelta(m: RemainingAccount, markets: u64, pa: RemainingAccount, delta: i128, sourceDomain: u64): SupportLossApplication {
  if (delta === I128_MIN_KF) failV16(V16_ARITHMETIC_OVERFLOW);
  if (delta === 0n) return noSupport();
  if (delta < 0n) return applyHaircutBoundedCloseLoss(m, markets, pa, absU(delta), NO_DOMAIN);
  const pnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  if (pnl >= 0n) {
    if (sourceDomain === NO_DOMAIN && marketMode(m) === MODE_LIVE_KF) failV16(V16_INVALID_LEG);
    if (pnl > toI128(I128_MAX_KF) - delta) failV16(V16_ARITHMETIC_OVERFLOW);
    setPnlMaybeSource(m, markets, pa, pnl + delta, sourceDomain);
    return noSupport();
  }
  const oldLoss = absU(pnl);
  const face = toU128(delta);
  let eff: u128 = 0n;
  if (sourceDomain !== NO_DOMAIN) eff = sourceDomainProspectiveSupport(m, markets, sourceDomain, face);
  else if (marketMode(m) !== MODE_LIVE_KF) {
    const res = residual(m);
    const junior = juniorClaimBound(m);
    if (junior > U128_MAX_KF - face) failV16(V16_ARITHMETIC_OVERFLOW);
    eff = haircutEffectiveSupport(face, res, junior + face);
  }
  const support = eff < oldLoss ? eff : oldLoss;
  const remaining = oldLoss - support;
  let burned: u128 = 0n;
  if (sourceDomain !== NO_DOMAIN) {
    const fb = consumeSourceDomainCreditForEffective(m, markets, sourceDomain, support).face_burn;
    burned = fb < face ? fb : face;
  } else if (support !== 0n) {
    const res = residual(m);
    const junior = juniorClaimBound(m);
    if (junior > U128_MAX_KF - face) failV16(V16_ARITHMETIC_OVERFLOW);
    burned = faceClaimToBurnForSupport(support, res, junior + face);
  }
  if ((sourceDomain === NO_DOMAIN && marketMode(m) === MODE_LIVE_KF) || remaining !== 0n) burned = face;
  // burned ≤ face here (a min, or the face itself, or faceClaimToBurnForSupport's at most the support ≤ the loss): the
  // original's ArithmeticOverflow check is kept as it is written.
  if (burned > face) failV16(V16_ARITHMETIC_OVERFLOW);
  const retained = toSigned(face - burned);
  const rem = toSigned(remaining);
  // Both in 0..=i128::MAX: the difference fits.
  const newPnl: i128 = retained - rem;
  if (newPnl > 0n) setPnlMaybeSource(m, markets, pa, newPnl, sourceDomain);
  else setAccountPnl(m, markets, pa, newPnl);
  return { support_consumed: support, junior_face_burned: burned, counterparty_support_consumed: 0n };
}

/**
 * `begin_full_drain_reset_inner(asset, side)`: the asset configured (InvalidLeg); LockActive with a pending domain-loss
 * barrier on the side; the side moved behind a reset epoch (`kernel_begin_full_drain_reset`), the asset written
 * (`set_asset_state`: its blocker total), the risk epoch advanced (CounterOverflow).
 */
export function beginFullDrainResetInner(m: RemainingAccount, markets: u64, asset: u64, short: boolean): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  if (hasPendingDomainLossBarrier(m, markets, asset, short)) failV16(V16_LOCK_ACTIVE);
  assetStateOf(m, markets, asset);
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  // set_asset_state's count of the stored asset's blockers, taken before the kernel changes it in place; its
  // CounterOverflow comes after the kernel's refusals, as in the original.
  const before = slotBlockers(e);
  beginFullDrainReset(e.asset, short);
  if (before > toU128(U64_MAX_KF)) failV16(V16_COUNTER_OVERFLOW);
  blockersAfter(m, asset, toU64(before));
  const hm = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (hm.risk_epoch === U64_MAX_KF) failV16(V16_COUNTER_OVERFLOW);
  hm.risk_epoch += 1n;
}

/**
 * `prepare_account_kf_settlement_entry(account, leg_slot, normalize_exhausted_sides)`: InvalidLeg past the legs, for a
 * leg that does not decode or is inactive, or on an asset that is not configured, in the view or assigned. With
 * normalization, an exhausted side (no pending residual, no barrier) begins its full-drain reset first. Then the leg's
 * K/F delta and the plan key (phase: a delta that is not negative; the source domain: the side opposite the leg for a
 * gain, the leg's own for a loss).
 */
export function prepareKfSettlementEntry(m: RemainingAccount, markets: u64, pa: RemainingAccount, legSlot: u64, normalize: boolean): KfPrepared {
  if (legSlot >= 16n) failV16(V16_INVALID_LEG);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const leg = p.legs.get(legSlot);
  checkV16(legErr(leg));
  if (leg.active !== 1n) failV16(V16_INVALID_LEG);
  const asset = toU64(leg.asset_index);
  assetStateOf(m, markets, asset);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  // asset_state has refused an asset past the configured slots or the view.
  if (e.asset.market_id === 0n) failV16(V16_INVALID_LEG);
  const short = leg.side === 1n;
  if (normalize && legHasExhaustedEffectiveOi(e.asset, leg)) {
    checkV16(closeProgressErr(p.close_progress));
    if (!closeHasPendingResidual(p.close_progress) && !hasPendingDomainLossBarrier(m, markets, asset, short)) {
      beginFullDrainResetInner(m, markets, asset, short);
      assetStateOf(m, markets, asset);
    }
  }
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  const kf = legKfDeltaComponents(a, leg);
  const sourceShort = kf.net > 0n ? !short : short;
  const domain = insuranceDomainIndex(m, markets, asset, sourceShort);
  const entry = planKey(kf.net >= 0n ? 1n : 0n, domain, legSlot);
  return { entry, k_now: kf.k_now, f_now: kf.f_now, f_snap_next: kf.f_snap_next, f_delta: kf.f_delta, net: kf.net };
}

/**
 * `apply_account_kf_settlement_entry(account, entry, prepared)`: the key decoded; the leg decoded and active; the asset
 * decoded; InvalidLeg unless the leg's live K/F target, the phase and the source domain still match what was prepared.
 * A gain applied with its source domain; a loss netted at par first, the rest through the haircut-bounded close loss
 * (on a Live market the burned liens' backing paid to the source domain, and the counterparty support booked for it),
 * then the capital-backed part of the new negative PnL reserved for the source domain. The funding flow recorded, the
 * stale K/F cohort settled, the leg's K and F snapshots and K/F epoch written, the health certificate invalidated, the
 * asset written (`set_asset_state`), the market's loss-stale flag set from the asset.
 */
export function applyKfSettlementEntry(m: RemainingAccount, markets: u64, pa: RemainingAccount, prep: KfPrepared): void {
  const key = decodePlanKey(prep.entry);
  const legSlot = key.slot;
  const sourceDomain = key.domain;
  const p0 = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const leg0 = p0.legs.get(legSlot);
  checkV16(legErr(leg0));
  if (leg0.active !== 1n) failV16(V16_INVALID_LEG);
  const asset = toU64(leg0.asset_index);
  const short = leg0.side === 1n;
  assetStateOf(m, markets, asset);
  const target = kfTargetForLeg(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset, leg0);
  const actualShort = prep.net > 0n ? !short : short;
  const phase: u8 = prep.net >= 0n ? 1n : 0n;
  if (target.k !== prep.k_now || target.f !== prep.f_now || key.phase !== phase || sourceDomain !== insuranceDomainIndex(m, markets, asset, actualShort))
    failV16(V16_INVALID_LEG);
  if (prep.net > 0n) applySignedKfDelta(m, markets, pa, prep.net, sourceDomain);
  else if (prep.net < 0n) {
    const pnlBefore = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
    const negBefore = pnlBefore < 0n ? absU(pnlBefore) : 0n;
    const lossAbs = absU(prep.net);
    const netted = settleKfLossBeforeSupport(m, markets, pa, sourceDomain, lossAbs);
    // netted ≤ the loss (settle_kf_loss_before_support returns loss − remaining): no CounterUnderflow.
    const remaining = lossAbs - netted;
    if (remaining !== 0n) {
      if (remaining > I128_MAX_KF) failV16(V16_ARITHMETIC_OVERFLOW);
      const kfDomain = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).mode === MODE_LIVE_KF ? sourceDomain : NO_DOMAIN;
      const support = applyHaircutBoundedCloseLoss(m, markets, pa, remaining, kfDomain);
      if (support.counterparty_support_consumed !== 0n) bookKfLossSupport(m, markets, sourceDomain, support.counterparty_support_consumed);
    }
    const pnlAfter = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
    reserveNewCapitalBackedLoss(m, markets, pa, sourceDomain, negBefore, pnlAfter < 0n ? absU(pnlAfter) : 0n);
  }
  recordAccountFundingFlow(pa, short, prep.f_delta);
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  // set_asset_state's count of the stored asset's blockers, taken before the stale cohort changes it in place.
  const before = slotBlockers(e);
  const epoch = settleKfStaleCohort(e.asset, short, leg0.kf_epoch_snap);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const leg = p.legs.get(legSlot);
  leg.k_snap = prep.k_now;
  leg.f_snap = prep.f_snap_next;
  leg.kf_epoch_snap = epoch;
  p.health_cert.valid = 0n;
  // set_asset_state: the index passed asset_state; the old blockers (CounterOverflow), the new, the total.
  if (before > toU128(U64_MAX_KF)) failV16(V16_COUNTER_OVERFLOW);
  blockersAfter(m, asset, toU64(before));
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  h.loss_stale_active = assetIsLossStaleAt(e.asset, h.current_slot) ? 1n : 0n;
}
