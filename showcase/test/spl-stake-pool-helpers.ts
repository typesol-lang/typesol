// The differential harness for showcase/mainnet/spl-stake-pool against SPL Stake Pool as deployed on mainnet
// (test/programs/spl_stake_pool.so, solana-program/stake-pool program@v2.1.0). The original and the port run in two
// LiteSVMs under the same program id; a StakeCluster gives both the same Clock, EpochSchedule and StakeHistory, so
// warmup and cooldown are the same in both. Every account is made by the same transactions in both VMs (the same
// keypairs), so the addresses and bytes agree; `both()` then sends a transaction to each and requires the same
// outcome, the same log lines (all but the compute-unit lines) and the same lamports, owner and data in every
// account the transaction names (and any others asked for).
//
// The instruction builders follow instruction.rs (the account lists of its `initialize`, `add_validator_to_pool`,
// … functions and the Borsh data of StakePoolInstruction), for all 27 tags.
import { getCreateAccountInstruction } from "@solana-program/system";
import * as token from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { deployFile, pda, send } from "../../test/harness.js";
import {
  STAKE_PROGRAM_ADDRESS,
  StakeCluster,
  type StakeClusterOptions,
  createStakeAccount,
  createVoteAccount,
  readStakeAccount,
} from "../../src/testing-stake.js";

export const PROGRAM = address("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
export const ORIGINAL = fileURLToPath(new URL("../../test/programs/spl_stake_pool.so", import.meta.url));
export const PORT = fileURLToPath(new URL("../mainnet/spl-stake-pool/stake_pool.ts", import.meta.url));
/** Metaplex Token Metadata, fetched by scripts/fetch-programs.sh (see test/programs/SOURCES.md). */
export const MPL_METADATA_SO = fileURLToPath(new URL("../../test/programs/mpl_token_metadata.so", import.meta.url));
export const TOKEN = address(token.TOKEN_PROGRAM_ADDRESS);
export const TOKEN_2022 = address(t22.TOKEN_2022_PROGRAM_ADDRESS);
export const SYSTEM = address("11111111111111111111111111111111");
export const STAKE = STAKE_PROGRAM_ADDRESS;
export const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
export const RENT = address("SysvarRent111111111111111111111111111111111");
export const STAKE_HISTORY = address("SysvarStakeHistory1111111111111111111111111");
export const STAKE_CONFIG = address("StakeConfig11111111111111111111111111111111");
export const MPL_METADATA = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const SOL = 1_000_000_000n;
/** get_packed_len::<StakePool>(): the account size clients allocate (every Option Some). */
export const STAKE_POOL_SIZE = 611n;
export const STAKE_ACCOUNT_SIZE = 200n;
export const MINIMUM_ACTIVE_STAKE = 1_000_000n;

export type Result = TransactionMetadata | FailedTransactionMetadata;
export type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

const enc = getAddressEncoder();
export const key = (a: string) => Buffer.from(enc.encode(address(a)));
export const u8 = (n: number | bigint) => Buffer.from([Number(n)]);
export const u32 = (n: number | bigint) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n));
  return b;
};
export const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt.asUintN(64, n));
  return b;
};
export const outcome = (r: Result) => (r instanceof FailedTransactionMetadata ? `error: ${String(r.err())}` : "ok");
export const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
/** The log lines both must share: all of them but the compute-unit lines. */
export const lines = (r: Result) =>
  meta(r)
    .logs()
    .filter((l) => !/ consumed \d+ of \d+ compute units$/.test(l));
/** The outcome of a custom program error, StakePoolError code `code`. */
export const custom = (code: number) => `error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: ${code} } }`;
/** The outcome of a built-in error of the first instruction (its name as LiteSVM prints it). */
export const builtin = (name: string) => `error: TransactionErrorInstructionError { index: 0, error: ${name} }`;

/** A Fee { denominator, numerator } (the order the program stores it in). */
export interface Fee {
  numerator: bigint;
  denominator: bigint;
}
export const fee = (numerator: bigint, denominator: bigint): Fee => ({ numerator, denominator });
const feeBytes = (f: Fee) => Buffer.concat([u64(f.denominator), u64(f.numerator)]);

/** FeeType (SetFee): a referral percentage or a Fee. */
export type FeeType =
  | { kind: "SolReferral"; percent: number }
  | { kind: "StakeReferral"; percent: number }
  | { kind: "Epoch" | "StakeWithdrawal" | "SolDeposit" | "StakeDeposit" | "SolWithdrawal"; fee: Fee };
const FEE_TYPES = ["SolReferral", "StakeReferral", "Epoch", "StakeWithdrawal", "SolDeposit", "StakeDeposit", "SolWithdrawal"] as const;

export const FUNDING = { StakeDeposit: 0, SolDeposit: 1, SolWithdraw: 2 } as const;

// ---- PDAs (lib.rs) ---------------------------------------------------------------------------------------------------

export const withdrawAuthority = async (pool: Address) => (await pda(PROGRAM, [pool, "withdraw"]))[0];
export const depositAuthority = async (pool: Address) => (await pda(PROGRAM, [pool, "deposit"]))[0];
export const validatorStake = async (vote: Address, pool: Address, seed = 0) =>
  (await pda(PROGRAM, seed === 0 ? [vote, pool] : [vote, pool, new Uint8Array(u32(seed))]))[0];
export const transientStake = async (vote: Address, pool: Address, seed: bigint) =>
  (await pda(PROGRAM, ["transient", vote, pool, new Uint8Array(u64(seed))]))[0];
export const ephemeralStake = async (pool: Address, seed: bigint) => (await pda(PROGRAM, ["ephemeral", pool, new Uint8Array(u64(seed))]))[0];
/** Metaplex's metadata account of `mint` (inline_mpl_token_metadata::pda::find_metadata_account). */
export const metadataAddress = async (mint: Address) => (await pda(MPL_METADATA, ["metadata", MPL_METADATA, mint]))[0];

// ---- Instructions (instruction.rs) -----------------------------------------------------------------------------------

export function instruction(data: Buffer, accounts: Meta[]): Instruction {
  return {
    programAddress: PROGRAM,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(data),
  };
}
const w = (a: Address): Meta => ({ address: a, writable: true });
const r = (a: Address): Meta => ({ address: a });
const s = (k: KeyPairSigner): Meta => ({ address: k.address, signer: k });
const ws = (k: KeyPairSigner): Meta => ({ address: k.address, signer: k, writable: true });
/** An account that may or may not sign (a signer when given as a keypair). */
const maybe = (a: Address | KeyPairSigner): Meta => (typeof a === "string" ? r(a) : s(a));

/** The pool's accounts, as a test keeps them. */
export interface Pool {
  pool: Address;
  list: Address;
  reserve: Address;
  mint: Address;
  managerFee: Address;
  withdraw: Address;
  deposit: Address;
  tokenProgram: Address;
  manager: KeyPairSigner;
  staker: KeyPairSigner;
  maxValidators: number;
}

/** Each tag's data and accounts. Every account list is the one the matching instruction.rs function builds. */
export const ix = {
  initialize(
    p: {
      pool: Address;
      manager: Address | KeyPairSigner;
      staker: Address;
      withdraw: Address;
      list: Address;
      reserve: Address;
      mint: Address;
      managerFee: Address;
      tokenProgram: Address;
    },
    fees: { epoch: Fee; withdrawal: Fee; deposit: Fee; referral: number; maxValidators: number },
    depositAuthority?: Address | KeyPairSigner,
  ) {
    const data = Buffer.concat([u8(0), feeBytes(fees.epoch), feeBytes(fees.withdrawal), feeBytes(fees.deposit), u8(fees.referral), u32(fees.maxValidators)]);
    return instruction(data, [
      w(p.pool),
      maybe(p.manager),
      r(p.staker),
      r(p.withdraw),
      w(p.list),
      r(p.reserve),
      w(p.mint),
      w(p.managerFee),
      r(p.tokenProgram),
      ...(depositAuthority ? [maybe(depositAuthority)] : []),
    ]);
  },
  addValidator(p: Pool, staker: Address | KeyPairSigner, stake: Address, vote: Address, seed = 0) {
    return instruction(Buffer.concat([u8(1), u32(seed)]), [
      w(p.pool),
      maybe(staker),
      w(p.reserve),
      r(p.withdraw),
      w(p.list),
      w(stake),
      r(vote),
      r(RENT),
      r(CLOCK),
      r(STAKE_HISTORY),
      r(STAKE_CONFIG),
      r(SYSTEM),
      r(STAKE),
    ]);
  },
  removeValidator(p: Pool, staker: Address | KeyPairSigner, stake: Address, transient: Address) {
    return instruction(u8(2), [w(p.pool), maybe(staker), r(p.withdraw), w(p.list), w(stake), w(transient), r(CLOCK), r(STAKE)]);
  },
  /** Tag 3 (deprecated): DecreaseValidatorStake. */
  decreaseValidatorStake(p: Pool, staker: Address | KeyPairSigner, stake: Address, transient: Address, lamports: bigint, transientSeed: bigint) {
    return instruction(Buffer.concat([u8(3), u64(lamports), u64(transientSeed)]), [
      r(p.pool),
      maybe(staker),
      r(p.withdraw),
      w(p.list),
      w(stake),
      w(transient),
      r(CLOCK),
      r(RENT),
      r(SYSTEM),
      r(STAKE),
    ]);
  },
  increaseValidatorStake(p: Pool, staker: Address | KeyPairSigner, transient: Address, stake: Address, vote: Address, lamports: bigint, transientSeed: bigint) {
    return instruction(Buffer.concat([u8(4), u64(lamports), u64(transientSeed)]), [
      r(p.pool),
      maybe(staker),
      r(p.withdraw),
      w(p.list),
      w(p.reserve),
      w(transient),
      r(stake),
      r(vote),
      r(CLOCK),
      r(RENT),
      r(STAKE_HISTORY),
      r(STAKE_CONFIG),
      r(SYSTEM),
      r(STAKE),
    ]);
  },
  setPreferredValidator(p: Pool, staker: Address | KeyPairSigner, type: "Deposit" | "Withdraw", vote: Address | null) {
    const data = Buffer.concat([u8(5), u8(type === "Deposit" ? 0 : 1), vote ? Buffer.concat([u8(1), key(vote)]) : u8(0)]);
    return instruction(data, [w(p.pool), maybe(staker), r(p.list)]);
  },
  /** UpdateValidatorListBalance over `pairs` (validator stake, transient stake) from `start`. */
  updateValidatorListBalance(p: Pool, start: number, noMerge: boolean, pairs: [Address, Address][]) {
    return instruction(Buffer.concat([u8(6), u32(start), u8(noMerge ? 1 : 0)]), [
      r(p.pool),
      r(p.withdraw),
      w(p.list),
      w(p.reserve),
      r(CLOCK),
      r(STAKE_HISTORY),
      r(STAKE),
      ...pairs.flatMap(([v, t]) => [w(v), w(t)]),
    ]);
  },
  updateStakePoolBalance(p: Pool) {
    return instruction(u8(7), [w(p.pool), r(p.withdraw), w(p.list), r(p.reserve), w(p.managerFee), w(p.mint), r(p.tokenProgram)]);
  },
  cleanupRemovedValidatorEntries(p: Pool, poolWritable = true) {
    return instruction(u8(8), [poolWritable ? w(p.pool) : r(p.pool), w(p.list)]);
  },
  /** Tags 9 / 23: DepositStake, with `minimum` DepositStakeWithSlippage. */
  depositStake(
    p: Pool,
    a: { depositAuthority: Address | KeyPairSigner; stake: Address; validatorStake: Address; to: Address; referrer: Address },
    minimum?: bigint,
  ) {
    const data = minimum === undefined ? u8(9) : Buffer.concat([u8(23), u64(minimum)]);
    return instruction(data, [
      w(p.pool),
      w(p.list),
      maybe(a.depositAuthority),
      r(p.withdraw),
      w(a.stake),
      w(a.validatorStake),
      w(p.reserve),
      w(a.to),
      w(p.managerFee),
      w(a.referrer),
      w(p.mint),
      r(CLOCK),
      r(STAKE_HISTORY),
      r(p.tokenProgram),
      r(STAKE),
    ]);
  },
  /** Tags 10 / 24: WithdrawStake, with `minimum` WithdrawStakeWithSlippage. */
  withdrawStake(
    p: Pool,
    a: { split: Address; receive: Address; newAuthority: Address; transferAuthority: KeyPairSigner; from: Address },
    poolTokens: bigint,
    minimum?: bigint,
  ) {
    const data = minimum === undefined ? Buffer.concat([u8(10), u64(poolTokens)]) : Buffer.concat([u8(24), u64(poolTokens), u64(minimum)]);
    return instruction(data, [
      w(p.pool),
      w(p.list),
      r(p.withdraw),
      w(a.split),
      w(a.receive),
      r(a.newAuthority),
      s(a.transferAuthority),
      w(a.from),
      w(p.managerFee),
      w(p.mint),
      r(CLOCK),
      r(p.tokenProgram),
      r(STAKE),
    ]);
  },
  setManager(p: Pool, manager: Address | KeyPairSigner, newManager: Address | KeyPairSigner, newFee: Address) {
    return instruction(u8(11), [w(p.pool), maybe(manager), maybe(newManager), r(newFee)]);
  },
  setFee(p: Pool, manager: Address | KeyPairSigner, f: FeeType) {
    const tag = FEE_TYPES.indexOf(f.kind);
    const body = "percent" in f ? u8(f.percent) : feeBytes(f.fee);
    return instruction(Buffer.concat([u8(12), u8(tag), body]), [w(p.pool), maybe(manager)]);
  },
  setStaker(p: Pool, authority: Address | KeyPairSigner, newStaker: Address) {
    return instruction(u8(13), [w(p.pool), maybe(authority), r(newStaker)]);
  },
  /** Tags 14 / 25: DepositSol, with `minimum` DepositSolWithSlippage; `authority`: the SOL deposit authority. */
  depositSol(p: Pool, a: { from: KeyPairSigner; to: Address; referrer: Address; authority?: Address | KeyPairSigner }, lamports: bigint, minimum?: bigint) {
    const data = minimum === undefined ? Buffer.concat([u8(14), u64(lamports)]) : Buffer.concat([u8(25), u64(lamports), u64(minimum)]);
    return instruction(data, [
      w(p.pool),
      r(p.withdraw),
      w(p.reserve),
      ws(a.from),
      w(a.to),
      w(p.managerFee),
      w(a.referrer),
      w(p.mint),
      r(SYSTEM),
      r(p.tokenProgram),
      ...(a.authority ? [maybe(a.authority)] : []),
    ]);
  },
  setFundingAuthority(p: Pool, manager: Address | KeyPairSigner, type: keyof typeof FUNDING, authority: Address | null) {
    return instruction(Buffer.concat([u8(15), u8(FUNDING[type])]), [w(p.pool), maybe(manager), ...(authority ? [r(authority)] : [])]);
  },
  /** Tags 16 / 26: WithdrawSol, with `minimum` WithdrawSolWithSlippage; `authority`: the SOL withdraw authority. */
  withdrawSol(
    p: Pool,
    a: { transferAuthority: KeyPairSigner; from: Address; to: Address; authority?: Address | KeyPairSigner },
    poolTokens: bigint,
    minimum?: bigint,
  ) {
    const data = minimum === undefined ? Buffer.concat([u8(16), u64(poolTokens)]) : Buffer.concat([u8(26), u64(poolTokens), u64(minimum)]);
    return instruction(data, [
      w(p.pool),
      r(p.withdraw),
      s(a.transferAuthority),
      w(a.from),
      w(p.reserve),
      w(a.to),
      w(p.managerFee),
      w(p.mint),
      r(CLOCK),
      r(STAKE_HISTORY),
      r(STAKE),
      r(p.tokenProgram),
      ...(a.authority ? [maybe(a.authority)] : []),
    ]);
  },
  /** Tag 17: CreateTokenMetadata { name, symbol, uri }. */
  createTokenMetadata(p: Pool, manager: Address | KeyPairSigner, payer: KeyPairSigner, metadata: Address, name: string, symbol: string, uri: string) {
    return instruction(Buffer.concat([u8(17), str(name), str(symbol), str(uri)]), [
      r(p.pool),
      maybe(manager),
      r(p.withdraw),
      r(p.mint),
      ws(payer),
      w(metadata),
      r(MPL_METADATA),
      r(SYSTEM),
    ]);
  },
  /** Tag 18: UpdateTokenMetadata { name, symbol, uri }. */
  updateTokenMetadata(p: Pool, manager: Address | KeyPairSigner, metadata: Address, name: string, symbol: string, uri: string) {
    return instruction(Buffer.concat([u8(18), str(name), str(symbol), str(uri)]), [r(p.pool), maybe(manager), r(p.withdraw), w(metadata), r(MPL_METADATA)]);
  },
  increaseAdditionalValidatorStake(
    p: Pool,
    staker: Address | KeyPairSigner,
    a: { ephemeral: Address; transient: Address; stake: Address; vote: Address },
    lamports: bigint,
    transientSeed: bigint,
    ephemeralSeed: bigint,
  ) {
    return instruction(Buffer.concat([u8(19), u64(lamports), u64(transientSeed), u64(ephemeralSeed)]), [
      r(p.pool),
      maybe(staker),
      r(p.withdraw),
      w(p.list),
      w(p.reserve),
      w(a.ephemeral),
      w(a.transient),
      r(a.stake),
      r(a.vote),
      r(CLOCK),
      r(STAKE_HISTORY),
      r(STAKE_CONFIG),
      r(SYSTEM),
      r(STAKE),
    ]);
  },
  decreaseAdditionalValidatorStake(
    p: Pool,
    staker: Address | KeyPairSigner,
    a: { stake: Address; ephemeral: Address; transient: Address },
    lamports: bigint,
    transientSeed: bigint,
    ephemeralSeed: bigint,
  ) {
    return instruction(Buffer.concat([u8(20), u64(lamports), u64(transientSeed), u64(ephemeralSeed)]), [
      r(p.pool),
      maybe(staker),
      r(p.withdraw),
      w(p.list),
      w(p.reserve),
      w(a.stake),
      w(a.ephemeral),
      w(a.transient),
      r(CLOCK),
      r(STAKE_HISTORY),
      r(SYSTEM),
      r(STAKE),
    ]);
  },
  decreaseValidatorStakeWithReserve(p: Pool, staker: Address | KeyPairSigner, stake: Address, transient: Address, lamports: bigint, transientSeed: bigint) {
    return instruction(Buffer.concat([u8(21), u64(lamports), u64(transientSeed)]), [
      r(p.pool),
      maybe(staker),
      r(p.withdraw),
      w(p.list),
      w(p.reserve),
      w(stake),
      w(transient),
      r(CLOCK),
      r(STAKE_HISTORY),
      r(SYSTEM),
      r(STAKE),
    ]);
  },
  /** Tag 22: Redelegate (refused by the program). */
  redelegate(
    p: Pool,
    staker: Address | KeyPairSigner,
    a: { sourceStake: Address; sourceTransient: Address; ephemeral: Address; destinationTransient: Address; destinationStake: Address; vote: Address },
    lamports: bigint,
    seeds: [bigint, bigint, bigint],
  ) {
    return instruction(Buffer.concat([u8(22), u64(lamports), u64(seeds[0]), u64(seeds[1]), u64(seeds[2])]), [
      r(p.pool),
      maybe(staker),
      r(p.withdraw),
      w(p.list),
      w(p.reserve),
      w(a.sourceStake),
      w(a.sourceTransient),
      w(a.ephemeral),
      w(a.destinationTransient),
      r(a.destinationStake),
      r(a.vote),
      r(CLOCK),
      r(STAKE_HISTORY),
      r(STAKE_CONFIG),
      r(SYSTEM),
      r(STAKE),
    ]);
  },
  /** Raw data and accounts, for malformed instructions. */
  raw(data: Buffer, accounts: Meta[]) {
    return instruction(data, accounts);
  },
};

/** A Borsh String. */
function str(text: string) {
  const b = Buffer.from(text, "utf8");
  return Buffer.concat([u32(b.length), b]);
}

// ---- The two VMs -----------------------------------------------------------------------------------------------------

export interface DiffOptions {
  cluster?: StakeClusterOptions;
}

/**
 * The original and the port side by side, the accounts made in both, and the comparison. Labels name compared
 * transactions; `cu` keeps their compute units (original, port) for the CU table.
 */
export class Diff {
  readonly cu: Record<string, [bigint, bigint]> = {};
  compared = 0;
  /** The original's log lines of the last compared transaction (for messages). */
  lastLogs = "";
  private constructor(
    readonly original: LiteSVM,
    readonly port: LiteSVM,
    readonly cluster: StakeCluster,
  ) {}

  static async create(opts: DiffOptions = {}): Promise<Diff> {
    const port = (await deployFile(PORT, { programId: PROGRAM })).svm;
    const original = new LiteSVM();
    original.addProgram(PROGRAM, new Uint8Array(readFileSync(ORIGINAL)));
    const cluster = new StakeCluster([original, port], opts.cluster);
    return new Diff(original, port, cluster);
  }

  /** Load Metaplex Token Metadata into both VMs. */
  withMetaplex(): this {
    for (const vm of this.vms) vm.addProgramFromFile(MPL_METADATA, MPL_METADATA_SO);
    return this;
  }

  get vms(): readonly [LiteSVM, LiteSVM] {
    return [this.original, this.port];
  }

  /** A keypair with `sol` SOL in both VMs. */
  async funded(sol = 1000n): Promise<KeyPairSigner> {
    const k = await generateKeyPairSigner();
    for (const vm of this.vms) vm.airdrop(k.address, lamports(sol * SOL));
    return k;
  }

  /** Send to both, which must succeed (accounts the tests start from). */
  async setup(payer: KeyPairSigner, ixs: Instruction[]): Promise<void> {
    for (const vm of this.vms) {
      const res = await send(vm, payer, ixs);
      if (res instanceof FailedTransactionMetadata) throw new Error(`setup failed: ${String(res.err())}\n${res.meta().logs().join("\n")}`);
    }
  }

  /** Write the same account into both VMs (rent-exempt for its size unless `lamports` is given). */
  write(at: Address, owner: Address, data: Buffer, lamportsHeld?: bigint): void {
    for (const vm of this.vms)
      vm.setAccount({
        address: at,
        data: new Uint8Array(data),
        executable: false,
        lamports: lamports(lamportsHeld ?? vm.minimumBalanceForRentExemption(BigInt(data.length))),
        programAddress: owner,
        space: BigInt(data.length),
      });
  }

  /** An account's data in the original. */
  data(a: Address): Buffer {
    const acct = this.original.getAccount(a);
    if (!acct.exists) throw new Error(`${a} does not exist`);
    return Buffer.from(acct.data);
  }

  /** Change an account's bytes in both VMs (its lamports and owner kept unless given). */
  patch(a: Address, edit: (data: Buffer) => void, opts: { lamports?: bigint; owner?: Address } = {}): void {
    const acct = this.original.getAccount(a);
    if (!acct.exists) throw new Error(`${a} does not exist`);
    const data = Buffer.from(acct.data);
    edit(data);
    this.write(a, opts.owner ?? acct.programAddress, data, opts.lamports ?? BigInt(acct.lamports));
  }

  /** Move an account to another address in both VMs (the old address is emptied). */
  move(from: Address, to: Address): void {
    const acct = this.original.getAccount(from);
    if (!acct.exists) throw new Error(`${from} does not exist`);
    this.write(to, acct.programAddress, Buffer.from(acct.data), BigInt(acct.lamports));
    this.write(from, SYSTEM, Buffer.alloc(0), 0n);
  }

  /** An account's lamports, owner and data, as compared. */
  bytes(vm: LiteSVM, a: Address): string {
    const acct = vm.getAccount(a);
    return acct.exists ? `${acct.lamports} ${acct.programAddress} ${Buffer.from(acct.data).toString("hex")}` : "missing";
  }

  /**
   * Send to both: the same outcome, the same log lines and the same bytes in every account the transaction names
   * (programs and sysvars aside) and in `watch`. Returns the outcome.
   */
  async both(label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[] = []): Promise<string> {
    const [a, b] = [await send(this.original, payer, ixs), await send(this.port, payer, ixs)];
    this.compared++;
    const logs = (res: Result) => meta(res).logs().join("\n");
    expect(outcome(b), `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toBe(outcome(a));
    expect(lines(b), `${label}: logs\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toEqual(lines(a));
    const named = new Set<Address>(watch);
    for (const i of ixs) for (const m of i.accounts ?? []) named.add(m.address);
    for (const at of named) {
      const acct = this.original.getAccount(at);
      if (acct.exists && acct.executable) continue;
      if (at === CLOCK || at === RENT || at === STAKE_HISTORY || at === STAKE_CONFIG) continue;
      expect(this.bytes(this.port, at), `${label}: ${at}`).toBe(this.bytes(this.original, at));
    }
    this.cu[label] = [meta(a).computeUnitsConsumed(), meta(b).computeUnitsConsumed()];
    this.lastLogs = logs(a);
    return outcome(a);
  }

  /** both(), which must succeed. */
  async ok(label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[] = []): Promise<void> {
    const got = await this.both(label, payer, ixs, watch);
    expect(got, `${label}\n${this.lastLogs}`).toBe("ok");
  }

  /** Move both VMs one epoch on (the StakeHistory gets the ending epoch's entry). */
  nextEpoch(): bigint {
    return this.cluster.nextEpoch();
  }

  // ---- Accounts ----------------------------------------------------------------------------------------------------

  /** A vote account at the same address in both. */
  async vote(payer: KeyPairSigner): Promise<Address> {
    const at = await generateKeyPairSigner();
    const node = await generateKeyPairSigner();
    for (const vm of this.vms) await createVoteAccount(vm, payer, { address: at, node });
    return at.address;
  }

  /** A stake account (Initialized) at the same address in both. */
  async stakeAccount(
    payer: KeyPairSigner,
    opts: { staker: Address; withdrawer: Address; lamports: bigint; lockup?: { unixTimestamp?: bigint; epoch?: bigint; custodian?: Address } },
  ) {
    const at = await generateKeyPairSigner();
    for (const vm of this.vms) await createStakeAccount(vm, payer, { ...opts, address: at });
    return at.address;
  }

  /** A mint of `program` (SPL Token by default), 9 decimals unless given, with Token-2022 extension initializers. */
  async mint(
    payer: KeyPairSigner,
    opts: {
      authority: Address;
      decimals?: number;
      freeze?: Address;
      program?: Address;
      extensions?: t22.ExtensionArgs[];
      init?: (m: Address) => Instruction[];
    } = {
      authority: payer.address,
    },
  ): Promise<Address> {
    const m = await generateKeyPairSigner();
    const program = opts.program ?? TOKEN;
    const size = program === TOKEN || !opts.extensions?.length ? 82 : t22.getMintSize(opts.extensions);
    const init = program === TOKEN ? token.getInitializeMint2Instruction : t22.getInitializeMint2Instruction;
    await this.setup(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: m,
        lamports: this.original.minimumBalanceForRentExemption(BigInt(size)),
        space: size,
        programAddress: program,
      }),
      ...(opts.init ? opts.init(m.address) : []),
      init({ mint: m.address, decimals: opts.decimals ?? 9, mintAuthority: opts.authority, freezeAuthority: opts.freeze ?? null }) as Instruction,
    ]);
    return m.address;
  }

  /** A token account of `mint` held by `owner` (sized for the mint's required account extensions). */
  async tokenAccount(payer: KeyPairSigner, mint: Address, owner: Address, program: Address = TOKEN, extensions: t22.ExtensionArgs[] = []): Promise<Address> {
    const a = await generateKeyPairSigner();
    const size = program === TOKEN || !extensions.length ? 165 : t22.getTokenSize(extensions);
    const init = program === TOKEN ? token.getInitializeAccount3Instruction : t22.getInitializeAccount3Instruction;
    await this.setup(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: a,
        lamports: this.original.minimumBalanceForRentExemption(BigInt(size)),
        space: size,
        programAddress: program,
      }),
      init({ account: a.address, mint, owner }) as Instruction,
    ]);
    return a.address;
  }

  /** An empty account of `space` bytes owned by `owner` (the pool's own accounts are allocated so, then initialized). */
  async allocated(payer: KeyPairSigner, space: bigint, owner: Address, extraLamports = 0n): Promise<Address> {
    const a = await generateKeyPairSigner();
    await this.setup(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: a,
        lamports: this.original.minimumBalanceForRentExemption(space) + extraLamports,
        space,
        programAddress: owner,
      }),
    ]);
    return a.address;
  }

  /** A token account's amount in the original (both are compared anyway). */
  tokenBalance(a: Address): bigint {
    const acct = this.original.getAccount(a);
    if (!acct.exists) return 0n;
    return Buffer.from(acct.data).readBigUInt64LE(64);
  }

  lamports(a: Address): bigint {
    const acct = this.original.getAccount(a);
    return acct.exists ? BigInt(acct.lamports) : 0n;
  }

  /** The stake account's state in the original. */
  stake(a: Address) {
    return readStakeAccount(this.original, a);
  }

  // ---- A pool ------------------------------------------------------------------------------------------------------

  /**
   * The accounts of a new pool, as the CLI makes them (pool account of 611 bytes, a validator list for
   * `maxValidators`, a reserve stake account of the withdraw authority holding `reserveLamports` past its rent, a
   * mint of the withdraw authority, the manager's fee account), not initialized yet.
   */
  async poolAccounts(
    payer: KeyPairSigner,
    opts: {
      maxValidators?: number;
      reserveLamports?: bigint;
      tokenProgram?: Address;
      mintExtensions?: t22.ExtensionArgs[];
      mintInit?: (m: Address) => Instruction[];
    } = {},
  ): Promise<Pool> {
    const maxValidators = opts.maxValidators ?? 10;
    const tokenProgram = opts.tokenProgram ?? TOKEN;
    const manager = await this.funded(100n);
    const staker = await this.funded(100n);
    const pool = await this.allocated(payer, STAKE_POOL_SIZE, PROGRAM);
    const list = await this.allocated(payer, BigInt(9 + 73 * maxValidators), PROGRAM);
    const withdraw = await withdrawAuthority(pool);
    const reserve = await this.stakeAccount(payer, {
      staker: withdraw,
      withdrawer: withdraw,
      lamports: this.original.minimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE) + (opts.reserveLamports ?? 0n),
    });
    const mint = await this.mint(payer, { authority: withdraw, program: tokenProgram, extensions: opts.mintExtensions, init: opts.mintInit });
    const accountExtensions: t22.ExtensionArgs[] = (opts.mintExtensions ?? []).some((e) => e.__kind === "TransferFeeConfig")
      ? [{ __kind: "TransferFeeAmount", withheldAmount: 0n }]
      : [];
    const managerFee = await this.tokenAccount(payer, mint, manager.address, tokenProgram, accountExtensions);
    return { pool, list, reserve, mint, managerFee, withdraw, deposit: await depositAuthority(pool), tokenProgram, manager, staker, maxValidators };
  }

  /** A new, initialized pool (Initialize through both()). */
  async createPool(
    payer: KeyPairSigner,
    opts: {
      maxValidators?: number;
      reserveLamports?: bigint;
      tokenProgram?: Address;
      mintExtensions?: t22.ExtensionArgs[];
      mintInit?: (m: Address) => Instruction[];
      epochFee?: Fee;
      withdrawalFee?: Fee;
      depositFee?: Fee;
      referral?: number;
      depositAuthority?: KeyPairSigner;
      label?: string;
    } = {},
  ): Promise<Pool> {
    const p = await this.poolAccounts(payer, opts);
    await this.ok(opts.label ?? "initialize", payer, [
      ix.initialize(
        { ...p, manager: p.manager, staker: p.staker.address },
        {
          epoch: opts.epochFee ?? fee(3n, 100n),
          withdrawal: opts.withdrawalFee ?? fee(1n, 1000n),
          deposit: opts.depositFee ?? fee(1n, 1000n),
          referral: opts.referral ?? 50,
          maxValidators: p.maxValidators,
        },
        opts.depositAuthority,
      ),
    ]);
    if (opts.depositAuthority) p.deposit = opts.depositAuthority.address;
    return p;
  }

  /** The validator list's entries in the original (vote, status, active, transient, last update epoch). */
  validators(p: Pool) {
    const list = this.original.getAccount(p.list);
    if (!list.exists) return [];
    const data = Buffer.from(list.data);
    const n = data.readUInt32LE(5);
    const out: { vote: Address; status: number; active: bigint; transient: bigint; epoch: bigint; transientSeed: bigint; seed: number }[] = [];
    const dec = (b: Buffer) => address(bs58(b));
    for (let i = 0; i < n; i++) {
      const o = 9 + 73 * i;
      out.push({
        active: data.readBigUInt64LE(o),
        transient: data.readBigUInt64LE(o + 8),
        epoch: data.readBigUInt64LE(o + 16),
        transientSeed: data.readBigUInt64LE(o + 24),
        seed: data.readUInt32LE(o + 36),
        status: data[o + 40]!,
        vote: dec(data.subarray(o + 41, o + 73)),
      });
    }
    return out;
  }
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 of 32 bytes. */
function bs58(b: Buffer): string {
  let n = BigInt(`0x${b.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of b) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The validator stake and transient stake accounts of a pool's validators, for UpdateValidatorListBalance. */
export async function updatePairs(d: Diff, p: Pool, from = 0, count?: number): Promise<[Address, Address][]> {
  const list = d.validators(p).slice(from, count === undefined ? undefined : from + count);
  return Promise.all(
    list.map(async (v) => [await validatorStake(v.vote, p.pool, v.seed), await transientStake(v.vote, p.pool, v.transientSeed)] as [Address, Address]),
  );
}

// ---- Raw token accounts (spl-token / Token-2022 layouts), for states the token programs would not make ------------

export const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
/** One Token-2022 extension entry (type, length, value). */
export const tlv = (type: number, value: Buffer) => Buffer.concat([u16(type), u16(value.length), value]);

/** A mint's bytes: the 82-byte base and, with `tlv`, the padding, the Mint account-type byte and the entries. */
export function mintBytes(o: {
  authority?: Address | null;
  supply?: bigint;
  decimals?: number;
  initialized?: number;
  freeze?: Address | null;
  tlv?: Buffer;
}): Buffer {
  const b = Buffer.alloc(82);
  if (o.authority) {
    b.writeUInt32LE(1, 0);
    key(o.authority).copy(b, 4);
  }
  b.writeBigUInt64LE(o.supply ?? 0n, 36);
  b[44] = o.decimals ?? 9;
  b[45] = o.initialized ?? 1;
  if (o.freeze) {
    b.writeUInt32LE(1, 46);
    key(o.freeze).copy(b, 50);
  }
  return o.tlv ? Buffer.concat([b, Buffer.alloc(83), u8(1), o.tlv]) : b;
}

/** A token account's bytes: the 165-byte base and, with `tlv`, the Account account-type byte and the entries. */
export function tokenAccountBytes(o: { mint: Address; owner: Address; amount?: bigint; state?: number; tlv?: Buffer }): Buffer {
  const b = Buffer.alloc(165);
  key(o.mint).copy(b, 0);
  key(o.owner).copy(b, 32);
  b.writeBigUInt64LE(o.amount ?? 0n, 64);
  b[108] = o.state ?? 1;
  return o.tlv ? Buffer.concat([b, u8(2), o.tlv]) : b;
}

/** Offsets in a StakeStateV2 (the Meta's authorities, the Delegation's epochs). */
export const STAKE_OFFSETS = { staker: 12, withdrawer: 44, voter: 124, stake: 156, activation: 164, deactivation: 172 } as const;
