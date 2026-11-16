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
position cap) and a free-list head past the 4,096 slots (a difference, pinned: below); and, for boundaries only such a
state reaches, the states listed under "Mutation testing" below. Some tests sign with the slab's
own keypair, as whoever created the slab account can, to pass the slab again as the user, the admin or the vault
authority (below).

**Mutation fuzzers** (`percolator-mutate-*.test.ts`, the shared world in `percolator-mutate.ts`). The hand-written
cases and the random walks send transactions a client would send; these send the ones it would not. A valid
transaction of each of the 27 instructions is built in eleven market states (empty; funded accounts; open positions;
a reset-pending side with stale accounts; resolved with accounts open; resolved with only insurance; resolved and
bare; matured-stale; Hyperp; Chainlink; inverted), every instruction succeeding in at least one, and then mutated:
its account list, its data, its environment, or the slab under it. Every account of the test world is at a keypair's
address, so any of them can sign (the slab, a token account, the vault). Each mutated transaction is compared as
`both()` compares, and every account is put back afterwards, so each mutation starts from the same state. A
divergence is recorded and the test fails at its end with the list; `PERCOLATOR_MUTATE_DUMP=<file>` writes one line per
divergence for minimising, `PERCOLATOR_MUTATE_SCALE` multiplies the sizes, `PERCOLATOR_MUTATE_SEED` changes the seed,
`PERCOLATOR_MUTATE_VERBOSE=1` prints the tally per instruction. The four differences they and a review of every
failure site of the original found are fixed and kept as named cases in `percolator-regressions.test.ts` (under
"Differences" below), with one difference pinned there (a panic after TradeCpi's call on a nearly full heap); the
sites that review found without a test are reached on purpose in `percolator-sites.test.ts`.
The tally is under "Mutation tally".

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
| `percolator-mutate-accounts.test.ts` | the account list of every instruction in every state: 60 random mutations each by default (an account replaced by any account of the test world, among them the slab, another market's slab, an uninitialized slab, the vault, the vault authority, token accounts of this and other mints and owners, the mint, the oracle, another oracle, a Chainlink account, the clock, Rent, SlotHashes, the instructions and epoch-schedule sysvars, the token, system and compute-budget programs, Percolator itself, the matcher and the rogue matcher, the matcher context, the LP PDA, users, the admin, the fee payer, a funded system account, program-owned accounts one byte short, one byte long, zeroed and of 8 bytes, a key with no account; duplicated into another position; the last one or two dropped; one to three appended; two swapped; the signer or writable flag flipped; one or two at a time); then, exhaustively, every position replaced by the slab and by the fee payer and duplicated into every other |
| `percolator-mutate-data.test.ts` | the instruction data of every instruction in every state (InitMarket once per oracle kind): every truncation and 1 to 9 appended bytes; every field at its boundaries (0, 1, 2, max, max - 1, the sign boundaries, its own value ± 1, and either side of the limits the program checks: indexes 4,095 / 4,096, basis points 10,000, prices 10^12, TVL 10^16, sizes 10^14, A 10^15, …; key fields to zero, all ones and the world's keys); 25 random byte changes each; all 256 tags with no payload and with each instruction's payload; KeeperCrank candidate lists of 0 to 130 (free slots, indexes past the slots, every policy byte, partial sizes at their bounds, a cut last candidate) and every format byte |
| `percolator-mutate-env.test.ts` | two or three instructions per transaction (one market, two markets, the same one twice; a market's end, WithdrawInsurance then CloseSlab, in one transaction); every instruction through a relay at stack height 2, once and twice in one instruction (`fixtures/percolator-relay.ts`); compute-unit limits from 2% to 101% of what the original needs (both fail and change nothing, or the original runs out and the port finishes: counted apart); 14 Clocks (slot 0, 1, before the market's, u64::MAX, 2^63, a timestamp of 0, -1, i64::MIN, i64::MAX, an hour either way) and the Clock moved backwards between two transactions; the Pyth account at 47 extremes (price, exponent from i32::MIN to i32::MAX, confidence, publish time, feed, verification tag, length) and the Chainlink account at 26 (decimals 0 to 255, answers 0, negative, past u128 once scaled, past u64, rounding to 0, timestamps past i64, length) |
| `percolator-mutate-slab.test.ts` | the slab patched in both before an instruction: every field of the header, the config, the engine and its parameters, the account entries of used and free slots, the free-list links, the used bitmap's words, the risk buffer and the generation table, at its boundary values, with an instruction drawn for each (three states), then random fields and random bytes under every instruction in every state; 21 free-list and bitmap inconsistencies (the head on a used slot, a used slot's bit cleared, links to itself, past the slots, the counts at 0 and u16::MAX, the risk buffer naming a free slot or one slot twice) under every instruction |
| `percolator-sites.test.ts` | failure sites of the original reached on purpose: CatchupRequired past 20 envelopes in WithdrawCollateral, CloseAccount, ConvertReleasedPnl and UpdateConfig; CatchupAccrue on a Hyperp market after a stale gap; SPL Token option tags of 2, states 0 / 2 / 3, accounts of 82 / 164 / 166 / 355 bytes as the user's token account, a vault of 82 or 355 bytes at InitMarket, a mint's freeze tag of 2, the vault frozen after InitMarket under every token instruction (live and resolved); TradeCpi zero fills three and 30 envelopes on, i128::MIN asked and answered, limit prices below the unit scale; CloseSlab with stranded tokens to bad destinations and a wrong vault authority, and with an account left; PushHyperpMark below and above the unit scale and with the authority burned; MAX_VAULT_TVL through InitUser, InitLP, deposits, top-ups; the trade's size, position and open-interest bounds (10^14) with real trades; TradeCpi with signers and writable accounts in its tail, the slab and the LP PDA among them, each account's flags as the matcher sees them logged by the rogue matcher and compared; the per-side cap on active positions (on a market of three accounts, which cannot reach it, then with the cap written below the counts real trades make: a third long or short refused, a flip, a close into a new position at the cap, a reduction refused above it, TradeCpi at and past it); the ADL edges: K_opp + ΔK at the headroom bound and one past it, K + ΔK past i128::MIN (the haircut fallbacks, K written in), a step past i128::MAX and A past u128::MAX / 10^6 (A written in), precision exhausted (A_candidate 0, A written in) and one past it, and KeeperCrank stopping on a pending reset, in the risk buffer's loop with real instructions and in the candidates' loop with the buffer emptied |
| `percolator-regressions.test.ts` | the four differences found by the fuzzers and the review, each as its minimal case (below); TradeCpi's tails around the original's heap exhaustion with 1 to 26 distinct accounts, before the call (the TypeSOL matcher) and after it (the rogue matcher, which takes any tail: a fill, a zero fill, a refused answer, and a panic, the one pinned difference) |
| `test/language/native-lamports.test.ts` | the compiler change the CloseSlab fix needed (`.lamports` on remaining accounts under NATIVE_ACCOUNT_WRITES) |

## Compute units and size

| | Original | Port |
| --- | ---: | ---: |
| Binary | 395,368 bytes | 363,392 bytes (SBPF v0) |

Successful transactions, mean / largest: those of the two fuzz walks with their ends (the account walk 40 seeds × 400
steps, the liquidation walk 40 seeds × 600 steps, 80 full life cycles), and for UpdateAuthority, which they do not
send, those of percolator-admin.test.ts. Every instruction is in the table.

| Instruction | Transactions | Original | Port |
| --- | ---: | ---: | ---: |
| InitMarket | 80 | 237,575 / 248,070 | 232,720 / 235,031 |
| InitUser | 1,445 | 6,926 / 7,225 | 2,917 / 3,250 |
| InitLP | 230 | 7,071 / 7,301 | 3,016 / 3,272 |
| DepositCollateral | 1,314 | 6,792 / 7,821 | 2,725 / 3,498 |
| WithdrawCollateral | 786 | 14,475 / 45,269 | 6,311 / 15,996 |
| KeeperCrank | 4,324 | 52,853 / 387,752 | 29,217 / 213,766 |
| TradeNoCpi | 1,790 | 27,367 / 88,586 | 14,298 / 33,715 |
| LiquidateAtOracle | 2,310 | 10,441 / 66,218 | 5,459 / 19,102 |
| CloseAccount (live and resolved) | 883 | 9,808 / 28,989 | 4,372 / 10,222 |
| TopUpInsurance | 1,383 | 6,387 / 6,450 | 2,381 / 2,420 |
| TradeCpi | 83 | 21,531 / 44,910 | 13,476 / 24,822 |
| CloseSlab | 80 | 12,270 / 12,270 | 8,225 / 8,225 |
| UpdateConfig | 433 | 3,024 / 9,318 | 1,265 / 3,107 |
| PushHyperpMark | 774 | 3,177 / 9,269 | 2,592 / 4,335 |
| SetOraclePriceCap | 601 | 1,934 / 8,484 | 606 / 2,577 |
| ResolveMarket | 58 | 4,490 / 27,650 | 1,814 / 8,725 |
| WithdrawInsurance | 92 | 6,056 / 6,404 | 2,085 / 2,299 |
| AdminForceCloseAccount | 423 | 9,139 / 22,995 | 3,631 / 8,866 |
| WithdrawInsuranceLimited | 31 | 7,062 / 7,085 | 2,606 / 2,660 |
| ReclaimEmptyAccount | 90 | 1,526 / 2,298 | 727 / 1,170 |
| SettleAccount | 1,133 | 5,794 / 22,438 | 3,609 / 9,803 |
| DepositFeeCredits | 6 | 7,030 / 7,517 | 2,795 / 3,065 |
| ConvertReleasedPnl | 241 | 20,188 / 35,488 | 8,646 / 12,482 |
| ResolvePermissionless | 22 | 1,617 / 1,632 | 791 / 805 |
| ForceCloseResolved | 208 | 10,135 / 26,722 | 3,864 / 9,811 |
| CatchupAccrue | 1,405 | 4,373 / 75,542 | 1,731 / 33,437 |
| UpdateAuthority | 7 | 1,496 / 1,697 | 437 / 587 |

Measured on the 363,392-byte build. Against the build before the mutation fuzzers' fixes (360,248 bytes), the same
transactions cost the port the same or fewer units in every row (SetOraclePriceCap, which now changes the config in
place, 606 on average from 1,696; the original's figures are unchanged, being the same binary on the same
transactions); in the keeper-crank table below every crank costs the port one unit more than on that build.

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
| 2 | no candidates (the fee sweep) | 200,000 | 23,510 | 13,757 |
| 2 | 1 candidate, touch only | 200,000 | 27,543 | 16,613 |
| 2 | 1 candidate, FullClose | 1.4M | 26,640 | 14,365 |
| 17 | no candidates | 200,000 | 67,040 | 33,964 |
| 17 | 16 candidates, touch only | 200,000 | 152,756 | 89,372 |
| 17 | 4 candidates, FullClose | 1.4M | 258,281 | 81,875 |
| 17 | 4 candidates, FullClose (a market of its own) | 200,000 | exceeds | 81,725 |
| 65 | no candidates | 200,000 | 120,774 | 61,450 |
| 65 | 64 candidates, touch only | 200,000 | exceeds | exceeds |
| 65 | 64 candidates, touch only | 1.4M | 516,363 | 305,738 |
| 65 | 32 candidates, FullClose | 1.4M | 1,031,712 | 308,923 |
| 257 | no candidates | 200,000 | 166,501 | 88,883 |
| 257 | 64 candidates, touch only | 1.4M | 556,056 | 319,057 |
| 257 | 16 candidates, FullClose | 1.4M | 683,654 | 217,130 |
| 257 | 32 candidates, FullClose | 1.4M | 1,189,473 | 356,344 |
| 257 | 64 candidates, FullClose | 1.4M | exceeds | 622,064 |
| 1,025 | no candidates | 200,000 | 166,494 | 88,883 |
| 1,025 | 64 candidates, touch only | 1.4M | 591,735 | 335,307 |
| 1,025 | 32 candidates, FullClose | 1.4M | 1,276,424 | 394,530 |
| 1,025 | 64 candidates, FullClose | 1.4M | exceeds | 660,078 |
| 4,096 | no candidates | 200,000 | 166,441 | 88,833 |
| 4,096 | 64 candidates, touch only | 1.4M | 591,682 | 335,258 |
| 4,096 | 32 candidates, FullClose | 1.4M | 1,277,097 | 394,447 |
| 4,096 | 64 candidates, FullClose | 1.4M | exceeds | 660,037 |

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
the two loops read that. 128 touch-only candidates on free slots of an empty market (the 363,392-byte build):
original 15,157, port 12,140.

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

**The default run** of all sixteen test files (`vitest run showcase/test/percolator*`, the default seeds and scales)
compares 139,185 transactions through `both()`, 33,590 of them successful under both. Counted as each file sends them
(`PERCOLATOR_TRACE=1` prints one line per compared transaction):

| File | Compared | Successful under both |
| --- | ---: | ---: |
| `percolator-mutate-data.test.ts` | 54,164 | 8,517 |
| `percolator-mutate-accounts.test.ts` | 26,714 | 1,996 |
| `percolator-mutate-slab.test.ts` | 26,062 | 11,991 |
| `percolator-mutate-env.test.ts` | 22,009 | 6,043 |
| `percolator-regressions.test.ts` | 3,791 | 882 |
| `percolator-fuzz.test.ts` | 3,711 | 2,152 |
| `percolator-crank-cu.test.ts` | 749 | 747 |
| `percolator-crank.test.ts` | 376 | 339 |
| `percolator-resolve.test.ts` | 369 | 232 |
| `percolator-sites.test.ts` | 299 | 163 |
| `percolator.test.ts` | 270 | 69 |
| `percolator-trade.test.ts` | 256 | 163 |
| `percolator-liquidate.test.ts` | 162 | 138 |
| `percolator-accounts.test.ts` | 141 | 96 |
| `percolator-admin.test.ts` | 112 | 62 |
| `percolator-layout.test.ts` | 0 | 0 |
| **Total** | **139,185** | **33,590** |

132,031 of them are random or mutated: 3,711 in the three random walks of `percolator-fuzz.test.ts` on their fixed
seeds (720 in the account walk, 1,452 in the oracle walk, 1,539 in the walk of leveraged trades, crashes and
liquidations) and 128,320 mutated transactions of the four mutation fuzzers at their default size (26,334 account
lists, 54,081 instruction data, 21,926 environments, 25,979 slab states; each fuzzer's other 83 transactions build its
markets, and the account-list fuzzer's 297 base transactions are sent unmutated first). The other 7,154 are fixed
cases, 3,760 of them TradeCpi tails of every length from 150 to 200 accounts with 1 to 26 distinct ones
(`percolator-regressions.test.ts`, the heap's limit). The mutation fuzzers' tallies also count transactions compared
outside `compare` (one side out of compute units, a pinned difference: below), which this count leaves out.

**Mutation testing** (whether the tests notice a wrong port). 196 hand-chosen mutants of the port's source, spread over
every file in proportion to its logic (64 in `engine.ts`, 21 `oracle.ts`, 17 `crank.ts`, 15 `users.ts`, 14 each in
`program.ts`, `market.ts` and `trade.ts`, 13 `resolve.ts`, 9 `percolator.ts`, 7 `wide.ts`, 4 `errors.ts`, 2 each in
`wire.ts` and `state.ts`) and over kinds: comparison boundaries, swapped operands and signs, rounding direction,
off-by-one constants and limits, removed checks, swapped error codes, reordered checks, wrong account indexes and field
offsets, skipped write-backs, omitted log lines, saturating made wrapping, the constants of the TradeCpi heap count and
of the funding clamp; 63 of them in rarely-run paths (ADL and the haircut, bad debt past insurance, the resolved
wind-down, Hyperp, Chainlink, warm-up, fee credits, force close). Each was applied alone, the port rebuilt from source
(a deliberately fatal mutant, killed, showed that the tests build what is on disk) and the sixteen files run in a fixed
order until the first failure. Every mutant compiled. 140 were killed by the tests as they stood. 22 of the 56 that
survived are equivalent: two compile to the same binary, and for the others no input can tell them apart (a bound an
earlier check makes unreachable, a check every caller already makes, a reordering of checks with the same error and no
write between them, a rounding that is exact at the boundary, the TradeCpi heap count's shortcut, which only matters
with 132 or more distinct accounts in one transaction, past the runtime's account-lock limit). The other 34 were gaps: each now has a differential test, in the
file of its subject, that fails on the mutant and passes on the port (boundaries hit exactly: the initial and
maintenance margin, an ExactPartial hint's predicted equity, A at MIN_A_SIDE, 21 envelopes of catch-up inline and 20
in one CatchupAccrue, the hard timeout, the Hyperp deviation band and mark staleness, the Hyperp index's 9,000-slot dt
cap, a fee of exactly `mark_min_fee`, a fill at its limit price, the deposit cap, `units_to_base` at u64::MAX, Chainlink's
18 decimals and maximum age, a week of staleness, WithdrawInsuranceLimited's rounding, and states only a written slab
has: the funding clamp by one, K at exactly i128::MIN, the dust clear bound, a drain-only empty short side, the scan
cursor at 4,096, an LP generation of 0, insurance without a vault and a CloseSlab destination near u64::MAX, a negative
PnL left open on a resolved market, a pending warm-up bucket's horizon, ConvertReleasedPnl at zero equity and at a cap
of exactly u128::MAX, the partial catch-up on Hyperp). Each such mutant was run again and is now killed. None of the
new tests found the port differing from the original. The driver that applies the mutants is not in the repository.

## Mutation tally

Transactions per category, compared through `both()`: tried, failed under both, succeeded under both, diverged,
pinned (a documented difference: the free-list index past the slots; in the compute-unit category, the original
running out of units where the port finishes), and not sendable (an account list the transaction format refuses). The
20-fold runs (`PERCOLATOR_MUTATE_SCALE=20 PERCOLATOR_MUTATE_SEED=7`, about 80 minutes in all) ran once, after the
fixes below except the last one:

| Fuzzer | Category | Tried | Both fail | Both succeed | Diverged | Pinned | Not sendable |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| accounts | the base transactions | 297 | 161 | 136 | 0 | 0 | 0 |
| accounts | random account-list mutations | 326,471 | 297,807 | 26,807 | 0 | 0 | 1,857 |
| accounts | every position the slab / the fee payer / duplicated | 10,043 | 9,553 | 490 | 0 | 0 | 0 |
| data | truncations and appended bytes | 6,545 | 6,494 | 51 | 0 | 0 | 0 |
| data | fields at their boundaries | 23,549 | 15,906 | 7,643 | 0 | 0 | 0 |
| data | random byte changes | 117,500 | 103,915 | 13,585 | 0 | 0 | 0 |
| data | every tag | 64,515 | 64,495 | 20 | 0 | 0 | 0 |
| data | KeeperCrank candidate lists and formats | 8,877 | 7,665 | 1,212 | 0 | 0 | 0 |
| env | several instructions per transaction | 13,205 | 10,543 | 2,662 | 0 | 0 | 0 |
| env | through the relay, once and twice | 594 | 368 | 226 | 0 | 0 | 0 |
| env | compute-unit limits | 2,970 | 2,109 | 408 | 0 | 453 | 0 |
| env | Clock extremes and moved backwards | 17,358 | 10,962 | 6,396 | 0 | 0 | 0 |
| env | oracle extremes | 14,958 | 11,048 | 3,910 | 0 | 0 | 0 |
| slab | every field at its boundary values | 578,223 | 342,659 | 235,519 | 2 | 43 | 0 |
| slab | random fields and bytes | 68,640 | 40,822 | 27,807 | 0 | 11 | 0 |
| slab | free list and bitmap inconsistencies | 4,914 | 2,667 | 2,202 | 0 | 45 | 0 |

About 1.26 million transactions. The two divergences of the 20-fold slab run were compute units, not behaviour:
SetOraclePriceCap on a Hyperp market with a funding horizon of 0 or a funding k of 10^15 written into the config cost
the port slightly more than the original's 2,611 units (the port copied the 400-byte config three times; it now
changes it in place, 942 units: percolator-regressions.test.ts). Before the fixes, the default slab run (then three
instructions per value) had found 16 divergences in 53,034 transactions, all the funding rate's clamp on a Hyperp
market, and the review's four cases differed as described under "Differences" (each confirmed against the port as it
was before its fix). The account-list, data and environment fuzzers found no divergence at either size. Every
instruction in every state at 2% to 101% of the units the original needs: in 453 of 2,970 transactions the original ran out and the port, needing fewer
units, finished (the only outcome the compute-unit category allows to differ); in every other one both failed with
every account unchanged, or both succeeded the same way.

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
| Port | `showcase/mainnet/percolator/percolator.ts` built by this repository's compiler (363,392 bytes; first run on the 360,248-byte build before the mutation fuzzers' fixes, with the same outcomes) |
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

**Compute units in the author's own benchmark** (`cu_benchmark.rs`, `benchmark_all_instructions -- --nocapture`, the
363,392-byte build; the figures include the SPL Token transfers these instructions make). Against the 360,248-byte
build, TradeNoCpi costs the port one unit more (7,766 from 7,765), six instructions are unchanged and eight cost fewer:

| Instruction | Original | Port |
| --- | ---: | ---: |
| TradeNoCpi | 14,033 | 7,766 |
| DepositCollateral | 11,424 | 7,386 |
| WithdrawCollateral | 18,095 | 11,540 |
| KeeperCrank | 42,411 | 27,209 |
| TopUpInsurance | 11,170 | 7,166 |
| UpdateConfig | 3,619 | 1,721 |
| SetOraclePriceCap | 2,507 | 928 |
| LiquidateAtOracle | 12,226 | 7,014 |
| CloseAccount | 14,397 | 9,527 |
| UpdateAuthority (admin) | 1,686 | 690 |
| ResolveMarket | 4,048 | 1,983 |
| KeeperCrank (resolved) | 6,274 | 4,764 |
| AdminForceCloseAccount | 12,218 | 8,018 |
| WithdrawInsurance | 11,108 | 7,015 |
| CloseSlab | 15,370 | 11,326 |

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
  original drops its borrow before the call). CloseSlab's last moves of lamports (the slab's to the admin) are plain
  `borrow_mut` writes in the original, so the slab or the admin named again in the position it does not read (the
  admin's token account, read only for a drain) is fine there; the port failed it with 2040, TypeSOL's refusal of a
  remaining account passed twice when its lamports are written. Under NATIVE_ACCOUNT_WRITES that refusal is now lifted
  for lamports as it was for data (docs/language-native.md), and the two agree (percolator-regressions.test.ts). The
  account-list fuzzer replaces every position of every instruction by the slab and duplicates every position into
  every other, in every state; run against the compiler before the change, it reports exactly these three cases
  (#4 = the admin, #4 = the slab by duplication and by replacement).
- **TradeCpi's heap.** Before the matcher call the original allocates on its 32 KiB bump heap, which never frees: the
  entrypoint's list of every account passed (48 bytes each) and two RefCells per distinct account (72 bytes), then the
  call's metas (34 bytes each), its data (67), its account infos (48 each) and `invoke_signed`'s copy of the metas and
  data. A tail of about 190 accounts exhausts it (192 with one distinct account, 184 with twenty), and the original
  logs "Error: memory allocation failed, out of memory" and aborts. The port has no such heap: it counts the same
  bytes in the same order (with the allocator's alignment) and stops at the same point with the same line
  (`cpiHeap` in percolator.ts; counted only for tails long enough to matter). The original passes 3 + T account infos
  to the call, the port 2 + T (the matcher program is not one); the runtime here has no limit that 128 or more infos
  reach (tails of 126 to 246 give the same outcome under both). After the call the original allocates nothing on the
  way to its answer, its trade or its refusals (read at 06f86fb: the handler's only `msg!` lines there are behind the
  `cu-audit` feature, and the engine has no heap values), except to format a panic (below). The TypeSOL matcher
  refuses more than 32 accounts, so percolator-regressions.test.ts also runs the rogue matcher, which takes any tail,
  at every tail of 170 to 194 accounts with 1 to 26 distinct ones: a fill, a zero fill and a refused answer
  give the same outcome, logs and bytes under both at every length, those the original's heap holds and those it
  does not. No other instruction comes near the heap's end: at most 255 accounts (12,240 bytes) of which at most 64
  are distinct (4,608), and KeeperCrank's two candidate vectors (12,288 bytes for 128 candidates) leave more than 3 KB.
- **A panic after TradeCpi's matcher call with the heap nearly full** (pinned, percolator-regressions.test.ts).
  solana-program 1.18's panic handler formats its line on the heap (`msg!("{}", info)`, a String grown as Rust grows
  one: 12, 28, 56 and 112 bytes, 208 in all, for `panicked at src/wide_math.rs:1554:30:` and its message). Where the
  call has left fewer bytes than that above the allocator's 8-byte position word, the original logs "Error: memory
  allocation failed, out of memory" instead of the panic line and aborts; the port, which formats nothing on a heap,
  logs the panic line. The outcome (ProgramFailedToComplete) and every account are the same. It needs a tail at the
  last one or two lengths the heap holds (191 accounts with one distinct among them, 180 with 26: 32 of the 1,326
  pairs of 1 to 26 distinct and 150 to 200 accounts) and a panic after the call, which only a slab written in reaches
  (the test writes a position basis whose arithmetic overflows). Reproducing it would mean formatting every panic line
  on a heap that holds what the original's holds at that point.
- **A matcher that shrinks its context during TradeCpi**: the original refuses a context under 64 bytes
  (InvalidAccountData) before it reads the answer; the port read the fields first (3003 under 32 bytes) and now checks
  the length first.
- **The config in place**: see "Compute units" (the same bytes; fewer copies).
- **`LastRestartSlot::get()`**: the original writes a fallback for an error (`unwrap_or(0)`, `Err(_) => false`) that
  it never receives: a sysvar syscall the runtime fails aborts the instruction with the runtime's error in both builds,
  before any `Result` reaches the program. The port's `lastRestartSlot()` has no fallback (where the runtime returns
  a status instead, it fails with 5103). The sysvar is available on mainnet and in LiteSVM, where the two agree
  (percolator-resolve.test.ts moves it).
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
- **The funding rate of a patched config** (`compute_current_funding_rate_e9`): a negative
  funding_max_premium_bps or funding_max_e9_per_slot, which InitMarket and UpdateConfig refuse, makes `i128::clamp`
  panic ("assertion failed: min <= max" in core's cmp.rs, at the platform-tools build's path), and a funding_k_bps past
  2^47 can saturate the premium's product. The port used plain comparisons (no panic) and a checked product (5100); it
  now panics with the same line and saturates as `saturating_mul` does (oracle.ts). Found by the slab fuzzer on a
  Hyperp market (the only kind with a mark EWMA in its states), kept in percolator-regressions.test.ts.
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
- **What the mutation fuzzers do not reach.** They start from one valid transaction per instruction and state and
  mutate one thing (or two account-list changes) at a time; the engine's internals are compared through outcomes and
  bytes, not line by line. Three edges percolator-sites.test.ts reaches only
  with a value written into both slabs, because no sequence of instructions makes it: enqueue_adl's haircut fallbacks
  (K_opp + ΔK past i128 or past the headroom i128::MAX - A · MAX_ORACLE_PRICE: an accrual moves K by at most A · |Δp|
  <= 10^27 and an ADL step by at most D · A · 10^6 / OI with D under the 10^16 vault cap, nowhere near 1.7 · 10^38),
  its "precision exhausted" branch (A_candidate = floor(A · OI_post / OI) = 0 with OI_post > 0 needs A < OI on that
  side, but a side takes new positions only in Normal mode, where A >= MIN_A_SIDE = 10^14 >= MAX_OI_SIDE_Q >= OI, and
  afterwards OI only falls while each ADL step keeps A >= OI), and the per-side cap on active positions (it equals
  max_accounts, and a side holds at most max_accounts - 1 positions). A KeeperCrank stopping on a pending reset inside
  the candidates' loop needs the risk buffer emptied first (count 0): the account whose liquidation empties a side
  holds that side's whole open interest, so the trades put it among the buffer's four and the stop comes in the
  buffer's loop, which real instructions reach. Compute-unit limits are tried for every instruction in every state at
  nine fractions of the original's need, not at every unit.
- **TradeCpi's path after the matcher call on a nearly full heap** is compared for a fill, a zero fill and a refused
  answer at every tail of 170 to 194 accounts with 1 to 26 distinct, and for one panic site (src/wide_math.rs:1554);
  a panic at any other site after the call, reachable only with a slab written in, is not compared, and differs in the
  same way wherever the heap left cannot hold its formatted line (the pinned difference above).
- The binary was not rebuilt from source here (see "How the facts above were checked").