// showcase/mainnet/percolator against Percolator v12.20 as deployed on mainnet (test/programs/percolator_v12.so): failure
// sites of the original that a review of every one of them found without a differential test, each reached here on
// purpose and compared through `both()` (outcome, error code, logs, inner instructions, return data, every named
// account's bytes). Where a site is also reached by the mutation fuzzers (percolator-mutate-*.test.ts), the README's
// "How it is checked" says which mutation reaches it.
import { beforeAll, describe, expect, it } from "vitest";
import {
  A,
  C,
  Diff,
  E,
  HAVE_ORIGINAL,
  I128_MAX,
  type Lp,
  MATCHER_CTX_LEN,
  type Market,
  P,
  RISK_BUF_OFF,
  ROGUE,
  SOL,
  TOKEN,
  type User,
  accountAt,
  computeUnits,
  defaultInitArgs,
  i128,
  ix,
  lpPda,
  passiveMatcher,
  pe,
  r,
  readI128,
  readU128,
  replace,
  s,
  tokenAccountBytes,
  u32,
  u64,
  w,
  writeU128,
  ws,
} from "./percolator-helpers.js";

const ADL_ONE = 1_000_000_000_000_000n;
const MAX_ORACLE_PRICE = 1_000_000_000_000n;
// RiskBuffer: scan_cursor u16, count u8, 13 bytes of padding, min_notional u128, then four 32-byte entries (idx first).
const RISK_BUF_COUNT = RISK_BUF_OFF + 2;
const RISK_BUF_ENTRIES = RISK_BUF_OFF + 32;

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: failure sites reached on purpose", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });

  async function funded(m: Market, amount: bigint, label: string): Promise<User> {
    const u = await d.user(m);
    await d.ok(`${label}: InitUser`, u.key, [ix.initUser(m, u, amount)]);
    return u;
  }

  it("CatchupRequired past 20 envelopes for Withdraw, CloseAccount, ConvertReleasedPnl, UpdateConfig", async () => {
    const m = await d.market({
      edit: (a) => {
        a.minOraclePriceCapE2bps = 1_000_000n;
        a.tail!.permissionlessResolveStaleSlots = 0n;
      },
    });
    const lp = await funded(m, 1_000n * SOL, "lp");
    const alice = await funded(m, 100n * SOL, "alice");
    await d.ok("TradeNoCpi", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 100_000_000n)]);
    d.setClock(d.slot + 10n);
    d.setPrice(m, 101_000_000n);
    await d.ok("SettleAccount: the index moves", alice.key, [ix.settleAccount(m, 1)]);
    d.setClock(d.slot + 450_000_000n);
    d.setPrice(m, 102_000_000n);
    await d.both("WithdrawCollateral: 45 envelopes", alice.key, [ix.withdraw(m, alice, 1, 1n)]);
    await d.both("CloseAccount: 45 envelopes", alice.key, [ix.closeAccount(m, alice, 1)]);
    await d.both("ConvertReleasedPnl: 45 envelopes", alice.key, [ix.convertReleasedPnl(m, alice, 1, 1000n)]);
    await d.both("UpdateConfig: 45 envelopes", m.admin, [
      ix.updateConfig(m, m.admin, { horizon: 500n, kBps: 100n, maxPremiumBps: 500n, maxE9PerSlot: 1000n, tvlCapMult: 0 }),
    ]);
    await d.both("DepositFeeCredits: 45 envelopes", alice.key, [ix.depositFeeCredits(m, alice, 1, 1000n)]);
    await d.both("WithdrawInsuranceLimited: 45 envelopes", m.admin, [
      ix.withdrawInsuranceLimited(m, m.admin, await d.tokenAccount(m.mint, m.admin.address), 1n),
    ]);
  });

  it("CatchupAccrue on a Hyperp market: partial catch-ups keep the effective price and the index slot", async () => {
    const m = await d.market({
      edit: (a) => {
        a.feedId = Buffer.alloc(32);
        a.initialMarkPriceE6 = 1_000_000n;
        a.tail!.permissionlessResolveStaleSlots = 0n;
      },
    });
    const alice = await funded(m, 100n * SOL, "alice");
    const lpOwner = await d.user(m);
    const lp = await d.lp(m, lpOwner, 500n * SOL);
    await d.ok("TradeCpi", alice.key, [ix.tradeCpi(m, alice.key, lpOwner.key.address, lp, 0, 50_000_000n)]);
    await d.ok("PushHyperpMark", m.admin, [ix.pushHyperpMark(m, m.admin, 1_300_000n, 0n)]);
    d.setClock(d.slot + 20n);
    await d.both("SettleAccount: the index follows the mark", alice.key, [ix.settleAccount(m, 0)]);
    d.setClock(d.slot + 450_000_000n);
    await d.both("SettleAccount: 45 envelopes", alice.key, [ix.settleAccount(m, 0)]);
    await d.both("CatchupAccrue: a stale mark", alice.key, [ix.catchupAccrue(m)]);
    await d.both("PushHyperpMark again", m.admin, [ix.pushHyperpMark(m, m.admin, 1_250_000n, 0n)]);
    for (let i = 0; i < 4; i++) await d.both(`CatchupAccrue ${i + 1}`, alice.key, [ix.catchupAccrue(m)]);
    await d.both("SettleAccount after the catch-up", alice.key, [ix.settleAccount(m, 0)]);
  });

  it("token accounts: bad option tags, uninitialized, wrong lengths; a vault frozen after InitMarket", async () => {
    const m = await d.market();
    const alice = await funded(m, 10n * SOL, "alice");
    const original = Buffer.from(d.data(alice.ata));
    const token = [
      ["InitUser", () => ix.initUser(m, alice, SOL)],
      ["InitLP", () => ix.initLp(m, alice, m.slab, m.slab, SOL)],
      ["DepositCollateral", () => ix.deposit(m, alice, 0, SOL)],
      ["TopUpInsurance", () => ix.topUpInsurance(m, alice, SOL)],
      ["DepositFeeCredits", () => ix.depositFeeCredits(m, alice, 0, 1000n)],
      ["WithdrawCollateral", () => ix.withdraw(m, alice, 0, 1000n)],
      ["CloseAccount", () => ix.closeAccount(m, alice, 0)],
    ] as const;
    const edits: [string, (b: Buffer) => void][] = [
      ["delegate tag 2", (b) => b.writeUInt32LE(2, 72)],
      ["is_native tag 2", (b) => b.writeUInt32LE(2, 109)],
      ["close authority tag 2", (b) => b.writeUInt32LE(2, 129)],
      ["state 0 (uninitialized)", (b) => (b[108] = 0)],
      ["state 2 (frozen)", (b) => (b[108] = 2)],
      ["state 3", (b) => (b[108] = 3)],
      ["state 0 and another mint", (b) => ((b[108] = 0), b.fill(7, 0, 32))],
    ];
    for (const [what, edit] of edits)
      for (const [name, make] of token) {
        d.patch(alice.ata, edit);
        await d.both(`${name}: the user's token account with ${what}`, alice.key, [make()]);
        d.patch(alice.ata, (b) => original.copy(b));
      }
    for (const len of [82, 164, 166, 355]) {
      const at = await d.address();
      d.write(at, TOKEN, Buffer.concat([tokenAccountBytes({ mint: m.mint, owner: alice.key.address, amount: SOL }), Buffer.alloc(200)]).subarray(0, len));
      for (const [name, make] of token)
        await d.both(`${name}: a ${len}-byte token-owned account as the user's`, alice.key, [
          replace(make(), name === "WithdrawCollateral" || name === "CloseAccount" ? 3 : 2, at),
        ]);
    }
    // InitMarket's vault: 82 and 355 bytes owned by SPL Token, a delegate tag of 2.
    for (const len of [82, 355]) {
      const n = await d.newMarket();
      d.write(n.vault, TOKEN, Buffer.concat([tokenAccountBytes({ mint: n.mint, owner: n.vaultPda }), Buffer.alloc(200)]).subarray(0, len));
      await d.both(`InitMarket: a vault of ${len} bytes`, n.admin, [computeUnits(1_400_000), ix.initMarket(n, defaultInitArgs(n.admin.address, n.mint))]);
    }
    // The mint's freeze-authority tag 2.
    const n = await d.newMarket();
    d.patch(n.mint, (b) => b.writeUInt32LE(2, 46));
    await d.both("InitMarket: the mint's freeze tag 2", n.admin, [computeUnits(1_400_000), ix.initMarket(n, defaultInitArgs(n.admin.address, n.mint))]);
    // The vault frozen after InitMarket: every token instruction, live and then resolved.
    d.patch(m.vault, (b) => (b[108] = 2));
    for (const [name, make] of token) await d.both(`${name}: the vault frozen`, alice.key, [make()]);
    d.patch(m.vault, (b) => (b[108] = 1));
    await d.ok("ResolveMarket", m.admin, [ix.resolveMarket(m, m.admin)]);
    d.patch(m.vault, (b) => (b[108] = 2));
    await d.both("CloseAccount: resolved, the vault frozen", alice.key, [ix.closeAccount(m, alice, 0)]);
    await d.both("ForceCloseResolved: the vault frozen", alice.key, [ix.forceCloseResolved(m, 0, alice.ata)]);
    await d.both("AdminForceCloseAccount: the vault frozen", m.admin, [ix.adminForceCloseAccount(m, m.admin, 0, alice.ata)]);
  });

  it("TradeCpi: a zero fill past the accrual envelope, an echoed i128::MIN, a limit below the unit scale", async () => {
    const m = await d.market({
      edit: (a) => {
        a.minOraclePriceCapE2bps = 1_000_000n;
        a.tail!.permissionlessResolveStaleSlots = 0n;
      },
    });
    const alice = await funded(m, 100n * SOL, "alice");
    const plain = await funded(m, 1_000n * SOL, "plain");
    await d.ok("TradeNoCpi", alice.key, [ix.tradeNoCpi(m, alice.key, plain.key, 1, 0, 100_000_000n)]);
    d.setClock(d.slot + 10n);
    d.setPrice(m, 101_000_000n);
    await d.ok("SettleAccount: funding runs", alice.key, [ix.settleAccount(m, 0)]);
    // A rogue LP answering a zero fill (PARTIAL_OK) to whatever is asked.
    const u = await d.user(m);
    const ctx = await d.address();
    d.write(ctx, ROGUE, Buffer.alloc(MATCHER_CTX_LEN));
    const idx = d.freeHead(m);
    await d.ok("rogue LP", u.key, [ix.initLp(m, u, ROGUE, ctx, 100n * SOL)]);
    const rlp: Lp = { idx, matcher: ROGUE, ctx, pda: await lpPda(m, idx) };
    const answer = (mode: bigint, flags: number, size: bigint) =>
      d.patch(ctx, (b) => {
        b.writeBigUInt64LE(mode, 128);
        Buffer.concat([u32(2), u32(flags), u64(101_000_000n), i128(size), u64(0n), u64(0n), u64(0n), u64(0n)]).copy(b, 144);
      });
    answer(1n | 2n | 4n, 3, 0n);
    d.setClock(d.slot + 30_000_000n);
    d.setPrice(m, 101_000_000n);
    await d.both("TradeCpi: a zero fill three envelopes on", alice.key, [ix.tradeCpi(m, alice.key, u.key.address, rlp, 0, 1_000_000n)]);
    d.setClock(d.slot + 300_000_000n);
    d.setPrice(m, 101_000_000n);
    await d.both("TradeCpi: a zero fill 30 envelopes on", alice.key, [ix.tradeCpi(m, alice.key, u.key.address, rlp, 0, 1_000_000n)]);
    await d.ok("CatchupAccrue", alice.key, [ix.catchupAccrue(m)]);
    await d.ok("CatchupAccrue", alice.key, [ix.catchupAccrue(m)]);
    const min = -(1n << 127n);
    answer(1n | 2n | 4n | 8n, 1, 0n);
    await d.both("TradeCpi: i128::MIN asked and echoed", alice.key, [ix.tradeCpi(m, alice.key, u.key.address, rlp, 0, min)]);
    answer(1n | 2n | 4n, 1, min);
    await d.both("TradeCpi: i128::MIN answered to a short", alice.key, [ix.tradeCpi(m, alice.key, u.key.address, rlp, 0, -1_000_000n)]);
    // A non-inverted market with a unit scale of 1,000: a limit price below the scale is 0 in engine units.
    const s = await d.market({ edit: (a) => (a.unitScale = 1000) });
    const bob = await funded(s, 10_000_000n, "bob");
    const sOwner = await d.user(s);
    const slp = await d.lp(s, sOwner, 100_000_000n, passiveMatcher());
    for (const limit of [1n, 999n, 1000n, 1001n])
      await d.both(`TradeCpi: limit ${limit} at unit scale 1,000`, bob.key, [ix.tradeCpi(s, bob.key, sOwner.key.address, slp, 0, 1_000n, limit)]);
  });

  it("CloseSlab: stranded tokens and a bad destination; an account left with the engine's vault at 0", async () => {
    const m = await d.market();
    await d.ok("ResolveMarket", m.admin, [ix.resolveMarket(m, m.admin)]);
    const stranger = await d.funded();
    d.patch(m.vault, (b) => b.writeBigUInt64LE(5000n, 64));
    const good = await d.tokenAccount(m.mint, m.admin.address);
    const otherMint = await d.mint();
    for (const [what, to] of [
      ["another owner's", await d.tokenAccount(m.mint, stranger.address)],
      ["another mint's", await d.tokenAccount(otherMint, m.admin.address)],
      ["the slab", m.slab],
      ["the vault", m.vault],
    ] as const)
      await d.both(`CloseSlab: stranded tokens to ${what} account`, m.admin, [ix.closeSlab(m, to as never)]);
    await d.both("CloseSlab: stranded tokens, the vault authority wrong", m.admin, [replace(ix.closeSlab(m, good), 3, stranger.address)]);
    await d.both("CloseSlab: stranded tokens drained", m.admin, [ix.closeSlab(m, good)]);
    // An account still open with the engine's vault patched to 0 (P:6684).
    const n = await d.market();
    await funded(n, SOL, "alice");
    await d.ok("ResolveMarket", n.admin, [ix.resolveMarket(n, n.admin)]);
    d.patch(n.slab, (b) => {
      b.fill(0, E.vault, E.vault + 16);
      b.fill(0, accountAt(0) + A.capital, accountAt(0) + A.capital + 16);
    });
    await d.both("CloseSlab: an account left, the engine's vault 0", n.admin, [ix.closeSlab(n, await d.tokenAccount(n.mint, n.admin.address))]);
  });

  it("PushHyperpMark: a burned authority; a price below the unit scale", async () => {
    const m = await d.market({
      edit: (a) => {
        a.feedId = Buffer.alloc(32);
        a.initialMarkPriceE6 = 1_000_000n;
        a.tail!.markMinFee = 10n;
      },
    });
    // InitMarket refuses a unit scale on a Hyperp market (InvalidInstructionData): written into the config instead.
    d.patch(m.slab, (b) => b.writeUInt32LE(1000, C.unitScale));
    for (const p of [1n, 999n, 1000n, 1001n, 10n ** 12n, 10n ** 12n + 1n, 10n ** 15n, 10n ** 15n + 1000n])
      await d.both(`PushHyperpMark: ${p} at unit scale 1,000`, m.admin, [ix.pushHyperpMark(m, m.admin, p, 0n)]);
    d.patch(m.slab, (b) => b.writeUInt32LE(0, C.unitScale));
    await d.both("UpdateAuthority: the Hyperp mark authority burned", m.admin, [
      ix.updateAuthority(m, m.admin, 1, "11111111111111111111111111111111" as never),
    ]);
    await d.both("PushHyperpMark: burned", m.admin, [ix.pushHyperpMark(m, m.admin, 1_000_000n, 0n)]);
    // The config's authority patched to zero where UpdateAuthority refused the burn.
    d.patch(m.slab, (b) => b.fill(0, C.hyperpAuthority, C.hyperpAuthority + 32));
    await d.both("PushHyperpMark: a zero authority", m.admin, [ix.pushHyperpMark(m, m.admin, 1_000_000n, 0n)]);
  });

  it("MAX_VAULT_TVL (10^16) through InitUser, InitLP, deposits and top-ups", async () => {
    const m = await d.market({ edit: (a) => (a.newAccountFee = 0n) });
    const whale = await d.user(m, 3n * 10n ** 16n);
    await d.both("InitUser: 10^16", whale.key, [ix.initUser(m, whale, 10n ** 16n)]);
    await d.both("InitUser: one more", whale.key, [ix.initUser(m, whale, 1n)]);
    await d.both("InitLP: one more", whale.key, [ix.initLp(m, whale, m.slab, m.slab, 1n)]);
    await d.both("DepositCollateral: one more", whale.key, [ix.deposit(m, whale, 0, 1n)]);
    await d.both("TopUpInsurance: one more", whale.key, [ix.topUpInsurance(m, whale, 1n)]);
    await d.both("WithdrawCollateral: one", whale.key, [ix.withdraw(m, whale, 0, 1n)]);
    await d.both("TopUpInsurance: one again", whale.key, [ix.topUpInsurance(m, whale, 1n)]);
    const n = await d.market();
    const w2 = await d.user(n, 3n * 10n ** 16n);
    await d.both("InitUser: 10^16 + 1", w2.key, [ix.initUser(n, w2, 10n ** 16n + 1n)]);
    await d.both("TopUpInsurance: 10^16 + 1", w2.key, [ix.topUpInsurance(n, w2, 10n ** 16n + 1n)]);
    await d.both("TopUpInsurance: 10^16", w2.key, [ix.topUpInsurance(n, w2, 10n ** 16n)]);
    await d.both("InitLP: 1 over", w2.key, [ix.initLp(n, w2, n.slab, n.slab, 1n)]);
  });
  it("trade bounds with real trades: MAX_TRADE_SIZE_Q, the position bound and MAX_OI_SIDE_Q (10^14)", async () => {
    // A price of 0.01 so that 10^14 of position is within the margin of 500 SOL.
    const m = await d.market({ price: 10_000n });
    const lp = await funded(m, 900n * SOL, "lp");
    const alice = await funded(m, 500n * SOL, "alice");
    const bob = await funded(m, 500n * SOL, "bob");
    const max = 10n ** 14n;
    await d.both("TradeNoCpi: 10^14 + 1", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, max + 1n)]);
    await d.both("TradeNoCpi: -(10^14 + 1)", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, -(max + 1n))]);
    await d.both("TradeNoCpi: 10^14", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, max)]);
    await d.both("TradeNoCpi: one more on the same position", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 1n)]);
    await d.both("TradeNoCpi: another long past the side's open interest", bob.key, [ix.tradeNoCpi(m, bob.key, lp.key, 0, 2, 1n)]);
    await d.both("TradeNoCpi: a short against the long side", bob.key, [ix.tradeNoCpi(m, bob.key, alice.key, 1, 2, 1n)]);
    await d.both("TradeNoCpi: the long reduced", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, -1n)]);
    await d.both("TradeNoCpi: then another long", bob.key, [ix.tradeNoCpi(m, bob.key, lp.key, 0, 2, 1n)]);
  });
  it("TradeCpi: signers and writable accounts in the tail, as the matcher sees them", async () => {
    // The tail is forwarded with the flags the transaction gave each account (the original copies is_signer and
    // is_writable into the call's metas). The rogue matcher logs, for every account it receives, its index, its signer
    // and writable flags, its data length and lamports; `both()` compares those lines.
    const m = await d.market();
    const alice = await funded(m, 10n * SOL, "alice");
    const u = await d.user(m);
    const ctx = await d.address();
    d.write(ctx, ROGUE, Buffer.alloc(MATCHER_CTX_LEN));
    const idx = d.freeHead(m);
    await d.ok("rogue LP", u.key, [ix.initLp(m, u, ROGUE, ctx, 100n * SOL)]);
    const lp: Lp = { idx, matcher: ROGUE, ctx, pda: await lpPda(m, idx) };
    const extra = await d.funded();
    const other = await d.funded();
    const flagLines = () => d.lastLogs.split("\n").filter((l) => l.startsWith("Program log: 0xb5e7e3,"));
    for (const [what, mode, tail] of [
      ["the user again, signing", 1n | 2n | 4n | 8n | 16n | 512n, [s(alice.key)]],
      ["the user writable and signing, then a signer only in the tail", 1n | 2n | 4n | 8n | 16n | 512n, [ws(alice.key), s(extra)]],
      ["a writable signer, the slab, the LP PDA as a plain account", 1n | 2n | 4n | 8n | 16n | 512n, [ws(extra), w(m.slab), r(lp.pda)]],
      ["the fee payer and the LP owner unsigned", 1n | 2n | 4n | 8n | 16n | 512n, [s(alice.key), r(u.key.address), w(other.address)]],
      ["a signer in the tail, the slab logged first", 1n | 2n | 4n | 8n | 16n | 128n | 512n, [r(m.slab), s(extra), ws(other)]],
      ["a signer in the tail, a refused answer", 1n | 2n | 4n | 16n | 512n, [s(extra), w(other.address)]],
    ] as [string, bigint, ReturnType<typeof r>[]][]) {
      d.patch(ctx, (b) => {
        b.writeBigUInt64LE(mode, 128);
        Buffer.concat([u32(2), u32(1), u64(0n), i128((mode & 8n) !== 0n ? 0n : 7n), u64(0n), u64(0n), u64(0n), u64(0n)]).copy(b, 144);
      });
      await d.both(`TradeCpi: ${what}`, alice.key, [ix.tradeCpi(m, alice.key, u.key.address, lp, 0, 1_000_000n, 0n, tail)]);
      // The LP PDA (signer), the context (writable), then the tail as sent.
      const lines = flagLines();
      expect(lines.length, what).toBe(2 + tail.length);
      expect(lines[0], what).toMatch(/^Program log: 0xb5e7e3, 0x0, 0x1,/);
      expect(lines[1], what).toMatch(/^Program log: 0xb5e7e3, 0x1, 0x2,/);
      tail.forEach((t, k) => {
        // An account named twice in the call carries the union of its flags in both programs (the runtime merges them).
        const flags = (t.signer ? 1 : 0) | (t.writable ? 2 : 0);
        if (![lp.pda, alice.key.address, m.slab].includes(t.address))
          expect(lines[2 + k], `${what} #${k}`).toMatch(new RegExp(`^Program log: 0xb5e7e3, 0x${(2 + k).toString(16)}, 0x${flags.toString(16)},`));
      });
    }
  });

  it("the per-side cap on active positions, reached with real trades", async () => {
    // RiskParams.max_active_positions_per_side is max_accounts (InitMarket sets both from one field), and a side's
    // count cannot exceed the accounts in use less one (the other side holds the opposite position), so on a market
    // as InitMarket makes it the cap is never reached: three accounts on a market of three fill both sides without it.
    const small = await d.market({ edit: (a) => (a.maxAccounts = 3n) });
    const lp0 = await funded(small, 100n * SOL, "lp");
    const a0 = await funded(small, 10n * SOL, "a");
    const b0 = await funded(small, 10n * SOL, "b");
    await d.both("InitUser: a fourth account on a market of three", b0.key, [ix.initUser(small, b0, SOL)]);
    await d.ok("TradeNoCpi: a long", a0.key, [ix.tradeNoCpi(small, a0.key, lp0.key, 0, 1, 1_000_000n)]);
    await d.ok("TradeNoCpi: b long (two longs of three)", b0.key, [ix.tradeNoCpi(small, b0.key, lp0.key, 0, 2, 1_000_000n)]);
    expect(d.data(small.slab).readBigUInt64LE(E.storedPosCountLong)).toBe(2n);
    // The cap itself, written into both slabs below the counts the trades make (2), with real trades on both sides.
    const m = await d.market({ edit: (a) => (a.maxAccounts = 8n) });
    const lp = await funded(m, 1_000n * SOL, "lp");
    const traders: User[] = [];
    for (const name of ["alice", "bob", "carol", "dave"]) traders.push(await funded(m, 10n * SOL, name));
    const [alice, bob, carol, dave] = traders as [User, User, User, User];
    const cap = (n: bigint) => d.patch(m.slab, (b) => b.writeBigUInt64LE(n, E.params + P.maxActivePositionsPerSide));
    const counts = () => [d.data(m.slab).readBigUInt64LE(E.storedPosCountLong), d.data(m.slab).readBigUInt64LE(E.storedPosCountShort)];
    cap(2n);
    await d.ok("TradeNoCpi: alice long (longs 1, shorts 1)", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 2_000_000n)]);
    await d.ok("TradeNoCpi: bob long (longs 2)", bob.key, [ix.tradeNoCpi(m, bob.key, lp.key, 0, 2, 1_000_000n)]);
    await d.fails(
      "TradeNoCpi: carol long, a third long past the cap",
      carol.key,
      [ix.tradeNoCpi(m, carol.key, lp.key, 0, 3, 1_000_000n)],
      pe("EngineOverflow"),
    );
    await d.ok("TradeNoCpi: carol short against alice (shorts 2)", carol.key, [ix.tradeNoCpi(m, carol.key, alice.key, 1, 3, -1_000_000n)]);
    expect(counts()).toEqual([2n, 2n]);
    await d.fails("TradeNoCpi: dave short, a third short", dave.key, [ix.tradeNoCpi(m, dave.key, lp.key, 0, 4, -1_000_000n)], pe("EngineOverflow"));
    await d.fails("TradeNoCpi: bob flips to short (a third short)", bob.key, [ix.tradeNoCpi(m, bob.key, lp.key, 0, 2, -2_000_000n)], pe("EngineOverflow"));
    // A long closing into a new long: the net count is unchanged at the cap.
    await d.ok("TradeNoCpi: bob closes into dave's new long", dave.key, [ix.tradeNoCpi(m, dave.key, bob.key, 2, 4, 1_000_000n)]);
    expect(counts()).toEqual([2n, 2n]);
    await d.ok("TradeNoCpi: alice adds at the cap", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 1_000_000n)]);
    // The cap below the counts: a trade that leaves either side above it fails, a reduction included; one that brings
    // both down to it passes.
    cap(1n);
    await d.fails(
      "TradeNoCpi: dave reduces with both sides above the cap",
      dave.key,
      [ix.tradeNoCpi(m, dave.key, lp.key, 0, 4, -500_000n)],
      pe("EngineOverflow"),
    );
    await d.fails(
      "TradeNoCpi: dave closes, the shorts still above the cap",
      dave.key,
      [ix.tradeNoCpi(m, dave.key, lp.key, 0, 4, -1_000_000n)],
      pe("EngineOverflow"),
    );
    await d.ok("TradeNoCpi: dave and carol close against each other (longs 1, shorts 1)", dave.key, [ix.tradeNoCpi(m, dave.key, carol.key, 3, 4, -1_000_000n)]);
    expect(counts()).toEqual([1n, 1n]);
    await d.ok("TradeNoCpi: alice adds at a cap of 1", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 1_000_000n)]);
    // Through TradeCpi too (the passive matcher), at the cap and past it.
    const lpOwner = await d.user(m);
    const mlp = await d.lp(m, lpOwner, 500n * SOL);
    await d.fails(
      "TradeCpi: carol long against the matcher's LP, a second long past a cap of 1",
      carol.key,
      [ix.tradeCpi(m, carol.key, lpOwner.key.address, mlp, 3, 1_000_000n)],
      pe("EngineOverflow"),
    );
    cap(2n);
    await d.ok("TradeCpi: carol long at a cap of 2 (the LP's short a second short)", carol.key, [
      ix.tradeCpi(m, carol.key, lpOwner.key.address, mlp, 3, 1_000_000n),
    ]);
    expect(counts()).toEqual([2n, 2n]);
    await d.fails("TradeCpi: dave long, a third", dave.key, [ix.tradeCpi(m, dave.key, lpOwner.key.address, mlp, 4, 1_000_000n)], pe("EngineOverflow"));
  });

  it("ADL edges: K without headroom (the haircut fallback), precision exhausted, a crank stopping on a pending reset", async () => {
    // The shorts' K is written into both slabs for the fallbacks: no sequence of instructions brings |K| near i128::MAX
    // (an accrual moves it by at most A · |Δp| <= 10^27, an ADL step by at most D · A · 10^6 / OI with D below the
    // 10^16 vault cap), and a step past i128::MAX by itself needs D above 1.7 · 10^17.
    const setup = async () => {
      const m = await d.market();
      const lp1 = await funded(m, 200n * SOL, "lp1");
      const alice = await funded(m, 10n * SOL, "alice");
      const lp2 = await funded(m, 2n * SOL, "lp2");
      const bob = await funded(m, 2n * SOL, "bob");
      await d.ok("TradeNoCpi: alice long 9 against lp1", alice.key, [ix.tradeNoCpi(m, alice.key, lp1.key, 0, 1, 900_000_000n)]);
      d.setClock(d.slot + 5n);
      d.setPrice(m, 70_000_000n);
      // The trade at the low accrues the market to it: the liquidation below accrues nothing more.
      await d.ok("TradeNoCpi: bob long 2 against lp2 at the low", bob.key, [ix.tradeNoCpi(m, bob.key, lp2.key, 2, 3, 200_000_000n)]);
      return { m, bob };
    };
    const { m, bob } = await setup();
    const before = Buffer.from(d.data(m.slab));
    const restore = () => d.patch(m.slab, (b) => before.copy(b));
    const k0 = readI128(before, E.adlCoeffShort);
    await d.ok("LiquidateAtOracle: the loss written into K_short", bob.key, [ix.liquidate(m, bob.key, 1)]);
    const deltaK = readI128(d.data(m.slab), E.adlCoeffShort) - k0;
    expect(deltaK < 0n).toBe(true);
    const aShort = readU128(before, E.adlMultShort);
    expect(aShort).toBe(ADL_ONE);
    const headroom = I128_MAX - aShort * MAX_ORACLE_PRICE;
    for (const [label, k, applied] of [
      ["K_short at the headroom bound less the step (applied)", -(headroom + deltaK), true],
      ["K_short one past it (the haircut)", -(headroom + deltaK) - 1n, false],
      ["K_short at i128::MIN + 1 (K + delta overflows: the haircut)", -I128_MAX, false],
    ] as [string, bigint, boolean][]) {
      restore();
      d.patch(m.slab, (b) => writeU128(b, E.adlCoeffShort, BigInt.asUintN(128, k)));
      await d.ok(`LiquidateAtOracle: ${label}`, bob.key, [ix.liquidate(m, bob.key, 1)]);
      expect(readI128(d.data(m.slab), E.adlCoeffShort), label).toBe(applied ? k + deltaK : k);
    }
    // A step past i128::MAX by itself, and A past u128::MAX / POS_SCALE (EngineOverflow), with A written in.
    for (const [label, a] of [
      ["A_short 10^30: the step past i128::MAX (the haircut)", 10n ** 30n],
      ["A_short above u128::MAX / 10^6", (1n << 128n) / 1_000_000n + 1n],
    ] as [string, bigint][]) {
      restore();
      d.patch(m.slab, (b) => writeU128(b, E.adlMultShort, a));
      await d.both(`LiquidateAtOracle: ${label}`, bob.key, [ix.liquidate(m, bob.key, 1)]);
    }
    // Precision exhausted: A_candidate = floor(A_old · OI_post / OI) = 0 with OI_post > 0, both sides drain to zero and
    // reset. It needs A_old < OI on the opposite side, which no instruction makes: a side takes new positions only in
    // Normal mode, where A >= MIN_A_SIDE = 10^14 >= MAX_OI_SIDE_Q >= OI, and from then on OI only falls and each ADL
    // step keeps A >= OI (floor(A · OI_post / OI) >= OI_post). A_short is written in.
    for (const a of [1n, 1_099_999_999n / 200_000_000n]) {
      restore();
      d.patch(m.slab, (b) => writeU128(b, E.adlMultShort, a));
      await d.ok(`LiquidateAtOracle: A_short ${a}, precision exhausted`, bob.key, [ix.liquidate(m, bob.key, 1)]);
      const after = d.data(m.slab);
      expect([readU128(after, E.oiEffLongQ), readU128(after, E.oiEffShortQ)]).toEqual([0n, 0n]);
      expect([after[E.sideModeLong], after[E.sideModeShort]]).toEqual([2, 2]);
    }
    // One past: A_old · OI_post = OI exactly leaves A_candidate 1.
    restore();
    d.patch(m.slab, (b) => writeU128(b, E.adlMultShort, 1_100_000_000n / 200_000_000n + 1n));
    await d.ok("LiquidateAtOracle: A_short just enough (A_candidate 1)", bob.key, [ix.liquidate(m, bob.key, 1)]);
    expect(readU128(d.data(m.slab), E.oiEffShortQ)).toBe(200_000_000n);
    expect(readU128(d.data(m.slab), E.adlMultShort)).toBe(1n);

    // KeeperCrank stopping once a reset is pending: the only short (an LP) liquidated empties the short side and the
    // longs' OI with it, so both sides begin a reset, and the accounts after it are not touched (a touch settles a
    // long's gain at 110 into its PnL and moves its K snapshot; the fee sweep, which syncs every account's fees, says
    // nothing about touches). The trades leave the four largest notionals in the risk buffer, the LP among them (an
    // account that holds a whole side has the largest notional), so with real instructions the stop comes in the
    // buffer's loop and the instruction's candidates are never reached. For the stop inside the candidates' loop the
    // buffer is emptied in both slabs first (count 0, as on a market before its first trade).
    const crankMarket = async () => {
      const n = await d.market({ edit: (a) => (a.maintenanceFeePerSlot = 1000n) });
      const lp = await funded(n, 20n * SOL, "lp");
      for (const [i, name] of ["x", "y", "z"].entries()) {
        const u = await funded(n, 100n * SOL, name);
        await d.ok(`TradeNoCpi: ${name} long 6`, u.key, [ix.tradeNoCpi(n, u.key, lp.key, 0, 1 + i, 600_000_000n)]);
      }
      return n;
    };
    const keeper = await d.funded();
    const touchState = (b: Buffer, i: number) => [readI128(b, accountAt(i) + A.pnl), readI128(b, accountAt(i) + A.adlKSnap)];
    const touched = (b0: Buffer, b1: Buffer) => [1, 2, 3].filter((i) => touchState(b0, i).join() !== touchState(b1, i).join());
    const n = await crankMarket();
    d.setClock(d.slot + 10n);
    d.setPrice(n, 110_000_000n);
    d.patch(n.slab, (b) => (b[RISK_BUF_COUNT] = 0));
    const pre = Buffer.from(d.data(n.slab));
    await d.ok("KeeperCrank: the LP first, then the longs (an empty risk buffer)", keeper, [
      ix.crank(n, keeper, 65535, [
        [0, 0],
        [1, 0xff],
        [2, 0xff],
        [3, 0xff],
      ]),
    ]);
    let post = d.data(n.slab);
    expect(readI128(post, accountAt(0) + A.positionBasisQ)).toBe(0n);
    expect([readU128(post, E.oiEffLongQ), readU128(post, E.oiEffShortQ)]).toEqual([0n, 0n]);
    // The longs, still stored, are stale under a reset; the short side, empty, reopens at once.
    expect([post[E.sideModeLong], post[E.sideModeShort]]).toEqual([2, 0]);
    expect(touched(pre, post)).toEqual([]);
    // The control: the same crank with the longs first touches them.
    const c = await crankMarket();
    d.setClock(d.slot + 10n);
    d.setPrice(c, 110_000_000n);
    d.patch(c.slab, (b) => (b[RISK_BUF_COUNT] = 0));
    const cpre = Buffer.from(d.data(c.slab));
    await d.ok("KeeperCrank: the longs first, then the LP (an empty risk buffer)", keeper, [
      ix.crank(c, keeper, 65535, [
        [1, 0xff],
        [2, 0xff],
        [3, 0xff],
        [0, 0],
      ]),
    ]);
    expect(touched(cpre, d.data(c.slab))).toEqual([1, 2, 3]);
    // The risk buffer as the trades left it, and candidates after it: the buffer's entries in order, stopping at the
    // reset; the candidates (the longs again, touch only) are not reached.
    const o = await crankMarket();
    d.setClock(d.slot + 10n);
    d.setPrice(o, 110_000_000n);
    const opre = Buffer.from(d.data(o.slab));
    await d.ok("KeeperCrank: the risk buffer, then candidates", keeper, [
      ix.crank(o, keeper, 65535, [
        [2, 0xff],
        [3, 0xff],
      ]),
    ]);
    post = d.data(o.slab);
    // The trades left the buffer as [x, the LP, y, z]: x is touched, the LP liquidated, the rest skipped.
    const buf = [0, 1, 2, 3].slice(0, opre[RISK_BUF_COUNT]!).map((k) => opre.readUInt16LE(RISK_BUF_ENTRIES + 32 * k));
    expect(buf).toEqual([1, 0, 2, 3]);
    expect(readI128(post, accountAt(0) + A.positionBasisQ)).toBe(0n);
    expect([post[E.sideModeLong], post[E.sideModeShort]]).toEqual([2, 0]);
    expect(touched(opre, post)).toEqual([1]);
  });

  it("boundaries in a written slab: the scan cursor at 4,096, dust exactly the clear bound, a drain-only empty short side, K at i128::MIN", async () => {
    // A 24-account market whose risk-buffer scan cursor is written to 4,096: read_risk_buffer resets it to 0 (at or past
    // MAX_ACCOUNTS), and the trade writes the buffer back so.
    const m = await d.market({ edit: (a) => (a.maxAccounts = 24n) });
    const lp = await funded(m, 100n * SOL, "lp");
    const alice = await funded(m, 10n * SOL, "alice");
    await d.ok("TradeNoCpi: alice long", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 10_000_000n)]);
    d.patch(m.slab, (b) => b.writeUInt16LE(4096, RISK_BUF_OFF));
    await d.ok("TradeNoCpi: the scan cursor at 4,096", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 10_000_000n)]);
    expect(d.data(m.slab).readUInt16LE(RISK_BUF_OFF)).toBe(0);
    // No stored positions, OI 5 on each side and phantom dust bounds 2 + 3: the residue is within the clear bound
    // (5 <= 5), so both sides reset.
    const n = await d.market();
    await funded(n, SOL, "bob");
    d.patch(n.slab, (b) => {
      writeU128(b, E.oiEffLongQ, 5n);
      writeU128(b, E.oiEffShortQ, 5n);
      writeU128(b, E.phantomDustBoundLongQ, 2n);
      writeU128(b, E.phantomDustBoundShortQ, 3n);
    });
    await d.ok("SettleAccount: dust exactly the clear bound", alice.key, [ix.settleAccount(n, 0)]);
    expect(d.data(n.slab).readBigUInt64LE(E.adlEpochLong)).toBe(1n);
    // The short side drain-only with no OI: reset at the end of the instruction.
    const q = await d.market();
    await funded(q, SOL, "carol");
    d.patch(q.slab, (b) => (b[E.sideModeShort] = 1));
    await d.ok("SettleAccount: a drain-only short side with no OI", alice.key, [ix.settleAccount(q, 0)]);
    expect(d.data(q.slab).readBigUInt64LE(E.adlEpochShort)).toBe(1n);
    expect(d.data(q.slab)[E.sideModeShort]).toBe(0);
    // The longs' K written to i128::MIN + A · 10^6: a fall of 1 (e6) takes it to exactly i128::MIN, which fits.
    const k = await d.market();
    const klp = await funded(k, 100n * SOL, "lp");
    const kal = await funded(k, 10n * SOL, "alice");
    await d.ok("TradeNoCpi: alice long (K)", kal.key, [ix.tradeNoCpi(k, kal.key, klp.key, 0, 1, 100_000_000n)]);
    d.patch(k.slab, (b) => i128(-(2n ** 127n) + ADL_ONE * 1_000_000n).copy(b, E.adlCoeffLong));
    d.setClock(d.slot + 2n);
    d.setPrice(k, 99_000_000n);
    await d.ok("SettleAccount: the longs' K to exactly i128::MIN", klp.key, [ix.settleAccount(k, 0)]);
    expect(readI128(d.data(k.slab), E.adlCoeffLong)).toBe(-(2n ** 127n));
  });

  it("the funding rate one below its negative clamp; a partial catch-up on a Hyperp market keeps the index slot", async () => {
    // The mark EWMA (100) below the index (101): the rate before its clamp is computed here from the slab, and
    // funding_max_e9_per_slot set one below its magnitude, so the clamp to -max applies by exactly one.
    const m = await d.market({
      edit: (a) => {
        a.minOraclePriceCapE2bps = 1_000_000n;
        a.tail!.permissionlessResolveStaleSlots = 0n;
      },
    });
    const lp = await funded(m, 1_000n * SOL, "lp");
    const alice = await funded(m, 100n * SOL, "alice");
    await d.ok("TradeNoCpi: alice long", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 100_000_000n)]);
    d.setClock(d.slot + 10n);
    d.setPrice(m, 101_000_000n);
    await d.ok("SettleAccount: the index above the mark", alice.key, [ix.settleAccount(m, 1)]);
    const mark = d.data(m.slab).readBigUInt64LE(C.markEwmaE6);
    const index = d.data(m.slab).readBigUInt64LE(C.lastEffectivePriceE6);
    const horizon = 1000n;
    const perSlot = ((((mark - index) * 1_000_000_000n) / index) * 100n) / 100n / horizon;
    expect(perSlot < 0n && -perSlot - 1n <= 10_000n).toBe(true);
    await d.ok("UpdateConfig: max one below the rate", m.admin, [
      ix.updateConfig(m, m.admin, { horizon, kBps: 100n, maxPremiumBps: 500n, maxE9PerSlot: -perSlot - 1n, tvlCapMult: 0 }),
    ]);
    d.setClock(d.slot + 10n);
    d.setPrice(m, 101_000_000n);
    await d.ok("SettleAccount: funding at the clamp", alice.key, [ix.settleAccount(m, 1)]);
    // A Hyperp market 45 envelopes on, its mark (written in) pushed just now and 0.5% above the index: CatchupAccrue
    // takes the partial path and restores the index and its slot.
    const h = await d.market({
      edit: (a) => {
        a.feedId = Buffer.alloc(32);
        a.initialMarkPriceE6 = 1_000_000n;
        a.tail!.permissionlessResolveStaleSlots = 0n;
      },
    });
    const carol = await funded(h, 100n * SOL, "carol");
    const lpOwner = await d.user(h);
    const hlp = await d.lp(h, lpOwner, 500n * SOL);
    await d.ok("TradeCpi", carol.key, [ix.tradeCpi(h, carol.key, lpOwner.key.address, hlp, 0, 50_000_000n)]);
    d.setClock(d.slot + 450_000_000n);
    const indexSlot = d.data(h.slab).readBigUInt64LE(C.lastHyperpIndexSlot);
    d.patch(h.slab, (b) => {
      b.writeBigUInt64LE(1_005_000n, C.markEwmaE6);
      writeU128(b, C.lastMarkPushSlot, d.slot);
    });
    await d.ok("CatchupAccrue: partial on Hyperp", carol.key, [ix.catchupAccrue(h)]);
    expect(d.data(h.slab).readBigUInt64LE(C.lastHyperpIndexSlot)).toBe(indexSlot);
  });
});
