// Signer seeds at Solana's limit: 16 per signer, the bump included (15 seeds and the bump), through a seed list
// given to the CPI, a signer([...]) list bound to a name, and createProgramAddress.
import { type AccountInfo, type Mut, type Pubkey, type SystemProgram, type u8, type u64, createProgramAddress, pubkey, signer } from "typesol";

/** Pay `amount` out of the system-owned vault PDA ["a", …, "o"] (15 seeds and the bump). */
export function withdraw(vault: Mut<AccountInfo>, to: Mut<AccountInfo>, systemProgram: SystemProgram, bump: u8, amount: u64): void {
  systemProgram.transfer(vault, to, amount, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", bump]);
}

/** The same through a signer([...]) list bound to a name. */
export function withdrawBound(vault: Mut<AccountInfo>, to: Mut<AccountInfo>, systemProgram: SystemProgram, bump: u8, amount: u64): void {
  const seeds = signer(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", bump]);
  systemProgram.transfer(vault, to, amount, seeds);
}

/** create_program_address of the 15 seeds and the bump under `program` (the default address when it is on the curve). */
export function address(program: Pubkey, bump: u8): Pubkey {
  const a = createProgramAddress(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", bump], program);
  return a ?? pubkey("11111111111111111111111111111111");
}
