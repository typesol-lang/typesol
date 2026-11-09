// epochRewards() (test/fixtures/epoch-rewards.ts): the EpochRewards sysvar read through sol_get_epoch_rewards_sysvar,
// every field as LiteSVM set it, the `active` guard both ways, and the misuses refused at compile time.
import { type KeyPairSigner } from "@solana/kit";
import { EpochRewards, FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, compileErrors, customError, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");

describe("epochRewards()", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/epoch-rewards.ts", import.meta.url)));
    payer = await fundedSigner(d.svm);
  });
  let nonce = 0;
  const call = (tag: number) => send(d.svm, payer, [{ programAddress: d.programId, accounts: [], data: new Uint8Array([tag, nonce++ & 0xff]) }]);
  const blockhash = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
  const set = (active: boolean) => d.svm.setEpochRewards(new EpochRewards(123_456n, 7n, blockhash, 2n ** 100n + 5n, 9_000_000_000n, 2_500_000_000n, active));

  it("reads every field of the sysvar without its account", async () => {
    set(true);
    const r = await call(0);
    expect(err(r)).toBe("ok");
    expect(logs(r)).toEqual(
      expect.arrayContaining([
        "Program log: height 123456 partitions 7",
        `Program log: blockhash ${blockhash}`,
        `Program log: points ${2n ** 100n + 5n} total 9000000000 distributed 2500000000`,
        "Program log: active true pending 6500000000",
      ]),
    );
  });

  it("refuses while rewards are distributed, runs once they are not", async () => {
    set(true);
    const busy = await call(1);
    expect(customError(busy)).toBe(0);
    expect(logs(busy).join("\n")).toContain("Epoch rewards are being distributed.");
    set(false);
    const r = await call(1);
    expect(err(r)).toBe("ok");
    expect(logs(r)).toContain("Program log: updated");
    const all = await call(0);
    expect(logs(all)).toContain("Program log: active false pending 6500000000");
  });

  it("refuses misuse at compile time", () => {
    const head = `import { epochRewards, log } from "typesol";\nexport function f(): void {\n`;
    expect(compileErrors(`${head}  log(\`\${epochRewards().nope}\`);\n}\n`)).toMatch(/'nope' does not exist on type 'EpochRewards'/);
    expect(compileErrors(`${head}  const e = epochRewards(1n);\n}\n`)).toMatch(/Expected 0 arguments|takes no arguments/);
    expect(compileErrors(`${head}  log(\`\${epochRewards()}\`);\n}\n`)).toMatch(/not EpochRewards/);
    // A copy lives in a local; helpers read the sysvar themselves.
    const helper = `import { type EpochRewards, epochRewards, u64 } from "typesol";\nfunction g(e: EpochRewards): u64 {\n  return e.totalRewards;\n}\nexport function f(): void {\n  g(epochRewards());\n}\n`;
    expect(compileErrors(helper)).toMatch(/parameter type must be/);
  });
});
