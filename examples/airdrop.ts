import {
  type Account,
  type Init,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type u8,
  type u64,
  invoke,
  loadAccountMut,
  minimumBalance,
  remainingAccounts,
  require,
  u32,
  writable,
  writableSigner,
} from "typesol";

/** Batch operations over a variable number of accounts passed as remaining accounts. */
export interface Pot {
  admin: Pubkey;
  paidOut: u64;
  bump: u8;
}

/** A member belongs to one pot: only that pot's admin can award it points. */
export interface Member {
  pot: Pubkey;
  owner: Pubkey;
  points: u64;
}

export enum PotError {
  NotAdmin = "Only the admin can do this",
  Empty = "The pot cannot cover this airdrop",
  WrongPot = "This member belongs to another pot",
}

export function setup(admin: Mut<Signer>, pot: Init<Pot>, systemProgram: SystemProgram): void {
  pot.bump = pot.create(admin, ["pot", admin.key]);
  pot.admin = admin.key;
}

export function join(owner: Mut<Signer>, pot: Account<Pot>, member: Init<Member>, systemProgram: SystemProgram): void {
  member.create(owner, ["member", pot.key, owner.key]);
  member.pot = pot.key;
  member.owner = owner.key;
}

/** Send `each` lamports from the pot to every remaining account. */
export function airdrop(admin: Signer, pot: Mut<Pot>, each: u64): void {
  require(admin.key === pot.admin, PotError.NotAdmin);
  const rest = remainingAccounts();
  const total = each * rest.length;
  require(pot.lamports - total >= minimumBalance(pot), PotError.Empty);
  for (let i = 0n; i < rest.length; i++) {
    const to = rest.get(i);
    pot.lamports -= each;
    to.lamports += each;
  }
  pot.paidOut += total;
}

/** Add points to every Member of this pot passed as a remaining account. */
export function award(admin: Signer, pot: Account<Pot>, points: u64): void {
  require(admin.key === pot.admin, PotError.NotAdmin);
  const rest = remainingAccounts();
  for (let i = 0n; i < rest.length; i++) {
    const m = loadAccountMut<Member>(rest.get(i));
    require(m.pot === pot.key, PotError.WrongPot);
    m.points += points;
  }
}

/** The payer tips every remaining account through System Program CPIs. */
export function tip(payer: Mut<Signer>, systemProgram: SystemProgram, amount: u64): void {
  const rest = remainingAccounts();
  for (let i = 0n; i < rest.length; i++) {
    invoke(systemProgram, [writableSigner(payer), writable(rest.get(i))], [u32(2n), amount]);
  }
}
