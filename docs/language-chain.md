# Sysvars, hashes, signatures and oracles

What a program can read from the chain besides its accounts: the clock and other sysvars, hashes and signature checks,
the transaction's other instructions, price oracles and randomness. Part of the [language guide](language.md).

## Sysvars

```ts
import { type Mut, type i64, type u64, currentEpoch, currentSlot, minimumBalance, now, rentExempt } from "typesol";

export interface Stamp {
  at: i64;
  slot: u64;
  epoch: u64;
  rent: u64;
}

export function stamp(s: Mut<Stamp>): void {
  s.at = now();
  s.slot = currentSlot();
  s.epoch = currentEpoch();
  s.rent = rentExempt(100n) + minimumBalance(s);
}
```

| Function or parameter | Reads |
| --- | --- |
| `now()`, `currentSlot()`, `currentEpoch()`, `epochStartTimestamp()` | the Clock sysvar (`now()` is the unix timestamp) |
| `minimumBalance(account)`, `rentExempt(space)` | Rent: the rent-exempt minimum for an account, or for `space` bytes |
| `slotsPerEpoch()`, `epochWarmup()`, `firstNormalEpoch()`, `firstNormalSlot()` | EpochSchedule |
| `lastRestartSlot()` | LastRestartSlot |
| `epochRewards()` | EpochRewards, through its syscall (Rust's `EpochRewards::get()`, no account) |
| `slotHashes: SlotHashesSysvar` | SlotHashes, as an account (too large for the sysvar syscalls) |
| `history: StakeHistorySysvar` | StakeHistory, as an account |

- The sysvar functions use the runtime's syscalls; a sysvar the runtime cannot give fails with 5103.
- `epochRewards()` is a read-only copy with `distributionStartingBlockHeight`, `numPartitions`, `parentBlockhash`
  (`Hash`), `totalPoints` (`u128`), `totalRewards`, `distributedRewards` and `active`. Bind it, `const er =
  epochRewards()`, or read one field inline, `epochRewards().active`; it is not a helper parameter.
- `slotHashes: SlotHashesSysvar`: `count`, `latestSlot`, `latestHash`. They are public: slot hashes are not a source of
  secret randomness.
- `history: StakeHistorySysvar`: `count`, `latestEpoch`, `has(epoch)`, `effective(epoch)`, `activating(epoch)`,
  `deactivating(epoch)` (0 for an epoch not listed). A native port reads it from a remaining account with
  `sysvarAt<StakeHistorySysvar>(account)` ([remaining accounts in
  CPIs](language-cpi.md#programs-and-sysvars-passed-as-remaining-accounts)).
- `stackHeight()` is 1 when the transaction calls the program directly and more under a CPI:
  `require(stackHeight() === 1n, …)` refuses CPI callers.

## Hashing

```ts
import { type Hash, type Mut, type Pubkey, type u64, keccak256, sha256 } from "typesol";

export interface Commit {
  digest: Hash;
  other: Hash;
  order: u64;
}

export function commit(c: Mut<Commit>, owner: Pubkey, text: string, n: u64): void {
  c.digest = sha256(text, owner, n);
  c.other = keccak256(c.digest, true);
  c.order = c.digest.compare(c.other) < 0n ? 0n : 1n;
}
```

- `sha256(...parts)` and `keccak256(...parts)` hash the concatenation of 1 to 16 parts (strings as UTF-8, Pubkeys and
  Hashes as 32 bytes, integers little-endian at their width, a bare literal as a u64, booleans as one byte) and return
  a `Hash`.
- A `Hash` is a PDA seed too (its 32 bytes), as Marginfi seeds an order with the hash of its bank keys.
- `a.compare(b)` orders Pubkeys and Hashes as Rust orders their 32 bytes (-1, 0 or 1).
- `merkleVerify(leaf, proof, root)`, with `proof` a `Vec<Hash>` instruction argument, returns whether the proof
  places `leaf` under `root`, with sorted-pair keccak (OpenZeppelin's convention). Inner nodes and leaves are hashed
  alike, so hash leaves as OpenZeppelin does, `keccak256(keccak256(data))`, and never take the leaf itself from the
  arguments: an inner node would pass as a leaf.

## Signatures

`merkleVerify`, `verifyEd25519` and `verifySecp256k1` return whether the proof or signature holds; they do not fail by
themselves. Unlike a check such as `HasOne`, nothing happens when the answer is false: wrap them in
`require(…, error)`. A call whose result is thrown away is refused at compile time.

```ts
import { type Account, type Hash, type Init, type InstructionsSysvar, type Mut, type Pubkey, type Signer, type SystemProgram, type u8, type u64, type Vec, keccak256, merkleVerify, require, verifyEd25519, verifySecp256k1 } from "typesol";

export interface Drop {
  root: Hash;
  issuer: Pubkey;
  ethIssuer: Hash;
  claimed: u64;
}

export interface Receipt {
  amount: u64;
}

export function claim(claimer: Mut<Signer>, drop: Mut<Drop>, receipt: Init<Receipt>, systemProgram: SystemProgram, amount: u64, proof: Vec<Hash>): void {
  require(merkleVerify(keccak256(keccak256(claimer.key, amount)), proof, drop.root), "not in the list");
  receipt.create(claimer, ["claimed", drop.key, claimer.key]);
  receipt.amount = amount;
  drop.claimed += amount;
}

export function approved(drop: Account<Drop>, ixs: InstructionsSysvar, who: Pubkey, r: Hash, s: Hash, v: u8): void {
  require(verifyEd25519(ixs, drop.issuer, `allow:${who}`), "not signed by the issuer");
  require(verifySecp256k1(keccak256(who), v, r, s, drop.ethIssuer), "not signed by the Ethereum issuer");
}
```

- The receipt, seeded with the drop and the claimer, makes a second claim fail: its address is already in use.
- `verifyEd25519(instructionsSysvar, signer, message)` returns whether the transaction holds an Ed25519 precompile
  instruction verifying `message` signed by `signer`. The client adds that instruction; the runtime rejects the
  transaction if its signature is wrong.
- `verifySecp256k1(hash, recoveryId, r, s, ethAddress)` recovers the secp256k1 signer of `hash` and returns whether it
  is `ethAddress` (an Ethereum address left-padded to 32 bytes), where `hash` is `keccak256(...message)` or
  `ethMessageHash(message)`. The hash must be computed in the program: a passed-in hash could be forged.

## Instruction introspection

`ixs: InstructionsSysvar` (its address checked, 3008) reads the transaction's other instructions:

- `ixs.length`, `ixs.currentIndex()` (the top-level instruction being executed), and `ixs.get(i)`, a
  `TransactionInstruction`: `programId`, `accountsLength`, `dataLength`, `accountKey(j)` / `accountIsSigner(j)` /
  `accountIsWritable(j)`, `readU8` / `readU16` / `readU32` / `readU64` / `readPubkey(offset)` (little-endian), and
  `is(program, "name")` (that program's instruction by its default Anchor discriminator, sha256("global:<name>"); an
  instruction with its own `@discriminator` is matched with `programId` and `readU64(0)` instead).
- Every read is bounds-checked (5104).
- It is the transaction author's data: require things of the transaction with it (a repay instruction after a flash
  loan), never treat it as proof.

## Oracles

```ts
import { type Hash, type i64, type Pubkey, type PythPriceUpdate, type SwitchboardFeed, type u64, pythPrice, switchboardValue } from "typesol";

export function pythUsd(update: PythPriceUpdate, feedId: Hash, maxAge: u64): i64 {
  return pythPrice(update, feedId, maxAge, -8n);
}

export function feedValue(feed: SwitchboardFeed, expected: Pubkey, maxStaleSlots: u64): i64 {
  return switchboardValue(feed, expected, maxStaleSlots, 6n);
}
```

- **Pyth**: `pythPrice(update: PythPriceUpdate, feedId, maxAgeSeconds, exponent?)` returns a price that is fully
  verified, of that feed and fresh (5111 otherwise). With `exponent`, a feed at another scale is refused. The raw fields
  `update.price`, `conf`, `exponent`, `publishTime` are unchecked (any feed, partially verified or stale): check
  `feedId`, `fullyVerified` and the age yourself, or use `pythPrice`.
- **Switchboard**: `switchboardValue(feed: SwitchboardFeed, expectedFeed, maxStaleSlots, decimals, minSamples?)`. The
  feed must be the expected one (anyone can create feeds); `minSamples`, default 1, is the fewest oracle samples
  accepted; staleness counts slots from the feed's `result.slot`; the 18-decimal result is scaled to `decimals`,
  rounding toward zero. It reads the mainnet program's feeds unless the parameter is `SwitchboardFeed<"devnet">`.
  Failures are 5111.
- Neither reader checks the price's sign or zero, the confidence (Pyth's `conf`, Switchboard's spread of samples), or a
  publish time or result slot in the future (it counts as fresh): check what your program relies on.

## Randomness

A chain has no secret randomness of its own: slot hashes and timestamps are known to, or chosen by, the block producer.
`SwitchboardRandomness` (Switchboard On-Demand's RandomnessAccountData; owner, discriminator and size checked) gives
verifiable randomness by commit and reveal:

```ts
import { type Init, type Mut, type Pubkey, type Signer, type SwitchboardRandomness, type SystemProgram, type u64, currentSlot, require } from "typesol";

export interface Bet {
  randomness: Pubkey;
  seedSlot: u64;
  guess: u64;
  won: boolean;
}

export function commit(player: Mut<Signer>, bet: Init<Bet>, randomness: SwitchboardRandomness, systemProgram: SystemProgram, guess: u64): void {
  bet.create(player, ["bet", player.key]);
  require(randomness.seedSlot === currentSlot() - 1n, "randomness already revealed or stale");
  bet.randomness = randomness.key;
  bet.seedSlot = randomness.seedSlot;
  bet.guess = guess % 2n;
}

export function settle(player: Signer, bet: Mut<Bet>, randomness: SwitchboardRandomness): void {
  require(bet.randomness === randomness.key && randomness.seedSlot === bet.seedSlot, "not the committed randomness");
  bet.won = randomness.valueU64() % 2n === bet.guess;
}
```

Commit while `r.seedSlot === currentSlot() - 1n` and store `r.key` and `r.seedSlot`. Settle in a later transaction
after checking both, with `r.value()` (32 bytes) or `r.valueU64()`, which fail (5111) unless the value was revealed in
this slot. The example is [`test/fixtures/coinflip.ts`](https://github.com/typesol-lang/typesol/blob/main/test/fixtures/coinflip.ts), shortened.

**Next:** [Porting a native program](language-native.md) (advanced), or [test your program](test-your-program.md).
