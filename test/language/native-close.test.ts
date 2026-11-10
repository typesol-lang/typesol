// closeRaw, assignOwner and resizeAccount on remaining accounts and AccountInfo parameters (test/fixtures/native-close.ts,
// native-close-writes.ts): Phoenix's Tombstone, compared with the Phoenix v1 binary's, and the checks with and without
// NATIVE_ACCOUNT_WRITES.
import { type Address, AccountRole, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, SYSTEM_PROGRAM, acct, compileErrors, customError, deployFile, expectOk, fundedSigner, send } from "../harness.js";
import { MARKET_512_SIZE, MarketStatus, type Result, changeMarketStatus, errOf, initializeMarket, logsOf, phoenixMarket } from "../phoenix-helpers.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/native-close.ts", import.meta.url));
const NATIVE = fileURLToPath(new URL("../fixtures/native-close-writes.ts", import.meta.url));

type Acct = { address: Address; writable?: boolean };

describe("closeRaw, assignOwner and resizeAccount", () => {
  let d: Deployed;
  let n: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(FIXTURE);
    n = await deployFile(NATIVE, { svm: d.svm });
    payer = await fundedSigner(d.svm, 100n);
  });
  let nonce = 0;
  const call = (p: Deployed, data: number[], accounts: Acct[]) =>
    send(d.svm, payer, [
      {
        programAddress: p.programId,
        accounts: accounts.map((a) => ({ address: a.address, role: a.writable === false ? AccountRole.READONLY : AccountRole.WRITABLE })),
        data: new Uint8Array([...data, nonce++ & 0xff]),
      },
    ]);
  const named = (p: Deployed, name: string, accounts: Acct[]) =>
    send(d.svm, payer, [
      {
        programAddress: p.programId,
        accounts: accounts.map((a) => ({ address: a.address, role: a.writable === false ? AccountRole.READONLY : AccountRole.WRITABLE })),
        data: new Uint8Array([...p.coder.instruction.encode(name, {}), nonce++ & 0xff]),
      },
    ]);
  /** An account of `owner` holding `size` bytes of 0xab and `lamports`. */
  const put = async (owner: Address, size: number, lamports = 1_000_000_000n): Promise<Address> => {
    const a = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: a, lamports, programAddress: owner, executable: false, data: new Uint8Array(size).fill(0xab) } as never);
    return a;
  };
  const lamportsOf = (a: Address) => {
    const x = d.svm.getAccount(a);
    return x.exists ? x.lamports : 0n;
  };
  const u64 = (v: number) => [...new Uint8Array(new BigUint64Array([BigInt(v)]).buffer)];
  const cu = (r: Result) => expectOk(r).computeUnitsConsumed();

  it("ends where Phoenix's Tombstone ends: the receiver holds the lamports and the account is gone", async () => {
    const m = await phoenixMarket();
    expectOk(await initializeMarket(m));
    expectOk(await changeMarketStatus(m, MarketStatus.PostOnly));
    expectOk(await changeMarketStatus(m, MarketStatus.Closed));
    const receiver = (await generateKeyPairSigner()).address;
    m.svm.airdrop(receiver, 5_000_000n as never);
    const marketLamports = acct(m.svm, m.market).lamports;
    const r = await changeMarketStatus(m, MarketStatus.Tombstoned, receiver);
    expect(errOf(r)).toBe("ok");
    expect(logsOf(r)).toContain("Program log: Market has been removed");
    expect(m.svm.getAccount(m.market).exists).toBe(false);
    expect(acct(m.svm, receiver).lamports).toBe(5_000_000n + marketLamports);

    // The same account (size, lamports) closed by a TypeSOL program the same way.
    const market = await put(d.programId, MARKET_512_SIZE, marketLamports);
    const to = await put(SYSTEM_PROGRAM, 0, 5_000_000n);
    const used = cu(await call(d, [0], [{ address: market }, { address: to }]));
    expect(d.svm.getAccount(market).exists).toBe(false);
    expect(lamportsOf(to)).toBe(5_000_000n + marketLamports);
    // No wipe of the 84,944 bytes (close() zeroes them first, as Anchor does).
    expect(used).toBeLessThan(2_000);
  });

  it("closes through a helper's RemainingAccount parameters and through Mut<AccountInfo> parameters", async () => {
    for (const via of ["helper", "param"] as const) {
      const a = await put(d.programId, 100, 7_000_000n);
      const to = await put(SYSTEM_PROGRAM, 0, 1_000_000n);
      expectOk(via === "helper" ? await call(d, [1], [{ address: a }, { address: to }]) : await named(d, "close_param", [{ address: a }, { address: to }]));
      expect(d.svm.getAccount(a).exists).toBe(false);
      expect(lamportsOf(to)).toBe(8_000_000n);
    }
  });

  it("checks without NATIVE_ACCOUNT_WRITES: writable (3006), passed once (2040), this program's (3007)", async () => {
    const a = await put(d.programId, 10);
    const to = await put(SYSTEM_PROGRAM, 0);
    expect(customError(await call(d, [0], [{ address: a, writable: false }, { address: to }]))).toBe(3006);
    expect(customError(await call(d, [0], [{ address: a }, { address: to, writable: false }]))).toBe(3006);
    expect(customError(await call(d, [0], [{ address: a }, { address: a }]))).toBe(2040);
    const foreign = await put(SYSTEM_PROGRAM, 10);
    expect(customError(await call(d, [0], [{ address: foreign }, { address: to }]))).toBe(3007);
    expect(customError(await call(d, [5], [{ address: foreign }]))).toBe(3007);
    expect(customError(await call(d, [3, ...u64(20)], [{ address: a, writable: false }]))).toBe(3006);
    expect(customError(await named(d, "close_param", [{ address: a }, { address: a }]))).toBe(2040);
    expect(d.svm.getAccount(a).exists).toBe(true);
  });

  it("leaves the judging to the runtime under NATIVE_ACCOUNT_WRITES, as for a native program", async () => {
    const a = await put(n.programId, 10, 3_000_000n);
    const to = await put(SYSTEM_PROGRAM, 0, 1_000_000n);
    // A read-only account changed, another program's account drained, an account closed into itself (lamports burnt).
    expect(errOf(await call(n, [0], [{ address: a, writable: false }, { address: to }]))).toMatch(/ReadonlyLamportChange/);
    const foreign = await put(d.programId, 10);
    expect(errOf(await call(n, [0], [{ address: foreign }, { address: to }]))).toMatch(/ExternalAccountLamportSpend/);
    expect(errOf(await call(n, [0], [{ address: a }, { address: a }]))).toMatch(/UnbalancedInstruction/);
    expect(errOf(await call(n, [3, ...u64(20)], [{ address: a, writable: false }]))).toMatch(/AccountDataSizeChanged|ReadonlyDataModified/);
    // What the runtime accepts goes through, plain AccountInfo parameters included.
    expectOk(await call(n, [0], [{ address: a }, { address: to }]));
    expect(lamportsOf(to)).toBe(4_000_000n);
    const b = await put(n.programId, 10, 2_000_000n);
    expectOk(await named(n, "close_param", [{ address: b }, { address: to }]));
    expect(lamportsOf(to)).toBe(6_000_000n);
    const c = await put(n.programId, 10, 2_000_000n);
    expectOk(await named(n, "resize_param", [{ address: c }]));
    expect(acct(d.svm, c).data.length).toBe(3);
    const e = await put(n.programId, 10, 2_000_000n);
    expect(errOf(await named(n, "resize_param", [{ address: e, writable: false }]))).toMatch(/AccountDataSizeChanged|ReadonlyDataModified/);
  });

  it("assigns an emptied account to the System Program, its lamports kept; the runtime refuses one with data left", async () => {
    const a = await put(d.programId, 64, 2_000_000n);
    expectOk(await call(d, [2], [{ address: a }]));
    const after = acct(d.svm, a);
    expect(after.programAddress).toBe(SYSTEM_PROGRAM);
    expect(after.lamports).toBe(2_000_000n);
    expect(after.data.length).toBe(0);
    const full = await put(d.programId, 64);
    expect(errOf(await call(d, [5], [{ address: full }]))).toMatch(/ModifiedProgramId/);
    const b = await put(n.programId, 64, 2_000_000n);
    expectOk(await call(n, [2], [{ address: b }]));
    expect(acct(d.svm, b).programAddress).toBe(SYSTEM_PROGRAM);
  });

  it("resizes a remaining account: new bytes zeroed, at most 10 KiB past the size it started with (3016)", async () => {
    const a = await put(d.programId, 100);
    expectOk(await call(d, [4, ...u64(10), ...u64(50)], [{ address: a }]));
    const data = acct(d.svm, a).data;
    expect(data.length).toBe(50);
    expect([...data.subarray(0, 10)].every((b) => b === 0xab)).toBe(true);
    expect([...data.subarray(10)].every((b) => b === 0)).toBe(true);
    const b = await put(d.programId, 100);
    expect(customError(await call(d, [4, ...u64(6000), ...u64(100 + 10240 + 1)], [{ address: b }]))).toBe(3016);
    expectOk(await call(d, [4, ...u64(6000), ...u64(100 + 10240)], [{ address: b }]));
    expect(acct(d.svm, b).data.length).toBe(100 + 10240);
    const c = await put(n.programId, 100);
    expect(customError(await call(n, [3, ...u64(100 + 10241)], [{ address: c }]))).toBe(3016);
    expectOk(await call(n, [3, ...u64(1)], [{ address: c }]));
    expect(acct(d.svm, c).data.length).toBe(1);
  });

  it("refuses other accounts at compile time", () => {
    const head = `import { AccountInfo, Mut, Signer, assignOwner, closeRaw, resizeAccount } from "typesol";\n`;
    expect(compileErrors(`${head}export function f(a: AccountInfo, b: Mut<AccountInfo>): void { closeRaw(a, b); }`)).toMatch(
      /a must be Mut<AccountInfo> to change it in place \(or declare const NATIVE_ACCOUNT_WRITES = true/,
    );
    expect(compileErrors(`${head}export function f(a: Mut<Signer>, b: Mut<AccountInfo>): void { closeRaw(a, b); }`)).toMatch(
      /Mut<Signer>. is not assignable|closeRaw.s account is a remaining account/,
    );
    expect(compileErrors(`${head}export function f(a: AccountInfo): void { resizeAccount(a, 1n); }`)).toMatch(
      /resizeAccount needs a Mut<AccountInfo> parameter or a remaining account/,
    );
    expect(compileErrors(`${head}export function f(a: Mut<AccountInfo>): void { assignOwner(a, 5n); }`)).toMatch(/Pubkey|not assignable/);
  });
});
