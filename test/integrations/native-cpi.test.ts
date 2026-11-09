// Typed CPIs from a native program (test/fixtures/native-cpi.ts): programAt<P>(remaining account) and the System,
// Token and Stake methods with remaining accounts, against the real Stake and Vote programs; the same calls written
// with invoke for the compute units; and the compile errors.
import { getCreateAccountInstruction } from "@solana-program/system";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, TOKEN_PROGRAM, SYSTEM_PROGRAM, compileErrors, customError, deployFile, expectOk, fundedSigner, pda, send } from "../harness.js";

const STAKE = "Stake11111111111111111111111111111111111111" as Address;
const VOTE = "Vote111111111111111111111111111111111111111" as Address;
const CONFIG = "StakeConfig11111111111111111111111111111111" as Address;
const RENT = "SysvarRent111111111111111111111111111111111" as Address;
const CLOCK = "SysvarC1ock11111111111111111111111111111111" as Address;
const HISTORY = "SysvarStakeHistory1111111111111111111111111" as Address;
const SOL = 1_000_000_000n;
const enc = getAddressEncoder();
const key = (a: Address) => Buffer.from(enc.encode(a));
const u64 = (n: bigint) => Buffer.from(BigUint64Array.of(n).buffer);
type Result = TransactionMetadata | FailedTransactionMetadata;
type Meta = { address: Address; writable?: boolean; signer?: KeyPairSigner };
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
/** The values logged with log(u64) (sol_log_64's last field). */
const logged = (r: Result) =>
  logs(r).flatMap((l) => {
    const m = /^Program log: (\d+)$/.exec(l);
    return m ? [BigInt(m[1]!)] : [];
  });

describe("typed CPIs from a native program (test/fixtures/native-cpi.ts)", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let authority: Address;
  let bump: number;
  let vote: Address;
  const cu: Record<string, [bigint, bigint]> = {};

  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/native-cpi.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 1000n);
    [authority, bump] = await pda(d.programId, ["authority"]);
    // A vote account: created (3762 bytes), then VoteInstruction::InitializeAccount (u32 0, VoteInit { node, voter,
    // withdrawer, commission }) with the vote account, Rent, Clock and the node (signing).
    const v = await generateKeyPairSigner();
    const node = await fundedSigner(d.svm);
    const data = Buffer.alloc(4 + 32 * 3 + 1);
    [node.address, node.address, node.address].forEach((k, i) => key(k).copy(data, 4 + 32 * i));
    expectOk(
      await send(d.svm, payer, [
        getCreateAccountInstruction({ payer, newAccount: v, lamports: d.svm.minimumBalanceForRentExemption(3762n), space: 3762n, programAddress: VOTE }),
        {
          programAddress: VOTE,
          accounts: [
            { address: v.address, role: AccountRole.WRITABLE },
            { address: RENT, role: AccountRole.READONLY },
            { address: CLOCK, role: AccountRole.READONLY },
            { address: node.address, role: AccountRole.READONLY_SIGNER, signer: node },
          ],
          data: new Uint8Array(data),
        } as Instruction,
      ]),
    );
    vote = v.address;
  });

  const callAt = (program: Address, tag: number, extra: Buffer, accounts: Meta[], signer = payer) =>
    send(d.svm, signer, [
      {
        programAddress: program,
        accounts: accounts.map((a) => ({
          address: a.address,
          role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
          ...(a.signer ? { signer: a.signer } : {}),
        })),
        data: new Uint8Array(Buffer.concat([Buffer.from([tag]), extra])),
      } as Instruction,
    ]);
  const call = (tag: number, extra: Buffer, accounts: Meta[], signer = payer) => callAt(d.programId, tag, extra, accounts, signer);
  const units = (r: Result) => expectOk(r).computeUnitsConsumed();
  const b = () => Buffer.from([bump]);

  /** An empty stake account: 200 bytes owned by the Stake program, `sol` above rent. */
  async function blank(sol: bigint) {
    const s = await generateKeyPairSigner();
    const lamports = d.svm.minimumBalanceForRentExemption(200n) + sol * SOL;
    expectOk(await send(d.svm, payer, [getCreateAccountInstruction({ payer, newAccount: s, lamports, space: 200n, programAddress: STAKE })]));
    return s.address;
  }
  /** A stake initialized through programAt (tag 0), the PDA its staker and withdrawer unless given. */
  async function stakeAccount(sol: bigint, staker = authority, withdrawer = authority) {
    const s = await blank(sol);
    expectOk(await call(0, Buffer.concat([key(staker), key(withdrawer)]), [{ address: s, writable: true }, { address: RENT }, { address: STAKE }]));
    return s;
  }
  const raw = (a: Address) => Buffer.from((d.svm.getAccount(a) as { data: Uint8Array }).data);
  const state = (a: Address) => raw(a).readUInt32LE(0);
  const lamportsOf = (a: Address) => d.svm.getBalance(a) ?? 0n;
  const delegate = (s: Address, tag = 2) =>
    call(tag, b(), [
      { address: s, writable: true },
      { address: vote },
      { address: CLOCK },
      { address: HISTORY },
      { address: CONFIG },
      { address: authority },
      { address: STAKE },
    ]);
  const split = (from: Address, to: Address, lamports: bigint, tag = 3) =>
    call(tag, Buffer.concat([b(), u64(lamports)]), [
      { address: from, writable: true },
      { address: to, writable: true },
      { address: authority },
      { address: STAKE },
    ]);
  const merge = (into: Address, from: Address) =>
    call(4, b(), [
      { address: into, writable: true },
      { address: from, writable: true },
      { address: CLOCK },
      { address: HISTORY },
      { address: authority },
      { address: STAKE },
    ]);
  const deactivate = (s: Address, tag = 5, program = STAKE, writable = true) =>
    call(tag, b(), [{ address: s, writable }, { address: CLOCK }, { address: authority }, { address: program }]);
  const withdraw = (s: Address, to: Address, lamports: bigint) =>
    call(6, Buffer.concat([b(), u64(lamports)]), [
      { address: s, writable: true },
      { address: to, writable: true },
      { address: CLOCK },
      { address: HISTORY },
      { address: authority },
      { address: STAKE },
    ]);
  const nextEpoch = () => {
    const c = d.svm.getClock();
    c.epoch += 1n;
    c.slot += 432_000n;
    d.svm.setClock(c);
  };

  it("initializes with and without a lockup", async () => {
    const s = await stakeAccount(1n);
    expect(state(s)).toBe(1); // Initialized
    expect([raw(s).subarray(12, 44), raw(s).subarray(44, 76)]).toEqual([key(authority), key(authority)]);
    expect(raw(s).subarray(76, 124)).toEqual(Buffer.alloc(48)); // no lockup

    const custodian = (await generateKeyPairSigner()).address;
    const l = await blank(1n);
    expectOk(
      await call(1, Buffer.concat([key(authority), key(payer.address), u64(1_900_000_000n), u64(77n), key(custodian)]), [
        { address: l, writable: true },
        { address: RENT },
        { address: STAKE },
      ]),
    );
    const data = raw(l);
    expect([data.readBigInt64LE(76), data.readBigUInt64LE(84)]).toEqual([1_900_000_000n, 77n]);
    expect(data.subarray(92, 124)).toEqual(key(custodian));
    expect(data.subarray(44, 76)).toEqual(key(payer.address));
  });

  it("names a sysvar by its address, as solana_program's stake builders do", async () => {
    const mergeByAddress = (into: Address, from: Address, extra: Meta[]) =>
      call(14, b(), [{ address: into, writable: true }, { address: from, writable: true }, { address: authority }, { address: STAKE }, ...extra]);
    const i1 = await stakeAccount(1n);
    const i2 = await stakeAccount(1n);
    // The Clock and StakeHistory anywhere in the transaction: found by key.
    expectOk(await mergeByAddress(i1, i2, [{ address: HISTORY }, { address: CLOCK }]));
    expect(lamportsOf(i2)).toBe(0n);
    // Not passed: the runtime refuses the call (MissingAccount), as it refuses the original's.
    const i3 = await stakeAccount(1n);
    const i4 = await stakeAccount(1n);
    const r = await mergeByAddress(i3, i4, [{ address: CLOCK }]);
    expect(r).toBeInstanceOf(FailedTransactionMetadata);
    expect(String((r as FailedTransactionMetadata).err())).toMatch(/MissingAccount/);
  });

  it("delegates, splits, merges, deactivates and withdraws with a PDA authority", async () => {
    const a = await stakeAccount(5n);
    expectOk(await delegate(a));
    expect(state(a)).toBe(2); // Stake
    expect(raw(a).subarray(124, 156)).toEqual(key(vote));

    // Split 2 SOL into a fresh account (its rent reserve already in it), then merge it back: two stakes activating in
    // the same epoch merge.
    const before = lamportsOf(a);
    const part = await blank(0n);
    expectOk(await split(a, part, 2n * SOL));
    expect(state(part)).toBe(2);
    expect(lamportsOf(a)).toBe(before - 2n * SOL);
    expectOk(await merge(a, part));
    expect(lamportsOf(a)).toBe(before + d.svm.minimumBalanceForRentExemption(200n));
    expect(lamportsOf(part)).toBe(0n);

    // A new epoch: the stake is active (no history: fully effective). Split and merge two active stakes.
    nextEpoch();
    const part2 = await blank(0n);
    expectOk(await split(a, part2, SOL + SOL / 2n));
    expectOk(await merge(part2, a)); // the other way round: `a` is drained into part2
    expect(lamportsOf(a)).toBe(0n);
    expect(state(part2)).toBe(2);

    // Two stakes that were never delegated (Initialized) merge too.
    const i1 = await stakeAccount(1n);
    const i2 = await stakeAccount(1n);
    expectOk(await merge(i1, i2));
    expect(lamportsOf(i2)).toBe(0n);

    // Deactivate, wait an epoch, withdraw everything.
    expectOk(await deactivate(part2));
    expect(raw(part2).readBigUInt64LE(172)).toBe(d.svm.getClock().epoch); // deactivation epoch
    nextEpoch();
    const to = (await generateKeyPairSigner()).address;
    const all = lamportsOf(part2);
    expect(await withdraw(part2, to, all + 1n)).toBeInstanceOf(FailedTransactionMetadata);
    expectOk(await withdraw(part2, to, all));
    expect(lamportsOf(to)).toBe(all);
  });

  it("hands over the staker and the withdrawer", async () => {
    const s = await stakeAccount(1n);
    const staker = (await generateKeyPairSigner()).address;
    const withdrawer = (await generateKeyPairSigner()).address;
    const authorize = (which: number, next: Address) =>
      call(7, Buffer.concat([b(), Buffer.from([which]), key(next)]), [
        { address: s, writable: true },
        { address: CLOCK },
        { address: authority },
        { address: STAKE },
      ]);
    expectOk(await authorize(0, staker));
    expect(raw(s).subarray(12, 44)).toEqual(key(staker));
    expectOk(await authorize(1, withdrawer));
    expect(raw(s).subarray(44, 76)).toEqual(key(withdrawer));
    // The PDA is neither any more.
    expect(await authorize(0, authority)).toBeInstanceOf(FailedTransactionMetadata);
  });

  it("signs with the lockup custodian when the lockup is in force", async () => {
    const custodian = await fundedSigner(d.svm, 1n);
    const s = await blank(2n);
    const farEpoch = d.svm.getClock().epoch + 1000n;
    expectOk(
      await call(1, Buffer.concat([key(authority), key(authority), u64(0n), u64(farEpoch), key(custodian.address)]), [
        { address: s, writable: true },
        { address: RENT },
        { address: STAKE },
      ]),
    );
    const to = (await generateKeyPairSigner()).address;
    // In lockup: the withdrawer alone cannot withdraw (StakeError::LockupInForce, custom 1).
    expect(customError(await withdraw(s, to, SOL))).toBe(1);
    const accounts = [
      { address: s, writable: true },
      { address: to, writable: true },
      { address: CLOCK },
      { address: HISTORY },
      { address: authority },
      { address: custodian.address, signer: custodian },
      { address: STAKE },
    ];
    expectOk(await call(9, Buffer.concat([b(), u64(SOL)]), accounts));
    expect(lamportsOf(to)).toBe(SOL);
    // The custodian passed without signing: the CPI asks for a signature the transaction lacks.
    const unsigned = accounts.map((a) => (a.address === custodian.address ? { address: a.address } : a));
    expect(err(await call(9, Buffer.concat([b(), u64(1000n)]), unsigned))).not.toBe("ok");

    // A new withdrawer during the lockup also needs the custodian.
    const next = (await generateKeyPairSigner()).address;
    expectOk(
      await call(10, Buffer.concat([b(), key(next)]), [
        { address: s, writable: true },
        { address: CLOCK },
        { address: authority },
        { address: custodian.address, signer: custodian },
        { address: STAKE },
      ]),
    );
    expect(raw(s).subarray(44, 76)).toEqual(key(next));
  });

  it("reads the minimum delegation the Stake program returns", async () => {
    const own = expectOk(await send(d.svm, payer, [{ programAddress: STAKE, accounts: [], data: new Uint8Array(u64(13n).subarray(0, 4)) } as Instruction]));
    const expected = Buffer.from(own.returnData().data()).readBigUInt64LE(0);
    const typed = await call(8, Buffer.alloc(0), [{ address: STAKE }]);
    expect(logged(typed)).toEqual([expected]);
    expect(logged(await call(22, Buffer.alloc(0), [{ address: STAKE }]))).toEqual([expected]); // the same with invoke
  });

  it("passes a programAt value to a helper, and lets a wallet authority sign", async () => {
    const s = await stakeAccount(2n);
    expectOk(await delegate(s));
    expectOk(await deactivate(s, 11));
    expect(raw(s).readBigUInt64LE(172)).toBe(d.svm.getClock().epoch);

    const wallet = await fundedSigner(d.svm, 1n);
    const w = await stakeAccount(2n, wallet.address, wallet.address);
    const delegated = expectOk(
      await send(d.svm, payer, [
        {
          programAddress: STAKE,
          accounts: [
            { address: w, role: AccountRole.WRITABLE },
            { address: vote, role: AccountRole.READONLY },
            { address: CLOCK, role: AccountRole.READONLY },
            { address: HISTORY, role: AccountRole.READONLY },
            { address: CONFIG, role: AccountRole.READONLY },
            { address: wallet.address, role: AccountRole.READONLY_SIGNER, signer: wallet },
          ],
          data: new Uint8Array([2, 0, 0, 0]),
        } as Instruction,
      ]),
    );
    expect(delegated).toBeTruthy();
    // Passed without its signature: the Stake program refuses (the compiler cannot know, the runtime does).
    expect(
      err(await call(13, Buffer.alloc(0), [{ address: w, writable: true }, { address: CLOCK }, { address: wallet.address }, { address: STAKE }])),
    ).not.toBe("ok");
    expectOk(
      await call(13, Buffer.alloc(0), [{ address: w, writable: true }, { address: CLOCK }, { address: wallet.address, signer: wallet }, { address: STAKE }]),
    );
  });

  it("checks the program once: another account fails with IncorrectProgramId", async () => {
    const s = await stakeAccount(1n);
    const r = await deactivate(s, 5, SYSTEM_PROGRAM);
    expect(err(r)).toContain("IncorrectProgramId");
    expect(logs(r).some((l) => l.includes("TypeSOL: not the Stake program (native-cpi.ts:"))).toBe(true);
    // A read-only stake account: the CPI cannot make it writable (the runtime's privilege check).
    const ro = await deactivate(s, 5, STAKE, false);
    expect(err(ro)).not.toBe("ok");
    expect(logs(ro).join("\n")).toMatch(/writable privilege escalated/);
  });

  it("reads the StakeHistory sysvar from a remaining account", async () => {
    const saved = d.svm.getAccount(HISTORY);
    const entries = [
      [12n, 9n, 2n, 1n],
      [11n, 7n, 3n, 0n],
    ];
    const data = Buffer.alloc(8 + 32 * entries.length);
    data.writeBigUInt64LE(BigInt(entries.length), 0);
    entries.forEach((e, i) => e.forEach((v, j) => data.writeBigUInt64LE(v, 8 + 32 * i + 8 * j)));
    d.svm.setAccount({
      address: HISTORY,
      data: new Uint8Array(data),
      executable: false,
      lamports: 1_000_000n as never,
      programAddress: "Sysvar1111111111111111111111111111111111111" as Address,
      space: BigInt(data.length),
    });
    try {
      expect(logged(expectOk(await call(12, u64(11n), [{ address: HISTORY }])))).toEqual([2n, 12n, 7_000_000n + 3000n, 1n]);
      expect(logged(expectOk(await call(12, u64(5n), [{ address: HISTORY }])))).toEqual([2n, 12n, 0n, 0n]);
      expect(err(await call(12, u64(5n), [{ address: CLOCK }]))).toContain("InvalidArgument");
    } finally {
      if (saved.exists) d.svm.setAccount(saved as never);
    }
  });

  /** An SPL Token mint (6 decimals, no supply) and token account, written in place. */
  const putMint = (address: Address, mintAuthority: Address) => {
    const data = Buffer.alloc(82);
    data.writeUInt32LE(1, 0);
    key(mintAuthority).copy(data, 4);
    data[44] = 6; // decimals
    data[45] = 1; // initialized
    d.svm.setAccount({ address, data: new Uint8Array(data), executable: false, lamports: 10_000_000n, programAddress: TOKEN_PROGRAM, space: 82n } as never);
  };
  const putToken = (address: Address, mint: Address, tokenOwner: Address, amount: bigint) => {
    const data = Buffer.alloc(165);
    key(mint).copy(data, 0);
    key(tokenOwner).copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1; // initialized
    d.svm.setAccount({ address, data: new Uint8Array(data), executable: false, lamports: 10_000_000n, programAddress: TOKEN_PROGRAM, space: 165n } as never);
  };

  describe("tokens and the System Program", () => {
    let mint: Address;
    let owner: KeyPairSigner;
    let a: Address;
    let bAcct: Address;
    const amount = (t: Address) => raw(t).readBigUInt64LE(64);
    beforeAll(async () => {
      mint = (await generateKeyPairSigner()).address;
      owner = await fundedSigner(d.svm, 5n);
      a = (await generateKeyPairSigner()).address;
      bAcct = (await generateKeyPairSigner()).address;
      putMint(mint, authority);
      putToken(a, mint, owner.address, 0n);
      putToken(bAcct, mint, owner.address, 0n);
    });

    it("mints with a PDA authority, burns and transfers with a wallet's signature", async () => {
      const mintTo = (tag: number, n: bigint) =>
        call(tag, Buffer.concat([b(), u64(n)]), [
          { address: mint, writable: true },
          { address: a, writable: true },
          { address: authority },
          { address: TOKEN_PROGRAM },
        ]);
      expectOk(await mintTo(30, 1000n));
      expect(amount(a)).toBe(1000n);
      expectOk(await mintTo(25, 1000n)); // the same with invoke
      expect(amount(a)).toBe(2000n);

      expectOk(
        await call(31, u64(300n), [
          { address: a, writable: true },
          { address: mint, writable: true },
          { address: owner.address, signer: owner },
          { address: TOKEN_PROGRAM },
        ]),
      );
      expect(amount(a)).toBe(1700n);
      expect(raw(mint).readBigUInt64LE(36)).toBe(1700n);
      expectOk(
        await call(32, u64(700n), [
          { address: a, writable: true },
          { address: mint },
          { address: bAcct, writable: true },
          { address: owner.address, signer: owner },
          { address: TOKEN_PROGRAM },
        ]),
      );
      expect([amount(a), amount(bAcct)]).toEqual([1000n, 700n]);
      // TokenInterface: either token program, nothing else.
      expect(err(await mintTo(30, 1n))).toBe("ok");
      const wrong = await call(30, Buffer.concat([b(), u64(1n)]), [
        { address: mint, writable: true },
        { address: a, writable: true },
        { address: authority },
        { address: SYSTEM_PROGRAM },
      ]);
      expect(err(wrong)).toContain("IncorrectProgramId");
    });

    it("transfers and creates accounts through the System Program", async () => {
      const to = (await generateKeyPairSigner()).address;
      const sent = SOL / 100n;
      expectOk(
        await call(33, u64(sent), [{ address: owner.address, writable: true, signer: owner }, { address: to, writable: true }, { address: SYSTEM_PROGRAM }]),
      );
      expect(lamportsOf(to)).toBe(sent);
      expectOk(
        await call(24, u64(sent), [{ address: owner.address, writable: true, signer: owner }, { address: to, writable: true }, { address: SYSTEM_PROGRAM }]),
      );
      expect(lamportsOf(to)).toBe(2n * sent);
      // The source passed without signing: refused by the runtime.
      expect(err(await call(33, u64(1n), [{ address: owner.address, writable: true }, { address: to, writable: true }, { address: SYSTEM_PROGRAM }]))).not.toBe(
        "ok",
      );
      // Stake in the System Program's slot.
      expect(
        err(await call(33, u64(1n), [{ address: owner.address, writable: true, signer: owner }, { address: to, writable: true }, { address: STAKE }])),
      ).toContain("IncorrectProgramId");

      const fresh = await generateKeyPairSigner();
      const rent = d.svm.minimumBalanceForRentExemption(200n);
      expectOk(
        await call(34, Buffer.concat([u64(rent), u64(200n), key(STAKE)]), [
          { address: owner.address, writable: true, signer: owner },
          { address: fresh.address, writable: true, signer: fresh },
          { address: SYSTEM_PROGRAM },
        ]),
      );
      const created = d.svm.getAccount(fresh.address);
      expect(created.exists && [created.programAddress, created.data.length]).toEqual([STAKE, 200]);

      // allocate + assign of a funded PDA (the stake pool's create_stake_account).
      const [vault, vaultBump] = await pda(d.programId, ["vault"]);
      d.svm.airdrop(vault, rent as never);
      expectOk(await call(35, Buffer.concat([Buffer.from([vaultBump]), key(STAKE)]), [{ address: vault, writable: true }, { address: SYSTEM_PROGRAM }]));
      const v = d.svm.getAccount(vault);
      expect(v.exists && [v.programAddress, v.data.length]).toEqual([STAKE, 200]);
    });
  });

  it("costs what the hand-encoded invoke costs, plus the program's key check", async () => {
    // Each pair compiled on its own (one call in the entry), so the numbers compare the calls, not where they sit in
    // a long if/else chain. `invoke` checks only that the program is executable; programAt compares its key.
    const head = `import { type StakeProgram, type SystemProgram, type TokenInterface, type u64, instructionData, invoke, log, programAt, readonly, readonlySigner, remainingAccounts, returnData, u32, u8, writable, writableSigner } from "typesol";\n/** @fallback */\nexport function entry(): void {\n  const data = instructionData();\n  const rest = remainingAccounts();\n`;
    const seeds = `["authority", data.readU8(1n)]`;
    const pairs: Record<string, [string, string]> = {
      delegate: [
        `programAt<StakeProgram>(rest.get(6n)).delegate(rest.get(0n), rest.get(1n), rest.get(2n), rest.get(3n), rest.get(4n), rest.get(5n), ${seeds});`,
        `invoke(rest.get(6n), [writable(rest.get(0n)), readonly(rest.get(1n)), readonly(rest.get(2n)), readonly(rest.get(3n)), readonly(rest.get(4n)), readonlySigner(rest.get(5n))], [u32(2n)], ${seeds});`,
      ],
      split: [
        `programAt<StakeProgram>(rest.get(3n)).split(rest.get(0n), rest.get(1n), rest.get(2n), data.readU64(2n), ${seeds});`,
        `invoke(rest.get(3n), [writable(rest.get(0n)), writable(rest.get(1n)), readonlySigner(rest.get(2n))], [u32(3n), data.readU64(2n)], ${seeds});`,
      ],
      deactivate: [
        `programAt<StakeProgram>(rest.get(3n)).deactivate(rest.get(0n), rest.get(1n), rest.get(2n), ${seeds});`,
        `invoke(rest.get(3n), [writable(rest.get(0n)), readonly(rest.get(1n)), readonlySigner(rest.get(2n))], [u32(5n)], ${seeds});`,
      ],
      getMinimumDelegation: [
        `log(programAt<StakeProgram>(rest.get(0n)).getMinimumDelegation());`,
        `const p = rest.get(0n);\n  invoke(p, [], [u32(13n)]);\n  log(returnData<u64>(p));`,
      ],
      mintTo: [
        `programAt<TokenInterface>(rest.get(3n)).mintTo(rest.get(0n), rest.get(1n), rest.get(2n), data.readU64(2n), ${seeds});`,
        `invoke(rest.get(3n), [writable(rest.get(0n)), writable(rest.get(1n)), readonlySigner(rest.get(2n))], [u8(7n), data.readU64(2n)], ${seeds});`,
      ],
      systemTransfer: [
        `programAt<SystemProgram>(rest.get(2n)).transfer(rest.get(0n), rest.get(1n), data.readU64(1n));`,
        `invoke(rest.get(2n), [writableSigner(rest.get(0n)), writable(rest.get(1n))], [u32(2n), data.readU64(1n)]);`,
      ],
    };
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-native-cpi-cu-"));
    const programs: Record<string, [Address, number][]> = {};
    try {
      for (const [op, bodies] of Object.entries(pairs)) {
        programs[op] = [];
        for (const [i, body] of bodies.entries()) {
          const file = path.join(dir, `${op}_${i}.ts`);
          writeFileSync(file, `${head}  ${body}\n}\n`);
          const { programId } = await deployFile(file, { svm: d.svm });
          programs[op].push([programId, (await pda(programId, ["authority"]))[1]]);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const at = async (programId: Address) => (await pda(programId, ["authority"]))[0];
    const measure = async (op: string, run: (programId: Address, bump: number, auth: Address) => Promise<Result>) => {
      const out: bigint[] = [];
      for (const [programId, bump] of programs[op]!) out.push(units(await run(programId, bump, await at(programId))));
      cu[op] = [out[0]!, out[1]!];
    };
    const stakeOf = async (auth: Address) => stakeAccount(3n, auth, auth);
    const stakes = new Map<string, Address>();
    await measure("delegate", async (programId, pb, auth) => {
      const s = await stakeOf(auth);
      stakes.set(programId, s);
      return callAt(programId, 0, Buffer.from([pb]), [
        { address: s, writable: true },
        { address: vote },
        { address: CLOCK },
        { address: HISTORY },
        { address: CONFIG },
        { address: auth },
        { address: STAKE },
      ]);
    });
    await measure("split", async (programId, pb, auth) => {
      const s = await stakeOf(auth);
      const part = await blank(0n);
      return callAt(programId, 0, Buffer.concat([Buffer.from([pb]), u64(SOL)]), [
        { address: s, writable: true },
        { address: part, writable: true },
        { address: auth },
        { address: STAKE },
      ]);
    });
    await measure("deactivate", async (programId, pb, auth) => {
      // Delegated by the fixture's PDA, which then hands the staker role to this program's.
      const s = await stakeAccount(3n);
      expectOk(await delegate(s));
      expectOk(
        await call(7, Buffer.concat([b(), Buffer.from([0]), key(auth)]), [
          { address: s, writable: true },
          { address: CLOCK },
          { address: authority },
          { address: STAKE },
        ]),
      );
      return callAt(programId, 0, Buffer.from([pb]), [{ address: s, writable: true }, { address: CLOCK }, { address: auth }, { address: STAKE }]);
    });
    await measure("getMinimumDelegation", (programId) => callAt(programId, 0, Buffer.alloc(0), [{ address: STAKE }]));
    await measure("mintTo", async (programId, pb, auth) => {
      const mint = (await generateKeyPairSigner()).address;
      const to = (await generateKeyPairSigner()).address;
      putMint(mint, auth);
      putToken(to, mint, payer.address, 0n);
      return callAt(programId, 0, Buffer.concat([Buffer.from([pb]), u64(5n)]), [
        { address: mint, writable: true },
        { address: to, writable: true },
        { address: auth },
        { address: TOKEN_PROGRAM },
      ]);
    });
    await measure("systemTransfer", async (programId) =>
      callAt(programId, 0, u64(SOL / 100n), [
        { address: payer.address, writable: true, signer: payer },
        { address: (await generateKeyPairSigner()).address, writable: true },
        { address: SYSTEM_PROGRAM },
      ]),
    );
    console.log("compute units, typed vs invoke (whole transaction, the callee included):");
    for (const [op, [typed, inv]] of Object.entries(cu)) console.log(`  ${op}: ${typed} vs ${inv} (${typed - inv})`);
    // The typed form pays for checking the program's key (four 8-byte compares; a declared StakeProgram parameter pays
    // the same on entry) where invoke checks only the executable flag, and getMinimumDelegation for the three checks of
    // the return data solana_program's get_minimum_delegation makes. Nothing else.
    for (const [typed, inv] of Object.values(cu)) expect(typed - inv).toBeLessThanOrEqual(32n);
  });
});

describe("programAt compile errors", () => {
  const head = `import { type AccountInfo, type Mut, type Pubkey, type Signer, type StakeProgram, type TokenProgram, type TokenAccount, type RemainingAccount, programAt, sysvarAt, remainingAccounts } from "typesol";\n`;
  const errors = (body: string) => compileErrors(head + body);

  it("names the program types it takes", () => {
    // TypeScript refuses other types (with a hint); without a type argument the compiler says which it takes.
    const wrong = errors(`export function f(): void { const p = programAt<TokenAccount>(remainingAccounts().get(0n)); }`);
    expect(wrong).toMatch(/Type 'TokenAccount' does not satisfy the constraint 'StakeProgram \| SystemProgram \| TokenProgram/);
    expect(wrong).toMatch(/hint: programAt<P> takes a program: StakeProgram, SystemProgram, TokenProgram, .* read other accounts with loadRaw \/ loadAccount/);
    expect(errors(`export function f(): void { const p = sysvarAt<StakeProgram>(remainingAccounts().get(0n)); }`)).toMatch(
      /hint: sysvarAt<S> takes StakeHistorySysvar; programs go through programAt<P>/,
    );
    expect(errors(`export function f(): void { const p = programAt(remainingAccounts().get(0n)); }`)).toMatch(
      /programAt<P>\(account\): P is one of StakeProgram, SystemProgram, TokenProgram, Token2022Program, TokenInterface, AssociatedTokenProgram, MemoProgram/,
    );
    expect(errors(`export function f(): void { const p = sysvarAt(remainingAccounts().get(0n)); }`)).toMatch(/sysvarAt<S>\(account\): S is StakeHistorySysvar/);
  });

  it("takes a remaining account or an AccountInfo parameter", () => {
    expect(errors(`export function f(t: TokenAccount): void { const p = programAt<StakeProgram>(t); }`)).toMatch(
      /pass a remaining account \(remainingAccounts\(\)\.get\(i\)\) or an AccountInfo parameter; a declared parameter can be typed StakeProgram itself/,
    );
    expect(errors(`export function f(a: AccountInfo): void { const p = programAt<StakeProgram>(a); }`)).toBe("");
  });

  it("keeps the compile-time checks of declared accounts", () => {
    // A read-only declared stake account, an authority that neither signed nor has signerSeeds.
    expect(
      errors(
        `export function f(s: AccountInfo, c: AccountInfo, a: Signer): void { programAt<StakeProgram>(remainingAccounts().get(0n)).deactivate(s, c, a); }`,
      ),
    ).toMatch(/the stake account must be writable \(Mut<\.\.\.>\)/);
    expect(
      errors(
        `export function f(s: Mut<AccountInfo>, c: AccountInfo, a: AccountInfo): void { programAt<StakeProgram>(remainingAccounts().get(0n)).deactivate(s, c, a); }`,
      ),
    ).toMatch(/the authority must be a Signer, or pass signerSeeds for a PDA authority/);
    // Remaining accounts are left to the runtime.
    expect(
      errors(`export function f(): void { const r = remainingAccounts(); programAt<StakeProgram>(r.get(0n)).deactivate(r.get(1n), r.get(2n), r.get(3n)); }`),
    ).toBe("");
  });

  it("passes a programAt value only to helpers that take that program", () => {
    expect(
      errors(
        `function h(p: StakeProgram, s: RemainingAccount, c: RemainingAccount, a: RemainingAccount): void { p.deactivate(s, c, a); }\nexport function f(): void { const r = remainingAccounts(); h(programAt<TokenProgram>(r.get(0n)), r.get(1n), r.get(2n), r.get(3n)); }`,
      ),
    ).toMatch(/Argument of type 'TokenProgram' is not assignable to parameter of type 'StakeProgram'/);
    expect(
      errors(
        `function h(p: StakeProgram, s: RemainingAccount, c: RemainingAccount, a: RemainingAccount): void { p.deactivate(s, c, a); }\nexport function f(): void { const r = remainingAccounts(); const p = programAt<StakeProgram>(r.get(0n)); h(p, r.get(1n), r.get(2n), r.get(3n)); }`,
      ),
    ).toBe("");
  });

  it("refuses methods the program does not have", () => {
    expect(errors(`export function f(): void { programAt<StakeProgram>(remainingAccounts().get(0n)).redelegate(); }`)).toMatch(
      /Property 'redelegate' does not exist|the Stake program supports initialize, authorize, delegate, split, deactivate, withdraw, merge and getMinimumDelegation/,
    );
  });

  it("checks the lockup and the custodian", () => {
    const r = `const r = remainingAccounts(); const s = programAt<StakeProgram>(r.get(0n));`;
    expect(errors(`export function f(k: Pubkey): void { ${r} s.initialize(r.get(1n), r.get(2n), k, k, { unixTimestamp: 0n, epoch: 0n } as never); }`)).toMatch(
      /the lockup is written \{ unixTimestamp, epoch, custodian \}/,
    );
    expect(
      errors(`export function f(k: Pubkey): void { ${r} s.initialize(r.get(1n), r.get(2n), k, k, { unixTimestamp: 0n, epoch: 0n, custodian: k }); }`),
    ).toBe("");
    // A declared custodian signs, or signerSeeds cover it.
    expect(errors(`export function f(c: AccountInfo, k: Pubkey): void { ${r} s.authorize(r.get(1n), r.get(2n), r.get(3n), k, "withdrawer", c); }`)).toMatch(
      /the custodian must be a Signer, or pass signerSeeds for a PDA custodian/,
    );
    expect(errors(`export function f(c: Signer, k: Pubkey): void { ${r} s.withdraw(r.get(1n), r.get(2n), r.get(3n), r.get(4n), r.get(5n), 1n, c); }`)).toBe("");
  });

  it("takes remaining accounts and AccountInfo parameters in every typed CPI", () => {
    const h = `import { type AccountInfo, type Mut, type MemoProgram, type AssociatedTokenProgram, type TokenInterface, type Token2022Program, type SystemProgram, programAt, remainingAccounts } from "typesol";\n`;
    expect(
      compileErrors(
        `${h}export function f(from: Mut<AccountInfo>, mint: AccountInfo, to: Mut<AccountInfo>, owner: AccountInfo): void {
  const r = remainingAccounts();
  programAt<MemoProgram>(r.get(0n)).memo("hi", [r.get(1n)]);
  programAt<AssociatedTokenProgram>(r.get(2n)).createIdempotent(r.get(3n), r.get(4n), r.get(5n), r.get(6n), r.get(7n), r.get(8n));
  programAt<TokenInterface>(r.get(8n)).transferChecked(from, mint, to, owner, 1n, ["a"]);
  programAt<Token2022Program>(r.get(9n)).initializeImmutableOwner(r.get(10n));
  programAt<SystemProgram>(r.get(7n)).createPda(r.get(3n), r.get(4n), 165n, r.get(8n).key, ["x"]);
}`,
      ),
    ).toBe("");
    // A declared AccountInfo in a writable slot must be Mut<AccountInfo>.
    expect(
      compileErrors(
        `${h}export function f(from: AccountInfo, mint: AccountInfo, to: Mut<AccountInfo>, owner: AccountInfo): void { programAt<TokenInterface>(remainingAccounts().get(0n)).transferChecked(from, mint, to, owner, 1n, ["a"]); }`,
      ),
    ).toMatch(/the source must be a Mut<TokenAccount> or a Mut<AccountInfo>/);
  });
});
