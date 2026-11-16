// `executable` on a remaining account (test/fixtures/remaining-executable.ts): true for a program, false for a data
// account; a member a remaining account does not have is refused.
import { type Address, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compileErrors, deployFile, fundedSigner, send } from "../harness.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/remaining-executable.ts", import.meta.url));

describe("RemainingAccount.executable", () => {
  let svm: LiteSVM;
  let programId: Address;
  beforeAll(async () => {
    const d = await deployFile(FIXTURE);
    svm = d.svm;
    programId = d.programId;
  });
  const call = async (first: Address, second: Address) => {
    const payer = await fundedSigner(svm);
    return send(svm, payer, [
      {
        programAddress: programId,
        accounts: [
          { address: first, role: AccountRole.READONLY },
          { address: second, role: AccountRole.READONLY },
        ],
        data: new Uint8Array([]),
      },
    ]);
  };

  it("reads the flag of a program and of a data account", async () => {
    const data = (await generateKeyPairSigner()).address;
    svm.airdrop(data, 1_000_000_000n as never);
    expect(await call(programId, data)).not.toBeInstanceOf(FailedTransactionMetadata);
    const notProgram = await call(data, data);
    expect(String((notProgram as FailedTransactionMetadata).err())).toMatch(/InvalidAccountData/);
    const program = await call(programId, programId);
    expect(String((program as FailedTransactionMetadata).err())).toMatch(/InvalidArgument/);
  });

  it("refuses a member a remaining account does not have", () => {
    const src = `import { remainingAccounts, require } from "typesol";\n/** @fallback */\nexport function entry(): void {\n  require(remainingAccounts().get(0n).rentEpoch === 0n, "x");\n}\n`;
    expect(compileErrors(src)).toMatch(/rentEpoch/);
  });
});
