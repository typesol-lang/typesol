// Marginfi part 5 D against the mainnet binary: Drift banks (lending_pool_add_bank_drift, drift_init_user,
// drift_deposit, drift_withdraw) over Drift v2 (test/programs/drift.so, the build Marginfi's own tests use: the program
// on mainnet now only winds Drift down), loaded into both ledgers: Drift's state and spot markets made with its own
// instructions, Pyth and Switchboard feeds, the market's cumulative deposit interest in the risk engine, balances in
// Drift's scaled units.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, lamports } from "@solana/kit";
import { BorshCoder, web3 } from "@anchor-lang/core";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BN, TOKEN_PROGRAM, pda } from "../../test/harness.js";
import { SYSTEM, key, program, report, sha } from "./jito-helpers.js";
import { Rng } from "./fuzz-rng.js";
import { INSTRUCTIONS, ONE, PROGRAM, bankConfig, fx, le, marginfiPair, ratio } from "./marginfi-helpers.js";

const DRIFT = address("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
const RENT = address("SysvarRent111111111111111111111111111111111");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const DISTRIBUTOR = address("distAitdwx9mDm3SaPMtGZRjpXMPUenLhmPwoySV3Hp");
const dcoder = new BorshCoder(JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/drift/drift.idl.json", import.meta.url)), "utf8")));
const pk = (a: Address) => new web3.PublicKey(a);
type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };
const dix = (name: string, args: Record<string, unknown>, accounts: Meta[]): Instruction => ({
  programAddress: DRIFT,
  accounts: accounts.map((a) => ({
    address: a.address,
    role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
    ...(a.signer ? { signer: a.signer } : {}),
  })) as Instruction["accounts"],
  data: new Uint8Array(dcoder.instruction.encode(name, args)),
});
/** MinimalSpotMarket's cumulative deposit interest and last interest time (discriminator included). */
const CUMULATIVE_DEPOSIT_INTEREST = 464;
const LAST_INTEREST_TS = 568;

describe.skipIf(!existsSync(program("drift.so")))("Marginfi v2 port against the mainnet binary: Drift banks", () => {
  const h = marginfiPair();
  const { s, setPyth, setSwb } = h;
  /**
   * h.run: a transaction not marked failing must succeed (both failing alike would otherwise pass unnoticed), and one
   * marked failing must fail with the original's error, code included.
   */
  const run = async (...args: Parameters<typeof h.run>) => {
    const [label, payer, ixs, watched, failing] = args;
    const o = await h.run(label, payer, ixs, watched, false);
    if (failing) expect(o, label).not.toBe("ok");
    else expect(o, label).toBe("ok");
    return o;
  };
  let admin: KeyPairSigner;
  let group: KeyPairSigner;
  let t = 1_800_600_000n;
  let slot = 700_000_000n;
  const tick = (dt = 10n) => {
    t += dt;
    slot += 3n;
    h.setClock(t, slot);
  };
  const ordered = (...groups: Address[][]) => groups.sort((x, y) => Buffer.compare(Buffer.from(pk(y[0]!).toBytes()), Buffer.from(pk(x[0]!).toBytes()))).flat();
  const data = (a: Address) => Buffer.from((s.original.getAccount(a) as { data: Uint8Array }).data);
  const poke = (a: Address, at: number, bytes: Buffer) => {
    for (const vm of s.vms()) {
      const x = vm.getAccount(a);
      if (!x.exists) throw new Error(`no account ${a}`);
      const d = Buffer.from(x.data);
      bytes.copy(d, at);
      vm.setAccount({ ...x, address: a, data: new Uint8Array(d) });
    }
  };

  let state: Address;
  let signer: Address;
  let usdcMint: Address;
  /** A spot market, the marginfi bank's feed (Pyth or Switchboard) and its price. */
  type Market = { index: number; mint: Address; market: Address; vault: Address; oracle: Address; swb: boolean; price: bigint };
  const markets: Market[] = [];
  const refreshFeeds = () => {
    for (const m of markets)
      if (m.swb) setSwb(m.oracle, { value: m.price * 10n ** 12n, lastUpdate: t });
      else setPyth(m.oracle, { price: m.price, conf: m.price / 10_000n, expo: -6, publishTime: t });
  };
  /** A Drift spot market (QuoteAsset: no oracle of Drift's own; the USDC market is index 0). */
  const newMarket = async (index: number, mint: Address, price: bigint, swb = false): Promise<Market> => {
    const idx = new Uint8Array(le(BigInt(index), 2));
    const [market] = await pda(DRIFT, ["spot_market", idx]);
    const [vault] = await pda(DRIFT, ["spot_market_vault", idx]);
    const [ifVault] = await pda(DRIFT, ["insurance_fund_vault", idx]);
    await run(
      "drift spot market",
      admin,
      [
        dix(
          "initialize_spot_market",
          {
            optimal_utilization: 500_000,
            optimal_borrow_rate: 50_000,
            max_borrow_rate: 1_000_000,
            oracle_source: { QuoteAsset: {} },
            initial_asset_weight: 10_000,
            maintenance_asset_weight: 10_000,
            initial_liability_weight: 10_000,
            maintenance_liability_weight: 10_000,
            imf_factor: 0,
            liquidator_fee: 0,
            if_liquidation_fee: 0,
            active_status: true,
            asset_tier: { Collateral: {} },
            scale_initial_asset_weight_start: new BN(0),
            withdraw_guard_threshold: new BN("10000000000000"),
            order_tick_size: new BN(1),
            order_step_size: new BN(1),
            if_total_factor: 0,
            name: Array(32).fill(0),
          },
          [
            { address: market, writable: true },
            { address: mint },
            { address: vault, writable: true },
            { address: ifVault, writable: true },
            { address: signer },
            { address: state, writable: true },
            { address: SYSTEM },
            { address: admin.address, signer: admin, writable: true },
            { address: RENT },
            { address: SYSTEM },
            { address: TOKEN_PROGRAM },
          ],
        ),
      ],
      [market, vault],
    );
    const m: Market = { index, mint, market, vault, oracle: (await s.key()).address, swb, price };
    markets.push(m);
    refreshFeeds();
    return m;
  };

  /** Drift's UpdateSpotMarketCumulativeInterest (a QuoteAsset market's oracle is the default key). */
  const refresh = (m: Market) =>
    dix("update_spot_market_cumulative_interest", {}, [{ address: state }, { address: m.market, writable: true }, { address: SYSTEM }, { address: m.vault }]);
  /**
   * Drift moves a market's last interest time only when interest accrues (a market with borrows): with none here, the
   * time is written in both ledgers, so Marginfi sees the market as refreshed now.
   */
  const fresh = (m: Market) => poke(m.market, LAST_INTEREST_TS, le(t, 8));
  type DriftBank = { address: Address; v: Awaited<ReturnType<typeof h.vaults>>; user: Address; stats: Address; m: Market };
  const addDriftBank = async (
    m: Market,
    seed: bigint,
    over: Record<string, unknown> = {},
    opts: { rest?: Address[]; market?: Address; user?: Address } = {},
  ) => {
    const [bank] = await pda(PROGRAM, [group.address, m.mint, new Uint8Array(le(seed, 8))]);
    const v = await h.vaults(bank);
    const [user] = await pda(DRIFT, ["user", v.liquidityAuth, new Uint8Array(le(0n, 2))]);
    const [stats] = await pda(DRIFT, ["user_stats", v.liquidityAuth]);
    const b: DriftBank = { address: bank, v, user, stats, m };
    const add = s.ix(
      "lending_pool_add_bank_drift",
      {
        bank_config: {
          oracle: pk(m.oracle),
          asset_weight_init: fx(ratio(8n, 10n)),
          asset_weight_maint: fx(ratio(9n, 10n)),
          deposit_limit: new BN("1000000000000"),
          oracle_setup: m.swb ? { DriftSwitchboardPull: {} } : { DriftPythPull: {} },
          operational_state: { Operational: {} },
          risk_tier: { Collateral: {} },
          config_flags: 1,
          total_asset_value_init_limit: new BN(0),
          oracle_max_age: 60,
          oracle_max_confidence: 0,
          ...over,
        },
        bank_seed: new BN(seed.toString()),
      },
      [
        { address: group.address, writable: true },
        { address: admin.address, signer: admin },
        { address: admin.address, signer: admin, writable: true },
        { address: m.mint },
        { address: bank, writable: true },
        { address: opts.market ?? m.market },
        { address: opts.user ?? user },
        { address: stats },
        { address: v.liquidityAuth },
        { address: v.liquidity, writable: true },
        { address: v.insuranceAuth },
        { address: v.insurance, writable: true },
        { address: v.feeAuth },
        { address: v.fee, writable: true },
        { address: TOKEN_PROGRAM },
        { address: SYSTEM },
        { address: INSTRUCTIONS },
        ...(opts.rest ?? [m.oracle, m.market]).map((address) => ({ address })),
      ],
    );
    return [add, b] as const;
  };
  const initUser = (b: DriftBank, payer: KeyPairSigner, tokens: Address, amount: bigint) =>
    s.ix("drift_init_user", { amount: new BN(amount.toString()) }, [
      { address: payer.address, signer: payer, writable: true },
      { address: tokens, writable: true },
      { address: b.address },
      { address: b.v.liquidityAuth },
      { address: b.v.liquidity, writable: true },
      { address: b.m.mint, writable: true },
      { address: b.stats, writable: true },
      { address: b.user, writable: true },
      { address: state, writable: true },
      { address: b.m.market, writable: true },
      { address: b.m.vault, writable: true },
      { address: PROGRAM },
      { address: DRIFT },
      { address: TOKEN_PROGRAM },
      { address: RENT },
      { address: SYSTEM },
    ]);
  const deposit = (b: DriftBank, account: Address, user: KeyPairSigner, tokens: Address, amount: bigint) =>
    s.ix("drift_deposit", { amount: new BN(amount.toString()) }, [
      { address: group.address },
      { address: account, writable: true },
      { address: user.address, signer: user },
      { address: b.address, writable: true },
      { address: PROGRAM },
      { address: b.v.liquidityAuth },
      { address: b.v.liquidity, writable: true },
      { address: tokens, writable: true },
      { address: state },
      { address: b.user, writable: true },
      { address: b.stats, writable: true },
      { address: b.m.market, writable: true },
      { address: b.m.vault, writable: true },
      { address: b.m.mint },
      { address: DRIFT },
      { address: TOKEN_PROGRAM },
      { address: SYSTEM },
    ]);
  const withdraw = (b: DriftBank, account: Address, user: KeyPairSigner, tokens: Address, amount: bigint, all: boolean | null, rest: Address[]) => {
    const i = s.ix("drift_withdraw", { amount: new BN(amount.toString()), withdraw_all: all }, [
      { address: group.address },
      { address: account, writable: true },
      { address: user.address, signer: user },
      { address: b.address, writable: true },
      { address: PROGRAM },
      { address: b.v.liquidityAuth },
      { address: b.v.liquidity, writable: true },
      { address: tokens, writable: true },
      { address: state },
      { address: b.user, writable: true },
      { address: b.stats, writable: true },
      { address: b.m.market, writable: true },
      { address: b.m.vault, writable: true },
      ...Array(6).fill({ address: PROGRAM }),
      { address: signer },
      { address: b.m.mint },
      { address: DRIFT },
      { address: TOKEN_PROGRAM },
      { address: SYSTEM },
    ]);
    return { ...i, accounts: [...i.accounts!, ...rest.map((address) => ({ address, role: AccountRole.READONLY }))] } as Instruction;
  };
  const watch = (b: DriftBank, ...more: Address[]) => [b.address, b.v.liquidity, b.user, b.stats, b.m.market, b.m.vault, ...more];
  const newUser = async () => {
    const user = await s.funded();
    const account = await s.key();
    await run("account", user, [h.accountInit(group.address, account, user)], [account.address]);
    return { user, account: account.address };
  };
  const driftBank = async (m: Market, seed: bigint) => {
    const [add, b] = await addDriftBank(m, seed);
    await run("add drift bank", admin, [add], watch(b, group.address));
    const tokens = await h.tokenAccount(m.mint, admin.address, 1_000n);
    await run("drift init user", admin, [initUser(b, admin, tokens, 100n)], watch(b, tokens, state));
    return b;
  };
  /** A plain bank on a Pyth feed with another depositor's liquidity, to borrow against the Drift collateral. */
  const otherBank = async () => {
    const mint = await h.mint(TOKEN_PROGRAM, 6);
    const oracle = (await s.key()).address;
    const [add, bank] = await h.addBank(group.address, admin, mint, TOKEN_PROGRAM, bankConfig());
    await run("add other bank", admin, [add], [bank.address]);
    const feed = () => setPyth(oracle, { price: 1_000_000n, conf: 1_000n, expo: -6, publishTime: t });
    feed();
    await run("other oracle", admin, [h.configureOracle(group.address, admin, bank.address, 3, oracle, [oracle])], [bank.address]);
    const lender = await newUser();
    const tokens = await h.tokenAccount(mint, lender.user.address, 500_000_000_000n);
    await run(
      "lend",
      lender.user,
      [h.deposit(group.address, lender.account, lender.user, bank.address, tokens, bank.v.liquidity, 500_000_000_000n)],
      [bank.address],
    );
    return { mint, oracle, bank, feed };
  };

  beforeAll(async () => {
    await h.load();
    for (const vm of s.vms()) vm.addProgramFromFile(DRIFT, program("drift.so"));
    admin = h.admin;
    h.setClock(t, slot);
    await run("init fee state", admin, [h.initFeeState(admin, h.feeWallet)], [h.feeState]);
    group = await s.key();
    await run("group init", admin, [h.groupInit(group, admin)], [group.address]);
    usdcMint = await h.mint(TOKEN_PROGRAM, 6);
    [state] = await pda(DRIFT, ["drift_state"]);
    [signer] = await pda(DRIFT, ["drift_signer"]);
    await run(
      "drift initialize",
      admin,
      [
        dix("initialize", {}, [
          { address: admin.address, signer: admin, writable: true },
          { address: state, writable: true },
          { address: usdcMint },
          { address: signer },
          { address: RENT },
          { address: SYSTEM },
          { address: TOKEN_PROGRAM },
        ]),
      ],
      [state],
    );
  });
  afterAll(() => report("marginfi-drift", s));

  it("adds a Drift bank and its user, refusing what the original refuses", async () => {
    const m = await newMarket(0, usdcMint, 1_000_000n);
    const otherMint = await h.mint(TOKEN_PROGRAM, 6);
    for (const [label, over, opts] of [
      ["kamino setup", { oracle_setup: { KaminoPythPush: {} } }, {}],
      ["one oracle account", {}, { rest: [m.oracle] }],
      ["wrong market key", {}, { rest: [m.oracle, usdcMint] }],
      ["user of another authority", {}, { user: m.market }],
      ["weights out of order", { asset_weight_init: fx(ratio(95n, 100n)) }, {}],
    ] as const) {
      const [add] = await addDriftBank(m, 7n, over as Record<string, unknown>, opts as { rest?: Address[]; market?: Address; user?: Address });
      await run(`add drift bank: ${label}`, admin, [add], [group.address], true);
    }
    const [wrongMint] = await addDriftBank({ ...m, mint: otherMint }, 7n);
    await run("add drift bank: market of another mint", admin, [wrongMint], [group.address], true);
    const b = await driftBank(m, 0n);
    const tokens = await h.tokenAccount(m.mint, admin.address, 1_000n);
    await run("drift init user: again", admin, [initUser(b, admin, tokens, 50n)], watch(b, tokens), true);
    const [add2, b2] = await addDriftBank(m, 1n);
    await run("add another drift bank", admin, [add2], watch(b2, group.address));
    await run("drift init user: 9 tokens", admin, [initUser(b2, admin, tokens, 9n)], watch(b2, tokens), true);
  });

  it("takes deposits into Drift and gives them back, pricing them at the market's interest", async () => {
    tick();
    const m = markets[0]!;
    const [add, b] = await addDriftBank(m, 2n);
    await run("add drift bank", admin, [add], watch(b, group.address));
    const seedTokens = await h.tokenAccount(m.mint, admin.address, 1_000n);
    await run("drift init user", admin, [initUser(b, admin, seedTokens, 100n)], watch(b, seedTokens, state));
    const other = await otherBank();
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(m.mint, user.address, 100_000_000n);
    tick();
    refreshFeeds();
    other.feed();
    fresh(m);
    await run("drift deposit", user, [deposit(b, account, user, tokens, 10_000_000n)], watch(b, account, tokens));
    await run("drift deposit: more than the user has", user, [deposit(b, account, user, tokens, 900_000_000n)], watch(b, account, tokens), true);
    const to = await h.tokenAccount(other.mint, user.address, 0n);
    const rest = ordered([b.address, m.oracle, m.market], [other.bank.address, other.oracle]);
    await run("borrow against drift", user, [h.borrow(group.address, account, user, other.bank, to, 5_000_000n, { rest })], [account, other.bank.address, to]);
    await run("borrow: past the drift collateral", user, [h.borrow(group.address, account, user, other.bank, to, 5_000_000n, { rest })], [account], true);
    await run("drift withdraw with a debt", user, [withdraw(b, account, user, tokens, 1_000_000n, null, rest)], watch(b, account, tokens));
    await run("drift withdraw: all of it, with a debt", user, [withdraw(b, account, user, tokens, 0n, true, rest)], watch(b, account, tokens), true);
    await run("drift withdraw: no oracles", user, [withdraw(b, account, user, tokens, 100_000n, null, [])], watch(b, account, tokens), true);
    await run("drift withdraw: more than deposited", user, [withdraw(b, account, user, tokens, 50_000_000n, null, rest)], watch(b, account, tokens), true);
    // The market's cumulative deposit interest grows by a fifth: the pulse, a borrow and a withdrawal price through it.
    tick();
    refreshFeeds();
    other.feed();
    fresh(m);
    const interest = data(m.market).readBigUInt64LE(CUMULATIVE_DEPOSIT_INTEREST) + (data(m.market).readBigUInt64LE(CUMULATIVE_DEPOSIT_INTEREST + 8) << 64n);
    poke(m.market, CUMULATIVE_DEPOSIT_INTEREST, le((interest * 6n) / 5n, 16));
    // The vault holds what that interest owes the depositors.
    poke(m.vault, 64, le(data(m.vault).readBigUInt64LE(64) * 2n, 8));
    await run("pulse drift bank", user, [h.pulse(group.address, b.address, [m.oracle, m.market])], [b.address]);
    await run(
      "borrow at the new interest",
      user,
      [h.borrow(group.address, account, user, other.bank, to, 500_000n, { rest })],
      [account, other.bank.address, to],
    );
    await run("drift withdraw at the new interest", user, [withdraw(b, account, user, tokens, 500_000n, null, rest)], watch(b, account, tokens));
    await run("drift deposit at the new interest", user, [deposit(b, account, user, tokens, 3_000_000n)], watch(b, account, tokens));
    // A fixed price (FixedDrift): $1.10 times the market's cumulative interest, priced from the spot market alone.
    const fixedRest = ordered([b.address, m.market], [other.bank.address, other.oracle]);
    await run(
      "fixed price: not the bank's market",
      admin,
      [h.setOraclePrice(group.address, admin, b.address, (11n * ONE) / 10n, 8, [other.oracle])],
      [b.address],
      true,
    );
    await run("fixed price", admin, [h.setOraclePrice(group.address, admin, b.address, (11n * ONE) / 10n, 8, [m.market])], [b.address]);
    await run("pulse fixed drift bank", user, [h.pulse(group.address, b.address, [m.market])], [b.address]);
    await run(
      "borrow against fixed drift",
      user,
      [h.borrow(group.address, account, user, other.bank, to, 300_000n, { rest: fixedRest })],
      [account, other.bank.address, to],
    );
    tick();
    other.feed();
    await run(
      "borrow: fixed drift, market stale",
      user,
      [h.borrow(group.address, account, user, other.bank, to, 1_000n, { rest: fixedRest })],
      [account],
      true,
    );
    fresh(m);
    await run("back to the feed", admin, [h.configureOracle(group.address, admin, b.address, 9, m.oracle, [m.oracle, m.market])], [b.address]);
    refreshFeeds();
    // Enough to repay the debt and its interest, then everything out.
    h.tokenAccountAt(to, other.mint, user.address, data(to).readBigUInt64LE(64) + 1_000_000n);
    await run(
      "repay",
      user,
      [h.repay(group.address, account, user, other.bank.address, to, other.bank.v.liquidity, 0n, { all: true })],
      [account, other.bank.address],
    );
    await run("drift withdraw all", user, [withdraw(b, account, user, tokens, 0n, true, [])], watch(b, account, tokens));
  });

  it("prices a Drift bank of another market on a Switchboard feed as the original does", async () => {
    tick();
    const mint = await h.mint(TOKEN_PROGRAM, 9);
    const m = await newMarket(1, mint, 150_000_000n, true);
    const b = await driftBank(m, 0n);
    const other = await otherBank();
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(m.mint, user.address, 10_000_000_000n);
    tick();
    refreshFeeds();
    other.feed();
    fresh(m);
    await run("switchboard drift deposit", user, [deposit(b, account, user, tokens, 2_000_000_000n)], watch(b, account, tokens));
    const to = await h.tokenAccount(other.mint, user.address, 0n);
    const rest = ordered([b.address, m.oracle, m.market], [other.bank.address, other.oracle]);
    await run(
      "borrow against switchboard drift",
      user,
      [h.borrow(group.address, account, user, other.bank, to, 100_000_000n, { rest })],
      [account, other.bank.address, to],
    );
    tick();
    refreshFeeds();
    other.feed();
    fresh(m);
    const interest = data(m.market).readBigUInt64LE(CUMULATIVE_DEPOSIT_INTEREST) + (data(m.market).readBigUInt64LE(CUMULATIVE_DEPOSIT_INTEREST + 8) << 64n);
    poke(m.market, CUMULATIVE_DEPOSIT_INTEREST, le((interest * 3n) / 2n, 16));
    poke(m.vault, 64, le(data(m.vault).readBigUInt64LE(64) * 2n, 8));
    await run("pulse switchboard drift bank", user, [h.pulse(group.address, b.address, [m.oracle, m.market])], [b.address]);
    await run("switchboard drift withdraw with a debt", user, [withdraw(b, account, user, tokens, 100_000_000n, null, rest)], watch(b, account, tokens));
    await run(
      "borrow: wrong spot market",
      user,
      [
        h.borrow(group.address, account, user, other.bank, to, 1_000n, {
          rest: ordered([b.address, m.oracle, other.oracle], [other.bank.address, other.oracle]),
        }),
      ],
      [account],
      true,
    );
    t += 120n;
    slot += 3n;
    h.setClock(t, slot);
    other.feed();
    await run("borrow: stale spot market", user, [h.borrow(group.address, account, user, other.bank, to, 1_000n, { rest })], [account], true);
  });

  it("harvests a reward Drift's admin paid into a Drift bank, as the original does", async () => {
    tick();
    // A bank of a market other than USDC's: its user's USDC position (the first) stays empty, its own is the second,
    // and Drift's admin pays a reward into the third.
    const rewardMint = await h.mint(TOKEN_PROGRAM, 6);
    const reward = await newMarket(2, rewardMint, 2_000_000n);
    const usdc = await newMarket(3, await h.mint(TOKEN_PROGRAM, 6), 1_000_000n);
    const b = await driftBank(usdc, 0n);
    // Drift's admin deposits into the bank's user in the reward market.
    const adminTokens = await h.tokenAccount(rewardMint, admin.address, 1_000_000_000n);
    const adminDeposit = {
      programAddress: DRIFT,
      accounts: [
        { address: state, role: AccountRole.READONLY },
        { address: b.user, role: AccountRole.WRITABLE },
        { address: admin.address, role: AccountRole.READONLY_SIGNER, signer: admin },
        { address: reward.vault, role: AccountRole.WRITABLE },
        { address: adminTokens, role: AccountRole.WRITABLE },
        { address: TOKEN_PROGRAM, role: AccountRole.READONLY },
        { address: reward.market, role: AccountRole.WRITABLE },
      ],
      data: new Uint8Array(
        Buffer.concat([Buffer.from(createHash("sha256").update("global:admin_deposit").digest().subarray(0, 8)), le(2n, 2), le(5_000_000n, 8)]),
      ),
    } as Instruction;
    await run("drift admin deposit", admin, [adminDeposit], [b.user, reward.vault]);
    const [intermediary] = await pda(ATA_PROGRAM, [b.v.liquidityAuth, TOKEN_PROGRAM, rewardMint]);
    const [destination] = await pda(ATA_PROGRAM, [h.feeWallet, TOKEN_PROGRAM, rewardMint]);
    h.tokenAccountAt(intermediary, rewardMint, b.v.liquidityAuth);
    h.tokenAccountAt(destination, rewardMint, h.feeWallet);
    const harvest = (market: Market, dst = destination, rest: Address[] = [usdc.market, reward.market]) => {
      const i = s.ix("drift_harvest_reward", {}, [
        { address: b.address },
        { address: h.feeState },
        { address: b.v.liquidityAuth },
        { address: intermediary, writable: true },
        { address: dst, writable: true },
        { address: state },
        { address: b.user, writable: true },
        { address: b.stats, writable: true },
        { address: market.market, writable: true },
        { address: market.vault, writable: true },
        { address: signer },
        { address: market.mint },
        { address: DRIFT },
        { address: TOKEN_PROGRAM },
      ]);
      return { ...i, accounts: [...i.accounts!, ...rest.map((address) => ({ address, role: AccountRole.WRITABLE }))] } as Instruction;
    };
    const wrong = await h.tokenAccount(rewardMint, admin.address, 0n);
    await run("drift harvest: not the fee wallet's account", admin, [harvest(reward, wrong)], [destination, b.user], true);
    await run("drift harvest: the bank's own market", admin, [harvest(usdc)], [destination, b.user], true);
    await run("drift harvest: no reward in that market", admin, [harvest(markets[0]!)], [destination, b.user], true);
    await run("drift harvest", admin, [harvest(reward)], [destination, intermediary, b.user, reward.vault]);
    expect(data(destination).readBigUInt64LE(64)).toBeGreaterThan(0n);
    await run("drift harvest: nothing left", admin, [harvest(reward)], [destination, b.user], true);
  });

  it("claims a Drift bad-debt distribution for a Drift bank and sweeps it to the fee wallet, as the original does", async () => {
    tick();
    const m = await newMarket(4, await h.mint(TOKEN_PROGRAM, 6), 1_000_000n);
    const b = await driftBank(m, 0n);
    for (const vm of s.vms()) vm.addProgramFromFile(DISTRIBUTOR, program("merkle_distributor.so"));
    // A distributor as the distributor's NewDistributor leaves it (its admin is a fixed key, so it is written in both
    // ledgers): halfway through vesting, a claim pays half its amount at once and the rest by the time elapsed.
    const claimMint = await h.mint(TOKEN_PROGRAM, 6);
    const [distributor, bump] = await pda(DISTRIBUTOR, ["MerkleDistributor", claimMint, new Uint8Array(le(0n, 8))]);
    const [vault] = await pda(ATA_PROGRAM, [distributor, TOKEN_PROGRAM, claimMint]);
    h.tokenAccountAt(vault, claimMint, distributor, 10_000_000n);
    const amount = 4_000_000n;
    // The distributor's leaves: sha256(0 ‖ sha256(claimant ‖ unlocked ‖ locked)); a node hashes 1 and its sorted children.
    const leaf = (c: Address, unlocked: bigint) => sha(Uint8Array.of(0), sha(key(c), le(unlocked, 8), le(0n, 8)));
    const [mine, other] = [leaf(b.v.liquidityAuth, amount), leaf(admin.address, 1_000_000n)];
    const root = Buffer.compare(mine, other) <= 0 ? sha(Uint8Array.of(1), mine, other) : sha(Uint8Array.of(1), other, mine);
    const d = Buffer.alloc(352);
    createHash("sha256").update("account:MerkleDistributor").digest().copy(d, 0, 0, 8);
    d[8] = bump;
    root.copy(d, 17);
    key(claimMint).copy(d, 49);
    key(vault).copy(d, 81);
    le(10_000_000n, 8).copy(d, 113); // max_total_claim
    le(2n, 8).copy(d, 121); // max_num_nodes
    le(t - 1_000n, 8).copy(d, 153); // start_ts
    le(t + 1_000n, 8).copy(d, 161); // end_ts
    le(t + 1_000n + 86_400n, 8).copy(d, 169); // clawback_start_ts
    key(admin.address).copy(d, 177);
    key(admin.address).copy(d, 209);
    for (const vm of s.vms())
      vm.setAccount({
        address: distributor,
        data: new Uint8Array(d),
        executable: false,
        lamports: lamports(10_000_000n),
        programAddress: DISTRIBUTOR,
        space: 352n,
      });
    const [claimStatus] = await pda(DISTRIBUTOR, ["ClaimStatus", b.v.liquidityAuth, distributor]);
    const [claimant] = await pda(ATA_PROGRAM, [b.v.liquidityAuth, TOKEN_PROGRAM, claimMint]);
    const [destination] = await pda(ATA_PROGRAM, [h.feeWallet, TOKEN_PROGRAM, claimMint]);
    const claim = (o: { amount?: bigint; proof?: Buffer[]; bank?: DriftBank; claimant?: Address; destination?: Address; wallet?: Address } = {}) =>
      s.ix("drift_claim_bad_debt", { amount: new BN((o.amount ?? amount).toString()), proof: (o.proof ?? [other]).map((x) => [...x]) }, [
        { address: admin.address, signer: admin, writable: true },
        { address: (o.bank ?? b).address },
        { address: h.feeState },
        { address: (o.bank ?? b).v.liquidityAuth, writable: true },
        { address: (o.bank ?? b).user },
        { address: (o.bank ?? b).stats },
        { address: distributor, writable: true },
        { address: claimStatus, writable: true },
        { address: vault, writable: true },
        { address: claimMint },
        { address: o.wallet ?? h.feeWallet },
        { address: o.claimant ?? claimant, writable: true },
        { address: o.destination ?? destination, writable: true },
        { address: DISTRIBUTOR },
        { address: ATA_PROGRAM },
        { address: TOKEN_PROGRAM },
        { address: SYSTEM },
      ]);
    const watched = [distributor, claimStatus, vault, claimant, destination, b.v.liquidityAuth];
    const other2 = (await s.key()).address;
    await run("drift claim: not the fee wallet", admin, [claim({ wallet: other2 })], watched, true);
    await run("drift claim: not the authority's token account", admin, [claim({ claimant: destination })], watched, true);
    await run("drift claim: not the fee wallet's token account", admin, [claim({ destination: claimant })], watched, true);
    await run("drift claim: a wrong amount", admin, [claim({ amount: amount + 1n })], watched, true);
    await run("drift claim: a wrong proof", admin, [claim({ proof: [mine] })], watched, true);
    await run("drift claim", admin, [claim()], watched);
    // Half at once, and of the other half the share of the vesting time elapsed (just past half): the rest is forgone.
    expect(data(destination).readBigUInt64LE(64)).toBeGreaterThanOrEqual(amount / 2n);
    expect(data(destination).readBigUInt64LE(64)).toBeLessThan(amount);
    expect(data(claimant).readBigUInt64LE(64)).toBe(0n);
    tick();
    await run("drift claim: claimed already", admin, [claim()], watched, true);
  });

  it("fails as the original does on a scaled balance past u64, a deposit limit past I80F48, and a foreign account", async () => {
    tick();
    if (markets.length === 0) await newMarket(0, usdcMint, 1_000_000n);
    // A 2-decimal mint (Drift makes no market of one, so its decimals are written in after): the bank's deposit limit is
    // scaled by 10^7 to Drift's 9 decimals, which overflows I80F48 (6004).
    const m = await newMarket(markets.length, await h.mint(TOKEN_PROGRAM, 6), 1_000_000n);
    poke(m.mint, 44, Buffer.from([2]));
    const [add, b] = await addDriftBank(m, 0n, { deposit_limit: new BN("18446744073709551614") });
    await run("add drift bank: huge deposit limit", admin, [add], watch(b, group.address));
    const seedTokens = await h.tokenAccount(m.mint, admin.address, 1_000n);
    await run("drift init user", admin, [initUser(b, admin, seedTokens, 100n)], watch(b, seedTokens, state));
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(m.mint, user.address, 1_000_000n);
    fresh(m);
    await run("drift deposit: limit past I80F48", user, [deposit(b, account, user, tokens, 1_000n)], watch(b, account, tokens), true);
    // A scaled balance past u64 (the market's 6 decimals: amount × 10^13 / 10^10), checked before any transfer:
    // Anchor's InvalidNumericConversion, 4102.
    await run("drift deposit: scaled balance past u64", user, [deposit(b, account, user, tokens, 20_000_000_000_000_000n)], watch(b, account, tokens), true);
    // An account Drift does not own as the spot market: Anchor loads it before any constraint (3007).
    const stranger = await h.tokenAccount(m.mint, user.address, 0n);
    const d = deposit(b, account, user, tokens, 1_000n);
    const wrong = { ...d, accounts: d.accounts!.map((a) => (a.address === m.market ? { ...a, address: stranger } : a)) } as Instruction;
    await run("drift deposit: spot market not Drift's", user, [wrong], watch(b, account, tokens), true);
  });

  it("matches the original through random deposits, withdrawals, borrows and interest", async () => {
    // FUZZ_SEED=<seed> reproduces a run, FUZZ_STEPS=<n> lengthens it, FUZZ_VERBOSE=1 prints the failures' codes.
    // Every transaction must match the original's outcome, error code, account bytes and events, whichever it is.
    const seed = BigInt(process.env.FUZZ_SEED ?? Date.now());
    const steps = Number(process.env.FUZZ_STEPS ?? 60);
    const rng = new Rng(seed);
    tick();
    // Spot markets are made in index order, the USDC market first.
    if (markets.length === 0) await newMarket(0, usdcMint, 1_000_000n);
    const m = await newMarket(markets.length, await h.mint(TOKEN_PROGRAM, rng.pick([6, 8, 9])), 1_000_000n + BigInt(rng.int(200_000_000)), rng.chance(50));
    const b = await driftBank(m, 0n);
    const other = await otherBank();
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(m.mint, user.address, 1_000_000_000_000n);
    const to = await h.tokenAccount(other.mint, user.address, 0n);
    // The health accounts: the banks the account has a balance in (tracked from what succeeded), now and then wrong.
    let deposited = false;
    let owing = false;
    const rest = (borrowing = false) => {
      const groups = [...(deposited ? [[b.address, m.oracle, m.market]] : []), ...(owing || borrowing ? [[other.bank.address, other.oracle]] : [])];
      if (rng.chance(10)) groups.push([other.bank.address, other.oracle].slice(0, 1));
      return ordered(...groups);
    };
    /** h.run, counting what succeeded: a run that only ever fails would prove little. */
    const ok = new Map<string, number>();
    const go = async (what: string, ...more: Parameters<typeof h.run> extends [string, ...infer R] ? R : never) => {
      const o = await h.run(`fuzz drift (seed ${seed}): ${what}`, ...more);
      if (o === "ok") ok.set(what, (ok.get(what) ?? 0) + 1);
      else if (process.env.FUZZ_VERBOSE) console.log(`${what}: ${o.replace(/.*code: (\d+).*/, "$1")}`);
      return o;
    };
    const amount = () => (rng.chance(25) ? BigInt(rng.int(30)) : rng.chance(50) ? rng.next() % 10_000_000n : rng.next() % 2_000_000_000n);
    for (let i = 0; i < steps; i++) {
      if (rng.chance(40)) {
        tick(BigInt(1 + rng.int(600)));
        refreshFeeds();
        other.feed();
      }
      // Drift moves the market's interest time only when interest accrues: written in now and then, or left stale.
      if (rng.chance(85)) fresh(m);
      switch (rng.int(7)) {
        case 0:
        case 1:
          if ((await go("deposit", user, [deposit(b, account, user, tokens, amount())], watch(b, account, tokens))) === "ok") deposited = true;
          break;
        case 2:
          await go("withdraw", user, [withdraw(b, account, user, tokens, amount(), null, rest())], watch(b, account, tokens));
          break;
        case 3:
          if ((await go("withdraw all", user, [withdraw(b, account, user, tokens, 0n, true, rest())], watch(b, account, tokens))) === "ok") deposited = false;
          break;
        case 4:
          if (
            (await go(
              "borrow",
              user,
              [h.borrow(group.address, account, user, other.bank, to, rng.next() % 50_000_000n, { rest: rest(true) })],
              [account, other.bank.address, to],
            )) === "ok"
          )
            owing = true;
          break;
        case 5: {
          // The cumulative deposit interest only grows; the vault holds what it owes.
          const interest =
            data(m.market).readBigUInt64LE(CUMULATIVE_DEPOSIT_INTEREST) + (data(m.market).readBigUInt64LE(CUMULATIVE_DEPOSIT_INTEREST + 8) << 64n);
          poke(m.market, CUMULATIVE_DEPOSIT_INTEREST, le(interest + (interest * BigInt(rng.int(500))) / 10_000n + BigInt(rng.int(1_000_000)), 16));
          poke(m.vault, 64, le(data(m.vault).readBigUInt64LE(64) * 2n + 1_000_000n, 8));
          await go("pulse", user, [h.pulse(group.address, b.address, [m.oracle, m.market])], [b.address]);
          break;
        }
        default:
          h.tokenAccountAt(to, other.mint, user.address, data(to).readBigUInt64LE(64) + 1_000_000_000n);
          if (
            (await go(
              "repay all",
              user,
              [h.repay(group.address, account, user, other.bank.address, to, other.bank.v.liquidity, 0n, { all: true })],
              [account, other.bank.address],
            )) === "ok"
          )
            owing = false;
      }
    }
    console.log(`fuzz drift (seed ${seed}): succeeded ${JSON.stringify(Object.fromEntries(ok))}`);
    expect(ok.get("deposit") ?? 0, "deposits succeeded").toBeGreaterThan(0);
    expect((ok.get("withdraw") ?? 0) + (ok.get("withdraw all") ?? 0), "withdrawals succeeded").toBeGreaterThan(0);
  });
});
