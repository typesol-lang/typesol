// The built-in RedBlackTree (lib-sokoban 0.3's, byte for byte) driven one operation per instruction, for the trace
// replay (test/verification/rbtree-trace.test.ts): u64 keys, Phoenix's FIFOOrderId with its side-dependent order
// (stride 64) and Pubkey keys with Phoenix's TraderState (stride 144). Each instruction makes the tree at the offset
// and capacity it is sent, runs one operation, and writes what it returned into the account's first 24 bytes.
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type i8,
  type u32,
  ProgramError,
  instructionData,
  loadRawMutAt,
  rbTreeMutAt,
  remainingAccounts,
  require,
  u64,
} from "typesol";

// The result block and the trees share one account, as Phoenix's header and books do.
export const NATIVE_ACCOUNT_WRITES = true;

/** What the operation returned. */
export interface Out {
  a: u64;
  b: u64;
  c: u64;
}

/** Phoenix's FIFOOrderId: a bid's sequence number is stored inverted (top bit set). */
export interface FIFOOrderId {
  price_in_ticks: u64;
  order_sequence_number: u64;
}

/** Phoenix's FIFORestingOrder. */
export interface FIFORestingOrder {
  trader_index: u64;
  num_base_lots: u64;
  last_valid_slot: u64;
  last_valid_unix_timestamp_in_seconds: u64;
}

/** Phoenix's TraderState: four u64 and eight of padding (96 bytes). */
export interface TraderState {
  w0: u64;
  w1: u64;
  w2: u64;
  w3: u64;
  w4: u64;
  w5: u64;
  w6: u64;
  w7: u64;
  w8: u64;
  w9: u64;
  w10: u64;
  w11: u64;
}

/** FIFOOrderId's Ord (phoenix-v1 src/state/markets/fifo.rs): the left key's side decides the direction. */
function fifoCmp(a: FIFOOrderId, b: FIFOOrderId): i8 {
  if (a.order_sequence_number >> 63n === 1n) {
    if (a.price_in_ticks !== b.price_in_ticks) return b.price_in_ticks < a.price_in_ticks ? -1n : 1n;
    if (a.order_sequence_number !== b.order_sequence_number) return b.order_sequence_number < a.order_sequence_number ? -1n : 1n;
    return 0n;
  }
  if (a.price_in_ticks !== b.price_in_ticks) return a.price_in_ticks < b.price_in_ticks ? -1n : 1n;
  if (a.order_sequence_number !== b.order_sequence_number) return a.order_sequence_number < b.order_sequence_number ? -1n : 1n;
  return 0n;
}

/** One FNV-1a round over a node index's four little-endian bytes (the oracle's iteration digest). */
function fnv(h: u64, index: u32): u64 {
  let x = h;
  let v = u64(index);
  for (let k = 0n; k < 4n; k++) {
    x = ((x ^ (v & 0xffn)) * 16777619n) & 0xffffffffn;
    v = v >> 8n;
  }
  return x;
}

// Data: op u8, shape u8, offset u64, capacity u64, then the operation's arguments at 18.

function runU64(acct: RemainingAccount, data: InstructionBytes): void {
  const op = data.readU8(0n);
  const t = rbTreeMutAt<u64, u64>(acct, data.readU64(2n), data.readU64(10n));
  const out = loadRawMutAt<Out>(acct, 0n);
  if (op === 0n) {
    t.initialize();
  } else if (op === 1n) {
    const r = t.insert(data.readU64(18n), data.readU64(26n));
    out.a = r === null ? 0n : 1n;
    out.b = r === null ? 0n : u64(r!);
  } else if (op === 2n) {
    const v = t.remove(data.readU64(18n));
    out.a = v === null ? 0n : 1n;
    out.b = v === null ? 0n : v;
  } else if (op === 3n) {
    const v = t.get(data.readU64(18n));
    out.a = v === null ? 0n : 1n;
    out.b = v === null ? 0n : v;
  } else if (op === 4n) {
    const e = t.min();
    out.a = e === null ? 0n : u64(e.index);
    out.b = e === null ? 0n : e.value;
  } else if (op === 5n) {
    const e = t.max();
    out.a = e === null ? 0n : u64(e.index);
    out.b = e === null ? 0n : e.value;
  } else if (op === 6n || op === 7n) {
    const limit = data.readU64(18n);
    let n = 0n;
    let h = 2166136261n;
    if (op === 6n) {
      for (const e of t) {
        if (limit !== 0n && n === limit) break;
        n++;
        h = fnv(h, e.index);
      }
    } else {
      for (const e of t.reversed()) {
        if (limit !== 0n && n === limit) break;
        n++;
        h = fnv(h, e.index);
      }
    }
    out.a = n;
    out.b = h;
  } else if (op === 9n) {
    // nothing: what making the tree and the result block costs (the compute-unit baseline)
  } else {
    out.a = u64(t.addrOf(data.readU64(18n)));
  }
  out.c = t.length;
}

function runFifo(acct: RemainingAccount, data: InstructionBytes): void {
  const op = data.readU8(0n);
  const t = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(acct, data.readU64(2n), data.readU64(10n), fifoCmp);
  const out = loadRawMutAt<Out>(acct, 0n);
  const key: FIFOOrderId = { price_in_ticks: data.readU64(18n), order_sequence_number: data.readU64(26n) };
  if (op === 0n) {
    t.initialize();
  } else if (op === 1n) {
    const r = t.insert(key, {
      trader_index: data.readU64(34n),
      num_base_lots: data.readU64(42n),
      last_valid_slot: data.readU64(50n),
      last_valid_unix_timestamp_in_seconds: data.readU64(58n),
    });
    out.a = r === null ? 0n : 1n;
    out.b = r === null ? 0n : u64(r!);
  } else if (op === 2n) {
    const v = t.remove(key);
    out.a = v === null ? 0n : 1n;
    out.b = v === null ? 0n : v.trader_index;
  } else if (op === 3n) {
    const v = t.get(key);
    out.a = v === null ? 0n : 1n;
    out.b = v === null ? 0n : v.trader_index;
  } else if (op === 4n) {
    const e = t.min();
    out.a = e === null ? 0n : u64(e.index);
    out.b = e === null ? 0n : e.key.price_in_ticks;
  } else if (op === 5n) {
    const e = t.max();
    out.a = e === null ? 0n : u64(e.index);
    out.b = e === null ? 0n : e.key.price_in_ticks;
  } else if (op === 6n || op === 7n) {
    const limit = data.readU64(18n);
    let n = 0n;
    let h = 2166136261n;
    if (op === 6n) {
      for (const e of t) {
        if (limit !== 0n && n === limit) break;
        n++;
        h = fnv(h, e.index);
      }
    } else {
      for (const e of t.reversed()) {
        if (limit !== 0n && n === limit) break;
        n++;
        h = fnv(h, e.index);
      }
    }
    out.a = n;
    out.b = h;
  } else if (op === 9n) {
    // nothing: what making the tree and the result block costs (the compute-unit baseline)
  } else {
    out.a = u64(t.addrOf(key));
  }
  out.c = t.length;
}

function runTrader(acct: RemainingAccount, data: InstructionBytes): void {
  const op = data.readU8(0n);
  const t = rbTreeMutAt<Pubkey, TraderState>(acct, data.readU64(2n), data.readU64(10n));
  const out = loadRawMutAt<Out>(acct, 0n);
  const key = data.readPubkey(18n);
  if (op === 0n) {
    t.initialize();
  } else if (op === 1n) {
    const r = t.insert(key, {
      w0: data.readU64(50n),
      w1: data.readU64(58n),
      w2: data.readU64(66n),
      w3: data.readU64(74n),
      w4: data.readU64(82n),
      w5: data.readU64(90n),
      w6: data.readU64(98n),
      w7: data.readU64(106n),
      w8: data.readU64(114n),
      w9: data.readU64(122n),
      w10: data.readU64(130n),
      w11: data.readU64(138n),
    });
    out.a = r === null ? 0n : 1n;
    out.b = r === null ? 0n : u64(r!);
  } else if (op === 2n) {
    const v = t.remove(key);
    out.a = v === null ? 0n : 1n;
    out.b = v === null ? 0n : v.w0;
  } else if (op === 3n) {
    const v = t.get(key);
    out.a = v === null ? 0n : 1n;
    out.b = v === null ? 0n : v.w0;
  } else if (op === 4n) {
    const e = t.min();
    out.a = e === null ? 0n : u64(e.index);
    out.b = e === null ? 0n : e.value.w0;
  } else if (op === 5n) {
    const e = t.max();
    out.a = e === null ? 0n : u64(e.index);
    out.b = e === null ? 0n : e.value.w0;
  } else if (op === 6n || op === 7n) {
    const limit = data.readU64(18n);
    let n = 0n;
    let h = 2166136261n;
    if (op === 6n) {
      for (const e of t) {
        if (limit !== 0n && n === limit) break;
        n++;
        h = fnv(h, e.index);
      }
    } else {
      for (const e of t.reversed()) {
        if (limit !== 0n && n === limit) break;
        n++;
        h = fnv(h, e.index);
      }
    }
    out.a = n;
    out.b = h;
  } else if (op === 9n) {
    // nothing: what making the tree and the result block costs (the compute-unit baseline)
  } else {
    out.a = u64(t.addrOf(key));
  }
  out.c = t.length;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 18n, ProgramError.InvalidInstructionData);
  const acct = remainingAccounts().get(0n);
  const shape = data.readU8(1n);
  if (shape === 0n) runU64(acct, data);
  else if (shape === 1n) runFifo(acct, data);
  else runTrader(acct, data);
}
