// PDAs of this program signing CPIs: systemProgram.transfer out of a SOL vault PDA, and two PDAs signing one invoke.
import { type Address, type KeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const pk = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as never)), toBase58: () => a });

describe("PDA signers (test/fixtures/pda-signers.ts)", () => {
  let d: Deployed;
  let owner: KeyPairSigner;
  let vault: Address;
  let vaultBump: number;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/pda-signers.ts", import.meta.url)));
    owner = await fundedSigner(d.svm, 5n);
    [vault, vaultBump] = await pda(d.programId, ["sol", owner.address]);
    d.svm.airdrop(vault, lamports(2_000_000_000n));
  });

  it("pays out of a system-owned vault PDA with systemProgram.transfer", async () => {
    const to = (await fundedSigner(d.svm, 1n)).address;
    const before = acct(d.svm, to).lamports;
    const withdraw = (bump: number, amount: bigint) =>
      send(d.svm, owner, [
        ix(d, "withdraw", { bump, amount: new BN(amount.toString()) }, [
          { address: owner.address, signer: owner },
          { address: vault, writable: true },
          { address: to, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await withdraw(vaultBump, 300_000_000n));
    expect(acct(d.svm, to).lamports - before).toBe(300_000_000n);
    expect(acct(d.svm, vault).lamports).toBe(1_700_000_000n);
    // A wrong bump derives another address, which cannot sign for the vault.
    const bad = await withdraw(vaultBump === 255 ? 254 : vaultBump + 1, 1n);
    expect(bad).toBeInstanceOf(FailedTransactionMetadata);
    expect(acct(d.svm, vault).lamports).toBe(1_700_000_000n);
  });

  it("signs one CPI for two PDAs", async () => {
    const [box, boxBump] = await pda(d.programId, ["box", owner.address]);
    expectOk(
      await send(d.svm, owner, [
        ix(d, "box_up", { vault_bump: vaultBump, box_bump: boxBump, lamports: new BN(10_000_000) }, [
          { address: owner.address, signer: owner },
          { address: vault, writable: true },
          { address: box, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const b = acct(d.svm, box);
    expect([b.lamports, b.data.length, b.programAddress]).toEqual([10_000_000n, 8, d.programId]);
  });
  it("signs an invokeInstruction for two PDAs, and only for the PDAs the seeds derive", async () => {
    const [crate, crateBump] = await pda(d.programId, ["crate", owner.address]);
    const data = Buffer.alloc(52);
    data.writeUInt32LE(0, 0); // CreateAccount
    data.writeBigUInt64LE(5_000_000n, 4);
    data.writeBigUInt64LE(16n, 12);
    Buffer.from(getAddressEncoder().encode(d.programId)).copy(data, 20);
    const run = (bump: number) =>
      send(d.svm, owner, [
        ix(
          d,
          "run_signed",
          {
            metas: [
              { pubkey: pk(vault), is_signer: true, is_writable: true },
              { pubkey: pk(crate), is_signer: true, is_writable: true },
            ],
            data,
            vault_bump: vaultBump,
            crate_bump: bump,
          },
          [
            { address: owner.address, signer: owner },
            // remainingAccounts(): the accounts the stored instruction names, and the program it calls.
            { address: vault, writable: true },
            { address: crate, writable: true },
            { address: SYSTEM_PROGRAM },
          ],
        ),
      ]);
    expect(await run(crateBump === 255 ? 254 : crateBump + 1)).toBeInstanceOf(FailedTransactionMetadata);
    expectOk(await run(crateBump));
    const c = acct(d.svm, crate);
    expect([c.lamports, c.data.length, c.programAddress]).toEqual([5_000_000n, 16, d.programId]);
  });
});

// A seed list holds pointers to its seeds, read when the CPI runs: a list bound to a name, or given to a helper, keeps
// the values its seeds had when it was written (JS evaluates the array then), and so does a list read before a later
// argument of the same call that changes a seed.
const SEEDS_ORDER = `import { type u64, type u8, type Pubkey, type Mut, type Signer, type Init, type AccountInfo, type SystemProgram, type SignerSeeds, signer } from "typesol";
export interface State { count: u64; who: Pubkey }
export interface Box { n: u64 }
export function setup(payer: Mut<Signer>, st: Init<State>, sys: SystemProgram): void { st.create(payer, ["st"]); st.count = 5n; st.who = payer.key; }
export function pay(st: Mut<State>, vault: Mut<AccountInfo>, to: Mut<AccountInfo>, sys: SystemProgram, bump: u8): void {
  const s = signer(["vault", st.count, bump]);
  st.count += 1n;
  sys.transfer(vault, to, 1000n, s);
}
export function payKey(st: Mut<State>, vault: Mut<AccountInfo>, to: Mut<AccountInfo>, other: AccountInfo, sys: SystemProgram, bump: u8): void {
  let who = st.who;
  const s = signer(["key", who, bump]);
  who = other.key;
  sys.transfer(vault, to, 1000n, s);
}
function payAfterBump(st: Mut<State>, vault: Mut<AccountInfo>, to: Mut<AccountInfo>, sys: SystemProgram, s: SignerSeeds): void {
  st.count += 1n;
  sys.transfer(vault, to, 1000n, s);
}
export function payHelper(st: Mut<State>, vault: Mut<AccountInfo>, to: Mut<AccountInfo>, sys: SystemProgram, bump: u8): void {
  payAfterBump(st, vault, to, sys, signer(["vault", st.count, bump]));
}
function space(st: Mut<State>): u64 { st.count += 1n; return 16n; }
export function make(payer: Mut<Signer>, st: Mut<State>, b: Init<Box>, sys: SystemProgram): void {
  b.create(payer, ["box", st.count], space(st));
}
`;

describe("seed lists keep the seeds they were written with", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let st: Address;
  let to: Address;
  const u64le = (n: bigint) => new Uint8Array(new BigUint64Array([n]).buffer);
  const vaultAt = async (n: bigint) => {
    const [v, bump] = await pda(d.programId, ["vault", u64le(n)]);
    d.svm.airdrop(v, lamports(10_000_000n));
    return { v, bump };
  };
  const count = () => Buffer.from(acct(d.svm, st).data).readBigUInt64LE(8);
  const pay = async (name: string, n: bigint) => {
    const { v, bump } = await vaultAt(n);
    return send(d.svm, payer, [
      ix(d, name, { bump }, [{ address: st, writable: true }, { address: v, writable: true }, { address: to, writable: true }, { address: SYSTEM_PROGRAM }]),
    ]);
  };
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-seeds-order-"));
    writeFileSync(path.join(dir, "seeds.ts"), SEEDS_ORDER);
    d = await deployFile(path.join(dir, "seeds.ts"));
    payer = await fundedSigner(d.svm);
    to = (await fundedSigner(d.svm, 1n)).address;
    [st] = await pda(d.programId, ["st"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: st, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
  });

  it("a bound list signs for the field as it was when the list was written", async () => {
    expect(count()).toBe(5n);
    expectOk(await pay("pay", 5n));
    expect(count()).toBe(6n);
    // The field is 6 now and becomes 7 before the transfer: the list says 6, so the vault of 7 cannot be signed for.
    expect(await pay("pay", 7n)).toBeInstanceOf(FailedTransactionMetadata);
    expect(count()).toBe(6n);
  });

  it("a list given to a helper keeps its seeds while the helper changes the field", async () => {
    expectOk(await pay("pay_helper", 6n));
    expect(count()).toBe(7n);
  });

  it("a Pubkey local reassigned after the list was written", async () => {
    const other = (await fundedSigner(d.svm, 1n)).address;
    const keyed = async (who: Address) => {
      const [v, bump] = await pda(d.programId, ["key", who]);
      d.svm.airdrop(v, lamports(10_000_000n));
      return send(d.svm, payer, [
        ix(d, "pay_key", { bump }, [
          { address: st, writable: true },
          { address: v, writable: true },
          { address: to, writable: true },
          { address: other },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    };
    expectOk(await keyed(payer.address));
    expect(await keyed(other)).toBeInstanceOf(FailedTransactionMetadata);
  });

  it("create's seeds are read before its space argument runs", async () => {
    // count is 7: the seeds say 7, then space() makes it 8.
    const [box] = await pda(d.programId, ["box", u64le(7n)]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "make", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: st, writable: true },
          { address: box, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(count()).toBe(8n);
  });
});
