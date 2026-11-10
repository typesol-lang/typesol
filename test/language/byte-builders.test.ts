// Byte builders on FixedVec<u8, N> (test/fixtures/byte-builders.ts): pushLE, pushKey, pushBorsh, setLE and truncate, and
// Phoenix's event recorder built from them, its batches compared byte for byte with the Phoenix v1 binary's.
import { type Address, AccountRole, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, acct, compileErrors, customError, deployFile, expectOk, fundedSigner, pda, send } from "../harness.js";
import { type Result, cancelAllWithFreeFunds, initializeMarket, logsOf, phoenixMarket } from "../phoenix-helpers.js";
import { addrBytes } from "../ports-helpers.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/byte-builders.ts", import.meta.url));

/** Little-endian bytes of an integer of `bytes` width (two's complement for negatives). */
const le = (v: bigint, bytes: number) => {
  const out = new Uint8Array(bytes);
  let x = BigInt.asUintN(bytes * 8, v);
  for (let i = 0; i < bytes; i++, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
};
const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const innerData = (r: Result) =>
  expectOk(r)
    .innerInstructions()
    .flat()
    .map((i) => Buffer.from(i.instruction().data()));

describe("byte builders", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(FIXTURE);
    payer = await fundedSigner(d.svm);
  });
  let nonce = 0;
  const call = (data: (Uint8Array | number[])[], accounts: { address: Address; role?: AccountRole }[] = []) =>
    send(d.svm, payer, [
      {
        programAddress: d.programId,
        accounts: accounts.map((a) => ({ address: a.address, role: a.role ?? AccountRole.WRITABLE })),
        data: cat(...data, [nonce++ & 0xff]),
      },
    ]);
  const ret = (r: Result) => Buffer.from(expectOk(r).returnData().data());

  it("pushLE writes each integer type at its width, pushKey a Pubkey; setLE overwrites within the length", async () => {
    const out = ret(await call([[0], le(0x0102030405060708n, 8)]));
    const want = cat(
      [0xab],
      le(0xbeefn, 2), // pushLE<u16>(0x1234n), then setLE<u16>(1n, 0xbeefn)
      le(7n, 4), // pushLE(u32(0xdeadbeefn)), then setLE(3n, u32(7n))
      le(0x0102030405060708n, 8),
      le(1n << 100n, 16),
      le(-2n, 1),
      le(-3n, 2),
      le(-4n, 4),
      le(-5n, 8),
      le(-6n, 16),
      addrBytes(d.programId),
    );
    expect([...out]).toEqual([...want]);
  });

  it("pushBorsh encodes structs, data enums, lists, arrays, strings, Options, booleans and integers as Borsh", async () => {
    const owner = (await generateKeyPairSigner()).address;
    const out = ret(await call([[1]], [{ address: owner, role: AccountRole.READONLY }]));
    const o = addrBytes(owner);
    const want = cat(
      le(7n, 4),
      le(-1n, 2), // Point { x: u32, y: i16 }: its fixed layout is its Borsh form
      le(5n, 8),
      [0],
      o, // Quote { price, limit: None, owner }: through the struct's Borsh encoder, the None one byte
      le(6n, 8),
      [1],
      le(9n, 8),
      o, // Quote { limit: Some(9) }
      [3],
      le(3n, 2),
      le(100n, 8), // PhoenixMarketEvent::Fee
      [0], // PhoenixMarketEvent::Uninitialized
      le(2n, 4),
      le(1n, 2),
      le(2n, 2), // FixedVec<u16, 4> [1, 2]: a Borsh Vec
      [9, 9, 9], // FixedArray<u8, 3>
      le(2n, 4),
      [104, 105], // "hi"
      [0], // u32 | null = null
      [1],
      le(77n, 4), // Some(77)
      [1], // true
      le(513n, 2),
    );
    expect([...out]).toEqual([...want]);
  });

  it("builds Phoenix's empty event batch byte for byte as the Phoenix binary sends it", async () => {
    const m = await phoenixMarket();
    expectOk(await initializeMarket(m));
    const phoenix = innerData(await cancelAllWithFreeFunds(m));
    expect(phoenix).toHaveLength(1);
    const batch = phoenix[0]!;
    expect(batch.length).toBe(93);
    // The same instruction and sequence number, in the same VM (same clock), market and signer.
    const port = await deployFile(FIXTURE, { svm: m.svm });
    const [logAuthority] = await pda(port.programId, ["log"]);
    const r = await send(m.svm, m.payer, [
      {
        programAddress: port.programId,
        accounts: [
          { address: port.programId, role: AccountRole.READONLY },
          { address: logAuthority, role: AccountRole.READONLY },
          { address: m.market, role: AccountRole.READONLY },
          { address: m.payer.address, role: AccountRole.READONLY_SIGNER, signer: m.payer },
        ] as never,
        data: cat([2, batch[2]!], batch.subarray(3, 11), le(0n, 8)),
      },
    ]);
    const ours = innerData(r);
    expect(ours).toHaveLength(1);
    expect([...ours[0]!]).toEqual([...batch]);
    expect(logsOf(r)).toContain("Program log: Sending batch 1 with header and 0 market events, total events sent: 0");
  });

  it("flushes full batches mid-way and patches each one's count, as Phoenix's recorder does", async () => {
    const [logAuthority] = await pda(d.programId, ["log"]);
    const market = (await generateKeyPairSigner()).address;
    const r = await call(
      [[2, 7], le(42n, 8), le(40n, 8)],
      [
        { address: d.programId, role: AccountRole.READONLY },
        { address: logAuthority, role: AccountRole.READONLY },
        { address: market, role: AccountRole.READONLY },
        { address: payer.address, role: AccountRole.READONLY },
      ],
    );
    const batches = innerData(r);
    // 93 + 17 × 67 + 34 = 1266 fits in 1280; an 18th Fill (67 bytes) would not.
    expect(batches.map((b) => b.length)).toEqual([93 + 17 * 67, 93 + 17 * 67, 93 + 6 * 67]);
    expect(batches.map((b) => b.readUInt16LE(91))).toEqual([17, 17, 6]);
    expect(logsOf(r).filter((l) => l.includes("Sending batch"))).toEqual([
      "Program log: Sending batch 1 with header and 17 market events, total events sent: 17",
      "Program log: Sending batch 2 with header and 17 market events, total events sent: 34",
      "Program log: Sending batch 3 with header and 6 market events, total events sent: 40",
    ]);
    let index = 0;
    for (const b of batches) {
      expect([...b.subarray(0, 3)]).toEqual([15, 1, 7]);
      expect(b.readBigUInt64LE(3)).toBe(42n);
      expect([...b.subarray(27, 59)]).toEqual([...addrBytes(market)]);
      for (let at = 93; at < b.length; at += 67, index++) {
        const want = cat([2], le(BigInt(index), 2), addrBytes(payer.address), le(BigInt(index), 8), le(1000n + BigInt(index), 8), le(1n, 8), le(0n, 8));
        expect([...b.subarray(at, at + 67)]).toEqual([...want]);
      }
    }
    expect(index).toBe(40);
  });

  it("writes a FixedVec<u8, N> in account data in place, bounded by its room", async () => {
    const a = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: a, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data: new Uint8Array(20) } as never);
    expectOk(await call([[3]], [{ address: a }]));
    let data = acct(d.svm, a).data;
    expect([...data]).toEqual([...cat(le(12n, 4), le(0x01020304n, 4), le(5n, 8), [0, 0, 0, 0])]);
    expectOk(await call([[4]], [{ address: a }]));
    data = acct(d.svm, a).data;
    expect([...data.subarray(0, 8)]).toEqual([...cat(le(4n, 4), [4, 3, 0xff, 0xff])]);
    // 4 + 12 bytes fill the room; 12 more do not.
    expectOk(await call([[3]], [{ address: a }]));
    expect(customError(await call([[3]], [{ address: a }]))).toBe(5104);
  });

  it("fails with 5104 past the room or the length", async () => {
    for (const tag of [5, 6, 7, 8, 9, 10]) expect(customError(await call([[tag]]))).toBe(5104);
    expect(logsOf(expectOk(await call([[11]])))).toContain("Program log: no failure");
  });

  it("refuses misuse at compile time", () => {
    const head = `import { FixedVec, Pubkey, fixedVec, u8, u64 } from "typesol";\nexport interface P { a: u64 }\n`;
    const body = (s: string) => `${head}export function f(k: Pubkey): void { const b: FixedVec<u8, 8> = fixedVec([]); ${s} }`;
    expect(compileErrors(body("b.pushLE(5n);"))).toMatch(/pushLE needs the integer's width: pushLE<u16>\(…\) or pushLE\(u16\(…\)\)/);
    expect(compileErrors(body("b.setLE(0n, 5n);"))).toMatch(/setLE needs the integer's width/);
    expect(compileErrors(body("b.pushLE(k);"))).toContain("Argument of type 'Pubkey' is not assignable to parameter of type 'bigint'.");
    expect(compileErrors(body("b.pushBorsh({ a: 1n });"))).toMatch(/pushBorsh\(\{ … \}\) needs the value's type: buf.pushBorsh<Header>/);
    expect(compileErrors(body("b.pushBorsh(5n);"))).toMatch(/pushBorsh needs the integer's width/);
    expect(compileErrors(body("b.pushLE<boolean>(true);"))).toContain("Type 'boolean' does not satisfy the constraint 'bigint'.");
    expect(compileErrors(`${head}export function f(): void { const b: FixedVec<u64, 8> = fixedVec([]); b.pushLE(u64(1n)); }`)).toMatch(
      /pushLE\(\) builds bytes in a FixedVec<u8, N>/,
    );
    expect(compileErrors(body("b.truncate(1n, 2n);"))).toMatch(/Expected 1 arguments|takes the new length/);
  });
});
