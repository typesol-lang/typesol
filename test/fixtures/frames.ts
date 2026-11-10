// Room beyond one 4 KiB stack frame (test/language/stack-limit.test.ts): two 1280-byte lists live in the entry and a
// helper builds two more of 1024 bytes after them. Inlined, the entry's frame would need 4,672 bytes; the helper is
// `@noinline` (a frame of its own) and one list is `@heap`, including one declared in a loop (one allocation, reused).
import { type FixedVec, type Inout, fixedVec, instructionData, setReturnData, u64, u8 } from "typesol";

export interface Pair {
  bytes: FixedVec<u8, 1000>;
  tag: u8;
}

function record(buf: Inout<FixedVec<u8, 1280>>, b: u8): void {
  buf.push(b);
}

/** The order ids a native port returns after its last CPI: built in a frame of its own. */
/** @noinline */
function finish(first: u8): void {
  const ids: FixedVec<u8, 1024> = fixedVec([first]);
  ids.push(9n);
  const more: FixedVec<u8, 1024> = fixedVec([]);
  more.pushAll(ids);
  setReturnData(more);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const tag = data.readU8(0n);
  const logData: FixedVec<u8, 1280> = fixedVec([]);
  /** @heap */
  const second: FixedVec<u8, 1280> = fixedVec([7n]);
  record(logData, tag);
  record(second, tag);
  second.pushAll(logData);
  if (tag === 0n) {
    finish(tag);
  } else if (tag === 1n) {
    setReturnData(second);
  } else if (tag === 2n) {
    // 64 passes of a 1,280-byte heap list would take 80 KiB if each allocated: one allocation, built again each pass.
    let total = 0n;
    for (let i = 0n; i < 64n; i++) {
      /** @heap */
      const scratch: FixedVec<u8, 1280> = fixedVec([]);
      scratch.push(u8(i));
      total += scratch.length;
      /** @heap */
      const p: Pair = { bytes: fixedVec([1n, 2n]), tag: u8(i) };
      total += p.bytes.length + u64(p.tag);
    }
    const out: FixedVec<u8, 8> = fixedVec([]);
    out.pushLE(total);
    setReturnData(out);
  }
}
