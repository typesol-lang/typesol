// showcase/mainnet/spl-stake-pool against SPL Stake Pool as deployed on mainnet (test/programs/spl_stake_pool.so): the
// scenarios of the original's own integration tests (solana-program/stake-pool program@v2.1.0, program/tests/*.rs)
// that the other files do not already run, each adapted to LiteSVM and sent to both programs through `both()` (the
// same outcome, logs and bytes in every account named), with the outcome the original's test expects. The mapping of
// every upstream test to a case here or elsewhere is in spl-stake-pool-upstream.md, next to this file.
//
// Adaptations, where program-test does what LiteSVM does not:
// - Epochs: `warp_to_slot` becomes `d.nextEpoch()` (a StakeCluster, so warmup and cooldown are a cluster's).
// - Validator rewards (`increment_vote_account_credits` and a warp): the active stake accounts' delegations grow with
//   their lamports, as the Stake program's reward payout grows them; extra lamports are sent as upstream sends them.
// - `program_test.add_account` / `context.set_account`: the same bytes written into both VMs (`d.write` / `d.patch`).
// - The minimum delegation: LiteSVM's Stake program takes 1 SOL (upstream deactivates that feature: 1,000,000
//   lamports); amounts upstream gives as multiples of it are multiples of LiteSVM's here.
import { getTransferSolInstruction } from "@solana-program/system";
import * as token from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner, getAddressDecoder, lamports } from "@solana/kit";
import { EpochRewards, LiteSVM } from "litesvm";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Diff,
  type Fee,
  type Pool,
  RENT,
  SOL,
  STAKE,
  STAKE_ACCOUNT_SIZE,
  STAKE_OFFSETS,
  TOKEN,
  TOKEN_2022,
  builtin,
  custom,
  ephemeralStake,
  fee,
  ix,
  key,
  mintBytes,
  stakeAuthorizeBoth,
  tlv,
  tokenAccountBytes,
  transientStake,
  u8,
  u32,
  updatePairs,
  validatorStake,
} from "./spl-stake-pool-helpers.js";

/** StakePoolError codes. */
const E = {
  AlreadyInUse: 0,
  InvalidProgramAddress: 1,
  InvalidState: 2,
  WrongManager: 6,
  SignatureMissing: 7,
  InvalidValidatorStakeList: 8,
  WrongStakeStake: 11,
  /** Also StakeError::InsufficientDelegation (12). */
  UserStakeNotActive: 12,
  ValidatorNotFound: 14,
  InvalidStakeAccountAddress: 15,
  StakeListAndPoolOutOfDate: 17,
  StakeLamportsNotEqualToMinimum: 23,
  IncorrectWithdrawVoteAddress: 25,
  FeeIncreaseTooHigh: 27,
  InvalidStakeDepositAuthority: 30,
  TransientAccountInUse: 33,
  UnsupportedMintExtension: 37,
  UnsupportedFeeAccountExtension: 38,
  ExceededSlippage: 39,
  EpochRewardDistributionInProgress: 43,
} as const;
/** spl-token's errors (TokenError): InsufficientFunds, MintMismatch, OwnerMismatch. */
const TokenError = { InsufficientFunds: 1, MintMismatch: 3, OwnerMismatch: 4 } as const;
const STATUS = { Active: 0, DeactivatingTransient: 1, ReadyForRemoval: 2, DeactivatingValidator: 3, DeactivatingAll: 4 } as const;

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
const replace = (i: Instruction, at: number, to: Address) =>
  accounts(i, (l) => {
    const role = l[at]!.role;
    l[at] = {
      address: to,
      role: role === AccountRole.READONLY_SIGNER ? AccountRole.READONLY : role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : role,
    };
  });
/** Account `at` passed without its signature. */
const unsigned = (i: Instruction, at: number) =>
  accounts(i, (l) => (l[at] = { address: l[at]!.address, role: l[at]!.role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : AccountRole.READONLY }));
/** An address nothing lives at (upstream's `Pubkey::new_unique()` / `Keypair::new().pubkey()`). */
const nowhere = () => getAddressDecoder().decode(randomBytes(32));
/** The outcome of a built-in error of instruction `index`. */
const builtinAt = (index: number, name: string) => `error: TransactionErrorInstructionError { index: ${index}, error: ${name} }`;

/** The rent of a stake account, and the pool's minimum delegation: LiteSVM's Stake program's 1 SOL (checked as validators are added). */
const RENT_200 = new LiteSVM().minimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE);
const MIN = SOL;
/** TEST_STAKE_AMOUNT of the upstream tests. */
const TEST_STAKE = 1_500_000_000n;
const U64_MAX = 2n ** 64n - 1n;

/** The upstream default pool (StakePoolAccounts::default): its fees, the SOL deposit fee and referral set after. */
async function upstreamPool(
  d: Diff,
  payer: KeyPairSigner,
  label: string,
  opts: Parameters<Diff["createPool"]>[1] & { solDepositFee?: Fee; solReferral?: number } = {},
): Promise<Pool> {
  const p = await d.createPool(payer, {
    epochFee: fee(1n, 100n),
    withdrawalFee: fee(3n, 1000n),
    depositFee: fee(1n, 1000n),
    referral: 25,
    maxValidators: 10,
    reserveLamports: 0n,
    ...opts,
    label: `initialize (${label})`,
  });
  await d.ok(`set fee: sol deposit (${label})`, payer, [ix.setFee(p, p.manager, { kind: "SolDeposit", fee: opts.solDepositFee ?? fee(3n, 100n) })]);
  await d.ok(`set fee: sol referral (${label})`, payer, [ix.setFee(p, p.manager, { kind: "SolReferral", percent: opts.solReferral ?? 50 })]);
  return p;
}

/** A pool's validators: vote accounts and their validator stake accounts. */
interface V {
  p: Pool;
  votes: Address[];
  stakes: Address[];
}
/** Add `n` validators, each as upstream's simple_add_validator_to_pool: a SOL deposit of what it takes, then the add. */
async function addValidators(
  d: Diff,
  payer: KeyPairSigner,
  p: Pool,
  n: number,
  label: string,
  o: { seed?: number; authority?: KeyPairSigner } = {},
): Promise<V> {
  const v: V = { p, votes: [], stakes: [] };
  for (let i = 0; i < n; i++) await addValidator(d, payer, v, `${label} ${i}`, o);
  return v;
}
/** The payer's pool-token account of each pool (for the SOL deposits that fund new validators). */
const payerTokens = new Map<Address, Address>();
async function addValidator(d: Diff, payer: KeyPairSigner, v: V, label: string, o: { seed?: number; authority?: KeyPairSigner } = {}): Promise<number> {
  const vote = await d.vote(payer);
  const seed = o.seed ?? 0;
  const stake = await validatorStake(vote, v.p.pool, seed);
  let tokens = payerTokens.get(v.p.pool);
  if (!tokens) payerTokens.set(v.p.pool, (tokens = await d.tokenAccount(payer, v.p.mint, payer.address, v.p.tokenProgram)));
  // LiteSVM's Stake program takes a minimum delegation of 1 SOL (checked below).
  await d.ok(`deposit sol for a validator (${label})`, payer, [
    ix.depositSol(v.p, { from: payer, to: tokens, referrer: tokens, authority: o.authority }, RENT_200 + SOL),
  ]);
  await d.ok(`add validator (${label})`, payer, [ix.addValidator(v.p, v.p.staker, stake, vote, seed)]);
  expect(d.validators(v.p).at(-1)!.active - RENT_200).toBe(MIN);
  v.votes.push(vote);
  v.stakes.push(stake);
  return v.votes.length - 1;
}

/** Upstream's update_all: every chunk of the list, the pool, and the cleanup (each must succeed). */
async function updateAll(d: Diff, payer: KeyPairSigner, p: Pool, label: string, noMerge = false): Promise<void> {
  const pairs = await updatePairs(d, p);
  for (let i = 0; i < Math.max(pairs.length, 1); i += 4)
    await d.ok(`update list (${label}${i ? ` ${i}` : ""})`, payer, [ix.updateValidatorListBalance(p, i, noMerge, pairs.slice(i, i + 4))]);
  await d.ok(`update pool (${label})`, payer, [ix.updateStakePoolBalance(p)]);
  await d.ok(`cleanup (${label})`, payer, [ix.cleanupRemovedValidatorEntries(p)]);
}

/**
 * Upstream's simple_deposit_stake: a stake account of a new user holding `amount` past its rent, delegated to
 * validator `i`, handed to the deposit authority and deposited (in the same transaction upstream, here right before).
 * Returns the user and the pool-token account.
 */
async function depositStake(d: Diff, payer: KeyPairSigner, v: V, i: number, amount: bigint, label: string) {
  const user = await d.funded(100n);
  const stake = await d.userStake(payer, user, amount, v.votes[i]!);
  const tokens = await d.tokenAccount(payer, v.p.mint, user.address, v.p.tokenProgram);
  await d.setup(payer, stakeAuthorizeBoth(stake, user, v.p.deposit));
  await d.ok(`deposit stake (${label})`, payer, [
    ix.depositStake(v.p, { depositAuthority: v.p.deposit, stake, validatorStake: v.stakes[i]!, to: tokens, referrer: v.p.managerFee }),
  ]);
  return { user, stake, tokens, staked: amount };
}

/** A blank stake account to split into (upstream's create_blank_stake_account). */
const blank = (d: Diff, payer: KeyPairSigner) => d.allocated(payer, STAKE_ACCOUNT_SIZE, STAKE);

/** WithdrawStake from `from` into a new blank account, by `who` from `tokens`. */
async function withdrawStake(
  d: Diff,
  payer: KeyPairSigner,
  p: Pool,
  a: { from: Address; who: KeyPairSigner; tokens: Address },
  poolTokens: bigint,
  minimum?: bigint,
) {
  const receive = await blank(d, payer);
  return {
    receive,
    i: ix.withdrawStake(p, { split: a.from, receive, newAuthority: a.who.address, transferAuthority: a.who, from: a.tokens }, poolTokens, minimum),
  };
}

const transientOf = (v: V, i: number, seed: bigint) => transientStake(v.votes[i]!, v.p.pool, seed);
type Decrease = "Additional" | "Reserve" | "Deprecated";
/** decrease_validator_stake_either: one of the three decrease instructions. */
async function decrease(d: Diff, v: V, i: number, amount: bigint, seed: bigint, kind: Decrease, ephemeralSeed = 0n): Promise<Instruction> {
  const transient = await transientOf(v, i, seed);
  if (kind === "Reserve") return ix.decreaseValidatorStakeWithReserve(v.p, v.p.staker, v.stakes[i]!, transient, amount, seed);
  if (kind === "Deprecated") {
    // The deprecated instruction pays no rent: upstream's helper funds the transient account first.
    if (!d.original.getAccount(transient).exists) for (const vm of d.vms) vm.airdrop(transient, lamports(RENT_200));
    return ix.decreaseValidatorStake(v.p, v.p.staker, v.stakes[i]!, transient, amount, seed);
  }
  return ix.decreaseAdditionalValidatorStake(
    v.p,
    v.p.staker,
    { stake: v.stakes[i]!, ephemeral: await ephemeralStake(v.p.pool, ephemeralSeed), transient },
    amount,
    seed,
    ephemeralSeed,
  );
}
async function increase(v: V, i: number, amount: bigint, seed: bigint, additional: boolean, ephemeralSeed = 0n): Promise<Instruction> {
  const transient = await transientOf(v, i, seed);
  return additional
    ? ix.increaseAdditionalValidatorStake(
        v.p,
        v.p.staker,
        { ephemeral: await ephemeralStake(v.p.pool, ephemeralSeed), transient, stake: v.stakes[i]!, vote: v.votes[i]! },
        amount,
        seed,
        ephemeralSeed,
      )
    : ix.increaseValidatorStake(v.p, v.p.staker, transient, v.stakes[i]!, v.votes[i]!, amount, seed);
}

/** Pool tokens worth at least `lamports` (rounded up), at the pool's current rate. */
function tokensFor(d: Diff, p: Pool, lamportsWanted: bigint): bigint {
  const { lamports: total, supply } = d.totals(p);
  return (lamportsWanted * supply + total - 1n) / total;
}
/** calculate_inverse_withdrawal_fee: the pool tokens that leave `tokens` once the withdrawal fee is taken. */
const inverseFee = (tokens: bigint, f: Fee) => (tokens * f.denominator + f.denominator - 1n) / (f.denominator - f.numerator);

// ---- The pool account's fee fields (state.rs StakePool, Borsh) ------------------------------------------------------

interface FutureFee {
  epochs: number;
  fee?: Fee;
}
/** A Fee { denominator, numerator } at `at`. */
const readFee = (b: Buffer, at: number): Fee => ({ denominator: b.readBigUInt64LE(at), numerator: b.readBigUInt64LE(at + 8) });
/** The pool account's variable-length tail parsed: fees, preferred validators and the offsets of each. */
function poolState(data: Buffer) {
  let at = 330;
  const epochFee = readFee(data, at);
  at += 16;
  const future = (): FutureFee => {
    const tag = data[at]!;
    at += 1;
    if (tag === 0) return { epochs: 0 };
    const f = readFee(data, at);
    at += 16;
    return { epochs: tag, fee: f };
  };
  const option = (): Address | null => {
    const tag = data[at]!;
    at += 1;
    if (tag === 0) return null;
    const k = getAddressDecoder().decode(data.subarray(at, at + 32));
    at += 32;
    return k;
  };
  const nextEpochFee = future();
  const preferredAt = at;
  const preferredDeposit = option();
  const preferredWithdraw = option();
  const tailAt = at;
  const stakeDepositFee = readFee(data, at);
  at += 16;
  const stakeWithdrawalFee = readFee(data, at);
  at += 16;
  const nextStakeWithdrawalFee = future();
  const stakeReferralFee = data[at]!;
  at += 1;
  option();
  const solDepositFee = readFee(data, at);
  at += 16;
  const solReferralFee = data[at]!;
  at += 1;
  option();
  const solWithdrawalFee = readFee(data, at);
  at += 16;
  const nextSolWithdrawalFee = future();
  return {
    epochFee,
    nextEpochFee,
    preferredDeposit,
    preferredWithdraw,
    stakeDepositFee,
    stakeWithdrawalFee,
    nextStakeWithdrawalFee,
    stakeReferralFee,
    solDepositFee,
    solReferralFee,
    solWithdrawalFee,
    nextSolWithdrawalFee,
    preferredAt,
    tailAt,
  };
}
/** The pool account's bytes with its preferred validators set (upstream writes the account with set_account). */
function withPreferred(data: Buffer, deposit: Address | null, withdraw: Address | null): Buffer {
  const s = poolState(data);
  const opt = (k: Address | null) => (k ? Buffer.concat([u8(1), key(k)]) : u8(0));
  const out = Buffer.concat([data.subarray(0, s.preferredAt), opt(deposit), opt(withdraw), data.subarray(s.tailAt)]);
  return Buffer.concat([out, Buffer.alloc(Math.max(0, data.length - out.length))]).subarray(0, data.length);
}

// ---- Accounts written as upstream's add_account / set_account write them --------------------------------------------

/** StakeStateV2 bytes: Initialized (a meta) or Stake (a meta and a delegation). */
function stakeBytes(o: {
  kind: "Uninitialized" | "Initialized" | "Stake";
  rentReserve?: bigint;
  staker?: Address;
  withdrawer?: Address;
  lockupEpoch?: bigint;
  custodian?: Address;
  voter?: Address;
  stake?: bigint;
  activation?: bigint;
  deactivation?: bigint;
  credits?: bigint;
}): Buffer {
  const b = Buffer.alloc(200);
  b.writeUInt32LE({ Uninitialized: 0, Initialized: 1, Stake: 2 }[o.kind], 0);
  if (o.kind === "Uninitialized") return b;
  b.writeBigUInt64LE(o.rentReserve ?? RENT_200, 4);
  key(o.staker!).copy(b, STAKE_OFFSETS.staker);
  key(o.withdrawer!).copy(b, STAKE_OFFSETS.withdrawer);
  b.writeBigUInt64LE(o.lockupEpoch ?? 0n, 84);
  if (o.custodian) key(o.custodian).copy(b, 92);
  if (o.kind === "Initialized") return b;
  key(o.voter!).copy(b, STAKE_OFFSETS.voter);
  b.writeBigUInt64LE(o.stake!, STAKE_OFFSETS.stake);
  b.writeBigUInt64LE(o.activation ?? 0n, STAKE_OFFSETS.activation);
  b.writeBigUInt64LE(o.deactivation ?? U64_MAX, STAKE_OFFSETS.deactivation);
  b.writeDoubleLE(0.25, 180);
  b.writeBigUInt64LE(o.credits ?? 0n, 188);
  return b;
}
/** A ValidatorStakeInfo's 73 bytes. */
function entryBytes(o: { vote: Address; active: bigint; transient?: bigint; epoch: bigint; transientSeed?: bigint; seed?: number; status?: number }): Buffer {
  const b = Buffer.alloc(73);
  b.writeBigUInt64LE(o.active, 0);
  b.writeBigUInt64LE(o.transient ?? 0n, 8);
  b.writeBigUInt64LE(o.epoch, 16);
  b.writeBigUInt64LE(o.transientSeed ?? 0n, 24);
  b.writeUInt32LE(o.seed ?? 0, 36);
  b[40] = o.status ?? STATUS.Active;
  key(o.vote).copy(b, 41);
  return b;
}
/** The withdraw authority's stake rent reserve, as the Stake program stores it (read from the pool's reserve). */
const rentReserveOf = (d: Diff, p: Pool) => d.data(p.reserve).readBigUInt64LE(4);
/** Add `amount` to the pool's lamports and token supply, and the tokens to the manager's account (as add_account does). */
function addToPool(d: Diff, p: Pool, amount: bigint) {
  d.patch(p.pool, (b) => {
    b.writeBigUInt64LE(b.readBigUInt64LE(258) + amount, 258);
    b.writeBigUInt64LE(b.readBigUInt64LE(266) + amount, 266);
  });
  d.patch(p.mint, (b) => b.writeBigUInt64LE(b.readBigUInt64LE(36) + amount, 36));
  d.patch(p.managerFee, (b) => b.writeBigUInt64LE(b.readBigUInt64LE(64) + amount, 64));
}

/** Stake Initialize (StakeInstruction tag 0) of `stake` for `authority`, no lockup. */
function stakeInitialize(stake: Address, authority: Address): Instruction {
  return {
    programAddress: STAKE,
    accounts: [
      { address: stake, role: AccountRole.WRITABLE },
      { address: RENT, role: AccountRole.READONLY },
    ] as Instruction["accounts"],
    data: new Uint8Array(Buffer.concat([u32(0), key(authority), key(authority), Buffer.alloc(16), Buffer.alloc(32)])),
  };
}
/** ComputeBudget SetComputeUnitLimit. */
const computeUnitLimit = (units: number): Instruction => ({
  programAddress: address("ComputeBudget111111111111111111111111111111"),
  accounts: [],
  data: new Uint8Array(Buffer.concat([u8(2), u32(units)])),
});

// ---- initialize.rs ---------------------------------------------------------------------------------------------------

describe("initialize.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(10_000n);
  });
  const init = (q: Pool) =>
    ix.initialize(
      { ...q, manager: q.manager, staker: q.staker.address },
      { epoch: fee(1n, 100n), withdrawal: fee(3n, 1000n), deposit: fee(1n, 1000n), referral: 25, maxValidators: q.maxValidators },
    );
  /** The account written at a new address. */
  const at = async (owner: Address, bytes: Buffer) => {
    const a = (await generateKeyPairSigner()).address;
    d.write(a, owner, bytes);
    return a;
  };

  it("fail_with_already_initialized_validator_list: a list another pool already uses", async () => {
    const first = await d.createPool(payer, { label: "initialize (first pool)" });
    const q = await d.poolAccounts(payer);
    expect(await d.both("initialize: another pool's list", payer, [replace(init(q), 4, first.list)])).toBe(custom(E.AlreadyInUse));
  });

  it("success_with_supported_extensions: a fee account with the extensions a fee account may have (CpiGuard among them)", async () => {
    const q = await d.poolAccounts(payer, {
      tokenProgram: TOKEN_2022,
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
    });
    // The fee account as the Token-2022 program lays it out: TransferFeeAmount (2) and CpiGuard (11, enabled).
    const feeAccount = await at(
      TOKEN_2022,
      tokenAccountBytes({ mint: q.mint, owner: q.manager.address, tlv: Buffer.concat([tlv(2, Buffer.alloc(8)), tlv(11, u8(1))]) }),
    );
    await d.ok("initialize: fee account with CpiGuard", payer, [replace(init(q), 7, feeAccount)]);
  });

  it("fail_with_unsupported_mint_extension: a NonTransferable mint", async () => {
    const q = await d.poolAccounts(payer, { tokenProgram: TOKEN_2022 });
    const mint = await at(TOKEN_2022, mintBytes({ authority: q.withdraw, tlv: tlv(9, Buffer.alloc(0)) }));
    expect(await d.both("initialize: non-transferable mint", payer, [replace(init(q), 6, mint)])).toBe(custom(E.UnsupportedMintExtension));
  });

  it("fail_with_unsupported_account_extension: a Token-2022 fee account with MemoTransfer", async () => {
    const q = await d.poolAccounts(payer, { tokenProgram: TOKEN_2022 });
    const feeAccount = await at(TOKEN_2022, tokenAccountBytes({ mint: q.mint, owner: q.manager.address, tlv: tlv(8, u8(1)) }));
    expect(await d.both("initialize: fee account with MemoTransfer", payer, [replace(init(q), 7, feeAccount)])).toBe(custom(E.UnsupportedFeeAccountExtension));
  });

  it("fail_with_wrong_fee_account: an empty account of another program as the fee account", async () => {
    const q = await d.poolAccounts(payer);
    const feeAccount = await at(nowhere(), Buffer.alloc(165));
    expect(await d.both("initialize: fee account of another program", payer, [replace(init(q), 7, feeAccount)])).toBe(builtin("UninitializedAccount"));
  });

  it("fail_with_bad_reserve: a reserve whose lockup has another custodian", async () => {
    const q = await d.poolAccounts(payer);
    const reserve = await d.stakeAccount(payer, { staker: q.withdraw, withdrawer: q.withdraw, lamports: RENT_200 + SOL, lockup: { custodian: payer.address } });
    expect(await d.both("initialize: reserve lockup custodian", payer, [replace(init(q), 5, reserve)])).toBe(custom(E.WrongStakeStake));
  });
});

// ---- vsa_add.rs, vsa_remove.rs ---------------------------------------------------------------------------------------

describe("vsa_add.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(10_000n);
  });

  it("fail_with_uninitialized_validator_list_account: a list of zeros", async () => {
    const p = await upstreamPool(d, payer, "vsa_add zeros", { reserveLamports: 10n * SOL });
    const vote = await d.vote(payer);
    const saved = d.data(p.list);
    d.patch(p.list, (b) => b.fill(0));
    expect(await d.both("add validator: list of zeros", payer, [ix.addValidator(p, p.staker, await validatorStake(vote, p.pool), vote)])).toBe(
      custom(E.InvalidState),
    );
    d.patch(p.list, (b) => saved.copy(b));
  });

  it("fail_on_non_vote_account: an address with no account as the vote account", async () => {
    const p = await upstreamPool(d, payer, "vsa_add non-vote", { reserveLamports: 10n * SOL });
    const vote = nowhere();
    expect(await d.both("add validator: no vote account", payer, [ix.addValidator(p, p.staker, await validatorStake(vote, p.pool), vote)])).toBe(
      builtin("IncorrectProgramId"),
    );
  });

  it("success_with_lamports_in_account: the validator stake address holds lamports already", async () => {
    const p = await upstreamPool(d, payer, "vsa_add lamports", { reserveLamports: 10n * SOL });
    const vote = await d.vote(payer);
    const stake = await validatorStake(vote, p.pool);
    for (const vm of d.vms) vm.airdrop(stake, lamports(1_000_000n));
    await d.ok("add validator: lamports at the stake address", payer, [ix.addValidator(p, p.staker, stake, vote)], [stake]);
    const got = d.stake(stake);
    expect(got?.kind === "Stake" && got.meta.authorized.staker).toBe(p.withdraw);
  });

  it("fail_with_draining_reserve: a reserve holding exactly what the validator takes", async () => {
    // As upstream's: reserve = the minimum delegation and its own rent, which the new stake account would take whole.
    const p = await upstreamPool(d, payer, "vsa_add draining", { reserveLamports: MIN });
    const vote = await d.vote(payer);
    expect(await d.both("add validator: draining the reserve", payer, [ix.addValidator(p, p.staker, await validatorStake(vote, p.pool), vote)])).toBe(
      builtin("InsufficientFunds"),
    );
  });
});

describe("vsa_remove.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });
  /** Upstream's setup: a pool and one validator (seeds u32::MAX / u64::MAX), added in this epoch. */
  async function setup(label: string) {
    const p = await upstreamPool(d, payer, label, { reserveLamports: 10n * SOL });
    return addValidators(d, payer, p, 1, label, { seed: 0xffff_ffff });
  }
  const remove = (v: V, transientSeed = U64_MAX) => transientOf(v, 0, transientSeed).then((t) => ix.removeValidator(v.p, v.p.staker, v.stakes[0]!, t));

  it("success_at_large_value: a validator holding a thousand times the minimum", async () => {
    const v = await setup("remove large");
    await depositStake(d, payer, v, 0, 1000n * MIN, "remove large");
    await d.ok("remove validator (large)", payer, [await remove(v)]);
  });

  it("fail_double_remove: removed, merged and cleaned up in the same epoch, then removed again", async () => {
    const v = await setup("double remove");
    await d.ok("remove validator (double)", payer, [await remove(v)]);
    // Deactivated in the epoch it activated: inactive at once, merged into the reserve by the update.
    await updateAll(d, payer, v.p, "double remove");
    expect(d.validators(v.p)).toEqual([]);
    expect(await d.both("remove validator: again after cleanup", payer, [await remove(v)])).toBe(builtin("BorshIoError"));
  });

  it("fail_no_signature: the staker does not sign", async () => {
    const v = await setup("remove unsigned");
    expect(await d.both("remove validator: staker not signing", payer, [unsigned(await remove(v), 1)])).toBe(custom(E.SignatureMissing));
  });

  it("success_with_activating_transient_stake (and ..._triggers_deactivating_all): removed right after an increase", async () => {
    const v = await setup("remove activating");
    await d.ok("increase (remove activating)", payer, [await increase(v, 0, 2n * SOL, U64_MAX, false)]);
    await d.ok("remove validator: activating transient", payer, [await remove(v)]);
    expect(d.validators(v.p)[0]!.status).toBe(STATUS.DeactivatingAll);
    const t = d.stake(await transientOf(v, 0, U64_MAX));
    expect(t?.kind === "Stake" && t.stake.delegation.deactivationEpoch).not.toBe(U64_MAX);
  });

  it("success_with_deactivating_transient_stake: removed after a decrease, merged in the same epoch", async () => {
    const v = await setup("remove deactivating");
    const { tokens, user } = await depositStake(d, payer, v, 0, TEST_STAKE, "remove deactivating");
    await d.ok("decrease with reserve (remove deactivating)", payer, [await decrease(d, v, 0, TEST_STAKE + RENT_200, U64_MAX, "Reserve")]);
    await d.ok("remove validator: deactivating transient", payer, [await remove(v)]);
    // No deposits into it, no withdrawals from it.
    const other = await d.funded(10n);
    const stake = await d.userStake(payer, other, TEST_STAKE, v.votes[0]!);
    await d.setup(payer, stakeAuthorizeBoth(stake, other, v.p.deposit));
    const otherTokens = await d.tokenAccount(payer, v.p.mint, other.address);
    expect(
      await d.both("deposit stake: validator being removed (deactivating)", payer, [
        ix.depositStake(v.p, { depositAuthority: v.p.deposit, stake, validatorStake: v.stakes[0]!, to: otherTokens, referrer: v.p.managerFee }),
      ]),
    ).not.toBe("ok");
    const w = await withdrawStake(d, payer, v.p, { from: v.stakes[0]!, who: user, tokens }, 1n);
    expect(await d.both("withdraw stake: validator being removed (deactivating)", payer, [w.i])).not.toBe("ok");
    expect(d.validators(v.p)[0]).toMatchObject({ status: STATUS.DeactivatingAll, active: RENT_200 + MIN, transient: TEST_STAKE + 2n * RENT_200 });
    await updateAll(d, payer, v.p, "remove deactivating");
    expect(d.validators(v.p)).toEqual([]);
  });

  it("fail_cannot_hijack_transient_account: the transient address refunded and initialized after the merge", async () => {
    const v = await setup("hijack");
    await d.ok("increase (hijack)", payer, [await increase(v, 0, MIN + RENT_200, U64_MAX, false)]);
    d.nextEpoch();
    await updateAll(d, payer, v.p, "hijack 1");
    await d.ok("decrease with reserve (hijack)", payer, [await decrease(d, v, 0, MIN + RENT_200, U64_MAX, "Reserve")]);
    d.nextEpoch();
    const transient = await transientOf(v, 0, U64_MAX);
    const hijacker = await d.funded(1n);
    const pairs = await updatePairs(d, v.p);
    const got = await d.both("update list, then the transient address refunded and initialized", payer, [
      ix.updateValidatorListBalance(v.p, 0, false, pairs.slice(0, 1)),
      getTransferSolInstruction({ source: payer, destination: transient, amount: MIN + RENT_200 }) as Instruction,
      stakeInitialize(transient, hijacker.address),
    ]);
    expect(got).toBe(builtinAt(2, "InvalidAccountData"));
  });

  it("fail_with_uninitialized_validator_list_account: a list of zeros", async () => {
    const v = await setup("remove zeros");
    const saved = d.data(v.p.list);
    d.patch(v.p.list, (b) => b.fill(0));
    expect(await d.both("remove validator: list of zeros", payer, [await remove(v)])).toBe(custom(E.InvalidState));
    d.patch(v.p.list, (b) => saved.copy(b));
  });

  it("update_no_merge_after_removal: an active validator removed stays while it cools down", async () => {
    const v = await setup("remove cooling");
    await depositStake(d, payer, v, 0, TEST_STAKE, "remove cooling");
    d.nextEpoch();
    await updateAll(d, payer, v.p, "remove cooling 1");
    await d.ok("remove validator (cooling)", payer, [await remove(v)]);
    await updateAll(d, payer, v.p, "remove cooling 2");
    expect(d.validators(v.p)).toHaveLength(1);
    expect(d.validators(v.p)[0]).toMatchObject({ status: STATUS.DeactivatingValidator, transient: 0n });
  });
});

// ---- preferred_validators.rs, set_*.rs ------------------------------------------------------------------------------

describe("preferred_validators.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });

  it("test_preferred_validator_reset_on_cleanup_inactive_validator: a preferred validator ReadyForRemoval is reset by the cleanup", async () => {
    const zero = fee(0n, 0n);
    const p = await upstreamPool(d, payer, "preferred inactive", {
      epochFee: zero,
      withdrawalFee: zero,
      depositFee: zero,
      solDepositFee: zero,
      reserveLamports: TEST_STAKE,
    });
    const v = await addValidators(d, payer, p, 1, "preferred inactive");
    await d.ok("set preferred withdraw (inactive)", payer, [ix.setPreferredValidator(p, p.staker, "Withdraw", v.votes[0]!)]);
    d.nextEpoch();
    await updateAll(d, payer, p, "preferred inactive");
    // Withdraw the validator whole: it is ReadyForRemoval and no longer preferred.
    const tokens = await d.tokenAccount(payer, p.mint, payer.address);
    await d.ok("deposit sol (preferred inactive)", payer, [ix.depositSol(p, { from: payer, to: tokens, referrer: tokens }, 10n * SOL)]);
    const w = await withdrawStake(d, payer, p, { from: v.stakes[0]!, who: payer, tokens }, tokensFor(d, p, d.lamports(v.stakes[0]!)));
    await d.ok("withdraw stake: whole preferred validator", payer, [w.i]);
    expect(poolState(d.data(p.pool)).preferredWithdraw).toBeNull();
    expect(d.validators(p)[0]!.status).toBe(STATUS.ReadyForRemoval);
    // Both preferred validators written to be that one, as upstream's set_account does; the cleanup resets them.
    d.patch(p.pool, (b) => withPreferred(b, v.votes[0]!, v.votes[0]!).copy(b));
    expect(poolState(d.data(p.pool))).toMatchObject({ preferredDeposit: v.votes[0], preferredWithdraw: v.votes[0] });
    await d.ok("cleanup resets preferred (ReadyForRemoval)", payer, [ix.cleanupRemovedValidatorEntries(p)]);
    expect(poolState(d.data(p.pool))).toMatchObject({ preferredDeposit: null, preferredWithdraw: null });
  });
});

describe("set_deposit_fee.rs, set_referral_fee.rs, set_epoch_fee.rs, set_funding_authority.rs, set_withdrawal_fee.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(10_000n);
  });
  const update = async (p: Pool, label: string) => {
    d.nextEpoch();
    await updateAll(d, payer, p, label);
  };

  it("set_deposit_fee::success_stake_increase_fee_from_0", async () => {
    const p = await upstreamPool(d, payer, "deposit fee from 0", { depositFee: fee(0n, 0n) });
    await d.ok("set fee: stake deposit from 0", payer, [ix.setFee(p, p.manager, { kind: "StakeDeposit", fee: fee(324n, 1234n) })]);
    expect(poolState(d.data(p.pool)).stakeDepositFee).toEqual(fee(324n, 1234n));
  });

  it("set_referral_fee::success_stake_increase_fee_from_0", async () => {
    const p = await upstreamPool(d, payer, "referral from 0", { referral: 0 });
    await d.ok("set fee: stake referral from 0", payer, [ix.setFee(p, p.manager, { kind: "StakeReferral", percent: 30 })]);
    expect(poolState(d.data(p.pool)).stakeReferralFee).toBe(30);
  });

  it("set_epoch_fee::success: a 100% epoch fee, applied after two epoch boundaries", async () => {
    const p = await upstreamPool(d, payer, "epoch fee 100%");
    await d.ok("set fee: epoch 100%", payer, [ix.setFee(p, p.manager, { kind: "Epoch", fee: fee(10n, 10n) })]);
    expect(poolState(d.data(p.pool))).toMatchObject({ epochFee: fee(1n, 100n), nextEpochFee: { epochs: 2, fee: fee(10n, 10n) } });
    await update(p, "epoch fee 100% 1");
    expect(poolState(d.data(p.pool))).toMatchObject({ epochFee: fee(1n, 100n), nextEpochFee: { epochs: 1, fee: fee(10n, 10n) } });
    await update(p, "epoch fee 100% 2");
    expect(poolState(d.data(p.pool))).toMatchObject({ epochFee: fee(10n, 10n), nextEpochFee: { epochs: 0 } });
  });

  it("set_funding_authority::fail_without_signature", async () => {
    const p = await upstreamPool(d, payer, "funding unsigned");
    const auth = await d.funded(1n);
    expect(await d.both("set funding: manager not signing", payer, [unsigned(ix.setFundingAuthority(p, p.manager, "StakeDeposit", auth.address), 1)])).toBe(
      custom(E.SignatureMissing),
    );
  });

  it("set_withdrawal_fee::success_fee_cannot_increase_more_than_once", async () => {
    const p = await upstreamPool(d, payer, "withdrawal fee once");
    const set = (label: string, f: Fee) => [
      ix.setFee(p, p.manager, { kind: "StakeWithdrawal", fee: f }),
      ix.setFee(p, p.manager, { kind: "SolWithdrawal", fee: f }),
    ];
    for (const [k, i] of set("up", fee(4n, 1000n)).entries()) await d.ok(`set fee: withdrawal 4/1000 (${k})`, payer, [i]);
    await update(p, "withdrawal fee once 1");
    await update(p, "withdrawal fee once 2");
    expect(poolState(d.data(p.pool))).toMatchObject({
      stakeWithdrawalFee: fee(4n, 1000n),
      solWithdrawalFee: fee(4n, 1000n),
      nextStakeWithdrawalFee: { epochs: 0 },
    });
    // Back to the old fee in the same epoch: taken, but not applied by an update in that epoch.
    for (const [k, i] of set("down", fee(3n, 1000n)).entries()) await d.ok(`set fee: withdrawal back to 3/1000 (${k})`, payer, [i]);
    await d.ok("update pool (withdrawal fee once, same epoch)", payer, [ix.updateStakePoolBalance(p)]);
    expect(poolState(d.data(p.pool))).toMatchObject({
      stakeWithdrawalFee: fee(4n, 1000n),
      nextStakeWithdrawalFee: { epochs: 2, fee: fee(3n, 1000n) },
      nextSolWithdrawalFee: { epochs: 2, fee: fee(3n, 1000n) },
    });
  });

  it("set_withdrawal_fee::success_reset_fee_after_one_epoch: a new fee restarts the two-epoch wait", async () => {
    const p = await upstreamPool(d, payer, "withdrawal fee reset");
    await d.ok("set fee: stake withdrawal 4/1000 (reset)", payer, [ix.setFee(p, p.manager, { kind: "StakeWithdrawal", fee: fee(4n, 1000n) })]);
    await d.ok("set fee: sol withdrawal 4/1000 (reset)", payer, [ix.setFee(p, p.manager, { kind: "SolWithdrawal", fee: fee(4n, 1000n) })]);
    await update(p, "withdrawal fee reset");
    expect(poolState(d.data(p.pool)).nextStakeWithdrawalFee).toEqual({ epochs: 1, fee: fee(4n, 1000n) });
    await d.ok("set fee: stake withdrawal back (reset)", payer, [ix.setFee(p, p.manager, { kind: "StakeWithdrawal", fee: fee(3n, 1000n) })]);
    await d.ok("set fee: sol withdrawal back (reset)", payer, [ix.setFee(p, p.manager, { kind: "SolWithdrawal", fee: fee(3n, 1000n) })]);
    expect(poolState(d.data(p.pool))).toMatchObject({
      stakeWithdrawalFee: fee(3n, 1000n),
      nextStakeWithdrawalFee: { epochs: 2, fee: fee(3n, 1000n) },
      nextSolWithdrawalFee: { epochs: 2, fee: fee(3n, 1000n) },
    });
  });

  it("set_withdrawal_fee::fail_high_sol_fee_increase, fail_high_stake_fee_increase_from_0, fail_not_updated", async () => {
    const p = await upstreamPool(d, payer, "withdrawal fee limits");
    expect(await d.both("set fee: sol withdrawal over 1.5x", payer, [ix.setFee(p, p.manager, { kind: "SolWithdrawal", fee: fee(46n, 10_000n) })])).toBe(
      custom(E.FeeIncreaseTooHigh),
    );
    const zero = await upstreamPool(d, payer, "withdrawal fee from 0", { withdrawalFee: fee(0n, 1n) });
    expect(
      await d.both("set fee: stake withdrawal too fast from 0", payer, [ix.setFee(zero, zero.manager, { kind: "StakeWithdrawal", fee: fee(16n, 10_000n) })]),
    ).toBe(custom(E.FeeIncreaseTooHigh));
    d.nextEpoch();
    expect(await d.both("set fee: stake withdrawal on a stale pool", payer, [ix.setFee(p, p.manager, { kind: "StakeWithdrawal", fee: fee(11n, 100n) })])).toBe(
      custom(E.StakeListAndPoolOutOfDate),
    );
  });
});

// ---- deposit.rs, deposit_sol.rs, deposit_authority.rs, deposit_edge_cases.rs ---------------------------------------

describe("deposit.rs, deposit_sol.rs, deposit_authority.rs, deposit_edge_cases.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });
  /** Upstream's deposit setup: one validator, a user's stake delegated to it, the epoch on and the pool updated. */
  async function setup(label: string, tokenProgram: Address = TOKEN) {
    const p = await upstreamPool(d, payer, label, { tokenProgram });
    const v = await addValidators(d, payer, p, 1, label);
    const user = await d.funded(100n);
    const stakes = [await d.userStake(payer, user, TEST_STAKE, v.votes[0]!), await d.userStake(payer, user, TEST_STAKE, v.votes[0]!)];
    d.nextEpoch();
    await updateAll(d, payer, p, label);
    for (const s of stakes) await d.setup(payer, stakeAuthorizeBoth(s, user, p.deposit));
    const tokens = await d.tokenAccount(payer, p.mint, user.address, tokenProgram);
    return { v, user, stakes, tokens };
  }

  for (const program of [TOKEN, TOKEN_2022]) {
    const name = program === TOKEN ? "token" : "token-2022";
    it(`deposit::success_with_slippage [${name}]: the least the deposit gives, and one more`, async () => {
      const { v, stakes, tokens } = await setup(`deposit slippage ${name}`, program);
      const dep = (stake: Address, minimum: bigint) =>
        ix.depositStake(v.p, { depositAuthority: v.p.deposit, stake, validatorStake: v.stakes[0]!, to: tokens, referrer: v.p.managerFee }, minimum);
      // At one pool token a lamport (no rewards yet) two equal deposits give the same: the first one shows how much.
      expect(d.totals(v.p).lamports).toBe(d.totals(v.p).supply);
      await d.ok(`deposit stake slippage 0 (${name})`, payer, [dep(stakes[0]!, 0n)]);
      const expected = d.tokenBalance(tokens);
      expect(await d.both(`deposit stake slippage: one more (${name})`, payer, [dep(stakes[1]!, expected + 1n)])).toBe(custom(E.ExceededSlippage));
      await d.ok(`deposit stake slippage: exactly (${name})`, payer, [dep(stakes[1]!, expected)]);
      expect(d.tokenBalance(tokens)).toBe(2n * expected);
    });
  }

  it("deposit_sol::fail_with_wrong_mint_for_receiver_acc, fail_with_invalid_referrer", async () => {
    const p = await upstreamPool(d, payer, "deposit sol receivers");
    const user = await d.funded(100n);
    const otherMint = await d.mint(payer, { authority: payer.address });
    const wrong = await d.tokenAccount(payer, otherMint, user.address);
    const tokens = await d.tokenAccount(payer, p.mint, user.address);
    expect(
      await d.both("deposit sol: receiver of another mint", payer, [ix.depositSol(p, { from: user, to: wrong, referrer: p.managerFee }, TEST_STAKE)]),
    ).toBe(custom(TokenError.MintMismatch));
    expect(await d.both("deposit sol: referrer with no account", payer, [ix.depositSol(p, { from: user, to: tokens, referrer: nowhere() }, TEST_STAKE)])).toBe(
      builtin("InvalidAccountData"),
    );
  });

  it("deposit_edge_cases::fail_with_invalid_referrer", async () => {
    const { v, stakes, tokens } = await setup("deposit stake referrer");
    const dep = ix.depositStake(v.p, { depositAuthority: v.p.deposit, stake: stakes[0]!, validatorStake: v.stakes[0]!, to: tokens, referrer: nowhere() });
    expect(await d.both("deposit stake: referrer with no account", payer, [dep])).toBe(builtin("InvalidAccountData"));
  });

  it("deposit_authority::success_deposit, fail_deposit_without_authority_signature: activating stake through the pool's authority", async () => {
    const authority = await d.funded(10n);
    const p = await upstreamPool(d, payer, "deposit authority", { depositAuthority: authority });
    // One authority for both: the SOL deposits that fund the validator need it too.
    const v = await addValidators(d, payer, p, 1, "deposit authority", { authority });
    const user = await d.funded(100n);
    // Delegated in this epoch: activating, as the validator stake (both activating in the same epoch merge).
    const stake = await d.userStake(payer, user, TEST_STAKE, v.votes[0]!);
    await d.setup(payer, stakeAuthorizeBoth(stake, user, authority.address));
    const tokens = await d.tokenAccount(payer, p.mint, user.address);
    const stranger = await d.funded(1n);
    const dep = (by: KeyPairSigner) => ix.depositStake(p, { depositAuthority: by, stake, validatorStake: v.stakes[0]!, to: tokens, referrer: p.managerFee });
    expect(await d.both("deposit stake: another key signing as the authority", payer, [dep(stranger)])).toBe(custom(E.InvalidStakeDepositAuthority));
    await d.ok("deposit stake: activating, through the authority", payer, [dep(authority)]);
  });
});

// ---- withdraw.rs, withdraw_with_fee.rs, withdraw_edge_cases.rs ----------------------------------------------------

describe("withdraw.rs, withdraw_with_fee.rs, withdraw_edge_cases.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });
  const WITHDRAWAL_FEE = fee(3n, 1000n);
  /**
   * Upstream's setup_for_withdraw: one validator, a deposit of three times the minimum into it in the same epoch
   * (activating), its pool tokens delegated to a transfer authority, and a blank stake account to split into.
   */
  async function setup(label: string, reserveLamports = RENT_200) {
    const p = await upstreamPool(d, payer, label, { reserveLamports });
    const v = await addValidators(d, payer, p, 1, label);
    const dep = await depositStake(d, payer, v, 0, 3n * MIN, label);
    const delegate = await d.funded(1n);
    const amount = d.tokenBalance(dep.tokens);
    await d.setup(payer, [token.getApproveInstruction({ source: dep.tokens, delegate: delegate.address, owner: dep.user, amount }) as Instruction]);
    return { p, v, ...dep, delegate, amount };
  }
  const withdraw = async (s: Awaited<ReturnType<typeof setup>>, from: Address, poolTokens: bigint, who = s.delegate, tokens = s.tokens) =>
    (await withdrawStake(d, payer, s.p, { from, who, tokens }, poolTokens)).i;

  it("withdraw::success_with_closed_manager_fee_account: the fee account emptied and closed, no fee taken", async () => {
    const s = await setup("closed fee account");
    const feeTokens = d.tokenBalance(s.p.managerFee);
    await d.setup(payer, [
      token.getTransferInstruction({ source: s.p.managerFee, destination: s.tokens, authority: s.p.manager, amount: feeTokens }) as Instruction,
      token.getCloseAccountInstruction({ account: s.p.managerFee, destination: s.p.manager.address, owner: s.p.manager }) as Instruction,
    ]);
    const before = d.totals(s.p);
    await d.ok("withdraw stake: fee account closed", payer, [await withdraw(s, s.v.stakes[0]!, s.amount)], [s.p.managerFee]);
    expect(before.supply - d.totals(s.p).supply).toBe(s.amount);
  });

  it("withdraw::fail_with_not_enough_tokens: more than the delegate was approved for", async () => {
    const s = await setup("not enough tokens");
    await d.setup(payer, [token.getApproveInstruction({ source: s.tokens, delegate: s.delegate.address, owner: s.user, amount: 1n }) as Instruction]);
    expect(await d.both("withdraw stake: more than approved", payer, [await withdraw(s, s.v.stakes[0]!, s.amount)])).toBe(custom(TokenError.InsufficientFunds));
    await d.setup(payer, [token.getRevokeInstruction({ source: s.tokens, owner: s.user }) as Instruction]);
    expect(await d.both("withdraw stake: approval revoked", payer, [await withdraw(s, s.v.stakes[0]!, s.amount)])).toBe(custom(TokenError.OwnerMismatch));
  });

  it("withdraw_with_fee::success_withdraw_all_fee_tokens: the manager's delegate withdraws every fee token", async () => {
    const s = await setup("all fee tokens");
    await d.setup(payer, [
      token.getTransferInstruction({ source: s.tokens, destination: s.p.managerFee, authority: s.delegate, amount: s.amount / 2n }) as Instruction,
    ]);
    const feeDelegate = await d.funded(1n);
    const all = d.tokenBalance(s.p.managerFee);
    await d.setup(payer, [
      token.getApproveInstruction({ source: s.p.managerFee, delegate: feeDelegate.address, owner: s.p.manager, amount: all }) as Instruction,
    ]);
    await d.ok("withdraw stake: all fee tokens", payer, [await withdraw(s, s.v.stakes[0]!, all, feeDelegate, s.p.managerFee)]);
    expect(d.tokenBalance(s.p.managerFee)).toBe(0n);
  });

  it("withdraw_with_fee::success_empty_out_stake_with_fee: down to exactly the minimum, the fee included", async () => {
    const s = await setup("empty out with fee");
    const i = await addValidator(d, payer, s.v, "empty out with fee 2");
    const second = await depositStake(d, payer, s.v, i, TEST_STAKE, "empty out with fee 2");
    await d.setup(payer, [
      token.getTransferInstruction({ source: s.tokens, destination: second.tokens, authority: s.delegate, amount: s.amount }) as Instruction,
    ]);
    const delegate = await d.funded(1n);
    const all = d.tokenBalance(second.tokens);
    await d.setup(payer, [token.getApproveInstruction({ source: second.tokens, delegate: delegate.address, owner: second.user, amount: all }) as Instruction]);
    const lamportsOut = d.lamports(s.v.stakes[0]!) - (RENT_200 + MIN);
    const poolTokens = inverseFee(tokensFor(d, s.p, lamportsOut), WITHDRAWAL_FEE);
    await d.ok("withdraw stake: down to the minimum", payer, [await withdraw(s, s.v.stakes[0]!, poolTokens, delegate, second.tokens)]);
    expect(d.lamports(s.v.stakes[0]!)).toBe(RENT_200 + MIN);
  });

  it("withdraw_edge_cases::fail_remove_validator_blocked_by_transient_stake", async () => {
    const s = await setup("blocked by transient");
    await d.ok("decrease additional (blocked by transient)", payer, [await decrease(d, s.v, 0, s.staked / 3n, 0n, "Additional")]);
    d.nextEpoch();
    await updateAll(d, payer, s.p, "blocked by transient", true);
    const active = d.validators(s.p)[0]!.active;
    const { lamports: total, supply } = d.totals(s.p);
    const poolTokens = inverseFee(((active - RENT_200) * supply) / total, WITHDRAWAL_FEE);
    expect(await d.both("withdraw stake: all but the rent, transient stake left", payer, [await withdraw(s, s.v.stakes[0]!, poolTokens)])).toBe(
      custom(E.StakeLamportsNotEqualToMinimum),
    );
    expect(d.lamports(await transientOf(s.v, 0, 0n))).toBeGreaterThan(0n);
  });

  it("withdraw_edge_cases::fail_remove_validator: pool tokens of the account's whole balance", async () => {
    const s = await setup("remove whole balance");
    await d.ok("decrease with reserve (remove whole balance)", payer, [await decrease(d, s.v, 0, s.staked / 2n, 0n, "Reserve")]);
    d.nextEpoch();
    await updateAll(d, payer, s.p, "remove whole balance");
    expect(await d.both("withdraw stake: the account's lamports in tokens", payer, [await withdraw(s, s.v.stakes[0]!, d.lamports(s.v.stakes[0]!))])).toBe(
      custom(E.StakeLamportsNotEqualToMinimum),
    );
  });

  for (const multiple of [0n, 5n, 11n, 29n]) {
    it(`withdraw_edge_cases::success_remove_validator [${multiple}]: the last validator taken whole, tokens worth more than a lamport`, async () => {
      const s = await setup(`remove whole ${multiple}`);
      for (const vm of d.vms) if (multiple) vm.airdrop(s.p.reserve, lamports(s.staked * multiple));
      d.nextEpoch();
      await updateAll(d, payer, s.p, `remove whole ${multiple} 1`);
      const { lamports: total, supply } = d.totals(s.p);
      const perToken = (total + supply - 1n) / supply;
      await d.ok(`decrease with reserve (remove whole ${multiple})`, payer, [await decrease(d, s.v, 0, s.staked + RENT_200 - perToken, 0n, "Reserve")]);
      d.nextEpoch();
      await updateAll(d, payer, s.p, `remove whole ${multiple} 2`);
      const remaining = d.lamports(s.v.stakes[0]!);
      expect(remaining).toBeGreaterThan(RENT_200 + MIN);
      const after = d.totals(s.p);
      const poolTokens = inverseFee((remaining * after.supply + after.lamports - 1n) / after.lamports, WITHDRAWAL_FEE);
      const w = await withdrawStake(d, payer, s.p, { from: s.v.stakes[0]!, who: s.delegate, tokens: s.tokens }, poolTokens);
      await d.ok(`withdraw stake: whole validator (${multiple})`, payer, [w.i]);
      expect(d.original.getAccount(s.v.stakes[0]!).exists).toBe(false);
      expect(d.lamports(w.receive)).toBe(remaining + RENT_200);
      await d.ok(`cleanup (remove whole ${multiple})`, payer, [ix.cleanupRemovedValidatorEntries(s.p)]);
      expect(d.validators(s.p)).toEqual([]);
    });
  }

  it("withdraw_edge_cases::fail_with_transient: the transient stake's whole balance while the validator is at the minimum", async () => {
    const s = await setup("transient whole");
    d.nextEpoch();
    await updateAll(d, payer, s.p, "transient whole 1");
    const held = d.lamports(s.v.stakes[0]!);
    await d.ok("decrease additional (transient whole)", payer, [await decrease(d, s.v, 0, held - (RENT_200 + MIN), 0n, "Additional")]);
    d.nextEpoch();
    await updateAll(d, payer, s.p, "transient whole 2", true);
    const transient = await transientOf(s.v, 0, 0n);
    const { lamports: total, supply } = d.totals(s.p);
    const poolTokens = inverseFee((d.lamports(transient) * supply) / total, WITHDRAWAL_FEE);
    expect(await d.both("withdraw stake: the whole transient stake", payer, [await withdraw(s, transient, poolTokens)])).toBe(
      custom(E.StakeLamportsNotEqualToMinimum),
    );
  });

  it("withdraw_edge_cases::fail_withdraw_from_transient: transient stake while the validator still has some", async () => {
    const s = await setup("transient while active");
    // An empty second validator, preferred for withdrawals: it has nothing to give.
    await addValidator(d, payer, s.v, "transient while active 2");
    await d.ok("set preferred withdraw (transient while active)", payer, [ix.setPreferredValidator(s.p, s.p.staker, "Withdraw", s.v.votes[1]!)]);
    // Two lamports past the minimum left in the validator stake account.
    await d.ok("decrease with reserve (transient while active)", payer, [await decrease(d, s.v, 0, s.staked + RENT_200 - 2n, 0n, "Reserve")]);
    expect(await d.both("withdraw stake: from the transient stake", payer, [await withdraw(s, await transientOf(s.v, 0, 0n), s.amount)])).toBe(
      custom(E.InvalidStakeAccountAddress),
    );
  });

  it("withdraw_edge_cases::success_with_small_preferred_withdraw: a preferred validator with less than one pool token to give", async () => {
    const s = await setup("small preferred", 0n);
    for (const vm of d.vms) vm.airdrop(s.p.reserve, lamports(s.staked * 5n));
    d.nextEpoch();
    await updateAll(d, payer, s.p, "small preferred 1");
    const i = await addValidator(d, payer, s.v, "small preferred 2");
    await d.ok("set preferred withdraw (small preferred)", payer, [ix.setPreferredValidator(s.p, s.p.staker, "Withdraw", s.v.votes[i]!)]);
    await depositStake(d, payer, s.v, i, MIN + 1n, "small preferred");
    await d.ok("decrease with reserve (small preferred)", payer, [await decrease(d, s.v, i, RENT_200 + MIN, 0n, "Reserve")]);
    d.nextEpoch();
    await updateAll(d, payer, s.p, "small preferred 2");
    expect(await d.both("withdraw stake: 1 token from the small preferred validator", payer, [await withdraw(s, s.v.stakes[i]!, 1n)])).not.toBe("ok");
    await d.ok("withdraw stake: from the other validator (small preferred)", payer, [await withdraw(s, s.v.stakes[0]!, s.amount / 6n)]);
  });
});

// ---- increase.rs, decrease.rs ----------------------------------------------------------------------------------------

describe("increase.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });
  const RESERVE = 100n * SOL;
  /** Upstream's setup: a reserve of 100 SOL, one validator, a deposit of twice the minimum and a rent, all activating. */
  async function setup(label: string): Promise<V> {
    const p = await upstreamPool(d, payer, label, { reserveLamports: RESERVE });
    const v = await addValidators(d, payer, p, 1, label);
    await depositStake(d, payer, v, 0, 2n * MIN + RENT_200, label);
    return v;
  }

  it("fail_twice_diff_seed [non-additional]: a second increase with another transient seed", async () => {
    const v = await setup("increase two seeds");
    await d.ok("increase (two seeds)", payer, [await increase(v, 0, RESERVE / 3n, 42n, false)]);
    expect(await d.both("increase: another seed", payer, [await increase(v, 0, RESERVE / 4n, 4200n, false)])).toBe(custom(E.TransientAccountInUse));
  });

  for (const [name, first, second, ok] of [
    ["success-all-additional", true, true, true],
    ["fail-without-additional", true, false, false],
  ] as const) {
    it(`twice [${name}]`, async () => {
      const v = await setup(`increase twice ${name}`);
      await d.ok(`increase twice: first (${name})`, payer, [await increase(v, 0, RESERVE / 3n, 42n, first)]);
      const got = await d.both(`increase twice: second (${name})`, payer, [await increase(v, 0, RESERVE / 4n, 42n, second)]);
      expect(got).toBe(ok ? "ok" : custom(E.TransientAccountInUse));
      if (ok) {
        expect(d.original.getAccount(await ephemeralStake(v.p.pool, 0n)).exists).toBe(false);
        expect(d.validators(v.p)[0]!.transient).toBe(RESERVE / 3n + RESERVE / 4n + 2n * RENT_200);
      }
    });
  }

  it("fail_with_small_lamport_amount [additional], fail_overdraw_reserve [additional]", async () => {
    const v = await setup("increase additional limits");
    expect(await d.both("increase additional: under the minimum", payer, [await increase(v, 0, MIN - 1n, 42n, true)])).toBe(custom(E.UserStakeNotActive));
    expect(await d.both("increase additional: the whole reserve", payer, [await increase(v, 0, RESERVE, 42n, true)])).toBe(builtin("InsufficientFunds"));
  });
});

describe("decrease.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });
  /** Upstream's setup: a reserve for three rents and the minimum, one validator, a deposit, all activating. */
  async function setup(label: string) {
    const p = await upstreamPool(d, payer, label, { reserveLamports: 3n * RENT_200 + MIN });
    const v = await addValidators(d, payer, p, 1, label);
    const amount = (MIN + RENT_200) * 3n;
    await depositStake(d, payer, v, 0, amount, label);
    return { v, amount, stakeLamports: amount + RENT_200 };
  }

  for (const kind of ["Reserve", "Deprecated"] as const) {
    it(`fail_twice_diff_seed [${kind}]: a second decrease with another transient seed`, async () => {
      const { v, amount } = await setup(`decrease two seeds ${kind}`);
      await d.ok(`decrease (two seeds, ${kind})`, payer, [await decrease(d, v, 0, amount / 3n, 42n, kind)]);
      expect(await d.both(`decrease: another seed (${kind})`, payer, [await decrease(d, v, 0, amount / 2n, 4200n, kind)])).toBe(
        custom(E.TransientAccountInUse),
      );
    });
  }

  for (const [name, first, second, ok] of [
    ["success-all-additional", "Additional", "Additional", true],
    ["fail-without-additional", "Additional", "Reserve", false],
  ] as const) {
    it(`twice [${name}]`, async () => {
      const { v, amount } = await setup(`decrease twice ${name}`);
      await d.ok(`decrease twice: first (${name})`, payer, [await decrease(d, v, 0, amount / 3n, 42n, first)]);
      const got = await d.both(`decrease twice: second (${name})`, payer, [await decrease(d, v, 0, amount / 2n, 42n, second)]);
      expect(got).toBe(ok ? "ok" : custom(E.TransientAccountInUse));
      if (ok) {
        expect(d.original.getAccount(await ephemeralStake(v.p.pool, 0n)).exists).toBe(false);
        expect(d.validators(v.p)[0]!.transient).toBe(amount / 3n + amount / 2n + 2n * RENT_200);
      }
    });
  }

  for (const kind of ["Additional", "Deprecated"] as const) {
    it(`fail_with_small_lamport_amount, fail_big_overdraw, fail_overdraw, fail_validator_marked_for_removal_decrease_stake [${kind}]`, async () => {
      const { v, amount, stakeLamports } = await setup(`decrease limits ${kind}`);
      expect(await d.both(`decrease: under the minimum (${kind})`, payer, [await decrease(d, v, 0, MIN - 1n, 42n, kind)])).toBe(
        builtin("AccountNotRentExempt"),
      );
      expect(await d.both(`decrease: a million times the stake (${kind})`, payer, [await decrease(d, v, 0, stakeLamports * 1_000_000n, 42n, kind)])).toBe(
        builtin("InsufficientFunds"),
      );
      expect(await d.both(`decrease: one past the stake (${kind})`, payer, [await decrease(d, v, 0, stakeLamports + RENT_200 + 1n, 42n, kind)])).toBe(
        builtin("InsufficientFunds"),
      );
      await d.ok(`remove validator (decrease limits ${kind})`, payer, [ix.removeValidator(v.p, v.p.staker, v.stakes[0]!, await transientOf(v, 0, 0n))]);
      expect(await d.both(`decrease: validator removed (${kind})`, payer, [await decrease(d, v, 0, amount, 42n, kind)])).toBe(custom(E.ValidatorNotFound));
    });
  }
});

// ---- update_validator_list_balance.rs, update_stake_pool_balance.rs ------------------------------------------------

describe("update_validator_list_balance.rs, update_stake_pool_balance.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });
  /**
   * Upstream's setup(n): n validators (validator seeds 0, 1, 2, ..., transient seed u64::MAX) and a stake account of
   * 1.5 SOL delegated to each; an epoch on, the pool updated and the stakes deposited; another epoch on and updated.
   */
  async function setup(n: number, label: string) {
    const p = await upstreamPool(d, payer, label, { reserveLamports: TEST_STAKE * 2n * BigInt(n), maxValidators: n + 2 });
    const v: V = { p, votes: [], stakes: [] };
    for (let i = 0; i < n; i++) await addValidator(d, payer, v, `${label} ${i}`, { seed: i });
    const user = await d.funded(100n);
    const tokens = await d.tokenAccount(payer, p.mint, user.address);
    const stakes: Address[] = [];
    for (let i = 0; i < n; i++) stakes.push(await d.userStake(payer, user, TEST_STAKE, v.votes[i]!));
    d.nextEpoch();
    await updateAll(d, payer, p, `${label} 1`);
    for (let i = 0; i < n; i++) {
      await d.setup(payer, stakeAuthorizeBoth(stakes[i]!, user, p.deposit));
      await d.ok(`deposit stake (${label} ${i})`, payer, [
        ix.depositStake(p, { depositAuthority: p.deposit, stake: stakes[i]!, validatorStake: v.stakes[i]!, to: tokens, referrer: p.managerFee }),
      ]);
    }
    d.nextEpoch();
    await updateAll(d, payer, p, `${label} 2`);
    return { v, user, tokens };
  }
  /** The pool's lamports as the list counts them: every entry's lamports and the reserve's past its rent. */
  const listSum = (p: Pool) => d.validators(p).reduce((a, x) => a + x.active + x.transient, d.lamports(p.reserve) - RENT_200);
  const remove = async (v: V, i: number) => ix.removeValidator(v.p, v.p.staker, v.stakes[i]!, await transientOf(v, i, d.validators(v.p)[i]!.transientSeed));

  it("success_with_normal: validator rewards counted by the update", async () => {
    const { v } = await setup(5, "rewards");
    const before = listSum(v.p);
    expect(d.totals(v.p).lamports).toBe(before);
    // The epoch's rewards: each validator stake's delegation grows with its lamports, as the reward payout grows them.
    d.nextEpoch();
    for (const s of v.stakes) {
      const reward = d.stake(s)!.kind === "Stake" ? d.lamports(s) / 100n : 0n;
      d.patch(s, (b) => b.writeBigUInt64LE(b.readBigUInt64LE(STAKE_OFFSETS.stake) + reward, STAKE_OFFSETS.stake), { lamports: d.lamports(s) + reward });
    }
    await updateAll(d, payer, v.p, "rewards paid");
    expect(listSum(v.p)).toBeGreaterThan(before);
    expect(d.totals(v.p).lamports).toBe(listSum(v.p));
  });

  it("merge_transient_stake_after_remove: deactivating all, then merged into the reserve", async () => {
    const { v } = await setup(1, "merge after remove");
    await d.ok("decrease with reserve (merge after remove)", payer, [await decrease(d, v, 0, TEST_STAKE, U64_MAX, "Reserve")]);
    await d.ok("remove validator (merge after remove)", payer, [await remove(v, 0)]);
    d.nextEpoch();
    await updateAll(d, payer, v.p, "merge after remove, no merge", true);
    expect(d.validators(v.p)[0]).toMatchObject({ status: STATUS.DeactivatingAll, active: RENT_200 + MIN, transient: TEST_STAKE + RENT_200 });
    const reserve = d.lamports(v.p.reserve);
    await d.ok("update list (merge after remove)", payer, [ix.updateValidatorListBalance(v.p, 0, false, await updatePairs(d, v.p))]);
    expect(d.validators(v.p)[0]).toMatchObject({ status: STATUS.ReadyForRemoval, active: 0n, transient: 0n });
    expect(d.original.getAccount(v.stakes[0]!).exists || d.original.getAccount(await transientOf(v, 0, U64_MAX)).exists).toBe(false);
    expect(d.lamports(v.p.reserve)).toBe(reserve + TEST_STAKE + MIN + 2n * RENT_200);
    await d.ok("update pool (merge after remove)", payer, [ix.updateStakePoolBalance(v.p)]);
    await d.ok("cleanup (merge after remove)", payer, [ix.cleanupRemovedValidatorEntries(v.p)]);
    expect(d.validators(v.p)).toEqual([]);
  });

  it("success_with_burned_tokens: the supply follows the mint after tokens are burned", async () => {
    const { v, user, tokens } = await setup(1, "burned");
    await d.setup(payer, [token.getBurnInstruction({ account: tokens, mint: v.p.mint, authority: user, amount: d.tokenBalance(tokens) }) as Instruction]);
    const mintSupply = () => d.data(v.p.mint).readBigUInt64LE(36);
    expect(mintSupply()).not.toBe(d.totals(v.p).supply);
    d.nextEpoch();
    await updateAll(d, payer, v.p, "burned");
    expect(d.totals(v.p).supply).toBe(mintSupply());
  });

  it("fail_with_no_merge_during_reward_payout", async () => {
    const { v } = await setup(5, "reward payout");
    d.nextEpoch();
    const inactive = d.original.getEpochRewards();
    for (const vm of d.vms)
      vm.setEpochRewards(new EpochRewards(d.original.getClock().slot + 2n, 4n, inactive.parentBlockhash, 10n ** 20n, 5n * SOL, SOL, true));
    const pairs = await updatePairs(d, v.p);
    expect(await d.both("update list, no merge: rewards distributed", payer, [ix.updateValidatorListBalance(v.p, 0, true, pairs.slice(0, 4))])).toBe(
      custom(E.EpochRewardDistributionInProgress),
    );
    for (const vm of d.vms) vm.setEpochRewards(inactive);
    await updateAll(d, payer, v.p, "reward payout");
  });

  it("updates_validator_status_after_cluster_restart_merge: a validator stake reset to Initialized", async () => {
    const { v } = await setup(1, "cluster restart");
    const reserve = d.lamports(v.p.reserve);
    d.patch(v.stakes[0]!, (b) =>
      stakeBytes({ kind: "Initialized", rentReserve: rentReserveOf(d, v.p), staker: v.p.withdraw, withdrawer: v.p.withdraw }).copy(b),
    );
    await d.ok("update list: validator stake Initialized", payer, [ix.updateValidatorListBalance(v.p, 0, false, await updatePairs(d, v.p))]);
    expect(d.validators(v.p)[0]).toMatchObject({ status: STATUS.ReadyForRemoval, active: 0n });
    expect(d.lamports(v.p.reserve)).toBeGreaterThan(reserve);
  });

  it("ignores_unusable_stake_accounts_preventing_exploit: a validator stake of another authority and lockup", async () => {
    const { v } = await setup(1, "exploit");
    const total = d.totals(v.p).lamports;
    const attacker = await d.funded(1n);
    const held = d.lamports(v.stakes[0]!);
    const extra = SOL;
    d.patch(
      v.stakes[0]!,
      (b) =>
        stakeBytes({
          kind: "Stake",
          rentReserve: rentReserveOf(d, v.p),
          staker: attacker.address,
          withdrawer: attacker.address,
          custodian: attacker.address,
          lockupEpoch: 100n,
          voter: v.votes[0]!,
          stake: TEST_STAKE + extra,
          activation: 0n,
        }).copy(b),
      { lamports: held + extra },
    );
    await d.ok("update list: validator stake not the pool's", payer, [ix.updateValidatorListBalance(v.p, 0, false, await updatePairs(d, v.p))]);
    expect(d.validators(v.p)[0]).toMatchObject({ status: STATUS.Active, active: 0n });
    expect(d.lamports(v.stakes[0]!)).toBe(held + extra);
    expect(d.totals(v.p).lamports).toBe(total);
  });

  it("update_validator_list_balance_ingores_uninitialized_stake_account_balances", async () => {
    const { v } = await setup(1, "uninitialized stake");
    await d.ok("remove validator (uninitialized stake)", payer, [await remove(v, 0)]);
    d.nextEpoch();
    d.patch(v.stakes[0]!, (b) => stakeBytes({ kind: "Uninitialized" }).copy(b));
    await d.ok("update list: validator stake Uninitialized", payer, [ix.updateValidatorListBalance(v.p, 0, false, await updatePairs(d, v.p))]);
    expect(d.validators(v.p)[0]).toMatchObject({ status: STATUS.DeactivatingValidator, active: 0n });
    expect(d.lamports(v.stakes[0]!)).toBeGreaterThan(0n);
  });

  it("cleanup_does_not_remove_validators_with_remaining_lamports", async () => {
    const { v } = await setup(2, "remaining lamports");
    for (const i of [0, 1]) await d.ok(`remove validator (remaining lamports ${i})`, payer, [await remove(v, i)]);
    d.nextEpoch();
    await d.ok("update list (remaining lamports)", payer, [ix.updateValidatorListBalance(v.p, 0, false, await updatePairs(d, v.p))]);
    expect(d.validators(v.p).map((x) => x.status)).toEqual([STATUS.ReadyForRemoval, STATUS.ReadyForRemoval]);
    // The list rewritten (as with set_account): the first entry still counts lamports.
    d.patch(v.p.list, (b) => {
      b.writeBigUInt64LE(1_000_000n, 9);
      b.writeBigUInt64LE(0n, 9 + 8);
    });
    await d.ok("cleanup: an entry with lamports left", payer, [ix.cleanupRemovedValidatorEntries(v.p)]);
    expect(d.validators(v.p)).toHaveLength(1);
    expect(d.validators(v.p)[0]).toMatchObject({ status: STATUS.ReadyForRemoval, active: 1_000_000n });
  });

  it("fail_with_uninitialized_validator_list (both files; an empty body upstream, done from its name): a list of zeros", async () => {
    const p = await upstreamPool(d, payer, "update zeros");
    d.nextEpoch();
    d.patch(p.list, (b) => b.fill(0));
    expect(await d.both("update list: list of zeros", payer, [ix.updateValidatorListBalance(p, 0, false, [])])).toBe(custom(E.InvalidState));
    expect(await d.both("update pool: list of zeros", payer, [ix.updateStakePoolBalance(p)])).toBe(custom(E.InvalidState));
  });

  it("update_stake_pool_balance::fail_with_wrong_reserve", async () => {
    const p = await upstreamPool(d, payer, "update pool reserve");
    expect(await d.both("update pool: wrong reserve", payer, [replace(ix.updateStakePoolBalance(p), 3, nowhere())])).toBe(custom(E.InvalidProgramAddress));
  });
});

// ---- force_destake.rs ------------------------------------------------------------------------------------------------

describe("force_destake.rs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });
  /**
   * Upstream's setup: a pool whose list holds one validator (validator seed 42) whose stake account was reset by the
   * cluster (`forced`), written into the accounts as add_account writes them; the pool counts its lamports.
   */
  async function setup(label: string, forced: (p: Pool, vote: Address) => Buffer) {
    const p = await upstreamPool(d, payer, label, { reserveLamports: TEST_STAKE });
    const vote = await d.vote(payer);
    const stake = await validatorStake(vote, p.pool, 42);
    d.write(stake, STAKE, forced(p, vote), TEST_STAKE + RENT_200);
    const active = TEST_STAKE - 1_000_000n;
    const epoch = d.data(p.pool).readBigUInt64LE(274);
    d.patch(p.list, (b) => {
      b.writeUInt32LE(1, 5);
      entryBytes({ vote, active, epoch, seed: 42 }).copy(b, 9);
    });
    addToPool(d, p, active);
    const v: V = { p, votes: [vote], stakes: [stake] };
    return v;
  }
  const meta = (p: Pool) => ({ rentReserve: rentReserveOf(d, p), staker: p.withdraw, withdrawer: p.withdraw });

  it("success_update: an Initialized validator stake merged into the reserve", async () => {
    const v = await setup("force destake update", (p) => stakeBytes({ kind: "Initialized", ...meta(p) }));
    d.nextEpoch();
    const reserve = d.lamports(v.p.reserve);
    const stake = d.lamports(v.stakes[0]!);
    await updateAll(d, payer, v.p, "force destake update");
    expect(d.lamports(v.p.reserve)).toBe(reserve + stake);
    expect(d.original.getAccount(v.stakes[0]!).exists).toBe(false);
  });

  it("fail_increase: no increase into an Initialized validator stake", async () => {
    const v = await setup("force destake increase", (p) => stakeBytes({ kind: "Initialized", ...meta(p) }));
    expect(await d.both("increase: validator stake Initialized", payer, [await increase(v, 0, MIN, 0n, false)])).toBe(custom(E.WrongStakeStake));
  });

  it("success_remove_validator: a validator stake deactivated at epoch 0 removed and merged", async () => {
    const v = await setup("force destake remove", (p, vote) =>
      stakeBytes({ kind: "Stake", ...meta(p), voter: vote, stake: TEST_STAKE, activation: 0n, deactivation: 0n, credits: 1n }),
    );
    d.nextEpoch();
    // Upstream ignores this update's outcome; here both must still agree on it.
    const pairs = await updatePairs(d, v.p);
    await d.both("update list (force destake remove 1)", payer, [ix.updateValidatorListBalance(v.p, 0, false, pairs)]);
    await d.both("update pool (force destake remove 1)", payer, [ix.updateStakePoolBalance(v.p)]);
    await d.both("cleanup (force destake remove 1)", payer, [ix.cleanupRemovedValidatorEntries(v.p)]);
    await d.ok("remove validator: deactivated by the cluster", payer, [ix.removeValidator(v.p, v.p.staker, v.stakes[0]!, await transientOf(v, 0, 0n))]);
    await updateAll(d, payer, v.p, "force destake remove 2");
    expect(d.validators(v.p)).toEqual([]);
    expect(d.original.getAccount(v.stakes[0]!).exists).toBe(false);
  });
});

// ---- huge_pool.rs ----------------------------------------------------------------------------------------------------

/** The compute units of the huge-pool cases (original, port), for their own table. */
const hugeUnits: Record<string, [bigint, bigint]> = {};

describe("huge_pool.rs", () => {
  /** MAX_POOL_SIZE_WITH_REQUESTED_COMPUTE_UNITS (every transaction asks for 1,400,000 CU) and MAX_POOL_SIZE (none). */
  const MAX_WITH_BUDGET = 20_000;
  const MAX = 3_000;
  const STAKE_AMOUNT = 200n * SOL;

  /**
   * Upstream's setup(max, num, stake): a pool whose list holds `num` validators (of `max`), each Active with `stake`
   * delegated and its rent, written as add_account writes them (here into an initialized pool: the list's entries,
   * the pool's lamports and supply, the mint's supply and the manager's tokens). Upstream also writes every validator
   * stake account and vote account; only the ones an instruction here names are written (no instruction reads the
   * others). Their stake activates in this epoch, as upstream's do (activation epoch = the current epoch). A user's
   * stake account delegated to the last validator, in this epoch too.
   */
  async function setup(max: number, num: number, stakeAmount: bigint, touched: number[], status: number = STATUS.Active, budgeted = max > MAX) {
    const d = await diff();
    const payer = await d.funded(100_000n);
    const p = await upstreamPool(d, payer, `huge ${max}`, { maxValidators: max, reserveLamports: stakeAmount });
    const epoch = d.data(p.pool).readBigUInt64LE(274);
    const lastVote = await d.vote(payer);
    const votes = Array.from({ length: max }, (_, i) => (i === max - 1 ? lastVote : nowhere()));
    const lamportsEach = stakeAmount + RENT_200;
    d.patch(p.list, (b) => {
      b.writeUInt32LE(num, 5);
      for (let i = 0; i < num; i++) entryBytes({ vote: votes[i]!, active: lamportsEach, epoch, status }).copy(b, 9 + 73 * i);
    });
    const stakes = new Map<number, Address>();
    for (const i of touched) {
      if (i >= num) continue;
      const at = await validatorStake(votes[i]!, p.pool);
      const bytes = stakeBytes({
        kind: "Stake",
        rentReserve: rentReserveOf(d, p),
        staker: p.withdraw,
        withdrawer: p.withdraw,
        voter: votes[i]!,
        stake: stakeAmount,
        activation: epoch,
      });
      d.write(at, STAKE, bytes, lamportsEach);
      stakes.set(i, at);
    }
    addToPool(d, p, BigInt(num) * lamportsEach);
    const user = await d.funded(1_000n);
    const userStake = await d.userStake(payer, user, stakeAmount, lastVote);
    const tokens = await d.tokenAccount(payer, p.mint, user.address);
    const budget = budgeted ? [computeUnitLimit(1_400_000)] : [];
    /** both() with the compute-budget instruction when the pool is past MAX_POOL_SIZE, its units noted. */
    const run = async (label: string, i: Instruction, watch: Address[] = []) => {
      const got = await d.both(label, payer, [i, ...budget], watch);
      expect(got, `${label}\n${d.lastLogs}`).toBe("ok");
      hugeUnits[label] = d.cu[label]!;
    };
    const pair = async (i: number): Promise<[Address, Address]> => [
      stakes.get(i) ?? (await validatorStake(votes[i]!, p.pool)),
      await transientStake(votes[i]!, p.pool, 0n),
    ];
    return { d, payer, p, votes, stakes, user, userStake, tokens, run, pair, last: max - 1 };
  }
  type Huge = Awaited<ReturnType<typeof setup>>;
  const depositLast = async (h: Huge, size: number) => {
    await h.d.setup(h.payer, stakeAuthorizeBoth(h.userStake, h.user, h.p.deposit));
    await h.run(
      `huge ${size}: deposit stake`,
      ix.depositStake(h.p, {
        depositAuthority: h.p.deposit,
        stake: h.userStake,
        validatorStake: h.stakes.get(h.last)!,
        to: h.tokens,
        referrer: h.p.managerFee,
      }),
    );
  };

  for (const max of [MAX_WITH_BUDGET, MAX]) {
    it(`update [${max}]: four validators, the pool and the cleanup`, async () => {
      const h = await setup(max, max, STAKE_AMOUNT, [0, 1, 2, 3]);
      await h.run(`huge ${max}: update list (4)`, ix.updateValidatorListBalance(h.p, 0, false, await Promise.all([0, 1, 2, 3].map(h.pair))));
      await h.run(`huge ${max}: update pool`, ix.updateStakePoolBalance(h.p));
      await h.run(`huge ${max}: cleanup`, ix.cleanupRemovedValidatorEntries(h.p));
    });

    it(`deposit_stake [${max}]: into the last validator`, async () => {
      const h = await setup(max, max, STAKE_AMOUNT, [max - 1]);
      await depositLast(h, max);
    });

    it(`withdraw [${max}]: from the last validator`, async () => {
      const h = await setup(max, max, STAKE_AMOUNT, [max - 1]);
      await depositLast(h, max);
      const receive = await blank(h.d, h.payer);
      await h.run(
        `huge ${max}: withdraw stake`,
        ix.withdrawStake(h.p, { split: h.stakes.get(h.last)!, receive, newAuthority: h.user.address, transferAuthority: h.user, from: h.tokens }, TEST_STAKE),
      );
    });
  }

  // Regression: past MAX_POOL_SIZE, with no compute-unit request, the port's withdrawal once ran out of compute where
  // the original's did not (its search for validators with stake to give went through the whole list in one pass that
  // only stopped once it had found active and transient stake both; the original's two searches each stop at the
  // first). At 3,550 validators the original needs about 191,000 of the default 200,000 units, the port then needed
  // more. Run with the 1,400,000 units, so that neither depends on how many units the bump searches of new keys take,
  // and the port's must fit the default.
  it("withdraw [3550]: from the last validator, within the default compute budget", async () => {
    const h = await setup(3_550, 3_550, STAKE_AMOUNT, [3_549], STATUS.Active, true);
    await depositLast(h, 3_550);
    const receive = await blank(h.d, h.payer);
    const label = "huge 3550: withdraw stake";
    await h.run(
      label,
      ix.withdrawStake(h.p, { split: h.stakes.get(h.last)!, receive, newAuthority: h.user.address, transferAuthority: h.user, from: h.tokens }, TEST_STAKE),
    );
    expect(hugeUnits[label]![1]).toBeLessThan(200_000n);
  });

  // Regression: past MAX_POOL_SIZE, with no compute-unit request (the default 200,000 units), the two instructions
  // that go through the whole list fit the original up to about 7,100 validators (UpdateStakePoolBalance) and 20,000
  // (the cleanup). The port's BigVec loops once cost more an entry than the original's (31 and 11 units, against 27 and
  // 9), so it ran out of compute where the original did not, from about 6,400 and 18,100 validators. Both must succeed.
  it("update pool [6800]: within the default compute budget, as the original", async () => {
    const h = await setup(6_800, 6_800, STAKE_AMOUNT, [], STATUS.Active, false);
    await h.run("huge 6800: update pool (no CU request)", ix.updateStakePoolBalance(h.p));
  });

  it("cleanup [19000]: within the default compute budget, as the original", async () => {
    const h = await setup(19_000, 19_000, STAKE_AMOUNT, [], STATUS.Active, false);
    await h.run("huge 19000: cleanup (no CU request)", ix.cleanupRemovedValidatorEntries(h.p));
  });

  it(`remove_validator_from_pool [${MAX}]: the first, the middle and the last, merged and cleaned up`, async () => {
    const middle = MAX / 2;
    const h = await setup(MAX, MAX, SOL, [0, middle, MAX - 1]);
    for (const [i, name] of [
      [0, "first"],
      [middle, "middle"],
      [MAX - 1, "last"],
    ] as const)
      await h.run(
        `huge ${MAX}: remove validator (${name})`,
        ix.removeValidator(h.p, h.p.staker, h.stakes.get(i)!, await transientStake(h.votes[i]!, h.p.pool, U64_MAX)),
      );
    for (const i of [0, middle, MAX - 1])
      expect(h.d.validators(h.p)[i]).toMatchObject({ status: STATUS.DeactivatingValidator, active: SOL + RENT_200, transient: 0n });
    for (const [i, name] of [
      [0, "first"],
      [middle, "middle"],
      [MAX - 1, "last"],
    ] as const)
      await h.run(`huge ${MAX}: update list (${name})`, ix.updateValidatorListBalance(h.p, i, false, [await h.pair(i)]));
    await h.run(`huge ${MAX}: cleanup (3 removed)`, ix.cleanupRemovedValidatorEntries(h.p));
    const left = h.d.validators(h.p).map((x) => x.vote);
    expect(left).toHaveLength(MAX - 3);
    for (const i of [0, middle, MAX - 1]) expect(left).not.toContain(h.votes[i]);
    for (const i of [1, middle - 1, middle + 1, MAX - 2]) expect(left).toContain(h.votes[i]);
  });

  it(`add_validator_to_pool [${MAX}]: into the last free entry, then an increase`, async () => {
    const h = await setup(MAX, MAX - 1, STAKE_AMOUNT, []);
    const stake = await validatorStake(h.votes[h.last]!, h.p.pool);
    await h.run(`huge ${MAX}: add validator (last)`, ix.addValidator(h.p, h.p.staker, stake, h.votes[h.last]!));
    expect(h.d.validators(h.p)).toHaveLength(MAX);
    expect(h.d.validators(h.p)[h.last]).toMatchObject({ status: STATUS.Active, active: MIN + RENT_200, transient: 0n, vote: h.votes[h.last] });
    const transient = await transientStake(h.votes[h.last]!, h.p.pool, U64_MAX);
    await h.run(`huge ${MAX}: increase (last)`, ix.increaseValidatorStake(h.p, h.p.staker, transient, stake, h.votes[h.last]!, SOL, U64_MAX));
    expect(h.d.validators(h.p)[h.last]).toMatchObject({ active: MIN + RENT_200, transient: SOL + RENT_200 });
  });

  it(`set_preferred [${MAX}]: the last validator, for deposits and withdrawals`, async () => {
    const h = await setup(MAX, MAX, STAKE_AMOUNT, []);
    await h.run(`huge ${MAX}: set preferred deposit (last)`, ix.setPreferredValidator(h.p, h.p.staker, "Deposit", h.votes[h.last]!));
    await h.run(`huge ${MAX}: set preferred withdraw (last)`, ix.setPreferredValidator(h.p, h.p.staker, "Withdraw", h.votes[h.last]!));
    expect(poolState(h.d.data(h.p.pool))).toMatchObject({ preferredDeposit: h.votes[h.last], preferredWithdraw: h.votes[h.last] });
  });

  it(`cleanup_all [${MAX}]: every entry ReadyForRemoval`, async () => {
    const h = await setup(MAX, MAX, STAKE_AMOUNT, [], STATUS.ReadyForRemoval);
    await h.run(`huge ${MAX}: cleanup (all)`, ix.cleanupRemovedValidatorEntries(h.p));
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
    const row = (name: string, [a, b]: [bigint, bigint]) =>
      console.log(`${name.padEnd(44)} original ${String(a).padStart(9)}  TypeSOL ${String(b).padStart(9)}  ${((Number(b) / Number(a)) * 100).toFixed(0)}%`);
    for (const [name, units] of Object.entries(hugeUnits)) row(name, units);
    console.log(`${compared} transactions compared`);
    expect(compared).toBeGreaterThan(300);
  });
});
