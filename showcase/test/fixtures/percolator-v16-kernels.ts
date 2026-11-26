// The engine functions of the Percolator v16 port that the settlement of open legs is built from
// (showcase/mainnet/percolator-v16/kernels.ts; Percolator v16 at commit 7b110913, engine 5e3af07, aeyakovenko/percolator,
// Apache-2.0) behind one native entry, for showcase/test/percolator-v16-kernels.test.ts. The data is the function id
// (u8) and eight 16-byte arguments (the table in showcase/test/percolator-v16-kernels.ts); account 0 receives the
// outputs (six u128s, signed ones in two's complement), account 1 is the 2,020-byte scratch (an engine asset slot, a
// leg, a source domain, a resolved-payout ledger and an engine config), changed in place as the function changes it.
// A refusal fails the transaction with the program's mapping of the engine error (`map_v16_error`), a panic as Rust's
// panic, logged as solana-program 1.18 logs one so that the test can read its location.
import {
  type FixedArray,
  type i128,
  type u64,
  type u128,
  fixedArray,
  instructionData,
  loadRawMutAt,
  remainingAccounts,
  require,
  u8 as toU8,
  u128 as toU128,
} from "typesol";
import {
  accountBChunkFromLeg,
  advanceLegBSnap,
  applyBackingUtilizationFeeCharge,
  assetContributesToLossStale,
  assetIsLossStaleAt,
  backingUtilizationFeeQuote,
  backingUtilizationRate,
  beginFullDrainReset,
  bTargetForLeg,
  counterpartyBackingAdd,
  counterpartyBackingExpiry,
  counterpartyLienConsume,
  counterpartyLienCreate,
  counterpartyLienTerminalRelease,
  creditPostSnapshotResidual,
  crystallizeSourceLienFee,
  decodePlanKey,
  floorDivSigned,
  fSnapAfterSettlement,
  fSnapResidualIsSubAtom,
  haircutEffectiveSupport,
  insuranceLienConsume,
  insuranceLienCreate,
  insuranceLienRelease,
  insuranceLienTerminalRelease,
  kfTargetForLeg,
  legHasExhaustedEffectiveOi,
  legKfDeltaComponents,
  mulDivCeilOrWide,
  mulDivFloorOrWide,
  normalizeSocialLossCarry,
  planKey,
  recomputeResolvedPayoutRate,
  recomputeSourceCreditForEpoch,
  scaledAdlDeltaFast,
  settleKfStaleCohort,
  settlePositiveFaceAfterSupport,
  sourceClaimDomainFirstBurnPartition,
  sourceCreditLienAmounts,
  sourceLienBackingRelease,
  sourceLienFaceBurnPartition,
  sourceLienFaceBurnPlan,
  sourceLienFeeAfterRelease,
  sourcePositiveClaimBurn,
  sourceRealizableSupport,
  wideSignedMulDivFloorFromKPair,
} from "../../mainnet/percolator-v16/kernels.js";
import {
  type Config,
  type EngineAssetSlot,
  type PortfolioLeg,
  type PortfolioSourceDomain,
  type ResolvedPayoutLedger,
} from "../../mainnet/percolator-v16/state.js";
import { readI128 } from "../../mainnet/percolator/wire.js";

export const PANIC_STYLE = "solana-1.18";

export interface KernelAnswer {
  values: FixedArray<u128, 6>;
}

export interface KernelScratch {
  slot: EngineAssetSlot;
  leg: PortfolioLeg;
  source: PortfolioSourceDomain;
  ledger: ResolvedPayoutLedger;
  config: Config;
}

const U128_MAX_F: u128 = 0xffffffffffffffffffffffffffffffffn;

/** An i128's two's complement bits as a u128. */
function bits(v: i128): u128 {
  return v < 0n ? U128_MAX_F - toU128(-(v + 1n)) : toU128(v);
}

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  const s = loadRawMutAt<KernelScratch>(rest.get(1n), 0n);
  const f = data.readU8(0n);
  const at = (i: u64): u64 => 1n + 16n * i;
  const u = (i: u64): u128 => data.readU128(at(i));
  const i = (n: u64): i128 => readI128(data, at(n));
  const w = (n: u64): u64 => data.readU64(at(n));
  const out = fixedArray<u128, 6>(0n);
  if (f === 0n) {
    const r = applyBackingUtilizationFeeCharge(u(0n), u(1n), u(2n), i(3n), u(4n));
    out.set(0n, r.charged);
    out.set(1n, r.capital);
    out.set(2n, r.c_tot);
    out.set(3n, r.earnings);
  } else if (f === 1n) out.set(0n, mulDivFloorOrWide(u(0n), u(1n), u(2n)));
  else if (f === 2n) out.set(0n, mulDivCeilOrWide(u(0n), u(1n), u(2n)));
  else if (f === 3n) {
    const r = sourceCreditLienAmounts(u(0n), u(1n));
    out.set(0n, r.a);
    out.set(1n, r.b);
  } else if (f === 4n) out.set(0n, sourceLienBackingRelease(u(0n), u(1n), u(2n)));
  else if (f === 5n) out.set(0n, sourceLienFeeAfterRelease(u(0n), u(1n), u(2n)));
  else if (f === 6n) {
    const r = sourceLienFaceBurnPartition(u(0n), u(1n), u(2n));
    out.set(0n, r.a);
    out.set(1n, r.b);
  } else if (f === 7n) {
    const r = sourceLienFaceBurnPlan(u(0n), u(1n), u(2n), u(3n), u(4n));
    out.set(0n, r.counterparty_face_burn);
    out.set(1n, r.insurance_face_burn);
    out.set(2n, r.counterparty_backing_release);
    out.set(3n, r.insurance_backing_release);
    out.set(4n, r.backing_release);
  } else if (f === 8n) out.set(0n, crystallizeSourceLienFee(s.source, u(0n)));
  else if (f === 9n) out.set(0n, toU128(settleKfStaleCohort(s.slot.asset, data.readU8(at(0n)) === 1n, w(1n))));
  else if (f === 10n) out.set(0n, toU128(recomputeSourceCreditForEpoch(s.slot.source_credit_long, w(0n), w(1n))));
  else if (f === 11n) sourcePositiveClaimBurn(s.slot.source_credit_long, u(0n));
  else if (f === 12n) {
    const r = sourceClaimDomainFirstBurnPartition(u(0n), u(1n));
    out.set(0n, r.a);
    out.set(1n, r.b);
  } else if (f === 13n) {
    const r = settlePositiveFaceAfterSupport(u(0n), u(1n), u(2n));
    out.set(0n, bits(r.pnl));
    out.set(1n, r.face_burned);
  } else if (f === 14n) recomputeResolvedPayoutRate(s.ledger);
  else if (f === 15n) out.set(0n, creditPostSnapshotResidual(s.ledger, u(0n), u(1n)));
  else if (f === 16n) advanceLegBSnap(s.leg, u(0n), u(1n), u(2n));
  else if (f === 17n) {
    const r = normalizeSocialLossCarry(u(0n), u(1n), u(2n));
    out.set(0n, r.a);
    out.set(1n, r.b);
  } else if (f === 18n) beginFullDrainReset(s.slot.asset, data.readU8(at(0n)) === 1n);
  else if (f === 19n) counterpartyLienCreate(s.slot.backing_long, s.slot.source_credit_long, w(0n), u(1n));
  else if (f === 20n) counterpartyBackingAdd(s.slot.backing_long, s.slot.source_credit_long, u(0n), w(1n), w(2n));
  else if (f === 21n) counterpartyBackingExpiry(s.slot.backing_long, s.slot.source_credit_long, w(0n));
  else if (f === 22n) counterpartyLienTerminalRelease(s.slot.backing_long, s.slot.source_credit_long, u(0n));
  else if (f === 23n) counterpartyLienConsume(s.slot.backing_long, s.slot.source_credit_long, u(0n));
  else if (f === 24n) {
    const r = insuranceLienConsume(s.slot.insurance_reservation_long, s.slot.source_credit_long, u(0n), u(1n), u(2n));
    out.set(0n, r.a);
    out.set(1n, r.b);
  } else if (f === 25n) insuranceLienCreate(s.slot.insurance_reservation_long, s.slot.source_credit_long, u(0n));
  else if (f === 26n) insuranceLienRelease(s.slot.insurance_reservation_long, s.slot.source_credit_long, u(0n));
  else if (f === 27n) insuranceLienTerminalRelease(s.slot.insurance_reservation_long, s.slot.source_credit_long, u(0n));
  else if (f === 28n) out.set(0n, sourceRealizableSupport(s.slot.source_credit_long, u(0n)));
  else if (f === 29n) out.set(0n, toU128(backingUtilizationRate(s.config, s.slot.source_credit_long)));
  else if (f === 30n) out.set(0n, backingUtilizationFeeQuote(s.config, s.slot.source_credit_long, u(0n), w(1n), w(2n)));
  else if (f === 31n) out.set(0n, toU128(planKey(toU8(data.readU8(at(0n))), w(1n), w(2n))));
  else if (f === 32n) {
    const r = decodePlanKey(w(0n));
    out.set(0n, toU128(r.phase));
    out.set(1n, toU128(r.domain));
    out.set(2n, toU128(r.slot));
  } else if (f === 33n) {
    const r = scaledAdlDeltaFast(u(0n), u(1n), i(2n), i(3n));
    out.set(0n, toU128(r.some));
    out.set(1n, bits(r.value));
  } else if (f === 34n) out.set(0n, bits(fSnapAfterSettlement(u(0n), u(1n), i(2n), i(3n), i(4n))));
  else if (f === 35n) out.set(0n, fSnapResidualIsSubAtom(u(0n), u(1n), i(2n), i(3n)) ? 1n : 0n);
  else if (f === 36n) out.set(0n, haircutEffectiveSupport(u(0n), u(1n), u(2n)));
  else if (f === 37n) {
    out.set(0n, assetIsLossStaleAt(s.slot.asset, w(0n)) ? 1n : 0n);
    out.set(1n, assetContributesToLossStale(s.slot.asset) ? 1n : 0n);
  } else if (f === 38n) {
    const r = kfTargetForLeg(s.slot.asset, s.leg);
    out.set(0n, bits(r.k));
    out.set(1n, bits(r.f));
  } else if (f === 39n) out.set(0n, bTargetForLeg(s.slot.asset, s.leg));
  else if (f === 40n) {
    const r = legKfDeltaComponents(s.slot.asset, s.leg);
    out.set(0n, bits(r.k_now));
    out.set(1n, bits(r.f_now));
    out.set(2n, bits(r.k_delta));
    out.set(3n, bits(r.f_delta));
    out.set(4n, bits(r.net));
    out.set(5n, bits(r.f_snap_next));
  } else if (f === 41n) {
    const r = accountBChunkFromLeg(s.leg, u(0n), u(1n), u(2n));
    out.set(0n, r.delta_b);
    out.set(1n, r.loss);
    out.set(2n, r.new_remainder);
    out.set(3n, r.remaining_after);
  } else if (f === 42n) out.set(0n, legHasExhaustedEffectiveOi(s.slot.asset, s.leg) ? 1n : 0n);
  else if (f === 43n) out.set(0n, bits(wideSignedMulDivFloorFromKPair(u(0n), i(1n), i(2n), u(3n))));
  else if (f === 44n) out.set(0n, bits(floorDivSigned(i(0n), u(1n))));
  else require(false, 1n);
  const answer = loadRawMutAt<KernelAnswer>(rest.get(0n), 0n);
  for (let n = 0n; n < 6n; n++) answer.values.set(n, out.get(n));
}
