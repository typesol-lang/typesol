// showcase/mainnet/spl-stake-pool against SPL Stake Pool as deployed on mainnet (test/programs/spl_stake_pool.so).
// The harness (spl-stake-pool-helpers.ts) runs both in their own LiteSVM under the same program id, with the same
// Clock and StakeHistory (a StakeCluster); every transaction must have the same outcome, the same log lines and the
// same bytes in every account it names. The outcomes are also checked, so that each error path is really reached.
//
// Part A: Initialize, AddValidatorToPool, RemoveValidatorFromPool, SetPreferredValidator, UpdateValidatorListBalance,
// UpdateStakePoolBalance, CleanupRemovedValidatorEntries, SetManager, SetFee, SetStaker, SetFundingAuthority,
// DepositSol, WithdrawSol (and the slippage forms), Redelegate, and the instruction decoding of every tag.
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner, lamports } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CLOCK,
  Diff,
  type Pool,
  RENT,
  SOL,
  STAKE,
  STAKE_ACCOUNT_SIZE,
  STAKE_HISTORY,
  STAKE_OFFSETS,
  STAKE_POOL_SIZE,
  SYSTEM,
  TOKEN,
  TOKEN_2022,
  PROGRAM,
  builtin,
  custom,
  fee,
  ix,
  key,
  mintBytes,
  tlv,
  tokenAccountBytes,
  transientStake,
  u8,
  u32,
  updatePairs,
  validatorStake,
  withdrawAuthority,
} from "./spl-stake-pool-helpers.js";
import { stakeHistoryEntry } from "../../src/testing-stake.js";

/** StakePoolError codes. */
const E = {
  AlreadyInUse: 0,
  InvalidProgramAddress: 1,
  InvalidState: 2,
  CalculationFailure: 3,
  FeeTooHigh: 4,
  WrongManager: 6,
  SignatureMissing: 7,
  InvalidValidatorStakeList: 8,
  InvalidFeeAccount: 9,
  WrongPoolMint: 10,
  WrongStakeStake: 11,
  ValidatorAlreadyAdded: 13,
  ValidatorNotFound: 14,
  InvalidStakeAccountAddress: 15,
  StakeListOutOfDate: 16,
  StakeListAndPoolOutOfDate: 17,
  WrongMintingAuthority: 19,
  UnexpectedValidatorListAccountSize: 20,
  WrongStaker: 21,
  NonZeroPoolTokenSupply: 22,
  InvalidMintFreezeAuthority: 26,
  FeeIncreaseTooHigh: 27,
  WithdrawalTooSmall: 28,
  DepositTooSmall: 29,
  InvalidSolDepositAuthority: 31,
  InvalidPreferredValidator: 32,
  InvalidSolWithdrawAuthority: 34,
  SolWithdrawalTooLarge: 35,
  UnsupportedMintExtension: 37,
  UnsupportedFeeAccountExtension: 38,
  ExceededSlippage: 39,
  IncorrectMintDecimals: 40,
  TooManyValidatorsInPool: 44,
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

describe("instruction decoding", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let p: Pool;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(10_000n);
    p = await d.createPool(payer, { reserveLamports: 5n * SOL, label: "initialize (decoding)" });
  });

  it("refuses data that is not exactly a StakePoolInstruction, before logging anything", async () => {
    const pool = [{ address: p.pool, role: AccountRole.WRITABLE }] as Instruction["accounts"];
    const bad: [string, Buffer][] = [
      ["no data", Buffer.alloc(0)],
      ["unknown tag 27", u8(27)],
      ["unknown tag 255", u8(255)],
      ["Initialize short", Buffer.concat([u8(0), Buffer.alloc(52)])],
      ["Initialize long", Buffer.concat([u8(0), Buffer.alloc(54)])],
      ["AddValidatorToPool short", Buffer.concat([u8(1), Buffer.alloc(3)])],
      ["RemoveValidatorFromPool trailing", Buffer.concat([u8(2), u8(0)])],
      ["SetPreferredValidator bad type", Buffer.concat([u8(5), u8(2), u8(0)])],
      ["SetPreferredValidator bad option", Buffer.concat([u8(5), u8(0), u8(2)])],
      ["SetPreferredValidator some short", Buffer.concat([u8(5), u8(0), u8(1), Buffer.alloc(31)])],
      ["SetPreferredValidator none long", Buffer.concat([u8(5), u8(0), u8(0), u8(0)])],
      ["UpdateValidatorListBalance bad bool", Buffer.concat([u8(6), u32(0), u8(2)])],
      ["UpdateValidatorListBalance short", Buffer.concat([u8(6), u32(0)])],
      ["UpdateStakePoolBalance trailing", Buffer.concat([u8(7), u8(1)])],
      ["Cleanup trailing", Buffer.concat([u8(8), u8(1)])],
      ["SetManager trailing", Buffer.concat([u8(11), u8(0)])],
      ["SetFee bad fee type", Buffer.concat([u8(12), u8(7), u8(0)])],
      ["SetFee referral long", Buffer.concat([u8(12), u8(0), u8(5), u8(0)])],
      ["SetFee fee short", Buffer.concat([u8(12), u8(2), Buffer.alloc(15)])],
      ["SetFee no type", u8(12)],
      ["SetStaker trailing", Buffer.concat([u8(13), u8(0)])],
      ["DepositSol short", Buffer.concat([u8(14), Buffer.alloc(7)])],
      ["SetFundingAuthority bad type", Buffer.concat([u8(15), u8(3)])],
      ["WithdrawSol long", Buffer.concat([u8(16), Buffer.alloc(9)])],
      ["Redelegate short", Buffer.concat([u8(22), Buffer.alloc(31)])],
      ["DepositSolWithSlippage short", Buffer.concat([u8(25), Buffer.alloc(8)])],
      ["WithdrawSolWithSlippage long", Buffer.concat([u8(26), Buffer.alloc(17)])],
    ];
    for (const [label, data] of bad) expect(await d.both(`decode: ${label}`, payer, [ix.raw(data, pool as never)]), label).toBe(builtin("BorshIoError"));
  });

  it("refuses Redelegate after decoding it", async () => {
    const k = p.pool;
    const r = ix.redelegate(p, p.staker, { sourceStake: k, sourceTransient: k, ephemeral: k, destinationTransient: k, destinationStake: k, vote: k }, SOL, [
      1n,
      2n,
      3n,
    ]);
    expect(await d.both("redelegate", payer, [r])).toBe(builtin("InvalidInstructionData"));
  });

  it("counts accounts where the original takes them", async () => {
    const fresh = await d.poolAccounts(payer);
    const init = ix.initialize(
      { ...fresh, manager: fresh.manager, staker: fresh.staker.address },
      { epoch: fee(0n, 0n), withdrawal: fee(0n, 0n), deposit: fee(0n, 0n), referral: 0, maxValidators: fresh.maxValidators },
    );
    expect(await d.both("initialize 8 accounts", payer, [truncate(init, 8)])).toBe(builtin("NotEnoughAccountKeys"));
    const user = await d.funded(10n);
    const cases: [string, Instruction, number][] = [
      ["set manager", ix.setManager(p, p.manager, p.manager, p.managerFee), 3],
      ["set fee", ix.setFee(p, p.manager, { kind: "SolReferral", percent: 1 }), 1],
      ["set staker", ix.setStaker(p, p.manager, p.manager.address), 2],
      ["set funding authority", ix.setFundingAuthority(p, p.manager, "SolDeposit", null), 1],
      ["set preferred", ix.setPreferredValidator(p, p.staker, "Deposit", null), 2],
      ["update pool", ix.updateStakePoolBalance(p), 6],
      ["cleanup", ix.cleanupRemovedValidatorEntries(p), 1],
      ["deposit sol", ix.depositSol(p, { from: user, to: p.managerFee, referrer: p.managerFee }, SOL), 9],
      ["withdraw sol", ix.withdrawSol(p, { transferAuthority: p.manager, from: p.managerFee, to: user.address }, SOL), 11],
      ["remove validator", ix.removeValidator(p, p.staker, p.reserve, p.reserve), 7],
    ];
    for (const [label, i, n] of cases) expect(await d.both(`${label}: ${n} accounts`, payer, [truncate(i, n)]), label).toBe(builtin("NotEnoughAccountKeys"));
    // Accounts taken between sysvar reads: the sysvar is checked before the next account is counted.
    const add = ix.addValidator(p, p.staker, p.reserve, p.reserve);
    expect(await d.both("add validator: 7 accounts", payer, [truncate(add, 7)])).toBe(builtin("NotEnoughAccountKeys"));
    expect(await d.both("add validator: 8 accounts, wrong rent", payer, [truncate(replace(add, 7, CLOCK), 8)])).toBe(builtin("InvalidArgument"));
    expect(await d.both("add validator: 8 accounts", payer, [truncate(add, 8)])).toBe(builtin("NotEnoughAccountKeys"));
    expect(await d.both("add validator: 9 accounts, wrong clock", payer, [truncate(replace(add, 8, RENT), 9)])).toBe(builtin("InvalidArgument"));
    expect(await d.both("add validator: 12 accounts", payer, [truncate(add, 12)])).toBe(builtin("NotEnoughAccountKeys"));
    const update = ix.updateValidatorListBalance(p, 0, false, []);
    expect(await d.both("update list: 4 accounts", payer, [truncate(update, 4)])).toBe(builtin("NotEnoughAccountKeys"));
    expect(await d.both("update list: 5 accounts, wrong clock", payer, [truncate(replace(update, 4, RENT), 5)])).toBe(builtin("InvalidArgument"));
    expect(await d.both("update list: 6 accounts", payer, [truncate(update, 6)])).toBe(builtin("NotEnoughAccountKeys"));
    const remove = ix.removeValidator(p, p.staker, p.reserve, p.reserve);
    expect(await d.both("remove validator: wrong clock", payer, [truncate(replace(remove, 6, RENT), 7)])).toBe(builtin("InvalidArgument"));
  });

  it("checks the pool account's owner and type", async () => {
    // Not the program's: IncorrectProgramId with the owner line. The program's but never initialized: InvalidState.
    const foreign = await d.allocated(payer, STAKE_POOL_SIZE, SYSTEM);
    const blank = await d.allocated(payer, STAKE_POOL_SIZE, PROGRAM);
    const short = await d.allocated(payer, 100n, PROGRAM);
    for (const [label, at, want] of [
      ["foreign", foreign, builtin("IncorrectProgramId")],
      ["uninitialized", blank, custom(E.InvalidState)],
      ["too short", short, builtin("BorshIoError")],
    ] as const) {
      const q = { ...p, pool: at };
      expect(await d.both(`set fee: ${label} pool`, payer, [ix.setFee(q, p.manager, { kind: "SolReferral", percent: 1 })])).toBe(want);
      expect(await d.both(`set staker: ${label} pool`, payer, [ix.setStaker(q, p.manager, p.staker.address)])).toBe(want);
      expect(await d.both(`set funding: ${label} pool`, payer, [ix.setFundingAuthority(q, p.manager, "SolWithdraw", null)])).toBe(want);
      expect(await d.both(`cleanup: ${label} pool`, payer, [ix.cleanupRemovedValidatorEntries(q)])).toBe(want);
      expect(await d.both(`update pool: ${label} pool`, payer, [ix.updateStakePoolBalance(q)])).toBe(want);
    }
  });
});

describe("Initialize", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });
  const fees = (
    maxValidators: number,
    o: Partial<{ epoch: ReturnType<typeof fee>; withdrawal: ReturnType<typeof fee>; deposit: ReturnType<typeof fee>; referral: number }> = {},
  ) => ({
    epoch: o.epoch ?? fee(5n, 100n),
    withdrawal: o.withdrawal ?? fee(3n, 1000n),
    deposit: o.deposit ?? fee(2n, 1000n),
    referral: o.referral ?? 25,
    maxValidators,
  });
  const init = (q: Pool, o: Parameters<typeof fees>[1] = {}, max = q.maxValidators, depositAuthority?: Address | KeyPairSigner) =>
    ix.initialize({ ...q, manager: q.manager, staker: q.staker.address }, fees(max, o), depositAuthority);

  it("makes pools with SPL Token and Token-2022 mints, with and without a deposit authority", async () => {
    const a = await d.poolAccounts(payer, { reserveLamports: 7n * SOL });
    await d.ok("initialize", payer, [init(a)]);
    expect(d.tokenBalance(a.managerFee)).toBe(7n * SOL);
    const b = await d.poolAccounts(payer, { reserveLamports: 0n, maxValidators: 3 });
    const depositor = await d.funded(1n);
    await d.ok("initialize with deposit authority, empty reserve", payer, [init(b, {}, 3, depositor)]);
    const c = await d.poolAccounts(payer, { reserveLamports: 2n * SOL, tokenProgram: TOKEN_2022 });
    await d.ok("initialize token-2022", payer, [init(c)]);
    // TransferFeeConfig and MetadataPointer are among the extensions a pool mint may have.
    const withFee = await d.poolAccounts(payer, {
      reserveLamports: SOL,
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
    await d.ok("initialize token-2022 transfer fee", payer, [init(withFee)]);
    // A close authority would let the mint be closed under the pool: refused.
    const closable = await d.poolAccounts(payer, {
      tokenProgram: TOKEN_2022,
      mintExtensions: [{ __kind: "MintCloseAuthority", closeAuthority: payer.address }],
      mintInit: (m) => [t22.getInitializeMintCloseAuthorityInstruction({ mint: m, closeAuthority: payer.address }) as Instruction],
    });
    expect(await d.both("initialize: token-2022 mint close authority", payer, [init(closable)])).toBe(custom(E.UnsupportedMintExtension));
  });

  it("refuses every bad account and argument, in the original's order", async () => {
    const q = await d.poolAccounts(payer, { reserveLamports: SOL, maxValidators: 5 });
    const run = (label: string, i: Instruction) => d.both(`initialize: ${label}`, payer, [i]);
    expect(
      await run(
        "manager not signing",
        accounts(init(q), (l) => (l[1] = { address: q.manager.address, role: AccountRole.READONLY })),
      ),
    ).toBe(custom(E.SignatureMissing));
    expect(await run("pool is the list", replace(init(q), 4, q.pool))).toBe(custom(E.AlreadyInUse));
    const foreign = await d.allocated(payer, STAKE_POOL_SIZE, SYSTEM);
    expect(await run("pool not the program's", replace(init(q), 0, foreign))).toBe(builtin("IncorrectProgramId"));
    const listForeign = await d.allocated(payer, 9n + 73n * 5n, SYSTEM);
    expect(await run("list not the program's", replace(init(q), 4, listForeign))).toBe(builtin("IncorrectProgramId"));
    // A list whose stored length runs past its data does not decode (Borsh); one of another type is in use.
    const listBad = await d.allocated(payer, 9n + 73n * 5n, PROGRAM);
    d.patch(listBad, (b) => b.writeUInt32LE(6, 5));
    expect(await run("list length past its data", replace(init(q), 4, listBad))).toBe(builtin("BorshIoError"));
    d.patch(listBad, (b) => {
      b.writeUInt32LE(0, 5);
      b[0] = 3;
    });
    expect(await run("list type byte 3", replace(init(q), 4, listBad))).toBe(builtin("BorshIoError"));
    d.patch(listBad, (b) => (b[0] = 2));
    expect(await run("list in use", replace(init(q), 4, listBad))).toBe(custom(E.AlreadyInUse));
    expect(await run("max validators mismatch", init(q, {}, 4))).toBe(custom(E.UnexpectedValidatorListAccountSize));
    const tiny = await d.allocated(payer, 9n, PROGRAM);
    expect(await run("max validators 0", replace(init(q, {}, 0), 4, tiny))).toBe(custom(E.UnexpectedValidatorListAccountSize));
    const huge = (await generateKeyPairSigner()).address;
    d.write(huge, PROGRAM, Buffer.alloc(9 + 73 * 20_001));
    expect(await run("over 20000 validators", replace(init(q, {}, 20_001), 4, huge))).toBe(custom(E.TooManyValidatorsInPool));
    const poorPool = (await generateKeyPairSigner()).address;
    d.write(poorPool, PROGRAM, Buffer.alloc(Number(STAKE_POOL_SIZE)), 1_000_000n);
    expect(await run("pool not rent-exempt", replace(init(q), 0, poorPool))).toBe(builtin("AccountNotRentExempt"));
    const poorList = (await generateKeyPairSigner()).address;
    d.write(poorList, PROGRAM, Buffer.alloc(9 + 73 * 5), 1_000_000n);
    expect(await run("list not rent-exempt", replace(init(q), 4, poorList))).toBe(builtin("AccountNotRentExempt"));
    expect(await run("epoch fee over 1", init(q, { epoch: fee(2n, 1n) }))).toBe(custom(E.FeeTooHigh));
    expect(await run("withdrawal fee over 1", init(q, { withdrawal: fee(11n, 10n) }))).toBe(custom(E.FeeTooHigh));
    expect(await run("deposit fee over 1", init(q, { deposit: fee(1n, 0n) }))).toBe(custom(E.FeeTooHigh));
    expect(await run("referral over 100", init(q, { referral: 101 }))).toBe(custom(E.FeeTooHigh));
    expect(await run("not a token program", replace(init(q), 8, SYSTEM))).toBe(builtin("IncorrectProgramId"));
    expect(await run("mint of another token program", replace(init(q), 8, TOKEN_2022))).toBe(builtin("IncorrectProgramId"));
    expect(await run("wrong withdraw authority", replace(init(q), 3, q.manager.address))).toBe(custom(E.InvalidProgramAddress));
    // Pool mints: written as the token program lays them out.
    const mintAt = async (bytes: Buffer, owner: Address = TOKEN) => {
      const m = (await generateKeyPairSigner()).address;
      d.write(m, owner, bytes);
      return m;
    };
    const w = q.withdraw;
    const mintCases: [string, Buffer, string, Address?][] = [
      ["mint uninitialized", mintBytes({ authority: w, initialized: 0 }), builtin("UninitializedAccount")],
      ["mint bad bool", mintBytes({ authority: w, initialized: 2 }), builtin("InvalidAccountData")],
      ["mint short", mintBytes({ authority: w }).subarray(0, 81), builtin("InvalidAccountData")],
      ["mint of a multisig's length", Buffer.alloc(355), builtin("InvalidAccountData")],
      ["mint with supply", mintBytes({ authority: w, supply: 1n }), custom(E.NonZeroPoolTokenSupply)],
      ["mint with 6 decimals", mintBytes({ authority: w, decimals: 6 }), custom(E.IncorrectMintDecimals)],
      ["mint of another authority", mintBytes({ authority: q.manager.address }), custom(E.WrongMintingAuthority)],
      ["mint without authority", mintBytes({ authority: null }), custom(E.WrongMintingAuthority)],
      ["mint with freeze authority", mintBytes({ authority: w, freeze: w }), custom(E.InvalidMintFreezeAuthority)],
      ["mint close authority", mintBytes({ authority: w, tlv: tlv(3, Buffer.alloc(32)) }), custom(E.UnsupportedMintExtension), TOKEN_2022],
      [
        "mint permanent delegate",
        mintBytes({ authority: w, tlv: Buffer.concat([tlv(18, Buffer.alloc(64)), tlv(12, Buffer.alloc(32))]) }),
        custom(E.UnsupportedMintExtension),
        TOKEN_2022,
      ],
      ["mint permissioned burn (28)", mintBytes({ authority: w, tlv: tlv(28, Buffer.alloc(33)) }), custom(E.UnsupportedMintExtension), TOKEN_2022],
      ["mint unknown extension (29)", mintBytes({ authority: w, tlv: tlv(29, Buffer.alloc(4)) }), builtin("InvalidAccountData"), TOKEN_2022],
      ["mint extension cut short", mintBytes({ authority: w, tlv: tlv(1, Buffer.alloc(108)).subarray(0, 50) }), builtin("InvalidAccountData"), TOKEN_2022],
      [
        "mint bad padding",
        (() => {
          const b = mintBytes({ authority: w, tlv: tlv(18, Buffer.alloc(64)) });
          b[100] = 1;
          return b;
        })(),
        builtin("InvalidAccountData"),
        TOKEN_2022,
      ],
      [
        "mint account-type byte of an account",
        (() => {
          const b = mintBytes({ authority: w, tlv: tlv(18, Buffer.alloc(64)) });
          b[165] = 2;
          return b;
        })(),
        builtin("InvalidAccountData"),
        TOKEN_2022,
      ],
      [
        "mint metadata pointer then unsupported",
        mintBytes({ authority: w, tlv: Buffer.concat([tlv(18, Buffer.alloc(64)), tlv(14, Buffer.alloc(64))]) }),
        custom(E.UnsupportedMintExtension),
        TOKEN_2022,
      ],
    ];
    for (const [label, bytes, want, owner] of mintCases) {
      const m = await mintAt(bytes, owner ?? TOKEN);
      const i = accounts(init(q), (l) => {
        l[6] = { address: m, role: AccountRole.WRITABLE };
        if (owner) l[8] = { address: owner, role: AccountRole.READONLY };
      });
      expect(await run(label, i), label).toBe(want);
    }
    // The manager's fee account: a token account of the pool mint, initialized, with only allowed extensions.
    const feeAt = async (bytes: Buffer, owner: Address = TOKEN) => {
      const a = (await generateKeyPairSigner()).address;
      d.write(a, owner, bytes);
      return a;
    };
    const feeCases: [string, Buffer, string][] = [
      ["fee account of another mint", tokenAccountBytes({ mint: q.manager.address, owner: q.manager.address }), custom(E.InvalidFeeAccount)],
      ["fee account frozen", tokenAccountBytes({ mint: q.mint, owner: q.manager.address, state: 2 }), custom(E.InvalidFeeAccount)],
      ["fee account uninitialized", tokenAccountBytes({ mint: q.mint, owner: q.manager.address, state: 0 }), builtin("UninitializedAccount")],
      ["fee account bad state", tokenAccountBytes({ mint: q.mint, owner: q.manager.address, state: 3 }), builtin("InvalidAccountData")],
      ["fee account short", tokenAccountBytes({ mint: q.mint, owner: q.manager.address }).subarray(0, 164), builtin("InvalidAccountData")],
      ["fee account multisig length", Buffer.alloc(355), builtin("InvalidAccountData")],
    ];
    for (const [label, bytes, want] of feeCases) expect(await run(label, replace(init(q), 7, await feeAt(bytes))), label).toBe(want);
    const systemFee = await feeAt(tokenAccountBytes({ mint: q.mint, owner: q.manager.address }), SYSTEM);
    expect(await run("fee account not the token program's", replace(init(q), 7, systemFee))).toBe(custom(E.InvalidFeeAccount));
    // The reserve: an initialized stake account of the withdraw authority, no lockup.
    const rent = d.original.minimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE);
    const reserveOf = (o: { staker?: Address; withdrawer?: Address; lockup?: { epoch: bigint } }) =>
      d.stakeAccount(payer, { staker: o.staker ?? w, withdrawer: o.withdrawer ?? w, lamports: rent + SOL, lockup: o.lockup });
    expect(await run("reserve not a stake account", replace(init(q), 5, q.managerFee))).toBe(builtin("IncorrectProgramId"));
    expect(await run("reserve with a lockup", replace(init(q), 5, await reserveOf({ lockup: { epoch: 99n } })))).toBe(custom(E.WrongStakeStake));
    expect(await run("reserve of another staker", replace(init(q), 5, await reserveOf({ staker: payer.address })))).toBe(custom(E.WrongStakeStake));
    expect(await run("reserve of another withdrawer", replace(init(q), 5, await reserveOf({ withdrawer: payer.address })))).toBe(custom(E.WrongStakeStake));
    const delegated = await reserveOf({});
    d.patch(delegated, (b) => b.writeUInt32LE(2, 0));
    expect(await run("reserve delegated", replace(init(q), 5, delegated))).toBe(custom(E.WrongStakeStake));
    d.patch(delegated, (b) => b.writeUInt32LE(0, 0));
    expect(await run("reserve uninitialized", replace(init(q), 5, delegated))).toBe(custom(E.WrongStakeStake));
    d.patch(delegated, (b) => b.writeUInt32LE(4, 0));
    expect(await run("reserve tag 4", replace(init(q), 5, delegated))).toBe(builtin("BorshIoError"));
    const poorReserve = await reserveOf({});
    d.patch(poorReserve, () => {}, { lamports: rent - 1n });
    expect(await run("reserve under its rent", replace(init(q), 5, poorReserve))).toBe(custom(E.CalculationFailure));
    // Last, the good one, then again: already in use.
    await d.ok("initialize after refusals", payer, [init(q)]);
    expect(await run("pool in use", init(q))).toBe(custom(E.AlreadyInUse));
  });
});

describe("manager and staker settings", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let p: Pool;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(10_000n);
    p = await d.createPool(payer, { reserveLamports: 3n * SOL, withdrawalFee: fee(0n, 0n), label: "initialize (settings)" });
  });

  it("sets each fee, and refuses fees over 100% or rising too fast", async () => {
    const set = (label: string, f: Parameters<typeof ix.setFee>[2], who: Address | KeyPairSigner = p.manager) =>
      d.both(`set fee: ${label}`, payer, [ix.setFee(p, who, f)]);
    expect(await set("sol referral", { kind: "SolReferral", percent: 40 })).toBe("ok");
    expect(await set("stake referral", { kind: "StakeReferral", percent: 100 })).toBe("ok");
    expect(await set("epoch", { kind: "Epoch", fee: fee(10n, 100n) })).toBe("ok");
    expect(await set("sol deposit", { kind: "SolDeposit", fee: fee(1n, 200n) })).toBe("ok");
    expect(await set("stake deposit", { kind: "StakeDeposit", fee: fee(0n, 0n) })).toBe("ok");
    // From no withdrawal fee, up to 1.5x the 1/1000 baseline.
    expect(await set("stake withdrawal from none", { kind: "StakeWithdrawal", fee: fee(15n, 10_000n) })).toBe("ok");
    expect(await set("sol withdrawal too fast from none", { kind: "SolWithdrawal", fee: fee(16n, 10_000n) })).toBe(custom(E.FeeIncreaseTooHigh));
    expect(await set("sol withdrawal from none", { kind: "SolWithdrawal", fee: fee(1n, 1000n) })).toBe("ok");
    expect(await set("sol referral over 100", { kind: "SolReferral", percent: 101 })).toBe(custom(E.FeeTooHigh));
    expect(await set("stake referral over 100", { kind: "StakeReferral", percent: 255 })).toBe(custom(E.FeeTooHigh));
    for (const kind of ["Epoch", "StakeWithdrawal", "SolDeposit", "StakeDeposit", "SolWithdrawal"] as const)
      expect(await set(`${kind} over 100%`, { kind, fee: fee(3n, 2n) })).toBe(custom(E.FeeTooHigh));
    expect(await set("wrong manager", { kind: "SolReferral", percent: 1 }, p.staker)).toBe(custom(E.WrongManager));
    expect(await set("manager not signing", { kind: "SolReferral", percent: 1 }, p.manager.address)).toBe(custom(E.SignatureMissing));
    // The withdrawal fees take effect two epoch boundaries later, through UpdateStakePoolBalance.
    for (let e = 0; e < 2; e++) {
      d.nextEpoch();
      expect(await set(`epoch fee on a stale pool ${e}`, { kind: "Epoch", fee: fee(1n, 100n) })).toBe(custom(E.StakeListAndPoolOutOfDate));
      expect(await set(`sol deposit fee on a stale pool ${e}`, { kind: "SolDeposit", fee: fee(1n, 100n) })).toBe("ok");
      await d.ok(`update list (settings ${e})`, payer, [ix.updateValidatorListBalance(p, 0, false, [])]);
      await d.ok(`update pool (settings ${e})`, payer, [ix.updateStakePoolBalance(p)]);
    }
    // Now 15/10000 for stake withdrawals: at most +1/200 and at most 1.5x.
    expect(await set("stake withdrawal 1.5x", { kind: "StakeWithdrawal", fee: fee(225n, 100_000n) })).toBe("ok");
    expect(await set("stake withdrawal over 1.5x", { kind: "StakeWithdrawal", fee: fee(226n, 100_000n) })).toBe(custom(E.FeeIncreaseTooHigh));
    expect(await set("stake withdrawal lower", { kind: "StakeWithdrawal", fee: fee(1n, 10_000n) })).toBe("ok");
  });

  it("caps a withdrawal fee rise at half a percent", async () => {
    // From 2%, 1.5x would allow 3%, but the absolute cap of +0.5% stops at 2.5%.
    const q = await d.createPool(payer, { reserveLamports: SOL, withdrawalFee: fee(2n, 100n), label: "initialize (fee cap)" });
    expect(await d.both("set fee: +0.5%", payer, [ix.setFee(q, q.manager, { kind: "SolWithdrawal", fee: fee(25n, 1000n) })])).toBe("ok");
    expect(await d.both("set fee: +0.6%", payer, [ix.setFee(q, q.manager, { kind: "StakeWithdrawal", fee: fee(26n, 1000n) })])).toBe(
      custom(E.FeeIncreaseTooHigh),
    );
    // Products past u128 are a CalculationFailure: the rise times 200 (from 1 / (2^64 - 1)), the factor times 3
    // (from (2^64 - 2) / (2^64 - 1)).
    const max = 2n ** 64n - 1n;
    const tiny = await d.createPool(payer, { reserveLamports: SOL, withdrawalFee: fee(1n, max), label: "initialize (tiny fee)" });
    expect(await d.both("set fee: rise overflow", payer, [ix.setFee(tiny, tiny.manager, { kind: "SolWithdrawal", fee: fee(max, max) })])).toBe(
      custom(E.CalculationFailure),
    );
    const full = await d.createPool(payer, { reserveLamports: SOL, withdrawalFee: fee(max - 1n, max), label: "initialize (full fee)" });
    expect(await d.both("set fee: factor overflow", payer, [ix.setFee(full, full.manager, { kind: "StakeWithdrawal", fee: fee(max, max) })])).toBe(
      custom(E.CalculationFailure),
    );
  });

  it("changes the manager, the staker and the funding authorities", async () => {
    const newManager = await d.funded(1n);
    const newFee = await d.tokenAccount(payer, p.mint, newManager.address);
    const otherMint = await d.mint(payer, { authority: payer.address });
    const wrongFee = await d.tokenAccount(payer, otherMint, newManager.address);
    const run = (label: string, i: Instruction) => d.both(label, payer, [i]);
    expect(await run("set manager: fee account not the token program's", ix.setManager(p, p.manager, newManager, p.reserve))).toBe(
      builtin("IncorrectProgramId"),
    );
    expect(await run("set manager: wrong manager", ix.setManager(p, newManager, newManager, newFee))).toBe(custom(E.WrongManager));
    expect(await run("set manager: manager not signing", ix.setManager(p, p.manager.address, newManager, newFee))).toBe(custom(E.SignatureMissing));
    expect(await run("set manager: new manager not signing", ix.setManager(p, p.manager, newManager.address, newFee))).toBe(custom(E.SignatureMissing));
    expect(await run("set manager: fee account of another mint", ix.setManager(p, p.manager, newManager, wrongFee))).toBe(custom(E.InvalidFeeAccount));
    expect(await run("set manager", ix.setManager(p, p.manager, newManager, newFee))).toBe("ok");
    p.manager = newManager;
    p.managerFee = newFee;
    // SetStaker: by the staker (the manager check still runs and logs), by the manager, by neither.
    const newStaker = await d.funded(1n);
    expect(await run("set staker by staker", ix.setStaker(p, p.staker, newStaker.address))).toBe("ok");
    expect(await run("set staker by old staker", ix.setStaker(p, p.staker, p.staker.address))).toBe(custom(E.SignatureMissing));
    p.staker = newStaker;
    expect(await run("set staker by manager", ix.setStaker(p, p.manager, newStaker.address))).toBe("ok");
    expect(await run("set staker unsigned", ix.setStaker(p, p.staker.address, newStaker.address))).toBe(custom(E.SignatureMissing));
    // Funding authorities: set (Some) and removed (None, which leaves the old key's bytes behind in the account).
    const auth = await d.funded(1n);
    for (const type of ["StakeDeposit", "SolDeposit", "SolWithdraw"] as const) {
      expect(await run(`set funding ${type}`, ix.setFundingAuthority(p, p.manager, type, auth.address))).toBe("ok");
    }
    expect(await run("set funding: wrong manager", ix.setFundingAuthority(p, p.staker, "SolDeposit", null))).toBe(custom(E.WrongManager));
    for (const type of ["SolWithdraw", "SolDeposit", "StakeDeposit"] as const) {
      expect(await run(`unset funding ${type}`, ix.setFundingAuthority(p, p.manager, type, null))).toBe("ok");
    }
  });
});

describe("SOL deposits and withdrawals", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
  });

  /** A pool and a user with a pool-token account, plus a referrer's account. */
  async function setting(opts: Parameters<Diff["createPool"]>[1] = {}) {
    const p = await d.createPool(payer, { reserveLamports: 10n * SOL, depositFee: fee(1n, 100n), withdrawalFee: fee(3n, 1000n), referral: 30, ...opts });
    const user = await d.funded(1000n);
    const extensions: t22.ExtensionArgs[] = (opts.mintExtensions ?? []).some((e) => e.__kind === "TransferFeeConfig")
      ? [{ __kind: "TransferFeeAmount", withheldAmount: 0n }]
      : [];
    const tokens = await d.tokenAccount(payer, p.mint, user.address, p.tokenProgram, extensions);
    const referrer = await d.tokenAccount(payer, p.mint, payer.address, p.tokenProgram, extensions);
    return { p, user, tokens, referrer };
  }

  for (const program of [TOKEN, TOKEN_2022]) {
    const name = program === TOKEN ? "SPL Token" : "Token-2022";
    it(`deposits and withdraws SOL (${name})`, async () => {
      const { p, user, tokens, referrer } = await setting({ tokenProgram: program, label: `initialize (sol, ${name})` });
      const dep = (lamports: bigint, minimum?: bigint) => ix.depositSol(p, { from: user, to: tokens, referrer }, lamports, minimum);
      await d.ok(`deposit sol (${name})`, payer, [dep(25n * SOL)]);
      expect(d.tokenBalance(tokens)).toBe(25n * SOL - (25n * SOL) / 100n);
      await d.ok(`deposit sol slippage (${name})`, payer, [dep(3n * SOL, 2n * SOL)]);
      expect(await d.both(`deposit sol slippage exceeded (${name})`, payer, [dep(SOL, SOL)])).toBe(custom(E.ExceededSlippage));
      expect(await d.both(`deposit sol zero (${name})`, payer, [dep(0n)])).toBe(custom(E.DepositTooSmall));
      expect(await d.both(`deposit sol 1 lamport (${name})`, payer, [dep(1n)])).toBe(custom(E.DepositTooSmall));
      expect(await d.both(`deposit sol 100 lamports (${name})`, payer, [dep(100n)])).toBe("ok");
      expect(await d.both(`deposit sol more than held (${name})`, payer, [dep(5000n * SOL)])).not.toBe("ok");
      const wd = (amount: bigint, minimum?: bigint, from = tokens, who = user) =>
        ix.withdrawSol(p, { transferAuthority: who, from, to: user.address }, amount, minimum);
      await d.ok(`withdraw sol (${name})`, payer, [wd(5n * SOL)]);
      await d.ok(`withdraw sol slippage (${name})`, payer, [wd(SOL, SOL / 2n)]);
      expect(await d.both(`withdraw sol slippage exceeded (${name})`, payer, [wd(SOL, SOL)])).toBe(custom(E.ExceededSlippage));
      expect(await d.both(`withdraw sol zero (${name})`, payer, [wd(0n)])).toBe(custom(E.WithdrawalTooSmall));
      expect(await d.both(`withdraw sol everything (${name})`, payer, [wd(d.tokenBalance(tokens))])).toBe("ok");
      // The manager withdraws from the fee account itself: no fee.
      const manager = ix.withdrawSol(p, { transferAuthority: p.manager, from: p.managerFee, to: user.address }, SOL);
      await d.ok(`withdraw sol from the fee account (${name})`, payer, [manager]);
      // More than the reserve holds past its rent.
      const all = d.tokenBalance(p.managerFee);
      expect(
        await d.both(`withdraw sol past the reserve (${name})`, payer, [
          ix.withdrawSol(p, { transferAuthority: p.manager, from: p.managerFee, to: user.address }, all + 1n),
        ]),
      ).not.toBe("ok");
    });
  }

  it("withdraws from a Token-2022 pool whose mint charges a transfer fee", async () => {
    const extension = {
      __kind: "TransferFeeConfig",
      transferFeeConfigAuthority: payer.address,
      withdrawWithheldAuthority: payer.address,
      withheldAmount: 0n,
      olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
      newerTransferFee: { epoch: 0n, maximumFee: 10n ** 9n, transferFeeBasisPoints: 100 },
    } as const;
    const { p, user, tokens, referrer } = await setting({
      tokenProgram: TOKEN_2022,
      mintExtensions: [extension],
      mintInit: (m) => [
        t22.getInitializeTransferFeeConfigInstruction({
          mint: m,
          transferFeeConfigAuthority: payer.address,
          withdrawWithheldAuthority: payer.address,
          transferFeeBasisPoints: 100,
          maximumFee: 10n ** 9n,
        }) as Instruction,
      ],
      label: "initialize (transfer fee)",
    });
    await d.ok("deposit sol (transfer fee)", payer, [ix.depositSol(p, { from: user, to: tokens, referrer }, 4n * SOL)]);
    await d.ok("withdraw sol (transfer fee)", payer, [ix.withdrawSol(p, { transferAuthority: user, from: tokens, to: user.address }, SOL)]);
  });

  it("refuses wrong accounts", async () => {
    const { p, user, tokens, referrer } = await setting({ label: "initialize (sol refusals)" });
    const dep = ix.depositSol(p, { from: user, to: tokens, referrer }, SOL);
    const wd = ix.withdrawSol(p, { transferAuthority: user, from: tokens, to: user.address }, SOL);
    await d.ok("deposit sol (refusals)", payer, [ix.depositSol(p, { from: user, to: tokens, referrer }, 10n * SOL)]);
    const other = await d.createPool(payer, { reserveLamports: SOL, label: "initialize (other pool)" });
    const cases: [string, Instruction, string][] = [
      ["deposit sol: wrong withdraw authority", replace(dep, 1, other.withdraw), custom(E.InvalidProgramAddress)],
      ["deposit sol: wrong mint", replace(dep, 7, other.mint), custom(E.WrongPoolMint)],
      ["deposit sol: wrong reserve", replace(dep, 2, other.reserve), custom(E.InvalidProgramAddress)],
      ["deposit sol: wrong token program", replace(dep, 9, TOKEN_2022), builtin("IncorrectProgramId")],
      ["deposit sol: wrong system program", replace(dep, 8, STAKE), builtin("IncorrectProgramId")],
      ["deposit sol: wrong fee account", replace(dep, 5, tokens), custom(E.InvalidFeeAccount)],
      ["deposit sol: a list as the pool", replace(dep, 0, other.list), "x"],
      ["deposit sol: user not signing", replace(dep, 3, user.address), "x"],
      ["withdraw sol: wrong withdraw authority", replace(wd, 1, other.withdraw), custom(E.InvalidProgramAddress)],
      ["withdraw sol: wrong mint", replace(wd, 7, other.mint), custom(E.WrongPoolMint)],
      ["withdraw sol: wrong reserve", replace(wd, 4, other.reserve), custom(E.InvalidProgramAddress)],
      ["withdraw sol: wrong token program", replace(wd, 11, TOKEN_2022), builtin("IncorrectProgramId")],
      ["withdraw sol: wrong stake program", replace(wd, 10, SYSTEM), builtin("IncorrectProgramId")],
      ["withdraw sol: wrong fee account", replace(wd, 6, tokens), custom(E.InvalidFeeAccount)],
      ["withdraw sol: another user's tokens", replace(wd, 3, referrer), "x"],
      // stake::instruction::withdraw names the Clock and the StakeHistory by address (the processor reads neither): the
      // runtime does not find the sysvar among the accounts.
      ["withdraw sol: another account as the clock", replace(wd, 8, STAKE_HISTORY), builtin("MissingAccount")],
      ["withdraw sol: another account as the stake history", replace(wd, 9, CLOCK), builtin("MissingAccount")],
    ];
    for (const [label, i, want] of cases) {
      const got = await d.both(label, payer, [i]);
      if (want !== "x") expect(got, label).toBe(want);
      else expect(got, label).not.toBe("ok");
    }
    // A stale pool: deposits and withdrawals wait for the update.
    d.nextEpoch();
    expect(await d.both("deposit sol: stale pool", payer, [dep])).toBe(custom(E.StakeListAndPoolOutOfDate));
    expect(await d.both("withdraw sol: stale pool", payer, [wd])).toBe(custom(E.StakeListAndPoolOutOfDate));
    for (const q of [p, other]) {
      await d.ok(`update list (sol refusals ${q.pool})`, payer, [ix.updateValidatorListBalance(q, 0, false, [])]);
      await d.ok(`update pool (sol refusals ${q.pool})`, payer, [ix.updateStakePoolBalance(q)]);
    }
    // A fee account that is no longer valid (frozen): withdrawals take no fee, its problem is logged.
    d.patch(p.managerFee, (b) => (b[108] = 2));
    await d.ok("withdraw sol: frozen fee account", payer, [wd]);
    await d.ok("update pool: frozen fee account", payer, [ix.updateStakePoolBalance(p)]);
    d.patch(p.managerFee, (b) => (b[108] = 1));
    // A fee account with an extension a fee account may not have (MemoTransfer): the same.
    const memoFee = (await generateKeyPairSigner()).address;
    d.write(memoFee, TOKEN, tokenAccountBytes({ mint: p.mint, owner: p.manager.address, tlv: tlv(8, u8(1)) }));
    expect(await d.both("set manager: fee account with MemoTransfer", payer, [ix.setManager(p, p.manager, p.manager, memoFee)])).toBe(
      custom(E.UnsupportedFeeAccountExtension),
    );
  });

  it("mints no fee tokens without a deposit fee", async () => {
    const { p, user, tokens, referrer } = await setting({ depositFee: fee(0n, 0n), label: "initialize (no deposit fee)" });
    await d.ok("deposit sol: no fee", payer, [ix.depositSol(p, { from: user, to: tokens, referrer }, 2n * SOL)]);
    expect(d.tokenBalance(tokens)).toBe(2n * SOL);
    // A referral share of 0: the whole deposit fee goes to the manager.
    await d.ok("set fee: sol deposit 1%", payer, [ix.setFee(p, p.manager, { kind: "SolDeposit", fee: fee(1n, 100n) })]);
    await d.ok("set fee: sol referral 0", payer, [ix.setFee(p, p.manager, { kind: "SolReferral", percent: 0 })]);
    await d.ok("deposit sol: no referral", payer, [ix.depositSol(p, { from: user, to: tokens, referrer }, 2n * SOL)]);
  });

  it("asks the SOL deposit and withdraw authorities to sign", async () => {
    const { p, user, tokens, referrer } = await setting({ label: "initialize (sol authorities)" });
    const auth = await d.funded(1n);
    await d.ok("set sol deposit authority", payer, [ix.setFundingAuthority(p, p.manager, "SolDeposit", auth.address)]);
    await d.ok("set sol withdraw authority", payer, [ix.setFundingAuthority(p, p.manager, "SolWithdraw", auth.address)]);
    const dep = (authority?: Address | KeyPairSigner) => ix.depositSol(p, { from: user, to: tokens, referrer, authority }, 2n * SOL);
    expect(await d.both("deposit sol: authority missing", payer, [dep()])).toBe(builtin("NotEnoughAccountKeys"));
    expect(await d.both("deposit sol: wrong authority", payer, [dep(user)])).toBe(custom(E.InvalidSolDepositAuthority));
    expect(await d.both("deposit sol: authority not signing", payer, [dep(auth.address)])).toBe(custom(E.SignatureMissing));
    await d.ok("deposit sol with authority", payer, [dep(auth)]);
    await d.ok("deposit sol with authority slippage", payer, [ix.depositSol(p, { from: user, to: tokens, referrer, authority: auth }, SOL, 1n)]);
    const wd = (authority?: Address | KeyPairSigner) => ix.withdrawSol(p, { transferAuthority: user, from: tokens, to: user.address, authority }, SOL);
    expect(await d.both("withdraw sol: authority missing", payer, [wd()])).toBe(builtin("NotEnoughAccountKeys"));
    expect(await d.both("withdraw sol: wrong authority", payer, [wd(user)])).toBe(custom(E.InvalidSolWithdrawAuthority));
    expect(await d.both("withdraw sol: authority not signing", payer, [wd(auth.address)])).toBe(custom(E.SignatureMissing));
    await d.ok("withdraw sol with authority", payer, [wd(auth)]);
    await d.ok("withdraw sol with authority slippage", payer, [
      ix.withdrawSol(p, { transferAuthority: user, from: tokens, to: user.address, authority: auth }, SOL, 1n),
    ]);
  });
});

describe("validators over epochs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let p: Pool;
  let votes: Address[];
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
    p = await d.createPool(payer, { reserveLamports: 50n * SOL, maxValidators: 6, label: "initialize (validators)" });
    votes = [];
    for (let i = 0; i < 6; i++) votes.push(await d.vote(payer));
  });
  const stakeOf = (vote: Address, seed = 0) => validatorStake(vote, p.pool, seed);
  async function update(label: string, noMerge = false) {
    await d.ok(`update list (${label})`, payer, [ix.updateValidatorListBalance(p, 0, noMerge, await updatePairs(d, p))]);
    await d.ok(`update pool (${label})`, payer, [ix.updateStakePoolBalance(p)]);
  }

  it("adds validators, and refuses bad additions", async () => {
    await d.ok("add validator", payer, [ix.addValidator(p, p.staker, await stakeOf(votes[0]!), votes[0]!)]);
    await d.ok("add validator with seed", payer, [ix.addValidator(p, p.staker, await stakeOf(votes[1]!, 42), votes[1]!, 42)]);
    const add = async (vote: Address, seed = 0) => ix.addValidator(p, p.staker, await stakeOf(vote, seed), vote, seed);
    const run = (label: string, i: Instruction) => d.both(`add validator: ${label}`, payer, [i]);
    expect(await run("again", await add(votes[0]!))).toBe(custom(E.ValidatorAlreadyAdded));
    expect(await run("wrong stake address", ix.addValidator(p, p.staker, await stakeOf(votes[2]!, 1), votes[2]!, 2))).toBe(
      custom(E.InvalidStakeAccountAddress),
    );
    expect(await run("wrong staker", ix.addValidator(p, p.manager, await stakeOf(votes[2]!), votes[2]!))).toBe(custom(E.WrongStaker));
    expect(await run("staker not signing", ix.addValidator(p, p.staker.address, await stakeOf(votes[2]!), votes[2]!))).toBe(custom(E.SignatureMissing));
    expect(await run("wrong system program", replace(await add(votes[2]!), 11, STAKE))).toBe(builtin("IncorrectProgramId"));
    expect(await run("wrong stake program", replace(await add(votes[2]!), 12, SYSTEM))).toBe(builtin("IncorrectProgramId"));
    expect(await run("wrong reserve", replace(await add(votes[2]!), 2, p.list))).toBe(custom(E.InvalidProgramAddress));
    expect(await run("wrong list", replace(await add(votes[2]!), 4, p.reserve))).toBe(custom(E.InvalidValidatorStakeList));
    expect(await run("wrong withdraw authority", replace(await add(votes[2]!), 3, p.reserve))).toBe(custom(E.InvalidProgramAddress));
    expect(await run("not a vote account", ix.addValidator(p, p.staker, await stakeOf(p.mint), p.mint))).not.toBe("ok");
    // DelegateStake names the StakeHistory and the stake config by address: another account in either slot fails the
    // call in the runtime (after the stake account was made and split); swapped, both are there (below).
    expect(await run("wrong stake history", replace(await add(votes[2]!), 9, p.mint))).toBe(builtin("MissingAccount"));
    expect(await run("wrong stake config", replace(await add(votes[2]!), 10, p.mint))).toBe(builtin("MissingAccount"));
    // A reserve that cannot fund another validator and keep its rent.
    const poor = await d.createPool(payer, { reserveLamports: SOL / 1000n, label: "initialize (poor)" });
    expect(
      await d.both("add validator: reserve too small", payer, [ix.addValidator(poor, poor.staker, await validatorStake(votes[2]!, poor.pool), votes[2]!)]),
    ).toBe(builtin("InsufficientFunds"));
    // A list that is full.
    const small = await d.createPool(payer, { reserveLamports: 10n * SOL, maxValidators: 1, label: "initialize (small)" });
    await d.ok("add validator (small)", payer, [ix.addValidator(small, small.staker, await validatorStake(votes[2]!, small.pool), votes[2]!)]);
    expect(
      await d.both("add validator: list full", payer, [ix.addValidator(small, small.staker, await validatorStake(votes[3]!, small.pool), votes[3]!)]),
    ).toBe(builtin("AccountDataTooSmall"));
    const swapped = accounts(await add(votes[2]!), (l) => {
      const h = l[9]!;
      l[9] = l[10]!;
      l[10] = h;
    });
    await d.ok("add validator: stake history and config swapped", payer, [swapped]);
    await d.ok(`add validator ${votes[3]!}`, payer, [await add(votes[3]!)]);
  });

  it("sets and clears preferred validators", async () => {
    const set = (label: string, type: "Deposit" | "Withdraw", vote: Address | null, who: Address | KeyPairSigner = p.staker) =>
      d.both(`set preferred: ${label}`, payer, [ix.setPreferredValidator(p, who, type, vote)]);
    expect(await set("deposit", "Deposit", votes[0]!)).toBe("ok");
    expect(await set("withdraw", "Withdraw", votes[1]!)).toBe("ok");
    expect(await set("not in the pool", "Deposit", votes[5]!)).toBe(custom(E.ValidatorNotFound));
    expect(await set("withdraw not in the pool", "Withdraw", votes[5]!)).toBe(custom(E.ValidatorNotFound));
    expect(await set("wrong staker", "Deposit", votes[0]!, p.manager)).toBe(custom(E.WrongStaker));
    expect(await set("staker not signing", "Deposit", votes[0]!, p.staker.address)).toBe(custom(E.SignatureMissing));
    expect(await d.both("set preferred: wrong list", payer, [replace(ix.setPreferredValidator(p, p.staker, "Deposit", null), 2, p.reserve)])).toBe(
      builtin("IncorrectProgramId"),
    );
    const otherList = (await d.createPool(payer, { label: "initialize (other list)" })).list;
    expect(await d.both("set preferred: another pool's list", payer, [replace(ix.setPreferredValidator(p, p.staker, "Deposit", null), 2, otherList)])).toBe(
      custom(E.InvalidValidatorStakeList),
    );
    expect(await set("clear deposit", "Deposit", null)).toBe("ok");
    expect(await set("deposit again", "Deposit", votes[2]!)).toBe("ok");
  });

  it("updates over epochs: extra lamports go to the reserve, the epoch fee is minted", async () => {
    d.nextEpoch();
    expect(await d.both("update pool before the list", payer, [ix.updateStakePoolBalance(p)])).toBe(custom(E.StakeListOutOfDate));
    expect(await d.both("add validator: stale pool", payer, [ix.addValidator(p, p.staker, await stakeOf(votes[4]!), votes[4]!)])).toBe(
      custom(E.StakeListAndPoolOutOfDate),
    );
    // Only the first half of the list, then the rest (start index 2).
    const pairs = await updatePairs(d, p);
    await d.ok("update list first half", payer, [ix.updateValidatorListBalance(p, 0, false, pairs.slice(0, 2))]);
    expect(await d.both("update pool after half", payer, [ix.updateStakePoolBalance(p)])).toBe(custom(E.StakeListOutOfDate));
    await d.ok("update list second half", payer, [ix.updateValidatorListBalance(p, 2, false, pairs.slice(2))]);
    await d.ok("update pool", payer, [ix.updateStakePoolBalance(p)]);
    // Rewards: lamports sent to a validator stake account are withdrawn into the reserve and counted.
    d.nextEpoch();
    for (const vm of d.vms) vm.airdrop(pairs[0]![0], lamports(3n * SOL));
    // The extra lamports are withdrawn with stake::instruction::withdraw, which names the StakeHistory by address.
    const wrongHistory = replace(ix.updateValidatorListBalance(p, 0, false, pairs), 5, p.mint);
    expect(await d.both("update list: wrong stake history", payer, [wrongHistory])).toBe(builtin("MissingAccount"));
    // no_merge still withdraws them; with no pairs there is no Stake CPI, and the account is never used.
    const noMerge = replace(ix.updateValidatorListBalance(p, 0, true, pairs), 5, p.mint);
    expect(await d.both("update list: wrong stake history, no merge", payer, [noMerge])).toBe(builtin("MissingAccount"));
    await d.ok("update list: wrong stake history, no pairs", payer, [replace(ix.updateValidatorListBalance(p, 0, false, []), 5, p.mint)]);
    await update("rewards");
    // Pairs that are not the entries' are skipped (an address mismatch is logged); odd counts and ranges past the end refused.
    d.nextEpoch();
    const swapped: [Address, Address][] = [pairs[1]!, pairs[0]!];
    await d.ok("update list: swapped pairs", payer, [ix.updateValidatorListBalance(p, 0, false, swapped)]);
    await d.ok("update list: wrong transient", payer, [ix.updateValidatorListBalance(p, 0, false, [[pairs[0]![0], pairs[1]![1]]])]);
    expect(await d.both("update list: odd accounts", payer, [accounts(ix.updateValidatorListBalance(p, 0, false, pairs), (l) => l.pop())])).toBe(
      custom(E.UnexpectedValidatorListAccountSize),
    );
    expect(await d.both("update list: past the end", payer, [ix.updateValidatorListBalance(p, 3, false, pairs.slice(0, 2))])).toBe(
      builtin("AccountDataTooSmall"),
    );
    expect(await d.both("update list: start past the end", payer, [ix.updateValidatorListBalance(p, 9, false, [])])).toBe(builtin("AccountDataTooSmall"));
    expect(await d.both("update list: wrong reserve", payer, [replace(ix.updateValidatorListBalance(p, 0, false, []), 3, p.pool)])).toBe(
      custom(E.InvalidProgramAddress),
    );
    expect(await d.both("update list: wrong stake program", payer, [replace(ix.updateValidatorListBalance(p, 0, false, []), 6, SYSTEM)])).toBe(
      builtin("IncorrectProgramId"),
    );
    expect(await d.both("update list: wrong withdraw authority", payer, [replace(ix.updateValidatorListBalance(p, 0, false, []), 1, p.pool)])).toBe(
      custom(E.InvalidProgramAddress),
    );
    expect(await d.both("update pool: wrong fee account", payer, [replace(ix.updateStakePoolBalance(p), 4, p.reserve)])).toBe(custom(E.InvalidFeeAccount));
    expect(await d.both("update pool: wrong list", payer, [replace(ix.updateStakePoolBalance(p), 2, p.reserve)])).toBe(custom(E.InvalidValidatorStakeList));
    expect(await d.both("update pool: wrong token program", payer, [replace(ix.updateStakePoolBalance(p), 6, TOKEN_2022)])).toBe(builtin("IncorrectProgramId"));
    expect(await d.both("update pool: wrong mint", payer, [replace(ix.updateStakePoolBalance(p), 5, p.reserve)])).toBe(custom(E.WrongPoolMint));
    await update("no merge", true);
  });

  it("keeps SOL withdrawals within the reserve", async () => {
    // The manager's tokens are worth all the pool's lamports, some of them staked: more than the reserve holds.
    const all = d.tokenBalance(p.managerFee);
    const user = await d.funded(1n);
    const wd = (amount: bigint) => ix.withdrawSol(p, { transferAuthority: p.manager, from: p.managerFee, to: user.address }, amount);
    expect(await d.both("withdraw sol: more than the reserve", payer, [wd(all)])).toBe(custom(E.SolWithdrawalTooLarge));
    await d.ok("withdraw sol: half", payer, [wd(all / 2n)]);
  });

  it("removes validators through deactivation, and cleans up", async () => {
    const pairs = await updatePairs(d, p);
    const run = (label: string, i: Instruction) => d.both(`remove validator: ${label}`, payer, [i]);
    expect(await run("not a stake account", ix.removeValidator(p, p.staker, p.reserve, pairs[0]![1]))).toBe(custom(E.WrongStakeStake));
    expect(await run("not delegated to a pool validator", ix.removeValidator(p, p.staker, pairs[0]![1], pairs[0]![1]))).toBe(builtin("BorshIoError"));
    expect(await run("wrong staker", ix.removeValidator(p, p.manager, pairs[0]![0], pairs[0]![1]))).toBe(custom(E.WrongStaker));
    expect(await run("wrong stake program", replace(ix.removeValidator(p, p.staker, pairs[0]![0], pairs[0]![1]), 7, SYSTEM))).toBe(
      builtin("IncorrectProgramId"),
    );
    expect(await run("wrong list", replace(ix.removeValidator(p, p.staker, pairs[0]![0], pairs[0]![1]), 3, p.reserve))).toBe(
      custom(E.InvalidValidatorStakeList),
    );
    // The preferred deposit validator (votes[2]) is removed: no longer preferred.
    expect(await run("preferred", ix.removeValidator(p, p.staker, pairs[2]![0], pairs[2]![1]))).toBe("ok");
    expect(await run("again", ix.removeValidator(p, p.staker, pairs[2]![0], pairs[2]![1]))).toBe(custom(E.ValidatorNotFound));
    expect(await d.both("set preferred: removed validator", payer, [ix.setPreferredValidator(p, p.staker, "Deposit", votes[2]!)])).toBe(
      custom(E.InvalidPreferredValidator),
    );
    expect(await run("withdraw preferred", ix.removeValidator(p, p.staker, pairs[1]![0], pairs[1]![1]))).toBe("ok");
    expect(await d.both("cleanup before the merge", payer, [ix.cleanupRemovedValidatorEntries(p)])).toBe("ok");
    d.nextEpoch();
    expect(await run("stale pool", ix.removeValidator(p, p.staker, pairs[0]![0], pairs[0]![1]))).toBe(custom(E.StakeListAndPoolOutOfDate));
    await update("after removal");
    await d.ok("cleanup", payer, [ix.cleanupRemovedValidatorEntries(p)]);
    await d.ok("cleanup with the pool read-only", payer, [ix.cleanupRemovedValidatorEntries(p, false)]);
    expect(d.validators(p).length).toBe(2);
  });

  it("resets preferred validators that are gone or inactive at cleanup", async () => {
    await d.ok("set preferred deposit (cleanup)", payer, [ix.setPreferredValidator(p, p.staker, "Deposit", votes[0]!)]);
    await d.ok("set preferred withdraw (cleanup)", payer, [ix.setPreferredValidator(p, p.staker, "Withdraw", votes[3]!)]);
    // As if the validators had changed under the pool: one marked for removal, one no longer listed.
    const list = d.validators(p);
    const i0 = list.findIndex((v) => v.vote === votes[0]);
    const i3 = list.findIndex((v) => v.vote === votes[3]);
    d.patch(p.list, (b) => {
      b[9 + 73 * i0 + 40] = 3;
      key(votes[5]!).copy(b, 9 + 73 * i3 + 41);
    });
    await d.ok("cleanup resets preferred", payer, [ix.cleanupRemovedValidatorEntries(p)]);
  });

  it("merges transient stake as it activates, deactivates or stays", async () => {
    // Transient stake accounts the pool would have made (Increase / Decrease are a later part): stake accounts of the
    // withdraw authority written at the transient addresses, and the entries' transient lamports set.
    const q = await d.createPool(payer, { reserveLamports: 50n * SOL, maxValidators: 8, label: "initialize (transient)" });
    const vs: Address[] = [];
    for (let i = 0; i < 6; i++) {
      const v = await d.vote(payer);
      vs.push(v);
      await d.ok(`add validator (transient ${i})`, payer, [ix.addValidator(q, q.staker, await validatorStake(v, q.pool), v)]);
    }
    d.nextEpoch();
    await d.ok("update list (transient 0)", payer, [ix.updateValidatorListBalance(q, 0, false, await updatePairs(d, q))]);
    await d.ok("update pool (transient 0)", payer, [ix.updateStakePoolBalance(q)]);
    const authority = await withdrawAuthority(q.pool);
    const owner = await d.funded(10n);
    const rent = d.original.minimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE);
    /** A stake account at the transient address of validator `i` (seed 7), delegated to `vote` or only initialized. */
    async function transient(i: number, o: { delegate?: Address; activation?: bigint; deactivation?: bigint; foreign?: boolean }) {
      const at = await d.stakeAccount(payer, { staker: owner.address, withdrawer: owner.address, lamports: rent + 2n * SOL });
      const to = await transientStake(vs[i]!, q.pool, 7n);
      d.patch(at, (b) => {
        if (o.delegate) {
          b.writeUInt32LE(2, 0);
          key(o.delegate).copy(b, STAKE_OFFSETS.voter);
          b.writeBigUInt64LE(2n * SOL, STAKE_OFFSETS.stake);
          b.writeBigUInt64LE(o.activation ?? 0n, STAKE_OFFSETS.activation);
          b.writeBigUInt64LE(o.deactivation ?? 2n ** 64n - 1n, STAKE_OFFSETS.deactivation);
          b.writeDoubleLE(0.25, 180);
        }
        if (!o.foreign) {
          key(authority).copy(b, STAKE_OFFSETS.staker);
          key(authority).copy(b, STAKE_OFFSETS.withdrawer);
        }
      });
      d.move(at, to);
      d.patch(q.list, (b) => {
        b.writeBigUInt64LE(rent + 2n * SOL, 9 + 73 * i + 8);
        b.writeBigUInt64LE(7n, 9 + 73 * i + 24);
      });
    }
    const epoch = d.cluster.epoch;
    await transient(0, {}); // initialized: merged into the reserve
    await transient(1, { delegate: vs[1]!, activation: epoch - 1n, deactivation: epoch - 1n }); // inactive: into the reserve
    await transient(2, { delegate: vs[2]!, activation: epoch - 1n }); // active, validator active: into the validator
    await transient(3, { delegate: vs[3]!, activation: epoch }); // activating: not ready
    await transient(4, { delegate: vs[4]!, activation: epoch - 1n, foreign: true }); // not the pool's: ignored
    await transient(5, { delegate: vs[5]!, activation: epoch - 1n });
    // Validator 5 is being removed: its active transient stake is deactivated instead.
    d.patch(q.list, (b) => (b[9 + 73 * 5 + 40] = 3));
    await d.ok("update list (transient, no merge)", payer, [ix.updateValidatorListBalance(q, 0, true, await updatePairs(d, q))]);
    await d.ok("update list (transient)", payer, [ix.updateValidatorListBalance(q, 0, false, await updatePairs(d, q))]);
    await d.ok("update pool (transient)", payer, [ix.updateStakePoolBalance(q)]);
    d.nextEpoch();
    await d.ok("update list (transient 2)", payer, [ix.updateValidatorListBalance(q, 0, false, await updatePairs(d, q))]);
    await d.ok("update pool (transient 2)", payer, [ix.updateStakePoolBalance(q)]);
    // A validator removed while its transient stake is active: both are deactivated (DeactivatingAll).
    await transient(3, { delegate: vs[3]!, activation: d.cluster.epoch - 1n });
    const pairs = await updatePairs(d, q);
    await d.ok("remove validator with transient stake", payer, [ix.removeValidator(q, q.staker, pairs[3]![0], pairs[3]![1])]);
    expect(await d.both("remove validator: wrong transient", payer, [ix.removeValidator(q, q.staker, pairs[0]![0], pairs[1]![1])])).toBe("ok");
    d.nextEpoch();
    await d.ok("update list (transient 3)", payer, [ix.updateValidatorListBalance(q, 0, false, await updatePairs(d, q))]);
    d.nextEpoch();
    await d.ok("update list (transient 4)", payer, [ix.updateValidatorListBalance(q, 0, false, await updatePairs(d, q))]);
    await d.ok("update pool (transient 4)", payer, [ix.updateStakePoolBalance(q)]);
    await d.ok("cleanup (transient)", payer, [ix.cleanupRemovedValidatorEntries(q)]);
  });

  it("refuses a status byte that is no StakeStatus", async () => {
    const r = await d.createPool(payer, { reserveLamports: 5n * SOL, maxValidators: 2, label: "initialize (status)" });
    const v = await d.vote(payer);
    await d.ok("add validator (status)", payer, [ix.addValidator(r, r.staker, await validatorStake(v, r.pool), v)]);
    d.patch(r.list, (b) => (b[9 + 40] = 9));
    expect(await d.both("set preferred withdraw: bad status", payer, [ix.setPreferredValidator(r, r.staker, "Withdraw", v)])).toBe(
      custom(E.InvalidPreferredValidator),
    );
    d.nextEpoch();
    for (const noMerge of [true, false])
      expect(
        await d.both(`update list: bad status (no merge ${noMerge})`, payer, [ix.updateValidatorListBalance(r, 0, noMerge, await updatePairs(d, r))]),
      ).toBe(builtin("InvalidAccountData"));
  });
});

describe("warmup and cooldown over several epochs", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    // A cluster that shrinks to almost nothing after the first epoch: the validators' stake activates at once, but
    // then about 9% of the few lamports left may deactivate per epoch, so a removed validator cools down over several
    // epochs (and the Stake program refuses to merge it into the reserve in between).
    d = await diff({ cluster: { base: (epoch) => (epoch < 1n ? stakeHistoryEntry(400_000_000n * SOL) : stakeHistoryEntry(1_000_000n)) } });
    payer = await d.funded(100_000n);
  });

  it("adds validators whose stake activates slowly, and removes one while it cools down", async () => {
    const p = await d.createPool(payer, { reserveLamports: 30n * SOL, maxValidators: 4, label: "initialize (warmup)" });
    const votes = [await d.vote(payer), await d.vote(payer)];
    for (const v of votes) await d.ok(`add validator (warmup) ${v}`, payer, [ix.addValidator(p, p.staker, await validatorStake(v, p.pool), v)]);
    const outcomes: string[] = [];
    for (let e = 0; e < 16 && d.validators(p).length > 1; e++) {
      d.nextEpoch();
      outcomes.push(await d.both(`update list (cooldown ${e})`, payer, [ix.updateValidatorListBalance(p, 0, false, await updatePairs(d, p))]));
      outcomes.push(await d.both(`update pool (cooldown ${e})`, payer, [ix.updateStakePoolBalance(p)]));
      if (e === 0) {
        const pairs = await updatePairs(d, p);
        outcomes.push(await d.both("remove validator (cooldown)", payer, [ix.removeValidator(p, p.staker, pairs[0]![0], pairs[0]![1])]));
      }
      outcomes.push(await d.both(`cleanup (cooldown ${e})`, payer, [ix.cleanupRemovedValidatorEntries(p)]));
    }
    // Some epochs could not merge the cooling stake; in the end it was absorbed and its entry cleaned up.
    expect(outcomes.filter((o) => o !== "ok").length, outcomes.join("\n")).toBeGreaterThan(0);
    expect(d.validators(p).length, outcomes.join("\n")).toBe(1);
  });
});

describe("a pool of 60 validators", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let p: Pool;
  const N = 60;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(100_000n);
    p = await d.createPool(payer, { reserveLamports: 200n * SOL, maxValidators: 64, label: "initialize (60)" });
  });

  it("adds them, updates them in chunks, removes some and cleans the list up", async () => {
    for (let i = 0; i < N; i++) {
      const v = await d.vote(payer);
      await d.ok(i === N - 1 ? "add validator (60th)" : `add validator (big ${i})`, payer, [
        ix.addValidator(p, p.staker, await validatorStake(v, p.pool, i % 3), v, i % 3),
      ]);
    }
    d.nextEpoch();
    const pairs = await updatePairs(d, p);
    const CHUNK = 12;
    for (let i = 0; i < N; i += CHUNK)
      await d.ok(i === 0 ? "update list (12 pairs)" : `update list (big ${i})`, payer, [ix.updateValidatorListBalance(p, i, false, pairs.slice(i, i + CHUNK))]);
    await d.ok("update pool (60)", payer, [ix.updateStakePoolBalance(p)]);
    // More than 32 accounts in one instruction: 16 pairs (39 accounts), with no merge.
    await d.ok("update list (16 pairs)", payer, [ix.updateValidatorListBalance(p, 0, true, pairs.slice(0, 16))]);
    const removed = [3, 17, 18, 40, 59];
    for (const i of removed) await d.ok(`remove validator (big ${i})`, payer, [ix.removeValidator(p, p.staker, pairs[i]![0], pairs[i]![1])]);
    await d.ok("set preferred (60)", payer, [ix.setPreferredValidator(p, p.staker, "Withdraw", d.validators(p)[N - 2]!.vote)]);
    d.nextEpoch();
    for (let i = 0; i < N; i += CHUNK)
      await d.ok(`update list after removal (big ${i})`, payer, [ix.updateValidatorListBalance(p, i, false, pairs.slice(i, i + CHUNK))]);
    await d.ok("update pool after removal (60)", payer, [ix.updateStakePoolBalance(p)]);
    await d.ok("cleanup (60)", payer, [ix.cleanupRemovedValidatorEntries(p)]);
    expect(d.validators(p).length).toBe(N - removed.length);
    // A validator added after the cleanup goes at the end of the compacted list.
    const v = await d.vote(payer);
    await d.ok("add validator after cleanup (60)", payer, [ix.addValidator(p, p.staker, await validatorStake(v, p.pool), v)]);
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
      ["initialize", "initialize"],
      ["add validator", "add validator"],
      ["remove validator", "remove validator: preferred"],
      ["set preferred", "set preferred: deposit"],
      ["update list (4 pairs)", "update list (rewards)"],
      ["update list (12 pairs)", "update list (12 pairs)"],
      ["update list (16, no merge)", "update list (16 pairs)"],
      ["update list (merges)", "update list (transient)"],
      ["update pool", "update pool (rewards)"],
      ["update pool (60)", "update pool (60)"],
      ["cleanup", "cleanup"],
      ["cleanup (60)", "cleanup (60)"],
      ["set manager", "set manager"],
      ["set fee", "set fee: epoch"],
      ["set staker", "set staker by manager"],
      ["set funding authority", "set funding SolDeposit"],
      ["deposit sol", "deposit sol (SPL Token)"],
      ["deposit sol (slippage)", "deposit sol slippage (SPL Token)"],
      ["withdraw sol", "withdraw sol (SPL Token)"],
      ["withdraw sol (slippage)", "withdraw sol slippage (SPL Token)"],
      ["deposit sol (Token-2022)", "deposit sol (Token-2022)"],
      ["redelegate (refused)", "redelegate"],
    ];
    for (const [name, label] of rows) {
      const got = all[label];
      expect(got, label).toBeDefined();
      const [a, b] = got!;
      console.log(`${name.padEnd(26)} original ${String(a).padStart(7)}  TypeSOL ${String(b).padStart(7)}  ${((Number(b) / Number(a)) * 100).toFixed(0)}%`);
      expect(b, `${name}: TypeSOL ${b} vs original ${a}`).toBeLessThan(a);
    }
    console.log(`${compared} transactions compared`);
    expect(compared).toBeGreaterThan(300);
  });
});
