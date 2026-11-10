import {
  type AccountInfo,
  type Pubkey,
  type u8,
  type u64,
  findProgramAddress,
  findProgramAddressBump,
  findProgramAddressWithBump,
  requirePda,
} from "typesol";

export interface AddressAndBump {
  address: Pubkey;
  bump: u8;
}

/** The canonical PDA of [seedA, seedB, seedN] under `program` (TypeSOL's own derivation, compared with the syscall's). */
export function derive(seedA: string, seedB: Pubkey, seedN: u64, program: Pubkey): Pubkey {
  return findProgramAddress([seedA, seedB, seedN], program);
}

/** create_program_address([seedA, bump]) must equal `target` (any off-curve bump, as the syscall accepts). */
export function check(target: AccountInfo, seedA: string, bump: u8): void {
  requirePda(target, [seedA], bump);
}

/** 15 seeds: the most a bump search takes. */
export function mostSeeds(program: Pubkey): Pubkey {
  return findProgramAddress(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"], program);
}

/** The address and its bump from one search. */
export function deriveBoth(seedA: string, seedB: Pubkey, seedN: u64, program: Pubkey): AddressAndBump {
  const [address, bump] = findProgramAddressWithBump([seedA, seedB, seedN], program);
  return { address, bump };
}

/** The same from two searches, as before findProgramAddressWithBump. */
export function deriveTwice(seedA: string, seedB: Pubkey, seedN: u64, program: Pubkey): AddressAndBump {
  const address = findProgramAddress([seedA, seedB, seedN], program);
  const bump = findProgramAddressBump([seedA, seedB, seedN], program);
  return { address, bump };
}

/** Only the bump (the address left out of the pattern). */
export function bumpOnly(seedA: string, program: Pubkey): u8 {
  const [, bump] = findProgramAddressWithBump([seedA], program);
  return bump;
}
