// systemProgram.createPda: Anchor's `init` with `seeds`, `space` and `owner = …` on an UncheckedAccount. The PDA is
// checked (2006), created owned by another program, or topped up, allocated and assigned when someone funded the
// address first; leading the body, it runs before the constraints, so an address in use fails creating (0) first.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lamports } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const OWNER = "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo";
const SOURCE = `import { type AccountInfo, type Mut, type Signer, type SystemProgram, constraint, pubkey } from "typesol";

export function open(payer: Mut<Signer>, slot: Mut<AccountInfo>, system: SystemProgram, ok: boolean): void {
  constraint(payer, ok);
  system.createPda(payer, slot, 300n, pubkey("${OWNER}"), ["slot", payer.key]);
}
`;

describe("systemProgram.createPda", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-create-pda-"));
    writeFileSync(path.join(dir, "a.ts"), SOURCE);
    d = await deployFile(path.join(dir, "a.ts"));
  });

  it("creates the PDA owned by another program, over a funded address too, before the constraints", async () => {
    const rent = d.svm.minimumBalanceForRentExemption(300n);
    const open = async (payerSol: Awaited<ReturnType<typeof fundedSigner>>, slot: string, ok = true) =>
      send(d.svm, payerSol, [
        ix(d, "open", { ok }, [
          { address: payerSol.address, signer: payerSol, writable: true },
          { address: slot as never, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    // Fresh: created, 300 bytes, owned by OWNER, rent-exempt.
    const a = await fundedSigner(d.svm);
    const [slotA] = await pda(d.programId, ["slot", a.address]);
    expect(customError(await open(a, slotA, false))).toBe(2003);
    expectOk(await open(a, slotA));
    const made = d.svm.getAccount(slotA);
    expect(made.exists && [made.programAddress, made.data.length, made.lamports]).toEqual([OWNER, 300, rent]);
    // In use: the create fails (AccountAlreadyInUse, 0) before the constraint is looked at.
    expect(customError(await open(a, slotA, false))).toBe(0);
    // Funded first, below and above the rent: topped up to rent (not past it), allocated, assigned.
    for (const funded of [1n, rent + 1_000n]) {
      const b = await fundedSigner(d.svm);
      const [slotB] = await pda(d.programId, ["slot", b.address]);
      d.svm.setAccount({ address: slotB, data: new Uint8Array(0), executable: false, lamports: lamports(funded), programAddress: SYSTEM_PROGRAM, space: 0n });
      expectOk(await open(b, slotB));
      const got = d.svm.getAccount(slotB);
      expect(got.exists && [got.programAddress, got.data.length, got.lamports]).toEqual([OWNER, 300, funded > rent ? funded : rent]);
    }
    // Not the PDA for the seeds: 2006.
    const c = await fundedSigner(d.svm);
    expect(customError(await open(c, slotA))).toBe(2006);
    // The IDL records the PDA, as Anchor's does for an init account's seeds.
    expect(d.idl.instructions[0]!.accounts.find((x) => x.name === "slot")).toMatchObject({
      writable: true,
      pda: { seeds: [{ kind: "const" }, { kind: "account", path: "payer" }] },
    });
  });

  it("takes a Mut<AccountInfo>", () => {
    expect(
      compileErrors(
        `import { type AccountInfo, type Mut, type Signer, type SystemProgram, pubkey } from "typesol";\nexport function f(p: Mut<Signer>, s: AccountInfo, sys: SystemProgram): void { sys.createPda(p, s, 8n, p.key, ["x"]); }`,
      ),
    ).toMatch(/must be a Mut<AccountInfo>/);
  });
});
