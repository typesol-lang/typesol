// A matcher for the TradeCpi and BatchTradeCpi tests of showcase/mainnet/percolator-v16 that does what its context
// account says, for what the author's matchers never do: fail, change other accounts, try to call back into the
// program, answer with return data that is too long or too short, set return data on a single call, or resize its
// context after answering. Both VMs load this same binary; it is a test fixture, not a port of anything.
//
// The context account (owned by this program, at least 128 bytes):
//   0..64    the answer of a single call (tag 0), written there
//   64..72   mode (u64): bit 0 answer honestly (the full requested size at the oracle price, every field echoed),
//            1 fail (custom error 0x77), 2 write 0xab into the first byte of every writable account it is given that
//            it owns (the context excepted), 3 call the program whose id is at 96..128 with no account before
//            answering (a re-entrant call), 4 batch: append the u64 at 72..80 zero bytes to the answers (capped at the
//            runtime's 1,024), 5 batch: drop the u64 at 80..88 bytes from the end, 6 after answering, resize the
//            context to the u64 at 88..96, 7 a single call also sets its answer as return data
//            8 answer at the price at 128..136 instead of the oracle price
//   96..128  the program id bit 3 calls
import {
  type FixedVec,
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccounts,
  type u32,
  type u64,
  ProgramError,
  fixedVec,
  instructionData,
  invokeInstruction,
  loadRawMutAt,
  readData,
  remainingAccounts,
  require,
  resizeAccount,
  setReturnData,
  type u8,
  u64 as toU64,
} from "typesol";

export const MAX_ACCOUNTS = 64n;

export enum RogueError {
  /** @code 119 */
  Refused = "Refused",
}

/** The answer as its 64 bytes lie in the context (the size as two words). */
interface Answer {
  abi: u32;
  flags: u32;
  price: u64;
  size_lo: u64;
  size_hi: u64;
  req: u64;
  lp: u64;
  oracle: u64;
  asset: u64;
}

interface Byte {
  v: u8;
}

interface Meta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

/** One honest answer: ABI 3, VALID, the oracle price, the requested size, the echoes. */
function answer(out: Inout<FixedVec<u8, 1088>>, reqId: u64, lp: u64, asset: u64, oracle: u64, data: InstructionBytes, sizeAt: u64, price: u64): void {
  out.pushLE<u32>(3n);
  out.pushLE<u32>(1n);
  out.pushLE<u64>(price);
  out.pushLE<u64>(data.readU64(sizeAt));
  out.pushLE<u64>(data.readU64(sizeAt + 8n));
  out.pushLE<u64>(reqId);
  out.pushLE<u64>(lp);
  out.pushLE<u64>(oracle);
  out.pushLE<u64>(asset);
}

function touch(rest: RemainingAccounts, self: Pubkey): void {
  for (let i = 2n; i < rest.length; i++) {
    const a = rest.get(i);
    if (a.isWritable && a.owner === self && a.dataLen > 0n) {
      const b = loadRawMutAt<Byte>(a, 0n);
      b.v = 0xabn;
    }
  }
}

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  require(rest.length >= 2n, ProgramError.NotEnoughAccountKeys);
  const ctx = rest.get(1n);
  const mode = readData<u64>(ctx, 64n);
  require((mode & 2n) === 0n, RogueError.Refused);
  if ((mode & 4n) !== 0n) touch(rest, ctx.owner);
  if ((mode & 8n) !== 0n) {
    const metas: FixedVec<Meta, 1> = fixedVec([]);
    const body: FixedVec<u8, 1> = fixedVec([5n]);
    invokeInstruction(readData<Pubkey>(ctx, 96n), metas, body, rest);
  }
  const out: FixedVec<u8, 1088> = fixedVec([]);
  const tag = data.readU8(0n);
  if (tag === 0n) {
    if ((mode & 1n) !== 0n) {
      const r = loadRawMutAt<Answer>(ctx, 0n);
      r.abi = 3n;
      r.flags = 1n;
      r.price = (mode & 256n) !== 0n ? readData<u64>(ctx, 128n) : data.readU64(19n);
      r.size_lo = data.readU64(27n);
      r.size_hi = data.readU64(35n);
      r.req = data.readU64(1n);
      r.lp = data.readU64(11n);
      r.oracle = data.readU64(19n);
      r.asset = toU64(data.readU16(9n));
      if ((mode & 128n) !== 0n) {
        answer(out, data.readU64(1n), data.readU64(11n), toU64(data.readU16(9n)), data.readU64(19n), data, 27n, r.price);
        setReturnData(out);
      }
    }
  } else {
    const n = toU64(data.readU8(1n));
    const reqId = data.readU64(2n);
    const lp = data.readU64(10n);
    if ((mode & 1n) !== 0n)
      for (let i = 0n; i < n; i++) {
        const at = 18n + i * 26n;
        answer(out, reqId, lp, toU64(data.readU16(at)), data.readU64(at + 2n), data, at + 10n, (mode & 256n) !== 0n ? readData<u64>(ctx, 128n) : data.readU64(at + 2n));
      }
    if ((mode & 16n) !== 0n) {
      let extra = readData<u64>(ctx, 72n);
      while (extra > 0n && out.length < 1024n) {
        out.push(0n);
        extra -= 1n;
      }
    }
    if ((mode & 32n) !== 0n) {
      const cut = readData<u64>(ctx, 80n);
      out.truncate(cut >= out.length ? 0n : out.length - cut);
    }
    setReturnData(out);
  }
  if ((mode & 64n) !== 0n) resizeAccount(ctx, readData<u64>(ctx, 88n));
}
