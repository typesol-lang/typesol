// `const EVENT_AUTHORITY_CHECK = "address"`: emitCpi's accounts checked as Anchor 1.x's #[event_cpi] checks them. The
// event authority is compared by address among the constraints (ConstraintAddress, 2012, after the accounts load and
// the creates run) instead of by seeds when it loads (2006), and the program account is not checked: the self-CPI
// names this program's id whatever account was passed there. Without the constant nothing changes.
import { generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed, type Meta } from "../harness.js";

const TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const body = `
export interface Paid { who: Pubkey; amount: u64 }
export interface Note { n: u64 }
export function pay(payer: Signer, eventAuthority: EventAuthority, self: SelfProgram, amount: u64): void {
  emitCpi<Paid>({ who: payer.key, amount }, eventAuthority, self);
}
export function quiet(payer: Signer, eventAuthority: EventAuthority, self: SelfProgram): void {}
/** An account created before the event accounts' checks, as Anchor's init runs before them. */
export function make(payer: Mut<Signer>, note: Init<Note>, systemProgram: SystemProgram, eventAuthority: EventAuthority, self: SelfProgram, n: u64): void {
  note.create(payer, ["note", payer.key]);
  note.n = n;
  emitCpi<Paid>({ who: payer.key, amount: n }, eventAuthority, self);
}
`;
const header = `import { type EventAuthority, type Init, type Mut, type Pubkey, type SelfProgram, type Signer, type SystemProgram, type u64, emitCpi } from "typesol";\n`;

function program(withConstant: boolean): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "event-authority-check-"));
  const file = path.join(dir, "events.ts");
  writeFileSync(file, header + (withConstant ? `export const EVENT_AUTHORITY_CHECK = "address";\n` : "") + body);
  return file;
}

describe('EVENT_AUTHORITY_CHECK = "address"', () => {
  let byAddress: Deployed;
  let bySeeds: Deployed;
  beforeAll(async () => {
    byAddress = await deployFile(program(true));
    bySeeds = await deployFile(program(false));
  });
  const accounts = async (d: Deployed, payer: { address: string }, authority?: string, self?: string): Promise<Meta[]> => {
    const [ea] = await getProgramDerivedAddress({ programAddress: d.programId, seeds: ["__event_authority"] });
    return [
      { address: payer.address, signer: payer } as Meta,
      { address: (authority ?? ea) as Meta["address"] },
      { address: (self ?? d.programId) as Meta["address"] },
    ];
  };

  it("emits the event through the self-CPI as before", async () => {
    const payer = await fundedSigner(byAddress.svm);
    const r = expectOk(await send(byAddress.svm, payer, [ix(byAddress, "pay", { amount: new BN(7) }, await accounts(byAddress, payer))]));
    const inner = r.innerInstructions().flat();
    expect(inner.length).toBe(1);
    const data = Buffer.from(inner[0]!.instruction().data());
    expect(data.subarray(0, 8).equals(TAG)).toBe(true);
    const ev = byAddress.coder.events.decode(data.subarray(8).toString("base64"))!;
    expect([ev.name, (ev.data.amount as BN).toString()]).toEqual(["Paid", "7"]);
  });

  it("refuses another event authority with ConstraintAddress (2012); the default refuses it with ConstraintSeeds (2006)", async () => {
    const wrong = (await generateKeyPairSigner()).address;
    for (const [d, code] of [
      [byAddress, 2012],
      [bySeeds, 2006],
    ] as const) {
      const payer = await fundedSigner(d.svm);
      expect(customError(await send(d.svm, payer, [ix(d, "pay", { amount: new BN(1) }, await accounts(d, payer, wrong))]))).toBe(code);
    }
  });

  it("leaves the program account unchecked; the default requires this program (3008)", async () => {
    const other = (await generateKeyPairSigner()).address;
    // An instruction that emits nothing passes with any account there, as Anchor's does.
    const payer = await fundedSigner(byAddress.svm);
    expectOk(await send(byAddress.svm, payer, [ix(byAddress, "quiet", {}, await accounts(byAddress, payer, undefined, other))]));
    // One that emits makes its self-CPI to this program, which the runtime finds only among the instruction's
    // accounts: without it there, the CPI fails in the runtime (MissingAccount), as Anchor's emit_cpi! does.
    const r = await send(byAddress.svm, payer, [ix(byAddress, "pay", { amount: new BN(3) }, await accounts(byAddress, payer, undefined, other))]);
    expect(String((r as { err?: () => unknown }).err?.())).toContain("MissingAccount");
    const payer2 = await fundedSigner(bySeeds.svm);
    expect(customError(await send(bySeeds.svm, payer2, [ix(bySeeds, "quiet", {}, await accounts(bySeeds, payer2, undefined, other))]))).toBe(3008);
  });

  it("checks the address in an instruction that creates an account (the create runs first, then the constraints)", async () => {
    const payer = await fundedSigner(byAddress.svm);
    const [note] = await getProgramDerivedAddress({ programAddress: byAddress.programId, seeds: ["note", getAddressEncoder().encode(payer.address)] });
    const [ea] = await getProgramDerivedAddress({ programAddress: byAddress.programId, seeds: ["__event_authority"] });
    const metas = (authority: string): Meta[] => [
      { address: payer.address, signer: payer, writable: true },
      { address: note, writable: true },
      { address: "11111111111111111111111111111111" as Meta["address"] },
      { address: authority as Meta["address"] },
      { address: byAddress.programId },
    ];
    expect(customError(await send(byAddress.svm, payer, [ix(byAddress, "make", { n: new BN(1) }, metas((await generateKeyPairSigner()).address))]))).toBe(2012);
    expectOk(await send(byAddress.svm, payer, [ix(byAddress, "make", { n: new BN(1) }, metas(ea))]));
  });

  it('takes only "address"', () => {
    expect(compileErrors(header + `export const EVENT_AUTHORITY_CHECK = "seeds";\n` + body)).toContain('EVENT_AUTHORITY_CHECK must be "address"');
  });
});
