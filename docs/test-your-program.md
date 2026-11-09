# Test your program

`typesol/testing` runs your program in LiteSVM, an in-process Solana runtime: no validator, no SOL, a few
milliseconds per transaction. Projects from `typesol init` already use it in `tests/<name>.test.ts`.

```ts
import { testProgram, type TestProgram } from "typesol/testing";
import { beforeAll, expect, it } from "vitest";

let t: TestProgram;
beforeAll(async () => {
  t = await testProgram("counter", import.meta.url); // builds the program of typesol.json and loads it
});

it("counts", async () => {
  const alice = await t.wallet(); // a funded keypair (10 SOL)
  const counter = await t.pda("counter", alice); // seeds: text, addresses or keypairs, bytes, bigints (u64)
  t.ok(await t.send(alice, t.ix("initialize", {}, { authority: alice, counter })));
  t.ok(await t.send(alice, t.ix("increment", { by: 5n }, { authority: alice, counter })));
  expect((await t.account<{ count: bigint }>("Counter", counter))?.count).toBe(5n);
});
```

## Instructions

`t.pda(...seeds)` derives this program's PDA for the seeds; `t.pdaWithBump(...seeds)` gives `[address, bump]`, for an
instruction that takes the bump as an argument.

`t.ix(name, args, accounts, remaining?)` builds one instruction.

- **Accounts by name**, in camelCase or snake_case. Their signer and writable flags come from the IDL, and accounts
  with a fixed address (the System Program, token programs, sysvars) are filled in, as are PDAs whose seeds are
  constants, arguments or other accounts' keys (`t.ix("initialize", {}, { authority: alice })` derives `counter`). Pass a keypair for an account that
  signs, an address otherwise, and `null` to leave an optional account out.
- **Arguments as plain values:** bigints or numbers for integers, address strings for Pubkeys, `null` for an empty
  Option, objects for structs (camelCase or snake_case fields), arrays for Vecs.
- **Remaining accounts:** `[{ address, writable?, signer? }]`, where `signer` is the account's `KeyPairSigner` (it then
  signs as a signer account; `writable` defaults to false).

`t.send(payer, ...ixs)` sends them in one transaction; keypairs given as accounts sign too.

## Results

| Helper | Gives |
| --- | --- |
| `t.ok(res)` | the successful result, or throws with the error, its name (`NotAdmin`) and the program's logs |
| `t.errorCode(res)` | the custom error code of a failed transaction: 6000 + the member's index in your error enum, or a framework code ([errors.md](errors.md)) |
| `t.account(type, address)` | the account decoded by its IDL type (bigints, address strings), or `null` once closed. TypeSOL fixed layouts come back as their IDL structs: a `FixedString<N>` as `{ len, bytes }`, a `FixedVec<T, N>` as `{ len, items }` (the generated client gives strings and arrays) |
| `t.returned(instruction, res)` | the instruction's return data: an integer, boolean, Pubkey or struct |
| `t.balance(address)` | lamports |
| `t.errorName(code)` | the name of an error code: your program's, TypeSOL's or Anchor's |
| `t.connection` | `{ rpc, rpcSubscriptions }` answered by this LiteSVM, for the generated client: `counter.sendInstructions(t.connection, alice, [ix])`, `counter.accounts.Counter.fetch(t.connection.rpc, address)`, views, `resolve`, `watch` and `watchEvents` (as on a cluster: `watch` yields when a later transaction changes the account, not at once; `watchEvents` gets transactions sent after it subscribed, failed ones included in the stream and skipped by the client) |

## Tokens and time

| Helper | Does |
| --- | --- |
| `t.mint({ authority, decimals?, supply?, freezeAuthority?, tokenProgram?, address? })` | writes a mint straight into the VM, as CreateAccount + InitializeMint2 leave it (SPL Token unless `tokenProgram` is Token-2022; no extensions), and returns its address |
| `t.tokenAccount({ mint, owner, amount?, tokenProgram?, address? })` | writes a token account holding `amount`; pass `address` for an associated token account |
| `t.tokenBalance(address)` | the amount a token account holds, or `null` when it does not exist |
| `t.warp({ unixTimestamp?, slot?, seconds? })` | moves the Clock: to a timestamp or slot, or forward by `seconds` |

## Epochs and staking

LiteSVM's `warpToSlot` leaves `Clock.epoch` where it was, and its StakeHistory stays empty, so the Stake program takes
every delegation as fully active one epoch after it was made. For a program that stakes, these helpers make epochs and
warmup / cooldown behave as on a cluster:

| Helper | Does |
| --- | --- |
| `warpToEpoch(svm, epoch, { secondsPerSlot? })` | moves the Clock to the first slot of `epoch` by the VM's EpochSchedule (warmup epochs included): slot, epoch, leader schedule epoch, `unixTimestamp` (+0.4 s a slot by default) and `epochStartTimestamp`; expires the blockhash. `nextEpoch(svm)` moves one epoch |
| `new StakeCluster(svms, opts?)` | one or more LiteSVMs that get the same Clock, EpochSchedule and StakeHistory. `cluster.nextEpoch()` / `cluster.warpToEpoch(e)` end each epoch as a cluster does: the StakeHistory gets the epoch's entry (the sum of every stake account's activation at that epoch, plus `base`, the rest of the cluster), then the Clock moves on. `cluster.activation(stake)` gives a stake account's `{ effective, activating, deactivating }` now |
| `stakeActivation(delegation, epoch, history, newRateActivationEpoch?, { math? })` | a delegation's activation at an epoch: an exact port of the Stake program's `stake_activating_and_deactivating_v2` (solana-stake-interface 4.3.0) |
| `createVoteAccount(svm, payer, { node?, voter?, withdrawer?, commission? })` | a vote account made by the Vote program; returns its address |
| `createStakeAccount(svm, payer, { staker, withdrawer, lamports, lockup? })` | a stake account made by the Stake program, `lamports` in all (rent-exempt minimum included) |
| `delegateStake(svm, payer, { stake, vote, staker? })` | delegates it |
| `readStakeAccount(svm, address)` | the account's StakeStateV2: `{ kind: "Stake", meta, stake: { delegation, creditsObserved }, stakeFlags }`, `Initialized`, `Uninitialized` or `RewardsPool`; `null` when it does not exist |
| `readStakeHistory(svm)` / `writeStakeHistory(svms, entries)` | the StakeHistory sysvar as a `Map` of epoch → `stakeHistoryEntry(effective, activating, deactivating)` |

```ts
const cluster = new StakeCluster([original.svm, port.svm], { base: stakeHistoryEntry(1000n * SOL) });
const vote = await createVoteAccount(original.svm, payer);
// ... the program under test delegates a stake account
cluster.nextEpoch(); // 9% of the cluster's effective stake may warm up per epoch: 90 SOL here
expect(cluster.activation(stake).effective).toBe(90n * SOL);
```

- **The rest of the cluster.** `base` defaults to 400M SOL effective with nothing activating or deactivating: as on
  mainnet, a delegation under 36M SOL warms up in one epoch. Give a smaller `effective`, or `activating` /
  `deactivating` above 9% of it, to make warmup and cooldown take several epochs; `base` may also be a function of
  the epoch. With `allStakeAccounts: false` only the accounts passed to `cluster.track(...)` count.
- **One history for every VM.** The delegations are read from the first VM; the Clock and EpochSchedule of the first
  VM are copied to the others when the cluster is made, so a differential test's two VMs see the same sysvars.
- **No gaps.** The Stake program finds an entry by its distance from the newest one, which must be the previous
  epoch's: a history that skips an epoch is misread. The cluster writes one entry per epoch it passes; it refuses a VM
  whose history stops before the previous epoch or has an entry for the current epoch or a later one (an epoch that
  has not ended), and `cluster.warpToEpoch` / `nextEpoch` refuse to go on once the Clock was moved past the history
  some other way. Warping a VM with stake accounts by `warpToEpoch` alone leaves the history behind.
- **A new LiteSVM's slot.** Its Clock is at epoch 0 but at slot 454,464,000; the first warp moves the slot back to the
  first slot of the epoch warped to (32 for epoch 1 by the default warmup schedule), the timestamps forward.
- **Float or integer.** The Stake program in LiteSVM 1.6.1 computes warmup and cooldown with f64 (the algorithm
  solana-stake-interface 4.3.0 keeps as the deprecated `stake_activating_and_deactivating`); Stake program 5.1
  (SIMD-0391) uses basis-point integers. They differ by a few lamports once amounts pass 2^53 lamports (about 9M SOL).
  `StakeCluster` uses `math: "float"` by default, so its history and `activation` match LiteSVM to the lamport;
  `stakeActivation` uses the integer algorithm unless given `{ math: "float" }`. Both take the 9% rate from epoch 0
  (`newRateActivationEpoch` 0, as the Stake program has it); `null` gives the original 25%.
- **Rent.** In LiteSVM 1.6.1 the Stake program holds back the Rent sysvar's minimum for 200 bytes
  (`svm.minimumBalanceForRentExemption(200n)`), which is less than the `rentExemptReserve` its Initialize stores.

## Accounts from a cluster

To test against accounts that exist on mainnet (a mint, an oracle, another program), list them in `typesol.json` as
`"clone": ["<address>", …]` and run `typesol clone --url mainnet-beta` once (or `typesol clone <address>…`). They are
written to `tests/accounts/`, which `testProgram` loads into its LiteSVM before your first test; commit the directory so
the tests run offline. `loadClonedAccounts(svm, dir)` does the same for a LiteSVM of your own.

`t.svm`, `t.programId`, `t.idl` and `t.coder` are there for anything else. `programHarness(svm, programId, idl)` gives the same helpers for a
program you loaded yourself, and `svmConnection(svm)` the RPC pair alone (for any LiteSVM, e.g. one with an Anchor
program loaded). Transactions sent through it run at once; `getProgramAccounts` (`fetchAll`) sees the accounts those
transactions named, plus any you `track(...)`.

The module needs `litesvm` and `@anchor-lang/core`, which `typesol init` adds to `devDependencies`.
