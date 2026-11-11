# Phoenix v1: the original's tests, mapped

Every test function of the original's own tests (Ellipsis-Labs/phoenix-v1 at c16694d, the source of the mainnet
binary: the 21 integration tests of `tests/test_phoenix.rs`, the 22 matching-engine unit tests of
`src/state/markets/test_market.rs` and the 7 other unit tests in `src/`, as `grep -rn "#\[test\]\|#\[tokio::test\]" src
tests` lists them) is mapped below to a differential case of the TypeSOL port's tests: the original
(`test/programs/phoenix_v1.so`) and the port run side by side, and each case must have the same outcome, log lines,
inner instructions (the event batches byte for byte), return data and account bytes in both (`both()` in
`phoenix-helpers.ts`).

- **covered**: a case of the earlier files runs the same instruction path under the same condition (the label in quotes
  is the `both()` label; the file is named).
- **added**: no earlier case did; `phoenix-upstream.test.ts` runs the whole upstream scenario, in a `describe` named
  after the file and an `it` named after the test. Every transaction of a scenario is compared, its setup included.
  Each transaction the upstream test expects to fail must fail with the original's error and log the original's own
  message for it (`rejects()`), so a transaction refused before it reaches the check the test aims at does not pass.
  The upstream test's own assertions are made on chain: token balances (`get_token_balance`), the book's orders and
  levels (`get_market_orderbook`, `get_typed_ladder`), a trader's free lots (`TraderState`), the market's
  sequence number and fees. The unit tests' `MatchingEngineResponse` has no account of its own: it is checked through
  what it moves in the trader's token accounts (an order with tokens deposits its matched and posted lots less the free
  lots it used, and withdraws what it matched out, as `process_new_order` does). Where an assertion still cannot be
  made on chain the row says so. Events (upstream decodes some of them) are compared byte for byte with the
  original's in every case, but not decoded here.

| | Test functions |
| --- | --- |
| covered | 11 |
| added | 37 |
| not applicable | 2 (`quantities.rs`'s two macro tests: compile-time type checks, see below) |

`phoenix-upstream.test.ts` compares 1,082 transactions (37 tests; the file fails if the count changes, and if the port
is not cheaper than the original on every one that succeeds); none of the 37 found a difference in the port.

## Adaptations

- **The bootstrap.** Upstream's `bootstrap_with_parameters` (a 4096/8193 market; 100,000 quote lots per quote unit,
  1,000 base lots per base unit, a tick of 1,000 quote lots per base unit, 9 and 6 decimals; InitializeMarket and
  ChangeMarketStatus Active in one transaction; a maker seated by the authority, an unseated taker, each with
  1,000,000 units of each token; the authority as the fee recipient) is made the same way. `get_new_maker`'s 5,000
  lamports sent to the seat address go in the same transaction as RequestSeatAuthorized, as there.
- **Prices and sizes.** The SDK's float conversions (`float_price_to_ticks_rounded_down`, `raw_base_units_to_base_lots`)
  are written out in ticks and lots: ×100 ticks per quote unit and ×1,000 lots per base unit on the default market.
  Where the float conversion would land on the integer (10.01 − 0.01·i, 10.02 + 0.01·i) the integer is used; the raw
  base unit test's 0.000001358 / 0.000001359 and 0.000001361 / 0.000001362 are 135, 135, 136 and 136 ticks.
- **The unit tests** call the FIFOMarket directly: no seats, no tokens, a clock function, `u128` trader ids. They run
  here on a real 4096/8193 market (the size of their `Dex`) with their tick and base lot sizes and 1,000,000 quote lots
  per quote unit; every trader that places a limit order holds an approved seat and tokens. `place_order` is
  PlaceLimitOrder (Swap for a take-only packet, the WithFreeFunds form for a packet on deposited funds),
  `claim_all_funds` WithdrawFunds, `cancel_*` / `reduce_order` with `claim_funds` the plain instructions,
  `collect_fees` CollectFees, and the clock function the Clock both VMs run with (`setClock`). Where the unit test
  removes a trader through `claim_all_funds` (`test_market_simple`), the authority retires and evicts the seat.
- **Free funds and Swap.** The bare matching engine leaves a trader's free lots alone on a take-only order that does
  not ask for them; the Swap instruction pays from a registered trader's free lots first. In
  `test_fok_and_ioc_with_free_funds` the quote lots the token buy took are deposited back right after it, so the
  free-funds orders that follow meet the unit test's balances (and its outcomes).
- **`warp_to_slot`** (upstream's way to send the same transaction twice) needs nothing: the harness expires the
  blockhash after every transaction.
- **The log limit.** The runtime cuts a transaction's log at 10,000 bytes; where it cuts depends on the "consumed N of
  M compute units" lines, whose N differ between the two programs by design. `layer_orders`' 12 orders a transaction
  are past it, so the harness now lifts the limit (`withLogBytesLimit()`) and compares whole logs.

## Compute units at the extremes

| Transaction | Original | TypeSOL | |
| --- | ---: | ---: | ---: |
| test_market_simple: 12 Limit bids or asks in one transaction (the largest) | 351,044 | 111,232 | 32% |
| test_phoenix_basic: 12 Limit bids in one transaction | 279,289 | 92,427 | 33% |
| test_market_simple: CancelUpTo, a maker's asks (the costliest of the ten) | 191,167 | 128,456 | 67% |
| test_market_simple: CancelUpTo, a maker's bids (the costliest of the ten) | 175,527 | 114,434 | 65% |
| test_phoenix_place_multiple_limit_orders: 21 PostOnly orders a side | 123,603 | 72,485 | 59% |
| test_phoenix_basic: CancelUpTo, 81 bids | 117,347 | 81,095 | 69% |
| test_market_simple: IOC sell through five bid levels | 83,995 | 46,440 | 55% |
| adversarial: IOC buy of 700 lots (24 fills, 136 orders a side) | 53,514 | 28,197 | 53% |
| adversarial: 30 + 30 one-lot orders coalesced, the 136th packet | 48,957 | 22,342 | 46% |
| place_multiple_memory_management: IOC sell of u64::MAX lots | 44,448 | 22,787 | 51% |
| test_tif: an IOC that expires the resting order | 15,149 | 5,658 | 37% |
| test_decode_order_packet: a deprecated IOC packet | 11,680 | 2,539 | 22% |

The costliest transactions anywhere are in the random walk (`phoenix-fuzz.test.ts`): CancelAllOrders of one trader's
orders on the 4096/8321 market, whose books hold about 8,000 orders, walks both books whole: 1,142,204 units in the
original and 612,943 in the port at most in the seeds tried (54%), 0.99–1.14 million in the original from seed to seed.

## tests/test_phoenix.rs

| Upstream test | Here |
| --- | --- |
| test_phoenix_request_seats | added (the attacker's own market on the same mints; a seat approved through another market's authority; self-approval; Retired → Approved; eviction with an open order, ForceCancelOrders on both sides, eviction). Upstream asserts only success and failure; each failure is pinned to the original's error and message |
| test_phoenix_orders | added (a bid at 0 ticks refused, at 1 tick placed and cancelled by `!1`; four orders in one transaction; cancels by id, again, and with an unknown id and the bid's inverted sequence number). The maker's balances after the four orders (999,999,998,000,000 base and 999,999,801,000 quote atoms), after each cancel, the bid's 99,000 quote atoms returned, and the sequence number unchanged by the cancels |
| test_phoenix_cancel_all_orders | covered: "CancelAllOrders 4096/8321: no orders left" (phoenix-cancel.test.ts; upstream builds its four orders but never sends them, so it cancels a registered trader's empty set) |
| test_phoenix_admin | added (fee 5; NameSuccessor and ClaimAuthority by the wrong and right keys; status changes by the old and new authority; trading while Paused; tombstoning with orders and with uncollected fees; EvictSeat while approved, then NotApproved and evicted; CollectFees; tombstoned). Upstream asserts only success and failure; each failure is pinned |
| test_phoenix_basic | added (81 bids and 110 asks layered 12 a transaction; an IOC sell through five levels; WithdrawFunds; CancelUpTo every bid; a lot deposited and withdrawn). The taker's +398,750,000 quote and −10,000,000,000 base atoms; the maker's withdrawal of 10,000,000,000 base atoms and no quote; the bid book empty after CancelUpTo and the maker's quote at 10¹² − 398,750,000; one lot of each deposited and withdrawn. Upstream also pairs each Reduce event with a resting bid: the events are compared byte for byte, not decoded |
| test_phoenix_fees | added (fee 5 accrued by a trade; ChangeFeeRecipient without and with the current recipient; CollectFees to the new recipient; ChangeFeeRecipient with nothing uncollected). The fee 5 bps of the taker's proceeds, 50,000 atoms out of the quote vault (left at 0) and into the new recipient's account, the maker's 1,000 free base lots |
| test_phoenix_cancel_with_free_funds | added (a bid on free funds; CancelAllOrdersWithFreeFunds; two bids and CancelMultipleOrdersByIdWithFreeFunds of `!2` in one transaction; a bid and CancelUpToWithFreeFunds in one transaction). The free lots after the deposit, after each bid (1,000 quote lots locked) and after each cancel, and whether the bid book is empty. The Reduce events upstream pairs with the orders are compared byte for byte, not decoded |
| test_phoenix_orders_with_free_funds | added (SwapWithFreeFunds without a seat; trades through 10 levels and DecrementTake self trades; free-funds orders short and funded; free lots paying first for token orders; each packet through the wrong instruction). Every balance upstream asserts: the maker's −2,200,000,000 quote and −66,000,000,000 base atoms after the trades, nothing moved by the free-funds IOCs, −33,690,000 and −1,000,000,000 for the orders a unit beyond its free lots; the second maker's balances unchanged by its free-funds orders and −10,000,000,000 base, −341,000,000 quote for the token ones |
| test_phoenix_place_multiple_limit_orders | added (five accounts only; free-funds packets short of base and of quote; crossing itself two ways; crossing the book; free lots first; 21 orders a side in the 766-byte packet). The maker's −20,000,000,000 base and −170,000,000 quote atoms for the first packet, nothing for the free-funds one, −5,000,000,000 and −40,000,000 for the one that spends free lots first. Upstream's "base short" packet has a bid at 11 above its ask at 10, so it is refused as crossing itself before funds are checked, in the original as here |
| test_phoenix_log_authorization | covered: "Log: another signer", "Log: the log authority, not signing" (phoenix.test.ts). Its third assertion (the log authority PDA signing outside the program) fails in the client, which cannot sign for a PDA; no instruction reaches the program there or here. |
| test_phoenix_cancel_all_memory_management | covered: "CancelAllOrders 4096/8321: 512 orders" (phoenix-cancel.test.ts: one trader's orders on both books cancelled by the plain form with 1,400,000 units; upstream's 401, layered by Limit orders) |
| test_phoenix_place_multiple_memory_management | added (21 orders a side, then an IOC sell of `u64::MAX` lots at price 0). Upstream asserts only success |
| test_phoenix_place_multiple_limit_orders_adversarial | added (136 transactions of 30 one-lot bids and 30 one-lot asks at one price each, coalesced, with upstream's self-transfer; an IOC buy of 700 lots). Upstream asserts only success |
| test_phoenix_basic_with_raw_base_unit_adjustment | added (1,000 raw base units a base unit, 5 decimals; the maker's extra tokens; four orders in one transaction; an IOC sell through both bids; WithdrawFunds). The taker's quote received and base sold by upstream's formula (price × size × lot size, the lot sizes from the market header), the maker's withdrawal of the base bought and no quote |
| test_phoenix_place_order_quiet_failure | added (fail-silent Limit asks and bids beyond the tokens, with deposits and free-funds orders in one transaction; the same order failing without the flag). The 3,000,000,000 base and 3,000,000 quote atoms left after the fail-silent orders, 3 asks and 3 bids resting before and after the failing ones, the balances back to the start after each CancelAllOrders |
| test_phoenix_multiple_orders_fail_silently_basic | added (FailOnInsufficientFunds fails; SkipOnInsufficientFunds rests 9 bids and 9 asks) |
| test_phoenix_multiple_orders_crossing_order_input | covered: "512: multi crossing input", "4096: multi crossing input" (phoenix-orders.test.ts: a packet whose own bids and asks cross is refused before any behavior applies) |
| test_phoenix_multiple_orders_crossing_existing_book_ignore_crossing_bid | added (FailOnCross and SkipOnInsufficientFunds-FailOnCross both refused, with the original's message) |
| test_phoenix_multiple_orders_crossing_existing_book_amend_bid | added (11 bids and 11 asks rest after the amendment; no bid at or above 1001 rests, the others do, two at 1000; every ask rests; the best ask 1001 and bid 1000) |
| test_phoenix_multiple_orders_crossing_existing_book_ignore_crossing_ask | added (FailOnCross and SkipOnInsufficientFunds-FailOnCross both refused, with the original's message) |
| test_phoenix_multiple_orders_crossing_existing_book_amend_ask | added (11 bids and 11 asks rest after the amendment; every bid rests, every ask above 996, three at 997; the best ask 997 and bid 996) |

## src/state/markets/test_market.rs

| Upstream test | Here |
| --- | --- |
| test_market_simple | added (10 seeded makers layering about 1,200 Limit orders; IOCs at the best levels, one crossing nothing, one through five levels but a lot; withdrawals; each maker's bids cancelled by CancelUpTo or by id at random; asks cancelled; seats retired and evicted; both books empty). Both books in price-time order; each IOC's base and quote lots (the quote × base lots a unit = tick × price × size), the next level then best, the ladder unchanged by the IOC that crosses nothing, 1 lot left on the fifth level and the quote out of the five-level sell; every maker that withdraws left with nothing free. Upstream's draws come from StdRng, here from the harness's xorshift; `claim_all_funds` removing an empty trader is the authority's retire and evict |
| test_post_only_default | added (a PostOnly crossing the trader's own order at the same price refused on both sides; the ladder: bids 101 and 100, ask 102, a lot each) |
| test_post_only_rejection | added (rejected and amended PostOnly orders; on an empty book an ask at 1 tick; a bid amended below 1 tick and a bid at 0 refused). The two ladders upstream asserts and the best ask at 1 tick |
| test_cancel_all | covered: "CancelAllOrders 512/128: 96 orders", "CancelAllOrders 4096/8321: 96 orders" (phoenix-cancel.test.ts: one trader's bids and asks, the plain form) |
| test_limit_orders_with_self_trade | added. Each response upstream asserts, as token movements: the ask posting 10 base lots, the DecrementTake bid posting on freed quote only, the taker's ask selling 5 and posting 5, its DecrementTake bid matching and posting nothing; the ladder sizes 5, 10, 5, 5 and 4 |
| test_limit_orders_with_free_lots | added (15 orders whose fills and self trades free lots that later orders spend). The six responses upstream asserts, as token movements (posted and matched lots less the free lots used, the quote of matched sells out) |
| test_orders_with_only_free_funds | added. Upstream asserts only which orders succeed; each refusal is pinned to "Trader does not have enough deposited funds to process order" |
| test_fok_and_ioc_limit_1 | added (FOK buy and sell through 3 levels: 30 lots for the quote lots of 30 at 102, 30 for those of 30 at 98) |
| test_fok_and_ioc_limit_2 | added (both FOKs refused for missing their minimum fill) |
| test_fok_and_ioc_limit_3 | added (a quote budget a lot above three levels buys 30 lots for the quote of 30 at 102; an IOC sell of 31 lots sells the 30 there) |
| test_fok_and_ioc_limit_4 | added (two levels filled each way: 20 lots for the quote of 10 at 101 and 10 at 102, and of 10 at 99 and 10 at 98) |
| test_fok_and_ioc_limit_5 | added (FOKs of 31 lots refused; IOCs expired by slot and by timestamp at slot 1,000, second 1,000 move nothing, the one within both limits fills; base and quote budgets both given refused as "Invalid IOC params.") |
| test_fok_and_ioc_with_free_funds | added (the taker's free lots deposited; see Adaptations). Upstream asserts only which orders succeed; the two refusals are pinned to the deposited-funds message |
| test_fok_with_slippage_1 | added (a quote budget with a minimum of base lots, the minimum computed in f64 as there; 5 bps). The starting ladder's third ask (103, 30,000 lots); the average price within 50 bps of 102; the best ask after it equals the starting book less the lots bought (upstream replays the Fill events; the fills take the best asks in order) |
| test_fok_with_slippage_2 | added (refused for missing its minimum of quote lots) |
| test_fok_with_slippage_3 | added (a base budget with a minimum of quote lots). All 50,000 base lots sold, at least the minimum of quote lots received, the best bid after it the starting book less the lots sold. Upstream's bps assertion (`bps.floor() <= bps + taker_bps`) holds for any fill; it is kept as written |
| test_sell_with_quote_lot_budget | added (1,000,000 quote lots out on the first sell; 10,101 base lots in for 10,101 × 99 quote lots on the second) |
| test_fees_basic | added (fees on a buy and a sell, then CollectFees). The buy's 10 lots for the quote plus 5 bps, the sell's 10 lots for the quote less 5 bps, no uncollected fees after CollectFees |
| test_evict_order | covered: "full 512: a better bid evicts the lowest", "full 512: a bid at the lowest price is refused", "full 512: a better ask evicts the highest", "full 512: a worse ask is refused" and the same at 4096 (phoenix-orders.test.ts; the evicted trader's freed lots are in the compared bytes) |
| test_reduce_order | covered: "ReduceOrder 4096/8321: part of a bid", "ReduceOrder 4096/8321: another trader's order", "ReduceOrder 4096/8321: an order that is not there", "ReduceOrder 4096/8321: the rest of the bid (size above it)" (phoenix-cancel.test.ts) |
| test_tif | added (a PostOnly bid with a last valid timestamp, then one with a last valid slot: placed when already expired (nothing rests, nothing deposited), placed, filled half way and exactly at the last valid slot or second (quote received each time), expired one past it (no quote, the bid's last 80 lots removed, the book empty)). The order of the events upstream checks (Place, TimeInForce, Fill, FillSummary, ExpiredOrder) is compared byte for byte with the original's, not decoded |
| test_limit_order_crossing | added (two Limit bids of 10 at 100; a Limit ask of 20 at 95 with a match limit of 1 fills one bid and, still crossing, does not rest: no asks, one bid of 10 left). "512: Limit bid, match limit 1, still crossing" (phoenix-orders.test.ts) runs the mirror case, a bid, and asserts only its success |

## The other unit tests in src/

| Upstream test | Here |
| --- | --- |
| lib.rs check_pda | covered: every event batch is a self-CPI signed by the log authority PDA with Phoenix's bump, compared as an inner instruction in every case that places an order (e.g. "512: PostOnly bid", phoenix-orders.test.ts), and "Log: another signer" (phoenix.test.ts) |
| program/accounts.rs test_valid_discriminants | covered: "InitializeMarket 512/128" (the header's discriminant written and the "Discriminant for … is …" lines logged), "Swap: market discriminant", "ChangeSeatStatus 512/128: seat discriminant" (phoenix.test.ts) |
| program/dispatch_market.rs test_market_size | covered: "InitializeMarket 512/128" … "InitializeMarket 4096/8321" (every accepted size) and "InitializeMarket: size 512/1024/128" and the other refused sizes (phoenix.test.ts) |
| program/instruction.rs test_instruction_serialization | covered: "entry: tag 18", "entry: tag 99", "entry: tag 110", "entry: tag 255" and every one of the 28 tags in "the entry" (phoenix.test.ts) |
| state/order_schema/order_packet.rs test_decode_order_packet | added (100 rounds of the deprecated PostOnly and Limit packets, 3 bytes shorter, and IOC packets, 2 bytes shorter, seeded; half random over every field as there, half with prices and sizes the market takes, so each form also succeeds) |
| quantities.rs test_new_constructor_macro | not applicable: it checks that `BaseLots + BaseLots` type-checks (and that mixing units does not compile), a property of the Rust newtypes with no program state or instruction behind it. The port's arithmetic on these quantities is compared in every case, their overflows in "panics on overflows as quantities.rs's operators do" (phoenix.test.ts). |
| quantities.rs test_multiply_macro | not applicable: the same for `BaseUnits × BaseLotsPerBaseUnit`. |
