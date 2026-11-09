// A ternary between accounts (test/fixtures/account-choice.ts): remaining accounts, AccountInfo parameters and
// RemainingAccount helper parameters, chosen at run time and used in CPIs, readData and loadRaw.
import { type Address, generateKeyPairSigner, getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, type Deployed, SYSTEM_PROGRAM, acct, compileErrors, deployFile, expectOk, fundedSigner, ix, send } from "../harness.js";

const enc = getAddressEncoder();
const FIXTURE = fileURLToPath(new URL("../fixtures/account-choice.ts", import.meta.url));

describe("account choice", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  const counters: Address[] = [];
  beforeAll(async () => {
    d = await deployFile(FIXTURE);
    payer = await fundedSigner(d.svm);
    for (let i = 0; i < 3; i++) {
      const address = (await generateKeyPairSigner()).address;
      const data = Buffer.alloc(40);
      Buffer.from(enc.encode(payer.address)).copy(data, 0);
      data.writeBigUInt64LE(BigInt(10 + i), 32);
      d.svm.setAccount({ address, lamports: 1_000_000n + BigInt(i), programAddress: d.programId, executable: false, data } as never);
      counters.push(address);
    }
  });
  const logs = (r: Awaited<ReturnType<typeof send>>) => expectOk(r).logs();

  it("reads the remaining account chosen", async () => {
    for (const second of [false, true]) {
      const i = second ? 1 : 0;
      const l = logs(
        await send(d.svm, payer, [
          ix(
            d,
            "pick",
            { second },
            counters.slice(0, 2).map((address) => ({ address })),
          ),
        ]),
      );
      expect(l).toContain(`Program log: ${counters[i]}`);
      expect(l).toContain(`Program log: count ${10 + i}`);
      expect(l).toContain(`Program log: lamports ${1_000_000 + i}`);
    }
  });

  it("chooses between a remaining account and an AccountInfo parameter, in a helper too", async () => {
    for (const useRest of [true, false]) {
      const l = logs(await send(d.svm, payer, [ix(d, "pick_param", { use_rest: useRest }, [{ address: counters[2]! }, { address: counters[0]! }])]));
      expect(l).toContain(`Program log: ${useRest ? counters[0] : counters[2]}`);
      expect(l).toContain(`Program log: count ${useRest ? 10 : 12}`);
      // The helper takes the remaining account when the instruction did, else the parameter.
      expect(l).toContain(`Program log: helper ${useRest ? 10 : 12}`);
    }
  });

  it("passes the chosen account to a CPI (a nested choice), running only the chosen side", async () => {
    for (const which of [0n, 1n, 2n]) {
      const before = counters.map((a) => acct(d.svm, a).lamports);
      expectOk(
        await send(d.svm, payer, [
          ix(d, "pay", { which: new BN(which.toString()) }, [
            { address: payer.address, signer: payer, writable: true },
            { address: SYSTEM_PROGRAM },
            ...counters.map((address) => ({ address, writable: true })),
          ]),
        ]),
      );
      counters.forEach((a, i) => expect(acct(d.svm, a).lamports - before[i]!).toBe(BigInt(i) === which ? 1000n : 0n));
    }
    // Only the side taken is evaluated: with one remaining account, `which === 0n` never reads rest.get(1n).
    expectOk(
      await send(d.svm, payer, [
        ix(d, "pay", { which: new BN(0) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: counters[0]!, writable: true },
        ]),
      ]),
    );
  });

  it("refuses a choice with a typed account or a plain value", () => {
    const head = `import { type AccountInfo, type Signer, log, remainingAccounts } from "typesol";\n`;
    expect(
      compileErrors(`${head}export function f(s: Signer, c: boolean): void { const rest = remainingAccounts(); const a = c ? rest.get(0n) : s; log(a.key); }`),
    ).toMatch(/choose between accounts of one kind/);
    expect(
      compileErrors(`${head}export function f(i: AccountInfo, c: boolean): void { const rest = remainingAccounts(); const a = c ? rest.get(0n) : 1n; }`),
    ).not.toBe("");
  });
});
