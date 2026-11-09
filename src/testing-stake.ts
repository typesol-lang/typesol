/**
 * Epochs and staking for `typesol/testing` (re-exported from there): move LiteSVM's Clock to an epoch, keep a
 * StakeHistory sysvar that rate-limits warmup and cooldown as a cluster does, and build vote and stake accounts.
 *
 * LiteSVM alone does neither: `warpToSlot` leaves Clock.epoch where it was, and its StakeHistory stays empty, so the
 * Stake program finds no history and takes every delegation as fully active one epoch after it was made.
 */
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM, StakeHistory, StakeHistoryEntry, type TransactionMetadata } from "litesvm";

export const STAKE_PROGRAM_ADDRESS = "Stake11111111111111111111111111111111111111" as Address;
export const VOTE_PROGRAM_ADDRESS = "Vote111111111111111111111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111" as Address;
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111" as Address;
const STAKE_HISTORY_SYSVAR = "SysvarStakeHistory1111111111111111111111111" as Address;
const STAKE_CONFIG = "StakeConfig11111111111111111111111111111111" as Address;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
/** Size of a stake account (StakeStateV2). */
export const STAKE_ACCOUNT_SIZE = 200n;
/** Size of a vote account. */
export const VOTE_ACCOUNT_SIZE = 3762n;
/** StakeHistory keeps this many epochs, newest first. */
export const STAKE_HISTORY_MAX_ENTRIES = 512;

// ---------------------------------------------------------------------------------------------------------------
// Epoch schedule and Clock

/** The EpochSchedule sysvar's fields (LiteSVM's `EpochSchedule` has them). */
export interface EpochScheduleLike {
  slotsPerEpoch: bigint;
  leaderScheduleSlotOffset: bigint;
  warmup: boolean;
  firstNormalEpoch: bigint;
  firstNormalSlot: bigint;
}

const MINIMUM_SLOTS_PER_EPOCH = 32n;
const log2Ceil = (n: bigint): bigint => {
  // trailing_zeros(next_power_of_two(n)) for n >= 1
  let k = 0n;
  while (1n << k < n) k++;
  return k;
};
const satSub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/** The epoch of `slot` and the slot's index in it (EpochSchedule::get_epoch_and_slot_index). */
export function epochAndSlotIndex(schedule: EpochScheduleLike, slot: bigint): { epoch: bigint; slotIndex: bigint } {
  if (slot < schedule.firstNormalSlot) {
    const epoch = satSub(satSub(log2Ceil(slot + MINIMUM_SLOTS_PER_EPOCH + 1n), 5n), 1n);
    const epochLen = 1n << (epoch + 5n);
    return { epoch, slotIndex: satSub(slot, satSub(epochLen, MINIMUM_SLOTS_PER_EPOCH)) };
  }
  const normal = slot - schedule.firstNormalSlot;
  const per = schedule.slotsPerEpoch;
  return { epoch: schedule.firstNormalEpoch + (per === 0n ? 0n : normal / per), slotIndex: per === 0n ? 0n : normal % per };
}

/** The first slot of `epoch` (EpochSchedule::get_first_slot_in_epoch). */
export function firstSlotInEpoch(schedule: EpochScheduleLike, epoch: bigint): bigint {
  if (epoch <= schedule.firstNormalEpoch) return ((1n << epoch) - 1n) * MINIMUM_SLOTS_PER_EPOCH;
  return (epoch - schedule.firstNormalEpoch) * schedule.slotsPerEpoch + schedule.firstNormalSlot;
}

/** The epoch whose leader schedule is known at `slot` (EpochSchedule::get_leader_schedule_epoch). */
export function leaderScheduleEpoch(schedule: EpochScheduleLike, slot: bigint): bigint {
  if (slot < schedule.firstNormalSlot) return epochAndSlotIndex(schedule, slot).epoch + 1n;
  const since = slot - schedule.firstNormalSlot + schedule.leaderScheduleSlotOffset;
  return schedule.firstNormalEpoch + (schedule.slotsPerEpoch === 0n ? 0n : since / schedule.slotsPerEpoch);
}

export interface WarpOptions {
  /** Seconds the Clock's unixTimestamp advances per slot (default 0.4, millisecond precision). */
  secondsPerSlot?: number;
}

interface ClockValue {
  slot: bigint;
  epoch: bigint;
  leaderScheduleEpoch: bigint;
  epochStartTimestamp: bigint;
  unixTimestamp: bigint;
}

/** The Clock at the first slot of `epoch`, from `svm`'s Clock and EpochSchedule. */
function clockAtEpoch(svm: LiteSVM, epoch: bigint, opts: WarpOptions = {}): ClockValue | null {
  const clock = svm.getClock();
  if (epoch < clock.epoch) throw new Error(`warpToEpoch: epoch ${epoch} is before the current epoch ${clock.epoch}`);
  if (epoch === clock.epoch) return null;
  const schedule = svm.getEpochSchedule();
  const slot = firstSlotInEpoch(schedule, epoch);
  // The time that passes: from the current slot, or from the start of the Clock's epoch when the slot is not in it
  // (a new LiteSVM's Clock has epoch 0 at slot 454464000).
  const from = epochAndSlotIndex(schedule, clock.slot).epoch === clock.epoch ? clock.slot : firstSlotInEpoch(schedule, clock.epoch);
  const msPerSlot = BigInt(Math.round((opts.secondsPerSlot ?? 0.4) * 1000));
  const unixTimestamp = clock.unixTimestamp + ((slot - from) * msPerSlot) / 1000n;
  return { slot, epoch, leaderScheduleEpoch: leaderScheduleEpoch(schedule, slot), epochStartTimestamp: unixTimestamp, unixTimestamp };
}

function applyClock(svm: LiteSVM, c: ClockValue) {
  const clock = svm.getClock();
  clock.slot = c.slot;
  clock.epoch = c.epoch;
  clock.leaderScheduleEpoch = c.leaderScheduleEpoch;
  clock.epochStartTimestamp = c.epochStartTimestamp;
  clock.unixTimestamp = c.unixTimestamp;
  svm.setClock(clock);
  svm.expireBlockhash();
}

/**
 * Move the cluster to the first slot of `epoch`: the Clock's slot, epoch, leader schedule epoch and timestamps
 * (unixTimestamp advances by `secondsPerSlot` per slot and the epoch starts then), by the VM's EpochSchedule, warmup
 * epochs included. The blockhash expires, so a transaction sent again is a new one. The StakeHistory is left as it is:
 * use a `StakeCluster` to have it filled in.
 */
export function warpToEpoch(svm: LiteSVM, epoch: bigint, opts?: WarpOptions): void {
  const c = clockAtEpoch(svm, epoch, opts);
  if (c) applyClock(svm, c);
}

/** `warpToEpoch` to the next epoch; returns it. */
export function nextEpoch(svm: LiteSVM, opts?: WarpOptions): bigint {
  const epoch = svm.getClock().epoch + 1n;
  warpToEpoch(svm, epoch, opts);
  return epoch;
}

// ---------------------------------------------------------------------------------------------------------------
// Stake activation

/** A StakeHistory entry, and what `stakeActivation` returns for one delegation: lamports. */
export interface StakeHistoryEntryValue {
  effective: bigint;
  activating: bigint;
  deactivating: bigint;
}
export type StakeActivationStatus = StakeHistoryEntryValue;

/** A StakeHistory entry. */
export function stakeHistoryEntry(effective = 0n, activating = 0n, deactivating = 0n): StakeHistoryEntryValue {
  return { effective, activating, deactivating };
}

/** Sum of entries, saturating at u64::MAX per field (StakeHistoryEntry's `+`). */
export function addStakeHistoryEntries(...entries: StakeHistoryEntryValue[]): StakeHistoryEntryValue {
  const sat = (x: bigint) => (x > U64_MAX ? U64_MAX : x);
  return entries.reduce(
    (s, e) => ({ effective: sat(s.effective + e.effective), activating: sat(s.activating + e.activating), deactivating: sat(s.deactivating + e.deactivating) }),
    stakeHistoryEntry(),
  );
}

/** Stake history by epoch: a Map, LiteSVM's `StakeHistory`, or anything with `get(epoch)`. */
export interface StakeHistoryLookup {
  get(epoch: bigint): StakeHistoryEntryValue | null | undefined;
}

/** The parts of a Delegation that activation depends on. */
export interface DelegationLike {
  stake: bigint;
  activationEpoch: bigint;
  deactivationEpoch: bigint;
}

export interface StakeActivationOptions {
  /**
   * `"integer"` (default): solana-stake-interface 4.3.0's `stake_activating_and_deactivating_v2`, the basis-point
   * integer math of SIMD-0391 (Stake program v5.1). `"float"`: the f64 math it replaces (the deprecated
   * `stake_activating_and_deactivating`), which the Stake program in LiteSVM 1.6.1 runs. They differ by a few lamports
   * once amounts pass 2^53 lamports (about 9M SOL), e.g. with a mainnet-sized cluster.
   */
  math?: "integer" | "float";
}

const ORIGINAL_RATE_BPS = 2_500n;
const TOWER_RATE_BPS = 900n;

/** warmup_cooldown_allowance.rs: `account`'s share of the cluster's allowed change for `epoch`, integer math. */
function allowanceInteger(epoch: bigint, account: bigint, clusterPortion: bigint, clusterEffective: bigint, rateEpoch: bigint | null): bigint {
  if (account === 0n || clusterPortion === 0n || clusterEffective === 0n) return 0n;
  const bps = rateEpoch !== null && epoch >= rateEpoch ? TOWER_RATE_BPS : ORIGINAL_RATE_BPS;
  const sat = (x: bigint) => (x > U128_MAX ? U128_MAX : x);
  const numerator = sat(sat(account * clusterEffective) * bps);
  const denominator = sat(clusterPortion * 10_000n);
  const delta = numerator / denominator;
  return delta < account ? delta : account;
}

/** `f64 as u64` in Rust: truncates, saturates, NaN is 0. */
const f64ToU64 = (x: number): bigint => (Number.isNaN(x) || x <= 0 ? 0n : x >= 18446744073709551616 ? U64_MAX : BigInt(Math.trunc(x)));

/** The deprecated f64 path: `((account / cluster) * (effective * rate)) as u64`, before `.max(1)`. */
function allowanceFloat(epoch: bigint, account: bigint, clusterPortion: bigint, clusterEffective: bigint, rateEpoch: bigint | null): bigint {
  const rate = epoch < (rateEpoch ?? U64_MAX) ? 0.25 : 0.09;
  const weight = Number(account) / Number(clusterPortion);
  return f64ToU64(weight * (Number(clusterEffective) * rate));
}

/**
 * The effective, activating and deactivating stake of a delegation at `targetEpoch`, given the cluster's stake history:
 * an exact port of `Delegation::stake_activating_and_deactivating_v2` (solana-stake-interface 4.3.0), BigInt math with
 * its u128 saturation. `newRateActivationEpoch` is the epoch from which warmup and cooldown are 9% per epoch rather
 * than 25%: 0 (the default) as the Stake program has it on every cluster; `null` for 25% throughout (Rust's None).
 */
export function stakeActivation(
  delegation: DelegationLike,
  targetEpoch: bigint,
  history: StakeHistoryLookup,
  newRateActivationEpoch: bigint | null = 0n,
  opts: StakeActivationOptions = {},
): StakeActivationStatus {
  const float = opts.math === "float";
  const allowance = float ? allowanceFloat : allowanceInteger;
  const entry = (epoch: bigint): StakeHistoryEntryValue | undefined => history.get(epoch) ?? undefined;
  const { stake: delegated, activationEpoch, deactivationEpoch } = delegation;

  // stake_and_activating_v2: (effective, activating)
  let effective: bigint;
  let activating: bigint;
  if (activationEpoch === U64_MAX)
    [effective, activating] = [delegated, 0n]; // bootstrap: fully effective
  else if (activationEpoch === deactivationEpoch) [effective, activating] = [0n, 0n];
  else if (targetEpoch === activationEpoch) [effective, activating] = [0n, delegated];
  else if (targetEpoch < activationEpoch) [effective, activating] = [0n, 0n];
  else {
    let prev = entry(activationEpoch);
    if (!prev)
      [effective, activating] = [delegated, 0n]; // no history, or dropped out of it: fully effective
    else {
      let prevEpoch = activationEpoch;
      let activated = 0n;
      for (;;) {
        const current = prevEpoch + 1n;
        if (prev.activating === 0n) break;
        const remaining = delegated - activated;
        const newly = allowance(current, remaining, prev.activating, prev.effective, newRateActivationEpoch);
        activated += newly > 1n ? newly : 1n;
        if (activated >= delegated) {
          activated = delegated;
          break;
        }
        if (current >= targetEpoch || current >= deactivationEpoch) break;
        const next = entry(current);
        if (!next) break;
        prevEpoch = current;
        prev = next;
      }
      [effective, activating] = [activated, delegated - activated];
    }
  }

  if (targetEpoch < deactivationEpoch) return { effective, activating, deactivating: 0n };
  if (targetEpoch === deactivationEpoch) return { effective, activating: 0n, deactivating: effective };
  let prev = entry(deactivationEpoch);
  if (!prev) return stakeHistoryEntry(); // no history, or dropped out of it: fully deactivated
  let prevEpoch = deactivationEpoch;
  let remaining = effective;
  for (;;) {
    const current = prevEpoch + 1n;
    if (prev.deactivating === 0n) break;
    const newly = allowance(current, remaining, prev.deactivating, prev.effective, newRateActivationEpoch);
    const step = newly > 1n ? newly : 1n;
    remaining = remaining > step ? remaining - step : 0n;
    if (remaining === 0n) break;
    if (current >= targetEpoch) break;
    const next = entry(current);
    if (!next) break;
    prevEpoch = current;
    prev = next;
  }
  return { effective: remaining, activating: 0n, deactivating: remaining };
}

// ---------------------------------------------------------------------------------------------------------------
// The StakeHistory sysvar

/** The StakeHistory sysvar of `svm`, by epoch (read from the sysvar account: newest first, as stored). */
export function readStakeHistory(svm: LiteSVM): Map<bigint, StakeHistoryEntryValue> {
  const out = new Map<bigint, StakeHistoryEntryValue>();
  const a = svm.getAccount(STAKE_HISTORY_SYSVAR);
  if (!a.exists || a.data.length < 8) return out;
  const v = new DataView(a.data.buffer, a.data.byteOffset, a.data.byteLength);
  const n = Number(v.getBigUint64(0, true));
  for (let i = 0; i < n && 8 + 32 * (i + 1) <= a.data.length; i++) {
    const o = 8 + 32 * i;
    out.set(v.getBigUint64(o, true), stakeHistoryEntry(v.getBigUint64(o + 8, true), v.getBigUint64(o + 16, true), v.getBigUint64(o + 24, true)));
  }
  return out;
}

/** Replace the StakeHistory sysvar of each VM with these entries (the newest 512 are kept). */
export function writeStakeHistory(svms: LiteSVM | readonly LiteSVM[], history: ReadonlyMap<bigint, StakeHistoryEntryValue>): void {
  for (const svm of Array.isArray(svms) ? svms : [svms as LiteSVM]) {
    const h = new StakeHistory();
    for (const [epoch, e] of history) h.add(epoch, new StakeHistoryEntry(e.effective, e.activating, e.deactivating));
    svm.setStakeHistory(h);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Stake accounts

export interface StakeAuthorized {
  staker: Address;
  withdrawer: Address;
}
export interface StakeLockup {
  unixTimestamp: bigint;
  epoch: bigint;
  custodian: Address;
}
export interface StakeMeta {
  /**
   * As stored. The Stake program in LiteSVM 1.6.1 holds back the Rent sysvar's minimum for 200 bytes instead
   * (`svm.minimumBalanceForRentExemption(200n)`), which is smaller than what its Initialize writes here.
   */
  rentExemptReserve: bigint;
  authorized: StakeAuthorized;
  lockup: StakeLockup;
}
export interface Delegation extends DelegationLike {
  voterPubkey: Address;
  /** The legacy `warmup_cooldown_rate: f64` field, now reserved: its 8 bytes as stored. */
  warmupCooldownRate: Uint8Array;
}
export interface Stake {
  delegation: Delegation;
  creditsObserved: bigint;
}
/** A stake account's data (StakeStateV2). */
export type StakeStateV2 =
  | { kind: "Uninitialized" }
  | { kind: "Initialized"; meta: StakeMeta }
  | { kind: "Stake"; meta: StakeMeta; stake: Stake; stakeFlags: number }
  | { kind: "RewardsPool" };

/** Decode StakeStateV2 bytes. */
export function decodeStakeState(data: Uint8Array): StakeStateV2 {
  if (data.length < 4) throw new Error(`stake account data is ${data.length} bytes`);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dec = getAddressDecoder();
  const key = (o: number) => dec.decode(data.subarray(o, o + 32));
  const tag = v.getUint32(0, true);
  if (tag === 0) return { kind: "Uninitialized" };
  if (tag === 3) return { kind: "RewardsPool" };
  if (tag !== 1 && tag !== 2) throw new Error(`not a stake account (tag ${tag})`);
  const need = tag === 1 ? 124 : 197;
  if (data.length < need) throw new Error(`stake account data is ${data.length} bytes; ${need} needed`);
  const meta: StakeMeta = {
    rentExemptReserve: v.getBigUint64(4, true),
    authorized: { staker: key(12), withdrawer: key(44) },
    lockup: { unixTimestamp: v.getBigInt64(76, true), epoch: v.getBigUint64(84, true), custodian: key(92) },
  };
  if (tag === 1) return { kind: "Initialized", meta };
  return {
    kind: "Stake",
    meta,
    stake: {
      delegation: {
        voterPubkey: key(124),
        stake: v.getBigUint64(156, true),
        activationEpoch: v.getBigUint64(164, true),
        deactivationEpoch: v.getBigUint64(172, true),
        warmupCooldownRate: data.slice(180, 188),
      },
      creditsObserved: v.getBigUint64(188, true),
    },
    stakeFlags: data[196]!,
  };
}

/** The stake account at `address` decoded, or null when it does not exist. */
export function readStakeAccount(svm: LiteSVM, address: Address): StakeStateV2 | null {
  const a = svm.getAccount(address);
  return a.exists ? decodeStakeState(a.data) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// StakeCluster

export interface StakeClusterOptions extends WarpOptions, StakeActivationOptions {
  /**
   * The rest of the cluster, added to every epoch's entry: a fixed entry or one per epoch. Default 400M SOL effective,
   * nothing activating or deactivating, which lets a delegation of under 36M SOL warm up in one epoch, as on mainnet.
   * Make `activating` / `deactivating` more than 9% of `effective` to see warmup and cooldown take several epochs.
   */
  base?: StakeHistoryEntryValue | ((epoch: bigint) => StakeHistoryEntryValue);
  /** Count every stake account of the first VM (default true); false counts only the ones passed to `track`. */
  allStakeAccounts?: boolean;
  /** The epoch the 9% rate starts (default 0, as the Stake program has it); null for 25%. */
  newRateActivationEpoch?: bigint | null;
}

const SOL = 1_000_000_000n;

/**
 * A cluster's stake bookkeeping over one or more LiteSVMs. Each epoch advance appends the StakeHistory entry of the
 * epoch that ends (the sum of `stakeActivation` over the cluster's delegations at that epoch, plus `base`), as a
 * cluster does at an epoch boundary, then moves the Clock to the next epoch's first slot. Every VM gets the same Clock,
 * EpochSchedule and StakeHistory (taken from the first VM when the cluster is made), so differential tests see
 * identical sysvars; the delegations are read from the first VM.
 *
 * The default `math` is `"float"`, the Stake program's in LiteSVM 1.6.1, so the history it writes and `activation`
 * agree to the lamport with what that program does.
 */
export class StakeCluster {
  readonly svms: readonly LiteSVM[];
  private readonly entries: Map<bigint, StakeHistoryEntryValue>;
  private readonly tracked = new Set<Address>();
  private readonly opts: StakeClusterOptions;

  constructor(svms: LiteSVM | readonly LiteSVM[], opts: StakeClusterOptions = {}) {
    this.svms = Array.isArray(svms) ? [...svms] : [svms as LiteSVM];
    if (this.svms.length === 0) throw new Error("StakeCluster needs at least one LiteSVM");
    this.opts = { math: "float", ...opts };
    const first = this.svms[0]!;
    this.entries = readStakeHistory(first);
    const clock = first.getClock();
    // The Stake program finds an entry by its distance from the newest one, which must be the previous epoch's: an
    // older one leaves a gap, one for this epoch or later is an epoch that has not ended.
    const newest = this.newestEntry();
    if (newest >= 0n && newest < clock.epoch - 1n)
      throw new Error(
        `StakeCluster: the StakeHistory ends at epoch ${newest} but the Clock is at epoch ${clock.epoch}; entries up to ${clock.epoch - 1n} are needed`,
      );
    if (newest >= clock.epoch)
      throw new Error(
        `StakeCluster: the StakeHistory has an entry for epoch ${newest} but the Clock is at epoch ${clock.epoch}; its newest entry must be epoch ${clock.epoch - 1n}'s (an epoch that ended)`,
      );
    const schedule = first.getEpochSchedule();
    for (const svm of this.svms.slice(1)) {
      svm.setEpochSchedule(schedule);
      applyClock(svm, clock);
    }
    writeStakeHistory(this.svms, this.entries);
  }

  /** Count these stake accounts (with `allStakeAccounts: false`, only tracked ones count). */
  track(...addresses: Address[]): this {
    for (const a of addresses) this.tracked.add(a);
    return this;
  }

  /** The current epoch (the first VM's Clock). */
  get epoch(): bigint {
    return this.svms[0]!.getClock().epoch;
  }

  /** The StakeHistory written so far, by epoch. */
  get history(): ReadonlyMap<bigint, StakeHistoryEntryValue> {
    return this.entries;
  }

  /** The delegations the cluster counts now: every Stake-state account (or the tracked ones) of the first VM. */
  delegations(): Delegation[] {
    const svm = this.svms[0]!;
    const addresses = new Set<Address>(this.tracked);
    if (this.opts.allStakeAccounts !== false) for (const a of svm.getProgramAccounts(STAKE_PROGRAM_ADDRESS)) addresses.add(a.address);
    const out: Delegation[] = [];
    for (const a of addresses) {
      const acc = svm.getAccount(a);
      if (!acc.exists || acc.programAddress !== STAKE_PROGRAM_ADDRESS || acc.data.length < 200) continue;
      const state = decodeStakeState(acc.data);
      if (state.kind === "Stake") out.push(state.stake.delegation);
    }
    return out;
  }

  /** A delegation's (or a stake account's) activation at `epoch` (default: now), by this cluster's history. */
  activation(of: Address | DelegationLike, epoch: bigint = this.epoch): StakeActivationStatus {
    let d: DelegationLike;
    if (typeof of === "string") {
      const state = readStakeAccount(this.svms[0]!, of);
      if (state?.kind !== "Stake") return stakeHistoryEntry();
      d = state.stake.delegation;
    } else d = of;
    return stakeActivation(d, epoch, this.entries, this.rateEpoch(), this.opts);
  }

  /** The entry the epoch `epoch` ends with, given the delegations now and the history so far. */
  entryAt(epoch: bigint): StakeHistoryEntryValue {
    const base = typeof this.opts.base === "function" ? this.opts.base(epoch) : (this.opts.base ?? stakeHistoryEntry(400_000_000n * SOL));
    const rate = this.rateEpoch();
    return addStakeHistoryEntries(base, ...this.delegations().map((d) => stakeActivation(d, epoch, this.entries, rate, this.opts)));
  }

  /** End the current epoch: append its entry and move every VM to the next epoch. Returns the new epoch. */
  nextEpoch(): bigint {
    const epoch = this.epoch + 1n;
    this.warpToEpoch(epoch);
    return epoch;
  }

  /**
   * End epochs one by one (an entry for each, none skipped) up to `epoch`, then move every VM to its first slot. The
   * history must still end at the epoch before the Clock's (or be empty): a Clock moved past it some other way (the
   * plain `warpToEpoch`, `setClock`) would leave epochs without an entry, which the Stake program misreads, so that is
   * refused. A new LiteSVM's Clock is at epoch 0 but at slot 454,464,000, so the first warp from one moves the slot back
   * (to the first slot of `epoch` by the EpochSchedule); the timestamps still move forward.
   */
  warpToEpoch(epoch: bigint): void {
    const first = this.svms[0]!;
    const now = first.getClock().epoch;
    const newest = this.newestEntry();
    if (newest >= 0n && newest !== now - 1n)
      throw new Error(
        `StakeCluster.warpToEpoch: the StakeHistory ends at epoch ${newest} but the Clock is at epoch ${now} (moved outside the cluster?); its newest entry must be epoch ${now - 1n}'s`,
      );
    const clock = clockAtEpoch(first, epoch, this.opts);
    if (!clock) return;
    for (let e = first.getClock().epoch; e < epoch; e++) {
      this.entries.set(e, this.entryAt(e));
      for (const old of [...this.entries.keys()]) if (old <= e - BigInt(STAKE_HISTORY_MAX_ENTRIES)) this.entries.delete(old);
    }
    writeStakeHistory(this.svms, this.entries);
    for (const svm of this.svms) applyClock(svm, clock);
  }

  /** The newest epoch with an entry, or -1 for an empty history. */
  private newestEntry(): bigint {
    return [...this.entries.keys()].reduce((a, b) => (b > a ? b : a), -1n);
  }

  private rateEpoch(): bigint | null {
    return this.opts.newRateActivationEpoch === undefined ? 0n : this.opts.newRateActivationEpoch;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Vote and stake account builders

type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };
const enc = getAddressEncoder();
const keyBytes = (a: Address) => enc.encode(a) as Uint8Array;

function instruction(programAddress: Address, data: Uint8Array, accounts: Meta[]): Instruction {
  return {
    programAddress,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })),
    data,
  } as unknown as Instruction;
}

class Writer {
  private parts: Uint8Array[] = [];
  u8(n: number) {
    this.parts.push(Uint8Array.of(n));
    return this;
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.parts.push(b);
    return this;
  }
  u64(n: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, n), true);
    this.parts.push(b);
    return this;
  }
  key(a: Address) {
    this.parts.push(keyBytes(a));
    return this;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

const createAccountIx = (payer: KeyPairSigner, account: KeyPairSigner, lamports: bigint, space: bigint, owner: Address) =>
  instruction(SYSTEM_PROGRAM, new Writer().u32(0).u64(lamports).u64(space).key(owner).bytes(), [
    { address: payer.address, signer: payer, writable: true },
    { address: account.address, signer: account, writable: true },
  ]);

/** Send `ixs` in one transaction paid by `payer`; throws with the logs if it fails. The blockhash expires after. */
async function sendOrThrow(svm: LiteSVM, payer: KeyPairSigner, ixs: Instruction[], what: string): Promise<TransactionMetadata> {
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (t) => setTransactionMessageFeePayerSigner(payer, t),
    (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t),
    (t) => appendTransactionMessageInstructions(ixs, t),
    (t) => signTransactionMessageWithSigners(t),
  );
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) throw new Error(`${what} failed: ${String(res.err())}\n${res.meta().logs().join("\n")}`);
  return res;
}

/**
 * A vote account made by the Vote program (System CreateAccount of 3762 bytes, then InitializeAccount with
 * VoteInit { node, authorized voter, authorized withdrawer, commission }). `node` signs (a new keypair by default);
 * `voter` and `withdrawer` default to the node. Returns the vote account's address (`address` to choose it).
 */
export async function createVoteAccount(
  svm: LiteSVM,
  payer: KeyPairSigner,
  opts: { node?: KeyPairSigner; voter?: Address; withdrawer?: Address; commission?: number; address?: KeyPairSigner } = {},
): Promise<Address> {
  const node = opts.node ?? (await generateKeyPairSigner());
  const vote = opts.address ?? (await generateKeyPairSigner());
  const data = new Writer()
    .u32(0)
    .key(node.address)
    .key(opts.voter ?? node.address)
    .key(opts.withdrawer ?? node.address)
    .u8(opts.commission ?? 0)
    .bytes();
  await sendOrThrow(
    svm,
    payer,
    [
      createAccountIx(payer, vote, svm.minimumBalanceForRentExemption(VOTE_ACCOUNT_SIZE), VOTE_ACCOUNT_SIZE, VOTE_PROGRAM_ADDRESS),
      instruction(VOTE_PROGRAM_ADDRESS, data, [
        { address: vote.address, writable: true },
        { address: RENT_SYSVAR },
        { address: CLOCK_SYSVAR },
        { address: node.address, signer: node },
      ]),
    ],
    "createVoteAccount",
  );
  return vote.address;
}

/**
 * A stake account made by the Stake program (System CreateAccount of 200 bytes holding `lamports` in all, rent
 * reserve included, then Initialize with the authorities and lockup). Returns its address (`address` to choose it).
 */
export async function createStakeAccount(
  svm: LiteSVM,
  payer: KeyPairSigner,
  opts: { staker: Address; withdrawer: Address; lamports: bigint; lockup?: Partial<StakeLockup>; address?: KeyPairSigner },
): Promise<Address> {
  const stake = opts.address ?? (await generateKeyPairSigner());
  const data = new Writer()
    .u32(0)
    .key(opts.staker)
    .key(opts.withdrawer)
    .u64(opts.lockup?.unixTimestamp ?? 0n)
    .u64(opts.lockup?.epoch ?? 0n)
    .key(opts.lockup?.custodian ?? SYSTEM_PROGRAM)
    .bytes();
  await sendOrThrow(
    svm,
    payer,
    [
      createAccountIx(payer, stake, opts.lamports, STAKE_ACCOUNT_SIZE, STAKE_PROGRAM_ADDRESS),
      instruction(STAKE_PROGRAM_ADDRESS, data, [{ address: stake.address, writable: true }, { address: RENT_SYSVAR }]),
    ],
    "createStakeAccount",
  );
  return stake.address;
}

/** Delegate a stake account to a vote account (Stake DelegateStake, signed by the staker; `staker` defaults to the payer). */
export async function delegateStake(
  svm: LiteSVM,
  payer: KeyPairSigner,
  opts: { stake: Address; vote: Address; staker?: KeyPairSigner },
): Promise<TransactionMetadata> {
  const staker = opts.staker ?? payer;
  return sendOrThrow(
    svm,
    payer,
    [
      instruction(STAKE_PROGRAM_ADDRESS, new Writer().u32(2).bytes(), [
        { address: opts.stake, writable: true },
        { address: opts.vote },
        { address: CLOCK_SYSVAR },
        { address: STAKE_HISTORY_SYSVAR },
        { address: STAKE_CONFIG },
        { address: staker.address, signer: staker },
      ]),
    ],
    "delegateStake",
  );
}
