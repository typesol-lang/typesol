// The wire conversions and state checks of the Percolator v16 port (showcase/mainnet/percolator-v16/wire.ts and
// state.ts; Percolator v16 at commit 7b110913, engine 5e3af07, aeyakovenko/percolator-prog and aeyakovenko/percolator,
// Apache-2.0) behind one native entry, for showcase/test/percolator-v16-state.test.ts: the data is an op byte and its
// argument bytes, account 0 receives the answer (Out), account 1 holds the bytes a struct conversion reads.
import { type i128, type u64, i128 as toI128, instructionData, loadRawAt, loadRawMutAt, remainingAccounts, u64 as toU64 } from "typesol";
import {
  assetLifecycleErr,
  assetStateErr,
  backingBucketErr,
  backingBucketStatusErr,
  boolErr,
  closeProgressErr,
  configDecodeErr,
  configShapeErr,
  healthCertErr,
  insuranceReservationErr,
  marketModeErr,
  nonMinI128Err,
  optionalRecoveryReasonErr,
  portfolioLegDecodeErr,
  provenanceHeaderErr,
  recoveryReasonErr,
  resolvedPayoutLedgerErr,
  resolvedPayoutReceiptErr,
  sideErr,
  sideModeErr,
} from "../../mainnet/percolator-v16/wire.js";
import { readI64, readI128 } from "../../mainnet/percolator/wire.js";
import {
  type AssetOracleProfile,
  type AssetState,
  type BackingBucket,
  type CloseProgressLedger,
  type Config,
  type HealthCert,
  type InsuranceCreditReservation,
  type OptionalRecoveryReason,
  type Portfolio,
  type PortfolioLeg,
  type ProvenanceHeader,
  type ResolvedPayoutLedger,
  type ResolvedPayoutReceipt,
  type WrapperConfig,
  type GroupHeader,
  type AssetSlot,
  type BackingDomainLedger,
  type InsuranceLedger,
  type PortfolioMatcherConfig,
  type AccountHeader,
  checkHeader,
  marketSlotCapacity,
  oracleLegConfigOk,
  validateAssetOracleProfile,
  validateWrapperConfig,
} from "../../mainnet/percolator-v16/state.js";

export interface Out {
  code: u64;
  value: i128;
}

/** Every struct of state.ts, named so that the compiler's model holds them all (the layout test reads it). */
export interface AllStructs {
  header: AccountHeader;
  wrapper: WrapperConfig;
  group: GroupHeader;
  slot: AssetSlot;
  portfolio: Portfolio;
  matcher: PortfolioMatcherConfig;
  backing: BackingDomainLedger;
  insurance: InsuranceLedger;
}

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  const out = loadRawMutAt<Out>(rest.get(0n), 0n);
  const op = data.readU8(0n);
  let code: u64 = 0n;
  let value: i128 = 0n;
  if (op === 0n) value = toI128(readI64(data, 1n));
  else if (op === 1n) value = readI128(data, 1n);
  else if (op === 2n) code = boolErr(data.readU8(1n));
  else if (op === 3n) code = sideErr(data.readU8(1n));
  else if (op === 4n) code = sideModeErr(data.readU8(1n));
  else if (op === 5n) code = assetLifecycleErr(data.readU8(1n));
  else if (op === 6n) code = marketModeErr(data.readU8(1n));
  else if (op === 7n) code = backingBucketStatusErr(data.readU8(1n));
  else if (op === 8n) code = recoveryReasonErr(data.readU8(1n));
  else if (op === 9n) code = nonMinI128Err(readI128(data, 1n));
  else if (op === 10n) code = optionalRecoveryReasonErr(loadRawAt<OptionalRecoveryReason>(rest.get(1n), 0n));
  else if (op === 11n) code = provenanceHeaderErr(loadRawAt<ProvenanceHeader>(rest.get(1n), 0n));
  else if (op === 12n) code = configDecodeErr(loadRawAt<Config>(rest.get(1n), 0n));
  else if (op === 13n) code = configShapeErr(loadRawAt<Config>(rest.get(1n), 0n));
  else if (op === 14n) code = assetStateErr(loadRawAt<AssetState>(rest.get(1n), 0n));
  else if (op === 15n) code = backingBucketErr(loadRawAt<BackingBucket>(rest.get(1n), 0n));
  else if (op === 16n) code = insuranceReservationErr(loadRawAt<InsuranceCreditReservation>(rest.get(1n), 0n));
  else if (op === 17n) code = portfolioLegDecodeErr(loadRawAt<PortfolioLeg>(rest.get(1n), 0n));
  else if (op === 18n) code = healthCertErr(loadRawAt<HealthCert>(rest.get(1n), 0n));
  else if (op === 19n) code = closeProgressErr(loadRawAt<CloseProgressLedger>(rest.get(1n), 0n));
  else if (op === 20n) code = resolvedPayoutLedgerErr(loadRawAt<ResolvedPayoutLedger>(rest.get(1n), 0n));
  else if (op === 21n) code = resolvedPayoutReceiptErr(loadRawAt<ResolvedPayoutReceipt>(rest.get(1n), 0n));
  // State checks that fail the instruction with the original's error: the outcome is the answer.
  else if (op === 22n) checkHeader(rest.get(1n), data.readU8(1n));
  else if (op === 23n) value = toI128(marketSlotCapacity(rest.get(1n)));
  else if (op === 24n) validateWrapperConfig(loadRawAt<WrapperConfig>(rest.get(1n), 0n));
  else if (op === 25n) validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(rest.get(1n), 0n));
  else if (op === 26n) {
    const c = loadRawAt<WrapperConfig>(rest.get(1n), 0n);
    code = oracleLegConfigOk(c.oracle_leg_count, c.oracle_leg_flags, c.oracle_leg_feeds) ? 1n : 0n;
  }
  out.code = toU64(code);
  out.value = value;
}
