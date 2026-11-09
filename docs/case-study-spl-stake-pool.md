# Case study: SPL Stake Pool

This page ports [SPL Stake Pool](https://github.com/solana-program/stake-pool) (Apache-2.0), the program behind most
liquid staking tokens on Solana (JitoSOL's pool is one of its accounts). The port is checked against the binary that
runs on mainnet as `SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy` (deployed in slot 429882117, 2026-06-30), not a
rebuild.

**Which source.** The binary's security.txt names `program@v2.0.3`, but that string is fixed in the source and the
deployed code carries a fee-cap message main only gained later. The tag `program@v2.1.0` (54cdced, on a release
branch) rebuilt with `solana-verify build --library-name spl_stake_pool --base-image
solanafoundation/solana-verifiable-build:3.1.14` gives the deployed executable's hash
(`8df58bc9f9428c02bf34fa845ae2961274156e7ff07a8dc1be0018dd765baeff`). The port follows that tag
([`test/programs/SOURCES.md`](../test/programs/SOURCES.md)).

Stake Pool is a native program: one entrypoint decodes a Borsh instruction (a tag byte, then the variant's fields,
every byte consumed), the processor takes its accounts by position, the pool account is plain Borsh with Options and
data enums, the validator list is a header and a `BigVec` of 73-byte entries over a preallocated account of up to
20,000 validators, and every stake move is a CPI into the Stake program across epochs.

| File | Holds |
| --- | --- |
| [`stake_pool.ts`](../showcase/mainnet/spl-stake-pool/stake_pool.ts) | the entrypoint: the instruction decoded as `try_from_slice` does, dispatch to the 27 instructions |
| [`state.ts`](../showcase/mainnet/spl-stake-pool/state.ts), [`errors.ts`](../showcase/mainnet/spl-stake-pool/errors.ts) | StakePool (Borsh, 611 bytes at most), ValidatorList with its `BigVec<ValidatorStakeInfo>`, the stake account layout, StakePoolError from code 0 |
| [`util.ts`](../showcase/mainnet/spl-stake-pool/util.ts) | PDAs, fee arithmetic, the pool-token and lamport conversions, token account and mint checks (Token-2022 extensions included), the stake CPIs as solana_program's builders make them |
| `admin.ts`, `validators.ts`, `update.ts`, `sol.ts`, `stake_deposit.ts`, `stake_withdraw.ts`, `rebalance.ts`, `metadata.ts` | the instructions by subject |

## What is ported

All 27 instructions: Initialize; adding, removing and cleaning up validators and the preferred validators; the epoch
update of the list and of the pool; SOL and stake deposits and withdrawals with their slippage forms; increasing and
decreasing validator stake (the deprecated decrease, the additional forms with ephemeral stake, the decrease funded
from the reserve); the manager's and staker's setters and the funding authorities; the Metaplex token metadata; and
Redelegate, which the deployed program refuses ("will not be enabled"), as the port does.

## What it needed

TypeSOL gained these features for it (docs/language.md, "Porting a native program"; every other program compiles
to the same C as before):

- `loadBorsh<T>` / `storeBorsh`: a Borsh account without a discriminator, read into a local struct and written back
  as `try_from_slice_unchecked` and `serialize` do, the bytes after a shrunk value left as they were (about 280 CU to
  read the 611-byte pool, 610 to read and write it).
- `BigVec<T>`: SPL's `big_vec`, a list over the rest of an account with `push`, `retain`, `slice` and the list
  methods, its loops emitted as functions of their own so they keep their registers (16 CU per entry for the pool's
  update sum, against the original's 27).
- `programAt<P>` / `sysvarAt<S>` and typed CPIs that take remaining accounts, the Stake program's `split`, `merge`,
  `getMinimumDelegation` and lockups, and sysvars named by address as solana_program's builders name them.
- `NATIVE_ACCOUNT_WRITES`: account data written in place and judged by the runtime afterwards, as a native program's
  is; `epochRewards()`; `panic(null, location)` and `abort()`; local lists, the instruction data as a list and
  `invokeInstruction` in helpers (the Metaplex CPI); a ternary between accounts.
- In `typesol/testing`: `warpToEpoch`, `StakeCluster` (the StakeHistory a cluster writes, so stake warms up and cools
  down over epochs as on mainnet, matched to the runtime's Stake program to the lamport), and vote and stake account
  builders.

## How it is checked

The mainnet binary and the port run in two LiteSVMs under the same program id, with the same clock and the same
StakeHistory written into both by one `StakeCluster`. Every transaction must give the same outcome, the same log
lines (the "Instruction: …" lines, every message with its numbers, the error lines, panic locations) and the same
bytes in every account it names. There are 2,092 such transactions in six files:

- **The instructions** (`spl-stake-pool.test.ts`, `-stake`, `-rebalance`, `-metadata`; 1,391): every instruction's
  success paths and every refusal that can be built, account by account (wrong signers, PDAs, owners, mints and
  Token-2022 extensions, sysvars, short account lists), fee limits, slippage, preferred validators, funding
  authorities, read-only and repeated accounts (the original's RefCell panics included), pools of 50 to 60 validators,
  warmup and cooldown over several epochs.
- **The original's own tests** (`spl-stake-pool-upstream.test.ts`; 701): each of the 221 test functions in
  `program/tests` at the tag is mapped to a case ([the mapping](../showcase/test/spl-stake-pool-upstream.md)): 143
  were covered already, 78 are added there, none is left out. huge_pool.rs runs at 3,000 and 20,000 validators.
- **A random walk over epochs** (`spl-stake-pool-fuzz.test.ts`): validators added and removed, users depositing and
  withdrawing SOL and stake, rebalancing, updates in random chunks, fee and authority changes, rewards, slow warmup,
  and invalid inputs at a low rate (`FUZZ_SEED`, `STAKE_POOL_FUZZ_STEPS`). Five seeds of 600 steps (215 epochs, about
  3,700 transactions) found no difference.

The random walk found one: a stake withdrawal that searched the list in one pass where the original searches twice
ran out of the default compute budget at 3,550 validators, where the original does not. The port now searches as the
original does, and a regression case runs at 3,550 validators.

## Cost

Compute units per transaction, mainnet original against the port, from those tests (the stake, token and Metaplex
CPIs are the same work in both; the port's own part is about a third of the original's):

| Instruction | Original | TypeSOL | |
| --- | ---: | ---: | ---: |
| `Initialize` | 16,535 | 6,311 | 38% |
| `DepositSol` | 16,090 | 7,090 | 44% |
| `WithdrawSol` | 21,247 | 12,492 | 59% |
| `AddValidatorToPool` | 41,117 | 31,518 | 77% |
| `RemoveValidatorFromPool` | 21,027 | 14,868 | 71% |
| `UpdateValidatorListBalance`, 12 validators | 104,835 | 29,605 | 28% |
| `UpdateStakePoolBalance` | 10,080 | 3,549 | 35% |
| `CleanupRemovedValidatorEntries` | 4,847 | 938 | 19% |
| `DepositStake` | 86,950 | 64,353 | 74% |
| `WithdrawStake` | 67,809 | 52,184 | 77% |
| `IncreaseValidatorStake` | 42,088 | 33,109 | 79% |
| `DecreaseValidatorStakeWithReserve` | 59,340 | 47,497 | 80% |
| `SetFee` | 3,624 | 1,628 | 45% |
| `UpdateTokenMetadata` (without Metaplex's part) | 10,250 | 5,285 | 52% |

At 20,000 validators (huge_pool.rs, with a 1.4M CU budget): `UpdateStakePoolBalance` 547,385 against 321,992 (59%),
the cleanup 184,870 against 101,019 (55%), `DepositStake` 611,313 against 153,300 (25%), `WithdrawStake` 783,846
against 310,716 (40%). Within the default 200,000 the port updates a pool of 6,800 validators in 110,642 and cleans up
19,000 in 95,869, as the original does in 190,835 and 175,720.

The binary is 202,240 bytes against the original's 338,912.

## Differences

None that a transaction can reach. Two need the pool's bytes rewritten by hand, which no instruction allows:

- The validator list given again in the place of an account the pool stores (the reserve, the mint, the fee account):
  the original would panic on a second borrow of the list there; the port does not model that borrow.
- A withdraw authority whose stored bump is not the canonical one: the metadata instructions sign with the stored bump,
  the original finds the canonical one again.

The tests run on LiteSVM, whose Stake program computes warmup with the f64 formula; `StakeCluster` follows it
(`math: "integer"` when the runtime moves to the integer one). Account-data direct mapping is not enabled there; both
programs write in place, so both would fault at the same write.
