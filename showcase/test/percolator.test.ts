// Percolator v12.20 (showcase/mainnet/percolator) against the mainnet binary: market creation (InitMarket), account
// creation (InitUser, InitLP), deposits (DepositCollateral, TopUpInsurance, DepositFeeCredits), each sent to both
// programs with the outcome, logs, inner instructions, return data and every named account's bytes compared
// (percolator-helpers.ts `Diff.both`), success paths and the refusals each handler makes, in its order.
import { type Address } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  A,
  C,
  CHAINLINK,
  Diff,
  E,
  FEED,
  HAVE_ORIGINAL,
  type InitMarketArgs,
  type Market,
  PROGRAM,
  PYTH_RECEIVER,
  SLAB_LEN,
  SOL,
  SYSTEM,
  TOKEN,
  accountAt,
  builtin,
  cuSummary,
  computeUnits,
  defaultInitArgs,
  ix,
  pe,
  pythBytes,
  readI128,
  readU128,
  readonly,
  replace,
  tokenAccountBytes,
  truncate,
  unsigned,
  withData,
  writeU128,
} from "./percolator-helpers.js";

const INVALID_DATA = builtin("InvalidInstructionData");
const CU = computeUnits(1_400_000);

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: InitMarket", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });
  afterAll(() => {
    if (process.env.PERCOLATOR_CU) console.table(cuSummary(d.rows));
  });

  /** InitMarket of a fresh market's accounts with `edit` applied: its outcome. */
  async function init(label: string, edit: (a: InitMarketArgs) => void, o: { price?: bigint; slabLen?: number } = {}): Promise<[string, Market]> {
    const m = await d.newMarket(o);
    const args = defaultInitArgs(m.admin.address, m.mint);
    edit(args);
    return [await d.both(label, m.admin, [CU, ix.initMarket(m, args)]), m];
  }

  it("markets of every shape", async () => {
    const shapes: [string, (a: InitMarketArgs) => void][] = [
      ["default", () => {}],
      ["no extended tail", (a) => (a.tail = null)],
      ["inverted", (a) => (a.invert = 1)],
      ["unit scale 1000, fee 5000", (a) => Object.assign(a, { unitScale: 1000, newAccountFee: 5000n })],
      ["maintenance fee", (a) => (a.maintenanceFeePerSlot = 12345n)],
      ["oracle cap floor", (a) => (a.minOraclePriceCapE2bps = 5000n)],
      ["warmup bounds", (a) => Object.assign(a, { hMin: 10n, hMax: 100n })],
      ["small max_accounts", (a) => (a.maxAccounts = 3n)],
      ["conf filter off", (a) => (a.confFilterBps = 0)],
      [
        "custom funding",
        (a) => Object.assign(a.tail!, { fundingHorizonSlots: 7n, fundingKBps: 100000n, fundingMaxPremiumBps: 0n, fundingMaxE9PerSlot: 10000n }),
      ],
      [
        "perm-resolve off with a cap floor",
        (a) => Object.assign(a, { minOraclePriceCapE2bps: 1n }) && Object.assign(a.tail!, { permissionlessResolveStaleSlots: 0n }),
      ],
      [
        "hyperp",
        (a) => {
          a.feedId = Buffer.alloc(32);
          a.initialMarkPriceE6 = 2_000_000n;
          a.tail!.markMinFee = 10n;
        },
      ],
      [
        "hyperp inverted and scaled",
        (a) => {
          a.feedId = Buffer.alloc(32);
          a.initialMarkPriceE6 = 50_000n;
          a.invert = 1;
          a.unitScale = 10;
          a.tail!.markMinFee = 10n;
        },
      ],
      [
        "hyperp, no perm-resolve, cap floor above the default",
        (a) => {
          a.feedId = Buffer.alloc(32);
          a.initialMarkPriceE6 = 1n;
          a.minOraclePriceCapE2bps = 20000n;
          a.tail!.permissionlessResolveStaleSlots = 0n;
        },
      ],
    ];
    for (const [label, edit] of shapes) expect((await init(`InitMarket ${label}`, edit))[0], label).toBe("ok");
  });

  it("the oracle read at init", async () => {
    // Prices as Pyth gives them: exponents, the inversion, the conf filter, staleness, other feeds and owners.
    const cases: [string, Partial<Parameters<typeof pythBytes>[0]> & { owner?: Address; len?: number }, (a: InitMarketArgs) => void][] = [
      ["expo -8", { price: 12_345_678_900n, expo: -8 }, () => {}],
      ["expo 2", { price: 7n, expo: 2 }, () => {}],
      ["expo -18", { price: 10n ** 18n, expo: -18 }, () => {}],
      ["expo 19", { price: 1n, expo: 19 }, () => {}],
      ["expo -19", { price: 1n, expo: -19 }, () => {}],
      ["price 0", { price: 0n }, () => {}],
      ["price negative", { price: -5n }, () => {}],
      ["price rounds to 0", { price: 9n, expo: -7 }, () => {}],
      ["price above u64", { price: 2n ** 62n, expo: 12 }, () => {}],
      ["above MAX_ORACLE_PRICE", { price: 1_000_000_000_001n * 1_000_000n }, () => {}],
      ["inverted", { price: 4_000_000n }, (a) => (a.invert = 1)],
      ["inverted to 0", { price: 2n * 10n ** 12n * 10n ** 6n }, (a) => (a.invert = 1)],
      ["scaled to 0", { price: 999n }, (a) => (a.unitScale = 1000)],
      ["conf too wide", { price: 100_000_000n, conf: 5_000_001n }, () => {}],
      ["conf at the limit", { price: 100_000_000n, conf: 5_000_000n }, () => {}],
      ["stale", { publishTime: -5000n }, () => {}],
      ["from the future", { publishTime: 5n }, () => {}],
      ["other feed", { feedId: Buffer.alloc(32, 7) }, () => {}],
      ["partial verification", { verification: 0 }, () => {}],
      ["short account", { len: 133 }, () => {}],
      ["owned by someone else", { owner: SYSTEM }, () => {}],
      ["chainlink owner, other key", { owner: CHAINLINK }, () => {}],
    ];
    for (const [label, p, edit] of cases) {
      const m = await d.newMarket();
      const now = d.unixTimestamp;
      d.write(
        m.oracle,
        p.owner ?? PYTH_RECEIVER,
        pythBytes({
          feedId: p.feedId ?? FEED,
          price: p.price ?? 100_000_000n,
          expo: p.expo ?? -6,
          conf: p.conf ?? 0n,
          publishTime: now + (p.publishTime ?? 0n),
          verification: p.verification,
          len: p.len,
        }),
      );
      const args = defaultInitArgs(m.admin.address, m.mint);
      edit(args);
      await d.both(`InitMarket oracle: ${label}`, m.admin, [CU, ix.initMarket(m, args)]);
    }
  });

  it("a Chainlink feed", async () => {
    for (const [label, answer, decimals, age] of [
      ["8 decimals", 4_000_000_000n, 8, 0n],
      ["2 decimals", 12n, 2, 10n],
      ["19 decimals", 12n, 19, 0n],
      ["answer 0", 0n, 8, 0n],
      ["stale", 4_000_000_000n, 8, 4000n],
      // The bounds themselves: 18 decimals (MAX_EXPO_ABS) is read, an age of max_staleness_secs (3,600) is fresh.
      ["18 decimals", 4_000_000_000n * 10n ** 10n, 18, 0n],
      ["an age of exactly max_staleness_secs", 4_000_000_000n, 8, 3600n],
      ["an age one past max_staleness_secs", 4_000_000_000n, 8, 3601n],
    ] as [string, bigint, number, bigint][]) {
      const m = await d.newMarket();
      const data = Buffer.alloc(232);
      data[138] = decimals;
      data.writeBigUInt64LE(d.unixTimestamp - age, 208);
      writeU128(data, 216, answer);
      d.write(m.oracle, CHAINLINK, data);
      const args = defaultInitArgs(m.admin.address, m.mint);
      args.feedId = Buffer.from(new Uint8Array((await import("@solana/kit")).getAddressEncoder().encode(m.oracle)));
      await d.both(`InitMarket chainlink: ${label}`, m.admin, [CU, ix.initMarket(m, args)]);
    }
  });

  it("refusals, in the handler's order", async () => {
    const m = await d.newMarket();
    const args = defaultInitArgs(m.admin.address, m.mint);
    const other = await d.funded();
    const bad = async (label: string, edit: (a: InitMarketArgs) => void, expected: string) => {
      const a = { ...args, tail: args.tail && { ...args.tail } };
      edit(a);
      await d.fails(`InitMarket: ${label}`, m.admin, [CU, ix.initMarket(m, a)], expected.replace("index: 0", "index: 1"));
    };
    await d.fails("InitMarket: no data", m.admin, [withData(ix.initMarket(m, args), Buffer.alloc(0))], INVALID_DATA);
    await d.fails("InitMarket: unknown tag", m.admin, [withData(ix.initMarket(m, args), Buffer.from([33]))], INVALID_DATA);
    await d.fails("InitMarket: tag 12 (deleted)", m.admin, [withData(ix.initMarket(m, args), Buffer.from([12]))], INVALID_DATA);
    const full = Buffer.from(ix.initMarket(m, args).data!);
    await d.fails("InitMarket: partial tail", m.admin, [withData(ix.initMarket(m, args), full.subarray(0, 300))], INVALID_DATA);
    await d.fails("InitMarket: trailing byte", m.admin, [withData(ix.initMarket(m, args), Buffer.concat([full, Buffer.from([0])]))], INVALID_DATA);
    await d.fails("InitMarket: no risk floors", m.admin, [withData(ix.initMarket(m, args), full.subarray(0, 290))], INVALID_DATA);
    await d.fails("InitMarket: 8 accounts", m.admin, [truncate(ix.initMarket(m, args), 8)], builtin("NotEnoughAccountKeys"));
    await d.fails("InitMarket: admin not signer", other, [unsigned(ix.initMarket(m, args), 0)], pe("ExpectedSigner"));
    await d.fails("InitMarket: slab read-only", m.admin, [readonly(ix.initMarket(m, args), 1)], pe("ExpectedWritable"));
    await bad("admin differs", (a) => (a.admin = other.address), INVALID_DATA);
    await bad("mint differs", (a) => (a.mint = other.address), INVALID_DATA);
    // The mint's checks.
    const notMint = await d.address();
    d.write(notMint, SYSTEM, Buffer.alloc(82));
    await d.fails("InitMarket: mint not SPL Token's", m.admin, [replace(ix.initMarket(m, { ...args, mint: notMint }), 2, notMint)], builtin("IllegalOwner"));
    for (const [label, bytes] of [
      ["mint of 81 bytes", Buffer.alloc(81, 0)],
      ["mint uninitialized", Buffer.alloc(82, 0)],
      [
        "mint with a bad option tag",
        (() => {
          const b = Buffer.alloc(82);
          b.writeUInt32LE(2, 0);
          b[45] = 1;
          return b;
        })(),
      ],
      [
        "mint with is_initialized 2",
        (() => {
          const b = Buffer.alloc(82);
          b[45] = 2;
          return b;
        })(),
      ],
    ] as [string, Buffer][]) {
      const mm = await d.address();
      d.write(mm, TOKEN, bytes);
      await d.both(`InitMarket: ${label}`, m.admin, [replace(ix.initMarket(m, { ...args, mint: mm }), 2, mm)]);
    }
    await bad("invert 2", (a) => (a.invert = 2), INVALID_DATA);
    await bad("conf filter above 100%", (a) => (a.confFilterBps = 10_001), INVALID_DATA);
    await bad("unit scale too big", (a) => (a.unitScale = 1_000_000_001), INVALID_DATA);
    await bad("initial margin 0", (a) => (a.initialMarginBps = 0n), INVALID_DATA);
    await bad("maintenance margin 0", (a) => (a.maintenanceMarginBps = 0n), INVALID_DATA);
    await bad("initial margin above 100%", (a) => (a.initialMarginBps = 10_001n), INVALID_DATA);
    await bad("initial below maintenance", (a) => (a.initialMarginBps = 400n), INVALID_DATA);
    await bad("insurance withdraw bps above 100%", (a) => (a.tail!.insuranceWithdrawMaxBps = 10_001), INVALID_DATA);
    await bad("insurance withdraw without cooldown", (a) => (a.tail!.insuranceWithdrawMaxBps = 10), INVALID_DATA);
    await bad("staleness 0", (a) => (a.maxStalenessSecs = 0n), INVALID_DATA);
    await bad("staleness over a week", (a) => (a.maxStalenessSecs = 604_801n), INVALID_DATA);
    // The bound itself is accepted (604,800 seconds).
    const [week] = await init("InitMarket: staleness exactly a week", (a) => (a.maxStalenessSecs = 604_800n));
    expect(week).toBe("ok");
    await bad("hyperp without a mark", (a) => (a.feedId = Buffer.alloc(32)), INVALID_DATA);
    await bad(
      "hyperp mark inverted to 0",
      (a) => Object.assign(a, { feedId: Buffer.alloc(32), initialMarkPriceE6: 2n * 10n ** 12n, invert: 1 }),
      pe("OracleInvalid"),
    );
    await bad("hyperp mark scaled to 0", (a) => Object.assign(a, { feedId: Buffer.alloc(32), initialMarkPriceE6: 5n, unitScale: 10 }), pe("OracleInvalid"));
    await bad("hyperp mark above the max", (a) => Object.assign(a, { feedId: Buffer.alloc(32), initialMarkPriceE6: 10n ** 12n + 1n }), pe("OracleInvalid"));
    await bad("account fee above the TVL cap", (a) => (a.newAccountFee = 10n ** 16n + 1n), INVALID_DATA);
    await bad("account fee off the unit scale", (a) => Object.assign(a, { unitScale: 1000, newAccountFee: 1500n }), INVALID_DATA);
    await bad("cap floor above 100%", (a) => (a.minOraclePriceCapE2bps = 1_000_001n), INVALID_DATA);
    await bad("perm-resolve within crank staleness", (a) => (a.tail!.permissionlessResolveStaleSlots = 1000n), INVALID_DATA);
    await bad("perm-resolve without force close", (a) => (a.tail!.forceCloseDelaySlots = 0n), INVALID_DATA);
    await bad("force close delay too long", (a) => (a.tail!.forceCloseDelaySlots = 10_000_001n), INVALID_DATA);
    await bad("h_max past perm-resolve", (a) => (a.hMax = 5001n), INVALID_DATA);
    await bad(
      "perm-resolve past the accrual envelope",
      (a) => Object.assign(a, { maxCrankStalenessSlots: 1n }) && (a.tail!.permissionlessResolveStaleSlots = 10_000_001n),
      INVALID_DATA,
    );
    await bad("no way to resolve", (a) => (a.tail!.permissionlessResolveStaleSlots = 0n), pe("InvalidConfigParam"));
    await bad("funding horizon 0", (a) => (a.tail!.fundingHorizonSlots = 0n), pe("InvalidConfigParam"));
    await bad("funding k too big", (a) => (a.tail!.fundingKBps = 100_001n), pe("InvalidConfigParam"));
    await bad("negative premium cap", (a) => (a.tail!.fundingMaxPremiumBps = -1n), pe("InvalidConfigParam"));
    await bad("negative funding cap", (a) => (a.tail!.fundingMaxE9PerSlot = -1n), pe("InvalidConfigParam"));
    await bad("funding cap above the envelope", (a) => (a.tail!.fundingMaxE9PerSlot = 10_001n), pe("InvalidConfigParam"));
    await bad("hyperp perm-resolve without a mark fee", (a) => Object.assign(a, { feedId: Buffer.alloc(32), initialMarkPriceE6: 5n }), INVALID_DATA);
    // The engine's invariants, checked after the oracle read.
    await bad("max_accounts 0", (a) => (a.maxAccounts = 0n), INVALID_DATA);
    await bad("max_accounts above 4096", (a) => (a.maxAccounts = 4097n), INVALID_DATA);
    await bad("trading fee above 100%", (a) => (a.tradingFeeBps = 10_001n), INVALID_DATA);
    await bad("liquidation fee above 100%", (a) => (a.liquidationFeeBps = 10_001n), INVALID_DATA);
    await bad("mm floor 0", (a) => (a.minNonzeroMmReq = 0n), INVALID_DATA);
    await bad("mm floor not below im floor", (a) => (a.minNonzeroMmReq = 2n), INVALID_DATA);
    await bad("im floor above the TVL cap", (a) => Object.assign(a, { minNonzeroImReq: 10n ** 16n + 1n }), INVALID_DATA);
    await bad("min liquidation above the cap", (a) => (a.minLiquidationAbs = 10n ** 12n + 1n), INVALID_DATA);
    await bad("liquidation cap above 1e36", (a) => Object.assign(a, { liquidationFeeCap: 10n ** 36n + 1n }), INVALID_DATA);
    await bad("h_max 0", (a) => (a.hMax = 0n), INVALID_DATA);
    await bad("h_min above h_max", (a) => Object.assign(a, { hMin: 5n, hMax: 4n }), INVALID_DATA);
    await bad("deviation 0", (a) => (a.resolvePriceDeviationBps = 0n), INVALID_DATA);
    await bad("deviation above 100%", (a) => (a.resolvePriceDeviationBps = 10_001n), INVALID_DATA);
    // The slab and the vault.
    const [r1] = await init("InitMarket: slab one byte short", () => {}, { slabLen: SLAB_LEN - 1 });
    expect(r1).toBe(pe("InvalidSlabLen", 1));
    const foreign = await d.address();
    d.write(foreign, SYSTEM, Buffer.alloc(SLAB_LEN));
    await d.fails("InitMarket: slab not the program's", m.admin, [CU, replace(ix.initMarket(m, args), 1, foreign)], builtin("IllegalOwner", 1));
    const [vaultPda] = [m.vaultPda];
    const vaults: [string, Buffer][] = [
      ["vault of another owner", tokenAccountBytes({ mint: m.mint, owner: m.admin.address })],
      ["vault of another mint", tokenAccountBytes({ mint: foreign, owner: vaultPda })],
      ["vault frozen", tokenAccountBytes({ mint: m.mint, owner: vaultPda, state: 2 })],
      ["vault uninitialized", tokenAccountBytes({ mint: m.mint, owner: vaultPda, state: 0 })],
      ["vault state 3", tokenAccountBytes({ mint: m.mint, owner: vaultPda, state: 3 })],
      ["vault with a delegate", tokenAccountBytes({ mint: m.mint, owner: vaultPda, delegate: foreign })],
      ["vault with a close authority", tokenAccountBytes({ mint: m.mint, owner: vaultPda, closeAuthority: foreign })],
      ["vault not empty", tokenAccountBytes({ mint: m.mint, owner: vaultPda, amount: 1n })],
    ];
    for (const [label, bytes] of vaults) {
      d.write(m.vault, TOKEN, bytes);
      await d.both(`InitMarket: ${label}`, m.admin, [CU, ix.initMarket(m, args)]);
    }
    d.write(m.vault, SYSTEM, tokenAccountBytes({ mint: m.mint, owner: vaultPda }));
    await d.fails("InitMarket: vault not SPL Token's", m.admin, [CU, ix.initMarket(m, args)], pe("InvalidVaultAta", 1));
    d.write(m.vault, TOKEN, tokenAccountBytes({ mint: m.mint, owner: vaultPda }));
    await d.fails("InitMarket: wrong clock", m.admin, [CU, replace(ix.initMarket(m, args), 5, foreign)], builtin("InvalidArgument", 1));
    await d.ok("InitMarket", m.admin, [CU, ix.initMarket(m, args)]);
    await d.fails("InitMarket again", m.admin, [CU, ix.initMarket(m, args)], pe("AlreadyInitialized", 1));
    expect(d.data(m.slab).readBigUInt64LE(C.lastGoodOracleSlot)).toBe(d.slot);
  });
});

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: InitUser, InitLP, deposits", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });
  afterAll(() => {
    if (process.env.PERCOLATOR_CU) console.table(cuSummary(d.rows));
  });

  it("accounts opened, funded and topped up", async () => {
    const m = await d.market({ edit: (a) => Object.assign(a, { newAccountFee: 100n, maxAccounts: 3n }) });
    const alice = await d.user(m);
    const lp = await d.user(m);
    const bob = await d.user(m);
    await d.ok("InitUser", alice.key, [ix.initUser(m, alice, 10n * SOL)]);
    const ctx = await d.address();
    await d.ok("InitLP", lp.key, [ix.initLp(m, lp, PROGRAM, ctx, 5n * SOL)]);
    expect(d.data(m.slab)[accountAt(1) + A.kind]).toBe(1);
    await d.ok("InitUser (third)", bob.key, [ix.initUser(m, bob, 101n)]);
    await d.fails("InitUser: market full", bob.key, [ix.initUser(m, bob, SOL)], pe("EngineAccountNotFound"));
    await d.ok("Deposit", alice.key, [ix.deposit(m, alice, 0, 3n * SOL)]);
    await d.ok("Deposit 0", alice.key, [ix.deposit(m, alice, 0, 0n)]);
    await d.ok("Deposit to the LP", lp.key, [ix.deposit(m, lp, 1, SOL)]);
    await d.fails("Deposit: another's account", alice.key, [ix.deposit(m, alice, 1, SOL)], pe("EngineUnauthorized"));
    await d.fails("Deposit: index past 4096", alice.key, [ix.deposit(m, alice, 5000, SOL)], pe("EngineAccountNotFound"));
    await d.fails("Deposit: more than the token account holds", alice.key, [ix.deposit(m, alice, 0, 10_000n * SOL)], custom1());
    await d.ok("TopUpInsurance", bob.key, [ix.topUpInsurance(m, bob, 2n * SOL)]);
    await d.ok("TopUpInsurance 0", bob.key, [ix.topUpInsurance(m, bob, 0n)]);
    // Time passes: deposits anchor at the market's slot, not the clock's.
    d.setClock(d.slot + 50n);
    await d.ok("Deposit later", alice.key, [ix.deposit(m, alice, 0, SOL)]);
    await d.ok("TopUpInsurance later", bob.key, [ix.topUpInsurance(m, bob, SOL)]);
    expect(readU128(d.data(m.slab), E.insurance)).toBe(3n * SOL + 300n);
  });

  it("the TVL:insurance cap and the unit scale", async () => {
    const m = await d.market({ edit: (a) => Object.assign(a, { unitScale: 1000, newAccountFee: 2000n }) });
    const alice = await d.user(m);
    await d.fails("InitUser: off the unit scale", alice.key, [ix.initUser(m, alice, 10_500n)], builtin("InvalidArgument"));
    await d.fails("InitUser: only the fee", alice.key, [ix.initUser(m, alice, 2000n)], pe("EngineInsufficientBalance"));
    await d.ok("InitUser scaled", alice.key, [ix.initUser(m, alice, 10_000n)]);
    await d.fails("Deposit: off the unit scale", alice.key, [ix.deposit(m, alice, 0, 1500n)], builtin("InvalidArgument"));
    await d.ok("Deposit scaled", alice.key, [ix.deposit(m, alice, 0, 7000n)]);
    // Turn the cap on (UpdateConfig) with 2 units of insurance: capital may reach 2 · k.
    await d.ok("UpdateConfig cap 5", m.admin, [
      ix.updateConfig(m, m.admin, { horizon: 500n, kBps: 100n, maxPremiumBps: 500n, maxE9PerSlot: 1000n, tvlCapMult: 5 }),
    ]);
    await d.fails("Deposit over the cap", alice.key, [ix.deposit(m, alice, 0, 1000n)], pe("DepositCapExceeded"));
    const bob = await d.user(m);
    await d.fails("InitUser over the cap", bob.key, [ix.initUser(m, bob, 3000n)], pe("DepositCapExceeded"));
    await d.ok("TopUpInsurance", bob.key, [ix.topUpInsurance(m, bob, 100_000n)]);
    await d.ok("Deposit under the cap", alice.key, [ix.deposit(m, alice, 0, 1000n)]);
    await d.ok("InitLP under the cap", bob.key, [ix.initLp(m, bob, SYSTEM, SYSTEM, 3000n)]);
  });

  it("refusals of InitUser, Deposit, TopUpInsurance", async () => {
    const m = await d.market();
    const alice = await d.user(m);
    const other = await d.funded();
    const builders: [string, (u: typeof alice) => ReturnType<typeof ix.initUser>][] = [
      ["InitUser", (u) => ix.initUser(m, u, SOL)],
      ["InitLP", (u) => ix.initLp(m, u, SYSTEM, SYSTEM, SOL)],
      ["Deposit", (u) => ix.deposit(m, u, 0, SOL)],
      ["TopUpInsurance", (u) => ix.topUpInsurance(m, u, SOL)],
      ["DepositFeeCredits", (u) => ix.depositFeeCredits(m, u, 0, SOL)],
    ];
    await d.ok("InitUser", alice.key, [ix.initUser(m, alice, SOL)]);
    const foreignSlab = await d.address();
    d.write(foreignSlab, SYSTEM, Buffer.alloc(SLAB_LEN));
    const shortSlab = await d.address();
    d.write(shortSlab, PROGRAM, Buffer.alloc(100));
    const blank = await d.address();
    d.write(blank, PROGRAM, Buffer.alloc(SLAB_LEN));
    const wrongAta = await d.tokenAccount(m.mint, other.address, SOL);
    const otherMintAta = await d.tokenAccount(await d.mint(), alice.key.address, SOL);
    const frozenAta = await d.tokenAccount(m.mint, alice.key.address, SOL, { state: 2 });
    const fakeVault = await d.tokenAccount(m.mint, m.vaultPda);
    for (const [name, build] of builders) {
      const i = build(alice);
      await d.fails(`${name}: 5 accounts`, alice.key, [truncate(i, 5)], builtin("NotEnoughAccountKeys"));
      await d.fails(`${name}: user not signer`, other, [unsigned(i, 0)], pe("ExpectedSigner"));
      await d.fails(`${name}: slab read-only`, alice.key, [readonly(i, 1)], pe("ExpectedWritable"));
      await d.fails(`${name}: not the token program`, alice.key, [replace(i, 4, SYSTEM)], pe("InvalidTokenProgram"));
      await d.fails(`${name}: slab not the program's`, alice.key, [replace(i, 1, foreignSlab)], builtin("IllegalOwner"));
      await d.fails(`${name}: short slab`, alice.key, [replace(i, 1, shortSlab)], pe("InvalidSlabLen"));
      await d.fails(`${name}: uninitialized slab`, alice.key, [replace(i, 1, blank)], pe("NotInitialized"));
      await d.fails(`${name}: other vault`, alice.key, [replace(i, 3, fakeVault)], pe("InvalidVaultAta"));
      await d.fails(`${name}: another's token account`, alice.key, [replace(i, 2, wrongAta)], pe("InvalidTokenAccount"));
      await d.fails(`${name}: token account of another mint`, alice.key, [replace(i, 2, otherMintAta)], pe("InvalidMint"));
      await d.fails(`${name}: frozen token account`, alice.key, [replace(i, 2, frozenAta)], pe("InvalidTokenAccount"));
      await d.fails(`${name}: token account not SPL Token's`, alice.key, [replace(i, 2, other.address)], pe("InvalidTokenAccount"));
      await d.fails(`${name}: wrong clock`, alice.key, [replace(i, 5, other.address)], builtin("InvalidArgument"));
    }
    // Corrupt enum tags and a TradeCpi in progress (written into both slabs: no instruction leaves them): refused before
    // anything else.
    const snapshot = Buffer.from(d.data(m.slab));
    for (const [label, at, v, expected] of [
      ["side mode 3", E.sideModeLong, 3, builtin("InvalidAccountData")],
      ["market mode 2", E.marketMode, 2, builtin("InvalidAccountData")],
      ["CPI in progress", 13, 8 | 4, builtin("InvalidAccountData")],
    ] as [string, number, number, string][]) {
      d.patch(m.slab, (b) => (b[at] = v));
      for (const [name, build] of builders) await d.fails(`${name}: ${label}`, alice.key, [build(alice)], expected);
      d.patch(m.slab, (b) => snapshot.copy(b));
    }
    // Stale past the permissionless window.
    d.setClock(d.slot + 6000n);
    for (const [name, build] of builders) await d.fails(`${name}: matured stale`, alice.key, [build(alice)], pe("OracleStale"));
    // Resolved (by anyone, past the hard timeout): refused before the vault and token checks.
    await d.ok("ResolvePermissionless", other, [ix.resolvePermissionless(m)]);
    for (const [name, build] of builders) await d.fails(`${name}: resolved`, alice.key, [build(alice)], builtin("InvalidAccountData"));
  });

  it("DepositFeeCredits pays fee debt", async () => {
    const m = await d.market({ edit: (a) => (a.maintenanceFeePerSlot = 1000n) });
    // Fee debt as the crank's sweep leaves it: four larger positions hold the risk buffer, so the crank does not touch
    // alice's tiny one; 80 slots of fees (80,000) against her 50,000 leave 30,000 of debt on an open position.
    const lp = await d.user(m);
    await d.ok("InitUser: lp", lp.key, [ix.initUser(m, lp, 100n * SOL)]);
    for (let i = 0; i < 4; i++) {
      const w = await d.user(m);
      await d.ok(`InitUser: big ${i}`, w.key, [ix.initUser(m, w, 100n * SOL)]);
      await d.ok(`TradeNoCpi: big ${i}`, w.key, [ix.tradeNoCpi(m, w.key, lp.key, 0, 1 + i, 100_000_000n)]);
    }
    const alice = await d.user(m);
    await d.ok("InitUser", alice.key, [ix.initUser(m, alice, 50_000n)]);
    await d.ok("TradeNoCpi: alice, a tiny position", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 5, 1_000n)]);
    d.setClock(d.slot + 80n);
    await d.ok("KeeperCrank: the sweep leaves fee debt", alice.key, [ix.crank(m, alice.key, 65535)]);
    expect(readI128(d.data(m.slab), accountAt(5) + A.feeCredits)).toBe(-30_000n);
    await d.fails("DepositFeeCredits: more than the debt", alice.key, [ix.depositFeeCredits(m, alice, 5, 30_001n)], builtin("InvalidArgument"));
    await d.fails("DepositFeeCredits: 0", alice.key, [ix.depositFeeCredits(m, alice, 5, 0n)], builtin("InvalidArgument"));
    const mallory = await d.user(m);
    await d.fails("DepositFeeCredits: another's account", mallory.key, [ix.depositFeeCredits(m, mallory, 5, 1n)], pe("EngineUnauthorized"));
    await d.ok("DepositFeeCredits part", alice.key, [ix.depositFeeCredits(m, alice, 5, 10_000n)]);
    d.setClock(d.slot + 7n);
    await d.ok("DepositFeeCredits rest", alice.key, [ix.depositFeeCredits(m, alice, 5, 20_000n)]);
    expect(readI128(d.data(m.slab), accountAt(5) + A.feeCredits)).toBe(0n);
    await d.fails("DepositFeeCredits: no debt", alice.key, [ix.depositFeeCredits(m, alice, 5, 1n)], builtin("InvalidArgument"));
  });

  it("the deposit cap reached exactly; a stale market's refusal before the unit scale's", async () => {
    // TVL:insurance cap 5 with 10 units of insurance: capital may reach exactly 50.
    const m = await d.market();
    const alice = await d.user(m);
    await d.ok("InitUser: 20", alice.key, [ix.initUser(m, alice, 20n)]);
    await d.ok("TopUpInsurance: 10", alice.key, [ix.topUpInsurance(m, alice, 10n)]);
    await d.ok("UpdateConfig cap 5", m.admin, [
      ix.updateConfig(m, m.admin, { horizon: 500n, kBps: 100n, maxPremiumBps: 500n, maxE9PerSlot: 1000n, tvlCapMult: 5 }),
    ]);
    await d.ok("Deposit: capital exactly at the cap", alice.key, [ix.deposit(m, alice, 0, 30n)]);
    await d.fails("Deposit: one past the cap", alice.key, [ix.deposit(m, alice, 0, 1n)], pe("DepositCapExceeded"));
    // A unit-scaled market past its hard timeout (5,000 slots without a price): an amount off the unit scale is refused
    // as stale first, the staleness check coming before the scale's.
    const n = await d.market({ edit: (a) => (a.unitScale = 1000) });
    const bob = await d.user(n);
    await d.ok("InitUser (scaled)", bob.key, [ix.initUser(n, bob, 10_000n)]);
    d.setClock(d.slot + 5001n);
    await d.fails("InitUser: stale and off the unit scale", bob.key, [ix.initUser(n, bob, 1500n)], pe("OracleStale"));
    await d.fails("Deposit: stale and off the unit scale", bob.key, [ix.deposit(n, bob, 0, 1500n)], pe("OracleStale"));
    await d.fails("TopUpInsurance: stale and off the unit scale", bob.key, [ix.topUpInsurance(n, bob, 1500n)], pe("OracleStale"));
  });

  it("verify_token_program: the token program's key, and executable", async () => {
    // A VM of its own: SPL Token's account is replaced by a non-executable one, which no later test could use.
    const own = await Diff.create();
    const m = await own.market();
    const alice = await own.user(m);
    own.write(TOKEN, SYSTEM, Buffer.alloc(0), 1_000_000_000n, false);
    await own.fails("InitUser: SPL Token's key, not executable", alice.key, [ix.initUser(m, alice, SOL)], pe("InvalidTokenProgram"));
  });
});

/** SPL Token's InsufficientFunds (custom 1), surfaced by the transfer the program makes. */
function custom1(): string {
  return "error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: 1 } }";
}
