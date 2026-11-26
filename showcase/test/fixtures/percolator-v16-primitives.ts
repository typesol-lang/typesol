// The market-view accessors and the backing and lien primitives of the Percolator v16 port
// (showcase/mainnet/percolator-v16/primitives.ts; Percolator v16 at commit 7b110913, engine 5e3af07,
// aeyakovenko/percolator, Apache-2.0) behind one native entry, for showcase/test/percolator-v16-primitives.test.ts. The
// data is the function id (u8) and eight 16-byte arguments (the table in showcase/test/percolator-v16-primitives.ts);
// account 0 receives the outputs (six u128s), account 1 is the market, account 2 the portfolio, each changed in place
// as the function changes it. A refusal fails the transaction with the program's mapping of the engine error
// (`map_v16_error`). Where the original takes a struct value read from the accounts, this program reads it the way the
// original's callers do and the port's function changes the accounts in place.
import {
  type FixedArray,
  type Inout,
  type InstructionBytes,
  type RemainingAccount,
  type i128,
  type u64,
  type u128,
  fixedArray,
  instructionData,
  loadRawAt,
  loadRawMutAt,
  remainingAccounts,
  require,
  i128 as toI128,
  u8 as toU8,
  u128 as toU128,
} from "typesol";
import {
  type KfLossLienPayment,
  NO_SLOT,
  accountSourceClaimBoundSum,
  activeLegForAsset,
  activeLegSlotForAssetBitmap,
  addAccountCounter,
  addFreshCounterpartyBacking,
  adjustProviderPrincipal,
  assetStateOf,
  bucketAt,
  bucketForDomain,
  bucketRawStatusExpiry,
  closeHasPendingResidual,
  collectBackingUtilizationFee,
  consumeCounterpartyLien,
  createAndConsumeCounterpartyCore,
  createAndConsumeCounterpartyParts,
  createAndConsumeInsuranceCore,
  createAndConsumeInsuranceParts,
  creditPostSnapshotResidualMarket,
  domainAssetSide,
  domainBudgetRemainingParts,
  domainInsuranceBudgetSpent,
  domainIsSparseTailDefault,
  encumbranceProofForDomain,
  encumbranceProofForParts,
  ensureAccountSourceClaimMarketId,
  expireSourceBackingBucket,
  faceClaimToBurnForSupport,
  freshCounterpartyBackingExpiry,
  hasBStaleLeg,
  hasPendingDomainLossBarrier,
  insuranceDomainIndex,
  juniorClaimBound,
  kfLossLienBackingToConsume,
  loserPaidBacking,
  lossBucketAcceptsFresh,
  pendingDomainLossBarrierCount,
  providerPrincipal,
  recomputeSourceCreditAfterMutations,
  refreshSourceCreditAfterMutation,
  releaseCounterpartyLienTerminal,
  releaseInsuranceLien,
  releaseInsuranceLienTerminal,
  releaseProviderPrincipalAfter,
  requireActiveLegSlotForAsset,
  reservationAt,
  reservationForDomain,
  resetSourceDomainSlotIfEmpty,
  residual,
  resolvedLossBackingCapacity,
  setBucketEarnings,
  setDomainInsuranceSpent,
  setDomainInsuranceSpentDelta,
  setSourceCreditTotals,
  slotUnlienedClaim,
  sourceAt,
  sourceClaimUnliened,
  sourceCreditAvailableBacking,
  sourceDomainSlotMut,
  sourceDomainSlotOrInsert,
  sourceDomainSlotView,
  sourceForDomain,
  sourceForDomainShape,
  sourceTotalsAt,
  storedSourceCreditRate,
  twinLoserPaidShare,
  validateDomainLedger,
  validateDomainLedgerCurrent,
  validateInsuranceToCloseInsuranceSpent,
} from "../../mainnet/percolator-v16/primitives.js";
import { checkV16 } from "../../mainnet/percolator-v16/errors.js";
import {
  burnImpairedSourceClaimFields,
  counterpartyImpairedLienRetirement,
  impairAccountCounterpartyLienFields,
  prepareCounterpartyLienImpairment,
  reconcileImpairedCounterpartyLienAtSlot,
  reconcileImpairedCounterpartyLiens,
  releaseOrRetireCounterpartyLien,
  retireCounterpartyImpairedLien,
} from "../../mainnet/percolator-v16/impairment.js";
import {
  NO_DOMAIN,
  burnSourceClaimAtSlotUpTo,
  burnSourceClaimBoundNum,
  burnSourceClaimDomainFirst,
  burnSourceLienFace,
  consumeSourceDomainCreditForEffective,
  consumeValidatedAccountSourceCredit,
  decrementSourceClaim,
  setAccountPnl,
  setAccountPnlAfterDomainFirstBurn,
  setAccountPnlAfterKfLossClaimBurn,
  setAccountPnlAfterSourceClaimBurn,
  setAccountPnlWithSource,
  sourceDomainProspectiveSupport,
} from "../../mainnet/percolator-v16/claims.js";
import {
  type KfLossDomainCredit,
  type ParNettingBatch,
  applyHaircutBoundedCloseLoss,
  applyKfSettlementEntry,
  applySignedKfDelta,
  beginFullDrainResetInner,
  bookKfLossSupport,
  bookRealizedKfLoss,
  cancelLossDomainFaceAtPar,
  netSlotFaceAtPar,
  payKfLossFromFreeCapital,
  prepareKfSettlementEntry,
  recordAccountFundingFlow,
  reserveNewCapitalBackedLoss,
  settleKfLossBeforeSupport,
} from "../../mainnet/percolator-v16/kfsettle.js";
import {
  type BSettlement,
  accountBSettlementChunk,
  bTargetForLegAt,
  clearAccountBStale,
  markAccountBStale,
  markLegBStale,
  settleAccountBChunk,
  settleAccountKfEffects,
  settleAccountSideEffects,
} from "../../mainnet/percolator-v16/settlement.js";
import { engineSlotAt, legErr, marketShapeErr, validateWithMarket } from "../../mainnet/percolator-v16/engine.js";
import { closeProgressErr } from "../../mainnet/percolator-v16/wire.js";
import {
  type BackingBucket,
  type EngineAssetSlot,
  type GroupHeader,
  type InsuranceCreditReservation,
  type Portfolio,
  type SourceCreditState,
  HEADER_LEN,
  MARKET_GROUP_OFF,
  marketSlotCapacity,
} from "../../mainnet/percolator-v16/state.js";

export const PANIC_STYLE = "solana-1.18";
/** As the port's program: native views of one account may be loaded writable more than once. */
export const NATIVE_ACCOUNT_WRITES = true;

export interface PrimitiveAnswer {
  values: FixedArray<u128, 6>;
}

const U128_MAX_F: u128 = 0xffffffffffffffffffffffffffffffffn;

/** An i128's two's complement bits as a u128. */
function bits(v: i128): u128 {
  return v < 0n ? U128_MAX_F - toU128(-(v + 1n)) : toU128(v);
}

const I128_MAX_F: u128 = 0x7fffffffffffffffffffffffffffffffn;
/** A u128's bits as an i128 (two's complement). */
function signed(v: u128): i128 {
  return v > I128_MAX_F ? -toI128(U128_MAX_F - v) - 1n : toI128(v);
}

/** A B settlement's outcome into the outputs. */
function bOut(out: Inout<FixedArray<u128, 6>>, c: BSettlement): void {
  out.set(0n, toU128(c.current));
  out.set(1n, c.delta_b);
  out.set(2n, c.loss);
  out.set(3n, c.new_remainder);
  out.set(4n, c.remaining_after);
}

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  const out = fixedArray<u128, 6>(0n);
  dispatch(rest.get(1n), rest.get(2n), data, out);
  const answer = loadRawMutAt<PrimitiveAnswer>(rest.get(0n), 0n);
  for (let n = 0n; n < 6n; n++) answer.values.set(n, out.get(n));
}

/** One function of the table on the market `m` and the portfolio `pa`; its outputs into `out`. */
function dispatch(m: RemainingAccount, pa: RemainingAccount, data: InstructionBytes, out: Inout<FixedArray<u128, 6>>): void {
  const markets = marketSlotCapacity(m);
  const f = data.readU8(0n);
  const at = (i: u64): u64 => 1n + 16n * i;
  const u = (i: u64): u128 => data.readU128(at(i));
  const w = (n: u64): u64 => data.readU64(at(n));
  const d = w(0n);
  if (f === 0n) {
    out.set(0n, toU128(domainAssetSide(m, markets, d)));
    out.set(1n, toU128(d % 2n));
  } else if (f === 1n) {
    require(u(1n) <= 1n, 1n);
    out.set(0n, toU128(insuranceDomainIndex(m, markets, d, u(1n) === 1n)));
  } else if (f === 2n) {
    sourceForDomain(m, markets, d);
    out.set(0n, loadRawAt<SourceCreditState>(m, sourceAt(d)).credit_rate_num);
  } else if (f === 3n) {
    sourceForDomainShape(m, markets, d);
    out.set(0n, loadRawAt<SourceCreditState>(m, sourceAt(d)).credit_rate_num);
  } else if (f === 4n) out.set(0n, storedSourceCreditRate(m, markets, d));
  else if (f === 5n) out.set(0n, providerPrincipal(m, markets, d));
  else if (f === 6n) out.set(0n, loserPaidBacking(m, markets, d));
  else if (f === 7n) out.set(0n, toU128(bucketForDomain(m, markets, d)));
  else if (f === 8n) {
    const r = bucketRawStatusExpiry(m, markets, d);
    out.set(0n, toU128(r.status));
    out.set(1n, toU128(r.expiry));
  } else if (f === 9n) reservationForDomain(m, markets, d);
  else if (f === 10n) out.set(0n, toU128(freshCounterpartyBackingExpiry(m, markets, d)));
  else if (f === 11n) {
    const r = domainInsuranceBudgetSpent(m, markets, d);
    out.set(0n, r.budget);
    out.set(1n, r.spent);
  } else if (f === 12n) {
    const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
    out.set(0n, residual(m));
    out.set(1n, juniorClaimBound(m));
    out.set(2n, h.backing_provider_earnings_total);
    out.set(3n, h.source_fresh_backing_total_num / 1000000000000n);
  } else if (f === 13n) out.set(0n, domainBudgetRemainingParts(u(0n), u(1n)));
  else if (f === 15n) {
    // set_source_credit_for_domain(domain, the stored state with three amounts replaced): its domain_asset_side, the
    // old state's shape, the totals of the change.
    domainAssetSide(m, markets, d);
    sourceForDomainShape(m, markets, d);
    const old = sourceTotalsAt(m, d);
    const s = loadRawMutAt<SourceCreditState>(m, sourceAt(d));
    s.positive_claim_bound_num = u(1n);
    s.insurance_credit_reserved_num = u(2n);
    s.fresh_reserved_backing_num = u(3n);
    setSourceCreditTotals(m, markets, d, old);
  } else if (f === 16n) {
    const expiry = bucketForDomain(m, markets, d);
    setBucketEarnings(m, markets, d, u(1n), expiry);
  } else if (f === 17n) {
    domainAssetSide(m, markets, d);
    const r = loadRawMutAt<InsuranceCreditReservation>(m, reservationAt(d));
    r.consumed_insurance_num = u(1n);
  } else if (f === 18n) adjustProviderPrincipal(m, markets, d, u(1n), u(2n) !== 0n);
  else if (f === 19n) releaseProviderPrincipalAfter(m, markets, d, u(1n), u(2n));
  else if (f === 20n) out.set(0n, setDomainInsuranceSpentDelta(u(0n), u(1n), u(2n), u(3n), u(4n)));
  else if (f === 21n) setDomainInsuranceSpent(m, markets, d, u(1n));
  else if (f === 22n) validateDomainLedger(m, markets, d);
  else if (f === 23n) validateDomainLedgerCurrent(m, markets, d);
  else if (f === 24n) recomputeSourceCreditAfterMutations(m, markets, d, 1n);
  else if (f === 25n) recomputeSourceCreditAfterMutations(m, markets, d, w(1n));
  else if (f === 26n) refreshSourceCreditAfterMutation(m, markets, d);
  else if (f === 27n) encumbranceProofForDomain(m, markets, d);
  else if (f === 28n) {
    sourceForDomain(m, markets, d);
    bucketForDomain(m, markets, d);
    reservationForDomain(m, markets, d);
    encumbranceProofForParts(m, markets, d);
  } else if (f === 29n || f === 31n) addFreshCounterpartyBacking(m, markets, d, u(1n), w(2n), 1n);
  else if (f === 30n || f === 32n) addFreshCounterpartyBacking(m, markets, d, u(1n), w(2n), w(3n));
  else if (f === 33n) expireSourceBackingBucket(m, markets, d, w(1n));
  else if (f === 34n) creditPostSnapshotResidualMarket(m, u(0n));
  else if (f === 35n) releaseCounterpartyLienTerminal(m, markets, d, u(1n));
  else if (f === 36n) consumeCounterpartyLien(m, markets, d, u(1n));
  else if (f === 37n) releaseInsuranceLien(m, markets, d, u(1n));
  else if (f === 38n) releaseInsuranceLienTerminal(m, markets, d, u(1n));
  else if (f === 39n) createAndConsumeCounterpartyCore(m, markets, d, u(1n));
  else if (f === 40n) {
    // The parts as `consume_validated_account_source_credit_not_atomic` reads them.
    sourceForDomainShape(m, markets, d);
    const expiry = bucketForDomain(m, markets, d);
    reservationForDomain(m, markets, d);
    createAndConsumeCounterpartyParts(m, markets, d, expiry, u(1n), u(2n));
  } else if (f === 41n) createAndConsumeInsuranceCore(m, markets, d, u(1n));
  else if (f === 42n) {
    sourceForDomainShape(m, markets, d);
    bucketForDomain(m, markets, d);
    reservationForDomain(m, markets, d);
    createAndConsumeInsuranceParts(m, markets, d, u(1n), u(2n));
  } else if (f === 43n) validateInsuranceToCloseInsuranceSpent(u(0n), u(1n), u(2n));
  else if (f === 44n) out.set(0n, sourceCreditAvailableBacking(m, markets, d));
  else if (f === 45n) out.set(0n, faceClaimToBurnForSupport(u(0n), u(1n), u(2n)));
  else if (f === 46n) out.set(0n, twinLoserPaidShare(m, markets, d, u(1n), u(2n)));
  else if (f === 47n) out.set(0n, lossBucketAcceptsFresh(m, markets, d) ? 1n : 0n);
  else if (f === 48n) out.set(0n, resolvedLossBackingCapacity(m, markets, d));
  else if (f === 49n) {
    require(u(1n) <= 1n, 1n);
    out.set(0n, toU128(pendingDomainLossBarrierCount(m, markets, d, u(1n) === 1n)));
    out.set(1n, hasPendingDomainLossBarrier(m, markets, d, u(1n) === 1n) ? 1n : 0n);
  } else if (f === 50n) {
    require(u(2n) <= 2n, 1n);
    const payment: KfLossLienPayment = { loss_domain: w(1n), loss_side_open: toU8(u(2n)), consumed_atoms: u(3n) };
    out.set(0n, kfLossLienBackingToConsume(m, markets, d, payment, u(4n), u(5n)));
    out.set(1n, toU128(payment.loss_side_open));
    out.set(2n, payment.consumed_atoms);
  } else if (f === 51n) out.set(0n, addAccountCounter(u(0n), u(1n)));
  else if (f === 52n || f === 53n) {
    const slot = f === 52n ? sourceDomainSlotView(pa, d) : sourceDomainSlotMut(pa, d);
    if (slot !== NO_SLOT) {
      out.set(0n, 1n);
      out.set(1n, toU128(slot));
    }
  } else if (f === 54n) out.set(0n, toU128(sourceDomainSlotOrInsert(pa, d)));
  else if (f === 55n) out.set(0n, resetSourceDomainSlotIfEmpty(pa, d) ? 1n : 0n);
  else if (f === 56n) {
    const sum = accountSourceClaimBoundSum(pa);
    out.set(0n, sum);
    out.set(1n, sum !== 0n ? 1n : 0n);
  } else if (f === 57n) out.set(0n, sourceClaimUnliened(pa, d));
  else if (f === 58n) out.set(0n, slotUnlienedClaim(loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(d % 32n)));
  else if (f === 59n) out.set(0n, domainIsSparseTailDefault(loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(d % 32n)) ? 1n : 0n);
  else if (f === 60n) out.set(0n, hasBStaleLeg(pa) ? 1n : 0n);
  else if (f === 61n) {
    const slot = activeLegSlotForAssetBitmap(pa, d);
    if (slot !== NO_SLOT) {
      out.set(0n, 1n);
      out.set(1n, toU128(slot));
    }
  } else if (f === 62n) out.set(0n, toU128(requireActiveLegSlotForAsset(pa, d)));
  else if (f === 63n) {
    // active_leg_for_asset: the slot's leg, or the EMPTY leg (zero in these three fields).
    const slot = activeLegForAsset(pa, d);
    if (slot !== NO_SLOT) {
      const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
      const l = p.legs.get(slot);
      out.set(0n, toU128(l.active));
      out.set(1n, toU128(l.asset_index));
      out.set(2n, bits(l.k_snap));
    }
  } else if (f === 64n) {
    assetStateOf(m, markets, d);
    out.set(0n, toU128(loadRawAt<EngineAssetSlot>(m, engineSlotAt(d)).asset.lifecycle));
  } else if (f === 65n) {
    const c = loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress;
    checkV16(closeProgressErr(c));
    out.set(0n, closeHasPendingResidual(c) ? 1n : 0n);
  } else if (f === 66n) ensureAccountSourceClaimMarketId(m, markets, pa, d);
  else if (f === 67n) out.set(0n, collectBackingUtilizationFee(m, markets, pa, d));
  else if (f === 69n) {
    const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
    out.set(0n, prepareCounterpartyLienImpairment(p.source_domains.get(d % 32n)));
  } else if (f === 70n) {
    domainAssetSide(m, markets, d);
    const b = loadRawMutAt<BackingBucket>(m, bucketAt(d));
    // A status byte that does not decode is no input to the original (the test skips it).
    require(b.status <= 3n, 1n);
    const s = loadRawMutAt<SourceCreditState>(m, sourceAt(d));
    counterpartyImpairedLienRetirement(b, s, u(1n));
  } else if (f === 71n) retireCounterpartyImpairedLien(m, markets, d, u(1n));
  else if (f === 72n) releaseOrRetireCounterpartyLien(m, markets, d, u(1n));
  else if (f === 73n) {
    const r = burnImpairedSourceClaimFields(pa, d, u(1n));
    out.set(0n, r.a);
    out.set(1n, r.b);
  } else if (f === 74n) out.set(0n, impairAccountCounterpartyLienFields(pa, d));
  else if (f === 75n) reconcileImpairedCounterpartyLienAtSlot(m, markets, pa, d);
  else if (f === 76n) reconcileImpairedCounterpartyLiens(m, markets, pa);
  else if (f === 77n) decrementSourceClaim(m, markets, pa, d, w(1n), u(2n));
  else if (f === 78n || f === 79n || f === 80n || f === 88n) {
    require(u(4n) <= 1n && u(6n) <= 2n, 1n);
    const pay: KfLossLienPayment = { loss_domain: w(5n), loss_side_open: toU8(u(6n)), consumed_atoms: u(7n) };
    const has = u(4n) === 1n;
    if (f === 78n) burnSourceLienFace(m, markets, pa, d, w(1n), u(2n), pay, has);
    else if (f === 79n) out.set(0n, burnSourceClaimAtSlotUpTo(m, markets, pa, d, w(1n), u(2n), pay, has));
    else if (f === 80n) burnSourceClaimBoundNum(m, markets, pa, u(0n), pay, has);
    else setAccountPnlAfterKfLossClaimBurn(m, markets, pa, signed(u(0n)), u(1n), pay, has);
    out.set(1n, toU128(pay.loss_side_open));
    out.set(2n, pay.consumed_atoms);
  } else if (f === 81n) burnSourceClaimDomainFirst(m, markets, pa, d, u(1n));
  else if (f === 82n) out.set(0n, sourceDomainProspectiveSupport(m, markets, d, u(1n)));
  else if (f === 83n) {
    const c = consumeSourceDomainCreditForEffective(m, markets, d, u(1n));
    out.set(0n, c.face_burn);
    out.set(1n, c.counterparty_credit_consumed);
    out.set(2n, c.insurance_credit_consumed);
  } else if (f === 84n) {
    require(u(1n) <= 1n && u(2n) <= 1n, 1n);
    const c = consumeValidatedAccountSourceCredit(m, markets, pa, u(0n), u(1n) === 1n, u(2n) === 1n);
    out.set(0n, c.face_burn);
    out.set(1n, c.counterparty_credit_consumed);
    out.set(2n, c.insurance_credit_consumed);
    out.set(3n, c.burned_num);
    out.set(4n, c.consumed);
  } else if (f === 85n) setAccountPnl(m, markets, pa, signed(u(0n)));
  else if (f === 86n) setAccountPnlWithSource(m, markets, pa, signed(u(0n)), w(1n));
  else if (f === 87n) setAccountPnlAfterSourceClaimBurn(m, markets, pa, signed(u(0n)), u(1n));
  else if (f === 89n) setAccountPnlAfterDomainFirstBurn(m, markets, pa, signed(u(0n)), w(1n));
  else if (f === 90n) {
    require(u(0n) <= 1n, 1n);
    recordAccountFundingFlow(pa, u(0n) === 1n, signed(u(1n)));
  } else if (f === 91n) out.set(0n, settleKfLossBeforeSupport(m, markets, pa, d, u(1n)));
  else if (f === 92n || f === 93n) {
    const batch: ParNettingBatch = { face_left: u(4n), loss_left: u(5n), netted: 0n, netted_num: 0n, transfer_num: 0n, expiry_slot: w(6n) };
    require(d < 32n, 1n);
    if (f === 92n) {
      require(u(2n) <= 1n && u(3n) <= 1n, 1n);
      netSlotFaceAtPar(m, markets, pa, d, w(1n), u(2n) === 1n, u(3n) === 1n, batch);
    } else {
      let netted = u(1n);
      if (batch.loss_left < netted) netted = batch.loss_left;
      if (batch.face_left < netted) netted = batch.face_left;
      require(netted !== 0n, 1n);
      cancelLossDomainFaceAtPar(m, markets, pa, d, netted, batch);
    }
    out.set(0n, batch.netted);
    out.set(1n, batch.netted_num);
    out.set(2n, batch.transfer_num);
    out.set(3n, batch.loss_left);
    out.set(4n, batch.face_left);
    out.set(5n, toU128(batch.expiry_slot));
  } else if (f === 94n) {
    const credit: KfLossDomainCredit = { amount_num: u(2n), expiry_slot: w(3n), payments: w(4n) };
    out.set(0n, payKfLossFromFreeCapital(m, markets, pa, d, u(1n), credit));
    out.set(1n, credit.amount_num);
    out.set(2n, toU128(credit.expiry_slot));
    out.set(3n, toU128(credit.payments));
  } else if (f === 95n || f === 96n) {
    require(u(1n) <= 1n, 1n);
    const domain = u(1n) === 1n ? w(2n) : NO_DOMAIN;
    const r = f === 95n ? applyHaircutBoundedCloseLoss(m, markets, pa, u(0n), domain) : applySignedKfDelta(m, markets, pa, signed(u(0n)), domain);
    out.set(0n, r.support_consumed);
    out.set(1n, r.junior_face_burned);
    out.set(2n, r.counterparty_support_consumed);
  } else if (f === 97n) reserveNewCapitalBackedLoss(m, markets, pa, d, u(1n), u(2n));
  else if (f === 98n) bookKfLossSupport(m, markets, d, u(1n));
  else if (f === 99n) out.set(0n, bookRealizedKfLoss(m, markets, d, u(1n)));
  else if (f === 100n || f === 101n) {
    require(u(1n) <= 1n, 1n);
    const prep = prepareKfSettlementEntry(m, markets, pa, d, u(1n) === 1n);
    if (f === 101n) applyKfSettlementEntry(m, markets, pa, prep);
    out.set(0n, toU128(prep.entry));
    out.set(1n, bits(prep.k_now));
    out.set(2n, bits(prep.f_now));
    out.set(3n, bits(prep.f_snap_next));
    out.set(4n, bits(prep.f_delta));
    out.set(5n, bits(prep.net));
  } else if (f === 102n) {
    require(u(1n) <= 1n, 1n);
    beginFullDrainResetInner(m, markets, d, u(1n) === 1n);
  } else if (f === 103n) {
    const slot = w(1n) % 16n;
    checkV16(legErr(loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot)));
    out.set(0n, bTargetForLegAt(m, markets, d, slot, pa));
  } else if (f === 104n) markAccountBStale(m, pa);
  else if (f === 105n) clearAccountBStale(m, pa);
  else if (f === 106n) markLegBStale(m, pa, d);
  else if (f === 107n) bOut(out, accountBSettlementChunk(m, markets, pa, d, u(1n)));
  else if (f === 108n) bOut(out, settleAccountBChunk(m, markets, pa, d, u(1n)));
  else if (f === 110n) {
    bOut(out, settleAccountSideEffects(m, markets, pa, u(0n)));
  } else if (f === 109n) {
    require(u(0n) <= 1n, 1n);
    settleAccountKfEffects(m, markets, pa, u(0n) === 1n);
  } else if (f === 68n) {
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    validateWithMarket(m, pa, markets);
  } else require(false, 1n);
}
