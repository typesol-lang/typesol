// The EpochRewards sysvar through its syscall (Rust's `EpochRewards::get()`), with no sysvar account: SPL Stake Pool
// refuses UpdateValidatorListBalance while rewards are being distributed.
import { type EpochRewards, epochRewards, instructionData, log, require, u64 } from "typesol";

export enum PoolError {
  /** @code 0 */
  EpochRewardDistributionInProgress = "Epoch rewards are being distributed.",
}

/** In a helper too: each call reads the sysvar where it is made. */
function rewardsPending(): u64 {
  const er: EpochRewards = epochRewards();
  return er.totalRewards - er.distributedRewards;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const tag = data.readU8(0n);
  if (tag === 0n) {
    // Every field, from one copy of the sysvar.
    const er = epochRewards();
    log(`height ${er.distributionStartingBlockHeight} partitions ${er.numPartitions}`);
    log(`blockhash ${er.parentBlockhash}`);
    log(`points ${er.totalPoints} total ${er.totalRewards} distributed ${er.distributedRewards}`);
    log(`active ${er.active} pending ${rewardsPending()}`);
    return;
  }
  // The stake pool's guard, read inline.
  require(!epochRewards().active, PoolError.EpochRewardDistributionInProgress);
  log("updated");
}
