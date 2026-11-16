import {
  type HasOne,
  type Init,
  type Mint,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenInterface,
  type u8,
  type u64,
  AuthorityType,
  emit,
  require,
} from "typesol";

/**
 * A capped token issuer that works with both SPL Token and Token-2022 mints.
 * The mint authority is the config PDA ["config", mint].
 */
export interface Config {
  admin: Pubkey;
  mint: Pubkey;
  cap: u64;
  minted: u64;
  bump: u8;
}

export interface Minted {
  to: Pubkey;
  amount: u64;
  total: u64;
}

export enum MinterError {
  NotAdmin = "Only the admin can mint",
  CapExceeded = "Minting would exceed the cap",
  WrongMint = "Account belongs to another mint",
}

/**
 * Only the mint's current authority can set up its config: it signs, becomes the admin and hands the mint
 * authority to the config PDA, so no one else can choose the admin or the cap of someone else's mint.
 */
export function setup(
  mintAuthority: Mut<Signer>,
  config: Init<Config>,
  mint: HasOne<Mut<Mint>, "mintAuthority">,
  tokenProgram: TokenInterface,
  systemProgram: SystemProgram,
  cap: u64,
): void {
  config.bump = config.create(mintAuthority, ["config", mint.key]);
  config.admin = mintAuthority.key;
  config.mint = mint.key;
  config.cap = cap;
  tokenProgram.setAuthority(mint, mintAuthority, AuthorityType.MintTokens, config.key);
}

export function issue(admin: Signer, config: Mut<Config>, mint: Mut<Mint>, to: Mut<TokenAccount>, tokenProgram: TokenInterface, amount: u64): void {
  require(admin.key === config.admin, MinterError.NotAdmin);
  require(mint.key === config.mint && to.mint === config.mint, MinterError.WrongMint);
  require(config.minted + amount <= config.cap, MinterError.CapExceeded);
  tokenProgram.mintTo(mint, to, config, amount, ["config", config.mint, config.bump]);
  config.minted += amount;
  emit<Minted>({ to: to.key, amount, total: config.minted });
}

/** transferChecked works for every Token-2022 mint, including ones with extensions. */
export function pay(owner: Signer, from: Mut<TokenAccount>, mint: Mint, to: Mut<TokenAccount>, tokenProgram: TokenInterface, amount: u64): void {
  require(from.mint === mint.key, MinterError.WrongMint);
  tokenProgram.transferChecked(from, mint, to, owner, amount);
}

/** Burn and return the mint's new supply. */
export function burn(owner: Signer, from: Mut<TokenAccount>, mint: Mut<Mint>, tokenProgram: TokenInterface, amount: u64): u64 {
  tokenProgram.burn(from, mint, owner, amount);
  return mint.supply;
}
