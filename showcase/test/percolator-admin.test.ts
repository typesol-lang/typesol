// Percolator v12.20 (showcase/mainnet/percolator) against the mainnet binary: the admin and authority instructions,
// UpdateConfig, SetOraclePriceCap, PushHyperpMark, UpdateAuthority and CloseSlab, success paths and refusals.
import { generateKeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  C,
  Diff,
  E,
  H,
  HAVE_ORIGINAL,
  SOL,
  SYSTEM,
  builtin,
  computeUnits,
  cuSummary,
  defaultInitArgs,
  instruction,
  ix,
  key,
  passiveMatcher,
  pe,
  readI128,
  readonly,
  replace,
  tokenTransfer,
  truncate,
  unsigned,
  w,
  ws,
} from "./percolator-helpers.js";

const CONFIG = { horizon: 700n, kBps: 150n, maxPremiumBps: 300n, maxE9PerSlot: 2000n, tvlCapMult: 20 };
const ZERO = "11111111111111111111111111111111" as const;

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: admin instructions", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });
  afterAll(() => {
    if (process.env.PERCOLATOR_CU) console.table(cuSummary(d.rows));
  });

  const hyperp = (m: { feedId?: Buffer }) => (a: Parameters<NonNullable<Parameters<Diff["market"]>[0]>["edit"] & {}>[0]) => {
    a.feedId = Buffer.alloc(32);
    a.initialMarkPriceE6 = 1_000_000n;
    a.tail!.markMinFee = 10n;
    void m;
  };

  it("UpdateConfig", async () => {
    // A circuit breaker (100%) so that trades move the mark EWMA, which funding is computed from.
    const m = await d.market({ edit: (a) => (a.minOraclePriceCapE2bps = 1_000_000n) });
    const other = await d.funded();
    await d.ok("UpdateConfig", m.admin, [ix.updateConfig(m, m.admin, CONFIG)]);
    expect(d.data(m.slab).readUInt16LE(C.tvlInsuranceCapMult)).toBe(20);
    await d.ok("UpdateConfig, cap off", m.admin, [ix.updateConfig(m, m.admin, { ...CONFIG, tvlCapMult: 0 })]);
    await d.fails("UpdateConfig: not the admin", other, [ix.updateConfig(m, other, CONFIG)], pe("EngineUnauthorized"));
    await d.fails("UpdateConfig: not signed", other, [unsigned(ix.updateConfig(m, m.admin, CONFIG), 0)], pe("ExpectedSigner"));
    await d.fails("UpdateConfig: slab read-only", m.admin, [readonly(ix.updateConfig(m, m.admin, CONFIG), 1)], pe("ExpectedWritable"));
    await d.fails("UpdateConfig: 3 accounts", m.admin, [truncate(ix.updateConfig(m, m.admin, CONFIG), 3)], builtin("NotEnoughAccountKeys"));
    for (const [label, c, err] of [
      ["horizon 0", { ...CONFIG, horizon: 0n }, pe("InvalidConfigParam")],
      ["negative premium cap", { ...CONFIG, maxPremiumBps: -1n }, pe("InvalidConfigParam")],
      ["negative rate cap", { ...CONFIG, maxE9PerSlot: -1n }, pe("InvalidConfigParam")],
      ["rate cap above the envelope", { ...CONFIG, maxE9PerSlot: 10_001n }, pe("InvalidConfigParam")],
      ["k above 1000x", { ...CONFIG, kBps: 100_001n }, pe("InvalidConfigParam")],
    ] as [string, typeof CONFIG, string][])
      await d.fails(`UpdateConfig: ${label}`, m.admin, [ix.updateConfig(m, m.admin, c)], err);
    // Accrual to the boundary with the funding rate as it was: open interest and a mark above the index (buys from a
    // matcher quoting 95 bps over the oracle) make it nonzero.
    const alice = await d.user(m);
    const lpOwner = await d.user(m);
    await d.ok("InitUser alice", alice.key, [ix.initUser(m, alice, 50n * SOL)]);
    const lp = await d.lp(m, lpOwner, 50n * SOL, passiveMatcher({ baseSpreadBps: 90, tradingFeeBps: 5, maxTotalBps: 95 }));
    await d.ok("TradeCpi: alice buys (the mark seeds at the index)", alice.key, [ix.tradeCpi(m, alice.key, lpOwner.key.address, lp, 0, 5_000_000n)]);
    d.setClock(d.slot + 50n);
    await d.ok("TradeCpi: alice buys (the mark moves above the index)", alice.key, [ix.tradeCpi(m, alice.key, lpOwner.key.address, lp, 0, 5_000_000n)]);
    expect(d.data(m.slab).readBigUInt64LE(C.markEwmaE6)).toBeGreaterThan(100_000_000n);
    d.setClock(d.slot + 100n);
    d.setPrice(m, 101_000_000n);
    await d.ok("UpdateConfig accrues with the old rate", m.admin, [ix.updateConfig(m, m.admin, { ...CONFIG, tvlCapMult: 0 })]);
    expect(readI128(d.data(m.slab), E.fLongNum)).not.toBe(0n);
    // A dead oracle: the degenerate arm (rate 0, the engine's last price); other oracle errors pass through.
    d.setClock(d.slot + 100n);
    d.setPrice(m, 101_000_000n, d.unixTimestamp - 5000n);
    await d.ok("UpdateConfig with a stale oracle (degenerate)", m.admin, [ix.updateConfig(m, m.admin, CONFIG)]);
    d.setPrice(m, 101_000_000n, d.unixTimestamp, -6, 9_000_000n);
    await d.ok("UpdateConfig with a wide oracle (degenerate)", m.admin, [ix.updateConfig(m, m.admin, CONFIG)]);
    d.write(m.oracle, SYSTEM, Buffer.alloc(134));
    await d.fails("UpdateConfig: oracle of another owner", m.admin, [ix.updateConfig(m, m.admin, CONFIG)], builtin("IllegalOwner"));
    d.setPrice(m, 101_000_000n);
    d.setClock(d.slot + 6000n);
    await d.fails("UpdateConfig: matured stale", m.admin, [ix.updateConfig(m, m.admin, CONFIG)], pe("OracleStale"));
    await d.ok("ResolveMarket (the hard timeout)", m.admin, [ix.resolveMarket(m, m.admin)]);
    await d.fails("UpdateConfig: resolved", m.admin, [ix.updateConfig(m, m.admin, CONFIG)], builtin("InvalidAccountData"));
  });

  it("SetOraclePriceCap", async () => {
    const m = await d.market({ edit: (a) => (a.minOraclePriceCapE2bps = 100n) });
    const other = await d.funded();
    await d.ok("SetOraclePriceCap", m.admin, [ix.setOraclePriceCap(m, m.admin, 5000n)]);
    await d.fails("SetOraclePriceCap: below the floor", m.admin, [ix.setOraclePriceCap(m, m.admin, 99n)], pe("InvalidConfigParam"));
    await d.fails("SetOraclePriceCap: 0 with a floor", m.admin, [ix.setOraclePriceCap(m, m.admin, 0n)], pe("InvalidConfigParam"));
    await d.fails("SetOraclePriceCap: above 100%", m.admin, [ix.setOraclePriceCap(m, m.admin, 1_000_001n)], pe("InvalidConfigParam"));
    await d.fails("SetOraclePriceCap: not the admin", other, [ix.setOraclePriceCap(m, other, 5000n)], pe("EngineUnauthorized"));
    await d.fails("SetOraclePriceCap: wrong clock", m.admin, [replace(ix.setOraclePriceCap(m, m.admin, 5000n), 2, other.address)], builtin("InvalidArgument"));
    const m2 = await d.market({ edit: (a) => Object.assign(a, { minOraclePriceCapE2bps: 0n }) && (a.tail!.permissionlessResolveStaleSlots = 3000n) });
    await d.ok("SetOraclePriceCap: 0 without a floor", m2.admin, [ix.setOraclePriceCap(m2, m2.admin, 0n)]);
    const h = await d.market({ edit: hyperp({}) });
    d.setClock(d.slot + 30n);
    await d.ok("SetOraclePriceCap on Hyperp (flushes the index, accrues)", h.admin, [ix.setOraclePriceCap(h, h.admin, 20_000n)]);
    await d.fails("SetOraclePriceCap: 0 on Hyperp", h.admin, [ix.setOraclePriceCap(h, h.admin, 0n)], pe("InvalidConfigParam"));
  });

  it("PushHyperpMark", async () => {
    const m = await d.market({ edit: hyperp({}) });
    const other = await d.funded();
    await d.ok("PushHyperpMark", m.admin, [ix.pushHyperpMark(m, m.admin, 1_050_000n, 123n)]);
    d.setClock(d.slot + 5n);
    await d.ok("PushHyperpMark clamped", m.admin, [ix.pushHyperpMark(m, m.admin, 9_000_000n, 0n)]);
    d.setClock(d.slot + 500n);
    await d.ok("PushHyperpMark after a while (EWMA)", m.admin, [ix.pushHyperpMark(m, m.admin, 900_000n, 0n)]);
    await d.fails("PushHyperpMark: price 0", m.admin, [ix.pushHyperpMark(m, m.admin, 0n, 0n)], pe("OracleInvalid"));
    await d.fails("PushHyperpMark: not the authority", other, [ix.pushHyperpMark(m, other, 1_000_000n, 0n)], pe("EngineUnauthorized"));
    await d.fails("PushHyperpMark: above the max", m.admin, [ix.pushHyperpMark(m, m.admin, 10n ** 12n + 1n, 0n)], pe("OracleInvalid"));
    await d.fails("PushHyperpMark: 1 account", m.admin, [truncate(ix.pushHyperpMark(m, m.admin, 1n, 0n), 1)], builtin("NotEnoughAccountKeys"));
    const p = await d.market();
    await d.fails("PushHyperpMark on a Pyth market", p.admin, [ix.pushHyperpMark(p, p.admin, 1_000_000n, 0n)], pe("EngineUnauthorized"));
  });

  it("UpdateAuthority", async () => {
    const m = await d.market();
    const next = await d.funded();
    const other = await d.funded();
    for (const kind of [2, 4]) {
      await d.ok(`UpdateAuthority ${kind} to next`, m.admin, [ix.updateAuthority(m, m.admin, kind, next.address, next)]);
      await d.fails(`UpdateAuthority ${kind}: old authority`, m.admin, [ix.updateAuthority(m, m.admin, kind, other.address, other)], pe("EngineUnauthorized"));
      await d.ok(`UpdateAuthority ${kind} burned`, next, [ix.updateAuthority(m, next, kind, ZERO as never)]);
    }
    await d.fails("UpdateAuthority: new key not signed", m.admin, [ix.updateAuthority(m, m.admin, 0, next.address)], pe("ExpectedSigner"));
    await d.fails(
      "UpdateAuthority: new key differs",
      m.admin,
      [replace(ix.updateAuthority(m, m.admin, 0, next.address, next), 1, other.address)],
      pe("ExpectedSigner"),
    );
    await d.fails(
      "UpdateAuthority: the new key signs but is another",
      m.admin,
      [instruction(Buffer.concat([Buffer.from([32, 0]), key(next.address)]), [ws(m.admin), ws(other), w(m.slab)])],
      builtin("InvalidArgument"),
    );
    await d.fails("UpdateAuthority: kind 3", m.admin, [ix.updateAuthority(m, m.admin, 3, next.address, next)], builtin("InvalidInstructionData"));
    await d.fails("UpdateAuthority: hyperp kind on a Pyth market", m.admin, [ix.updateAuthority(m, m.admin, 1, next.address, next)], pe("EngineUnauthorized"));
    await d.ok("UpdateAuthority admin to next", m.admin, [ix.updateAuthority(m, m.admin, 0, next.address, next)]);
    expect(Buffer.from(d.data(m.slab).subarray(H.admin, H.admin + 32))).toEqual(key(next.address));
    await d.fails("UpdateAuthority: 2 accounts", next, [truncate(ix.updateAuthority(m, next, 0, other.address, other), 2)], builtin("NotEnoughAccountKeys"));
    await d.ok("UpdateAuthority admin burned", next, [ix.updateAuthority(m, next, 0, ZERO as never)]);
    await d.fails("UpdateConfig after the burn", next, [ix.updateConfig(m, next, CONFIG)], pe("EngineUnauthorized"));
    // Burning admin needs a way to resolve and to force-close.
    const m2 = await d.market({ edit: (a) => Object.assign(a, { minOraclePriceCapE2bps: 1n }) && (a.tail!.permissionlessResolveStaleSlots = 0n) });
    await d.fails("UpdateAuthority: admin burn without perm-resolve", m2.admin, [ix.updateAuthority(m2, m2.admin, 0, ZERO as never)], pe("InvalidConfigParam"));
    // Hyperp authority.
    const h = await d.market({ edit: hyperp({}) });
    await d.ok("UpdateAuthority hyperp to next", h.admin, [ix.updateAuthority(h, h.admin, 1, next.address, next)]);
    d.patch(h.slab, (b) => b.writeBigUInt64LE(0n, C.markEwmaE6));
    await d.fails("UpdateAuthority: hyperp burn before the EWMA", next, [ix.updateAuthority(h, next, 1, ZERO as never)], pe("InvalidConfigParam"));
    d.setClock(d.slot + 6000n);
    await d.fails("UpdateAuthority: transfer past maturity", h.admin, [ix.updateAuthority(h, h.admin, 0, other.address, other)], pe("OracleStale"));
    await d.ok("UpdateAuthority: burn past maturity", h.admin, [ix.updateAuthority(h, h.admin, 2, ZERO as never)]);
  });

  it("CloseSlab", async () => {
    const m = await d.market();
    const adminAta = await d.tokenAccount(m.mint, m.admin.address);
    await d.fails("CloseSlab: live market", m.admin, [ix.closeSlab(m, adminAta)], builtin("InvalidAccountData"));
    const ins = await d.user(m);
    await d.ok("TopUpInsurance", ins.key, [ix.topUpInsurance(m, ins, 5n)]);
    await d.ok("ResolveMarket", m.admin, [ix.resolveMarket(m, m.admin)]);
    const other = await d.funded();
    await d.fails("CloseSlab: not the admin", other, [ix.closeSlab({ ...m, admin: other }, adminAta)], pe("EngineUnauthorized"));
    await d.fails("CloseSlab: 5 accounts", m.admin, [truncate(ix.closeSlab(m, adminAta), 5)], builtin("NotEnoughAccountKeys"));
    // Insurance left: the vault (which holds it) is not empty, the first of the two checks.
    await d.fails("CloseSlab: insurance left", m.admin, [ix.closeSlab(m, adminAta)], pe("EngineInsufficientBalance"));
    await d.ok("WithdrawInsurance", m.admin, [ix.withdrawInsurance(m, m.admin, adminAta)]);
    // Stranded tokens (sent to the vault by an SPL Token transfer, not through the program) go to the admin's token
    // account, then the vault is closed and the slab drained.
    await d.ok("SPL Token transfer into the vault", ins.key, [tokenTransfer(ins.ata, m.vault, ins.key, 777n)]);
    await d.fails("CloseSlab: wrong vault authority", m.admin, [replace(ix.closeSlab(m, adminAta), 3, other.address)], builtin("InvalidSeeds"));
    await d.ok("CloseSlab", m.admin, [ix.closeSlab(m, adminAta)], [m.vault, m.slab]);
    expect(d.original.getAccount(m.slab).exists).toBe(false);
    expect(d.amount(adminAta)).toBe(5n + 777n);
    // An empty vault: no transfer, only the close.
    const m2 = await d.market();
    await d.ok("ResolveMarket (m2)", m2.admin, [ix.resolveMarket(m2, m2.admin)]);
    await d.ok("CloseSlab, empty vault", m2.admin, [ix.closeSlab(m2, adminAta)], [m2.vault, m2.slab]);
  });

  it("the slab passed again where the original holds its borrow across a CPI", async () => {
    // The original keeps `slab.try_borrow_mut_data()` across the SPL Token calls of InitUser, InitLP,
    // DepositCollateral, TopUpInsurance and CloseSlab. solana-program's `invoke` borrows every account it passes (data
    // and lamports, mutably for a writable one) before the call, so the slab named again among the accounts of the call
    // fails it with AccountBorrowFailed. That needs the slab's keypair (the user, the admin) or an account the original
    // does not check before the call (CloseSlab's vault authority while no stranded tokens are drained). The tests sign
    // with the slab's keypair, as whoever created the slab account can. Every other aliasing of the slab with a
    // token account, the vault, the vault PDA, the clock or the oracle is refused by an owner or key check first.
    const slabKey = await generateKeyPairSigner();
    const payer = await d.funded();
    const m0 = await d.newMarket({ slab: slabKey });
    const m = { ...m0, admin: slabKey };
    await d.ok("InitMarket: the slab its own admin", payer, [computeUnits(1_400_000), ix.initMarket(m, defaultInitArgs(slabKey.address, m.mint))]);
    expect(Buffer.from(d.data(m.slab).subarray(H.admin, H.admin + 32))).toEqual(key(slabKey.address));
    const asSlab = { key: slabKey, ata: await d.tokenAccount(m.mint, slabKey.address, 1_000n * SOL) };
    await d.fails("InitUser: the slab as the user", payer, [ix.initUser(m, asSlab, SOL)], builtin("AccountBorrowFailed"));
    await d.fails("InitLP: the slab as the user", payer, [ix.initLp(m, asSlab, SYSTEM, SYSTEM, SOL)], builtin("AccountBorrowFailed"));
    await d.fails("TopUpInsurance: the slab as the payer of the tokens", payer, [ix.topUpInsurance(m, asSlab, SOL)], builtin("AccountBorrowFailed"));
    // No transfer, no borrow: the refusal of a zero amount is the original's own.
    const zero = await d.both("TopUpInsurance: the slab, nothing", payer, [ix.topUpInsurance(m, asSlab, 0n)]);
    expect(zero).not.toBe(builtin("AccountBorrowFailed"));
    // DepositCollateral transfers before the engine looks for the account: the call fails first, though the slab owns
    // no account (InitUser and InitLP refuse it one above).
    await d.fails("DepositCollateral: the slab, owning nothing", payer, [ix.deposit(m, asSlab, 0, SOL)], builtin("AccountBorrowFailed"));
    // Where no CPI names it, the slab as a signer is only a key: the crank, the authorities.
    const ins = await d.user(m);
    await d.ok("TopUpInsurance", ins.key, [ix.topUpInsurance(m, ins, 5n * SOL)]);
    await d.ok("KeeperCrank: the slab as the caller", payer, [ix.crank(m, slabKey, 65535)]);
    await d.ok("ResolveMarket by the slab", payer, [ix.resolveMarket(m, slabKey)]);
    await d.ok("WithdrawInsurance by the slab", payer, [ix.withdrawInsurance(m, slabKey, asSlab.ata)]);
    const adminAta = await d.tokenAccount(m.mint, m0.admin.address);
    // CloseSlab with the admin (the lamports' destination) the slab: the vault's close names it.
    await d.fails("CloseSlab: the slab its own destination", payer, [ix.closeSlab(m, asSlab.ata)], builtin("AccountBorrowFailed"));
    await d.ok("UpdateAuthority: admin from the slab", payer, [ix.updateAuthority(m, slabKey, 0, m0.admin.address, m0.admin)]);
    // The vault authority is checked only before a drain: with nothing stranded the slab there reaches the call.
    await d.fails("CloseSlab: the slab as the vault authority", m0.admin, [replace(ix.closeSlab(m0, adminAta), 3, m.slab)], builtin("AccountBorrowFailed"));
    await d.ok("SPL Token transfer into the vault", ins.key, [tokenTransfer(ins.ata, m.vault, ins.key, 9n)]);
    await d.fails("CloseSlab: the slab as the vault authority, a drain", m0.admin, [replace(ix.closeSlab(m0, adminAta), 3, m.slab)], builtin("InvalidSeeds"));
    await d.ok("UpdateAuthority: admin back to the slab", payer, [ix.updateAuthority(m, m0.admin, 0, slabKey.address, slabKey)]);
    await d.fails("CloseSlab: the slab its own destination, a drain", payer, [ix.closeSlab(m, asSlab.ata)], builtin("AccountBorrowFailed"));
    await d.ok("UpdateAuthority: admin from the slab again", payer, [ix.updateAuthority(m, slabKey, 0, m0.admin.address, m0.admin)]);
    await d.ok("CloseSlab", m0.admin, [ix.closeSlab(m0, adminAta)], [m.vault, m.slab]);
    expect(d.amount(adminAta)).toBe(9n);
  });
});
