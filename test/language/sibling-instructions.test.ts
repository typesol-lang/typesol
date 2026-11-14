// processedSiblingInstructionCount() and processedSiblingInstruction(i): the sol_get_processed_sibling_instruction
// syscall as Rust's get_processed_sibling_instruction reads it. At the top level a program's siblings are the
// transaction's earlier instructions; under a caller, the instructions that caller already invoked (index 0 the
// latest). showcase/test/meteora-dbc-swap.test.ts checks Meteora's single-swap guard with it against the Rust program.
import { AccountRole } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const PROBE = `import { type Signer, type u64, log, processedSiblingInstruction, processedSiblingInstructionCount } from "typesol";
export function probe(who: Signer, tag: u64, read: u64): void {
  const n = processedSiblingInstructionCount();
  log(\`siblings \${n}\`);
  for (let i = 0n; i < n; i++) {
    const s = processedSiblingInstruction(i);
    log(\`\${i}: \${s.programId} accounts \${s.accountsLength} signer \${s.accountsLength > 0n && s.accountIsSigner(0n)} data \${s.dataLength}\`);
  }
  if (read > 0n) log(\`read \${processedSiblingInstruction(read - 1n).readU64(8n)}\`);
}
`;

const RELAY = `import { type FixedVec, type Pubkey, fixedVec, instructionData, invokeInstruction, remainingAccounts, u64 } from "typesol";
interface Meta { pubkey: Pubkey; isSigner: boolean; isWritable: boolean }
/** @fallback */
export function entry(): void {
  const rest = remainingAccounts();
  const data = instructionData();
  const metas: FixedVec<Meta, 8> = fixedVec([]);
  for (let j = 1n; j < rest.length; j++) metas.push({ pubkey: rest.get(j).key, isSigner: rest.get(j).isSigner, isWritable: rest.get(j).isWritable });
  for (let i = 0n; i < u64(data.get(0n)); i++) invokeInstruction(rest.get(0n).key, metas, data.slice(1n), rest);
}
`;

describe("processed sibling instructions", () => {
  let probe: Deployed;
  let relay: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-siblings-"));
    writeFileSync(path.join(dir, "probe.ts"), PROBE);
    writeFileSync(path.join(dir, "relay.ts"), RELAY);
    probe = await deployFile(path.join(dir, "probe.ts"));
    relay = await deployFile(path.join(dir, "relay.ts"), { svm: probe.svm });
  });
  const logs = (r: { logs(): string[] }) => r.logs().filter((l) => l.startsWith("Program log: ") && !l.includes("Instruction:"));

  it("at the top level: the transaction's earlier instructions", async () => {
    const who = await fundedSigner(probe.svm);
    const call = (tag: number, read = 0) => ix(probe, "probe", { tag: new BN(tag), read: new BN(read) }, [{ address: who.address, signer: who }]);
    const r = expectOk(await send(probe.svm, who, [call(1), call(2), call(3, 2)]));
    expect(logs(r)).toEqual([
      "Program log: siblings 0",
      "Program log: siblings 1",
      `Program log: 0: ${probe.programId} accounts 1 signer true data 24`,
      "Program log: siblings 2",
      `Program log: 0: ${probe.programId} accounts 1 signer true data 24`,
      `Program log: 1: ${probe.programId} accounts 1 signer true data 24`,
      "Program log: read 1",
    ]);
  });

  it("under a caller: what the caller already invoked, index 0 the latest; 5104 past the last", async () => {
    const who = await fundedSigner(probe.svm);
    const inner = (tag: number, read = 0) => ix(probe, "probe", { tag: new BN(tag), read: new BN(read) }, [{ address: who.address, signer: who }]);
    const via = (n: number, i: ReturnType<typeof inner>) => ({
      programAddress: relay.programId,
      accounts: [{ address: probe.programId, role: AccountRole.READONLY }, ...(i.accounts ?? [])],
      data: new Uint8Array([n, ...(i.data ?? [])]),
    });
    const r = expectOk(await send(probe.svm, who, [via(1, inner(7)) as never, via(2, inner(8)) as never]));
    expect(logs(r)).toEqual([
      "Program log: siblings 0",
      "Program log: siblings 0",
      "Program log: siblings 1",
      `Program log: 0: ${probe.programId} accounts 1 signer true data 24`,
    ]);
    // reading sibling 0 where there is none
    expect(customError(await send(probe.svm, who, [via(2, inner(9, 1)) as never]))).toBe(5104);
  });
});
