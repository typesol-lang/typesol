// What a native port builds on the stack: local lists of structs and bytes (`FixedVec<Meta, 4>`, `fixedVec([])`),
// the instruction data as a list (slices, for … of, list methods, a bulk copy with pushAll), and invokeInstruction
// from a helper with metas the helper built (as Rust's instruction builders do).
import {
  type FixedArray,
  type FixedVec,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccounts,
  u8,
  ProgramError,
  fixedArray,
  fixedVec,
  instructionData,
  invokeInstruction,
  log,
  remainingAccounts,
  require,
  u64,
} from "typesol";

export interface Meta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

/** A sum of bytes, for checking what was copied. */
function sum(bytes: InstructionBytes): u64 {
  return bytes.reduce((acc, b) => acc + u64(b), 0n);
}

/**
 * system_instruction::transfer(from, to, lamports) built here and invoked: the metas name the accounts by key (`to` is
 * read from the data when `named`, so it may be an account the transaction does not hold).
 */
function transfer(rest: RemainingAccounts, data: InstructionBytes, named: boolean): void {
  const to = named ? data.readPubkey(9n) : rest.get(1n).key;
  const metas: FixedVec<Meta, 2> = fixedVec([{ pubkey: rest.get(0n).key, isSigner: true, isWritable: true }]);
  metas.push({ pubkey: to, isSigner: false, isWritable: true });
  const ix: FixedVec<u8, 12> = fixedVec([2n, 0n, 0n, 0n]);
  ix.pushAll(data.slice(1n, 9n));
  invokeInstruction(rest.get(2n).key, metas, ix, rest);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  if (tag === 0n) {
    // A bulk copy of the data after the tag.
    const out: FixedVec<u8, 1200> = fixedVec([]);
    out.pushAll(data.slice(1n));
    log(`copied ${out.length} last ${out.get(out.length - 1n)}`);
    return;
  }
  if (tag === 1n) {
    // The same, one push at a time.
    const out: FixedVec<u8, 1200> = fixedVec([]);
    for (const b of data.slice(1n)) out.push(b);
    log(`copied ${out.length} last ${out.get(out.length - 1n)}`);
    return;
  }
  if (tag === 2n || tag === 3n) {
    transfer(remainingAccounts(), data, tag === 3n);
    log("transferred");
    return;
  }
  if (tag === 4n) {
    // Struct lists on the stack.
    const rest = remainingAccounts();
    const k = rest.get(0n).key;
    const metas: FixedVec<Meta, 4> = fixedVec([{ pubkey: k, isSigner: false, isWritable: false }]);
    metas.push({ pubkey: rest.get(1n).key, isSigner: true, isWritable: true });
    metas.set(0n, { pubkey: k, isSigner: false, isWritable: true });
    log(`metas ${metas.length} writable ${metas.filter((m) => m.isWritable).length} signer ${metas.findIndex((m) => m.isSigner)}`);
    for (const m of metas) log(m.pubkey);
    metas.pop();
    const empty: FixedVec<Meta, 3> = fixedVec([]);
    log(`after pop ${metas.length} empty ${empty.length}`);
    const pair: FixedArray<Meta, 2> = fixedArray({ pubkey: k, isSigner: false, isWritable: false });
    pair.set(1n, { pubkey: rest.get(1n).key, isSigner: true, isWritable: false });
    log(`pair ${pair.get(0n).pubkey === pair.get(1n).pubkey} ${pair.some((m) => m.isSigner)}`);
    // Struct lists appended whole: a FixedArray, then a FixedVec.
    const all: FixedVec<Meta, 4> = fixedVec([]);
    all.pushAll(pair);
    all.pushAll(metas);
    log(`all ${all.length} ${all.get(1n).isSigner} ${all.get(2n).pubkey === k}`);
    // Inline fixedArray(…) under a chain, a list method and for … of.
    const s = fixedArray<u64, 3>(2n)
      .map((x) => x * 5n)
      .reduce((a, b) => a + b, 0n);
    let t = 0n;
    for (const x of fixedArray<u64, 4>(3n)) t += x;
    log(`inline ${s} ${t} ${fixedArray<Meta, 2>({ pubkey: k, isSigner: true, isWritable: false }).every((m) => m.isSigner)}`);
    return;
  }
  if (tag === 5n) {
    // Slices: views, checked against the length (5104).
    const body = data.slice(1n);
    const head = body.slice(0n, 2n);
    log(`len ${body.length} head ${head.length} ${head.get(1n)} sum ${sum(body)} ${sum(data.slice(2n, 4n))}`);
    log(`le ${body.readU16(0n)} max ${body.map((b) => u64(b)).filter((b) => b > 2n).length} has ${body.includes(u8(7n))}`);
    const out: FixedVec<u8, 4> = fixedVec([]);
    out.pushAll(head);
    out.pushAll(data.slice(1n, 3n));
    log(`out ${out.length} ${out.get(3n)}`);
    // Past the end: 5104.
    const far = data.slice(1n, data.length + u64(data.readU8(1n) === 9n ? 1n : 0n));
    log(`far ${far.length}`);
    return;
  }
  if (tag === 6n) {
    // More than the room left: 5104, nothing appended.
    const out: FixedVec<u8, 4> = fixedVec([1n]);
    out.pushAll(data.slice(1n));
    log(`fits ${out.length}`);
  }
}
