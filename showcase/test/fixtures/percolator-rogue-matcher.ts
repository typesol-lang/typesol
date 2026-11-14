// A matcher that answers whatever its context account tells it to, for the TradeCpi tests of
// showcase/mainnet/percolator: each refusal of the matcher's answer (ABI version, flags, echoed fields, sizes, prices,
// the off-market band, the user's limit) needs an answer the real matcher never gives. It also re-enters Percolator
// to show the reentrancy flag, and logs the slab it is handed in the tail as it stands during the call.
//
// The context account (owned by this program, at least 320 bytes like the real matcher's): the answer goes to bytes
// 0..64; bytes 128..208 hold the template:
//   128 mode (u64): bit 0 echo req_id, 1 echo lp_account_id, 2 echo the oracle price, 3 fill the requested size,
//       4 price = oracle · (10_000 + delta_bps) / 10_000, 5 call Percolator's SettleAccount (tail: Percolator, slab,
//       clock, oracle) before answering, 6 fill half the requested size, 7 log the slab passed as the first tail
//       account (below)
//   136 delta_bps (i64)
//   144 the answer's 64 bytes, used as they are where the mode does not replace a field
import {
  type FixedArray,
  type Inout,
  type InstructionBytes,
  type RemainingAccount,
  type i64,
  type u32,
  u128,
  ProgramError,
  i128,
  instructionData,
  invoke,
  loadRawMutAt,
  log64,
  readData,
  readonly,
  remainingAccounts,
  require,
  u8,
  u16,
  u64,
  writable,
} from "typesol";

export interface Answer {
  abi_version: u32;
  flags: u32;
  exec_price_e6: u64;
  exec_size: i128;
  req_id: u64;
  lp_account_id: u64;
  oracle_price_e6: u64;
  reserved: u64;
}

export interface RogueAccount {
  ret: Answer;
  unused: FixedArray<u8, 64>;
  mode: u64;
  delta_bps: i64;
  template: Answer;
}

function call(acct: Inout<RogueAccount>, data: InstructionBytes): void {
  const mode = acct.mode;
  const r: Answer = acct.template;
  const oracle = data.readU64(19n);
  const reqSize = data.readU128(27n);
  if ((mode & 1n) !== 0n) r.req_id = data.readU64(1n);
  if ((mode & 2n) !== 0n) r.lp_account_id = data.readU64(11n);
  if ((mode & 4n) !== 0n) r.oracle_price_e6 = oracle;
  if ((mode & 8n) !== 0n) r.exec_size = asI128(reqSize);
  if ((mode & 64n) !== 0n) r.exec_size = asI128(reqSize) / 2n;
  if ((mode & 16n) !== 0n) {
    const bps = 10000n + i128(acct.delta_bps);
    r.exec_price_e6 = u64((i128(oracle) * bps) / 10000n);
  }
  acct.ret = r;
}

function asI128(x: u128): i128 {
  if (x <= 0x7fffffffffffffffffffffffffffffffn) return i128(x);
  return -i128(0xffffffffffffffffffffffffffffffffn - x) - 1n;
}

/** FNV-1a over `words` little-endian u64 words of the account's data from `offset` (a fingerprint, not a secure hash). */
function fingerprint(a: RemainingAccount, offset: u64, words: u64): u64 {
  let h: u64 = 0xcbf29ce484222325n;
  for (let i = 0n; i < words; i++) h = u64((u128(h ^ readData<u64>(a, offset + i * 8n)) * 0x100000001b3n) & 0xffffffffffffffffn);
  return h;
}

/**
 * The slab as the matcher sees it (mode bit 7): one line with the flags byte (13, FLAG_CPI_IN_PROGRESS is bit 2), the
 * request nonce (48), the data length, the admin's first word; the header's 136 bytes, the config's 400 and the
 * engine's first 17,600 (everything before its accounts) each fingerprinted; the config's 50 words as they are (ten
 * lines); the LP's 360-byte account entry (lp_idx from the request) fingerprinted.
 */
function observe(slab: RemainingAccount, data: InstructionBytes): void {
  log64(0x0b5e7e0n, u64(readData<u8>(slab, 13n)), readData<u64>(slab, 48n), slab.dataLen, readData<u64>(slab, 16n));
  log64(0x0b5e7e1n, fingerprint(slab, 0n, 17n), fingerprint(slab, 136n, 50n), fingerprint(slab, 536n, 2200n), 0n);
  for (let i = 0n; i < 10n; i++)
    log64(
      readData<u64>(slab, 136n + i * 40n),
      readData<u64>(slab, 144n + i * 40n),
      readData<u64>(slab, 152n + i * 40n),
      readData<u64>(slab, 160n + i * 40n),
      readData<u64>(slab, 168n + i * 40n),
    );
  const lpIdx = u64(data.readU16(9n));
  log64(0x0b5e7e2n, lpIdx, fingerprint(slab, 536n + 17600n + lpIdx * 360n, 45n), 0n, 0n);
}

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  require(rest.length >= 2n, ProgramError.NotEnoughAccountKeys);
  const acct = loadRawMutAt<RogueAccount>(rest.get(1n), 0n);
  if ((acct.mode & 128n) !== 0n) {
    require(rest.length >= 3n, ProgramError.NotEnoughAccountKeys);
    observe(rest.get(2n), data);
  }
  if ((acct.mode & 32n) !== 0n) {
    // Re-enter Percolator: SettleAccount(0) on the slab of the tail.
    invoke(rest.get(2n), [writable(rest.get(3n)), readonly(rest.get(4n)), readonly(rest.get(5n))], [u8(26n), u16(0n)]);
  }
  call(acct, data);
}
