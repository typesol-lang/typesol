# Case study: Raydium AMM v4

This page ports [Raydium AMM v4](https://github.com/raydium-io/raydium-amm), Raydium's original constant-product AMM,
from `program/src` at d26944b (Apache-2.0). The port is checked against the binary that runs on mainnet as
`675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` (deployed in slot 445763204, dumped in slot 466115597), not a rebuild.

Unlike the other ports here, AMM v4 is a native program: no Anchor. Its entrypoint reads a tag byte and the arguments
after it, takes its accounts by position (a swap accepts 17 or 18 of them, the v2 swaps 8), keeps its accounts as
`#[repr(C, packed)]` structs with no discriminator, and fails with built-in program errors and panics as often as with
its own errors. The port keeps all of that.

| File | Holds |
| --- | --- |
| [`raydium_amm.ts`](../showcase/mainnet/raydium-amm/raydium_amm.ts) | the entrypoint (one `@fallback` over `instructionData()` and `remainingAccounts()`), every instruction, the token and system CPIs, the P&L calculation |
| [`state.ts`](../showcase/mainnet/raydium-amm/state.ts) | AmmInfo (752 bytes), TargetOrders, AmmConfig, Fees, the ray_log records, the 61 errors (codes 0–60) |
| [`math.ts`](../showcase/mainnet/raydium-amm/math.ts) | decimal normalization, the constant-product amounts, the exchange rates, with the original's panics at their places |

## What is ported

All of it. The live instructions: Initialize2 (tag 1, both its 19- and 21-account forms), Deposit (3, 11 or 14–15
accounts, the optional minimum), Withdraw (4, 11 or 20–23 accounts, the optional minimums), SetParams (6: status, state,
fees, open time), WithdrawPnl (7), SwapBaseIn / SwapBaseOut (9 / 11, 17 or 18 accounts), CreateConfigAccount (14),
UpdateConfigAccount (15), SwapBaseInV2 / SwapBaseOutV2 (16 / 17, 8 accounts) and WithdrawExcessLamports (18). The
retired ones (0, 2, 5, 8, 10, 12, 13) panic with `not implemented` at the original's source location, as it does.
The order book (OpenBook) was removed upstream in July 2026; its accounts are still accepted where the original
accepts them, and ignored.

## What it needed

TypeSOL gained what a native program needs (docs/language.md, "Porting a native program"):

- `loadRaw<T>` / `loadRawMut<T>`: accounts with no discriminator, read from byte 0. The port makes the original's own
  checks first (owner, an exact size, its error codes), then loads.
- `instructionData().readU64(offset)` and the other little-endian readers, for the hand-packed arguments (optional
  ones are present when enough bytes follow).
- Errors from code 0 (returned as Solana's CUSTOM_ZERO, as `ProgramError::Custom(0)` is), `ProgramError.X` for the
  built-in errors (`NotEnoughAccountKeys`, `InvalidInstructionData`, `InsufficientFunds`), `panic(message, location)`
  and `PANIC_ON_OVERFLOW` for `unwrap()` and checked arithmetic, `ERROR_LOG_PREFIX` / `PROGRAM_ERROR_LOG_PREFIX` for the
  entrypoint's "AMM error: …" / "Program error: …" lines.
- `logBase64` for the ray_log records (bincode of a packed struct, base64), `createProgramAddress` for the authority
  derived from the stored nonce, and `isqrt` of a u256 (the P&L uses U256).

## How it is checked

`showcase/test/raydium-amm.test.ts` runs the mainnet binary and the port in two LiteSVMs under the same program id
and clock. Raydium's three fixed keys (its admin, the pool fee destination and the lamports collector) are swapped for
test keys in both, in the original where its code loads them (lddw immediates) and in the port's source, so the admin
instructions run too. Every transaction must give the same outcome, the same bytes in every account it touches and
the same log lines: the ray_log records, the original's messages ("initialize2: …", "withdrawpnl …", mismatch lines),
the entrypoint's error lines and, for panics, the message and the source location the runtime reports.

Covered: pool creation in both forms (open now and later), swaps in both directions, base in and base out, in all three
account forms; refusals (slippage, more than held, zero, the whole pool out, wrong account counts, short data, a vault
as the user's account, a wrong token program); deposits on either side with and without the minimum, withdrawals with
and without minimums, amounts past u64; status, state, fees and open time changes and their refusals; the P&L taken by
the P&L owner after the pool grew; config creation and updates; the retired tags; excess lamports; and a random mix of
swaps, deposits and withdrawals (`FUZZ_SEED`, `FUZZ_STEPS`). 484 transactions in all at 400 fuzz steps.

## Differences

None found in outcomes, account bytes or log lines. Two things are outside what the test compares:

- **Compute-unit lines** ("consumed N of M compute units") differ, by design (see below).
- **Overflow panics the inputs cannot reach.** The original's `checked_*().unwrap()` sites that user input can reach
  (a base-out swap for the whole side or more, an exchange rate past u64, a zero total) panic in the port with the
  original's message and location. Arithmetic that cannot overflow for any input (u64 by u64 products in u128, for
  instance) still panics there under `PANIC_ON_OVERFLOW`, but with an empty location.

## Cost

| | original | TypeSOL | |
| --- | ---: | ---: | ---: |
| swap base in (v2) | 15,222 | 6,597 | 43% |
| swap base out (v2) | 15,894 | 6,800 | 43% |
| swap base in (17 accounts) | 16,317 | 6,875 | 42% |
| deposit | 44,406 | 16,544 | 37% |
| withdraw | 45,278 | 16,045 | 35% |
| initialize2 | 107,403 | 62,158 | 58% |

The binary is 147,536 bytes against the original's 308,616.
