# Calling other programs

A program calls another one with a cross-program invocation (CPI). TypeSOL has typed methods for the System, SPL
Token, Token-2022, Associated Token, Memo, Stake and Metaplex programs, typed helpers generated from any Anchor IDL,
and `invoke` / `invokeInstruction` for everything else. Part of the [language guide](language.md). Signing as a PDA is
on the [PDAs](language-pdas.md#signing-as-a-pda) page.

## The System Program

```ts
import { type Mut, type Signer, type SystemAccount, type SystemProgram, type u64 } from "typesol";

export function tip(from: Mut<Signer>, to: Mut<SystemAccount>, systemProgram: SystemProgram, lamports: u64): void {
  systemProgram.transfer(from, to, lamports);
}
```

- `systemProgram.transfer(from, to, lamports, signerSeeds?)`: `from` is a `Mut<Signer>`, or a system-owned PDA of this
  program (a SOL vault) with its seeds.
- `systemProgram.createAccount(payer, account, lamports, space, owner, signerSeeds?)`: the new account signs, a keypair
  `Mut<Signer>` or this program's PDA.
- `systemProgram.createPda(payer, account, space, owner, seeds)` ([PDAs](language-pdas.md#createpda)).
- `systemProgram.allocate(account, space, seeds?)` and `systemProgram.assign(account, owner, seeds?)`, for an address
  someone pre-funded ([accounts created by hand](language-accounts.md#accounts-created-by-hand)).
- `rentExempt(space)` is the rent-exempt minimum for `space` bytes; `MINT_SIZE` and `TOKEN_ACCOUNT_SIZE` are SPL
  Token's sizes.

## Tokens

```ts
import { type Mint, type Mut, type Signer, type TokenAccount, type TokenInterface, type u64, type u8 } from "typesol";

export function pay(owner: Signer, from: Mut<TokenAccount>, mint: Mint, to: Mut<TokenAccount>, tokenProgram: TokenInterface, amount: u64): void {
  tokenProgram.transferChecked(from, mint, to, owner, amount);
}

export function payOut(vault: Mut<TokenAccount>, mint: Mint, to: Mut<TokenAccount>, tokenProgram: TokenInterface, amount: u64, bump: u8): void {
  tokenProgram.transferChecked(vault, mint, to, vault, amount, ["vault", mint.key, bump]);
}
```

The token programs (`TokenProgram`, `Token2022Program`, `TokenInterface` for either) have one method per instruction.
Pass signer seeds (with the bump) as the last argument when the authority is a PDA.

| Methods | Notes |
| --- | --- |
| `transfer`, `transferChecked(from, mint, to, authority, amount)` | Token-2022 mints with fees or hooks require `transferChecked` |
| `mintTo`, `mintToChecked(mint, to, authority, amount)` | the mint may be one this instruction just created |
| `burn`, `burnChecked(from, mint, authority, amount)` | |
| `approve(source, delegate, owner, amount)`, `approveChecked(source, mint, delegate, owner, amount)`, `revoke` | the checked forms take the decimals from the mint |
| `closeAccount` | a token account, or a Token-2022 mint with a close authority |
| `setAuthority(target, current, AuthorityType.MintTokens, next \| null)` | |
| `freezeAccount` / `thawAccount(account, mint, freezeAuthority)`, `syncNative(account)` | |
| `initializeMint2(mint, decimals, mintAuthority, freezeAuthority \| null)`, `initializeAccount3(account, mint, owner)` | after `createAccount` |

Token-2022 only:

| Methods | Notes |
| --- | --- |
| `initializeTransferFeeConfig(mint, configAuthority \| null, withdrawAuthority \| null, basisPoints, maximumFee)`, `initializeMintCloseAuthority(mint, authority \| null)`, `initializeNonTransferableMint(mint)`, `initializePermanentDelegate(mint, delegate)`, `initializeDefaultAccountState(mint, frozen)`, `initializeMetadataPointer` / `initializeGroupPointer` / `initializeGroupMemberPointer` / `initializeTransferHook(mint, authority \| null, address \| null)`, `initializeInterestBearingMint(mint, rateAuthority \| null, rate)`, `initializeImmutableOwner(account)` | extension initializers, called between `createAccount` and `initializeMint2` / `initializeAccount3` |
| `initializeMetadata(mint, updateAuthority, mintAuthority, name, symbol, uri)` | the metadata extension |
| `updateDefaultAccountState(mint, freezeAuthority, frozen)`, `updateTransferHook(mint, authority, programId \| null)`, `enableRequiredMemoTransfers` / `disableRequiredMemoTransfers(account, owner)`, `updateInterestRate(mint, rateAuthority, rate)`, `transferCheckedWithFee(from, mint, to, authority, amount, fee)`, `harvestWithheldTokensToMint(mint, remainingAccounts())`, `withdrawWithheldTokensFromMint(mint, destination, authority)`, `setTransferFee(mint, authority, basisPoints, maximumFee)` | extension instructions |
| `updateMetadataField(mint, updateAuthority, field, value)` ("name" / "symbol" / "uri" or any other key), `removeMetadataKey(mint, updateAuthority, key, idempotent)`, `updateMetadataAuthority(mint, updateAuthority, next \| null)`, `emitMetadata(mint)` | the Token Metadata interface |
| `initializeTokenGroup(group, mint, mintAuthority, updateAuthority \| null, maxSize)`, `initializeGroupMember(member, memberMint, memberMintAuthority, group, groupUpdateAuthority)`, `updateGroupMaxSize(group, authority, maxSize)`, `updateGroupAuthority(group, authority, next \| null)` | the Token Group interface; a collection mint with a GroupPointer to itself (fund the rent for the group, which Token-2022 adds to the account) |

Each takes optional signer seeds.

### Token accounts and mints as parameters

| Parameter | Checked before the body |
| --- | --- |
| `TokenAccount` / `Mut<TokenAccount>` | owned by SPL Token or Token-2022 (extensions allowed, multisig accounts refused), initialized (3012 for an account never created). Fields: `mint`, `owner`, `amount`, `delegate`, `delegatedAmount`, `isFrozen`, `isNative`, `closeAuthority`, `tokenProgram` |
| `Mint` / `Mut<Mint>` | owned by SPL Token or Token-2022, initialized (3012). Fields: `decimals`, `supply`, `mintAuthority`, `freezeAuthority`, `tokenProgram` |
| `HasOne<TokenAccount, "mint" \| "owner">`, `HasOne<Mint, "mintAuthority" \| "freezeAuthority">` | against the parameter with that name (2014 / 2015 / 2016 / 2017) |
| `TokenOf<TokenAccount, "mintParam", "authorityParam", "tokenProgramParam">` | Anchor's `token::mint = …`, `token::authority = …`, `token::token_program = …`: the token account's mint (2014), owner (2015), and owner program (2021). `never` leaves one out |
| `MintOf<Mint, "authorityParam", "freezeParam", "tokenProgramParam">` | Anchor's `mint::authority = …` etc.: mint authority (2016), freeze authority (2017), owner program (2022) |
| `Ata<TokenAccount, "owner", "mint">` | the associated token account of those parameters (2009; the ATA's `pda` in the IDL). The owner may be a `Pubkey` field of a struct account parameter, `"@config.wallet"` (Anchor's `associated_token::authority = config.load()?.wallet`; the IDL names the account, as Anchor's does) |

### Creating mints and token accounts

```ts
import { type AccountInfo, type Ata, type Init, type InitIfNeeded, type Mint, type Mut, type Signer, type SystemProgram, type TokenAccount, type TokenInterface, type AssociatedTokenProgram, type u8 } from "typesol";

export function makeMint(payer: Mut<Signer>, mint: Init<Mint>, authority: AccountInfo, tokenProgram: TokenInterface, systemProgram: SystemProgram, decimals: u8): u8 {
  const bump = mint.create(payer, ["mint", payer.key], decimals, authority.key, null);
  return bump;
}

export function makeVault(payer: Mut<Signer>, mint: Mint, vault: Init<TokenAccount>, tokenProgram: TokenInterface, systemProgram: SystemProgram): void {
  vault.create(payer, ["vault", mint.key], mint, vault.key);
}

export function openWallet(
  payer: Mut<Signer>,
  owner: AccountInfo,
  mint: Mint,
  wallet: Ata<InitIfNeeded<TokenAccount>, "owner", "mint">,
  tokenProgram: TokenInterface,
  associatedTokenProgram: AssociatedTokenProgram,
  systemProgram: SystemProgram,
): boolean {
  const created = wallet.createIfNeeded(payer);
  return created;
}
```

- **`Init<Mint>`, `InitIfNeeded<Mint>`** (Anchor's `init` / `init_if_needed` with `mint::decimals`, `mint::authority`,
  `mint::freeze_authority`): `const bump = mint.create(payer, ["mint", payer.key], 6n, authority, freezeAuthority |
  null)` creates the mint at that PDA of this program, or with `null` seeds as a new keypair account that signs (3010
  if it did not). It uses the instruction's token program (its only token program parameter, or one passed as the last
  argument of `create` / `createIfNeeded`) and needs `SystemProgram`. `createIfNeeded(…)` returns whether it created
  the mint; an existing one must be that PDA and have those decimals and authorities (2018 / 2016 / 2017).
- **Token-2022 extensions** (Anchor's `extensions::…`) go after the freeze authority: `mint.create(payer, null, 6n,
  authority, null, { metadataPointer: { authority, metadataAddress: mint.key }, transferHook: { authority, programId },
  closeAuthority, permanentDelegate, nonTransferable: true, defaultAccountState: true, interestBearing: { rateAuthority,
  rate }, transferFee: { configAuthority, withdrawAuthority, basisPoints, maximumFee }, groupPointer,
  groupMemberPointer })`. The mint is sized for them as Token-2022 does (extensions adding up to a Multisig's 355 bytes
  give a 357-byte mint), and each is initialized before InitializeMint2. A `null` authority is sent as Token-2022's
  empty COption. Extensions under SPL Token are refused (`mint extensions are Token-2022's`).
- With `createIfNeeded`, an existing mint must carry groupPointer / groupMemberPointer / metadataPointer /
  closeAuthority / permanentDelegate / transferHook with those keys (Anchor's 2024–2039). Extensions not listed are
  not looked at, so an existing mint may carry others (a permanent delegate, say). Extensions that cannot be checked on
  an existing mint (`nonTransferable`, …) are refused on `createIfNeeded`.
- **`Init<TokenAccount>`, `InitIfNeeded<TokenAccount>`** without `Ata<…>` (Anchor's `token::mint` / `token::authority`):
  `vault.create(payer, ["vault", mint.key], mint, authority)` (the authority may be `vault.key` itself) creates a token
  account at that PDA (or a keypair account with `null`), sized for the mint's extensions under Token-2022.
  `createIfNeeded` checks that an existing one has that mint and owner (2014 / 2015), not its delegate or close
  authority (as Anchor).
- **`Ata<Init<TokenAccount>, "owner", "mint">`, `Ata<InitIfNeeded<TokenAccount>, "owner", "mint">`** (Anchor's `init` /
  `init_if_needed` with `associated_token::…`): `acct.create(payer)` creates the ATA (fails if it exists);
  `const created = acct.createIfNeeded(payer)` creates it only when missing, otherwise checks it is that ATA (2009).
  Then it is a `TokenAccount` of that mint and owner (2014 / 2015). Needs `AssociatedTokenProgram`, `SystemProgram`
  and a token program parameter; call it at the top level before using the account.

### Token-2022 extension reads

| Function | Reads |
| --- | --- |
| `transferFee(mint, amount)` | the current epoch's TransferFeeConfig fee for `amount` (ceiling and cap, as spl-token-2022) |
| `transferFeeInverse(mint, amountReceived)` | the fee when the recipient is to get that much (spl-token-2022's `calculate_inverse_epoch_fee`) |
| `transferFeeBasisPoints(mint)`, `transferFeeMaximum(mint)` | this epoch's; 0 without the extension |
| `extensionsWithin(account, [1n, 18n, …])` | whether every extension is one of those types |
| `hasExtension(account, type)` | whether the account has that extension |
| `transferHookProgram(mint)`, `transferHookAuthority(mint)`, `permanentDelegate(mint)`, `mintCloseAuthority(mint)` | `Option<Pubkey>` |
| `isTransferring(tokenAccount)` | inside a transfer hook: whether Token-2022 is transferring from it |

## Associated Token, Memo, Metadata and Stake

- **`AssociatedTokenProgram`**: `create` and `createIdempotent` CPIs; `associatedTokenAddress(owner, mint,
  tokenProgram)` derives the address.
- **`MemoProgram`** (SPL Memo v2): `memoProgram.memo(text, [signers], signerSeeds?)`; each listed account signs (a PDA
  of this program with its seeds).
- **`TokenMetadataProgram`** (Metaplex Token Metadata):
  - `createV3(…)` (CreateMetadataAccountV3), optionally with `{ creators: [{ address, verified, share }], collection:
    mint }` after `isMutable` (1–5 creators, shares adding up to 100; only the update authority, signing, can be
    `verified: true`; the collection is written unverified; `isCollection: true` makes the NFT a sized collection);
  - `createMasterEditionV3(edition, mint, updateAuthority, mintAuthority, payer, metadata, tokenProgram, systemProgram,
    maxSupply | null)`;
  - `verifyCollection(authority, metadata, collectionMint, collectionMetadata, collectionMasterEdition, systemProgram,
    instructionsSysvar)` (Verify with CollectionV1);
  - `updateMetadataAccountsV2(metadata, updateAuthority, data | null, newUpdateAuthority | null, primarySaleHappened |
    null, isMutable | null)` (`data` replaces the whole DataV2: `{ name, symbol, uri, sellerFeeBasisPoints, creators?,
    collection? }`; each null leaves that part);
  - `burnV1(authority, metadata, edition | null, mint, token, collectionMetadata | null, systemProgram,
    instructionsSysvar, tokenProgram, amount)` (Burn: the holder signs and gets the rent back; the token account and
    edition close, the metadata is cleared to one byte);
  - `metadataAddress(mint)`, `masterEditionAddress(mint)`.
- **`StakeProgram`**: `initialize(stake, rentSysvar, staker, withdrawer, lockup?)` (`lockup`: `{ unixTimestamp, epoch,
  custodian }`, none when left out), `authorize(stake, clockSysvar, authority, newAuthority, "staker" | "withdrawer",
  custodian?)`, `delegate(stake, vote, clockSysvar, stakeHistorySysvar, stakeConfig, staker)`, `split(stake,
  splitStake, staker, lamports)`, `deactivate(stake, clockSysvar, staker)`, `withdraw(stake, to, clockSysvar,
  stakeHistorySysvar, withdrawer, lamports, custodian?)`, `merge(destination, source, clockSysvar, stakeHistorySysvar,
  staker)`, `getMinimumDelegation()` (a CPI, then the u64 the Stake program returns; fails as solana_program's
  `get_minimum_delegation` does).
  - Instruction tags and account lists are solana-stake-interface's builders'.
  - The sysvar and config accounts are parameters, as in anchor-spl's stake module, or `named(account, address)` (a
    native port): the instruction names `address` (`SysvarC1ock…`), as solana_program's builders do, and `account`,
    the slot's account, is what the runtime gets, as Rust's `invoke_signed(&ix, &[stake, clock_info, …])` passes it.
    The runtime looks the address up among the CPI's accounts only, so a slot holding another account fails the call
    (MissingAccount), as the original does, even when the sysvar is elsewhere in the transaction (`named` is valid only
    there).
  - Authorities and the lockup custodian sign (PDAs with signer seeds, given last).

## Metaplex Core

`core: MplCoreProgram`:

- `createCollection`, `createAsset` (in a collection, PDA authorities via signer seeds), `transferAsset`, `burnAsset`
  (`null` leaves an optional account out).
- Plugins as a literal list after the uri: `[{ kind: "Royalties", basisPoints: 500n, creators: [{ address, percentage:
  100n }] }, { kind: "PermanentFreezeDelegate", frozen: false, authority: studio.key }]`, and `addPlugin` /
  `updatePlugin` / `removePlugin(…, "FreezeDelegate")` with their `…CollectionPlugin` forms.
- Plugins: Royalties (with an optional `ruleSet: { programAllowList | programDenyList: [...] }`), FreezeDelegate,
  BurnDelegate, TransferDelegate, UpdateDelegate, PermanentFreezeDelegate, Attributes, PermanentTransferDelegate,
  PermanentBurnDelegate, Edition, MasterEdition (collections: `maxSupply?`, `name?`, `uri?`), AddBlocker,
  ImmutableMetadata, VerifiedCreators, Autograph, BubblegumV2, FreezeExecute, PermanentFreezeExecute (Groups is kept by
  Core's group instructions). `authority` is `"owner"`, `"updateAuthority"`, `"none"` or a Pubkey.
- `coreAssetOwner(asset)`, `coreAssetCollection(asset)` read an asset.
- External plugin adapters: `addExternalPlugin` / `removeExternalPlugin` / `writeExternalPluginData` (and the
  Collection forms) with `{ kind: "AppData", dataAuthority, schema? }`, `{ kind: "Oracle", baseAddress, checks: [{
  event: "transfer", canReject: true }], resultsOffset?, baseAddressConfig? }`, `{ kind: "LifecycleHook", hookedProgram,
  checks, extraAccounts?, dataAuthority?, schema? }` and the Linked forms. A key names one (`{ kind: "AppData",
  dataAuthority }`, `{ kind: "Oracle", address }`); data is a string, a `Vec<u8>` argument or `null` (Core currently
  answers lifecycle hooks with NotAvailable, 23).

## Compressed NFTs (Bubblegum)

`bubblegum: BubblegumProgram`:

- **V1** (trees on SPL Account Compression): `createTree`, `mint` (MintV1, no collection or creators),
  `mintToCollection` (MintToCollectionV1: into a verified Token Metadata collection), `transfer`, `burn`, `delegate`
  (the leaf owner or delegate signs; a PDA owner signs with the seeds).
- **V2** (trees on mpl-account-compression with mpl-noop): `createTreeV2`, `mintV2(…, { name, symbol, uri,
  sellerFeeBasisPoints, creators?, isMutable? }, { collection, authority, cpiSigner }?)` (into a Core collection that
  has the `BubblegumV2` plugin), `transferV2`, `burnV2`, `delegateV2`, `freezeV2` / `thawV2`, `setNonTransferableV2`,
  `updateMetadataV2(…, currentMetadata, { name?, symbol?, uri?, creators?, … })`, `verifyCreatorV2` /
  `unverifyCreatorV2`, `setCollectionV2`.
- Each takes the leaf (`{ root, dataHash, creatorHash, assetDataHash?, flags?, nonce, index }`, or `{ root,
  assetDataHash?, flags?, nonce, index }` with the leaf's current metadata for the metadata instructions) and its proof
  as `remainingAccounts()` / `rest.slice(a)`.

## Typed calls from an IDL

`typesol cpi other.json --out other_cpi.ts` writes one helper per instruction of another program
(`vaultDeposit(program, owner, vault, systemProgram, amount, seeds)`), with the account flags, discriminator and
argument encoding taken from the IDL (Anchor 0.30+ / 1.x, or TypeSOL's own). Import the file and call a helper with
`signer([...seeds, bump])` when a PDA of your program signs, or `signer([])`. Instructions whose arguments have no
Borsh-identical TypeSOL type (strings or Options inside structs, data-carrying enums) are listed and left out.

## invoke

```ts
import { type AccountInfo, type Mut, type Program, type Signer, type SystemAccount, type SystemProgram, type u64, type u8, invoke, readonlySigner, sighash, u32, writable, writableSigner } from "typesol";

export function relayIncrement(authority: Signer, counter: Mut<AccountInfo>, counterProgram: Program<"JD2vDBgLPPLbLDghjzLMp5zCLvBWuZBkgFDCqCQv99Y2">, by: u64): void {
  invoke(counterProgram, [readonlySigner(authority), writable(counter)], [sighash("increment"), by]);
}

export function payOut(admin: Signer, treasury: Mut<SystemAccount>, recipient: Mut<SystemAccount>, systemProgram: SystemProgram, amount: u64, bump: u8): void {
  invoke(systemProgram, [writableSigner(treasury), writable(recipient)], [u32(2n), amount], ["treasury", admin.key, bump]);
}
```

`invoke(program, accounts, data, signerSeeds?)` calls any program. The second call above is a raw System transfer
(u32 tag 2, u64 lamports) out of a treasury PDA.

### Program

A `Program<"address">` (key and executable checked on entry), an `UncheckedProgram`, an `Address<AccountInfo,
"address">` (Anchor's `#[account(address = ID)]` on an `UncheckedAccount`: only the key is checked, 2012), the system
or a token program, or a remaining account.

### Accounts

- `readonly(x)`, `writable(x)`, `readonlySigner(x)`, `writableSigner(x)`, written inside the list (`only valid inside
  the accounts list`).
- The compiler refuses `writable` on a parameter that is not `Mut<…>` (`not writable here`), and a signer flag on an
  account that neither signed nor is covered by signer seeds (`did not sign`).
- An optional account passed as it is (`readonly(x)` / `writable(x)` with `x: A | null`, no `!`) is left out of the
  list when it was not passed, as Rust's `if let Some(x) = &self.x { accounts.push(…) }` does.
- Remaining accounts: one at a time, or spread (`...remainingAccounts()`, `...readonly(rest)`, `...writable(rest)`,
  `rest.slice(a, b)`; [remaining accounts](language-accounts.md#remaining-accounts)).
- At most 32 accounts in one call (`invoke takes at most 32 accounts`), or the program's `MAX_ACCOUNTS`; at run time
  5113.

### Data

Borsh: integers little-endian at their declared width (`u32(2n)` is 4 bytes, a bare `5n` is a u64), booleans,
Pubkeys, strings, Options, structs and FixedArrays (their fixed layout), data enums, `Vec` arguments,
`sighash("name")` (an Anchor instruction discriminator) and `hex("0a0b")`. Up to 1024 bytes.

### Return data

After the call, `returnData<u64>(program)` reads what the callee returned, checking the size and that it came from
`program`. A struct is bound to a local, `const quote = returnData<Quote>(amm)`: a fixed layout of integers, booleans,
Pubkeys, unit enums and arrays is read as its bytes (booleans and enums checked); a struct with Options, strings or
Vecs is declared `/** @layout borsh */` and Borsh-decoded. Bytes that are not exactly the struct fail with 5106. The
type argument is required.

## invokeInstruction

A call decided at run time, such as one a multisig stored in account data, is `invokeInstruction` (Rust's
`invoke_signed(&Instruction { program_id, accounts, data }, infos, seeds)`):

```ts
import { type Account, type Pubkey, type u8, type Vec, invokeInstruction, remainingAccounts } from "typesol";

export interface TransactionAccount {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Multisig {
  nonce: u8;
}

export interface Transaction {
  programId: Pubkey;
  accounts: Vec<TransactionAccount>;
  data: Vec<u8>;
}

export function execute(multisig: Account<Multisig>, transaction: Account<Transaction>): void {
  invokeInstruction(transaction.programId, transaction.accounts, transaction.data, remainingAccounts(), [multisig.key, multisig.nonce]);
}
```

- The accounts are a list of structs with `pubkey`, `isSigner` and `isWritable` (a Vec or FixedVec in account data, a
  Vec argument, a stored `map` result, or a local list built on the stack); the data a list of u8 (the same, the
  instruction data or a slice of it).
- Every account in the fourth argument (`remainingAccounts()` or a slice; in a helper, its `RemainingAccounts`
  parameter or a slice of it) is handed to the runtime, which finds each meta's account there by key: one that is
  missing fails the call, as under Rust (MissingAccount, "Instruction references an unknown account").
- So a native port builds the instruction as Rust's instruction builders do, in a helper too, with metas naming
  accounts by key:

  ```ts
  import { type FixedVec, type InstructionBytes, type Pubkey, type RemainingAccounts, type u8, fixedVec, instructionData, invokeInstruction, remainingAccounts } from "typesol";

  interface Meta {
    pubkey: Pubkey;
    isSigner: boolean;
    isWritable: boolean;
  }

  function transfer(rest: RemainingAccounts, data: InstructionBytes, to: Pubkey): void {
    const metas: FixedVec<Meta, 2> = fixedVec([{ pubkey: rest.get(0n).key, isSigner: true, isWritable: true }]);
    metas.push({ pubkey: to, isSigner: false, isWritable: true });
    const ix: FixedVec<u8, 12> = fixedVec([2n, 0n, 0n, 0n]); // system_instruction::transfer
    ix.pushAll(data.slice(1n, 9n)); // the lamports, as sent
    invokeInstruction(rest.get(2n).key, metas, ix, rest);
  }

  /** @fallback */
  export function entry(): void {
    const rest = remainingAccounts();
    const data = instructionData();
    transfer(rest, data, rest.get(1n).key);
  }
  ```

- The runtime checks the privileges: a meta may be a signer or writable only as the transaction passed that account,
  or as a PDA of this program the seeds (fifth argument) sign for. The multisig port in the showcase
  (`showcase/mainnet/multisig/multisig.ts`) uses it.

## Programs and sysvars passed as remaining accounts

A native program takes its programs and sysvars by position too. `programAt<P>(account)` checks that a remaining
account (or an `AccountInfo` parameter) is that program, once, by its key, and gives it P's typed methods:

```ts
import { type StakeProgram, type TokenInterface, instructionData, programAt, remainingAccounts } from "typesol";

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const lamports = data.readU64(1n);
  const bump = data.readU8(9n);
  const rest = remainingAccounts();
  const stake = programAt<StakeProgram>(rest.get(12n)); // ProgramError.IncorrectProgramId if it is another account
  stake.split(rest.get(3n), rest.get(4n), rest.get(1n), lamports, [rest.get(0n).key, "withdraw", bump]);
  const minimum = stake.getMinimumDelegation();
  programAt<TokenInterface>(rest.get(10n)).mintTo(rest.get(7n), rest.get(8n), rest.get(1n), minimum, [rest.get(0n).key, "withdraw", bump]);
}
```

- P is `StakeProgram`, `SystemProgram`, `TokenProgram`, `Token2022Program`, `TokenInterface` (either token program),
  `AssociatedTokenProgram` or `MemoProgram`. Bind it with `const`, or call a method on it directly; pass it to a helper
  that takes that program type.
- `sysvarAt<StakeHistorySysvar>(account)` does the same for the StakeHistory sysvar (ProgramError.InvalidArgument for
  another account): `count`, `latestEpoch`, `has(epoch)`, `effective(epoch)` … as on a parameter (read its fields
  through a `const` bound to it; methods also work on the call itself).
- Every typed CPI (System, SPL Token and Token-2022, ATA, Memo, Stake) takes, for each account, a declared parameter, a
  remaining account (`rest.get(i)`, a local bound to one, a `RemainingAccount` helper parameter), a struct loaded from
  one, or an `AccountInfo` parameter where a `TokenAccount` or `Mint` goes. Declared parameters keep their compile-time
  checks (writable slots need `Mut<…>`, an authority without signer seeds a `Signer`). A remaining account is not
  checked by the compiler, and unlike `invoke` the typed calls add no run-time check of their own: the runtime refuses
  a CPI that makes an account writable or a signer when the transaction did not (and no seeds sign for it), and the
  called program checks the rest (a token account's mint and owner, a stake account's authorities).
- The cost is the key check (four 8-byte compares) and the call itself: within a few compute units of the same call
  written with `invoke`, which checks only the executable flag (`test/integrations/native-cpi.test.ts` measures it).

## Order of evaluation

A call's arguments are evaluated left to right, as in JavaScript, and its seeds are read where they are written: a seed
list written in the call holds the seeds as they were when the list was read, even when a later argument changes one,
while a named `signer([…])` list holds them as they were when it was declared ([signing as a
PDA](language-pdas.md#signing-as-a-pda)).

## Implementing another program's interface (transfer hooks)

```ts
import { type AccountInfo, type Mint, type Mut, type Signer, type SystemProgram, type TokenAccount, type u64, initExtraAccountMetas, require } from "typesol";

/** @discriminator spl-transfer-hook-interface:initialize-extra-account-metas */
export function initializeExtraAccountMetaList(payer: Mut<Signer>, extraMetas: Mut<AccountInfo>, mint: Mint, systemProgram: SystemProgram): void {
  initExtraAccountMetas(payer, extraMetas, mint, systemProgram);
}

/** @discriminator spl-transfer-hook-interface:execute */
export function execute(source: TokenAccount, mint: Mint, destination: TokenAccount, owner: AccountInfo, extraMetas: AccountInfo, amount: u64): void {
  require(amount <= 1000n, "transfers above 1000 are blocked by the hook");
}
```

`/** @discriminator spl-transfer-hook-interface:execute */` above an instruction replaces its Anchor discriminator with
sha256(preimage)[..8] (or `@discriminator 0x…` for raw bytes), so a TypeSOL program can be a Token-2022 transfer hook:
`execute(source, mint, destination, owner, extraMetas, ...extraAccounts, amount)` plus
`initExtraAccountMetas(payer, account, mint, systemProgram, extraAccounts?)` for the validation account (an
ExtraAccountMetaList).

- Extra accounts are listed as `{ address, isSigner?, isWritable? }` (a fixed address) or `{ seeds: [...], program?,
  isSigner?, isWritable? }` (a PDA of this program, or with `program: i` of the program at account index i), with
  seeds from string literals, `seedAccountKey(i)`, `seedAccountData(i, offset, length)` and
  `seedInstructionData(offset, length)`. Token-2022 resolves and checks them on every transfer. The first extra account
  has index 5.
- `updateExtraAccountMetas(...)` rewrites and resizes an existing list.
- Inside the hook, `isTransferring(source)` says whether Token-2022 is transferring from it.
- See `test/fixtures/hook.ts` and the transfer-hook ports.
