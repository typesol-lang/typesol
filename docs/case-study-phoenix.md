# Case study: Phoenix v1

This page ports [Phoenix v1](https://github.com/Ellipsis-Labs/phoenix-v1), Ellipsis Labs' on-chain limit order book:
a central limit order book that matches and settles in the same instruction, price first and first in, first out
within a price, with no crank. Its repository now calls it Phoenix Legacy. The port is checked against the binary
that runs on mainnet as `PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY` (deployed in slot 231433470, 2023-11-21), not a
rebuild.

**Which source.** Commit c16694d rebuilt with `solana-verify build --library-name phoenix` (Solana 1.14.9) gives the
deployed executable's hash (`6877a5b732b3494b828a324ec846d526d962223959534dbaf4209e0da3b2d6a9`); OtterSec's
verification registry lists the program as verified from that commit. The repository was under BUSL 1.1 at c16694d;
on 2026-05-11 Ellipsis Labs relicensed it under the MIT License (5a34f7f) with the program's sources unchanged since
c16694d, so the port follows c16694d under MIT ([`test/programs/SOURCES.md`](https://github.com/typesol-lang/typesol/blob/main/test/programs/SOURCES.md)).

Phoenix is a native program built with solana-program 1.14: a u8 tag, the instruction's Borsh arguments after it,
accounts by position. A market is one account: a 576-byte header, then a `FIFOMarket` whose bids, asks and traders are
three lib-sokoban `RedBlackTree`s laid out in the account's bytes (sized by the header: twelve size sets, up to 4,096
orders a side and 8,321 seats), read and written in place. Phoenix does not log its market events: it sends them to
itself in Log instructions, self-CPIs signed by a log-authority PDA, so clients read them from the inner instructions.
The order instructions return the ids of the orders that rested as return data, and the program's failures are often
Rust panics in solana-program 1.14's format, at the original's source locations.

| File | Holds |
| --- | --- |
| [`phoenix.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/mainnet/phoenix/phoenix.ts) | the entrypoint (one `@fallback` over `instructionData()` and `remainingAccounts()`): the four accounts every instruction starts with, the event recorder, dispatch to the 28 tags |
| [`state.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/mainnet/phoenix/state.ts), [`errors.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/mainnet/phoenix/errors.ts) | MarketHeader, the FIFOMarket prefix, the tree keys and values, Seat, PhoenixMarketEvent, the instruction arguments, PhoenixError from code 0 |
| [`checkers.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/mainnet/phoenix/checkers.ts), [`util.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/mainnet/phoenix/util.ts) | the account checks in the original's order, the market loader with its twelve sizes; PDAs, the quantity operators with their panics, the token CPIs |
| [`recorder.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/mainnet/phoenix/recorder.ts) | the event recorder: batches of events sent in Log self-CPIs whenever the next event would not fit |
| [`matching.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/mainnet/phoenix/matching.ts), [`book.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/mainnet/phoenix/book.ts) | the FIFOMarket: place_order_inner, match_order, check_for_cross, eviction; reduce_order_inner and the cancels built on it |
| `orders.ts`, `cancel.ts`, `initialize.ts`, `governance.ts`, `seats.ts`, `funds.ts`, `fees.ts` | the instructions by subject |

## What is ported

All 28 tags: Swap and SwapWithFreeFunds (0, 1), PlaceLimitOrder and its free-funds form (2, 3), ReduceOrder (4, 5),
CancelAllOrders (6, 7), CancelUpTo (8, 9), CancelMultipleOrdersById (10, 11), WithdrawFunds (12), DepositFunds (13),
RequestSeat (14), Log (15), PlaceMultiplePostOnlyOrders (16, 17), and the authority's InitializeMarket,
ClaimAuthority, NameSuccessor, ChangeMarketStatus, ChangeSeatStatus, RequestSeatAuthorized, EvictSeat,
ForceCancelOrders, CollectFees and ChangeFeeRecipient (100 to 109). Every order type (PostOnly, Limit, ImmediateOrCancel
and fill-or-kill, with base or quote budgets, minimum fills, match limits, the three self-trade behaviours, time in
force, fail-silent orders), free funds, taker fees, eviction from a full book, the order packet decoder with its
zero-padding retries, the market's statuses down to Tombstone, and the events byte for byte.

## What it needed

TypeSOL gained these features for it ([Porting a native program](language-native.md)); programs that use none of them
compile to the same C as before:

- **lib-sokoban's RedBlackTree** over account bytes, `rbTreeAt` / `rbTreeMutAt`: `get`, `insert`, `remove`, `min`,
  `max`, `addrOf`, `nodeAt`, walks both ways, with a comparator of the program (Phoenix orders bids by inverted sequence
  numbers). It runs sokoban's code statement for statement, so the bytes are the crate's: replayed against the real
  crate with identical bytes after every operation, on the 21,650 recorded operations of the committed test (seeds
  1–3, capacities 1 to 4096, strides 32, 64 and 144) and, with the previous trace generator, on a one-off run of
  1,020,000 (capacities 1 to 512); sokoban's panics come out with its messages and source lines.
- **`removeAt(index)`**: the node `addrOf`, `min` or `max` found, removed with `remove(key)`'s writes and no second
  search (the trace replay runs again with every `remove(key)` as `removeAt(addrOf(key))`). The port uses it where
  Phoenix finds an order and then removes it: 62 to 103 compute units less per cancelled order (more in deeper books),
  about 100 per order a match fills whole, 190 to 360 per eviction.
- **Cheaper tree walks** (one bounds check per node, the stack by pointer) and an **owner-check cache** for native
  views (the market viewed again passes with a pointer compare): Phoenix's helpers each view the market again, often in
  loops that write it.
- **Data enums by `pushBorsh`, straight-line**: `data.pushBorsh<PhoenixMarketEvent>({ kind: "Fill", … })` writes only
  that variant, one room check and a store per field. Every event is appended to the batch this way: 47 compute units
  less per Reduce event than the six `pushLE` calls it replaced, each of which checked the room of the batch (an
  `Inout` parameter) on its own, and 55 to 70 less per Fill, Place, FillSummary, Evict or ExpiredOrder than serializing
  the whole enum.
- **Struct arguments in place**: an owned struct (a local, a parameter passed on) goes to a helper that takes accounts by
  pointer, so the book helpers take their MarketShape as a plain struct, not `Inout<T>`.
- **`Inout<T>`** helper parameters (Rust's `&mut`: the recorder and its 1,280-byte batch passed down the matching
  engine), **`/** @noinline */`** and **`/** @heap */`** (room beyond one 4 KiB stack frame), local lists of 2 KiB
  (asked for by a 2,052-byte list of collected order ids; the port keeps the 512 ids as u16 node indices).
- **Native-program foundations**: `loadRawAt` / `loadRawMutAt` (a struct at a run-time offset), `NATIVE_ACCOUNT_WRITES`
  (views of one account written in place, judged by the runtime), byte builders (`pushLE`, `pushKey`, `pushBorsh`,
  `setLE`, `truncate`) and `invokeInstruction` for the Log self-CPI, `setReturnData` and `logComputeUnits`, `closeRaw`
  for Tombstone, `findProgramAddressWithBump`, errors from code 0 that log nothing (`ERROR_LOG_PREFIX = null`), and
  panics as solana-program 1.14 writes them (`PANIC_STYLE = "solana-1.14"`, `panicsAt` for Rust's overflow messages at
  the original's locations).
- **Source-level conveniences** the port reads better with: constant expressions (`EVENT_ROOM =
  MAX_INNER_INSTRUCTION_SIZE - LOG_IX_ACCOUNT_META_SIZE`, the node sizes, `BIDS_OFFSET`), file-local structs for
  helper-only types (left out of the IDL), comma-separated `for` updates, and read-only views read where they are made
  (`loadRaw<MarketHeader>(m).status`).

## How it is checked

The mainnet binary and the port run in two LiteSVMs under the same program id and the same Clock
([`phoenix-helpers.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/test/phoenix-helpers.ts)). Every account is made the same way in both, and every
transaction must give:

- the same outcome;
- the same log lines, every one: the original's messages and numbers, panics with their locations, the batch lines of
  the recorder (Phoenix's own "Program consumption" lines by count and position; only the runtime's "consumed N of M
  compute units" lines are left out);
- the same inner instructions in order, each one's program, accounts and data bytes: the Log self-CPIs, so every event
  batch is compared byte for byte, and the token transfers;
- the same return data;
- the same lamports, owner and bytes in every account the transaction names (the books and the traders tree byte for
  byte, rotations and colours included).

There are 3,575 such transactions in five files, on markets of 512 orders and 128 seats and of 4,096 and 8,321 (each
file fails unless it compares exactly its own count):

- **The non-matching instructions** (`phoenix.test.ts`; 824): the entry's checks for all 28 tags, InitializeMarket with
  each of the twelve sizes and every refusal, the authority's instructions, seats, deposits and withdrawals, fees.
- **Orders and matching** (`phoenix-orders.test.ts`; 1,117): every order type on both sides, crossings of many levels,
  self trades, match limits, minimum fills, budgets, fees (100% included), free funds, multiple-order grouping and its
  failure behaviours, a full book (eviction and rejection), time in force, the sequence number's limit, matches whose
  events take several Log batches (300 fills), the packet decoder on cut and invalid packets.
- **Reductions and cancels** (`phoenix-cancel.test.ts`; 390): the orders are placed by the original and its bytes
  copied into the port's VM, so both start from the trees Phoenix itself wrote; partial, whole and oversized reductions,
  foreign and unknown orders, every cancel form with its limits, ForceCancelOrders and EvictSeat, 90 to 512 cancels in
  one instruction, the out-of-memory abort at the 513th, books of up to 8,000 orders, the overflow and division panics.
- **The original's own tests** (`phoenix-upstream.test.ts`; 1,082): each of the 50 test functions at c16694d (the
  integration tests, the matching engine's unit tests, the packet decoder's) is mapped to a case
  ([the mapping](https://github.com/typesol-lang/typesol/blob/main/showcase/test/phoenix-upstream.md)): 11 were covered already, 37 are added there and run whole,
  2 are not applicable (compile-time type checks of the quantity macros). Each refusal the upstream test expects is
  pinned to the original's error and message, and the upstream test's own assertions (balances, the book, free lots,
  the sequence number, fees) are made on chain.
- **The limits** (`phoenix-limits.test.ts`; 162): markets with a tick size or a base lot of 0 (the divisions' panics),
  a negative clock, multiple-order packets longer than a transaction carries, and both sides of each of the heap's
  boundaries, through a forwarding caller program where a CPI is needed (see Differences).

States no instruction reaches in a test's time (fees accrued, a sequence number near its maximum, a damaged lot size)
are written into both VMs' bytes, and each test checks the outcome too, so that every error path is really reached.
Every compared transaction's compute units are kept, and each file fails unless the port uses fewer on every
transaction that succeeds: 2,390 of the 3,575.

**A random walk over the order book** (`phoenix-fuzz.test.ts`, not in those counts) runs a 512/128 and a 4096/8321
market, each book started nearly full of orders far from the action: seated makers and unseated takers deposit and
withdraw, place every kind of order with tokens or free funds, reduce and cancel (with others', unknown, wrong-side and
bit-flipped ids), the authority changes seats, forces cancels, evicts, collects fees and changes the market's status,
the clock moves on so orders expire, and some packets are corrupted. Every step goes through the same comparison, and
an oracle checks after each that the registered traders' locked and free lots plus the uncollected fees are exactly
what the vaults hold. A walk's choices and every keypair come from its seed, so a seed reproduces it. By default the
test walks seeds 1, 2 and 3 on both markets, 300 steps each (1,801 transactions), and requires minimum counts of real
effects decoded from the event batches (fills, partial fills, orders rested, self trades, expiries, evictions, fees)
and a minimum share of successes for every kind of instruction. `FUZZ_SEED` walks another seed and
`PHOENIX_FUZZ_STEPS` changes the length; a walk of 1,000 steps or more must also have every main kind of instruction
succeed and each book fill up and evict. Before the walk drew its keys from the seed, a one-off run of five seeds (1
and 1794299110079 at 1,000 steps, 2, 3 and 4 at 3,000; 21,593 transactions) found no difference.

## Cost

Compute units per transaction, mainnet original against the port, from those tests (the token CPIs are the same work
in both; the account checks that derive PDAs vary with the bumps the keys need, each further bump about 1,500 units
in the original and 341 in the port, and a few rows by a few dozen units from run to run: a range is what two runs of
the five files gave, and `InitializeMarket`'s covers its twelve sizes):

| Instruction | Original | TypeSOL | |
| --- | ---: | ---: | ---: |
| `InitializeMarket` | 79,146–97,353 | 10,940–15,035 | 14–15% |
| `RequestSeat` | 14,900 | 4,599 | 31% |
| `DepositFunds` | 20,441 | 6,176 | 30% |
| `WithdrawFunds` | 17,760 | 6,201 | 35% |
| `CollectFees` | 13,814 | 4,977 | 36% |
| `PlaceLimitOrder`, PostOnly | 20,577–25,077 | 6,452–7,475 | 30–31% |
| `PlaceLimitOrder`, Limit, resting | 21,971–23,471 | 7,066–7,407 | 32% |
| `Swap`, 2 fills | 22,809–22,886 | 8,178–8,196 | 36% |
| `Swap`, 30 fills | 61,313–61,390 | 26,344–26,362 | 43% |
| `PlaceLimitOrder`, Limit through 20 fills, then resting | 108,397–114,399 | 52,894–54,260 | 47–49% |
| `PlaceMultiplePostOnlyOrders`, 5 orders in 4 levels | 34,605–40,614 | 13,324–14,698 | 36–39% |
| `ReduceOrder` | 15,235 | 5,170 | 34% |
| `CancelMultipleOrdersById`, 1 order | 15,984 | 5,708 | 36% |
| `CancelMultipleOrdersByIdWithFreeFunds`, 50 orders | 67,793–67,871 | 38,527–38,547 | 57% |
| `CancelUpTo`, 3 orders | 18,349–18,367 | 7,312 | 40% |
| `CancelAllOrdersWithFreeFunds`, 90 orders | 115,366 | 69,762 | 60% |
| `EvictSeat` | 22,966–33,466 | 7,306–9,693 | 29–32% |

At the extremes: a match of 300 fills in three Log batches 443,217–443,295 against 217,847–217,867 (49%);
`CancelAllOrders` of 512 orders in a 4,096 book 760,087 against 434,446 (57%), and of 200 among 8,000 orders 1,184,623
against 471,050 (40%); `CancelUpTo` searching 1,500 orders 1,002,398–1,002,399 against 456,958–456,960 (46%); the
513th collected id runs both out of memory after 90,220 and 30,363.

The binary is 256,360 bytes against the original's 1,344,472.

## Differences

What the port does not reproduce, and how a transaction would reach it:

- **Compute.** The port spends 13–61% of the original's units (up to 86% in `phoenix-limits.test.ts`, whose
  transactions carry hundreds of account entries or go through a forwarding program), so a transaction that runs the
  original out of its compute budget can complete in the port; the tests give both enough.
- **Memory, counted.** Phoenix allocates on solana-program 1.14.9's bump heap: 32 KiB from the top down, never freed,
  and an allocation past it aborts with "Error: memory allocation failed, out of memory". The port keeps its own lists
  fixed and counts Phoenix's heap instead ([`heap.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/mainnet/phoenix/heap.ts)), charge by charge as the
  Rust allocates: the entrypoint's 48 bytes per account entry and 72 per distinct account, the discriminant lines, the
  event recorder, the status checks' messages (built even when they pass), each batch line, each SPL Token transfer's
  instruction, the cancels' boxed tree iterators with their stacks and the ids they collect, CancelMultipleOrdersById's
  decoded list and kept ids, the multiple-order packet's decoded lists, its sorts (the merge sort's buffer and stack of
  runs) and the "Insufficient funds" lines of the orders it skips, the placed order ids and their Borsh bytes. So a
  transaction that fills the heap (with up to 255 account entries, which Phoenix ignores past the ones it reads, or with
  a CPI's larger instruction data) aborts in the port at the same allocation, after the same log lines and batches.
  [`phoenix-limits.test.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/test/phoenix-limits.test.ts) finds the original's boundary and compares both
  sides of it (one account entry fewer succeeds, the next aborts) for CancelAllOrders and its free-funds form (257 to
  512 orders, bids and asks, 4 to 20 accounts of their own, top-level and through a CPI), CancelUpTo with a count and
  with a search limit, ForceCancelOrders, CancelMultipleOrdersById through a CPI (230 and 340 entries; 341 always runs
  out), and PlaceMultiplePostOnlyOrders through a CPI (decoded lists past their first 85 orders, scrambled sides, 130
  resting orders, token deposits, skipped orders).
- **More than a transaction carries.** A CPI passes up to 10,240 bytes of instruction data, so a multiple-order packet
  is decoded whatever its length, as Phoenix decodes it: past 170 orders a side always runs out of memory at its sort,
  and past 340 while decoding; from 64 resting orders set_return_data refuses the ids (1,028 bytes and up), after every
  order is placed and every batch sent, in both.
- **Memory, not counted.** What Phoenix formats only when it fails is not charged: assert_with_msg's line with its
  location, the formatted failure lines (an IOC's minimum fill, "Market is not active, …"), the String of a Borsh
  decoding error, the panic handler's line. Phoenix builds each on the heap before it reports the failure, so when the
  heap no longer has room for it Phoenix aborts with the out-of-memory line (ProgramFailedToComplete) where the port
  logs the failure and returns its error. A transaction gets there only by failing after it has nearly filled the
  heap. For instance a forwarded multiple-order packet of 300 bids whose asks are cut short fails with BorshIoError in
  both with few account entries and runs out of memory in both (its decoded Vec's last growth) with many; in between,
  at one account count, Phoenix runs out of memory building the error's message (about 100 bytes) while the port
  returns BorshIoError. A formatted failure line after a long match would need the same kind of near-full heap.
  Neither are InitializeMarket's, CollectFees' and the seat and governance
  instructions' own lines and vectors charged (only their batches): with at most 128 distinct accounts, the most a
  transaction locks, they stay far below the heap. A Limit order's crossing check (a boxed iterator) and a match's
  batches are counted, but no test reaches the limit with them: it takes a match of about a thousand fills and more
  distinct accounts than a transaction holds without lookup tables.
- **Damaged trees.** A tree walk keeps its stack of 64 nodes on the program's stack, more than any red-black tree a u32
  index can address holds on one path; only damaged registers go deeper, and the port panics where sokoban's heap stack
  would grow. The panics of a node index out of range (`nodeAt` on damaged registers) take their locations from
  sokoban's source, not from the binary.
- **Paths v1 never takes.** An order of zero lots on a book (only bytes written by hand put one there) is removed as
  the original removes it: a cancel meeting one is tested, the matching engine's two such paths ("Empty order found in
  check_for_cross", a tombstone met while matching) are ported but not reached by a test. The unclean-division warning
  of a bid's unlock, which no market InitializeMarket accepts can produce, is tested on written bytes.

The tests run on LiteSVM without account-data direct mapping; both programs write the market in place, so both would
fault at the same write. The runtime truncates a transaction's log at 10,000 bytes at a point that depends on the
compute-unit lines, which differ by design, so the harness lifts that limit to compare the whole log.
