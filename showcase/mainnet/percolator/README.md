# Percolator v12.20, ported to TypeSOL

> **The original's warning stands for this port: an educational research project, not audited. Do not use it with
> real funds.** (Percolator's engine: "Educational research project. Not production ready. Not audited. Do not use with
> real funds." Its program: "FOR EDUCATIONAL PURPOSES ONLY … NOT been audited. Do NOT use in production or with real
> funds.")

A port of Percolator v12.20, Anatoly Yakovenko's perpetual-futures risk engine and the native Solana program around
it, licensed under the Apache License 2.0 (Copyright Anatoly Yakovenko; see NOTICE). It targets one immutable build:

| | |
| --- | --- |
| Program | `BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw` on mainnet, upgrade authority burned, deployed in slot 414,977,364 |
| Sources | aeyakovenko/percolator-prog `06f86fb` (`src/percolator.rs`) and the engine aeyakovenko/percolator `3f55f87` (`src/percolator.rs`, `src/wide_math.rs`, `src/i128.rs`) |
| Binary | 395,368 bytes, sha256 `502088e9cf5e1b38cccd31bbab2df18d4958712fb9456d48669241aaddf4cc93` |
| Toolchain | native `solana-program 1.18` `entrypoint!`, release build without overflow checks (the binary holds no "attempt to add with overflow" message), rustc 1.73 or later (its panic lines) |

This is v12.20, not the current Percolator: v16 (November 2026) is a different and much larger design (about 43k lines,
50 instructions, portfolios of up to 14 legs across thousands of assets).

## How the facts above were checked

- The binary: `scripts/fetch-programs.sh` dumps the program data from mainnet (`test/programs/percolator_v12.so`, not
  cut: the program data is exactly the build's 395,368 bytes). Its sha256 is the one the author's deploy manifest
  (aeyakovenko/percolator-cli `mainnet-market.json`) records together with the program commit
  `06f86fb125525af81c0bfd19a295095dda102c07` and the engine commit `3f55f871a3aa29d7b582fc2641d2106cbac0c32e`;
  `solana program show` gives the data length 395,368 and authority none. The binary was not rebuilt from source here.
- The sources: read at those two commits (`git archive` of each, compared byte for byte with the files the scope
  research had collected).
- The slab layout: read from slabs the mainnet binary itself initialised and changed in LiteSVM
  (`showcase/test/percolator-layout.test.ts`), not derived from the Rust source. The binary logs the length it wants
  (`sol_log_64(SLAB_LEN, len, …)`): 1,525,624 bytes.

Figures that are easy to get wrong from the source alone:

- The slab is header 136 + **config 400** (not 384) + engine 1,492,160 (at byte 536) + risk buffer 160 + generation
  table 32,768 = 1,525,624, the length the binary logs. The config's fields add up to 400 bytes with no implicit
  padding (its padding is explicit fields), and every u128 / i128 of the slab is aligned to 8, as on SBF.
- `src/percolator.rs` of the program has no tests: all 8,499 lines are program code. Line 2,923 is the `#[cfg(kani)]`
  stub of `cluster_restarted_since_init`, not the start of a test module.
- The binary was built without overflow checks: plain `+ - *` wrap in the original (the port's checked operators are
  only used where the original's own checks make wrapping impossible; see engine.ts).

## The 27 instructions

Tags as `Instruction::decode` reads them (tags 11, 12, 15, 16, 22 and 24 were deleted upstream; they decode as
InvalidInstructionData). Accounts in order; "anyone" means no signer is checked.

| Tag | Instruction | Accounts | Who may call | Port |
| ---: | --- | --- | --- | --- |
| 0 | InitMarket | admin (signer), slab (w), mint, vault (w), token program, clock, rent, oracle, system | anyone (becomes admin) | **ported** |
| 1 | InitUser | user (signer), slab (w), user ATA (w), vault (w), token program, clock | anyone | **ported** |
| 2 | InitLP | as InitUser | anyone | **ported** |
| 3 | DepositCollateral | as InitUser | account owner | **ported** |
| 4 | WithdrawCollateral | user (signer), slab (w), vault (w), user ATA (w), vault PDA, token program, clock, oracle | account owner | **ported** |
| 5 | KeeperCrank | caller (signer unless permissionless), slab (w), clock, oracle | anyone (`caller_idx` 0xffff), or an account owner | **ported** |
| 6 | TradeNoCpi | user (signer), LP (signer), slab (w), clock, oracle | both owners | **ported** |
| 7 | LiquidateAtOracle | caller (not checked), slab (w), clock, oracle | anyone | **ported** |
| 8 | CloseAccount | as WithdrawCollateral | account owner | **ported** (live and resolved markets) |
| 9 | TopUpInsurance | as InitUser | anyone | **ported** |
| 10 | TradeCpi | user (signer), LP owner, slab (w), clock, oracle, matcher program, matcher context (w), LP PDA, tail… | user; the LP through its matcher | **ported** |
| 13 | CloseSlab | admin (signer), slab (w), vault (w), vault PDA, admin ATA (w), token program | admin, resolved market | **ported** |
| 14 | UpdateConfig | admin (signer), slab (w), clock, oracle | admin | **ported** |
| 17 | PushHyperpMark | Hyperp authority (signer), slab (w) | Hyperp authority | **ported** |
| 18 | SetOraclePriceCap | admin (signer), slab (w), clock | admin | **ported** |
| 19 | ResolveMarket | admin (signer), slab (w), clock, oracle | admin | **ported** |
| 20 | WithdrawInsurance | insurance authority (signer), slab (w), ATA (w), vault (w), token program, vault PDA | insurance authority, resolved, every account closed | **ported** |
| 21 | AdminForceCloseAccount | admin (signer), slab (w), vault (w), owner ATA (w), vault PDA, token program, clock, (oracle, unread) | admin, resolved | **ported** |
| 23 | WithdrawInsuranceLimited | insurance operator (signer), slab (w), ATA (w), vault (w), token program, vault PDA, clock | insurance operator, live | **ported** |
| 25 | ReclaimEmptyAccount | slab (w), clock | anyone | **ported** |
| 26 | SettleAccount | slab (w), clock, oracle | anyone | **ported** |
| 27 | DepositFeeCredits | as InitUser | account owner | **ported** |
| 28 | ConvertReleasedPnl | user (signer), slab (w), clock, oracle | account owner | **ported** |
| 29 | ResolvePermissionless | slab (w), clock | anyone, past the hard timeout | **ported** |
| 30 | ForceCloseResolved | slab (w), vault (w), owner ATA (w), vault PDA, token program, clock, (oracle, unread) | anyone, after the delay | **ported** |
| 31 | CatchupAccrue | slab (w), clock, oracle | anyone | **ported** |
| 32 | UpdateAuthority | current authority (signer), new authority (signer unless burning), slab (w) | the current holder of that kind | **ported** |

## Status

**All 27 instructions are ported**, each compared with the mainnet binary on its success paths and on every refusal
the tests can reach (the ones they cannot reach are listed under "What is not verified"). The packages, in order:

1. The slab, the engine core and 15 instructions: InitMarket, InitUser, InitLP, DepositCollateral, WithdrawCollateral,
   CloseAccount on live markets, TopUpInsurance, CloseSlab, UpdateConfig, PushHyperpMark, SetOraclePriceCap,
   ReclaimEmptyAccount, SettleAccount, DepositFeeCredits, UpdateAuthority; the slab layout byte for byte, the wide
   arithmetic (wide.ts), the error enum and its mapping, the oracle readers (Pyth, Chainlink, Hyperp), and the engine's
   slot management, PnL and reserve bookkeeping, two-bucket warm-up, live touch and finalize, market accrual (K and F),
   maintenance fees, end-of-instruction resets.
2. Trading: TradeNoCpi, TradeCpi (with its matcher call), ConvertReleasedPnl; `execute_trade_not_atomic`.
3. Liquidation and the crank: KeeperCrank, LiquidateAtOracle, CatchupAccrue; `liquidate_at_oracle_not_atomic` /
   `_internal` (the full close and the crank's exact partial, the liquidation fee, bad debt), `enqueue_adl` (insurance
   first, then ceil(D_rem · A · POS_SCALE / OI) into the opposite side's K, A shrunk by OI_post / OI with its
   phantom-dust bound, drain-only below MIN_A_SIDE, side resets with stale accounts settled at the frozen K and F),
   `keeper_crank_not_atomic` with `validate_keeper_hint`, the fee sweep (`sweep_maintenance_fees`, 128 syncs from the
   bitmap cursor, the reclaim of drained accounts), the crank reward, the risk buffer's upkeep, complete and partial
   catch-ups.
4. Resolution and the end of a market: ResolveMarket, ResolvePermissionless, ForceCloseResolved,
   AdminForceCloseAccount, CloseAccount's resolved arm, WithdrawInsurance, WithdrawInsuranceLimited:
   - `resolve_market_not_atomic`: the ordinary arm (accrued to now with the live price and the captured funding rate,
     then the deviation band |resolved - P_last| · 10,000 <= resolve_price_deviation_bps · P_last) and the degenerate
     arm (P_last, rate 0, no accrual); the terminal K deltas A_side · (resolved - live), 0 for a side already mid-reset,
     kept apart from K; every side with positions begins a reset (all positions stale under a new epoch), an empty one
     reopens at once; OI zeroed; all positive PnL matured;
   - ResolveMarket's choice of arm as the program makes it: past the hard timeout the degenerate arm at P_last (and
     ResolvePermissionless the same, by anyone); a fresh external price (an observation no newer than the last stands
     for the stored price) or, on a Hyperp market, the index flushed toward the mark, the ordinary arm with its
     catch-up first; a stale or too-wide oracle, or a Hyperp mark silent for more than 3 · max_staleness_secs slots,
     the degenerate arm; the Hyperp settlement price is the mark EWMA;
   - `force_close_resolved_not_atomic`: `reconcile_resolved_not_atomic` (the stale position settled at
     K_epoch_start + the terminal delta and F_epoch_start, losses paid from capital, a flat loss past it absorbed by
     insurance, reserve buckets cleared), the sides that are ready finalized, then ProgressOnly for a winner while the
     market is not terminal-ready (positions, stale accounts or negative PnL left) or
     `close_resolved_terminal_not_atomic`: the payout snapshot min(residual, matured) / matured taken by the first
     winner's close, the PnL paid at it, fee debt swept from capital and the rest forgiven, the capital paid out, the
     slot freed, the market's surplus swept into insurance once it is empty;
   - the fee sync to resolved_slot before each resolved close; ForceCloseResolved's delay; the owner's token account
     checked only for a payout;
   - WithdrawInsurance: every account closed, then the insurance balance, or the whole vault (the rounding residue
     folded in) when every aggregate is zero; WithdrawInsuranceLimited on live markets: at most max(insurance ·
     max_bps / 10,000, 10 units), at most the balance, once per cooldown.

Every live instruction refuses a resolved market (InvalidAccountData), KeeperCrank does nothing on one, UpdateAuthority
may still transfer or burn (an admin burn with accounts left needs a force-close delay), and CloseSlab needs it.

The engine's `garbage_collect_dust` is not ported: v12.20's program never calls it (the crank's `num_gc_closed` is
always 0); the fee sweep's reclaim is what frees dust there.

The author's own test suite runs against the TypeSOL binary with the same outcome, test by test, as against the
mainnet binary (below).

## Files

| File | Ports |
| --- | --- |
| `percolator.ts` | the entrypoint and `Instruction::decode`'s length rules |
| `market.ts` | InitMarket, CloseSlab, UpdateConfig, PushHyperpMark, SetOraclePriceCap, `handle_update_authority` |
| `users.ts` | InitUser, InitLP, DepositCollateral, WithdrawCollateral, CloseAccount, TopUpInsurance, ReclaimEmptyAccount, SettleAccount, DepositFeeCredits, ConvertReleasedPnl |
| `crank.ts` | KeeperCrank (the decode of its candidates, the fee syncs and `sweep_maintenance_fees`, the reward, the risk buffer's upkeep), LiquidateAtOracle, CatchupAccrue |
| `resolve.ts` | ResolveMarket, ResolvePermissionless, ForceCloseResolved, AdminForceCloseAccount, WithdrawInsurance, WithdrawInsuranceLimited, and the resolved close CloseAccount shares |
| `trade.ts` | TradeNoCpi, TradeCpi (before and after the matcher call, which `percolator.ts` makes: TypeSOL forwards the tail of accounts into a CPI only from the instruction itself), `execute_trade_with_matcher`, `mod matcher_abi`, the mark EWMA after a fill, the risk buffer after a trade |
| `matcher/matcher.ts` | not part of the program: a test fixture, aeyakovenko/percolator-match 199b139 (the matcher ABI v2; the Passive and vAMM kinds), which the TradeCpi tests run beside both programs (below) |
| `engine.ts` | the risk engine (percolator `src/percolator.rs`): everything the program calls, resolution and the resolved closes included |
| `wide.ts` | `src/wide_math.rs`: U256 / I256 / U512 as exact u256 arithmetic with the original's range checks and panics |
| `oracle.ts` | `mod oracle` and the price helpers of `mod verify`: Pyth PriceUpdateV2, Chainlink OCR2, Hyperp, the circuit breaker, the EWMA, the funding rate |
| `program.ts` | the shared processor helpers: slab_guard, the SPL Token checks, the clock, catch-up accrual, fee syncs, the risk buffer |
| `state.ts` | the slab layout (`SlabHeader`, `MarketConfig`, `RiskEngine`, `Account`, `RiskBuffer`) |
| `errors.ts` | `PercolatorError`, RiskError's mapping |
| `wire.ts` | signed integers of the instruction data |

## How it is checked

The original and the port run in two LiteSVMs under the program's id with the same clock; every account is written
the same way in both (`showcase/test/percolator-helpers.ts`). Each transaction goes to both, and the outcome, the
error code, every log line (the compute-unit lines excepted), the inner instructions, the return data and the bytes of
every account the transaction names (the 1.5 MB slab included) must be the same. Positions, PnL, reserves, funding,
fee debt, liquidations, bad debt, the loss socialised over a side, drain-only and reset-pending sides, stale accounts
and a flat account with a loss past its capital all come from real instructions, and so do resolved markets (by the
admin and permissionless), the resolved closes, the payout haircut, the insurance withdrawals and the stranded tokens
CloseSlab drains (an SPL Token transfer into the vault). State no instruction can make is written into both slabs the
same way, and each test says where: a position basis whose arithmetic overflows (for the panic line), the TradeCpi
request nonce at u64::MAX, corrupt enum tags and a TradeCpi in progress (for the slab checks), a resolved market whose
resolved price is 0 (KeeperCrank's refusal of it: resolution refuses a zero price) and a Hyperp mark EWMA of 0
(UpdateAuthority's refusal to burn the Hyperp authority before the EWMA: InitMarket seeds it with the initial mark and
no update brings it back to 0), per-side position counts and caps of 2^63 and more (the i64 arithmetic of the trade's
position cap) and a free-list head past the 4,096 slots (a difference, pinned: below). Some tests sign with the slab's
own keypair, as whoever created the slab account can, to pass the slab again as the user, the admin or the vault
authority (below).

Compute units: `both()` fails any transaction that succeeds under both programs, has a top-level instruction of the
program (identified by program id) and does not cost the port fewer units than the original. That covers every
Percolator instruction in every test file; the transactions it exempts are those with no Percolator instruction at the
top level (the matcher's own Init, an SPL Token transfer), the same program on both sides. KeeperCrank's compute-unit
test goes through the same comparison wherever the two outcomes match.

**The matcher.** TradeCpi calls the LP's matcher program. No build of the author's matcher is deployed for v12.20 (the
deploy manifest says "NOT DEPLOYED — third parties provision their own"; the author's devnet markets name matcher
programs whose builds are not identified, so none was used), so the tests build `matcher/matcher.ts`, a TypeSOL port
of aeyakovenko/percolator-match 199b139, and run that same matcher beside both the original and the port: the matcher
itself is not compared with any binary. Answers the real matcher never gives (a wrong ABI version, unknown flags,
wrong echoes, sizes and prices out of bounds) come from `showcase/test/fixtures/percolator-rogue-matcher.ts`, which
writes what its context account says.

| Test | What it covers |
| --- | --- |
| `percolator-layout.test.ts` | the slab layout, read from slabs the mainnet binary initialised (every header, config and engine field, an account, the generation table) |
| `percolator.test.ts` | InitMarket in 14 shapes (Pyth, inverted, scaled, Hyperp, fees, funding), 22 oracle readings at init, Chainlink feeds, every InitMarket refusal in order; InitUser, InitLP, deposits, top-ups, the TVL cap, the unit scale, fee credits, and the shared refusals of the five token instructions (accounts, signer, writability, token program, slab owner and length, uninitialized, vault and token-account checks, clock, corrupt enum tags, CPI in progress, matured staleness, a resolved market) |
| `percolator-accounts.test.ts` | withdraw and close (oracle errors, price clamp, unit scale), positions from trades with mark-to-market, warm-up buckets, margin and funding, losses past capital absorbed by insurance, released-PnL conversion, the close refused while profit warms, maintenance fees and fee debt, a Hyperp market, a panic line, a free-list head past the slots (pinned difference) |
| `percolator-admin.test.ts` | UpdateConfig (ordinary and degenerate arms, accrual with funding from traded positions), SetOraclePriceCap, PushHyperpMark, UpdateAuthority (all kinds, burns, consent), CloseSlab (live, insurance left, stranded tokens, an empty vault); the slab passed again where the original holds its borrow across a CPI (below) |
| `percolator-trade.test.ts` | TradeNoCpi: fills, flips, closes, fees, the EWMA, the risk buffer past four entries, and every refusal (accounts, signers, owners, sizes, self-trade, margin, the flat-close guard, oracle staleness, the hard timeout, the circuit breaker, Hyperp, a drain-only side, a resolved market); per-side position counts and caps past i64 (a patched slab). TradeCpi through the Passive and vAMM matcher (partial, inventory-capped and zero fills, the limit on normal and inverted markets, Hyperp marks and zero fills) and every refusal of its accounts, the LP binding and the answer; the slab as the matcher sees it during the call (below). ConvertReleasedPnl: warm-up, partial and whole conversions, the haircut, the flat-account cap, refusals |
| `percolator-liquidate.test.ts` | LiquidateAtOracle: healthy and flat accounts (nothing), full closes within the capital and past it (bad debt paid by insurance), past insurance (the loss written into the shorts' K, A shrunk, the dust bound), a second liquidation emptying the longs (the shorts reset, stale; a reset-pending side refusing new shorts; a stale account settling a loss past its capital, absorbed; the last stale account settled inside a trade, the side reopening), drain-only (A below MIN_A_SIDE, refusals, the side emptied and reset), maintenance fees synced first, a Hyperp market, every refusal; CatchupAccrue: nothing to do, funding past the envelope (CatchupRequired for Settle, Liquidate and the crank), partial and complete catch-ups, refusals |
| `percolator-crank.test.ts` | KeeperCrank: permissionless and self cranks, every refusal (accounts, signer, owner, the data's format, tags, leftovers, 128 and 129 candidates, the slab checks for all three keeper instructions, the oracle, resolved with and without a price), liquidations from the risk buffer and from hints (FullClose, a valid and a too-small partial, touch only, missing slots, duplicates), the 64-attempt budget, 150 accounts cranked over many slots (the sweep cursor stopping inside a word, dust accounts reclaimed, the keeper's reward, funding, warm-up maturing), fee debt left by the sweep on an open position |
| `percolator-resolve.test.ts` | ResolveMarket: every refusal (accounts, signer, admin, oracle owner and feed, slab checks, already resolved, the burned admin), the ordinary arm at a fresh price, an observation no newer than the last, the catch-up inline and CatchupRequired past 20 envelopes, the degenerate arm for a stale and a too-wide oracle and past the hard timeout, Hyperp at the mark (a terminal delta), past the deviation band, with a silent mark (degenerate). ResolvePermissionless: early, a slot short, turned off, then by anyone; after a cluster restart (LiteSVM's LastRestartSlot moved past the one InitMarket recorded) the market frozen and resolvable by anyone with staleness turned off. The close-out: winners reconciled only (ProgressOnly by each of the three closes) until the losers are gone, a loss past insurance and the payout haircut below 1, pending warm-up buckets cleared, fee debt forgiven, LPs, a side drain-only and a side mid-reset (stale accounts, no terminal delta) at resolution; every refusal of the three closes (delay, no delay configured, accounts, vault, PDA, owner, token accounts, free slots). Every live instruction on a resolved market, the crank's nothing, UpdateAuthority's transfer and burns there. WithdrawInsuranceLimited (the bps cap, the 10-unit floor, the cooldown over time, another operator, dust, the hard timeout, resolved) and WithdrawInsurance (accounts left, another authority, the terminal surplus); the teardown to CloseSlab with stranded tokens; fewer compute units than the original on every successful transaction |
| `percolator-crank-cu.test.ts` | KeeperCrank's compute units at 2 to 4,096 accounts (below), under the default 200,000 and the 1.4M limits; every crank whose outcome is the same under both compared as `both()` compares |
| `percolator-fuzz.test.ts` | two seeded random walks, each ending in the end of the market. The account walk: markets of random shape (fees, margins, warm-up bounds, caps, Pyth or Hyperp, with or without permissionless resolution, with or without bounded insurance withdrawals) and sequences of opens (users, LPs bound to the matcher or not), deposits, withdrawals, closes, settles, reclaims, top-ups, fee payments, trades (TradeNoCpi and TradeCpi, random or near the margin), conversions, config updates, liquidations, cranks with random candidates and hints, catch-ups, price moves (crashes and spikes included) and clock moves (past the accrual envelope where nothing resolves the market). The liquidation walk: leveraged traders against a few counterparties with little insurance, and leveraged trades, price moves up to crashes, liquidations, cranks, catch-ups, settlements, deposits, withdrawals, conversions, new accounts, closes and top-ups. Then the end (`endOfLife`): bounded insurance withdrawals, resolution by the admin (the oracle moved, older, stale or too wide; catch-ups and retries where the original refuses) or permissionless after the hard timeout (an early try first), the three resolved closes in random order (before and after the delay), insurance withdrawals and CloseSlab tried too early, live instructions refused, cranks; every account closed out, WithdrawInsurance, CloseSlab, and the vault, the slab and every token account compared once more. 6 seeds of each by default. The oracle walk: the account walk, from four opened accounts, on markets of one oracle shape each (a Chainlink OCR2 feed with 8, 9 or 18 decimals; an inverted Pyth market; a Pyth feed at exponent -8, -10 or -5 with its confidence exactly at the market's limit of 50, 200 or 500 bps, one past it for a wide reading; a Hyperp market), each to its end, each with at least one successful trade and crank; 2 seeds of each shape by default (`PERCOLATOR_ORACLE_RUNS`, `PERCOLATOR_ORACLE_STEPS`). `PERCOLATOR_FUZZ_VERBOSE=1` prints what a run reached, how often each ADL event occurred and how many full life cycles ran, by market shape (below) |
| `test/language/native-log64-zero.test.ts`, `remaining-executable.test.ts` | the compiler additions this port needed, with their lines checked against the binary's |

## Compute units and size

| | Original | Port |
| --- | ---: | ---: |
| Binary | 395,368 bytes | 360,248 bytes (SBPF v0) |

Successful transactions, mean / largest: those of the two fuzz walks with their ends (the account walk 40 seeds × 400
steps, the liquidation walk 40 seeds × 600 steps, 80 full life cycles), and for UpdateAuthority, which they do not
send, those of percolator-admin.test.ts. Every instruction is in the table.

| Instruction | Transactions | Original | Port |
| --- | ---: | ---: | ---: |
| InitMarket | 80 | 237,575 / 248,070 | 232,720 / 235,031 |
| InitUser | 1,445 | 6,926 / 7,225 | 2,917 / 3,250 |
| InitLP | 230 | 7,071 / 7,301 | 3,016 / 3,272 |
| DepositCollateral | 1,314 | 6,792 / 7,821 | 2,725 / 3,498 |
| WithdrawCollateral | 786 | 14,475 / 45,269 | 6,403 / 16,194 |
| KeeperCrank | 4,324 | 52,853 / 387,752 | 29,294 / 213,966 |
| TradeNoCpi | 1,790 | 27,367 / 88,586 | 14,379 / 33,927 |
| LiquidateAtOracle | 2,310 | 10,441 / 66,218 | 5,537 / 19,302 |
| CloseAccount (live and resolved) | 883 | 9,808 / 28,989 | 4,445 / 10,422 |
| TopUpInsurance | 1,383 | 6,387 / 6,450 | 2,381 / 2,420 |
| TradeCpi | 83 | 21,531 / 44,910 | 13,563 / 24,957 |
| CloseSlab | 80 | 12,270 / 12,270 | 8,362 / 8,362 |
| UpdateConfig | 433 | 3,024 / 9,318 | 1,360 / 3,315 |
| PushHyperpMark | 774 | 3,177 / 9,269 | 2,796 / 4,539 |
| SetOraclePriceCap | 601 | 1,934 / 8,484 | 1,696 / 4,146 |
| ResolveMarket | 58 | 4,490 / 27,650 | 1,918 / 8,937 |
| WithdrawInsurance | 92 | 6,056 / 6,404 | 2,085 / 2,299 |
| AdminForceCloseAccount | 423 | 9,139 / 22,995 | 3,631 / 8,866 |
| WithdrawInsuranceLimited | 31 | 7,062 / 7,085 | 2,606 / 2,660 |
| ReclaimEmptyAccount | 90 | 1,526 / 2,298 | 727 / 1,170 |
| SettleAccount | 1,133 | 5,794 / 22,438 | 3,689 / 10,015 |
| DepositFeeCredits | 6 | 7,030 / 7,517 | 2,795 / 3,065 |
| ConvertReleasedPnl | 241 | 20,188 / 35,488 | 8,707 / 12,680 |
| ResolvePermissionless | 22 | 1,617 / 1,632 | 791 / 805 |
| ForceCloseResolved | 208 | 10,135 / 26,722 | 3,864 / 9,811 |
| CatchupAccrue | 1,405 | 4,373 / 75,542 | 1,812 / 33,637 |
| UpdateAuthority | 7 | 1,496 / 1,697 | 439 / 589 |

TradeCpi's figures include the matcher's call (about 1,000 units, the same TypeSOL matcher under both). Every test
asserts the rule through `both()` (see "How it is checked"): a successful transaction with a Percolator instruction at
the top level fails the test unless the port used fewer units than the original, in every test file, the fuzz walks
included; the matcher's own Init and SPL Token transfers, which carry no Percolator instruction, are the only
transactions exempt. `PERCOLATOR_CU=1` prints these tables, `PERCOLATOR_TRACE=1` each compared transaction's outcome
and units.

**KeeperCrank by account count** (percolator-crank-cu.test.ts; N - 1 traders long against one LP, a maintenance fee of
1 per slot, every account touched by a fee sync; the liquidation batches after a 10% fall, each batch on traders not
liquidated yet and preceded by the risk buffer's four entries with FullClose):

| Accounts | Crank | Limit | Original | Port |
| ---: | --- | ---: | ---: | ---: |
| 2 | no candidates (the fee sweep) | 200,000 | 23,510 | 13,756 |
| 2 | 1 candidate, touch only | 200,000 | 27,543 | 16,612 |
| 2 | 1 candidate, FullClose | 1.4M | 26,640 | 14,364 |
| 17 | no candidates | 200,000 | 67,040 | 33,963 |
| 17 | 16 candidates, touch only | 200,000 | 152,756 | 89,371 |
| 17 | 4 candidates, FullClose | 1.4M | 258,281 | 81,874 |
| 17 | 4 candidates, FullClose (a market of its own) | 200,000 | exceeds | 81,724 |
| 65 | no candidates | 200,000 | 120,774 | 61,449 |
| 65 | 64 candidates, touch only | 200,000 | exceeds | exceeds |
| 65 | 64 candidates, touch only | 1.4M | 516,363 | 305,737 |
| 65 | 32 candidates, FullClose | 1.4M | 1,031,712 | 308,922 |
| 257 | no candidates | 200,000 | 166,501 | 88,882 |
| 257 | 64 candidates, touch only | 1.4M | 556,056 | 319,056 |
| 257 | 16 candidates, FullClose | 1.4M | 683,654 | 217,129 |
| 257 | 32 candidates, FullClose | 1.4M | 1,189,473 | 356,343 |
| 257 | 64 candidates, FullClose | 1.4M | exceeds | 622,063 |
| 1,025 | no candidates | 200,000 | 166,494 | 88,882 |
| 1,025 | 64 candidates, touch only | 1.4M | 591,735 | 335,306 |
| 1,025 | 32 candidates, FullClose | 1.4M | 1,276,424 | 394,529 |
| 1,025 | 64 candidates, FullClose | 1.4M | exceeds | 660,077 |
| 4,096 | no candidates | 200,000 | 166,441 | 88,832 |
| 4,096 | 64 candidates, touch only | 1.4M | 591,682 | 335,257 |
| 4,096 | 32 candidates, FullClose | 1.4M | 1,277,097 | 394,446 |
| 4,096 | 64 candidates, FullClose | 1.4M | exceeds | 660,036 |

The port completes every crank the original completes, within the same limit, and some it does not: 64 liquidations
in one crank exceed the original's 1.4M units at every size tried from 257 accounts (the port needs 622,000 to
660,000), and 4 liquidations with the risk buffer's four exceed its default 200,000 units on a 17-account market (the
port needs 82,000). Where the original exceeds its budget the test records both outcomes and stops comparing that
market (the slabs part there). A crank touching 64 accounts exceeds the default limit under both. The sweep's 128 syncs
bound the fee work at about 167,000 units in the original and 89,000 in the port whatever the market's size.
(`PERCOLATOR_CRANK_COUNTS=1,16,64,256,1024,4096 PERCOLATOR_CU=1` reproduces the table; the default counts stop at 257.)

KeeperCrank was above the original at first on cranks with many candidates naming free slots (a fuzz crank of 70
mostly missing candidates: 13,838 against 17,979). The causes were in the port: the candidates were parsed three
times (the decode, the crank loop, the risk buffer's last phase) where the original parses them once into a vector;
three validations of an account's reserve shape on every touch where two cannot fail (the touch validated it and
nothing changed it in between: `admit_outstanding_reserve_on_touch` and `advance_profit_warmup` keep the original's
statements otherwise); a step function called for missing slots too. The handler now checks and parses the candidates
once, at its start (the same errors as the decode, which runs nothing in between), into a list of 128 packed words;
the two loops read that. 128 candidates on free slots: original 15,702, port 12,764.

**ADL in the fuzz** (the liquidation walk, 40 seeds × 600 steps): 535 liquidations (478 in cranks, 57 by
LiquidateAtOracle), a loss written into a side's K past insurance 264 times (in 39 of 40 seeds), A shrunk 333 times
(40 seeds), a side turned drain-only 56 times (39 seeds), 170 side resets begun (25 seeds) and 74 finished, their stale
accounts settled (24 seeds: the full cycle). The account walk (40 × 400) reached each of these too, less often (one
socialised loss, 24 resets begun, 12 finished).

**The ends of the walks** (the same 80 markets): 58 resolved by the admin's ResolveMarket (4 of them refused first,
past a Hyperp deviation band, then retried), 22 by ResolvePermissionless after the hard timeout (17 earlier tries
refused); 4 with a terminal K delta (Hyperp), 99 sides with stale positions at resolution; 389 resolved closes that
only reconciled a winner (ProgressOnly), 110 payouts at a haircut below 1; all 80 reached CloseSlab (2 inside the
random part, the rest after the final close-out) with the vault and every token account the same in both VMs.

**Oracle and market shapes** (the oracle walk, `PERCOLATOR_ORACLE_RUNS=10 PERCOLATOR_ORACLE_STEPS=400`): 40 full life
cycles, 10 on each of a Chainlink feed, an inverted Pyth market, a Pyth feed at exponent -8, -10 or -5 with its
confidence at the market's limit, and a Hyperp market, every one from InitMarket to CloseSlab with the same outcome,
logs and bytes in both programs: 350 successful trades (235 TradeCpi, 115 TradeNoCpi), 1,249 cranks, 33 side resets
begun on each side, losses socialised into K 9 times, sides turned drain-only 12 times. No divergence was found.

**The default run** of all ten test files (`vitest run showcase/test/percolator*`, the default seeds) compares 6,028
transactions through `both()`, 3,896 of them successful under both: 2,317 in the nine files of fixed cases
(`percolator-crank-cu.test.ts` 749, `-crank` 370, `-resolve` 345, `percolator.test.ts` 255, `-trade` 229, `-liquidate`
140, `-accounts` 127, `-admin` 102; `-layout` sends none) and 3,711 in the three random walks of
`percolator-fuzz.test.ts` on their fixed seeds (720 in the account walk, 1,452 in the oracle walk, 1,539 in the walk of
leveraged trades, crashes and liquidations).

## The author's test suite

aeyakovenko/percolator-prog ships its own LiteSVM tests (`tests/*.rs`, Apache-2.0). They load whatever is at
`target/deploy/percolator_prog.so` under a random program id (`Pubkey::new_unique()`), and the TradeCpi tests also
load `../percolator-match/target/deploy/percolator_match.so` under another. They were run unchanged, once with the
mainnet binary there and once with the port, and every test has the same outcome under both.

| | |
| --- | --- |
| Program and its tests | aeyakovenko/percolator-prog `06f86fb125525af81c0bfd19a295095dda102c07` (default features: 4,096 accounts, the mainnet size) |
| Engine (path dependency `../percolator`) | aeyakovenko/percolator `3f55f871a3aa29d7b582fc2641d2106cbac0c32e` |
| Matcher (`../percolator-match`) | the TypeSOL matcher fixture (`matcher/matcher.ts`, a port of aeyakovenko/percolator-match `199b1396`), under both programs: no build of the author's matcher is deployed, and the tests' matcher calls (Init tag 2, 66 bytes; the call tag 0, 67 bytes; the 320-byte context) are the ABI it speaks |
| Original | `test/programs/percolator_v12.so`, sha256 `502088e9…cc93` |
| Port | `showcase/mainnet/percolator/percolator.ts` built by this repository's compiler (360,248 bytes) |
| Harness | the suite's own `Cargo.lock`: litesvm 0.1.0, solana-sdk / solana-program-runtime 1.18.26, spl-token 4.0.0; host build with rustc 1.96.0 (`cargo test`, nothing built for SBF) |

The port has no program id built in: `programId()` is the id the runtime passes, so the vault PDA
(`["vault", slab]`) and the LP PDAs come out under the tests' random ids as they do in the original.

| Test file | Tests | Original: passed / failed / ignored | Port: passed / failed / ignored |
| --- | ---: | ---: | ---: |
| `test_security.rs` | 239 | 234 / 0 / 5 | 234 / 0 / 5 |
| `test_basic.rs` | 134 | 132 / 0 / 2 | 132 / 0 / 2 |
| `test_tradecpi.rs` | 83 | 83 / 0 / 0 | 83 / 0 / 0 |
| `test_resolution.rs` | 47 | 47 / 0 / 0 | 47 / 0 / 0 |
| `test_insurance.rs` | 43 | 42 / 0 / 1 | 42 / 0 / 1 |
| `test_conservation.rs` | 38 | 35 / 0 / 3 | 35 / 0 / 3 |
| `test_admin.rs` | 27 | 27 / 0 / 0 | 27 / 0 / 0 |
| `test_risk_buffer.rs` | 22 | 22 / 0 / 0 | 22 / 0 / 0 |
| `unit.rs` | 14 | 14 / 0 / 0 | 14 / 0 / 0 |
| `test_oracle.rs` | 13 | 13 / 0 / 0 | 13 / 0 / 0 |
| `i128_alignment.rs` | 8 | 8 / 0 / 0 | 8 / 0 / 0 |
| `cu_benchmark.rs` | 2 | 2 / 0 / 0 | 2 / 0 / 0 |
| `src/percolator.rs` (`--lib`) | 1 | 1 / 0 / 0 | 1 / 0 / 0 |
| **Total** | **671** | **660 / 0 / 11** | **660 / 0 / 11** |

(`tests/kani.rs` is `#![cfg(kani)]`: no tests in a normal build.) 609 of the 660 run the program binary; the other 51
test the Rust crates on the host (all of `unit.rs` and the `--lib` test, 7 of `i128_alignment.rs`, 27 of
`test_basic.rs`, 2 of `test_risk_buffer.rs`: they pass with no binary present), so they say nothing about the port
and are counted only because the suite counts them. No test passes on one binary and fails on the other.

**The 11 ignored tests** (`#[ignore]` upstream) were run as well (`-- --ignored`): the same 4 pass under both
(`test_property_state_machine_extended`, the 40,000-operation state machine; `test_attack_engine_vault_spl_vault_consistency`
and `test_attack_withdraw_between_two_cranks`, ignored upstream as exceeding 1.4M units; `test_bug4_fee_overpayment_should_be_handled`)
and the same 7 fail under both, each at the same line with the same message: three on the new-account fee that
engine v12.18.1 removed (`test_init_user_charges_new_account_fee`, `test_attack_init_user_fee_conservation`,
`test_attack_new_account_fee_goes_to_insurance`), `test_attack_trade_risk_increase_when_gated` (a slab offset that
moved in v12.19), `test_attack_withdrawal_with_warmup_settlement` (warm-up semantics of v12.18.1), and two whose
assertions v12.20 does not meet: `test_attack_haircut_all_users_in_loss` ("Vault should be intact after loss
scenario") and `test_binary_market_complete_lifecycle_conservation` ("All accounts should be freed after
AdminForceCloseAccount", noted upstream as needing an engine fix). The only differences in their output are compute
units and signatures.

**Compute units in the author's own benchmark** (`cu_benchmark.rs`, `benchmark_all_instructions -- --nocapture`;
the figures include the SPL Token transfers these instructions make):

| Instruction | Original | Port |
| --- | ---: | ---: |
| TradeNoCpi | 14,033 | 7,765 |
| DepositCollateral | 11,424 | 7,386 |
| WithdrawCollateral | 18,095 | 11,740 |
| KeeperCrank | 42,411 | 27,409 |
| TopUpInsurance | 11,170 | 7,166 |
| UpdateConfig | 3,619 | 1,921 |
| SetOraclePriceCap | 2,507 | 2,046 |
| LiquidateAtOracle | 12,226 | 7,216 |
| CloseAccount | 14,397 | 9,727 |
| UpdateAuthority (admin) | 1,686 | 690 |
| ResolveMarket | 4,048 | 2,183 |
| KeeperCrank (resolved) | 6,274 | 4,764 |
| AdminForceCloseAccount | 12,218 | 8,018 |
| WithdrawInsurance | 11,108 | 7,015 |
| CloseSlab | 15,370 | 11,463 |

**To reproduce.** Check out the three repositories side by side at the commits above (`<dir>/percolator-prog`,
`<dir>/percolator`, `<dir>/percolator-match`), fetch the mainnet binary (`scripts/fetch-programs.sh`), then:

```sh
(cd <dir>/percolator-prog && cargo fetch --locked)   # the crates; the script itself downloads nothing
pnpm build                                          # the compiler, for the port and the matcher fixture
scripts/percolator-author-suite.sh <dir>            # original, then port; compares every test's outcome
```

The script builds the matcher fixture and the port into a temporary directory, copies each program to
`target/deploy/percolator_prog.so` in turn, runs every test file one at a time (`cargo test --locked --offline -j 2
--test <file> -- --test-threads=2`), keeps each run's logs in `<dir>/results-original/` and `<dir>/results-port/`,
and fails if a test file does not build or run, if a test fails, if the totals are not those recorded in the script for
the pinned commits (671 tests: 660 passed, 0 failed, 11 ignored), if the two runs list different test names, or if
any test's outcome differs. A whole run takes about 6 minutes per binary on a laptop, most of it
`cu_benchmark.rs`'s worst-case crank scenarios. The ignored tests: `cargo test --locked --offline -j 2 --test <file> --
--ignored --test-threads=2` with either binary in place.

## Differences from the original

- **InitMarket's account canonicalization** writes one canonical 360-byte account into each of the 4,096 slots (a
  copy) where the original sets each field; the fields end the same, and so do the padding bytes, because InitMarket
  zeroes the whole slab first (the original's `init_in_place` would leave padding as it found it on unzeroed memory,
  which no caller gives it).
- **TradeCpi's matcher call** is made by the entrypoint between two halves of the handler (TypeSOL forwards the
  remaining accounts into a CPI only from the instruction itself); the statements run in the original's order.
- **Reentrancy**: a matcher that calls back into Percolator is stopped by the runtime (ReentrancyNotAllowed) under both
  programs before Percolator's own FLAG_CPI_IN_PROGRESS check could run, so no test reaches that check. What the
  matcher sees is compared: given the slab in its tail (writable or read-only; both programs pass it), the test matcher
  logs during the call the flags byte, the request nonce, the slab's length, fingerprints of the header, the config, the
  engine before its accounts and the LP's entry, and the config's 400 bytes word by word, on a Pyth and a Hyperp market,
  a fill, a zero fill and a refused answer; `both()` compares those lines, and the test checks that the flag is set,
  the nonce not yet advanced and the config still the one from before the price read (the original writes its copy back
  only after the call). The flag cleared after the call is in the slab bytes compared after every TradeCpi.
- **The slab passed again where the original holds its borrow**: the original keeps `slab.try_borrow_mut_data()` across
  the SPL Token calls of InitUser, InitLP, DepositCollateral, TopUpInsurance and CloseSlab, and solana-program's
  `invoke` borrows every account it passes first, so the slab named again in that call fails it with
  AccountBorrowFailed: the user signing with the slab's keypair (the four deposits), an admin who is the slab (CloseSlab's
  rent destination) or the slab as CloseSlab's vault authority when nothing is drained (that key is checked only before
  a drain). TypeSOL has no borrow flags, so the port checks those keys explicitly at the same point and returns the same
  error (`depositCollateralHeld` in program.ts, CloseSlab in market.ts); percolator-admin.test.ts compares each case.
  Every other aliasing of the slab (a token account, the vault, the vault PDA, the clock, the oracle, the matcher
  context) is refused first by an owner or key check in both; the slab in TradeCpi's tail is passed by both (the
  original drops its borrow before the call).
- **The config in place**: see "Compute units" (the same bytes; fewer copies).
- **`LastRestartSlot::get()`**: the original treats a failing syscall as slot 0 (`unwrap_or(0)`, `Err(_) => false`);
  the port's `lastRestartSlot()` fails the instruction (5103) instead. The sysvar is available on mainnet and in LiteSVM,
  where the two agree (percolator-resolve.test.ts moves it).
- **Panic locations** of panics the tests cannot reach were read from the source (the one the tests reach,
  `src/wide_math.rs:1554:30`, matches the binary).
- **KeeperCrank's candidates** are checked and parsed by its handler, first thing, instead of by the decode: the same
  errors in the same cases (InvalidInstructionData), since nothing runs between the decode and the handler's start.
  The risk buffer is sanitized once in place (the original sanitizes two copies; nothing writes it in between).
- **Two reserve-shape validations** of the live touch are left out (see "Compute units"): they cannot fail.
- **`garbage_collect_dust`** is not ported (the program never calls it).
- **ResolveMarket reads the Clock account once** where the original reads it three times (the same account, the same
  values), and changes the config in place (no copy, as above).
- **Checks that cannot fail are left out of the resolution path**, each with a comment where it would be:
  `finalize_side_reset`'s four checks where `resolve_market_not_atomic` calls it (the conditions it is called under
  are those checks), the "both OI zero" check right after both are zeroed, the deviation band's two `checked_mul`s
  (products below 2^128), `close_resolved_terminal_not_atomic`'s "reserve is zero" check right after it is cleared, and
  `checked_sub` on a stale count just checked to be nonzero.
- **`ResolvedCloseResult`** is a payout in units, or `PROGRESS_ONLY` (u128::MAX, more than any vault can hold) for
  ProgressOnly.
- **Compute units** differ (the port uses fewer on every successful transaction, asserted; tabled above): where the
  original exceeds a compute budget on a crank the port completes (above), the outcomes differ.
- **Three engine paths only a patched slab reaches**, read on both sides:
  - `I256::checked_mul_i256` in the original (`src/wide_math.rs`, about line 855) bounds a negative product by
    `U256::from_u128(1u128 << 127)`, that is 2^127, where its comment says 2^255: a negative product above 2^127 fails
    with EngineOverflow (exactly 2^127 gives I256::MIN). The port's `mulI256Mag` (wide.ts) multiplies exactly up to
    2^255. accrue_market_to's products never reach 2^127: A <= ADL_ONE (1e15) and |delta_p| <= MAX_ORACLE_PRICE (1e12)
    give at most 1e27, and InitMarket's funding envelope bounds ADL_ONE · MAX_ORACLE_PRICE · max_abs_funding ·
    max_accrual_dt (each factor checked on entry) by i128::MAX < 2^127 (engine.ts, accrueMarketTo). Upstream fixed the
    bound after v12.20 (aeyakovenko/percolator 2532878, "Fix I256 negative multiplication bound").
  - The trade's per-side position cap counts in i64 in the original (`count as i64 + after - before`, wrapping, then
    negative is EngineCorruptState and above `cap as i64` EngineOverflow). The port now counts the same way (it used
    u64 before, which gave EngineOverflow for a count of 2^63); percolator-trade.test.ts compares counts and caps of
    2^63 and more.
  - A free-list index of 4,096 to 65,534 (the head, or a slot's next / prev link) is past the arrays: the original
    panics with Rust's bounds check ("index out of bounds: the len is 4096 but the index is 5000", at
    src/percolator.rs:1127:13 for the head in free_slot), the port fails TypeSOL's bounds check (5104, "array index out
    of bounds"). The panic message carries the index, which a TypeSOL `panic` (a fixed message) cannot reproduce; both
    fail and change nothing. percolator-accounts.test.ts pins both outcomes.

## What is not verified

- **Refusals no transaction can reach**, read from the source and ported, not compared: ResolveMarket's OracleInvalid
  for a market whose oracle was never initialized (InitMarket always sets the flag) and for P_last = 0 (InitMarket
  always sets a price), its InvalidAccountData for a Hyperp market without a mark (InitMarket requires one and no
  instruction clears it); the engine's own refusals in resolution (a slot before current_slot or last_market_slot, a
  price of 0 or above MAX_ORACLE_PRICE, a terminal delta past i128, a degenerate arm with another live price or a
  rate) and in the resolved closes (CorruptState for a same-epoch or two-epoch-old position, an A basis of 0, a zero
  stale count, a zero payout denominator; InsufficientBalance for capital above the vault); a payout above u64::MAX
  (EngineOverflow) and WithdrawInsurance's payout above the vault (no vault reaches either: MAX_VAULT_TVL is 10^16).
- **The author's test suite** runs on LiteSVM 0.1 (the 1.18 runtime), not the runtime the differential tests here use;
  its 609 tests that run the binary compare outcomes the tests assert, not every byte (see "The author's test suite").
- **The matcher** is not compared with any binary (see "The matcher"); neither is the SPL Token program, which both
  sides call (LiteSVM's own build).
- The binary was not rebuilt from source here (see "How the facts above were checked").