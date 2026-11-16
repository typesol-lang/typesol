// NATIVE_ACCOUNT_WRITES and a remaining account's `.lamports`: written as a native program's
// `**a.lamports.borrow_mut() = v`, with no writability check (3006) and no refusal of an account passed twice (2040);
// the runtime judges the result when the instruction ends. Without the flag both checks stay. The program moves
// lamports from its first remaining account to its second and names whatever else is passed only as a position
// (Percolator's CloseSlab, whose unused destination token account may be the slab or the admin again).
import { type Address, AccountRole, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, acct, customError, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");

const source = (native: boolean) => `import { instructionData, remainingAccounts } from "typesol";

export const NATIVE_ACCOUNT_WRITES = ${native};

/** @fallback */
export function process(): void {
  const rest = remainingAccounts();
  const data = instructionData();
  const amount = data.readU64(1n);
  const from = rest.get(0n);
  const to = rest.get(1n);
  const all = from.lamports;
  from.lamports = all - amount;
  to.lamports = to.lamports + amount;
}
`;

describe("NATIVE_ACCOUNT_WRITES: lamport writes on remaining accounts", () => {
  let native: Deployed;
  let checked: Deployed;
  let payer: KeyPairSigner;
  let source0: Address;
  let dest: Address;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-native-lamports-"));
    writeFileSync(path.join(dir, "native.ts"), source(true));
    writeFileSync(path.join(dir, "checked.ts"), source(false));
    native = await deployFile(path.join(dir, "native.ts"));
    checked = await deployFile(path.join(dir, "checked.ts"), { svm: native.svm });
    payer = await fundedSigner(native.svm);
    source0 = (await generateKeyPairSigner()).address;
    dest = (await generateKeyPairSigner()).address;
  });
  const put = (d: Deployed, at: Address, lamports: bigint) =>
    native.svm.setAccount({ address: at, lamports, programAddress: d.programId, executable: false, data: new Uint8Array(8), space: 8n } as never);
  let nonce = 0;
  const move = (d: Deployed, amount: bigint, list: { address: Address; writable: boolean }[]) => {
    const data = Buffer.alloc(10);
    data[0] = 1;
    data.writeBigUInt64LE(amount, 1);
    data[9] = nonce++ & 0xff;
    return send(native.svm, payer, [
      {
        programAddress: d.programId,
        accounts: list.map((a) => ({ address: a.address, role: a.writable ? AccountRole.WRITABLE : AccountRole.READONLY })),
        data: new Uint8Array(data),
      },
    ]);
  };
  const lamportsOf = (at: Address) => acct(native.svm, at).lamports;

  it("moves lamports when either account is named again in another position", async () => {
    for (const again of ["source", "destination"]) {
      put(native, source0, 5_000_000n);
      put(native, dest, 1_000_000n);
      const third = again === "source" ? source0 : dest;
      const r = await move(native, 2_000_000n, [
        { address: source0, writable: true },
        { address: dest, writable: true },
        { address: third, writable: true },
      ]);
      expect(err(r), again).toBe("ok");
      expect(lamportsOf(source0)).toBe(3_000_000n);
      expect(lamportsOf(dest)).toBe(3_000_000n);
      put(checked, source0, 5_000_000n);
      put(checked, dest, 1_000_000n);
      expect(
        customError(
          await move(checked, 2_000_000n, [
            { address: source0, writable: true },
            { address: dest, writable: true },
            { address: third, writable: true },
          ]),
        ),
      ).toBe(2040);
    }
  });

  it("one account as both: the same record, the balance unchanged", async () => {
    put(native, source0, 5_000_000n);
    const r = await move(native, 2_000_000n, [
      { address: source0, writable: true },
      { address: source0, writable: true },
    ]);
    expect(err(r)).toBe("ok");
    expect(lamportsOf(source0)).toBe(5_000_000n);
  });

  it("leaves a read-only account's change to the runtime", async () => {
    put(native, source0, 5_000_000n);
    put(native, dest, 1_000_000n);
    const r = await move(native, 1n, [
      { address: source0, writable: true },
      { address: dest, writable: false },
    ]);
    expect(err(r)).toMatch(/ReadonlyLamportChange|UnbalancedInstruction|ExternalAccountLamportSpend/);
    expect(lamportsOf(dest)).toBe(1_000_000n);
    put(checked, source0, 5_000_000n);
    put(checked, dest, 1_000_000n);
    expect(
      customError(
        await move(checked, 1n, [
          { address: source0, writable: true },
          { address: dest, writable: false },
        ]),
      ),
    ).toBe(3006);
  });
});
