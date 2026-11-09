// showcase/mainnet/spl-stake-pool against SPL Stake Pool as deployed on mainnet (test/programs/spl_stake_pool.so):
// stake deposits and withdrawals (DepositStake, WithdrawStake and their slippage forms). The harness
// (spl-stake-pool-helpers.ts) runs both in their own LiteSVM with the same Clock and StakeHistory; every transaction
// must have the same outcome, the same log lines and the same bytes in every account it names. The users' stake
// accounts are made, delegated and activated over epochs by the Stake program itself, so the merges and splits the
// pool asks for meet the states they meet on a cluster.
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner, lamports } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CLOCK,
  Diff,
  PROGRAM,
  type Pool,
  SOL,
  STAKE,
  STAKE_ACCOUNT_SIZE,
  STAKE_HISTORY,
  STAKE_OFFSETS,
  SYSTEM,
  TOKEN,
  TOKEN_2022,
  builtin,
  custom,
  depositAuthority,
  fee,
  ix,
  key,
  outcome,
  stakeAuthorizeBoth,
  transientStake,
  u32,
  updatePairs,
  validatorStake,
  withdrawAuthority,
} from "./spl-stake-pool-helpers.js";
import { send } from "../../test/harness.js";

/** StakePoolError codes. */
const E = {
  InvalidProgramAddress: 1,
  InvalidState: 2,
  InvalidValidatorStakeList: 8,
  InvalidFeeAccount: 9,
  WrongPoolMint: 10,
  WrongStakeStake: 11,
  ValidatorNotFound: 14,
  InvalidStakeAccountAddress: 15,
  StakeListAndPoolOutOfDate: 17,
  StakeLamportsNotEqualToMinimum: 23,
  IncorrectDepositVoteAddress: 24,
  IncorrectWithdrawVoteAddress: 25,
  WithdrawalTooSmall: 28,
  DepositTooSmall: 29,
  InvalidStakeDepositAuthority: 30,
  SolWithdrawalTooLarge: 35,
  ExceededSlippage: 39,
} as const;

/** Every Diff of the file, for the CU table. */
const diffs: Diff[] = [];
async function diff(opts?: Parameters<typeof Diff.create>[0]): Promise<Diff> {
  const d = await Diff.create(opts);
  diffs.push(d);
  return d;
}

/** The instruction with its account list changed (dropped, replaced, flags changed). */
function accounts(i: Instruction, edit: (list: { address: Address; role: AccountRole; signer?: KeyPairSigner }[]) => void): Instruction {
  const list = [...(i.accounts ?? [])].map((a) => ({ ...a })) as { address: Address; role: AccountRole; signer?: KeyPairSigner }[];
  edit(list);
  return { ...i, accounts: list as Instruction["accounts"] };
}
const truncate = (i: Instruction, n: number) => accounts(i, (l) => l.splice(n));
const replace = (i: Instruction, at: number, address: Address) =>
  accounts(i, (l) => {
    l[at] = {
      address,
      role:
        l[at]!.role === AccountRole.READONLY_SIGNER ? AccountRole.READONLY : l[at]!.role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : l[at]!.role,
    };
  });

/** Stake Deactivate (StakeInstruction tag 5), the staker signing. */
function stakeDeactivate(stake: Address, staker: KeyPairSigner): Instruction {
  return {
    programAddress: STAKE,
    accounts: [
      { address: stake, role: AccountRole.WRITABLE },
      { address: CLOCK, role: AccountRole.READONLY },
      { address: staker.address, role: AccountRole.READONLY_SIGNER, signer: staker },
    ] as Instruction["accounts"],
    data: new Uint8Array(u32(5)),
  };
}

/**
 * A pool and a validator list that are not what they should be: an uninitialized pool account (InvalidState), a list
 * owned by another program, of another account type, or whose type byte does not decode.
 */
async function damagedPoolAndList(d: Diff, payer: KeyPairSigner, p: Pool, name: string, i: Instruction): Promise<void> {
  const blank = await d.allocated(payer, 611n, PROGRAM);
  expect(await d.both(`${name}: uninitialized pool`, payer, [replace(i, 0, blank)])).toBe(custom(E.InvalidState));
  d.patch(p.list, () => {}, { owner: SYSTEM });
  expect(await d.both(`${name}: list not the program's`, payer, [i])).toBe(builtin("IncorrectProgramId"));
  d.patch(p.list, () => {}, { owner: PROGRAM });
  d.patch(p.list, (b) => (b[0] = 1));
  expect(await d.both(`${name}: list of another type`, payer, [i])).toBe(custom(E.InvalidState));
  d.patch(p.list, (b) => (b[0] = 3));
  expect(await d.both(`${name}: list type byte 3`, payer, [i])).toBe(builtin("BorshIoError"));
  d.patch(p.list, (b) => (b[0] = 2));
}

/** Pool tokens worth at least `lamports` (rounded up), at the pool's current rate. */
function tokensFor(d: Diff, p: Pool, lamportsWanted: bigint): bigint {
  const { lamports: total, supply } = d.totals(p);
  return (lamportsWanted * supply + total - 1n) / total;
}

/** Pool tokens that leave at least `wanted` once a withdrawal fee of `numerator / denominator` (rounded up) is taken. */
function tokensPayingFee(wanted: bigint, numerator: bigint, denominator: bigint): bigint {
  let t = (wanted * denominator) / (denominator - numerator) - 2n;
  while (t - (t * numerator + denominator - 1n) / denominator < wanted) t++;
  return t;
}

/** A pool with validators, stake accounts of users and their deposits; the epochs moved on as the tests need. */
class Setting {
  votes: Address[] = [];
  private updates = 0;
  constructor(
    readonly d: Diff,
    readonly payer: KeyPairSigner,
    readonly p: Pool,
  ) {}

  static async create(d: Diff, payer: KeyPairSigner, validators: number, opts: Parameters<Diff["createPool"]>[1] = {}): Promise<Setting> {
    const p = await d.createPool(payer, { reserveLamports: 50n * SOL, maxValidators: validators + 2, ...opts });
    const s = new Setting(d, payer, p);
    for (let i = 0; i < validators; i++) await s.addValidator(`add validator (${opts.label ?? "pool"} ${i})`);
    await s.epoch();
    return s;
  }

  async addValidator(label: string): Promise<Address> {
    const v = await this.d.vote(this.payer);
    this.votes.push(v);
    await this.d.ok(label, this.payer, [ix.addValidator(this.p, this.p.staker, await validatorStake(v, this.p.pool), v)]);
    return v;
  }

  stakeOf(i: number): Promise<Address> {
    return validatorStake(this.votes[i]!, this.p.pool);
  }

  /** Move to the next epoch and update the list and the pool (UpdateValidatorListBalance in chunks of 12). */
  async epoch(): Promise<void> {
    this.d.nextEpoch();
    await this.update();
  }

  async update(): Promise<void> {
    const n = this.updates++;
    const pairs = await updatePairs(this.d, this.p);
    for (let i = 0; i < Math.max(pairs.length, 1); i += 12)
      await this.d.ok(`update list (stake ${n}.${i})`, this.payer, [ix.updateValidatorListBalance(this.p, i, false, pairs.slice(i, i + 12))]);
    await this.d.ok(`update pool (stake ${n})`, this.payer, [ix.updateStakePoolBalance(this.p)]);
  }

  /** A stake account of `owner` with `amount` past its rent, delegated to validator `vote` (an index or a vote account). */
  async userStake(owner: KeyPairSigner, amount: bigint, vote?: number | Address): Promise<Address> {
    return this.d.userStake(this.payer, owner, amount, typeof vote === "number" ? this.votes[vote]! : vote);
  }

  /** The stake account handed to the deposit authority (the pool's PDA unless given), as a depositor does first. */
  async authorize(stake: Address, owner: KeyPairSigner, to: Address = this.p.deposit): Promise<void> {
    await this.d.setup(this.payer, stakeAuthorizeBoth(stake, owner, to));
  }

  /** A pool-token account of `owner` (with the transfer-fee account extension when the mint has the fee). */
  async tokens(owner: Address, transferFee = false): Promise<Address> {
    return this.d.tokenAccount(this.payer, this.p.mint, owner, this.p.tokenProgram, transferFee ? [{ __kind: "TransferFeeAmount", withheldAmount: 0n }] : []);
  }

  deposit(a: { stake: Address; validator: Address; to: Address; referrer?: Address; authority?: Address | KeyPairSigner }, minimum?: bigint): Instruction {
    return ix.depositStake(
      this.p,
      { depositAuthority: a.authority ?? this.p.deposit, stake: a.stake, validatorStake: a.validator, to: a.to, referrer: a.referrer ?? this.p.managerFee },
      minimum,
    );
  }

  /** An uninitialized stake account to split into. */
  splitTarget(): Promise<Address> {
    return this.d.allocated(this.payer, STAKE_ACCOUNT_SIZE, STAKE);
  }

  async withdraw(a: { from: Address; who: KeyPairSigner; tokens: Address; to?: Address; newAuthority?: Address }, poolTokens: bigint, minimum?: bigint) {
    return ix.withdrawStake(
      this.p,
      { split: a.from, receive: a.to ?? (await this.splitTarget()), newAuthority: a.newAuthority ?? a.who.address, transferAuthority: a.who, from: a.tokens },
      poolTokens,
      minimum,
    );
  }
}

describe("stake deposits", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let s: Setting;
  let p: Pool;
  let user: KeyPairSigner;
  let tokens: Address;
  let referrer: Address;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
    s = await Setting.create(d, payer, 4, { depositFee: fee(1n, 100n), referral: 30, label: "deposits" });
    p = s.p;
    // A SOL deposit fee unlike the stake deposit fee, for the deposit's rent reserve.
    await d.ok("set fee: sol deposit (stake deposits)", payer, [ix.setFee(p, p.manager, { kind: "SolDeposit", fee: fee(5n, 100n) })]);
    user = await d.funded(1000n);
    tokens = await s.tokens(user.address);
    referrer = await s.tokens(payer.address);
  });

  it("merges an active stake account into its validator's, minting at the stake and SOL deposit fees", async () => {
    const a = await s.userStake(user, 10n * SOL, 0);
    const b = await s.userStake(user, 5n * SOL, 1);
    const extra = await s.userStake(user, 3n * SOL, 0);
    await s.epoch();
    // Lamports past the delegation (rewards a wallet sent): they go to the reserve, at the SOL deposit fee.
    for (const vm of d.vms) vm.airdrop(extra, lamports(2n * SOL));
    for (const x of [a, b, extra]) await s.authorize(x, user);
    const before = d.totals(p);
    const held = () => [d.tokenBalance(tokens), d.tokenBalance(referrer), d.tokenBalance(p.managerFee)];
    const [userBefore, referrerBefore, managerBefore] = held();
    await d.ok("deposit stake", payer, [s.deposit({ stake: a, validator: await s.stakeOf(0), to: tokens, referrer })], [p.reserve]);
    const [userAfter, referrerAfter, managerAfter] = held();
    expect(d.totals(p).supply - before.supply).toBe(userAfter! - userBefore! + referrerAfter! - referrerBefore! + managerAfter! - managerBefore!);
    expect(referrerAfter! - referrerBefore!).toBeGreaterThan(0n);
    expect(managerAfter! - managerBefore!).toBeGreaterThan(0n);
    expect(d.stake(a)).toBeNull();
    expect(d.validators(p)[0]!.active).toBe(d.lamports(await s.stakeOf(0)));
    await d.ok("deposit stake slippage", payer, [s.deposit({ stake: b, validator: await s.stakeOf(1), to: tokens, referrer }, 1n)], [p.reserve]);
    await d.ok("deposit stake with extra lamports", payer, [s.deposit({ stake: extra, validator: await s.stakeOf(0), to: tokens, referrer })], [p.reserve]);
    // The slippage limit: fewer tokens than asked fail (after the merge, which the failure rolls back).
    const c = await s.userStake(user, 2n * SOL, 2);
    await s.epoch();
    await s.authorize(c, user);
    expect(
      await d.both("deposit stake slippage exceeded", payer, [s.deposit({ stake: c, validator: await s.stakeOf(2), to: tokens, referrer }, 3n * SOL)]),
    ).toBe(custom(E.ExceededSlippage));
    await d.ok("deposit stake slippage met", payer, [s.deposit({ stake: c, validator: await s.stakeOf(2), to: tokens, referrer }, SOL)]);
  });

  it("leaves the stake account's state to the Stake program: inactive, activating, deactivating, another vote", async () => {
    const run = async (label: string, stake: Address, validator: number) =>
      d.both(`deposit stake: ${label}`, payer, [s.deposit({ stake, validator: await s.stakeOf(validator), to: tokens, referrer })]);
    const initialized = await s.userStake(user, 3n * SOL);
    const elsewhere = await s.userStake(user, 3n * SOL, 1);
    const deactivating = await s.userStake(user, 3n * SOL, 0);
    await s.epoch();
    await d.setup(payer, [stakeDeactivate(deactivating, user)]);
    const activating = await s.userStake(user, 3n * SOL, 0);
    for (const x of [initialized, elsewhere, deactivating, activating]) await s.authorize(x, user);
    expect(await run("inactive", initialized, 0)).not.toBe("ok");
    expect(await run("activating", activating, 0)).not.toBe("ok");
    expect(await run("deactivating", deactivating, 0)).not.toBe("ok");
    expect(await run("delegated to another validator", elsewhere, 0)).not.toBe("ok");
    // Once active, the activating one is taken.
    await s.epoch();
    expect(await run("activated", activating, 0)).toBe("ok");
    // Not handed to the deposit authority: the Stake program refuses the authorize.
    const own = await s.userStake(user, 3n * SOL, 0);
    await s.epoch();
    expect(await run("authorities not handed over", own, 0)).not.toBe("ok");
  });

  it("refuses validator stake accounts the pool does not take", async () => {
    const stake = await s.userStake(user, 3n * SOL, 0);
    const outsider = await d.vote(payer);
    const foreign = await s.userStake(user, 3n * SOL, outsider);
    const lookalike = await s.userStake(user, 3n * SOL, 0);
    await s.epoch();
    await s.authorize(stake, user);
    const run = (label: string, validator: Address) => d.both(`deposit stake: ${label}`, payer, [s.deposit({ stake, validator, to: tokens, referrer })]);
    expect(await run("validator not in the pool", foreign)).toBe(custom(E.ValidatorNotFound));
    expect(await run("not the validator's stake account", lookalike)).toBe(custom(E.InvalidStakeAccountAddress));
    expect(await run("an initialized stake account", p.reserve)).toBe(custom(E.WrongStakeStake));
    expect(await run("not a stake account", p.mint)).toBe(builtin("BorshIoError"));
    expect(await run("an empty account", (await generateKeyPairSigner()).address)).toBe(builtin("BorshIoError"));
    // A preferred deposit validator takes every deposit.
    await d.ok("set preferred deposit (stake deposits)", payer, [ix.setPreferredValidator(p, p.staker, "Deposit", s.votes[1]!)]);
    expect(await run("not the preferred validator", await s.stakeOf(0))).toBe(custom(E.IncorrectDepositVoteAddress));
    await d.ok("set preferred deposit to the stake's (stake deposits)", payer, [ix.setPreferredValidator(p, p.staker, "Deposit", s.votes[0]!)]);
    await d.ok("deposit stake: preferred validator", payer, [s.deposit({ stake, validator: await s.stakeOf(0), to: tokens, referrer })]);
    await d.ok("clear preferred deposit (stake deposits)", payer, [ix.setPreferredValidator(p, p.staker, "Deposit", null)]);
    // A validator on its way out takes no deposits.
    const late = await s.userStake(user, 3n * SOL, 3);
    await s.epoch();
    await s.authorize(late, user);
    await d.ok("remove validator (stake deposits)", payer, [
      ix.removeValidator(p, p.staker, await s.stakeOf(3), await transientStake(s.votes[3]!, p.pool, 0n)),
    ]);
    expect(
      await d.both("deposit stake: validator being removed", payer, [s.deposit({ stake: late, validator: await s.stakeOf(3), to: tokens, referrer })]),
    ).toBe(custom(E.ValidatorNotFound));
  });

  it("refuses wrong accounts, in the original's order", async () => {
    const stake = await s.userStake(user, 3n * SOL, 0);
    await s.epoch();
    await s.authorize(stake, user);
    const other = await d.createPool(payer, { reserveLamports: SOL, label: "initialize (other pool, stake deposits)" });
    const dep = s.deposit({ stake, validator: await s.stakeOf(0), to: tokens, referrer });
    const foreign = await d.allocated(payer, 611n, SYSTEM);
    const cases: [string, Instruction, string][] = [
      ["11 accounts", truncate(dep, 11), builtin("NotEnoughAccountKeys")],
      ["12 accounts", truncate(dep, 12), builtin("NotEnoughAccountKeys")],
      ["14 accounts", truncate(dep, 14), builtin("NotEnoughAccountKeys")],
      ["clock not the Clock", replace(dep, 11, STAKE_HISTORY), builtin("InvalidArgument")],
      ["wrong stake program", replace(dep, 14, SYSTEM), builtin("IncorrectProgramId")],
      ["pool not the program's", replace(dep, 0, foreign), builtin("IncorrectProgramId")],
      ["a list as the pool", replace(dep, 0, p.list), "x"],
      ["wrong withdraw authority", replace(dep, 3, other.withdraw), custom(E.InvalidProgramAddress)],
      ["wrong deposit authority", replace(dep, 2, other.deposit), custom(E.InvalidStakeDepositAuthority)],
      ["wrong mint", replace(dep, 10, other.mint), custom(E.WrongPoolMint)],
      ["wrong list", replace(dep, 1, other.list), custom(E.InvalidValidatorStakeList)],
      ["wrong reserve", replace(dep, 6, other.reserve), custom(E.InvalidProgramAddress)],
      ["wrong token program", replace(dep, 13, TOKEN_2022), builtin("IncorrectProgramId")],
      ["wrong fee account", replace(dep, 8, referrer), custom(E.InvalidFeeAccount)],
      ["tokens to another mint's account", replace(dep, 7, other.managerFee), "x"],
    ];
    for (const [label, i, want] of cases) {
      const got = await d.both(`deposit stake: ${label}`, payer, [i]);
      if (want !== "x") expect(got, label).toBe(want);
      else expect(got, label).not.toBe("ok");
    }
    await damagedPoolAndList(d, payer, p, "deposit stake", dep);
    // Another account where the StakeHistory sysvar goes: the original's merge names the sysvar itself, which the
    // transaction does not hold (the runtime's MissingAccount); the port refuses it at the same point (InvalidArgument).
    const wrongHistory = replace(dep, 12, CLOCK);
    for (const [vm, want] of [
      [d.original, builtin("MissingAccount")],
      [d.port, builtin("InvalidArgument")],
    ] as const) {
      const before = [stake, p.pool, p.list].map((a) => d.bytes(vm, a));
      expect(outcome(await send(vm, payer, [wrongHistory]))).toBe(want);
      expect([stake, p.pool, p.list].map((a) => d.bytes(vm, a))).toEqual(before);
    }
    // A stale pool takes no deposits until it is updated.
    d.nextEpoch();
    expect(await d.both("deposit stake: stale pool", payer, [dep])).toBe(custom(E.StakeListAndPoolOutOfDate));
    await s.update();
    // Fees of 100%: nothing left for the user.
    await d.ok("set fee: stake deposit 100%", payer, [ix.setFee(p, p.manager, { kind: "StakeDeposit", fee: fee(1n, 1n) })]);
    await d.ok("set fee: sol deposit 100%", payer, [ix.setFee(p, p.manager, { kind: "SolDeposit", fee: fee(1n, 1n) })]);
    expect(await d.both("deposit stake: all fees", payer, [dep])).toBe(custom(E.DepositTooSmall));
    // No fees and no referral share: only the user's tokens are minted.
    await d.ok("set fee: stake deposit 0", payer, [ix.setFee(p, p.manager, { kind: "StakeDeposit", fee: fee(0n, 0n) })]);
    await d.ok("set fee: sol deposit 0", payer, [ix.setFee(p, p.manager, { kind: "SolDeposit", fee: fee(0n, 0n) })]);
    await d.ok("deposit stake: no fees", payer, [dep]);
  });

  it("deposits through a stake deposit authority of the manager's choosing, which signs", async () => {
    const depositor = await d.funded(1n);
    const q = await Setting.create(d, payer, 2, { depositAuthority: depositor, depositFee: fee(1n, 100n), label: "custom deposit authority" });
    const to = await q.tokens(user.address);
    const [x, y] = [await q.userStake(user, 4n * SOL, 0), await q.userStake(user, 4n * SOL, 0)];
    await q.epoch();
    for (const z of [x, y]) await q.authorize(z, user, depositor.address);
    const dep = async (authority: Address | KeyPairSigner, stake = x) =>
      q.deposit({ stake, validator: await q.stakeOf(0), to, referrer: q.p.managerFee, authority }, undefined);
    expect(await d.both("deposit stake: custom authority not signing", payer, [await dep(depositor.address)])).not.toBe("ok");
    expect(await d.both("deposit stake: the PDA instead of the custom authority", payer, [await dep(await depositAuthority(q.p.pool))])).toBe(
      custom(E.InvalidStakeDepositAuthority),
    );
    await d.ok("deposit stake (custom authority)", payer, [await dep(depositor)]);
    await d.ok("deposit stake slippage (custom authority)", payer, [
      q.deposit({ stake: y, validator: await q.stakeOf(0), to, referrer: q.p.managerFee, authority: depositor }, 1n),
    ]);
  });
});

describe("stake withdrawals", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let s: Setting;
  let p: Pool;
  let user: KeyPairSigner;
  let tokens: Address;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
    s = await Setting.create(d, payer, 4, { withdrawalFee: fee(3n, 1000n), label: "withdrawals" });
    p = s.p;
    user = await d.funded(1000n);
    tokens = await s.tokens(user.address);
    const a = await s.userStake(user, 20n * SOL, 0);
    const b = await s.userStake(user, 5n * SOL, 1);
    await s.epoch();
    for (const x of [a, b]) await s.authorize(x, user);
    await d.ok("deposit stake (withdrawals 0)", payer, [s.deposit({ stake: a, validator: await s.stakeOf(0), to: tokens })]);
    await d.ok("deposit stake (withdrawals 1)", payer, [s.deposit({ stake: b, validator: await s.stakeOf(1), to: tokens })]);
  });

  it("splits from validator stake accounts that have stake to give, handing the new account to the user", async () => {
    const wd = async (label: string, from: Address, poolTokens: bigint, minimum?: bigint) =>
      d.both(`withdraw stake: ${label}`, payer, [await s.withdraw({ from, who: user, tokens }, poolTokens, minimum)]);
    const target = await s.splitTarget();
    const owner = (await generateKeyPairSigner()).address;
    const before = d.validators(p)[0]!.active;
    await d.ok(
      "withdraw stake",
      payer,
      [await s.withdraw({ from: await s.stakeOf(0), who: user, tokens, to: target, newAuthority: owner }, 2n * SOL)],
      [p.managerFee],
    );
    const got = d.stake(target);
    expect(got?.kind).toBe("Stake");
    if (got?.kind === "Stake") {
      expect(got.meta.authorized.staker).toBe(owner);
      expect(got.meta.authorized.withdrawer).toBe(owner);
    }
    expect(d.validators(p)[0]!.active).toBe(before - (d.lamports(target) - d.original.minimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE)));
    await d.ok("withdraw stake slippage", payer, [await s.withdraw({ from: await s.stakeOf(0), who: user, tokens }, 2n * SOL, SOL)], [p.managerFee]);
    expect(await wd("slippage exceeded", await s.stakeOf(0), 2n * SOL, 3n * SOL)).toBe(custom(E.ExceededSlippage));
    expect(await wd("no tokens", await s.stakeOf(0), 0n)).toBe(custom(E.WithdrawalTooSmall));
    expect(await wd("1 pool token", await s.stakeOf(0), 1n)).toBe(custom(E.WithdrawalTooSmall));
    // The reserve, and validators at the minimum, wait while some validator has stake to give.
    expect(await wd("from the reserve", p.reserve, 2n * SOL)).toBe(custom(E.StakeLamportsNotEqualToMinimum));
    expect(await wd("from a validator at the minimum", await s.stakeOf(2), 2n * SOL)).toBe(custom(E.StakeLamportsNotEqualToMinimum));
    // Not below the minimum a validator stake account keeps.
    expect(await wd("leaving less than the minimum", await s.stakeOf(1), 5n * SOL + SOL / 2n)).toBe(custom(E.StakeLamportsNotEqualToMinimum));
    expect(await wd("more than the account holds", await s.stakeOf(1), 50n * SOL)).toBe(custom(E.StakeLamportsNotEqualToMinimum));
    // Accounts that are not the validator's stake account.
    const outsider = await d.vote(payer);
    const initialized = await s.userStake(user, SOL);
    const foreign = await s.userStake(user, 2n * SOL, outsider);
    const lookalike = await s.userStake(user, 2n * SOL, 0);
    expect(await wd("not a stake account", p.mint, 2n * SOL)).toBe(builtin("BorshIoError"));
    expect(await wd("an empty account", await transientStake(s.votes[0]!, p.pool, 0n), 2n * SOL)).toBe(builtin("BorshIoError"));
    expect(await wd("an initialized stake account", initialized, 2n * SOL)).toBe(custom(E.WrongStakeStake));
    expect(await wd("validator not in the pool", foreign, 2n * SOL)).toBe(custom(E.ValidatorNotFound));
    expect(await wd("not the validator's stake account", lookalike, 2n * SOL)).toBe(custom(E.InvalidStakeAccountAddress));
  });

  it("takes from the preferred withdraw validator first", async () => {
    const wd = async (label: string, from: number) =>
      d.both(`withdraw stake: ${label}`, payer, [await s.withdraw({ from: await s.stakeOf(from), who: user, tokens }, 2n * SOL)]);
    await d.ok("set preferred withdraw (withdrawals)", payer, [ix.setPreferredValidator(p, p.staker, "Withdraw", s.votes[1]!)]);
    expect(await wd("not the preferred validator", 0)).toBe(custom(E.IncorrectWithdrawVoteAddress));
    expect(await wd("the preferred validator", 1)).toBe("ok");
    // A preferred validator with nothing to give leaves the others free.
    await d.ok("set preferred withdraw at the minimum (withdrawals)", payer, [ix.setPreferredValidator(p, p.staker, "Withdraw", s.votes[2]!)]);
    expect(await wd("preferred validator at the minimum", 0)).toBe("ok");
    // A preferred validator that is not in the list (only a damaged pool has one): logged, any validator goes.
    const at = d.data(p.pool).indexOf(key(s.votes[2]!));
    expect(at).toBeGreaterThan(0);
    d.patch(p.pool, (b) => key(payer.address).copy(b, at));
    expect(await wd("preferred validator not found", 0)).toBe("ok");
    await d.ok("clear preferred withdraw (withdrawals)", payer, [ix.setPreferredValidator(p, p.staker, "Withdraw", null)]);
  });

  it("takes the fee for the manager, but not from the manager's own account or into an unusable one", async () => {
    // Tokens for the manager: a SOL deposit into the fee account.
    await d.ok("deposit sol to the fee account (withdrawals)", payer, [ix.depositSol(p, { from: user, to: p.managerFee, referrer: p.managerFee }, 10n * SOL)]);
    const fees = d.tokenBalance(p.managerFee);
    await d.ok("withdraw stake from the fee account", payer, [await s.withdraw({ from: await s.stakeOf(0), who: p.manager, tokens: p.managerFee }, 2n * SOL)]);
    expect(d.tokenBalance(p.managerFee)).toBe(fees - 2n * SOL);
    d.patch(p.managerFee, (b) => (b[108] = 2));
    await d.ok("withdraw stake: frozen fee account", payer, [await s.withdraw({ from: await s.stakeOf(0), who: user, tokens }, 2n * SOL)]);
    d.patch(p.managerFee, (b) => (b[108] = 1));
  });

  it("refuses wrong accounts, in the original's order", async () => {
    const other = await d.createPool(payer, { reserveLamports: SOL, label: "initialize (other pool, stake withdrawals)" });
    const otherTokens = await d.tokenAccount(payer, other.mint, user.address);
    const wd = await s.withdraw({ from: await s.stakeOf(0), who: user, tokens }, 2n * SOL);
    const foreign = await d.allocated(payer, 611n, SYSTEM);
    const stranger = await d.funded(1n);
    const cases: [string, Instruction, string][] = [
      ["10 accounts", truncate(wd, 10), builtin("NotEnoughAccountKeys")],
      ["11 accounts", truncate(wd, 11), builtin("NotEnoughAccountKeys")],
      ["12 accounts", truncate(wd, 12), builtin("NotEnoughAccountKeys")],
      ["clock not the Clock", replace(wd, 10, STAKE_HISTORY), builtin("InvalidArgument")],
      ["wrong stake program", replace(wd, 12, SYSTEM), builtin("IncorrectProgramId")],
      ["pool not the program's", replace(wd, 0, foreign), builtin("IncorrectProgramId")],
      ["a list as the pool", replace(wd, 0, p.list), "x"],
      ["wrong mint", replace(wd, 9, other.mint), custom(E.WrongPoolMint)],
      ["wrong list", replace(wd, 1, other.list), custom(E.InvalidValidatorStakeList)],
      ["wrong withdraw authority", replace(wd, 2, other.withdraw), custom(E.InvalidProgramAddress)],
      ["wrong fee account", replace(wd, 8, tokens), custom(E.InvalidFeeAccount)],
      ["wrong token program", replace(wd, 11, TOKEN_2022), builtin("IncorrectProgramId")],
      ["tokens of another mint", replace(wd, 7, otherTokens), "x"],
      ["split into an existing stake account", replace(wd, 4, await s.stakeOf(1)), "x"],
      ["another user's tokens", await s.withdraw({ from: await s.stakeOf(0), who: stranger, tokens }, 2n * SOL), "x"],
    ];
    for (const [label, i, want] of cases) {
      const got = await d.both(`withdraw stake: ${label}`, payer, [i]);
      if (want !== "x") expect(got, label).toBe(want);
      else expect(got, label).not.toBe("ok");
    }
    await damagedPoolAndList(d, payer, p, "withdraw stake", wd);
    d.nextEpoch();
    expect(await d.both("withdraw stake: stale pool", payer, [wd])).toBe(custom(E.StakeListAndPoolOutOfDate));
    await s.update();
    // A validator on its way out allows no withdrawals.
    await d.ok("remove validator (withdrawals)", payer, [ix.removeValidator(p, p.staker, await s.stakeOf(3), await transientStake(s.votes[3]!, p.pool, 0n))]);
    expect(await d.both("withdraw stake: validator being removed", payer, [await s.withdraw({ from: await s.stakeOf(3), who: user, tokens }, 2n * SOL)])).toBe(
      custom(E.ValidatorNotFound),
    );
  });
});

describe("withdrawals from transient stake, whole validators and the reserve", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let s: Setting;
  let p: Pool;
  let user: KeyPairSigner;
  let tokens: Address;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
    s = await Setting.create(d, payer, 4, { withdrawalFee: fee(3n, 1000n), label: "removals" });
    p = s.p;
    user = await d.funded(1000n);
    tokens = await s.tokens(user.address);
    // Tokens for the user and for the manager (whose withdrawals pay no fee), all their lamports in the reserve.
    await d.ok("deposit sol (removals)", payer, [ix.depositSol(p, { from: user, to: tokens, referrer: tokens }, 40n * SOL)]);
    await d.ok("deposit sol to the fee account (removals)", payer, [ix.depositSol(p, { from: user, to: p.managerFee, referrer: p.managerFee }, 40n * SOL)]);
  });

  it("takes from transient stake while there is some", async () => {
    // A transient stake account the pool would have made (IncreaseValidatorStake is a later part): a stake account of
    // the withdraw authority, active, at the transient address of validator 0 (seed 7), and the entry's transient
    // lamports set.
    const authority = await withdrawAuthority(p.pool);
    const rent = d.original.minimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE);
    const at = await d.stakeAccount(payer, { staker: user.address, withdrawer: user.address, lamports: rent + 3n * SOL });
    const transient = await transientStake(s.votes[0]!, p.pool, 7n);
    d.patch(at, (b) => {
      b.writeUInt32LE(2, 0);
      key(s.votes[0]!).copy(b, STAKE_OFFSETS.voter);
      b.writeBigUInt64LE(3n * SOL, STAKE_OFFSETS.stake);
      b.writeBigUInt64LE(d.cluster.epoch - 1n, STAKE_OFFSETS.activation);
      b.writeBigUInt64LE(2n ** 64n - 1n, STAKE_OFFSETS.deactivation);
      b.writeDoubleLE(0.25, 180);
      key(authority).copy(b, STAKE_OFFSETS.staker);
      key(authority).copy(b, STAKE_OFFSETS.withdrawer);
    });
    d.move(at, transient);
    d.patch(p.list, (b) => {
      b.writeBigUInt64LE(rent + 3n * SOL, 9 + 8);
      b.writeBigUInt64LE(7n, 9 + 24);
    });
    const wd = async (label: string, from: Address, poolTokens: bigint) =>
      d.both(`withdraw stake: ${label}`, payer, [await s.withdraw({ from, who: user, tokens }, poolTokens)]);
    expect(await wd("validator stake while transient stake is left", await s.stakeOf(0), SOL)).toBe(custom(E.InvalidStakeAccountAddress));
    expect(await wd("another validator while transient stake is left", await s.stakeOf(1), SOL)).toBe(custom(E.InvalidStakeAccountAddress));
    expect(await wd("reserve while transient stake is left", p.reserve, SOL)).toBe(custom(E.StakeLamportsNotEqualToMinimum));
    expect(await wd("transient stake past the minimum", transient, 3n * SOL)).toBe(custom(E.StakeLamportsNotEqualToMinimum));
    await d.ok("withdraw stake (transient)", payer, [await s.withdraw({ from: transient, who: user, tokens }, tokensFor(d, p, 3n * SOL) / 2n)]);
    expect(d.validators(p)[0]!.transient).toBe(d.lamports(transient));
  });

  it("takes a validator stake account at the minimum whole, removing the validator", async () => {
    const whole = async (i: number) => d.lamports(await s.stakeOf(i));
    const fromFees = async (label: string, i: number, poolTokens: bigint) =>
      d.both(`withdraw stake: ${label}`, payer, [await s.withdraw({ from: await s.stakeOf(i), who: p.manager, tokens: p.managerFee }, poolTokens)]);
    // Transient lamports under the tolerance still tie validator 0 to its transient stake account.
    d.patch(p.list, (b) => b.writeBigUInt64LE(1000n, 9 + 8));
    expect(await fromFees("validator with a little transient stake", 0, tokensFor(d, p, await whole(0)))).toBe(custom(E.InvalidStakeAccountAddress));
    const all = await whole(1);
    expect(await fromFees("less than a whole account", 1, tokensFor(d, p, all - SOL / 2n))).toBe(custom(E.StakeLamportsNotEqualToMinimum));
    expect(await fromFees("more than a whole account", 1, tokensFor(d, p, all + SOL))).toBe(custom(E.StakeLamportsNotEqualToMinimum));
    // Preferred validators that leave stop being preferred.
    await d.ok("set preferred deposit (removals)", payer, [ix.setPreferredValidator(p, p.staker, "Deposit", s.votes[1]!)]);
    await d.ok("set preferred withdraw (removals)", payer, [ix.setPreferredValidator(p, p.staker, "Withdraw", s.votes[1]!)]);
    await d.ok("withdraw stake (whole validator)", payer, [
      await s.withdraw({ from: await s.stakeOf(1), who: p.manager, tokens: p.managerFee }, tokensFor(d, p, all)),
    ]);
    expect(d.validators(p)[1]!).toMatchObject({ status: 2, active: 0n });
    // A list entry that counts more than the account holds: the withdrawal would leave lamports behind.
    const two = await whole(2);
    d.patch(p.list, (b) => b.writeBigUInt64LE(two + 1n, 9 + 73 * 2));
    expect(await fromFees("leaving lamports in the entry", 2, tokensFor(d, p, two))).toBe(custom(E.StakeListAndPoolOutOfDate));
    d.patch(p.list, (b) => b.writeBigUInt64LE(two, 9 + 73 * 2));
    // By a user, who pays the withdrawal fee.
    const userWhole = await s.withdraw({ from: await s.stakeOf(2), who: user, tokens }, tokensPayingFee(tokensFor(d, p, two), 3n, 1000n));
    expect(await d.both("withdraw stake (whole validator, user)", payer, [userWhole], [p.managerFee])).toBe("ok");
    await d.ok("cleanup (removals)", payer, [ix.cleanupRemovedValidatorEntries(p)]);
    expect(d.validators(p).map((v) => v.vote)).toEqual([s.votes[0], s.votes[3]]);
  });

  it("takes from the reserve once no validator has anything to give", async () => {
    // Validator 0's transient lamports are gone from its entry (as if merged), validator 3 at the minimum.
    d.patch(p.list, (b) => b.writeBigUInt64LE(0n, 9 + 8));
    const wd = async (label: string, poolTokens: bigint) =>
      d.both(`withdraw stake: ${label}`, payer, [await s.withdraw({ from: p.reserve, who: user, tokens }, poolTokens)]);
    await d.ok("withdraw stake (reserve)", payer, [await s.withdraw({ from: p.reserve, who: user, tokens }, 2n * SOL)]);
    expect(await wd("more than the reserve holds", tokensPayingFee(tokensFor(d, p, d.lamports(p.reserve)), 3n, 1000n))).toBe(custom(E.SolWithdrawalTooLarge));
    await d.ok("withdraw stake slippage (reserve)", payer, [await s.withdraw({ from: p.reserve, who: user, tokens }, 2n * SOL, SOL)]);
    // The last validators go whole too.
    const last = d.lamports(await s.stakeOf(3));
    await d.ok("withdraw stake (whole validator 3)", payer, [
      await s.withdraw({ from: await s.stakeOf(3), who: p.manager, tokens: p.managerFee }, tokensFor(d, p, last)),
    ]);
  });
});

describe("Token-2022 pools", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });

  it("deposits and withdraws stake, the mint charging a transfer fee on the withdrawal fee", async () => {
    const s = await Setting.create(d, payer, 2, {
      tokenProgram: TOKEN_2022,
      withdrawalFee: fee(3n, 1000n),
      mintExtensions: [
        {
          __kind: "TransferFeeConfig",
          transferFeeConfigAuthority: payer.address,
          withdrawWithheldAuthority: payer.address,
          withheldAmount: 0n,
          olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
          newerTransferFee: { epoch: 0n, maximumFee: 10n ** 9n, transferFeeBasisPoints: 100 },
        },
      ],
      mintInit: (m) => [
        t22.getInitializeTransferFeeConfigInstruction({
          mint: m,
          transferFeeConfigAuthority: payer.address,
          withdrawWithheldAuthority: payer.address,
          transferFeeBasisPoints: 100,
          maximumFee: 10n ** 9n,
        }) as Instruction,
      ],
      label: "token-2022",
    });
    const user = await d.funded(1000n);
    const tokens = await s.tokens(user.address, true);
    const stake = await s.userStake(user, 10n * SOL, 0);
    await s.epoch();
    await s.authorize(stake, user);
    await d.ok("deposit stake (Token-2022)", payer, [s.deposit({ stake, validator: await s.stakeOf(0), to: tokens })]);
    await d.ok("withdraw stake (Token-2022)", payer, [await s.withdraw({ from: await s.stakeOf(0), who: user, tokens }, 3n * SOL)], [s.p.managerFee]);
    await d.ok("withdraw stake slippage (Token-2022)", payer, [await s.withdraw({ from: await s.stakeOf(0), who: user, tokens }, 2n * SOL, SOL)]);
  });
});

describe("a pool of 52 validators", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let s: Setting;
  const N = 52;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
    s = await Setting.create(d, payer, N, { reserveLamports: 200n * SOL, label: "52" });
  });

  it("withdraws whole validators and from the reserve, deposits into and withdraws from the last validator", async () => {
    const p = s.p;
    const user = await d.funded(1000n);
    const tokens = await s.tokens(user.address);
    await d.ok("deposit sol to the fee account (52)", payer, [ix.depositSol(p, { from: user, to: p.managerFee, referrer: p.managerFee }, 20n * SOL)]);
    // Every validator at the minimum: a whole one may go, after a scan of the list that finds nothing to give.
    const first = d.lamports(await s.stakeOf(0));
    await d.ok("withdraw stake (whole validator, 52)", payer, [
      await s.withdraw({ from: await s.stakeOf(0), who: p.manager, tokens: p.managerFee }, tokensFor(d, p, first)),
    ]);
    await d.ok("withdraw stake (reserve, 52)", payer, [await s.withdraw({ from: p.reserve, who: p.manager, tokens: p.managerFee }, 2n * SOL)]);
    const stake = await s.userStake(user, 10n * SOL, N - 1);
    await s.epoch();
    await s.authorize(stake, user);
    await d.ok("deposit stake (52)", payer, [s.deposit({ stake, validator: await s.stakeOf(N - 1), to: tokens })]);
    // Only the last validator has stake to give: the reserve and the others wait.
    expect(await d.both("withdraw stake: reserve (52)", payer, [await s.withdraw({ from: p.reserve, who: user, tokens }, 2n * SOL)])).toBe(
      custom(E.StakeLamportsNotEqualToMinimum),
    );
    expect(await d.both("withdraw stake: at the minimum (52)", payer, [await s.withdraw({ from: await s.stakeOf(1), who: user, tokens }, 2n * SOL)])).toBe(
      custom(E.StakeLamportsNotEqualToMinimum),
    );
    await d.ok("withdraw stake (52)", payer, [await s.withdraw({ from: await s.stakeOf(N - 1), who: user, tokens }, 2n * SOL)]);
    await d.ok("set preferred withdraw (52)", payer, [ix.setPreferredValidator(p, p.staker, "Withdraw", s.votes[N - 1]!)]);
    await d.ok("withdraw stake preferred (52)", payer, [await s.withdraw({ from: await s.stakeOf(N - 1), who: user, tokens }, 2n * SOL)]);
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
      ["deposit stake", "deposit stake"],
      ["deposit stake (slippage)", "deposit stake slippage"],
      ["deposit stake (extra lamports)", "deposit stake with extra lamports"],
      ["deposit stake (custom auth)", "deposit stake (custom authority)"],
      ["deposit stake (Token-2022)", "deposit stake (Token-2022)"],
      ["deposit stake (52)", "deposit stake (52)"],
      ["withdraw stake", "withdraw stake"],
      ["withdraw stake (slippage)", "withdraw stake slippage"],
      ["withdraw stake (fee account)", "withdraw stake from the fee account"],
      ["withdraw stake (transient)", "withdraw stake (transient)"],
      ["withdraw stake (whole)", "withdraw stake (whole validator)"],
      ["withdraw stake (reserve)", "withdraw stake (reserve)"],
      ["withdraw stake (Token-2022)", "withdraw stake (Token-2022)"],
      ["withdraw stake (52)", "withdraw stake (52)"],
      ["withdraw stake (52, whole)", "withdraw stake (whole validator, 52)"],
      ["withdraw stake (52, reserve)", "withdraw stake (reserve, 52)"],
      ["withdraw stake (52, preferred)", "withdraw stake preferred (52)"],
      ["withdraw: reserve refused (52)", "withdraw stake: reserve (52)"],
    ];
    for (const [name, label] of rows) {
      const got = all[label];
      expect(got, label).toBeDefined();
      const [a, b] = got!;
      console.log(`${name.padEnd(32)} original ${String(a).padStart(7)}  TypeSOL ${String(b).padStart(7)}  ${((Number(b) / Number(a)) * 100).toFixed(0)}%`);
      expect(b, `${name}: TypeSOL ${b} vs original ${a}`).toBeLessThan(a);
    }
    console.log(`${compared} transactions compared`);
    expect(compared).toBeGreaterThan(150);
  });
});
