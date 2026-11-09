// showcase/mainnet/spl-stake-pool against SPL Stake Pool as deployed on mainnet (test/programs/spl_stake_pool.so):
// the rebalancing instructions, IncreaseValidatorStake (4), IncreaseAdditionalValidatorStake (19),
// DecreaseValidatorStake (3, deprecated), DecreaseAdditionalValidatorStake (20) and DecreaseValidatorStakeWithReserve
// (21), and UpdateValidatorListBalance merging the transient stake they leave, over epochs. The harness
// (spl-stake-pool-helpers.ts) runs both programs side by side; every transaction must have the same outcome, the same
// log lines and the same bytes in every account it names. The outcomes are checked too, so each path is really reached.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, lamports } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CLOCK,
  Diff,
  type Pool,
  PROGRAM,
  RENT,
  SOL,
  STAKE,
  STAKE_ACCOUNT_SIZE,
  STAKE_OFFSETS,
  STAKE_CONFIG,
  STAKE_HISTORY,
  STAKE_POOL_SIZE,
  SYSTEM,
  builtin,
  custom,
  ephemeralStake,
  ix,
  key,
  transientStake,
  u8,
  updatePairs,
  validatorStake,
} from "./spl-stake-pool-helpers.js";
import { stakeHistoryEntry } from "../../src/testing-stake.js";

/** StakePoolError codes. */
const E = {
  InvalidProgramAddress: 1,
  InvalidState: 2,
  CalculationFailure: 3,
  SignatureMissing: 7,
  InvalidValidatorStakeList: 8,
  WrongStakeStake: 11,
  /** Also StakeError::InsufficientDelegation (12), which IncreaseValidatorStake returns for too few lamports. */
  UserStakeNotActive: 12,
  ValidatorNotFound: 14,
  InvalidStakeAccountAddress: 15,
  StakeListAndPoolOutOfDate: 17,
  WrongStaker: 21,
  TransientAccountInUse: 33,
  ReserveDepleted: 41,
} as const;

const diffs: Diff[] = [];
async function diff(opts?: Parameters<typeof Diff.create>[0]): Promise<Diff> {
  const d = await Diff.create(opts);
  diffs.push(d);
  return d;
}

type AccountList = { address: Address; role: AccountRole; signer?: KeyPairSigner }[];
function accounts(i: Instruction, edit: (list: AccountList) => void): Instruction {
  const list = [...(i.accounts ?? [])].map((a) => ({ ...a })) as AccountList;
  edit(list);
  return { ...i, accounts: list as Instruction["accounts"] };
}
const truncate = (i: Instruction, n: number) => accounts(i, (l) => l.splice(n));
const replace = (i: Instruction, at: number, address: Address) =>
  accounts(i, (l) => {
    const role = l[at]!.role;
    l[at] = { address, role: role === AccountRole.READONLY_SIGNER ? AccountRole.READONLY : role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : role };
  });

/** The rent of a 200-byte stake account, and the pool's minimum delegation (read from the first validator added). */
const RENT_200 = new LiteSVM().minimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE);
let MIN = 0n;

/** A pool, its validators (vote, validator stake), and the epoch moved on and updated so their stake is active. */
interface Validators {
  p: Pool;
  votes: Address[];
  stakes: Address[];
}
async function poolWithValidators(d: Diff, payer: KeyPairSigner, n: number, reserveSol: bigint, label: string, seeds = false): Promise<Validators> {
  const p = await d.createPool(payer, { reserveLamports: reserveSol * SOL, maxValidators: n + 2, label: `initialize (${label})` });
  const votes: Address[] = [];
  const stakes: Address[] = [];
  for (let i = 0; i < n; i++) {
    const v = await d.vote(payer);
    const seed = seeds ? i % 3 : 0;
    const s = await validatorStake(v, p.pool, seed);
    await d.ok(`add validator (${label} ${i})`, payer, [ix.addValidator(p, p.staker, s, v, seed)]);
    // A validator is added with the pool's minimum delegation and a stake account's rent.
    if (i === 0) MIN = d.validators(p)[0]!.active - RENT_200;
    votes.push(v);
    stakes.push(s);
  }
  d.nextEpoch();
  await update(d, payer, p, `${label} start`);
  return { p, votes, stakes };
}

/** UpdateValidatorListBalance over the whole list (in chunks of 4 pairs: merges are dear), then UpdateStakePoolBalance. */
async function update(d: Diff, payer: KeyPairSigner, p: Pool, label: string): Promise<string[]> {
  const pairs = await updatePairs(d, p);
  const out: string[] = [];
  for (let i = 0; i < Math.max(pairs.length, 1); i += 4)
    out.push(await d.both(`update list (${label}${i ? ` ${i}` : ""})`, payer, [ix.updateValidatorListBalance(p, i, false, pairs.slice(i, i + 4))]));
  out.push(await d.both(`update pool (${label})`, payer, [ix.updateStakePoolBalance(p)]));
  return out;
}

describe("instruction decoding and account counts", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let v: Validators;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(10_000n);
    v = await poolWithValidators(d, payer, 1, 20n, "decoding");
  });

  it("refuses data of the wrong length for each tag", async () => {
    const pool = [{ address: v.p.pool, role: AccountRole.WRITABLE }] as Instruction["accounts"];
    const bad: [string, Buffer][] = [
      ["DecreaseValidatorStake short", Buffer.concat([u8(3), Buffer.alloc(15)])],
      ["DecreaseValidatorStake long", Buffer.concat([u8(3), Buffer.alloc(17)])],
      ["IncreaseValidatorStake short", Buffer.concat([u8(4), Buffer.alloc(8)])],
      ["IncreaseAdditionalValidatorStake short", Buffer.concat([u8(19), Buffer.alloc(16)])],
      ["IncreaseAdditionalValidatorStake long", Buffer.concat([u8(19), Buffer.alloc(25)])],
      ["DecreaseAdditionalValidatorStake short", Buffer.concat([u8(20), Buffer.alloc(23)])],
      ["DecreaseValidatorStakeWithReserve long", Buffer.concat([u8(21), Buffer.alloc(24)])],
    ];
    for (const [label, data] of bad) expect(await d.both(`decode: ${label}`, payer, [ix.raw(data, pool as never)]), label).toBe(builtin("BorshIoError"));
  });

  it("counts accounts where the original takes them, the sysvars checked as they are taken", async () => {
    const { p, votes, stakes } = v;
    const t = await transientStake(votes[0]!, p.pool, 0n);
    const eph = await ephemeralStake(p.pool, 0n);
    const inc = ix.increaseValidatorStake(p, p.staker, t, stakes[0]!, votes[0]!, SOL, 0n);
    const incAdd = ix.increaseAdditionalValidatorStake(p, p.staker, { ephemeral: eph, transient: t, stake: stakes[0]!, vote: votes[0]! }, SOL, 0n, 0n);
    const dec = ix.decreaseValidatorStake(p, p.staker, stakes[0]!, t, SOL, 0n);
    const decRes = ix.decreaseValidatorStakeWithReserve(p, p.staker, stakes[0]!, t, SOL, 0n);
    const decAdd = ix.decreaseAdditionalValidatorStake(p, p.staker, { stake: stakes[0]!, ephemeral: eph, transient: t }, SOL, 0n, 0n);
    // [instruction, clock index, rent index (or -1), account count]
    const cases: [string, Instruction, number, number, number][] = [
      ["increase", inc, 8, 9, 14],
      ["increase additional", incAdd, 9, -1, 14],
      ["decrease", dec, 6, 7, 10],
      ["decrease with reserve", decRes, 7, -1, 11],
      ["decrease additional", decAdd, 8, -1, 12],
    ];
    for (const [label, i, clock, rent, n] of cases) {
      const run = (what: string, x: Instruction) => d.both(`${label}: ${what}`, payer, [x]);
      expect(await run(`${clock} accounts`, truncate(i, clock))).toBe(builtin("NotEnoughAccountKeys"));
      expect(await run("wrong clock", truncate(replace(i, clock, RENT), clock + 1))).toBe(builtin("InvalidArgument"));
      expect(await run(`${clock + 1} accounts`, truncate(i, clock + 1))).toBe(builtin("NotEnoughAccountKeys"));
      if (rent >= 0) {
        expect(await run("wrong rent", truncate(replace(i, rent, CLOCK), rent + 1))).toBe(builtin("InvalidArgument"));
        expect(await run(`${rent + 1} accounts`, truncate(i, rent + 1))).toBe(builtin("NotEnoughAccountKeys"));
      }
      expect(await run(`${n - 1} accounts`, truncate(i, n - 1))).toBe(builtin("NotEnoughAccountKeys"));
      expect(await run("wrong system program", replace(i, n - 2, STAKE))).toBe(builtin("IncorrectProgramId"));
      expect(await run("wrong stake program", replace(i, n - 1, SYSTEM))).toBe(builtin("IncorrectProgramId"));
    }
  });
});

describe("IncreaseValidatorStake and IncreaseAdditionalValidatorStake", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let v: Validators;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(10_000n);
    v = await poolWithValidators(d, payer, 4, 200n, "increase");
  });
  const transient = (i: number, seed: bigint) => transientStake(v.votes[i]!, v.p.pool, seed);
  const inc = async (i: number, amount: bigint, seed: bigint) =>
    ix.increaseValidatorStake(v.p, v.p.staker, await transient(i, seed), v.stakes[i]!, v.votes[i]!, amount, seed);
  const incAdd = async (i: number, amount: bigint, seed: bigint, ephemeralSeed: bigint) =>
    ix.increaseAdditionalValidatorStake(
      v.p,
      v.p.staker,
      { ephemeral: await ephemeralStake(v.p.pool, ephemeralSeed), transient: await transient(i, seed), stake: v.stakes[i]!, vote: v.votes[i]! },
      amount,
      seed,
      ephemeralSeed,
    );

  it("refuses bad accounts and amounts, in the original's order", async () => {
    const { p, votes, stakes } = v;
    const run = (label: string, i: Instruction) => d.both(`increase: ${label}`, payer, [i]);
    const good = await inc(0, 5n * SOL, 1n);
    const foreign = await d.allocated(payer, STAKE_POOL_SIZE, SYSTEM);
    const blank = await d.allocated(payer, STAKE_POOL_SIZE, PROGRAM);
    expect(await run("pool not the program's", replace(good, 0, foreign))).toBe(builtin("IncorrectProgramId"));
    expect(await run("pool uninitialized", replace(good, 0, blank))).toBe(custom(E.InvalidState));
    expect(await run("wrong withdraw authority", replace(good, 2, p.reserve))).toBe(custom(E.InvalidProgramAddress));
    expect(await run("wrong staker", ix.increaseValidatorStake(p, p.manager, await transient(0, 1n), stakes[0]!, votes[0]!, SOL, 1n))).toBe(
      custom(E.WrongStaker),
    );
    expect(await run("staker not signing", ix.increaseValidatorStake(p, p.staker.address, await transient(0, 1n), stakes[0]!, votes[0]!, SOL, 1n))).toBe(
      custom(E.SignatureMissing),
    );
    expect(await run("wrong list", replace(good, 3, p.reserve))).toBe(custom(E.InvalidValidatorStakeList));
    expect(await run("wrong reserve", replace(good, 4, p.list))).toBe(custom(E.InvalidProgramAddress));
    const other = await d.vote(payer);
    expect(await run("vote not in the pool", replace(good, 7, other))).toBe(custom(E.ValidatorNotFound));
    expect(await run("validator stake not a stake account", replace(good, 6, p.list))).toBe(builtin("IncorrectProgramId"));
    expect(await run("another validator's stake", replace(good, 6, stakes[1]!))).toBe(custom(E.InvalidStakeAccountAddress));
    expect(await run("below the minimum delegation", await inc(0, MIN - 1n, 1n))).toBe(custom(E.UserStakeNotActive));
    expect(await run("more than the reserve has", await inc(0, 200n * SOL, 1n))).toBe(builtin("InsufficientFunds"));
    expect(await run("wrong transient address", replace(good, 5, await transient(0, 2n)))).toBe(custom(E.InvalidStakeAccountAddress));
    expect(await run("wrong ephemeral address", replace(await incAdd(0, SOL, 1n, 1n), 5, await ephemeralStake(p.pool, 2n)))).toBe(
      custom(E.InvalidStakeAccountAddress),
    );
    // An additional increase with a wrong transient address fails after the ephemeral stake was made and delegated.
    expect(await run("additional, wrong transient address", replace(await incAdd(0, SOL, 1n, 1n), 6, await transient(0, 2n)))).toBe(
      custom(E.InvalidStakeAccountAddress),
    );
  });

  it("increases, then adds to the transient stake in the same epoch only", async () => {
    await d.ok("increase", payer, [await inc(0, 5n * SOL, 3n)]);
    expect(await d.both("increase: transient in use", payer, [await inc(0, SOL, 3n)])).toBe(custom(E.TransientAccountInUse));
    expect(await d.both("increase additional: wrong seed", payer, [await incAdd(0, SOL, 4n, 0n)])).toBe(builtin("InvalidSeeds"));
    await d.ok("increase additional (merge)", payer, [await incAdd(0, 2n * SOL, 3n, 0n)]);
    // The ephemeral seed may be used again: the ephemeral stake account is merged away.
    await d.ok("increase additional again", payer, [await incAdd(0, SOL, 3n, 0n)]);
    // No transient stake yet: the ephemeral stake is split whole into a new transient stake account.
    await d.ok("increase additional (split)", payer, [await incAdd(1, 3n * SOL, 0n, 7n)]);
    await d.ok("increase legacy (seed 0)", payer, [await inc(2, MIN, 0n)]);
    expect(d.validators(v.p)[0]!.transient).toBe(8n * SOL + 3n * RENT_200);
    d.nextEpoch();
    // The epoch after: the transient stake is no longer activating in this epoch.
    expect(await d.both("increase additional: next epoch", payer, [await incAdd(0, SOL, 3n, 0n)])).toBe(custom(E.StakeListAndPoolOutOfDate));
    await update(d, payer, v.p, "after increase");
    expect(d.validators(v.p).every((x) => x.transient === 0n)).toBe(true);
    // Merged into the validator stake; the same seed may be used again.
    await d.ok("increase after merge", payer, [await inc(0, SOL, 3n)]);
    d.nextEpoch();
    await update(d, payer, v.p, "after increase 2");
  });

  it("refuses an additional increase of a transient stake from an earlier epoch", async () => {
    await d.ok("increase (stale transient)", payer, [await inc(3, 2n * SOL, 5n)]);
    d.nextEpoch();
    // Only the pool is updated (no merge): the transient stake from last epoch is still there.
    await d.ok("update pool only (stale transient)", payer, [ix.updateValidatorListBalance(v.p, 0, true, await updatePairs(d, v.p))]);
    await d.ok("update pool (stale transient)", payer, [ix.updateStakePoolBalance(v.p)]);
    expect(await d.both("increase additional: transient not activating now", payer, [await incAdd(3, SOL, 5n, 0n)])).toBe(custom(E.WrongStakeStake));
    expect(await d.both("decrease additional: transient activating", payer, [await decAddOf(d, v, 3, SOL, 5n, 0n)])).toBe(custom(E.WrongStakeStake));
    await update(d, payer, v.p, "stale transient");
  });

  it("refuses validators marked for removal", async () => {
    const pairs = await updatePairs(d, v.p);
    await d.ok("remove validator (increase)", payer, [ix.removeValidator(v.p, v.p.staker, pairs[1]![0], pairs[1]![1])]);
    expect(await d.both("increase: validator removed", payer, [await inc(1, SOL, 9n)])).toBe(custom(E.ValidatorNotFound));
    expect(await d.both("decrease: validator removed", payer, [await decResOf(d, v, 1, SOL, 9n)])).toBe(custom(E.ValidatorNotFound));
  });
});

const decResOf = async (d: Diff, v: Validators, i: number, amount: bigint, seed: bigint) =>
  ix.decreaseValidatorStakeWithReserve(v.p, v.p.staker, v.stakes[i]!, await transientStake(v.votes[i]!, v.p.pool, seed), amount, seed);
const decOf = async (d: Diff, v: Validators, i: number, amount: bigint, seed: bigint) =>
  ix.decreaseValidatorStake(v.p, v.p.staker, v.stakes[i]!, await transientStake(v.votes[i]!, v.p.pool, seed), amount, seed);
const decAddOf = async (d: Diff, v: Validators, i: number, amount: bigint, seed: bigint, ephemeralSeed: bigint) =>
  ix.decreaseAdditionalValidatorStake(
    v.p,
    v.p.staker,
    { stake: v.stakes[i]!, ephemeral: await ephemeralStake(v.p.pool, ephemeralSeed), transient: await transientStake(v.votes[i]!, v.p.pool, seed) },
    amount,
    seed,
    ephemeralSeed,
  );

describe("DecreaseValidatorStake, DecreaseValidatorStakeWithReserve and DecreaseAdditionalValidatorStake", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let v: Validators;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(10_000n);
    v = await poolWithValidators(d, payer, 5, 100n, "decrease");
    // Stake for the validators to give back: 20 SOL each.
    for (let i = 0; i < 5; i++)
      await d.ok(`increase (decrease ${i})`, payer, [
        ix.increaseValidatorStake(v.p, v.p.staker, await transientStake(v.votes[i]!, v.p.pool, 0n), v.stakes[i]!, v.votes[i]!, 3n * SOL, 0n),
      ]);
    d.nextEpoch();
    await update(d, payer, v.p, "decrease funded");
  });

  it("refuses bad accounts and amounts, in the original's order", async () => {
    const { p, stakes } = v;
    const run = (label: string, i: Instruction) => d.both(`decrease: ${label}`, payer, [i]);
    const good = await decResOf(d, v, 0, SOL, 1n);
    const foreign = await d.allocated(payer, STAKE_POOL_SIZE, SYSTEM);
    const blank = await d.allocated(payer, STAKE_POOL_SIZE, PROGRAM);
    expect(await run("pool not the program's", replace(good, 0, foreign))).toBe(builtin("IncorrectProgramId"));
    expect(await run("pool uninitialized", replace(good, 0, blank))).toBe(custom(E.InvalidState));
    expect(await run("wrong withdraw authority", replace(good, 2, p.reserve))).toBe(custom(E.InvalidProgramAddress));
    expect(await run("staker not signing", ix.decreaseValidatorStakeWithReserve(p, p.staker.address, stakes[0]!, p.reserve, SOL, 1n))).toBe(
      custom(E.SignatureMissing),
    );
    expect(await run("wrong list", replace(good, 3, p.reserve))).toBe(custom(E.InvalidValidatorStakeList));
    expect(await run("list not the program's", replace(good, 3, foreign))).toBe(custom(E.InvalidValidatorStakeList));
    expect(await run("wrong reserve", replace(good, 4, p.pool))).toBe(custom(E.InvalidProgramAddress));
    expect(await run("validator stake not a stake account", replace(good, 5, p.pool))).toBe(builtin("BorshIoError"));
    expect(await run("validator stake only initialized", replace(good, 5, p.reserve))).toBe(custom(E.WrongStakeStake));
    // A stake account delegated to a validator of the pool, but not its validator stake account.
    const owner = await d.funded(10n);
    const outsider = await d.stakeAccount(payer, { staker: owner.address, withdrawer: owner.address, lamports: RENT_200 + 2n * SOL });
    d.patch(outsider, (b) => {
      b.writeUInt32LE(2, 0);
      Buffer.from(d.data(stakes[0]!).subarray(STAKE_OFFSETS.voter, STAKE_OFFSETS.voter + 32)).copy(b, STAKE_OFFSETS.voter);
      b.writeBigUInt64LE(2n ** 64n - 1n, STAKE_OFFSETS.deactivation);
    });
    expect(await run("not the validator stake account", replace(good, 5, outsider))).toBe(custom(E.InvalidStakeAccountAddress));
    d.patch(outsider, (b) => (b[STAKE_OFFSETS.voter] ^= 1));
    expect(await run("delegated to a validator not in the pool", replace(good, 5, outsider))).toBe(custom(E.ValidatorNotFound));
    expect(await run("below the minimum delegation", await decResOf(d, v, 0, MIN - 1n, 1n))).toBe(builtin("AccountNotRentExempt"));
    const held = d.lamports(stakes[0]!);
    expect(await run("more than the validator stake holds", await decResOf(d, v, 0, held + 1n, 1n))).toBe(builtin("InsufficientFunds"));
    expect(await run("all of the validator stake", await decResOf(d, v, 0, held, 1n))).toBe(builtin("InsufficientFunds"));
    expect(await run("leaving less than the minimum", await decResOf(d, v, 0, held - MIN, 1n))).toBe(builtin("InsufficientFunds"));
    expect(await run("wrong transient address", replace(good, 6, await transientStake(v.votes[0]!, p.pool, 2n)))).toBe(custom(E.InvalidStakeAccountAddress));
    expect(await run("additional, wrong ephemeral address", replace(await decAddOf(d, v, 0, SOL, 1n, 1n), 6, await ephemeralStake(p.pool, 2n)))).toBe(
      custom(E.InvalidStakeAccountAddress),
    );
    expect(
      await run("additional, wrong transient address", replace(await decAddOf(d, v, 0, SOL, 1n, 1n), 7, await transientStake(v.votes[0]!, p.pool, 2n))),
    ).toBe(custom(E.InvalidStakeAccountAddress));
  });

  it("decreases with the reserve paying rent, then adds to the transient stake in the same epoch", async () => {
    await d.ok("decrease with reserve", payer, [await decResOf(d, v, 0, 2n * SOL, 5n)]);
    expect(await d.both("decrease with reserve: transient in use", payer, [await decResOf(d, v, 0, SOL, 5n)])).toBe(custom(E.TransientAccountInUse));
    expect(await d.both("decrease: transient in use", payer, [await decOf(d, v, 0, SOL, 5n)])).toBe(custom(E.TransientAccountInUse));
    expect(await d.both("decrease additional: wrong seed", payer, [await decAddOf(d, v, 0, SOL, 6n, 0n)])).toBe(builtin("InvalidSeeds"));
    expect(await d.both("increase additional: transient deactivating", payer, [await incAddOf(v, 0, SOL, 5n, 0n)])).toBe(custom(E.WrongStakeStake));
    // Stake deactivated this epoch out of an active validator stake is transient: the Stake program will not merge
    // the ephemeral stake into it (MergeTransientStake), in both.
    expect(await d.both("decrease additional: active stake, merge refused", payer, [await decAddOf(d, v, 0, SOL, 5n, 0n)])).toBe(
      "error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: 5 } }",
    );
    await d.ok("decrease additional (split)", payer, [await decAddOf(d, v, 1, SOL, 2n, 3n)]);
    // The deprecated instruction pays no rent: the Stake program refuses to split active stake into an account that
    // is not rent-exempt already, so the transient account must be funded beforehand.
    expect(await d.both("decrease (deprecated): transient not funded", payer, [await decOf(d, v, 2, SOL, 0n)])).toBe(builtin("InsufficientFunds"));
    const t2 = await transientStake(v.votes[2]!, v.p.pool, 0n);
    for (const vm of d.vms) vm.airdrop(t2, lamports(RENT_200));
    await d.ok("decrease (deprecated)", payer, [await decOf(d, v, 2, SOL, 0n)], [t2]);
    d.nextEpoch();
    expect(await d.both("decrease additional: next epoch", payer, [await decAddOf(d, v, 0, SOL, 5n, 0n)])).toBe(custom(E.StakeListAndPoolOutOfDate));
    await update(d, payer, v.p, "after decrease");
    expect(d.validators(v.p).every((x) => x.transient === 0n)).toBe(true);
  });

  it("decreases where the reserve cannot pay rent, or the transient account was funded", async () => {
    // The deprecated instruction with a transient account funded short of its rent: still refused; funded, it splits.
    const t3 = await transientStake(v.votes[3]!, v.p.pool, 1n);
    for (const vm of d.vms) vm.airdrop(t3, lamports(RENT_200 - 1n));
    expect(await d.both("decrease (deprecated): transient short of rent", payer, [await decOf(d, v, 3, MIN, 1n)], [t3])).toBe(builtin("InsufficientFunds"));
    for (const vm of d.vms) vm.airdrop(t3, lamports(1n));
    await d.ok("decrease (deprecated): transient funded", payer, [await decOf(d, v, 3, MIN, 1n)], [t3]);
    const t4 = await transientStake(v.votes[4]!, v.p.pool, 1n);
    for (const vm of d.vms) vm.airdrop(t4, lamports(RENT_200));
    await d.ok("decrease with reserve: transient funded", payer, [await decResOf(d, v, 4, SOL, 1n)], [t4]);
    // An ephemeral account funded beforehand needs less rent from the reserve; its transient account none.
    const e = await ephemeralStake(v.p.pool, 9n);
    for (const vm of d.vms) vm.airdrop(e, lamports(RENT_200 / 2n));
    await d.ok("decrease additional: ephemeral half funded", payer, [await decAddOf(d, v, 0, SOL, 3n, 9n)], [e]);
    const e2 = await ephemeralStake(v.p.pool, 10n);
    for (const vm of d.vms) vm.airdrop(e2, lamports(RENT_200));
    await d.ok("decrease additional: ephemeral funded", payer, [await decAddOf(d, v, 1, SOL, 3n, 10n)], [e2]);
    d.nextEpoch();
    await update(d, payer, v.p, "after funded");
  });

  it("merges an additional decrease of stake that activated this epoch", async () => {
    // A validator added in this epoch, its stake grown as a stake deposit would grow it: stake split off it and
    // deactivated in its activation epoch is inactive at once, so the ephemeral stake merges into the transient.
    const vote = await d.vote(payer);
    const stake = await validatorStake(vote, v.p.pool);
    await d.ok("add validator (activating)", payer, [ix.addValidator(v.p, v.p.staker, stake, vote)]);
    const extra = 10n * SOL;
    d.patch(stake, (b) => b.writeBigUInt64LE(b.readBigUInt64LE(STAKE_OFFSETS.stake) + extra, STAKE_OFFSETS.stake), { lamports: d.lamports(stake) + extra });
    const at = 9 + 73 * (d.validators(v.p).length - 1);
    d.patch(v.p.list, (b) => b.writeBigUInt64LE(b.readBigUInt64LE(at) + extra, at));
    const w: Validators = { p: v.p, votes: [vote], stakes: [stake] };
    await d.ok("decrease with reserve (activating)", payer, [await decResOf(d, w, 0, 3n * SOL, 1n)]);
    await d.ok("decrease additional (merge)", payer, [await decAddOf(d, w, 0, 2n * SOL, 1n, 2n)]);
    await d.ok("decrease additional (merge again)", payer, [await decAddOf(d, w, 0, MIN, 1n, 2n)]);
    expect(d.validators(v.p).at(-1)!.transient).toBe(5n * SOL + MIN + 3n * RENT_200);
    d.nextEpoch();
    await update(d, payer, v.p, "after merge");
    expect(d.validators(v.p).at(-1)!.transient).toBe(0n);
  });

  it("refuses to fund rent from a reserve that has only its own", async () => {
    // The reserve holds what one validator takes and its own rent; after the update the validator holds more.
    const p = await d.createPool(payer, { reserveLamports: MIN + RENT_200, maxValidators: 2, label: "initialize (poor reserve)" });
    const vote = await d.vote(payer);
    const stake = await validatorStake(vote, p.pool);
    await d.ok("add validator (poor reserve)", payer, [ix.addValidator(p, p.staker, stake, vote)]);
    d.nextEpoch();
    await update(d, payer, p, "poor reserve");
    const poor: Validators = { p, votes: [vote], stakes: [stake] };
    // The validator holds the minimum; give it more through the stake account directly, as rewards would.
    for (const vm of d.vms) vm.airdrop(poor.stakes[0]!, lamports(5n * SOL));
    expect(await d.both("decrease with reserve: reserve depleted", payer, [await decResOf(d, poor, 0, SOL, 0n)])).toBe(custom(E.ReserveDepleted));
    expect(await d.both("decrease additional: reserve depleted", payer, [await decAddOf(d, poor, 0, SOL, 0n, 0n)])).toBe(custom(E.ReserveDepleted));
  });

  it("reports a validator stake under its minimum as a calculation failure", async () => {
    const low = await poolWithValidators(d, payer, 1, 5n, "low validator");
    // Lamports taken from the validator stake account (as a slashing would): under rent plus the minimum delegation.
    d.patch(low.stakes[0]!, () => {}, { lamports: RENT_200 + MIN - 1n });
    expect(await d.both("decrease: validator under its minimum", payer, [await decResOf(d, low, 0, MIN, 0n)])).toBe(custom(E.CalculationFailure));
  });
});

const incAddOf = async (v: Validators, i: number, amount: bigint, seed: bigint, ephemeralSeed: bigint) =>
  ix.increaseAdditionalValidatorStake(
    v.p,
    v.p.staker,
    {
      ephemeral: await ephemeralStake(v.p.pool, ephemeralSeed),
      transient: await transientStake(v.votes[i]!, v.p.pool, seed),
      stake: v.stakes[i]!,
      vote: v.votes[i]!,
    },
    amount,
    seed,
    ephemeralSeed,
  );

describe("warmup and cooldown over several epochs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    // The rest of the cluster is small after the first epoch: about 9% of it may warm up or cool down per epoch, so
    // the transient stake activates and deactivates over several epochs, and merges wait for it.
    d = await diff({ cluster: { base: (epoch) => (epoch < 2n ? stakeHistoryEntry(400_000_000n * SOL) : stakeHistoryEntry(100n * SOL)) } });
    payer = await d.funded(100_000n);
  });

  it("merges the transient stake only once it is fully active or inactive", async () => {
    // Epoch 1: the validators are active; stake added to validator 1 now still warms up at once.
    const v = await poolWithValidators(d, payer, 2, 500n, "slow");
    await d.ok("increase (fast)", payer, [await incOf(v, 1, 100n * SOL, 0n)]);
    d.nextEpoch();
    await update(d, payer, v.p, "fast");
    // Epoch 2 on: only about 9 SOL may warm up or cool down per epoch.
    await d.ok("increase (slow)", payer, [await incOf(v, 0, 50n * SOL, 0n)]);
    await d.ok("decrease (slow)", payer, [await decResOf(d, v, 1, 50n * SOL, 1n)]);
    const outcomes: string[] = [];
    for (let e = 0; e < 12 && d.validators(v.p).some((x) => x.transient !== 0n); e++) {
      d.nextEpoch();
      outcomes.push(...(await update(d, payer, v.p, `slow ${e}`)));
    }
    expect(
      d.validators(v.p).every((x) => x.transient === 0n),
      outcomes.join("\n"),
    ).toBe(true);
    console.log(
      `slow: ${outcomes.length} updates, ${outcomes.filter((o) => o !== "ok").length} refused; transient ${d.validators(v.p).map((x) => x.transient)}`,
    );
  });
});

const incOf = async (v: Validators, i: number, amount: bigint, seed: bigint) =>
  ix.increaseValidatorStake(v.p, v.p.staker, await transientStake(v.votes[i]!, v.p.pool, seed), v.stakes[i]!, v.votes[i]!, amount, seed);

describe("a pool of 52 validators", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let v: Validators;
  const N = 52;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
    v = await poolWithValidators(d, payer, N, 2_000n, "52", true);
  });

  it("rebalances across the list, then merges every transient stake over two epochs", async () => {
    // Increases at both ends of the list (the search goes through it), then decreases out of them.
    const ends = [...Array(8).keys(), ...Array.from({ length: 8 }, (_, k) => N - 8 + k)];
    for (const i of ends) await d.ok(i === N - 1 ? "increase (52, last)" : `increase (52 ${i})`, payer, [await incOf(v, i, 10n * SOL, BigInt(i))]);
    await d.ok("increase additional (52, last)", payer, [await incAddOf(v, N - 1, 5n * SOL, BigInt(N - 1), 1n)]);
    d.nextEpoch();
    await update(d, payer, v.p, "52 increased");
    for (let i = 0; i < 8; i++)
      await d.ok(i === 0 ? "decrease with reserve (52, first)" : `decrease with reserve (52 ${i})`, payer, [await decResOf(d, v, i, 4n * SOL, 1n)]);
    await d.ok("decrease with reserve (52, last)", payer, [await decResOf(d, v, N - 1, 4n * SOL, 1n)]);
    await d.ok("decrease additional (52, split)", payer, [await decAddOf(d, v, N - 2, 2n * SOL, 1n, 4n)]);
    for (let i = N - 8; i < N - 2; i++) {
      const t = await transientStake(v.votes[i]!, v.p.pool, 2n);
      for (const vm of d.vms) vm.airdrop(t, lamports(RENT_200));
      await d.ok(`decrease (52 ${i})`, payer, [await decOf(d, v, i, 2n * SOL, 2n)]);
    }
    d.nextEpoch();
    await update(d, payer, v.p, "52 decreased");
    expect(d.validators(v.p).every((x) => x.transient === 0n)).toBe(true);
  });
});

describe("accounts in the wrong slots, and balances out of range", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let v: Validators;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(10_000n);
    v = await poolWithValidators(d, payer, 4, 100n, "slots");
    for (let i = 0; i < 4; i++) await d.ok(`increase (slots ${i})`, payer, [await incOf(v, i, 10n * SOL, 0n)]);
    d.nextEpoch();
    await update(d, payer, v.p, "slots funded");
  });

  it("panics where the original finds the validator list passed again (its data is borrowed)", async () => {
    // "already mutably borrowed": the original's panic handler logs no message, only the runtime's location.
    const check = async (label: string, i: Instruction, at: string) => {
      expect(await d.both(label, payer, [i]), label).toBe(builtin("ProgramFailedToComplete"));
      expect(d.lastLogs, label).toContain(`Program ${PROGRAM} failed: SBF program Panicked in ${at}`);
    };
    // Decrease: AccountInfo::data_len of the validator stake account, before anything else reads it.
    await check("decrease: validator stake is the list", replace(await decResOf(d, v, 1, SOL, 1n), 5, v.p.list), "src/lib.rs at 105:19");
    // With a transient stake in this epoch, the Additional forms read it first.
    await d.ok("increase (slots, activating)", payer, [await incOf(v, 1, 2n * SOL, 1n)]);
    await check("increase additional: transient is the list", replace(await incAddOf(v, 1, SOL, 1n, 0n), 6, v.p.list), "program/src/processor.rs at 50:89");
    await d.ok("decrease (slots, deactivating)", payer, [await decResOf(d, v, 0, 2n * SOL, 1n)]);
    await check("decrease additional: transient is the list", replace(await decAddOf(d, v, 0, SOL, 1n, 0n), 7, v.p.list), "program/src/processor.rs at 50:89");
    // Elsewhere the list in another slot fails a check first, as in the original.
    expect(await d.both("increase: vote is the list", payer, [replace(await incOf(v, 2, SOL, 0n), 7, v.p.list)])).toBe(custom(E.ValidatorNotFound));
    expect(await d.both("increase: validator stake is the list", payer, [replace(await incOf(v, 2, SOL, 0n), 6, v.p.list)])).toBe(
      builtin("IncorrectProgramId"),
    );
    expect(await d.both("increase: transient is the list", payer, [replace(await incOf(v, 2, SOL, 0n), 5, v.p.list)])).toBe(
      custom(E.InvalidStakeAccountAddress),
    );
    expect(await d.both("increase additional: ephemeral is the list", payer, [replace(await incAddOf(v, 2, SOL, 0n, 0n), 5, v.p.list)])).toBe(
      custom(E.InvalidStakeAccountAddress),
    );
    expect(await d.both("decrease: reserve is the list", payer, [replace(await decResOf(d, v, 2, SOL, 0n), 4, v.p.list)])).toBe(
      custom(E.InvalidProgramAddress),
    );
    expect(await d.both("decrease: transient is the list", payer, [replace(await decResOf(d, v, 2, SOL, 0n), 6, v.p.list)])).toBe(
      custom(E.InvalidStakeAccountAddress),
    );
    expect(await d.both("decrease additional: ephemeral is the list", payer, [replace(await decAddOf(d, v, 2, SOL, 0n, 0n), 6, v.p.list)])).toBe(
      custom(E.InvalidStakeAccountAddress),
    );
  });

  it("refuses a StakeHistory or stake config account that is not the sysvar, at the CPI that names it", async () => {
    // The Stake instructions name the sysvar by address and the runtime does not find it among the accounts
    // (MissingAccount, logged by the runtime), in both.
    const check = async (label: string, i: Instruction, missing: string) => {
      expect(await d.both(label, payer, [i])).toBe(builtin("MissingAccount"));
      expect(d.lastLogs, label).toContain(`Instruction references an unknown account ${missing}`);
    };
    const HISTORY = "SysvarStakeHistory1111111111111111111111111";
    const CONFIG = "StakeConfig11111111111111111111111111111111";
    await check("increase: wrong stake history", replace(await incOf(v, 2, SOL, 0n), 10, v.p.mint), HISTORY);
    await check("increase: wrong stake config", replace(await incOf(v, 2, SOL, 0n), 11, v.p.mint), CONFIG);
    await check("increase additional: wrong stake history", replace(await incAddOf(v, 2, SOL, 0n, 0n), 10, v.p.mint), HISTORY);
    await check("increase additional (merge): wrong stake history", replace(await incAddOf(v, 1, SOL, 1n, 0n), 10, v.p.mint), HISTORY);
    await check("decrease with reserve: wrong stake history", replace(await decResOf(d, v, 2, SOL, 1n), 8, v.p.mint), HISTORY);
    await check("decrease additional: wrong stake history", replace(await decAddOf(d, v, 2, SOL, 1n, 0n), 9, v.p.mint), HISTORY);
    // The sysvar elsewhere in the instruction does not stand in for its slot: the runtime looks for the address only
    // among the accounts the CPI is given, those of its slots (Rust's invoke_signed account infos).
    const plus = (i: Instruction, address: Address) => accounts(i, (l) => l.push({ address, role: AccountRole.READONLY }));
    const elsewhere = async (label: string, i: Instruction, slot: number, sysvar: Address) =>
      check(`${label}, the sysvar appended`, plus(replace(i, slot, v.p.mint), sysvar), sysvar);
    await elsewhere("increase: wrong stake history", await incOf(v, 2, SOL, 0n), 10, STAKE_HISTORY);
    await elsewhere("increase: wrong stake config", await incOf(v, 2, SOL, 0n), 11, STAKE_CONFIG);
    await elsewhere("increase additional: wrong stake history", await incAddOf(v, 2, SOL, 0n, 0n), 10, STAKE_HISTORY);
    await elsewhere("increase additional: wrong stake config", await incAddOf(v, 2, SOL, 0n, 0n), 11, STAKE_CONFIG);
    await elsewhere("increase additional (merge): wrong stake history", await incAddOf(v, 1, SOL, 1n, 0n), 10, STAKE_HISTORY);
    await elsewhere("decrease with reserve: wrong stake history", await decResOf(d, v, 2, SOL, 1n), 8, STAKE_HISTORY);
    await elsewhere("decrease additional: wrong stake history", await decAddOf(d, v, 2, SOL, 1n, 0n), 9, STAKE_HISTORY);
    // DelegateStake finds them by address among its own accounts: swapped, both are there.
    const swapped = accounts(await incOf(v, 2, SOL, 7n), (l) => {
      const h = l[10]!;
      l[10] = l[11]!;
      l[11] = h;
    });
    await d.ok("increase: stake history and config swapped", payer, [swapped]);
  });

  it("checks the validator stake account's state on an increase", async () => {
    const stake = v.stakes[3]!;
    const bytes = d.data(stake);
    const other = await d.funded(1n);
    const restore = () => d.patch(stake, (b) => bytes.copy(b));
    d.patch(stake, (b) => key(other.address).copy(b, STAKE_OFFSETS.staker));
    expect(await d.both("increase: validator stake of another staker", payer, [await incOf(v, 3, SOL, 4n)])).toBe(custom(E.WrongStakeStake));
    restore();
    d.patch(stake, (b) => key(v.votes[1]!).copy(b, STAKE_OFFSETS.voter));
    expect(await d.both("increase: validator stake delegated elsewhere", payer, [await incOf(v, 3, SOL, 4n)])).toBe(custom(E.WrongStakeStake));
    d.patch(stake, (b) => b.writeUInt32LE(1, 0));
    expect(await d.both("increase: validator stake not delegated", payer, [await incOf(v, 3, SOL, 4n)])).toBe(custom(E.WrongStakeStake));
    d.patch(stake, (b) => b.writeUInt32LE(7, 0));
    expect(await d.both("increase: validator stake undecodable", payer, [await incOf(v, 3, SOL, 4n)])).toBe(builtin("BorshIoError"));
    restore();
  });

  it("fails at the end with a list passed read-only, after the same CPIs", async () => {
    // The list is written in place and the runtime refuses that at the instruction's end (ReadonlyDataModified).
    const ro = (i: Instruction) => accounts(i, (l) => (l[3] = { address: l[3]!.address, role: AccountRole.READONLY }));
    for (const [label, i] of [
      ["increase: list read-only", ro(await incOf(v, 3, SOL, 9n))],
      ["increase additional: list read-only", ro(await incAddOf(v, 3, SOL, 9n, 3n))],
      ["decrease with reserve: list read-only", ro(await decResOf(d, v, 3, SOL, 9n))],
      ["decrease additional: list read-only", ro(await decAddOf(d, v, 3, SOL, 9n, 3n))],
    ] as const)
      expect(await d.both(label, payer, [i]), label).toBe(builtin("ReadonlyDataModified"));
  });

  it("fails with CalculationFailure where the list's balances would overflow", async () => {
    const at = (i: number) => 9 + 73 * i;
    // Active lamports recorded under the amount decreased (the account holds more): after the CPIs.
    const active = d.validators(v.p)[3]!.active;
    d.patch(v.p.list, (b) => b.writeBigUInt64LE(MIN, at(3)));
    expect(await d.both("decrease: recorded active under the amount", payer, [await decResOf(d, v, 3, MIN + 1n, 5n)])).toBe(custom(E.CalculationFailure));
    d.patch(v.p.list, (b) => b.writeBigUInt64LE(active, at(3)));
    // Transient lamports recorded near u64::MAX: the additional increase overflows them, after its CPIs.
    const transient = d.validators(v.p)[1]!.transient;
    d.patch(v.p.list, (b) => b.writeBigUInt64LE(2n ** 64n - 1n - SOL, at(1) + 8));
    expect(await d.both("increase additional: transient lamports overflow", payer, [await incAddOf(v, 1, SOL, 1n, 0n)])).toBe(custom(E.CalculationFailure));
    d.patch(v.p.list, (b) => b.writeBigUInt64LE(transient, at(1) + 8));
  });

  it("refuses another account in UpdateValidatorListBalance's StakeHistory slot, the sysvar riding in a skipped pair", async () => {
    // Validators 0, 1 and 2 have transient stake from this epoch: the next epoch's update merges or deactivates it,
    // each Stake CPI naming the StakeHistory, which the runtime looks for among the CPI's accounts only.
    d.nextEpoch();
    const pairs = await updatePairs(d, v.p, 0, 3);
    const other = await d.funded(1n);
    // The fourth pair (validator 3's place) is not its accounts, so it is skipped; the StakeHistory rides in it.
    const bad = replace(ix.updateValidatorListBalance(v.p, 0, false, [...pairs, [STAKE_HISTORY, other.address]]), 5, v.p.mint);
    expect(await d.both("update list: wrong stake history, the sysvar in a skipped pair", payer, [bad])).toBe(builtin("MissingAccount"));
    expect(d.lastLogs).toContain(`Instruction references an unknown account ${STAKE_HISTORY}`);
    await update(d, payer, v.p, "after the stake history slot");
  });
});

describe("compute units", () => {
  it("reports compute units", () => {
    const all: Record<string, [bigint, bigint]> = {};
    let compared = 0;
    for (const d of diffs) {
      Object.assign(all, d.cu);
      compared += d.compared;
    }
    const rows: [string, string][] = [
      ["increase", "increase"],
      ["increase (52, last)", "increase (52, last)"],
      ["increase additional (merge)", "increase additional (merge)"],
      ["increase additional (split)", "increase additional (split)"],
      ["decrease (deprecated)", "decrease (deprecated)"],
      ["decrease with reserve", "decrease with reserve"],
      ["decrease with reserve (52)", "decrease with reserve (52, first)"],
      ["decrease additional (merge)", "decrease additional (merge)"],
      ["decrease additional (split)", "decrease additional (split)"],
      ["update list (merges)", "update list (after increase)"],
      ["update list (52, merges)", "update list (52 decreased)"],
    ];
    for (const [name, label] of rows) {
      const got = all[label];
      expect(got, label).toBeDefined();
      const [a, b] = got!;
      console.log(`${name.padEnd(30)} original ${String(a).padStart(7)}  TypeSOL ${String(b).padStart(7)}  ${((Number(b) / Number(a)) * 100).toFixed(0)}%`);
      expect(b, `${name}: TypeSOL ${b} vs original ${a}`).toBeLessThan(a);
    }
    console.log(`${compared} transactions compared`);
    expect(compared).toBeGreaterThan(300);
  });
});
