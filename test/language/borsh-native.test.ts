// loadBorsh / storeBorsh (test/fixtures/borsh-native.ts): a native program's Borsh accounts read into a local struct
// and written back, byte for byte as Rust's try_from_slice_unchecked / serialize do it, checked against a Borsh encoder
// written here: every field kind, Options both ways with the bytes after the value left as they were, data enums,
// nested structs, the BorshIoError cases, and SPL Stake Pool's StakePool (program@v2.1.0 state.rs).
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, compileErrors, customError, deployFile, expectOk, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const enc = getAddressEncoder();
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");

/** A Borsh writer: little-endian integers, then the bytes. */
class W {
  parts: Buffer[] = [];
  int(n: bigint, bytes: number, signed = false) {
    const b = Buffer.alloc(bytes);
    let v = signed && n < 0n ? (1n << BigInt(bytes * 8)) + n : n;
    for (let i = 0; i < bytes; i++, v >>= 8n) b[i] = Number(v & 0xffn);
    this.parts.push(b);
    return this;
  }
  u8 = (n: bigint | number) => this.int(BigInt(n), 1);
  bool = (b: boolean) => this.u8(b ? 1 : 0);
  key = (k: Address) => (this.parts.push(Buffer.from(enc.encode(k))), this);
  str = (s: string) => (this.int(BigInt(Buffer.byteLength(s)), 4), this.parts.push(Buffer.from(s)), this);
  opt = <T>(v: T | null, f: (v: T) => void) => (this.u8(v === null ? 0 : 1), v !== null && f(v), this);
  bytes = () => Buffer.concat(this.parts);
}

interface Inner {
  a: bigint;
  flag: boolean;
  when: bigint | null;
}
interface Point {
  x: bigint;
  y: bigint;
}
type Shape = { kind: "Dot" } | { kind: "Box"; w: bigint; h: bigint } | { kind: "At"; p: Point };
interface Kitchen {
  small: bigint;
  half: bigint;
  word: bigint;
  big: bigint;
  huge: bigint;
  neg: bigint;
  stamp: bigint;
  wide: bigint;
  flag: boolean;
  key: Address;
  kind: number;
  arr: bigint[];
  name: string;
  list: bigint[];
  optKey: Address | null;
  optNum: bigint | null;
  optPoint: Point | null;
  optInner: Inner | null;
  optArr: bigint[] | null;
  inner: Inner;
  point: Point;
  shape: Shape;
  tail: bigint;
}

const inner = (w: W, i: Inner) =>
  w
    .int(i.a, 2)
    .bool(i.flag)
    .opt(i.when, (v) => w.int(v, 4));
const point = (w: W, p: Point) => w.int(p.x, 4, true).int(p.y, 4, true);
function encodeKitchen(k: Kitchen): Buffer {
  const w = new W();
  w.u8(k.small).int(k.half, 2).int(k.word, 4).int(k.big, 8).int(k.huge, 16).int(k.neg, 1, true).int(k.stamp, 8, true).int(k.wide, 16, true);
  w.bool(k.flag).key(k.key).u8(k.kind);
  for (const a of k.arr) w.int(a, 2);
  w.str(k.name).int(BigInt(k.list.length), 4);
  for (const x of k.list) w.int(x, 4);
  w.opt(k.optKey, (v) => w.key(v));
  w.opt(k.optNum, (v) => w.int(v, 8));
  w.opt(k.optPoint, (v) => point(w, v));
  w.opt(k.optInner, (v) => inner(w, v));
  w.opt(k.optArr, (v) => v.forEach((x) => w.int(x, 2)));
  inner(w, k.inner);
  point(w, k.point);
  w.u8(["Dot", "Box", "At"].indexOf(k.shape.kind));
  if (k.shape.kind === "Box") w.int(k.shape.w, 8).int(k.shape.h, 8);
  if (k.shape.kind === "At") point(w, k.shape.p);
  return w.int(k.tail, 8).bytes();
}

interface Fee {
  denominator: bigint;
  numerator: bigint;
}
type FutureEpoch = { kind: "None" } | { kind: "One"; fee: Fee } | { kind: "Two"; fee: Fee };
interface StakePool {
  accountType: number;
  manager: Address;
  staker: Address;
  stakeDepositAuthority: Address;
  stakeWithdrawBumpSeed: number;
  validatorList: Address;
  reserveStake: Address;
  poolMint: Address;
  managerFeeAccount: Address;
  tokenProgramId: Address;
  totalLamports: bigint;
  poolTokenSupply: bigint;
  lastUpdateEpoch: bigint;
  lockup: { unixTimestamp: bigint; epoch: bigint; custodian: Address };
  epochFee: Fee;
  nextEpochFee: FutureEpoch;
  preferredDepositValidatorVoteAddress: Address | null;
  preferredWithdrawValidatorVoteAddress: Address | null;
  stakeDepositFee: Fee;
  stakeWithdrawalFee: Fee;
  nextStakeWithdrawalFee: FutureEpoch;
  stakeReferralFee: number;
  solDepositAuthority: Address | null;
  solDepositFee: Fee;
  solReferralFee: number;
  solWithdrawAuthority: Address | null;
  solWithdrawalFee: Fee;
  nextSolWithdrawalFee: FutureEpoch;
  lastEpochPoolTokenSupply: bigint;
  lastEpochTotalLamports: bigint;
}
/** StakePool as `#[derive(BorshSerialize)]` writes it (the field order of program/src/state.rs). */
function encodePool(p: StakePool): Buffer {
  const w = new W();
  const fee = (f: Fee) => w.int(f.denominator, 8).int(f.numerator, 8);
  const future = (f: FutureEpoch) => (w.u8(["None", "One", "Two"].indexOf(f.kind)), f.kind !== "None" && fee(f.fee));
  w.u8(p.accountType).key(p.manager).key(p.staker).key(p.stakeDepositAuthority).u8(p.stakeWithdrawBumpSeed);
  w.key(p.validatorList).key(p.reserveStake).key(p.poolMint).key(p.managerFeeAccount).key(p.tokenProgramId);
  w.int(p.totalLamports, 8).int(p.poolTokenSupply, 8).int(p.lastUpdateEpoch, 8);
  w.int(p.lockup.unixTimestamp, 8, true).int(p.lockup.epoch, 8).key(p.lockup.custodian);
  fee(p.epochFee);
  future(p.nextEpochFee);
  w.opt(p.preferredDepositValidatorVoteAddress, (k) => w.key(k));
  w.opt(p.preferredWithdrawValidatorVoteAddress, (k) => w.key(k));
  fee(p.stakeDepositFee);
  fee(p.stakeWithdrawalFee);
  future(p.nextStakeWithdrawalFee);
  w.u8(p.stakeReferralFee);
  w.opt(p.solDepositAuthority, (k) => w.key(k));
  fee(p.solDepositFee);
  w.u8(p.solReferralFee);
  w.opt(p.solWithdrawAuthority, (k) => w.key(k));
  fee(p.solWithdrawalFee);
  future(p.nextSolWithdrawalFee);
  return w.int(p.lastEpochPoolTokenSupply, 8).int(p.lastEpochTotalLamports, 8).bytes();
}
/** solana_program's get_packed_len::<StakePool>(): the size SPL Stake Pool allocates. */
const STAKE_POOL_LEN = 611;

const key = async () => (await generateKeyPairSigner()).address;
/** `before` with its first `encoded.length` bytes replaced: what Rust's serialize into the account leaves. */
const over = (before: Buffer, encoded: Buffer) => Buffer.concat([encoded, before.subarray(encoded.length)]);

describe("loadBorsh / storeBorsh", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let k1: Address;
  let k2: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/borsh-native.ts", import.meta.url)));
    payer = await fundedSigner(d.svm);
    [k1, k2] = [await key(), await key()];
  });

  const put = async (data: Buffer, programAddress: Address = d.programId) => {
    const address = await key();
    d.svm.setAccount({ address, lamports: 100_000_000n, programAddress, executable: false, data: new Uint8Array(data) } as never);
    return address;
  };
  const bytes = (a: Address) => {
    const acct = d.svm.getAccount(a);
    if (!acct.exists) throw new Error("account is gone");
    return Buffer.from(acct.data);
  };
  const raw = (data: Buffer, accounts: { address: Address; writable?: boolean }[]) =>
    ({
      programAddress: d.programId,
      accounts: accounts.map((a) => ({ address: a.address, role: a.writable === false ? AccountRole.READONLY : AccountRole.WRITABLE })),
      data: new Uint8Array(data),
    }) as Instruction;
  const call = (tag: number, accounts: (Address | { address: Address; writable?: boolean })[], extra = Buffer.alloc(0)) =>
    send(d.svm, payer, [
      raw(
        Buffer.concat([Buffer.from([tag]), extra]),
        accounts.map((a) => (typeof a === "string" ? { address: a } : a)),
      ),
    ]);
  const borshIoError = (r: Result) => {
    // ProgramError::BorshIoError (the built-in error 15 << 32): the runtime reports InstructionError::BorshIoError.
    expect(err(r)).toBe("TransactionErrorInstructionError { index: 0, error: BorshIoError }");
    expect(logs(r)).toContain("Program log: Program error: BorshIoError");
  };

  const kitchen = (over: Partial<Kitchen> = {}): Kitchen => ({
    small: 250n,
    half: 0xbeefn,
    word: 0xdeadbeefn,
    big: 2n ** 64n - 2n,
    huge: 2n ** 127n + 5n,
    neg: -7n,
    stamp: -1_700_000_000n,
    wide: -(2n ** 100n),
    flag: true,
    key: k1,
    kind: 1,
    arr: [1n, 2n, 65535n],
    name: "héllo",
    list: [10n, 20n, 30n],
    optKey: k2,
    optNum: 99n,
    optPoint: { x: -5n, y: 6n },
    optInner: { a: 300n, flag: false, when: 12n },
    optArr: [7n, 8n, 9n],
    inner: { a: 4n, flag: true, when: 77n },
    point: { x: 2147483647n, y: -2147483648n },
    shape: { kind: "Box", w: 3n, h: 4n },
    tail: 0x0123456789abcdefn,
    ...over,
  });
  const none: Partial<Kitchen> = { optKey: null, optNum: null, optPoint: null, optInner: null, optArr: null, inner: { a: 4n, flag: true, when: null } };

  it("reads every field kind and writes it back byte for byte, leaving the bytes after it", async () => {
    for (const k of [
      kitchen(),
      kitchen(none),
      kitchen({ shape: { kind: "Dot" }, list: [], name: "" }),
      kitchen({ shape: { kind: "At", p: { x: -1n, y: 1n } }, list: [1n, 2n, 3n, 4n], name: "twelve bytes" }),
    ]) {
      const e = encodeKitchen(k);
      const src = await put(Buffer.concat([e, randomBytes(9)])); // trailing bytes are ignored
      const dstBefore = randomBytes(e.length + 40);
      const dst = await put(dstBefore);
      expectOk(await call(0, [src, dst]));
      expect(bytes(dst).equals(over(dstBefore, e))).toBe(true);
      // The same through a helper taking RemainingAccounts.
      const dst2Before = randomBytes(e.length + 3);
      const dst2 = await put(dst2Before);
      expectOk(await call(7, [src, dst2]));
      expect(bytes(dst2).equals(over(dst2Before, e))).toBe(true);
    }
  });

  it("updates a local and writes it back: Options both ways, data enum variants, the tail kept as Rust leaves it", async () => {
    // Some -> None: the encoding shrinks, the old bytes after it stay.
    let k = kitchen({ big: 5n });
    const start = Buffer.concat([encodeKitchen(k), Buffer.alloc(16, 0xee)]);
    const a = await put(start);
    expectOk(await call(1, [a]));
    const flip = (k: Kitchen, self: Address): Kitchen => ({
      ...k,
      optKey: k.optKey === null ? self : null,
      optNum: k.optNum === null ? 7n : null,
      optPoint: k.optPoint === null ? { x: -3n, y: 4n } : null,
      optInner: k.optInner === null ? { a: 9n, flag: true, when: 70000n } : null,
      optArr: null,
      inner: { ...k.inner, when: k.inner.when === null ? 11n : null },
      shape: k.shape.kind === "Dot" ? { kind: "Box", w: 1n, h: 2n } : k.shape.kind === "Box" ? { kind: "At", p: { x: -1n, y: 2n } } : { kind: "Dot" },
      big: k.big + 1n,
      flag: !k.flag,
      kind: 2,
      name: "renamed",
      list: k.list.length < 4 ? [...k.list, 42n] : k.list,
    });
    let before = start;
    for (let round = 0; round < 4; round++) {
      if (round > 0) expectOk(await call(1, [a]));
      k = flip(k, a);
      const e = encodeKitchen(k);
      const after = bytes(a);
      expect(after.equals(over(before, e))).toBe(true);
      // Shrinking left stale bytes behind the value (not zeroed), exactly as they were.
      if (round === 0) expect(e.length).toBeLessThan(encodeKitchen(kitchen()).length);
      before = after;
    }
  });

  it("writes a struct literal", async () => {
    const a = await put(Buffer.alloc(10, 0xaa));
    expectOk(await call(6, [a]));
    expect([...bytes(a)]).toEqual([0x01, 0x02, 1, 0, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
  });

  it("takes AccountInfo parameters (no owner check: another program's account reads too)", async () => {
    const k = kitchen({ shape: { kind: "Dot" } });
    const e = encodeKitchen(k);
    const src = await put(e, k2); // owned by someone else: loadBorsh does not check
    const dstBefore = randomBytes(e.length);
    const dst = await put(dstBefore);
    const disc = d.idl.instructions.find((i) => i.name === "via_params" || i.name === "viaParams")!.discriminator;
    const r = expectOk(
      await send(d.svm, payer, [
        {
          programAddress: d.programId,
          accounts: [
            { address: src, role: AccountRole.READONLY },
            { address: dst, role: AccountRole.WRITABLE },
          ],
          data: new Uint8Array(disc),
        } as Instruction,
      ]),
    );
    expect(r.logs()).toContain(`Program log: big ${k.big} ${k.big}`);
    expect(bytes(dst).equals(e)).toBe(true);
  });

  it("fails with BorshIoError on bytes that are not a valid value", async () => {
    const e = encodeKitchen(kitchen());
    const read = async (data: Buffer) => call(5, [await put(data)]);
    expect(logs(expectOk(await read(e)))).toContain(`Program log: tail ${kitchen().tail}`);
    // Offsets of the tag/flag bytes in the encoding of kitchen().
    const flagAt = 1 + 2 + 4 + 8 + 16 + 1 + 8 + 16;
    const kindAt = flagAt + 1 + 32;
    const nameAt = kindAt + 1 + 6;
    const listAt = nameAt + 4 + Buffer.byteLength("héllo");
    const optKeyAt = listAt + 4 + 12;
    const shapeAt = e.length - 8 - 1 - 16;
    expect(e[shapeAt]).toBe(1); // Box
    const bad = (at: number, v: number) => {
      const b = Buffer.from(e);
      b[at] = v;
      return b;
    };
    borshIoError(await read(e.subarray(0, e.length - 1))); // truncated
    borshIoError(await read(Buffer.alloc(0)));
    borshIoError(await read(bad(flagAt, 2))); // a bool not 0/1
    borshIoError(await read(bad(kindAt, 3))); // a unit enum tag out of range
    borshIoError(await read(bad(optKeyAt, 2))); // an Option tag not 0/1
    borshIoError(await read(bad(shapeAt, 3))); // a data enum tag out of range
    borshIoError(await read(bad(nameAt + 4, 0xff))); // a String that is not UTF-8
    borshIoError(await read(bad(nameAt, 13))); // longer than the FixedString<12>
    borshIoError(await read(bad(listAt, 5))); // longer than the FixedVec<u32, 4>
    // An Option<Inner>'s nested bool, past the variable-length part.
    const k = kitchen({ optKey: null, optNum: null, optPoint: null });
    const e2 = encodeKitchen(k);
    const innerFlag = optKeyAt + 3 + 1 + 2;
    expect(e2[innerFlag]).toBe(0);
    borshIoError(await read(Buffer.from(e2).fill(9, innerFlag, innerFlag + 1)));
    expectOk(await read(Buffer.concat([e2, Buffer.alloc(100, 0xff)])));
  });

  it("fails with BorshIoError when the encoding does not fit, and on a read-only account", async () => {
    const e = encodeKitchen(kitchen());
    const src = await put(e);
    borshIoError(await call(0, [src, await put(Buffer.alloc(e.length - 1))]));
    expectOk(await call(0, [src, await put(Buffer.alloc(e.length))]));
    // A remaining account passed read-only: 3006 (AccountNotMutable), before any byte is written.
    const ro = await put(Buffer.alloc(e.length + 8));
    expect(customError(await call(0, [src, { address: ro, writable: false }]))).toBe(3006);
    expect(bytes(ro).equals(Buffer.alloc(e.length + 8))).toBe(true);
  });

  describe("SPL Stake Pool's StakePool", () => {
    const fee = (numerator: bigint, denominator: bigint): Fee => ({ numerator, denominator });
    const pool = async (over: Partial<StakePool> = {}): Promise<StakePool> => ({
      accountType: 1,
      manager: await key(),
      staker: await key(),
      stakeDepositAuthority: await key(),
      stakeWithdrawBumpSeed: 254,
      validatorList: await key(),
      reserveStake: await key(),
      poolMint: await key(),
      managerFeeAccount: await key(),
      tokenProgramId: await key(),
      totalLamports: 5_000_000_000_000n,
      poolTokenSupply: 4_800_000_000_000n,
      lastUpdateEpoch: 812n,
      lockup: { unixTimestamp: -3n, epoch: 9n, custodian: await key() },
      epochFee: fee(3n, 100n),
      nextEpochFee: { kind: "Two", fee: fee(5n, 100n) },
      preferredDepositValidatorVoteAddress: null,
      preferredWithdrawValidatorVoteAddress: await key(),
      stakeDepositFee: fee(0n, 1000n),
      stakeWithdrawalFee: fee(1n, 1000n),
      nextStakeWithdrawalFee: { kind: "One", fee: fee(2n, 1000n) },
      stakeReferralFee: 50,
      solDepositAuthority: await key(),
      solDepositFee: fee(0n, 0n),
      solReferralFee: 0,
      solWithdrawAuthority: null,
      solWithdrawalFee: fee(1n, 200n),
      nextSolWithdrawalFee: { kind: "None" },
      lastEpochPoolTokenSupply: 4_700_000_000_000n,
      lastEpochTotalLamports: 4_900_000_000_000n,
      ...over,
    });
    /** What fixture tag 2 does to a pool. */
    const update = (p: StakePool, add: bigint): StakePool => {
      const next = { ...p };
      next.totalLamports += add;
      next.poolTokenSupply += p.stakeWithdrawalFee.denominator === 0n ? 0n : (1000n * p.stakeWithdrawalFee.numerator) / p.stakeWithdrawalFee.denominator;
      next.preferredDepositValidatorVoteAddress = p.preferredDepositValidatorVoteAddress === null ? p.manager : null;
      next.preferredWithdrawValidatorVoteAddress = null;
      next.solDepositAuthority = null;
      if (p.nextEpochFee.kind === "One") [next.epochFee, next.nextEpochFee] = [p.nextEpochFee.fee, { kind: "None" }];
      else if (p.nextEpochFee.kind === "Two") next.nextEpochFee = { kind: "One", fee: p.nextEpochFee.fee };
      if (p.nextSolWithdrawalFee.kind === "None") next.nextSolWithdrawalFee = { kind: "Two", fee: fee(3n, 100n) };
      return next;
    };
    const full = async () =>
      pool({
        preferredDepositValidatorVoteAddress: await key(),
        solWithdrawAuthority: await key(),
        nextSolWithdrawalFee: { kind: "Two", fee: fee(1n, 10n) },
      });

    it("mirrors state.rs: 611 bytes with every Option Some and every FutureEpoch set", async () => {
      expect(encodePool(await full()).length).toBe(STAKE_POOL_LEN);
      expect(encodePool(await pool({ nextEpochFee: { kind: "None" }, nextStakeWithdrawalFee: { kind: "None" } })).length).toBe(
        STAKE_POOL_LEN - 32 - 32 - 16 - 16 - 16, // two Options None, three FutureEpochs None
      );
    });

    it("reads, updates and writes back a pool account as the program does", async () => {
      let p = await pool();
      const a = await put(Buffer.concat([encodePool(p), Buffer.alloc(STAKE_POOL_LEN - encodePool(p).length)]));
      let before = bytes(a);
      for (const add of [1_000n, 2_000n, 3_000n]) {
        const withdraw = p.preferredWithdrawValidatorVoteAddress;
        const r = expectOk(await call(2, [a], Buffer.from(BigUint64Array.of(add).buffer)));
        const next = update(p, add);
        expect(r.logs()).toContain(`Program log: before ${p.totalLamports} after ${next.totalLamports}`);
        expect(r.logs()).toContain(`Program log: epoch fee ${next.epochFee.numerator}/${next.epochFee.denominator}`);
        if (withdraw) expect(r.logs()).toContain(`Program log: ${withdraw}`);
        const after = bytes(a);
        expect(after.length).toBe(STAKE_POOL_LEN);
        expect(after.equals(over(before, encodePool(next)))).toBe(true);
        [p, before] = [next, after];
      }
      // A pool that is not a StakePool (account_type checked by the program itself).
      const other = await put(Buffer.concat([encodePool(await pool({ accountType: 2 })), Buffer.alloc(100)]));
      expect(err(await call(2, [other], Buffer.alloc(8)))).toMatch(/InvalidAccountData/);
    });

    it("costs little compute for a 611-byte pool", async () => {
      const e = encodePool(await full());
      const a = await put(e);
      const cu = async (tag: number) => expectOk(await call(tag, [a])).computeUnitsConsumed();
      const base = await cu(4);
      const load = (await cu(8)) - base;
      const loadStore = (await cu(3)) - base;
      console.log(`loadBorsh<StakePool> (611 bytes): ${load} CU; loadBorsh + storeBorsh: ${loadStore} CU (baseline ${base} CU)`);
      expect(bytes(a).equals(e)).toBe(true);
      expect(load).toBeLessThan(400n);
      expect(loadStore).toBeLessThan(800n);
    });
  });

  it("refuses what it cannot compile, with the fix", () => {
    const head = `import { type AccountInfo, type Mut, type Signer, type Option, type Pubkey, type Vec, type u64, loadBorsh, storeBorsh, log, remainingAccounts } from "typesol";
export interface P { a: u64; b: Option<Pubkey> }
export interface Q { a: u64 }
`;
    const errs = (body: string, extra = "") => compileErrors(head + extra + body);
    // In a helper, from its AccountInfo or RemainingAccount parameter, in a loop body, and a typed binding.
    expect(
      errs(`function h(a: AccountInfo): u64 { const p = loadBorsh<P>(a); return p.a; }
export function f(acct: Mut<AccountInfo>): void {
  const rest = remainingAccounts();
  for (let i = 0n; i < rest.length; i++) { const q: P = loadBorsh(rest.get(i)); q.b = null; storeBorsh(rest.get(i), q); }
  log(\`\${h(acct)}\`);
}`),
    ).toBe("");
    expect(errs(`export function f(acct: AccountInfo): void { const p = loadBorsh(acct); }`)).toMatch(
      /loadBorsh needs a struct type: const pool = loadBorsh<MyStruct>\(account\)/,
    );
    expect(errs(`export function f(acct: AccountInfo): void { const p = loadBorsh<u64>(acct); }`)).toMatch(/loadBorsh needs a struct type/);
    expect(errs(`export function f(acct: AccountInfo): void { let p = loadBorsh<P>(acct); }`)).toMatch(/bind loadBorsh<T>\(\.\.\.\) with const/);
    expect(errs(`export function f(acct: AccountInfo): void { log(loadBorsh<P>(acct).a); }`)).toMatch(/bind loadBorsh<T>\(\.\.\.\) to a const first/);
    expect(errs(`export function f(acct: AccountInfo): void { const p: Q = loadBorsh<P>(acct); }`)).toMatch(/loadBorsh<P> is bound to a Q|not assignable/);
    expect(errs(`export function f(s: Signer): void { const p = loadBorsh<P>(s); }`)).toMatch(
      /'Signer' is not assignable to parameter of type 'RemainingAccount \| AccountInfo'/,
    );
    expect(errs(`export function f(acct: AccountInfo): void { const p = loadBorsh<P>(acct); storeBorsh(acct, p); }`)).toMatch(
      /acct must be Mut<AccountInfo> to write it with storeBorsh/,
    );
    expect(errs(`export function f(acct: Mut<AccountInfo>): void { storeBorsh(acct, 5n); }`)).toMatch(/storeBorsh writes a struct value/);
    expect(errs(`export function f(acct: Mut<AccountInfo>): void { storeBorsh(acct, { a: 1n }); }`)).toMatch(
      /storeBorsh needs the struct type for an object literal: storeBorsh<MyStruct>/,
    );
    expect(errs(`export function f(acct: Mut<AccountInfo>): void { const p = loadBorsh<P>(acct); storeBorsh<Q>(acct, p); }`)).toMatch(
      /expected a Q, got a P|not assignable/,
    );
    expect(
      errs(`export function f(acct: AccountInfo): void { const v = loadBorsh<V>(acct); }`, `/** @layout borsh */\nexport interface V { items: Vec<u64> }\n`),
    ).toMatch(/loadBorsh cannot take V: V has a Vec<T> field \(it would live on the heap\): use FixedVec<T, N>|V\.items is a Vec<T>/);
    expect(
      errs(
        `export function f(acct: AccountInfo): void { const v = loadBorsh<V>(acct); }`,
        `export type Say = { kind: "Hi"; text: string } | { kind: "Bye" };\n/** @layout borsh */\nexport interface V { say: Say }\n`,
      ),
    ).toMatch(/loadBorsh cannot take V/);
  });
});
