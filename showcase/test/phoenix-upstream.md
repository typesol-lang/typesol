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
  after the file and an `it` named after the test, with the outcomes the upstream test asserts. Every transaction of a
  scenario is compared, its setup included.

| | Test functions |
| --- | --- |
| covered | 12 |
| added | 36 |
| not applicable | 2 (`quantities.rs`'s two macro tests: compile-time type checks, see below) |

`phoenix-upstream.test.ts` compares 1,073 transactions (36 tests); none of the 36 found a difference in the port.

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

## tests/test_phoenix.rs

| Upstream test | Here |
| --- | --- |
| test_phoenix_request_seats | added (the attacker's own market on the same mints; a seat approved through another market's authority; self-approval; Retired → Approved; eviction with an open order, ForceCancelOrders on both sides, eviction) |
| test_phoenix_orders | added (a bid at 0 ticks refused, at 1 tick placed and cancelled by `!1`; four orders in one transaction; cancels by id, again, and with an unknown id and the bid's inverted sequence number) |
| test_phoenix_cancel_all_orders | covered: "CancelAllOrders 4096/8321: no orders left" (phoenix-cancel.test.ts; upstream builds its four orders but never sends them, so it cancels a registered trader's empty set) |
| test_phoenix_admin | added (fee 5; NameSuccessor and ClaimAuthority by the wrong and right keys; status changes by the old and new authority; trading while Paused; tombstoning with orders and with uncollected fees; EvictSeat while approved, then NotApproved and evicted; CollectFees; tombstoned) |
| test_phoenix_basic | added (81 bids and 110 asks layered 12 a transaction; an IOC sell through five levels; WithdrawFunds; CancelUpTo every bid; a lot deposited and withdrawn) |
| test_phoenix_fees | added (fee 5 accrued by a trade; ChangeFeeRecipient without and with the current recipient; CollectFees to the new recipient, 50,000 atoms; ChangeFeeRecipient with nothing uncollected) |
| test_phoenix_cancel_with_free_funds | added (a bid on free funds; CancelAllOrdersWithFreeFunds; two bids and CancelMultipleOrdersByIdWithFreeFunds of `!2` in one transaction; a bid and CancelUpToWithFreeFunds in one transaction) |
| test_phoenix_orders_with_free_funds | added (SwapWithFreeFunds without a seat; trades through 10 levels and DecrementTake self trades; free-funds orders short and funded; free lots paying first for token orders; each packet through the wrong instruction) |
| test_phoenix_place_multiple_limit_orders | added (five accounts only; free-funds packets short of base and of quote; crossing itself two ways; crossing the book; free lots first; 21 orders a side in the 766-byte packet) |
| test_phoenix_log_authorization | covered: "Log: another signer", "Log: the log authority, not signing" (phoenix.test.ts). Its third assertion (the log authority PDA signing outside the program) fails in the client, which cannot sign for a PDA; no instruction reaches the program there or here. |
| test_phoenix_cancel_all_memory_management | covered: "CancelAllOrders 4096/8321: 512 orders" (phoenix-cancel.test.ts: one trader's orders on both books cancelled by the plain form with 1,400,000 units; upstream's 401, layered by Limit orders) |
| test_phoenix_place_multiple_memory_management | added (21 orders a side, then an IOC sell of `u64::MAX` lots at price 0) |
| test_phoenix_place_multiple_limit_orders_adversarial | added (136 transactions of 30 one-lot bids and 30 one-lot asks at one price each, coalesced, with upstream's self-transfer; an IOC buy of 700 lots) |
| test_phoenix_basic_with_raw_base_unit_adjustment | added (1,000 raw base units a base unit, 5 decimals; the maker's extra tokens; four orders in one transaction; an IOC sell through both bids; WithdrawFunds) |
| test_phoenix_place_order_quiet_failure | added (fail-silent Limit asks and bids beyond the tokens, with deposits and free-funds orders in one transaction; the same order failing without the flag) |
| test_phoenix_multiple_orders_fail_silently_basic | added (FailOnInsufficientFunds fails; SkipOnInsufficientFunds rests 9 bids and 9 asks) |
| test_phoenix_multiple_orders_crossing_order_input | covered: "512: multi crossing input", "4096: multi crossing input" (phoenix-orders.test.ts: a packet whose own bids and asks cross is refused before any behavior applies) |
| test_phoenix_multiple_orders_crossing_existing_book_ignore_crossing_bid | added |
| test_phoenix_multiple_orders_crossing_existing_book_amend_bid | added (11 bids and 11 asks rest after the amendment) |
| test_phoenix_multiple_orders_crossing_existing_book_ignore_crossing_ask | added |
| test_phoenix_multiple_orders_crossing_existing_book_amend_ask | added (11 bids and 11 asks rest after the amendment) |

## src/state/markets/test_market.rs

| Upstream test | Here |
| --- | --- |
| test_market_simple | added (10 seeded makers layering about 1,200 Limit orders; IOCs at the best levels, one crossing nothing, one through five levels but a lot; withdrawals; each maker's bids cancelled by CancelUpTo or by id at random; asks cancelled; seats retired and evicted; both books empty) |
| test_post_only_default | added (a PostOnly crossing the trader's own order at the same price refused on both sides) |
| test_post_only_rejection | added (rejected and amended PostOnly orders; on an empty book an ask at 1 tick; a bid amended below 1 tick and a bid at 0 refused) |
| test_cancel_all | covered: "CancelAllOrders 512/128: 96 orders", "CancelAllOrders 4096/8321: 96 orders" (phoenix-cancel.test.ts: one trader's bids and asks, the plain form) |
| test_limit_orders_with_self_trade | added |
| test_limit_orders_with_free_lots | added (15 orders whose fills and self trades free lots that later orders spend) |
| test_orders_with_only_free_funds | added |
| test_fok_and_ioc_limit_1 | added |
| test_fok_and_ioc_limit_2 | added |
| test_fok_and_ioc_limit_3 | added (a quote budget a lot above three levels) |
| test_fok_and_ioc_limit_4 | added |
| test_fok_and_ioc_limit_5 | added (IOCs expired by slot and by timestamp at slot 1,000, second 1,000; within both limits; base and quote budgets both given) |
| test_fok_and_ioc_with_free_funds | added (the taker's free lots deposited; see Adaptations) |
| test_fok_with_slippage_1 | added (a quote budget with a minimum of base lots, the minimum computed in f64 as there; 5 bps) |
| test_fok_with_slippage_2 | added |
| test_fok_with_slippage_3 | added (a base budget with a minimum of quote lots) |
| test_sell_with_quote_lot_budget | added |
| test_fees_basic | added (fees on a buy and a sell, then CollectFees) |
| test_evict_order | covered: "full 512: a better bid evicts the lowest", "full 512: a bid at the lowest price is refused", "full 512: a better ask evicts the highest", "full 512: a worse ask is refused" and the same at 4096 (phoenix-orders.test.ts; the evicted trader's freed lots are in the compared bytes) |
| test_reduce_order | covered: "ReduceOrder 4096/8321: part of a bid", "ReduceOrder 4096/8321: another trader's order", "ReduceOrder 4096/8321: an order that is not there", "ReduceOrder 4096/8321: the rest of the bid (size above it)" (phoenix-cancel.test.ts) |
| test_tif | added (a PostOnly bid with a last valid timestamp, then one with a last valid slot: placed when already expired (nothing rests), placed, filled half way and exactly at the last valid slot or second, expired one past it) |
| test_limit_order_crossing | covered: "512: Limit bid, match limit 1, still crossing" (phoenix-orders.test.ts: a Limit order whose match limit leaves it crossing does not rest) |

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
