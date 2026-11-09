// showcase/mainnet/spl-stake-pool against SPL Stake Pool as deployed on mainnet (test/programs/spl_stake_pool.so).
// The harness (spl-stake-pool-helpers.ts) runs both in their own LiteSVM under the same program id, with the same
// Clock and StakeHistory; every transaction must have the same outcome, log lines and account bytes.
import { type KeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { Diff, SOL, builtin, custom, fee, ix, transientStake, updatePairs, validatorStake } from "./spl-stake-pool-helpers.js";

describe("showcase/mainnet/spl-stake-pool against SPL Stake Pool on mainnet", () => {
  let d: Diff;
  let payer: KeyPairSigner;

  beforeAll(async () => {
    d = await Diff.create();
    payer = await d.funded(100_000n);
  });

  it("initializes a pool", async () => {
    const p = await d.createPool(payer, { reserveLamports: 10n * SOL });
    expect(d.tokenBalance(p.managerFee)).toBe(10n * SOL);
    await d.ok("set fee", payer, [ix.setFee(p, p.manager, { kind: "SolDeposit", fee: fee(1n, 100n) })]);
    expect(await d.both("set fee unsigned", payer, [ix.setFee(p, p.manager.address, { kind: "SolDeposit", fee: fee(1n, 100n) })])).toBe(custom(7));
    expect(await d.both("empty data", payer, [ix.raw(Buffer.alloc(0), [])])).toBe(builtin("BorshIoError"));
  });

  it("adds, updates and removes validators", async () => {
    const p = await d.createPool(payer, { reserveLamports: 100n * SOL });
    const votes = [await d.vote(payer), await d.vote(payer)];
    for (const [i, v] of votes.entries())
      await d.ok(`add validator ${i}`, payer, [ix.addValidator(p, p.staker, await validatorStake(v, p.pool, i * 7), v, i * 7)]);
    d.nextEpoch();
    await d.ok("update list", payer, [ix.updateValidatorListBalance(p, 0, false, await updatePairs(d, p))]);
    await d.ok("update pool", payer, [ix.updateStakePoolBalance(p)]);
    const stake0 = await validatorStake(votes[0]!, p.pool, 0);
    await d.ok("remove validator", payer, [ix.removeValidator(p, p.staker, stake0, await transientStake(votes[0]!, p.pool, 0n))]);
    d.nextEpoch();
    await d.ok("update list after removal", payer, [ix.updateValidatorListBalance(p, 0, false, await updatePairs(d, p))]);
    await d.ok("update pool after removal", payer, [ix.updateStakePoolBalance(p)]);
    await d.ok("cleanup", payer, [ix.cleanupRemovedValidatorEntries(p)]);
    for (const [l, [a, b]] of Object.entries(d.cu)) console.log(`${l.padEnd(30)} ${a} ${b}`);
  });
});
