// Whole-value copies and zero-fills by the memory syscalls (test/fixtures/bulk-copies.ts): struct assignments below
// the copy threshold between pointers (3, 6, 16, 40, 72 and 79 bytes, loads before stores) and from it (80, 87, 1,024
// bytes, the memmove syscall), between disjoint and overlapping views of one account in both directions, unaligned offsets, an account
// passed twice; copies through a local around its threshold (399 and 400 bytes); a struct literal built in a
// temporary; an Option<struct> set to null below and at the zero threshold (191 and 192 bytes); resizeAccount's zero-fill around its threshold (63, 64, 65 bytes) and at 8 KiB; failed checks copy
// nothing; and compute-unit ceilings that pin the gain.
import { type Address, type KeyPairSigner, AccountRole, generateKeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM, TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { acct as acctOf, deployFile, fundedSigner, send } from "../harness.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/bulk-copies.ts", import.meta.url));
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const LEN = 4_096;
const pattern = (len = LEN) => Buffer.from(Array.from({ length: len }, (_, i) => (i * 7 + 3) & 0xff));
// The struct sizes of the copying tags (tag 4 builds a B1024 literal; 8 and 9 copy through a local).
const SIZE = [79, 80, 87, 1024, 1024, 0, 0, 0, 399, 400, 3, 6, 16, 40, 72] as const;
// The tags that copy one struct to another place of its type: below the threshold, from it, through a local.
const COPIES = [10, 11, 12, 13, 14, 0, 1, 2, 3, 8, 9] as const;

describe("whole-value copies and zero-fills by the memory syscalls", () => {
  let svm: LiteSVM;
  let programId: Address;
  let payer: KeyPairSigner;
  let account: Address;
  let other: Address;
  beforeAll(async () => {
    const d = await deployFile(FIXTURE);
    svm = d.svm;
    programId = d.programId;
    payer = await fundedSigner(svm);
    account = (await generateKeyPairSigner()).address;
    other = (await generateKeyPairSigner()).address;
  });
  const reset = (address = account, len = LEN, data = pattern(len)) =>
    svm.setAccount({
      address,
      data: new Uint8Array(data),
      executable: false,
      lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(len + 10_240))),
      programAddress: programId,
      space: BigInt(len),
    });
  let nonce = 0;
  const call = (tag: number, dst: number | bigint, src: number | bigint, opts: { run?: boolean; role?: AccountRole; accounts?: Address[] } = {}) =>
    send(svm, payer, [
      {
        programAddress: programId,
        accounts: (opts.accounts ?? [account]).map((address) => ({ address, role: opts.role ?? AccountRole.WRITABLE })),
        data: new Uint8Array(Buffer.concat([Buffer.from([tag]), u64(dst), u64(src), Buffer.from([opts.run === false ? 0 : 1, nonce++ & 0xff])])),
      },
    ]);
  const ok = (r: TransactionMetadata | FailedTransactionMetadata, what: string) => {
    if (r instanceof FailedTransactionMetadata) throw new Error(`${what}: ${String(r.err())}\n${r.meta().logs().join("\n")}`);
    return r;
  };
  const data = (address = account) => Buffer.from(acctOf(svm, address).data);

  it("copies disjoint and backward-overlapping ranges as a copy of the old bytes, below and from the threshold", async () => {
    for (const tag of [...COPIES, 4]) {
      const n = SIZE[tag]!;
      for (const [dst, src] of [
        [0, 2_000],
        [3, 1_501], // unaligned on both sides
        [100, 101], // backward overlap: one byte apart
        [100, 108],
        [100, 100 + n - 1],
        [500, 500], // the same place
      ] as const) {
        if (dst + n > LEN || src + n > LEN) continue;
        reset();
        ok(await call(tag, dst, src), `tag ${tag} ${src} -> ${dst}`);
        const want = pattern();
        want.copyWithin(dst, src, src + n);
        if (tag === 4) want.writeBigUInt64LE(pattern().readBigUInt64LE(dst) + 1n, dst); // head: the old head + 1
        expect(data().equals(want), `tag ${tag} (${n} bytes) ${src} -> ${dst}`).toBe(true);
      }
    }
  });

  it("copies a forward overlap as a copy of the old bytes at every size, below and from the threshold", async () => {
    for (const tag of COPIES) {
      const n = SIZE[tag]!;
      for (const [dst, src] of [
        [101, 100],
        [108, 100],
        [103, 100],
        [100 + n - 1, 100],
        [103, 101], // unaligned on both sides
      ] as const) {
        reset();
        ok(await call(tag, dst, src), `tag ${tag} ${src} -> ${dst}`);
        // The destination ends with the source's old bytes (Rust's copy_within, JS's copy of a value): below 80 bytes
        // every byte is read before any is written, from 80 the memmove syscall copies them.
        const want = pattern();
        want.copyWithin(dst, src, src + n);
        expect(data().equals(want), `tag ${tag} (${n} bytes) ${src} -> ${dst}`).toBe(true);
      }
    }
  });

  it("refuses an account passed twice (2040) before copying, and copies between two accounts", async () => {
    // Without NATIVE_ACCOUNT_WRITES a mutable view claims its account: passed again, it fails before the copy.
    reset();
    const twice = await call(3, 40, 8, { accounts: [account, account] });
    expect(String((twice as FailedTransactionMetadata).err())).toMatch(/code: 2040/);
    expect(data().equals(pattern())).toBe(true);
    reset();
    reset(other, LEN, Buffer.alloc(LEN, 0x5a));
    ok(await call(3, 16, 32, { accounts: [account, other] }), "two accounts");
    const want = pattern();
    want.fill(0x5a, 16, 16 + 1024);
    expect(data().equals(want)).toBe(true);
  });

  it("copies between two views of an account passed twice under NATIVE_ACCOUNT_WRITES (one buffer), overlapping", async () => {
    const w = await deployFile(fileURLToPath(new URL("../fixtures/bulk-copies-writes.ts", import.meta.url)), { svm });
    for (const [tag, n] of [
      [1, 80],
      [2, 1024],
    ] as const)
      for (const [dst, src] of [
        [40, 8],
        [8, 40],
      ] as const) {
        // An account of the second fixture's own.
        svm.setAccount({
          address: other,
          data: new Uint8Array(pattern()),
          executable: false,
          lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(LEN))),
          programAddress: w.programId,
          space: BigInt(LEN),
        });
        ok(
          await send(svm, payer, [
            {
              programAddress: w.programId,
              accounts: [
                { address: other, role: AccountRole.WRITABLE },
                { address: other, role: AccountRole.WRITABLE },
              ],
              data: new Uint8Array(Buffer.concat([Buffer.from([tag]), u64(dst), u64(src), Buffer.from([nonce++ & 0xff])])),
            },
          ]),
          `${n} bytes ${src} -> ${dst}`,
        );
        const want = pattern();
        want.copyWithin(dst, src, src + n);
        expect(data(other).equals(want), `${n} bytes ${src} -> ${dst}`).toBe(true);
      }
  });

  it("checks the views before the copy: past the end (AccountDataTooSmall) and a read-only account (3006) copy nothing", async () => {
    for (const tag of [0, 1, 3, 4]) {
      const n = SIZE[tag]!;
      for (const [dst, src] of [
        [LEN - n + 1, 0],
        [0, LEN - n + 1],
        [0, 0xffff_ffff_ffff_fff0n],
      ] as const) {
        reset();
        const r = await call(tag, dst, src);
        expect(r, `tag ${tag} ${src} -> ${dst}`).toBeInstanceOf(FailedTransactionMetadata);
        expect(String((r as FailedTransactionMetadata).err())).toMatch(/AccountDataTooSmall/);
        expect(data().equals(pattern())).toBe(true);
      }
      reset();
      const ro = await call(tag, 0, 2_000, { role: AccountRole.READONLY });
      expect(String((ro as FailedTransactionMetadata).err())).toMatch(/code: 3006/);
      expect(data().equals(pattern())).toBe(true);
    }
  });

  it("sets an Option<struct> to null: tag and value zeroed, below (191 bytes) and from (192) the zero threshold", async () => {
    for (const [tag, n] of [
      [5, 191],
      [6, 192],
    ] as const) {
      reset();
      ok(await call(tag, 7, 0), `tag ${tag}`);
      const want = pattern();
      want.fill(0, 7, 7 + 1 + n);
      expect(data().equals(want), `Option of ${n} bytes`).toBe(true);
    }
  });

  it("zeroes the bytes resizeAccount adds, around the run-time threshold and at 8 KiB, and keeps the old ones", async () => {
    for (const grow of [0, 1, 7, 8, 63, 64, 65, 1_000, 8_192]) {
      // The account's old bytes past its length are not visible: start from a shorter account of the pattern.
      reset(account, 100);
      ok(await call(7, 100 + grow, 0), `grow ${grow}`);
      const want = Buffer.concat([pattern(100), Buffer.alloc(grow)]);
      expect(data().equals(want), `grow ${grow}`).toBe(true);
    }
    // Shrinking and growing back in one instruction is two calls in two transactions here; a shrink zeroes nothing.
    reset(account, 300);
    ok(await call(7, 120, 0), "shrink");
    expect(data().equals(pattern(120))).toBe(true);
  });

  it("costs at most 30 compute units to copy a 1 KiB struct (and a 79-byte one) and 60 to zero-fill 8 KiB on resize", async () => {
    const cu = (r: TransactionMetadata | FailedTransactionMetadata) => ok(r, "cu").computeUnitsConsumed();
    // The same instruction with the copy skipped (the views made, the same checks) is the baseline.
    reset();
    const skip = cu(await call(3, 0, 2_000, { run: false }));
    reset();
    const copy = cu(await call(3, 0, 2_000));
    // Measured: 16 (the word loop: about 1,027).
    expect(copy - skip).toBeLessThanOrEqual(30n);
    reset();
    const literal = cu(await call(4, 0, 2_000));
    // The literal: the array copied into the temporary, the temporary into place. Measured: 2 × 16 and the head.
    expect(literal - skip).toBeLessThanOrEqual(60n);
    // Below the threshold every byte is loaded before any is stored: no more than the forward word loop cost
    // (measured: 79 bytes 27, the loop 38; 16 bytes 9, the loop 10).
    for (const [tag, most] of [
      [0, 30n],
      [12, 10n],
    ] as const) {
      reset();
      const base = cu(await call(tag, 0, 2_000, { run: false }));
      reset();
      expect(cu(await call(tag, 2_000, 0)) - base, `tag ${tag}`).toBeLessThanOrEqual(most);
    }
    reset(account, 100);
    const same = cu(await call(7, 100, 0));
    reset(account, 100);
    const grown = cu(await call(7, 100 + 8_192, 0));
    // Measured: 41 (the stores: about 4,100).
    expect(grown - same).toBeLessThanOrEqual(60n);
  });
});
