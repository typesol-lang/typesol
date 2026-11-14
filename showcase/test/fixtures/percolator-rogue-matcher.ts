// A matcher that answers whatever its context account tells it to, for the TradeCpi tests of
// showcase/mainnet/percolator: each refusal of the matcher's answer (ABI version, flags, echoed fields, sizes, prices,
// the off-market band, the user's limit) needs an answer the real matcher never gives. It also re-enters Percolator
// to show the reentrancy flag.
//
// The context account (owned by this program, at least 320 bytes like the real matcher's): the answer goes to bytes
// 0..64; bytes 128..208 hold the template:
//   128 mode (u64): bit 0 echo req_id, 1 echo lp_account_id, 2 echo the oracle price, 3 fill the requested size,
//       4 price = oracle · (10_000 + delta_bps) / 10_000, 5 call Percolator's SettleAccount (tail: Percolator, slab,
//       clock, oracle) before answering, 6 fill half the requested size
//   136 delta_bps (i64)
//   144 the answer's 64 bytes, used as they are where the mode does not replace a field
import { type FixedArray, type Inout, type InstructionBytes, type i64, type u32, type u128, ProgramError, i128, instructionData, invoke, loadRawMutAt, readonly, remainingAccounts, require, u8, u16, u64, writable } from "typesol";

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

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  require(rest.length >= 2n, ProgramError.NotEnoughAccountKeys);
  const acct = loadRawMutAt<RogueAccount>(rest.get(1n), 0n);
  if ((acct.mode & 32n) !== 0n) {
    // Re-enter Percolator: SettleAccount(0) on the slab of the tail.
    invoke(rest.get(2n), [writable(rest.get(3n)), readonly(rest.get(4n)), readonly(rest.get(5n))], [u8(26n), u16(0n)]);
  }
  call(acct, data);
}
