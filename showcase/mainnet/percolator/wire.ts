// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb, src/percolator.rs `mod ix` readers), Copyright
// Anatoly Yakovenko, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// Changes: rewritten in TypeSOL.
//
// Signed integers of the instruction data (`i64::from_le_bytes`, `i128::from_le_bytes`): the u64 / u128 read, its
// bits reinterpreted.
import { type InstructionBytes, type i64, type i128, type u64, i64 as toI64, i128 as toI128 } from "typesol";

export function readI64(data: InstructionBytes, at: u64): i64 {
  const u = data.readU64(at);
  if (u <= 0x7fffffffffffffffn) return toI64(u);
  return -toI64(0xffffffffffffffffn - u) - 1n;
}

export function readI128(data: InstructionBytes, at: u64): i128 {
  const u = data.readU128(at);
  if (u <= 0x7fffffffffffffffffffffffffffffffn) return toI128(u);
  return -toI128(0xffffffffffffffffffffffffffffffffn - u) - 1n;
}
