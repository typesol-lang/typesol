// TypeSOL derives PDAs with the sha256 and curve-validation syscalls instead of the PDA syscalls
// (runtime/typesol_rt.h ts_find_pda / ts_create_pda_address). These cases compare it with @solana/kit's derivation,
// which follows the runtime's: random seeds, canonical bumps below 255, on-curve bumps and over-long seeds.
import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, isOffCurveAddress } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";
import { pk } from "../ports-helpers.js";

const enc = getAddressEncoder();
// create_program_address: sha256(seeds ‖ program ‖ "ProgramDerivedAddress"), valid only off the curve.
const createPda = (program: Address, seeds: Uint8Array[]): Address | undefined => {
  const h = createHash("sha256");
  for (const s of seeds) h.update(s);
  h.update(new Uint8Array(enc.encode(program)));
  h.update("ProgramDerivedAddress");
  const address = getAddressDecoder().decode(h.digest());
  return isOffCurveAddress(address) ? address : undefined;
};
const u64le = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

describe("PDA derivation (sha256 + curve check) matches the runtime's", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/pda-derivation.ts", import.meta.url)));
  });

  it("finds the same canonical address for random seeds and programs", async () => {
    const payer = await fundedSigner(d.svm);
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
    let belowMax = 0;
    for (let i = 0; i < 160; i++) {
      const len = i % 33;
      const seedA = Array.from({ length: len }, (_, k) => alphabet[(i * 7 + k * 13) % alphabet.length]).join("");
      const seedB = (await generateKeyPairSigner()).address;
      const seedN = (BigInt(i) * 0x9e3779b97f4a7c15n) % (1n << 64n);
      const program = (await generateKeyPairSigner()).address;
      const [expected, bump] = await getProgramDerivedAddress({ programAddress: program, seeds: [seedA, enc.encode(seedB), u64le(seedN)] });
      if (bump < 255) belowMax++;
      const r = expectOk(
        await send(d.svm, payer, [ix(d, "derive", { seed_a: seedA, seed_b: pk(seedB), seed_n: new BN(seedN.toString()), program: pk(program) }, [])]),
      );
      expect(getAddressDecoder().decode(r.returnData().data())).toBe(expected);
    }
    // The canonical bump is below 255 about half the time: those cases walk past on-curve candidates.
    expect(belowMax).toBeGreaterThan(40);
  });

  it("accepts exactly the bumps create_program_address accepts", async () => {
    const payer = await fundedSigner(d.svm);
    let onCurve = 0;
    let offCurve = 0;
    for (let i = 0; i < 40; i++) {
      const seedA = `seed-${i}`;
      for (const bump of [255, 254, 253]) {
        // undefined: the hash is on the curve, so there is no PDA for this bump
        const address = createPda(d.programId, [new TextEncoder().encode(seedA), Uint8Array.of(bump)]);
        // The target: the PDA when there is one, else any address (the check must fail either way).
        const target = address ?? (await generateKeyPairSigner()).address;
        const r = await send(d.svm, payer, [ix(d, "check", { seed_a: seedA, bump }, [{ address: target }])]);
        if (address) {
          offCurve++;
          expectOk(r);
        } else {
          onCurve++;
          expect(customError(r)).toBe(2006);
        }
      }
    }
    expect(onCurve).toBeGreaterThan(10);
    expect(offCurve).toBeGreaterThan(10);
  });

  it("refuses seeds over 32 bytes, as the syscall does", async () => {
    const payer = await fundedSigner(d.svm);
    const program = (await generateKeyPairSigner()).address;
    const r = await send(d.svm, payer, [ix(d, "derive", { seed_a: "x".repeat(33), seed_b: pk(payer.address), seed_n: new BN(1), program: pk(program) }, [])]);
    expect(customError(r)).toBe(2006);
  });

  it("searches with 15 seeds, the most the syscall takes (16 is a compile error)", async () => {
    const payer = await fundedSigner(d.svm);
    const program = (await generateKeyPairSigner()).address;
    const seeds = "abcdefghijklmno".split("");
    const [expected] = await getProgramDerivedAddress({ programAddress: program, seeds });
    const ok = expectOk(await send(d.svm, payer, [ix(d, "most_seeds", { program: pk(program) }, [])]));
    expect(getAddressDecoder().decode(ok.returnData().data())).toBe(expected);
  });

  it("gives the address and its bump from one search (findProgramAddressWithBump)", async () => {
    const payer = await fundedSigner(d.svm);
    const saved: number[] = [];
    for (let i = 0; i < 24; i++) {
      const seedA = `pair-${i}`;
      const seedB = (await generateKeyPairSigner()).address;
      const program = (await generateKeyPairSigner()).address;
      const [expected, bump] = await getProgramDerivedAddress({ programAddress: program, seeds: [seedA, enc.encode(seedB), u64le(BigInt(i))] });
      const args = { seed_a: seedA, seed_b: pk(seedB), seed_n: new BN(i), program: pk(program) };
      const one = expectOk(await send(d.svm, payer, [ix(d, "derive_both", args, [])]));
      const two = expectOk(await send(d.svm, payer, [ix(d, "derive_twice", args, [])]));
      for (const r of [one, two]) {
        const out = r.returnData().data();
        expect(getAddressDecoder().decode(out.subarray(0, 32))).toBe(expected);
        expect(out[32]).toBe(bump);
      }
      saved.push(Number(two.computeUnitsConsumed() - one.computeUnitsConsumed()));
      const only = expectOk(await send(d.svm, payer, [ix(d, "bump_only", { seed_a: seedA, program: pk(program) }, [])]));
      expect(only.returnData().data()[0]).toBe((await getProgramDerivedAddress({ programAddress: program, seeds: [seedA] }))[1]);
    }
    // The second search cost what the first does: one sha256 and curve check per bump tried (453 to 2,118 CU here).
    expect(Math.min(...saved)).toBeGreaterThan(400);
  });

  it("refuses findProgramAddressWithBump anywhere but `const [address, bump] = …`", () => {
    const src = (body: string) =>
      `import { type Pubkey, findProgramAddressWithBump, log, programId } from "typesol";\nexport function f(k: Pubkey): void {\n${body}\n}`;
    expect(compileErrors(src(`  const [a, b] = findProgramAddressWithBump(["x", k], programId());\n  log(a);\n  log(b);`))).toBe("");
    expect(compileErrors(src(`  const pair = findProgramAddressWithBump(["x", k], programId());\n  log(pair[1]);`))).toContain(
      "bind both results where it is called: const [address, bump] = findProgramAddressWithBump(seeds, program)",
    );
    expect(compileErrors(src(`  let [a, b] = findProgramAddressWithBump(["x", k], programId());\n  log(a);`))).toContain("bind them with const");
    expect(compileErrors(src(`  const [a, b] = [k, k];\n  log(a);`))).toContain(
      "array destructuring is only for const [address, bump] = findProgramAddressWithBump",
    );
    expect(compileErrors(src(`  const [k2, ...rest] = findProgramAddressWithBump(["x", k], programId());\n  log(k2);`))).toContain(
      "name the address and the bump",
    );
  });
});
