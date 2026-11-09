// typesol/testing: epochs, a cluster-like StakeHistory and stake / vote builders, checked against the Stake program
// LiteSVM runs (the lamport a withdrawal may take is the stake the program computes as still effective).
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { EpochSchedule, FailedTransactionMetadata, LiteSVM } from "litesvm";
import { describe, expect, it } from "vitest";
import {
  type DelegationLike,
  type StakeHistoryEntryValue,
  STAKE_PROGRAM_ADDRESS,
  StakeCluster,
  createStakeAccount,
  createVoteAccount,
  delegateStake,
  epochAndSlotIndex,
  firstSlotInEpoch,
  leaderScheduleEpoch,
  nextEpoch,
  readStakeAccount,
  readStakeHistory,
  stakeActivation,
  stakeHistoryEntry,
  warpToEpoch,
  writeStakeHistory,
} from "../../src/testing.js";

const SOL = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const CLOCK = "SysvarC1ock11111111111111111111111111111111" as Address;
const HISTORY = "SysvarStakeHistory1111111111111111111111111" as Address;

const history = (entries: [bigint, StakeHistoryEntryValue][]) => new Map(entries);
const delegation = (stake: bigint, activationEpoch: bigint, deactivationEpoch = U64_MAX): DelegationLike => ({ stake, activationEpoch, deactivationEpoch });
const e = stakeHistoryEntry;

describe("warpToEpoch", () => {
  it("follows LiteSVM's default (warmup) schedule", () => {
    const svm = new LiteSVM();
    const s = svm.getEpochSchedule();
    expect([s.slotsPerEpoch, s.warmup, s.firstNormalEpoch, s.firstNormalSlot]).toEqual([432_000n, true, 14n, 524_256n]);
    // Short warmup epochs: 32, 64, 128 … slots, epoch 13 = 2^18 slots ending at 524_255.
    expect([0n, 1n, 2n, 13n, 14n, 15n].map((ep) => firstSlotInEpoch(s, ep))).toEqual([0n, 32n, 96n, 262_112n, 524_256n, 956_256n]);
    expect(epochAndSlotIndex(s, 31n)).toEqual({ epoch: 0n, slotIndex: 31n });
    expect(epochAndSlotIndex(s, 32n)).toEqual({ epoch: 1n, slotIndex: 0n });
    expect(epochAndSlotIndex(s, 524_255n)).toEqual({ epoch: 13n, slotIndex: 262_143n });
    expect(epochAndSlotIndex(s, 956_257n)).toEqual({ epoch: 15n, slotIndex: 1n });
    for (let ep = 0n; ep < 40n; ep++) {
      expect(epochAndSlotIndex(s, firstSlotInEpoch(s, ep))).toEqual({ epoch: ep, slotIndex: 0n });
      expect(epochAndSlotIndex(s, firstSlotInEpoch(s, ep + 1n) - 1n).epoch).toBe(ep);
    }
    // Before the first normal slot the leader schedule is one epoch ahead; after it, offset slots ahead.
    expect(leaderScheduleEpoch(s, 32n)).toBe(2n);
    expect(leaderScheduleEpoch(s, 524_256n)).toBe(15n);

    const start = svm.getClock(); // a new LiteSVM: epoch 0 at slot 454_464_000, timestamp 0
    expect(start.epoch).toBe(0n);
    warpToEpoch(svm, 1n);
    let c = svm.getClock();
    expect([c.slot, c.epoch, c.leaderScheduleEpoch]).toEqual([32n, 1n, 2n]);
    expect([c.unixTimestamp, c.epochStartTimestamp]).toEqual([12n, 12n]); // 32 slots × 0.4 s, whole seconds
    warpToEpoch(svm, 15n);
    c = svm.getClock();
    expect([c.slot, c.epoch, c.leaderScheduleEpoch]).toEqual([956_256n, 15n, 16n]);
    expect(c.unixTimestamp).toBe(12n + ((956_256n - 32n) * 4n) / 10n);
    expect(c.epochStartTimestamp).toBe(c.unixTimestamp);
  });

  it("follows a schedule without warmup, refuses to go back and expires the blockhash", () => {
    const svm = new LiteSVM();
    svm.setEpochSchedule(new EpochSchedule(100n, 50n, false, 0n, 0n));
    const c0 = svm.getClock();
    c0.slot = 0n;
    svm.setClock(c0);
    const hash = svm.latestBlockhash();
    expect(nextEpoch(svm, { secondsPerSlot: 1 })).toBe(1n);
    expect(svm.latestBlockhash()).not.toBe(hash);
    warpToEpoch(svm, 5n, { secondsPerSlot: 0.5 });
    const c = svm.getClock();
    expect([c.slot, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp, c.epochStartTimestamp]).toEqual([500n, 5n, 5n, 300n, 300n]);
    warpToEpoch(svm, 5n); // already there: nothing changes
    expect(svm.getClock().slot).toBe(500n);
    expect(() => warpToEpoch(svm, 4n)).toThrow(/before the current epoch/);
    svm.setEpochSchedule(new EpochSchedule(100n, 100n, false, 0n, 0n));
    warpToEpoch(svm, 6n);
    expect(svm.getClock().leaderScheduleEpoch).toBe(7n);
  });
});

describe("stakeActivation (solana-stake-interface 4.3.0, integer)", () => {
  it("bootstrap, before / at activation, no history, activated and deactivated in one epoch", () => {
    const none = history([]);
    expect(stakeActivation(delegation(1000n, U64_MAX), 7n, none)).toEqual(e(1000n));
    expect(stakeActivation(delegation(1000n, U64_MAX, 9n), 9n, none)).toEqual(e(1000n, 0n, 1000n));
    expect(stakeActivation(delegation(1000n, 5n), 4n, none)).toEqual(e());
    expect(stakeActivation(delegation(1000n, 5n), 5n, none)).toEqual(e(0n, 1000n));
    expect(stakeActivation(delegation(1000n, 5n), 6n, none)).toEqual(e(1000n)); // no history: fully effective
    expect(stakeActivation(delegation(1000n, 0n, 5n), 6n, none)).toEqual(e()); // no history: fully deactivated
    // Activated and deactivated in the same epoch: never any stake, whatever the history.
    const busy = history([0n, 1n, 2n, 3n].map((ep) => [ep, e(1000n, 10_000n, ep < 3n ? 1000n : 100n)]));
    for (let ep = 0n; ep < 6n; ep++) expect(stakeActivation(delegation(700n, 0n, 0n), ep, busy, null)).toEqual(e());
  });

  it("the cases of the Rust test test_stake_activating_and_deactivating", () => {
    const d = delegation(1000n, 0n, 5n);
    const increment = (1000n * 2500n) / 10_000n; // 25%: rate None
    // An entry without this stake's activating amount: still all activating.
    expect(stakeActivation(d, 1n, history([[0n, e(1000n)]]), null)).toEqual(e(0n, 1000n));
    // With it, but no entry for epoch 1: stuck after the first step.
    expect(stakeActivation(d, 2n, history([[0n, e(1000n, 1000n)]]), null)).toEqual(e(increment, 1000n - increment));
    expect(stakeActivation(d, 6n, history([[5n, e(1000n)]]), null)).toEqual(e(1000n, 0n, 1000n));
    expect(stakeActivation(d, 7n, history([[5n, e(1000n, 0n, 1000n)]]), null)).toEqual(e(1000n - increment, 0n, 1000n - increment));
  });

  it("hand-worked warmup and cooldown at 9%, 25% and across the rate change", () => {
    // Epoch 0: 10_000 effective, this stake's 1000 activating. 9%: 1000·10_000·900 / (1000·10_000) = 900.
    const h = history([
      [0n, e(10_000n, 1000n)],
      [1n, e(10_900n, 100n)],
    ]);
    expect(stakeActivation(delegation(1000n, 0n), 1n, h)).toEqual(e(900n, 100n));
    expect(stakeActivation(delegation(1000n, 0n), 2n, h)).toEqual(e(1000n)); // 100·10_900·900/(100·10_000) = 981 → capped at 100
    expect(stakeActivation(delegation(1000n, 0n), 1n, h, null)).toEqual(e(1000n)); // 25%: 2500 ≥ 1000
    // Rate change at epoch 2: epoch 1 at 25%, epoch 2 at 9%.
    const r = history([
      [0n, e(1000n, 4000n)],
      [1n, e(1062n, 3938n)],
    ]);
    expect(stakeActivation(delegation(1000n, 0n), 1n, r, 2n)).toEqual(e(62n, 938n)); // 1000·1000·2500/(4000·10_000) = 62.5
    expect(stakeActivation(delegation(1000n, 0n), 2n, r, 2n)).toEqual(e(84n, 916n)); // + 938·1062·900/(3938·10_000) = 22.77
    expect(stakeActivation(delegation(1000n, 0n), 1n, r, 1n)).toEqual(e(22n, 978n)); // 1000·1000·900/(4000·10_000) = 22.5
    // Warmup stops at the deactivation epoch; cooldown starts from what was effective then.
    const w = history([
      [0n, e(10_000n, 5000n)],
      [1n, e(10_000n, 5000n)],
      [2n, e(10_000n, 0n, 1000n)],
      [3n, e(10_000n, 0n, 1000n)],
    ]);
    // Epoch 1: 1000·10_000·900/(5000·10_000) = 180; epoch 2: 820·10_000·900/(5000·10_000) = 147.6 → 327.
    expect(stakeActivation(delegation(1000n, 0n, 2n), 2n, w)).toEqual(e(327n, 0n, 327n));
    // Epoch 3: 327·10_000·900/(1000·10_000) = 294.3 → 33 left; epoch 4: 29.7 → 4 left; no entry for epoch 4: stuck at 4.
    expect(stakeActivation(delegation(1000n, 0n, 2n), 3n, w)).toEqual(e(33n, 0n, 33n));
    expect(stakeActivation(delegation(1000n, 0n, 2n), 4n, w)).toEqual(e(4n, 0n, 4n));
    expect(stakeActivation(delegation(1000n, 0n, 2n), 9n, w)).toEqual(e(4n, 0n, 4n));
    // With an entry for epoch 4: 4·10_000·900/(1000·10_000) = 3.6 → 1 left at epoch 5, stuck there without entry 5.
    expect(stakeActivation(delegation(1000n, 0n, 2n), 9n, new Map([...w, [4n, e(10_000n, 0n, 1000n)]]))).toEqual(e(1n, 0n, 1n));
    expect(stakeActivation(delegation(1000n, 0n, 1n), 1n, w)).toEqual(e(180n, 0n, 180n));
  });

  it("makes at least one lamport of progress per epoch (max(1))", () => {
    const h = history([0n, 1n, 2n, 3n, 4n].map((ep) => [ep, e(1n, 1_000_000_000_000n, 1_000_000_000_000n)]));
    for (const ep of [1n, 2n, 3n, 5n]) expect(stakeActivation(delegation(1000n, 0n), ep, h).effective).toBe(ep > 5n ? 5n : ep);
    expect(stakeActivation(delegation(1000n, U64_MAX, 0n), 3n, h)).toEqual(e(997n, 0n, 997n));
    // Stuck at the end of the history: progress stops at the last entry.
    expect(stakeActivation(delegation(1000n, 0n), 50n, h).effective).toBe(5n);
  });

  it("saturates the u128 product as the Rust does (overflow_scenario_still_rate_limits)", () => {
    const supply = 400_000_000_000_000_000n; // 400M SOL
    const d = delegation(supply, U64_MAX, 10n);
    const h = history([[10n, e(supply, 0n, supply)]]);
    // u128::MAX / (4e17 · 10_000) = 85_070_591_730_234_615 instead of a quarter of the supply.
    expect(stakeActivation(d, 11n, h, null).effective).toBe(supply - 85_070_591_730_234_615n);
    // Basic shares and truncation from warmup_cooldown_allowance.rs.
    const one = (acct: bigint, portion: bigint, eff: bigint, epoch: bigint, rate: bigint | null) =>
      acct - stakeActivation(delegation(acct, U64_MAX, epoch - 1n), epoch, history([[epoch - 1n, e(eff, 0n, portion)]]), rate).effective;
    expect(one(100n, 500n, 1000n, 99n, 100n)).toBe(50n);
    expect(one(100n, 500n, 1000n, 100n, 100n)).toBe(18n);
    expect(one(100n, 1000n, 10_001n, 20n, 10n)).toBe(90n);
    expect(one(40n, 100n, 1_000_000n, 99n, 100n)).toBe(40n);
  });

  it("the f64 algorithm differs from the integer one past 2^53 (high_ulp_case)", () => {
    const acct = 342_898_401_157_885_026n;
    const h = history([[9n, e(708_104_488_956_562_499n, 0n, 2_426_138_261_763_124_479n)]]);
    const d = delegation(acct, U64_MAX, 9n);
    expect(acct - stakeActivation(d, 10n, h, 0n).effective).toBe(9_007_199_253_579_461n);
    expect(acct - stakeActivation(d, 10n, h, 0n, { math: "float" }).effective).toBe(9_007_199_253_579_466n);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Against the Stake program in LiteSVM

const enc = getAddressEncoder();
type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };
const ix = (data: number[] | Uint8Array, accounts: Meta[]): Instruction =>
  ({
    programAddress: STAKE_PROGRAM_ADDRESS,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })),
    data: Uint8Array.from(data),
  }) as unknown as Instruction;
const u64le = (n: bigint) => [...new Uint8Array(BigUint64Array.of(n).buffer)];
const withdrawIx = (stake: Address, to: Address, withdrawer: KeyPairSigner, amount: bigint) =>
  ix(
    [4, 0, 0, 0, ...u64le(amount)],
    [
      { address: stake, writable: true },
      { address: to, writable: true },
      { address: CLOCK },
      { address: HISTORY },
      { address: withdrawer.address, signer: withdrawer },
    ],
  );
const deactivateIx = (stake: Address, staker: KeyPairSigner) =>
  ix([5, 0, 0, 0], [{ address: stake, writable: true }, { address: CLOCK }, { address: staker.address, signer: staker }]);
const mergeIx = (dest: Address, src: Address, staker: KeyPairSigner) =>
  ix(
    [7, 0, 0, 0],
    [
      { address: dest, writable: true },
      { address: src, writable: true },
      { address: CLOCK },
      { address: HISTORY },
      { address: staker.address, signer: staker },
    ],
  );

function bytes(svm: LiteSVM, address: Address): Buffer {
  const a = svm.getAccount(address);
  if (!a.exists) throw new Error(`${address} does not exist`);
  return Buffer.from(a.data);
}
async function tx(svm: LiteSVM, payer: KeyPairSigner, ixs: Instruction[]) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    (t) => setTransactionMessageFeePayerSigner(payer, t),
    (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t),
    (t) => appendTransactionMessageInstructions(ixs, t),
    (t) => signTransactionMessageWithSigners(t),
  );
}
async function send(svm: LiteSVM, payer: KeyPairSigner, ...ixs: Instruction[]) {
  const res = svm.sendTransaction(await tx(svm, payer, ixs));
  svm.expireBlockhash();
  return res;
}
async function simulateOk(svm: LiteSVM, payer: KeyPairSigner, ...ixs: Instruction[]) {
  return !(svm.simulateTransaction(await tx(svm, payer, ixs)) instanceof FailedTransactionMetadata);
}
/**
 * The stake the program still holds back in a deactivated stake account: the largest withdrawal it allows is
 * lamports − rent-exempt minimum − staked. Checks that `staked` is exactly that (withdrawing one lamport more fails).
 * The program takes the minimum from the Rent sysvar, not from the account's `rentExemptReserve`, which in LiteSVM
 * 1.6.1 is larger (it was computed at Initialize with the older per-byte rate).
 */
async function heldBack(svm: LiteSVM, payer: KeyPairSigner, stake: Address, staked: bigint) {
  const free = svm.getBalance(stake)! - svm.minimumBalanceForRentExemption(200n) - staked;
  const exact = free > 0n ? await simulateOk(svm, payer, withdrawIx(stake, payer.address, payer, free)) : true;
  const over = await simulateOk(svm, payer, withdrawIx(stake, payer.address, payer, free + 1n));
  return { exact, over };
}

describe("StakeCluster against LiteSVM's Stake program", () => {
  it("rate-limited warmup and cooldown, to the lamport, in two VMs with identical sysvars", async () => {
    const svms = [new LiteSVM(), new LiteSVM()];
    const [payer, node, voteKey, x, y, m1, m2] = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => generateKeyPairSigner()));
    // The rest of the cluster: 1000 SOL effective, so 90 SOL a epoch may warm up or cool down (9%).
    const cluster = new StakeCluster(svms, { base: e(1000n * SOL) });
    let vote!: Address;
    const reserve = svms[0]!.minimumBalanceForRentExemption(200n);
    for (const svm of svms) {
      svm.airdrop(payer!.address, lamports(10_000n * SOL));
      vote = await createVoteAccount(svm, payer!, { node: node!, address: voteKey!, commission: 5 });
      for (const [k, sol] of [
        [x, 500n],
        [y, 300n],
        [m1, 100n],
        [m2, 50n],
      ] as const) {
        await createStakeAccount(svm, payer!, { staker: payer!.address, withdrawer: payer!.address, lamports: reserve + sol * SOL, address: k! });
        await delegateStake(svm, payer!, { stake: k!.address, vote });
      }
    }
    const sameSysvars = () => {
      for (const a of [CLOCK, HISTORY]) expect(bytes(svms[1]!, a)).toEqual(bytes(svms[0]!, a));
      for (const k of [x, y, m1]) expect(svms[1]!.getAccount(k!.address)).toEqual(svms[0]!.getAccount(k!.address));
    };
    const xs = readStakeAccount(svms[0]!, x!.address);
    expect(xs?.kind === "Stake" && xs.stake.delegation).toMatchObject({
      voterPubkey: vote,
      stake: 500n * SOL,
      activationEpoch: 0n,
      deactivationEpoch: U64_MAX,
    });
    expect(xs?.kind === "Stake" && xs.meta.authorized).toEqual({ staker: payer!.address, withdrawer: payer!.address });
    expect(cluster.activation(x!.address)).toEqual(e(0n, 500n * SOL));

    // Epoch 0 ends with 950 SOL activating against 1000 effective: each gets its share of 90 SOL.
    expect(cluster.nextEpoch()).toBe(1n);
    sameSysvars();
    expect(cluster.history.get(0n)).toEqual(e(1000n * SOL, 950n * SOL));
    expect(readStakeHistory(svms[1]!)).toEqual(cluster.history);
    const x1 = cluster.activation(x!.address);
    expect(x1.effective).toBe((500n * SOL * 90n) / 950n); // the float math gives the same here (< 2^53)
    // Merging partly active stakes fails (transient); y is deactivated now and its held-back stake checked each epoch.
    for (const svm of svms) {
      expect(await simulateOk(svm, payer!, mergeIx(m1!.address, m2!.address, payer!))).toBe(false);
      expect((await send(svm, payer!, deactivateIx(y!.address, payer!))) instanceof FailedTransactionMetadata).toBe(false);
    }
    const yEpoch1 = cluster.activation(y!.address);
    expect(yEpoch1.deactivating).toBe((300n * SOL * 90n) / 950n);
    let mergedAt: bigint | undefined;
    let seenPartial = 0;
    for (let epoch = 1n; epoch <= 12n; epoch++) {
      const yAct = cluster.activation(y!.address);
      for (const svm of svms) expect(await heldBack(svm, payer!, y!.address, yAct.effective)).toEqual({ exact: true, over: false });
      // m1 + m2 merge once both are fully active (nothing activating), not an epoch earlier.
      if (mergedAt === undefined) {
        const full = cluster.activation(m1!.address).activating === 0n && cluster.activation(m2!.address).activating === 0n;
        for (const svm of svms) expect(await simulateOk(svm, payer!, mergeIx(m1!.address, m2!.address, payer!))).toBe(full);
        if (full) {
          for (const svm of svms) expect((await send(svm, payer!, mergeIx(m1!.address, m2!.address, payer!))) instanceof FailedTransactionMetadata).toBe(false);
          mergedAt = epoch;
        }
      }
      const xAct = cluster.activation(x!.address);
      if (xAct.effective > 0n && xAct.activating > 0n) seenPartial++;
      cluster.nextEpoch();
      sameSysvars();
    }
    expect(mergedAt).toBeGreaterThan(2n); // warmup took several epochs
    expect(seenPartial).toBeGreaterThan(2);
    expect(readStakeAccount(svms[0]!, m2!.address)).toBeNull(); // merged away
    expect(cluster.activation(y!.address)).toEqual(e()); // cooled down: all of it can be withdrawn
    for (const svm of svms)
      expect((await send(svm, payer!, withdrawIx(y!.address, payer!.address, payer!, svm.getBalance(y!.address)!))) instanceof FailedTransactionMetadata).toBe(
        false,
      );
    // The history has one entry per epoch up to the one before the current, as the program needs.
    expect([...cluster.history.keys()].sort((a, b) => Number(a - b))).toEqual([...Array(13).keys()].map(BigInt));
    expect(svms[0]!.getClock().epoch).toBe(13n);
  });

  it("warmup progress, read by the program at the deactivation epoch, matches stakeActivation", async () => {
    const svm = new LiteSVM();
    const [payer, a, b] = await Promise.all([1, 2, 3].map(() => generateKeyPairSigner()));
    svm.airdrop(payer!.address, lamports(10_000n * SOL));
    // Something else activating too: 2000 SOL each epoch against 1000 SOL effective.
    const cluster = new StakeCluster(svm, { base: e(1000n * SOL, 2000n * SOL) });
    const vote = await createVoteAccount(svm, payer!);
    const reserve = svm.minimumBalanceForRentExemption(200n);
    for (const k of [a, b]) {
      await createStakeAccount(svm, payer!, { staker: payer!.address, withdrawer: payer!.address, lamports: reserve + 700n * SOL, address: k! });
      await delegateStake(svm, payer!, { stake: k!.address, vote });
    }
    warpOn(cluster, 3n);
    expect(await send(svm, payer!, deactivateIx(a!.address, payer!))).not.toBeInstanceOf(FailedTransactionMetadata);
    const atDeactivation = cluster.activation(a!.address);
    expect(atDeactivation.effective).toBeGreaterThan(0n);
    expect(atDeactivation.effective).toBeLessThan(700n * SOL);
    expect(await heldBack(svm, payer!, a!.address, atDeactivation.effective)).toEqual({ exact: true, over: false });
    for (let i = 0; i < 4; i++) {
      cluster.nextEpoch();
      expect(await heldBack(svm, payer!, a!.address, cluster.activation(a!.address).effective)).toEqual({ exact: true, over: false });
    }
    // b, never deactivated, holds back all of its stake whatever its activation.
    expect(await heldBack(svm, payer!, b!.address, 700n * SOL)).toEqual({ exact: true, over: false });
  });

  it("with the default mainnet-sized base, a delegation warms up and cools down in one epoch each", async () => {
    const svm = new LiteSVM();
    const payer = await generateKeyPairSigner();
    svm.airdrop(payer.address, lamports(10_000n * SOL));
    const cluster = new StakeCluster(svm);
    const vote = await createVoteAccount(svm, payer);
    const stake = await createStakeAccount(svm, payer, { staker: payer.address, withdrawer: payer.address, lamports: 1000n * SOL });
    await delegateStake(svm, payer, { stake, vote });
    cluster.nextEpoch();
    expect(cluster.history.get(0n)?.effective).toBe(400_000_000n * SOL);
    expect(cluster.activation(stake)).toEqual(e(1000n * SOL - svm.minimumBalanceForRentExemption(200n)));
    expect(await send(svm, payer, deactivateIx(stake, payer))).not.toBeInstanceOf(FailedTransactionMetadata);
    expect(await simulateOk(svm, payer, withdrawIx(stake, payer.address, payer, svm.getBalance(stake)!))).toBe(false);
    cluster.nextEpoch();
    expect(await send(svm, payer, withdrawIx(stake, payer.address, payer, svm.getBalance(stake)!))).not.toBeInstanceOf(FailedTransactionMetadata);
  });

  it("LiteSVM 1.6.1's Stake program uses the f64 algorithm (mainnet-sized amounts, to the lamport)", async () => {
    const svm = new LiteSVM();
    const payer = await generateKeyPairSigner();
    svm.airdrop(payer.address, lamports(10n * SOL));
    const reserve = svm.minimumBalanceForRentExemption(200n);
    // Stake accounts written straight into the VM (bootstrap delegations, so only the cooldown counts), against
    // histories of mainnet size; the program's held-back stake is compared with both algorithms.
    let seed = 0x2545f491n;
    const rand = (max: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & U64_MAX;
      return (seed >> 11n) % max;
    };
    let floatDiffers = 0;
    const cases: [bigint, StakeHistoryEntryValue][] = [[342_898_401_157_885_026n, e(708_104_488_956_562_499n, 0n, 2_426_138_261_763_124_479n)]];
    for (let i = 0; i < 24; i++) {
      const stake = 1n * SOL + rand(30_000_000n * SOL);
      cases.push([stake, e(300_000_000n * SOL + rand(200_000_000n * SOL), rand(10_000_000n * SOL), stake + rand(80_000_000n * SOL))]);
    }
    let epoch = 20n;
    for (const [stake, entry] of cases) {
      const address = (await generateKeyPairSigner()).address;
      const data = new Uint8Array(200);
      const v = new DataView(data.buffer);
      v.setUint32(0, 2, true);
      v.setBigUint64(4, reserve, true);
      data.set(enc.encode(payer.address), 12);
      data.set(enc.encode(payer.address), 44);
      v.setBigUint64(156, stake, true);
      v.setBigUint64(164, U64_MAX, true);
      v.setBigUint64(172, epoch, true);
      svm.setAccount({ address, data, executable: false, lamports: lamports(stake + reserve + 1n), programAddress: STAKE_PROGRAM_ADDRESS, space: 200n });
      // Cooldown over two epochs: the entry at the deactivation epoch and the next (its stake partly gone). The
      // newest entry must be the epoch before the current one: the program reads entries by their distance from it.
      const h = history([
        [epoch, entry],
        [epoch + 1n, e(entry.effective, entry.activating, entry.deactivating / 2n)],
      ]);
      for (const target of [epoch + 1n, epoch + 2n]) {
        writeStakeHistory(svm, new Map([...h].filter(([k]) => k < target)));
        warpToEpoch(svm, target);
        const d = delegation(stake, U64_MAX, epoch);
        const float = stakeActivation(d, target, h, 0n, { math: "float" }).effective;
        const integer = stakeActivation(d, target, h, 0n).effective;
        if (float !== integer) floatDiffers++;
        expect(await heldBack(svm, payer, address, float)).toEqual({ exact: true, over: false });
      }
      epoch += 3n;
    }
    expect(floatDiffers).toBeGreaterThan(0); // the integer algorithm would be off by a few lamports in these
  });

  it("writes an entry for every epoch it passes, keeps 512, and reads an existing history", async () => {
    const svm = new LiteSVM();
    warpToEpoch(svm, 1n);
    writeStakeHistory(svm, history([[0n, e(5n, 1n, 2n)]]));
    const cluster = new StakeCluster(svm, { base: (ep) => e(1000n + ep) });
    expect(cluster.history.get(0n)).toEqual(e(5n, 1n, 2n));
    warpOn(cluster, 600n);
    const h = readStakeHistory(svm);
    expect(h.size).toBe(512);
    expect(h).toEqual(cluster.history);
    expect(h.get(599n)).toEqual(e(1599n));
    expect(h.get(88n)).toEqual(e(1088n));
    expect(h.has(87n)).toBe(false);
    expect(bytes(svm, HISTORY).length).toBe(8 + 512 * 32);
    // A history that stops before the previous epoch would be misread by the program: refused.
    const gap = new LiteSVM();
    writeStakeHistory(gap, history([[0n, e(1n)]]));
    warpToEpoch(gap, 3n);
    expect(() => new StakeCluster(gap)).toThrow(/ends at epoch 0 but the Clock is at epoch 3/);
    // An entry for the current epoch or a later one: an epoch that has not ended, refused too.
    for (const at of [3n, 5n]) {
      const ahead = new LiteSVM();
      warpToEpoch(ahead, 3n);
      writeStakeHistory(ahead, history([[at, e(1n)]]));
      expect(() => new StakeCluster(ahead)).toThrow(new RegExp(`entry for epoch ${at} but the Clock is at epoch 3`));
    }
    // Only tracked accounts count when allStakeAccounts is false.
    const payer = await generateKeyPairSigner();
    svm.airdrop(payer.address, lamports(100n * SOL));
    const vote = await createVoteAccount(svm, payer);
    const stake = await createStakeAccount(svm, payer, { staker: payer.address, withdrawer: payer.address, lamports: 10n * SOL });
    await delegateStake(svm, payer, { stake, vote });
    const only = new StakeCluster(svm, { base: e(), allStakeAccounts: false });
    expect(only.delegations()).toEqual([]);
    expect(
      only
        .track(stake)
        .delegations()
        .map((d) => d.stake),
    ).toEqual([10n * SOL - svm.minimumBalanceForRentExemption(200n)]);
  });
});

describe("StakeCluster.warpToEpoch", () => {
  it("refuses a Clock moved past the history outside the cluster (epochs left without an entry)", () => {
    const svm = new LiteSVM();
    const cluster = new StakeCluster(svm, { base: (ep) => e(1000n + ep) });
    cluster.nextEpoch();
    expect([...cluster.history.keys()]).toEqual([0n]);
    // The plain warpToEpoch moves the Clock only: epochs 1 and 2 would have no entry.
    warpToEpoch(svm, 3n);
    expect(() => cluster.nextEpoch()).toThrow(/ends at epoch 0 but the Clock is at epoch 3/);
    expect(() => cluster.warpToEpoch(5n)).toThrow(/ends at epoch 0 but the Clock is at epoch 3/);
    expect([...cluster.history.keys()]).toEqual([0n]);
    expect(cluster.epoch).toBe(3n);
  });

  it("from a new LiteSVM, moves the slot back to the epoch's first slot on the first warp, the time forward", () => {
    const svm = new LiteSVM();
    const before = svm.getClock();
    expect([before.epoch, before.slot]).toEqual([0n, 454_464_000n]);
    const cluster = new StakeCluster(svm);
    cluster.nextEpoch();
    const after = svm.getClock();
    expect(after.epoch).toBe(1n);
    expect(after.slot).toBe(firstSlotInEpoch(svm.getEpochSchedule(), 1n)); // 32: the warmup schedule's
    expect(after.slot < before.slot).toBe(true);
    expect(after.unixTimestamp > before.unixTimestamp).toBe(true);
    // From then on, each warp moves the slot forward.
    cluster.nextEpoch();
    expect(svm.getClock().slot > after.slot).toBe(true);
  });
});

function warpOn(cluster: StakeCluster, epoch: bigint) {
  cluster.warpToEpoch(epoch);
  expect(cluster.epoch).toBe(epoch);
}
