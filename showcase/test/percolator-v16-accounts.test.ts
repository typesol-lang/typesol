// The account checks of the ported instructions of the Percolator v16 port against the reference (Percolator v16 at
// commit 7b110913, engine 5e3af07, aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0;
// test/programs/percolator_v16.so, the Rust build of those commits, not a deployed program), swept exhaustively from a
// valid transaction of each in the world of percolator-v16-world.ts:
//
// - every ordered pair of account positions (i, j): the account at i passed at j too (the original's repeated
//   accounts share one RefCell, so where it holds a borrow of one position while borrowing the other it fails with
//   AccountBorrowFailed; the port checks the keys there);
// - every position with its signer flag dropped, its writable flag dropped, and replaced by each account of the world
//   (other kinds, other owners, the token programs, SPL Token-2022, the zero key);
// - the list cut to each shorter length and one account longer.
//
// Each mutated transaction is compared whole (outcome, logs, inner instructions, return data, every named account) and
// the world restored after it.
import { AccountRole } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { SYSTEM } from "./percolator-helpers.js";
import { HAVE_PORT, HAVE_REFERENCE, PROGRAM } from "./percolator-v16-helpers.js";
import { NAMES, SEED, TAGS, World, withAccount } from "./percolator-v16-world.js";

const isSigner = (r: AccountRole) => r === AccountRole.READONLY_SIGNER || r === AccountRole.WRITABLE_SIGNER;
const isWritable = (r: AccountRole) => r === AccountRole.WRITABLE || r === AccountRole.WRITABLE_SIGNER;
const roleOf = (signer: boolean, writable: boolean) =>
  signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : writable ? AccountRole.WRITABLE : AccountRole.READONLY;

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: every account position of the ported instructions", () => {
  let w: World;
  const tally = { sent: 0, ok: 0 };
  beforeAll(async () => {
    w = await World.build(SEED);
  });

  for (const tag of TAGS) {
    it(`${NAMES[tag]} (${tag})`, async () => {
      const rng = new Rng(SEED + BigInt(tag));
      const { payer, ix: base } = await w.base(tag, rng);
      const accounts = base.accounts ?? [];
      const n = accounts.length;
      const variants: [string, typeof base][] = [];
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          if (i !== j) {
            const ai = accounts[i]!;
            const aj = accounts[j]!;
            if (ai.address === PROGRAM && isWritable(aj.role)) continue;
            variants.push([
              `position ${i} again at ${j}`,
              withAccount(w, base, j, ai.address, roleOf(isSigner(aj.role) || isSigner(ai.role), isWritable(aj.role))),
            ]);
          }
      for (let j = 0; j < n; j++) {
        const aj = accounts[j]!;
        if (isSigner(aj.role)) variants.push([`position ${j} not signing`, withAccount(w, base, j, aj.address, roleOf(false, isWritable(aj.role)))]);
        if (isWritable(aj.role)) variants.push([`position ${j} read-only`, withAccount(w, base, j, aj.address, roleOf(isSigner(aj.role), false))]);
        for (const other of w.pool())
          // The program itself cannot be passed writable (the invoked program is never writable).
          if (other !== aj.address && !(other === PROGRAM && isWritable(aj.role)))
            variants.push([`position ${j} = ${other.slice(0, 6)}`, withAccount(w, base, j, other, aj.role)]);
      }
      for (let k = 0; k < n; k++) variants.push([`${k} accounts`, { ...base, accounts: accounts.slice(0, k) }]);
      variants.push([`one more account`, { ...base, accounts: [...accounts, { address: w.m.market, role: AccountRole.WRITABLE }] }]);
      for (const [label, v] of variants) {
        const got = await w.d.send(`${NAMES[tag]}: ${label}`, payer, [v]);
        tally.sent++;
        if (got === "ok") tally.ok++;
        w.restore();
      }
      expect(variants.length).toBeGreaterThan(n);
    }, 600_000);
  }

  // Last, as it takes a world key and a new snapshot: an account the snapshot records as missing, created since, is
  // removed again by a restore in both VMs.
  it("restores an account recorded as missing by removing it", async () => {
    const at = await w.d.address();
    w.take();
    w.d.write(at, SYSTEM, new Uint8Array(8), 1_000_000_000n);
    for (const vm of w.d.vms) expect(vm.getAccount(at).exists).toBe(true);
    w.restore();
    for (const vm of w.d.vms) expect(vm.getAccount(at).exists).toBe(false);
  });

  it("records the count", () => {
    console.log(`account sweep: ${tally.sent} transactions compared, ${tally.ok} succeeded in both`);
    expect(tally.sent).toBeGreaterThan(1000);
  });
});
