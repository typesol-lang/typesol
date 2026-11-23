// The refusals of InitMarket, InitPortfolio, Deposit and ClosePortfolio of the Percolator v16 port, each compared whole
// with the reference (Percolator v16 at commit 7b110913, engine 5e3af07, aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so, the Rust build of those commits, not a deployed
// program), and a seeded random fuzz of InitMarket's arguments (the configuration checks and the exact solvency
// envelope) and of Deposit's amount. PERCOLATOR_V16_INIT_FUZZ (300) sizes the InitMarket fuzz.
import { type Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { Diff, HAVE_PORT, HAVE_REFERENCE, type InitMarketArgs, PROGRAM, TOKEN, TOKEN_2022, defaultInitArgs, err, errB, ix } from "./percolator-v16-helpers.js";
import { marketLen } from "./percolator-v16-layout.js";
import { mintBytes, tokenAccountBytes } from "./percolator-helpers.js";

const INIT_FUZZ = Number(process.env.PERCOLATOR_V16_INIT_FUZZ ?? 300);
const SEED = BigInt(process.env.PERCOLATOR_FUZZ_SEED ?? "1618");
const E = { AlreadyInitialized: 2, NotInitialized: 3, InvalidAccountKind: 4, InvalidAccountLen: 5, ExpectedSigner: 6, ExpectedWritable: 7, Unauthorized: 8 };
const C = { InvalidInstruction: 9, InvalidMint: 10, InvalidTokenAccount: 11, InvalidVaultAccount: 12, InvalidTokenProgram: 13, EngineInvalidConfig: 14 };
const S = { EngineProvenanceMismatch: 16, EngineStale: 19, EngineLockActive: 21, RentExemptRequired: 31 };

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: set-up refusals and argument fuzz", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });

  it("InitMarket: accounts, the mint, the arguments, the account length, every configuration check", async () => {
    const m = await d.newMarket({ capacity: 2 });
    const a = m.admin;
    const init = (o: Partial<InitMarketArgs>) => ix.initMarket(m, defaultInitArgs({ maxPortfolioAssets: 2, ...o }));
    const base = init({});
    await d.fails("two accounts", a, [{ ...base, accounts: base.accounts!.slice(0, 2) }], errB("NotEnoughAccountKeys"));
    const t22 = await d.address();
    d.write(t22, TOKEN_2022, mintBytes({ decimals: 6 }));
    await d.fails("a Token-2022 mint", a, [ix.initMarket({ ...m, mint: t22 }, defaultInitArgs({ maxPortfolioAssets: 2 }))], err(C.InvalidMint));
    const longMint = await d.address();
    d.write(longMint, TOKEN, Buffer.concat([mintBytes({ decimals: 6 }), Buffer.alloc(1)]));
    await d.fails("a mint of 83 bytes", a, [ix.initMarket({ ...m, mint: longMint }, defaultInitArgs({ maxPortfolioAssets: 2 }))], err(C.InvalidMint));
    const tagged = await d.address();
    const tb = mintBytes({ decimals: 6 });
    tb.writeUInt32LE(2, 0);
    d.write(tagged, TOKEN, tb);
    await d.fails("a mint with a bad COption tag", a, [ix.initMarket({ ...m, mint: tagged }, defaultInitArgs({ maxPortfolioAssets: 2 }))], err(C.InvalidMint));
    for (const [label, o] of [
      ["base fee above the maximum", { maxTradingFeeBps: 10n, tradeFeeBaseBps: 11n }],
      ["no assets", { maxPortfolioAssets: 0 }],
      ["15 assets", { maxPortfolioAssets: 15 }],
      ["h_max above the bound scale", { hMax: 1_000_000_000_001n }],
      ["maintenance fee above the protocol cap", { maintenanceFeePerSlot: 10n ** 36n + 1n }],
      ["price 0", { initialPrice: 0n }],
      ["price above the maximum", { initialPrice: 10n ** 12n + 1n }],
    ] as [string, Partial<InitMarketArgs>][])
      await d.fails(`InitMarket ${label}`, a, [init(o)], err(C.EngineInvalidConfig));
    for (const [label, o] of [
      ["h_min above h_max", { hMin: 11n }],
      ["h_max 0", { hMax: 0n, hMin: 0n }],
      ["mm floor 0", { minNonzeroMmReq: 0n }],
      ["mm floor not below im floor", { minNonzeroMmReq: 2n }],
      ["maintenance above initial", { maintenanceMarginBps: 10_000n, initialMarginBps: 9_000n }],
      ["initial above 10000", { initialMarginBps: 10_001n }],
      ["liquidation fee above 10000", { liquidationFeeBps: 10_001n }],
      ["liquidation floor above the cap", { minLiquidationAbs: 2n, liquidationFeeCap: 1n }],
      ["liquidation cap above the protocol cap", { liquidationFeeCap: 10n ** 36n + 1n }],
      ["accrual window 0", { maxAccrualDtSlots: 0n }],
      ["funding lifetime below the window", { minFundingLifetimeSlots: 3n }],
      ["funding above 10000", { maxAbsFundingE9PerSlot: 10_001n }],
      ["price move 0", { maxPriceMoveBpsPerSlot: 0n }],
      ["B chunks 0", { maxAccountBSettlementChunks: 0n }],
      ["bankrupt chunks 0", { maxBankruptCloseChunks: 0n }],
      ["bankrupt lifetime 0", { maxBankruptCloseLifetimeSlots: 0n }],
      ["public B chunk 0", { publicBChunkAtoms: 0n }],
      ["the envelope: maintenance 10% against a 1000 bps/slot move", { maintenanceMarginBps: 1000n, initialMarginBps: 2000n }],
      ["the envelope: funding headroom", { maxAbsFundingE9PerSlot: 10_000n, maxAccrualDtSlots: 1n << 40n, minFundingLifetimeSlots: 1n << 40n }],
      ["the capacity below the assets", { maxPortfolioAssets: 3 }],
    ] as [string, Partial<InitMarketArgs>][])
      await d.fails(`InitMarket ${label}`, a, [init(o)], errB("InvalidAccountData"));
    for (const [label, len, want] of [
      ["1,189 bytes", 1189, err(E.InvalidAccountLen)],
      ["the header alone", 1190, errB("InvalidAccountData")],
      ["a slot and a byte", marketLen(1) + 1, errB("InvalidAccountData")],
    ] as [string, number, string][]) {
      const short = await d.newMarket({ capacity: 1 });
      d.write(short.market, PROGRAM, new Uint8Array(len));
      await d.fails(`InitMarket ${label}`, short.admin, [ix.initMarket(short, defaultInitArgs())], want);
    }
    await d.ok("InitMarket", a, [base]);
    await d.fails("InitMarket again", a, [base], err(E.AlreadyInitialized));
  });

  it(`InitMarket: ${INIT_FUZZ} random argument sets (shape and solvency envelope)`, async () => {
    const rng = new Rng(SEED);
    const pick = (xs: bigint[]) => xs[rng.int(xs.length)]!;
    const counts = { ok: 0, sent: 0 };
    for (let n = 0; n < INIT_FUZZ; n++) {
      const capacity = 1 + rng.int(4);
      const m = await d.newMarket({ capacity });
      const mm = pick([0n, 1n, 50n, 500n, 1000n, 2500n, 5000n, 9999n, 10_000n, BigInt(rng.int(10_001))]);
      const im = mm + pick([0n, 1n, 100n, 1000n, BigInt(rng.int(10_001))]);
      const a = defaultInitArgs({
        maxPortfolioAssets: 1 + rng.int(capacity + 1),
        hMin: pick([0n, 1n, 5n]),
        hMax: pick([1n, 10n, 1000n]),
        minNonzeroMmReq: pick([1n, 10n, 1_000_000n, BigInt(rng.int(1 << 30))]),
        minNonzeroImReq: pick([2n, 100n, 2_000_000n, 1n << 40n]),
        maintenanceMarginBps: mm,
        initialMarginBps: im > 10_000n && rng.chance(80) ? 10_000n : im,
        liquidationFeeBps: pick([0n, 0n, 1n, 25n, 100n, 1000n]),
        liquidationFeeCap: pick([0n, 1n, 1000n, 1_000_000n, 10n ** 18n]),
        minLiquidationAbs: pick([0n, 0n, 1n, 100n]),
        maxPriceMoveBpsPerSlot: pick([1n, 2n, 10n, 50n, 100n, 1000n, 10_000n]),
        maxAccrualDtSlots: pick([1n, 2n, 4n, 16n, 100n]),
        maxAbsFundingE9PerSlot: pick([0n, 0n, 1n, 5n, 100n, 10_000n]),
        minFundingLifetimeSlots: pick([4n, 100n, 1000n, 1n << 20n]),
        maintenanceFeePerSlot: pick([0n, 1n, 1000n]),
      });
      const got = await d.send(`InitMarket fuzz ${n}`, m.admin, [ix.initMarket(m, a)]);
      counts.sent++;
      if (got === "ok") counts.ok++;
    }
    console.log(`InitMarket fuzz: ${counts.sent} compared, ${counts.ok} succeeded in both`);
    expect(counts.ok).toBeGreaterThan(INIT_FUZZ / 20);
  }, 1_800_000);

  it("InitPortfolio, Deposit, ClosePortfolio: accounts, kinds, bindings, token accounts, amounts", async () => {
    const m = await d.market({ capacity: 1 });
    const { owner, portfolio } = await d.newPortfolio();
    const base = ix.initPortfolio(m, owner, portfolio);
    await d.fails("InitPortfolio two accounts", owner, [{ ...base, accounts: base.accounts!.slice(0, 2) }], errB("NotEnoughAccountKeys"));
    const poor = await d.newPortfolio();
    d.write(poor.portfolio, PROGRAM, new Uint8Array(9563), 1_000_000n);
    await d.fails("InitPortfolio not rent-exempt", poor.owner, [ix.initPortfolio(m, poor.owner, poor.portfolio)], err(S.RentExemptRequired));
    const other = await d.newMarket();
    await d.fails("InitPortfolio on an uninitialized market", owner, [ix.initPortfolio(other, owner, portfolio)], err(E.NotInitialized));
    await d.ok("InitPortfolio", owner, [base]);
    await d.fails("InitPortfolio again", owner, [base], err(E.AlreadyInitialized));
    const asMarket = { ...m, market: portfolio };
    const second = await d.newPortfolio();
    await d.fails(
      "InitPortfolio with a portfolio as the market",
      second.owner,
      [ix.initPortfolio(asMarket, second.owner, second.portfolio)],
      err(E.InvalidAccountKind),
    );
    const id = d.portfolioId(portfolio);
    const source = await d.tokenAccount(m.mint, owner.address, 1_000n);
    const dep = (o: { src?: Address; idv?: bigint; seq?: bigint; amount?: bigint; vault?: Address; tp?: Address } = {}) =>
      ix.deposit({ ...m, vault: o.vault ?? m.vault }, owner, portfolio, o.src ?? source, o.idv ?? id, o.seq ?? 0n, o.amount ?? 10n, o.tp ?? TOKEN);
    await d.fails("Deposit with Token-2022", owner, [dep({ tp: TOKEN_2022 })], err(C.InvalidTokenProgram));
    await d.fails("Deposit wrong id", owner, [dep({ idv: id + 1n })], err(S.EngineProvenanceMismatch));
    await d.fails("Deposit wrong sequence", owner, [dep({ seq: 1n })], err(S.EngineStale));
    const otherMint = await d.mint();
    await d.fails("Deposit from another mint", owner, [dep({ src: await d.tokenAccount(otherMint, owner.address, 1_000n) })], err(C.InvalidMint));
    await d.fails(
      "Deposit from another owner's account",
      owner,
      [dep({ src: await d.tokenAccount(m.mint, m.admin.address, 1_000n) })],
      err(C.InvalidTokenAccount),
    );
    const frozen = await d.address();
    d.write(frozen, TOKEN, tokenAccountBytes({ mint: m.mint, owner: owner.address, amount: 1_000n, state: 2 }));
    await d.fails("Deposit from a frozen account", owner, [dep({ src: frozen })], err(C.InvalidTokenAccount));
    const t22 = await d.address();
    d.write(t22, TOKEN_2022, tokenAccountBytes({ mint: m.mint, owner: owner.address, amount: 1_000n }));
    await d.fails("Deposit from a Token-2022 account", owner, [dep({ src: t22 })], err(C.InvalidTokenAccount));
    await d.fails("Deposit into a non-canonical vault", owner, [dep({ vault: await d.tokenAccount(m.mint, m.vaultPda) })], err(C.InvalidVaultAccount));
    d.write(m.vault, TOKEN, tokenAccountBytes({ mint: m.mint, owner: m.vaultPda, delegate: owner.address }));
    await d.fails("Deposit into a vault with a delegate", owner, [dep()], err(C.InvalidVaultAccount));
    d.write(m.vault, TOKEN, tokenAccountBytes({ mint: m.mint, owner: m.vaultPda }));
    await d.fails("Deposit above u64", owner, [dep({ amount: 1n << 64n })], err(C.InvalidInstruction));
    await d.fails("Deposit above the balance", owner, [dep({ amount: 1_001n })], err(C.InvalidTokenAccount));
    const rich = await d.tokenAccount(m.mint, owner.address, 0xffff_ffff_ffff_ffffn);
    await d.fails("Deposit past the vault's TVL cap", owner, [dep({ src: rich, amount: 10n ** 16n + 1n })], err(C.EngineInvalidConfig));
    const intruder = await d.funded();
    const stolen = ix.deposit(m, intruder, portfolio, await d.tokenAccount(m.mint, intruder.address, 10n), id, 0n, 1n);
    await d.fails("Deposit into another owner's portfolio", intruder, [stolen], err(E.Unauthorized));
    const rng = new Rng(SEED + 3n);
    let seq = 0n;
    for (let n = 0; n < 20; n++) {
      const amount = rng.chance(20) ? 0n : BigInt(rng.int(50));
      const got = await d.send(`Deposit ${amount}`, owner, [dep({ seq, amount })]);
      if (got === "ok") seq++;
    }
    await d.fails("ClosePortfolio with capital", owner, [ix.closePortfolio(m, owner, portfolio, id, seq, 0n)], err(S.EngineLockActive));
    await d.fails("ClosePortfolio wrong sequence", owner, [ix.closePortfolio(m, owner, portfolio, id, seq + 1n, 0n)], err(S.EngineStale));
    await d.fails("ClosePortfolio wrong epoch", owner, [ix.closePortfolio(m, owner, portfolio, id, seq, 1n)], err(S.EngineStale));
    const empty = await d.newPortfolio();
    await d.ok("InitPortfolio empty", empty.owner, [ix.initPortfolio(m, empty.owner, empty.portfolio)]);
    const eid = d.portfolioId(empty.portfolio);
    await d.fails("ClosePortfolio by a stranger", intruder, [ix.closePortfolio(m, intruder, empty.portfolio, eid, 0n, 0n)], err(E.Unauthorized));
    await d.fails(
      "ClosePortfolio by the market admin (live market)",
      m.admin,
      [ix.closePortfolio(m, m.admin, empty.portfolio, eid, 0n, 0n)],
      err(E.Unauthorized),
    );
    await d.ok("ClosePortfolio", empty.owner, [ix.closePortfolio(m, empty.owner, empty.portfolio, eid, 0n, 0n)]);
    await d.fails("ClosePortfolio again", empty.owner, [ix.closePortfolio(m, empty.owner, empty.portfolio, eid, 0n, 0n)], errB("IncorrectProgramId"));
    const long = await d.newPortfolio(9564);
    await d.fails(
      "InitPortfolio of 9,564 bytes is shrunk, then ClosePortfolio of a longer one",
      long.owner,
      [ix.closePortfolio(m, long.owner, long.portfolio, 1n, 0n, 0n)],
      err(E.InvalidAccountLen),
    );
  });
});
