// Marginfi part 5 C against the mainnet binary: Solend banks (lending_pool_add_bank_solend, solend_init_obligation,
// solend_deposit, solend_withdraw) over Solend's mainnet program (test/programs/solend.so), loaded into both ledgers:
// a lending market and reserves made with Solend's own instructions, Pyth and Switchboard feeds, the reserve's exchange
// rate in the risk engine, the price cache's multiplier.
import { type Address, type Instruction, type KeyPairSigner, address, lamports } from "@solana/kit";
import { web3 } from "@anchor-lang/core";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BN, TOKEN_PROGRAM, pda } from "../../test/harness.js";
import { SYSTEM, key, program, report } from "./jito-helpers.js";
import { Rng } from "./fuzz-rng.js";
import { INSTRUCTIONS, PROGRAM, bankConfig, fx, le, marginfiPair, ratio } from "./marginfi-helpers.js";

const SOLEND = address("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");
const RENT = address("SysvarRent111111111111111111111111111111111");
const PYTH_RECEIVER = address("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const SWITCHBOARD = address("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
/** Solend's "no oracle" key. */
const NULL = address("nu11111111111111111111111111111111111111111");
const ATA = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const u64 = (n: bigint) => le(n, 8);
const pk = (a: Address) => new web3.PublicKey(a);

describe.skipIf(!existsSync(program("solend.so")))("Marginfi v2 port against the mainnet binary: Solend banks", () => {
  const h = marginfiPair();
  const { s, setPyth, setSwb } = h;
  /**
   * h.run: a transaction not marked failing must succeed (both failing alike would otherwise pass unnoticed), and one
   * marked failing must fail with the original's error, code included ("if-panics": where the original fails with a
   * runtime error, both failing).
   */
  const run = async (...args: Parameters<typeof h.run>) => {
    const [label, payer, ixs, watched, failing] = args;
    if (failing === "if-panics") return h.run(...args);
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
  const ix = (programAddress: Address, accounts: { address: Address; signer?: KeyPairSigner; writable?: boolean }[], data: Buffer): Instruction => ({
    programAddress,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: (a.signer ? 2 : 0) + (a.writable ? 1 : 0),
      ...(a.signer ? { signer: a.signer } : {}),
    })) as never,
    data: new Uint8Array(data),
  });
  /** An empty account of `owner`, written into both (Solend's instructions initialize them). */
  const blank = async (owner: Address, space: number) => {
    const a = (await s.key()).address;
    for (const vm of s.vms())
      vm.setAccount({
        address: a,
        data: new Uint8Array(space),
        executable: false,
        lamports: lamports(10_000_000n),
        programAddress: owner,
        space: BigInt(space),
      });
    return a;
  };
  /** [bank, its oracle accounts…] groups in the order the account's balances sort to (descending bank key), flattened. */
  const ordered = (...groups: Address[][]) => groups.sort((x, y) => Buffer.compare(Buffer.from(pk(y[0]!).toBytes()), Buffer.from(pk(x[0]!).toBytes()))).flat();
  const data = (a: Address) => Buffer.from((s.original.getAccount(a) as { data: Uint8Array }).data);
  /** Both ledgers' copies of an account, edited alike. */
  const poke = (a: Address, at: number, bytes: Buffer) => {
    for (const vm of s.vms()) {
      const x = vm.getAccount(a);
      if (!x.exists) throw new Error(`no account ${a}`);
      const d = Buffer.from(x.data);
      bytes.copy(d, at);
      vm.setAccount({ ...x, address: a, data: new Uint8Array(d) });
    }
  };

  let market: Address;
  let marketAuth: Address;
  /** `oracle` prices the marginfi bank (Pyth or Switchboard); Solend prices the reserve itself with its own Pyth feed. */
  type Reserve = {
    mint: Address;
    reserve: Address;
    supply: Address;
    colMint: Address;
    colSupply: Address;
    oracle: Address;
    solendOracle: Address;
    swb: boolean;
    price: bigint;
  };
  const reserves: Reserve[] = [];
  /** Every feed at its price, published now. */
  const refreshFeeds = () => {
    for (const r of reserves) {
      if (r.swb) setSwb(r.oracle, { value: r.price * 10n ** 12n, lastUpdate: t });
      setPyth(r.solendOracle, { price: r.price, conf: r.price / 1000n, expo: -6, publishTime: t });
    }
  };
  /** Solend's RefreshReserve. */
  const refresh = (r: Reserve) => ix(SOLEND, [{ address: r.reserve, writable: true }, { address: r.solendOracle }, { address: NULL }], Buffer.from([3]));
  /** A Solend reserve of a new mint, seeded with 1,000 tokens; its marginfi bank priced by Pyth (or Switchboard). */
  const newReserve = async (price: bigint, swb = false, decimals = 6): Promise<Reserve> => {
    const mint = await h.mint(TOKEN_PROGRAM, decimals);
    const solendOracle = (await s.key()).address;
    const oracle = swb ? (await s.key()).address : solendOracle;
    const r: Reserve = {
      mint,
      reserve: await blank(SOLEND, 619),
      supply: await blank(TOKEN_PROGRAM, 165),
      colMint: await blank(TOKEN_PROGRAM, 82),
      colSupply: await blank(TOKEN_PROGRAM, 165),
      oracle,
      solendOracle,
      swb,
      price,
    };
    reserves.push(r);
    refreshFeeds();
    const feeReceiver = await blank(TOKEN_PROGRAM, 165);
    const destination = await blank(TOKEN_PROGRAM, 165);
    const seed = 1_000n * 10n ** BigInt(decimals);
    const source = await h.tokenAccount(mint, admin.address, seed);
    const config = Buffer.concat([
      Buffer.from([2]),
      u64(seed),
      Buffer.from([80, 98, 75, 5, 85, 0, 6, 15]),
      u64(150n),
      u64(100000000000000n),
      u64(300000000000000n),
      Buffer.from([20]),
      u64(10n ** 18n),
      u64(10n ** 18n),
      key(feeReceiver),
      Buffer.from([30, 10]),
      u64(0n),
      Buffer.from([0, 10, 90]),
      u64(0n),
      Buffer.from([0]),
      u64(0n),
      u64(0n),
    ]);
    await run(
      "solend init reserve",
      admin,
      [
        ix(
          SOLEND,
          [
            { address: source, writable: true },
            { address: destination, writable: true },
            { address: r.reserve, writable: true },
            { address: mint },
            { address: r.supply, writable: true },
            { address: feeReceiver, writable: true },
            { address: r.colMint, writable: true },
            { address: r.colSupply, writable: true },
            { address: r.solendOracle },
            { address: r.solendOracle },
            { address: NULL },
            { address: market, writable: true },
            { address: marketAuth },
            { address: admin.address, signer: admin },
            { address: admin.address, signer: admin },
            { address: RENT },
            { address: TOKEN_PROGRAM },
          ],
          config,
        ),
      ],
      [r.reserve, r.supply, r.colMint, r.colSupply],
    );
    return r;
  };

  type SolendBank = { address: Address; v: Awaited<ReturnType<typeof h.vaults>>; obligation: Address; userCollateral: Address; r: Reserve };
  const addSolendBank = (r: Reserve, seed: bigint, over: Record<string, unknown> = {}, rest?: Address[], by: KeyPairSigner = admin) =>
    (async () => {
      const [bank] = await pda(PROGRAM, [group.address, r.mint, new Uint8Array(u64(seed))]);
      const v = await h.vaults(bank);
      const [obligation] = await pda(PROGRAM, ["solend_obligation", bank]);
      const [userCollateral] = await pda(ATA, [v.liquidityAuth, TOKEN_PROGRAM, r.colMint]);
      const b: SolendBank = { address: bank, v, obligation, userCollateral, r };
      const add = s.ix(
        "lending_pool_add_bank_solend",
        {
          bank_config: {
            oracle: pk(r.oracle),
            asset_weight_init: fx(ratio(8n, 10n)),
            asset_weight_maint: fx(ratio(9n, 10n)),
            deposit_limit: new BN("1000000000000"),
            oracle_setup: r.swb ? { SolendSwitchboardPull: {} } : { SolendPythPull: {} },
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
          { address: by.address, signer: by },
          { address: admin.address, signer: admin, writable: true },
          { address: r.mint },
          { address: bank, writable: true },
          { address: r.reserve },
          { address: obligation },
          { address: v.liquidityAuth },
          { address: v.liquidity, writable: true },
          { address: v.insuranceAuth },
          { address: v.insurance, writable: true },
          { address: v.feeAuth },
          { address: v.fee, writable: true },
          { address: TOKEN_PROGRAM },
          { address: SYSTEM },
          { address: INSTRUCTIONS },
          ...(rest ?? [r.oracle, r.reserve]).map((address) => ({ address })),
        ],
      );
      return [add, b] as const;
    })();
  /** The accounts init_obligation, deposit and withdraw share, from the user's token account on. */
  const venue = (b: SolendBank, tokens: Address, withdraw = false) => [
    { address: tokens, writable: true },
    { address: b.v.liquidityAuth, writable: withdraw },
    { address: b.v.liquidity, writable: true },
    { address: b.obligation, writable: true },
    { address: market, writable: withdraw },
    { address: marketAuth },
    { address: b.r.reserve, writable: true },
    { address: b.r.mint, writable: !withdraw },
    { address: b.r.supply, writable: true },
    { address: b.r.colMint, writable: true },
    { address: b.r.colSupply, writable: true },
    { address: b.userCollateral, writable: true },
  ];
  const feeds = (b: SolendBank) => [{ address: b.r.solendOracle }, { address: NULL }];
  const initObligation = (b: SolendBank, payer: KeyPairSigner, tokens: Address, amount: bigint) =>
    s.ix("solend_init_obligation", { amount: new BN(amount.toString()) }, [
      { address: payer.address, signer: payer, writable: true },
      { address: b.address },
      ...venue(b, tokens).map((m) => (m.address === b.r.mint ? { ...m, writable: true } : m)),
      ...feeds(b),
      { address: SOLEND },
      { address: TOKEN_PROGRAM },
      { address: RENT },
      { address: SYSTEM },
    ]);
  const deposit = (b: SolendBank, account: Address, user: KeyPairSigner, tokens: Address, amount: bigint) =>
    s.ix("solend_deposit", { amount: new BN(amount.toString()) }, [
      { address: group.address },
      { address: account, writable: true },
      { address: user.address, signer: user },
      { address: b.address, writable: true },
      ...venue(b, tokens).map((m) => (m.address === b.r.mint ? { ...m, writable: false } : m)),
      ...feeds(b),
      { address: SOLEND },
      { address: TOKEN_PROGRAM },
    ]);
  const withdraw = (b: SolendBank, account: Address, user: KeyPairSigner, tokens: Address, amount: bigint, all: boolean | null, rest: Address[]) => {
    const i = s.ix("solend_withdraw", { amount: new BN(amount.toString()), withdraw_all: all }, [
      { address: group.address },
      { address: account, writable: true },
      { address: user.address, signer: user },
      { address: b.address, writable: true },
      ...venue(b, tokens, true),
      { address: SOLEND },
      { address: TOKEN_PROGRAM },
    ]);
    return { ...i, accounts: [...i.accounts!, ...rest.map((address) => ({ address, role: 0 }) as never)] };
  };
  const watch = (b: SolendBank, ...more: Address[]) => [b.address, b.v.liquidity, b.obligation, b.r.reserve, b.r.supply, b.r.colSupply, ...more];
  const newUser = async () => {
    const user = await s.funded();
    const account = await s.key();
    await run("account", user, [h.accountInit(group.address, account, user)], [account.address]);
    return { user, account: account.address };
  };
  /** A Solend bank and its obligation, made with 100 of the admin's tokens. */
  const solendBank = async (r: Reserve, seed: bigint) => {
    const [add, b] = await addSolendBank(r, seed);
    await run("add solend bank", admin, [add], watch(b, group.address));
    h.tokenAccountAt(b.userCollateral, r.colMint, b.v.liquidityAuth);
    const tokens = await h.tokenAccount(r.mint, admin.address, 1_000n);
    await run("solend init obligation", admin, [refresh(r), initObligation(b, admin, tokens, 100n)], watch(b, tokens));
    return b;
  };

  beforeAll(async () => {
    await h.load();
    for (const vm of s.vms()) vm.addProgramFromFile(SOLEND, program("solend.so"));
    admin = h.admin;
    h.setClock(t, slot);
    await run("init fee state", admin, [h.initFeeState(admin, h.feeWallet)], [h.feeState]);
    group = await s.key();
    await run("group init", admin, [h.groupInit(group, admin)], [group.address]);
    market = await blank(SOLEND, 290);
    [marketAuth] = await pda(SOLEND, [market]);
    const quote = Buffer.alloc(32);
    quote.write("USD");
    await run(
      "solend init market",
      admin,
      [
        ix(
          SOLEND,
          [{ address: market, writable: true }, { address: RENT }, { address: TOKEN_PROGRAM }, { address: PYTH_RECEIVER }, { address: SWITCHBOARD }],
          Buffer.concat([Buffer.from([0]), key(admin.address), quote]),
        ),
      ],
      [market],
    );
  });
  afterAll(() => report("marginfi-venues", s));

  it("adds Solend banks and their obligations, refusing what the original refuses", async () => {
    const r = await newReserve(1_000_000n);
    const other = await newReserve(2_000_000n);
    // A setup that is not Solend's, the wrong reserve for the mint, the remaining accounts' count and keys, a stranger.
    for (const [label, over, rest, reserve] of [
      ["kamino setup", { oracle_setup: { KaminoPythPush: {} } }, undefined, undefined],
      ["plain pyth setup", { oracle_setup: { PythPushOracle: {} } }, undefined, undefined],
      ["one oracle account", {}, [r.oracle], undefined],
      ["wrong feed", {}, [other.oracle, r.reserve], undefined],
      ["wrong reserve key", {}, [r.oracle, other.reserve], undefined],
      ["reserve of another mint", {}, undefined, other.reserve],
      ["weights out of order", { asset_weight_init: fx(ratio(95n, 100n)) }, undefined, undefined],
      ["oracle age too short", { oracle_max_age: 5 }, undefined, undefined],
    ] as const) {
      const [add] = await addSolendBank(r, 7n, over as Record<string, unknown>, rest as Address[] | undefined);
      const accounts = reserve ? add.accounts!.map((a, i) => (i === 5 ? { ...a, address: reserve } : a)) : add.accounts!;
      await run(`add solend bank: ${label}`, admin, [{ ...add, accounts } as Instruction], [group.address], true);
    }
    const stranger = await s.funded();
    const [byStranger] = await addSolendBank(r, 7n, {}, undefined, stranger);
    await run("add solend bank: not the admin", admin, [byStranger], [group.address], true);

    const b = await solendBank(r, 0n);
    expect(data(b.obligation).length).toBe(1300);
    // A second obligation for the bank, too small a first deposit, a stale reserve.
    const [add2, b2] = await addSolendBank(r, 1n);
    await run("add another solend bank", admin, [add2], watch(b2, group.address));
    h.tokenAccountAt(b2.userCollateral, r.colMint, b2.v.liquidityAuth);
    const tokens = await h.tokenAccount(r.mint, admin.address, 1_000n);
    await run("init obligation: 9 tokens", admin, [refresh(r), initObligation(b2, admin, tokens, 9n)], watch(b2, tokens), true);
    await run("init obligation: again", admin, [refresh(r), initObligation(b, admin, tokens, 50n)], watch(b, tokens), true);
    tick();
    await run("init obligation: no refresh first", admin, [initObligation(b2, admin, tokens, 50n)], watch(b2, tokens));
    const sw = await newReserve(150_000_000n, true, 9);
    await solendBank(sw, 0n);
  });

  it("takes deposits into Solend and gives them back, pricing them at the reserve's rate", async () => {
    tick();
    const r = await newReserve(1_000_000n);
    const b = await solendBank(r, 0n);
    // A plain USDC bank to borrow from, with another depositor's liquidity.
    const usdcMint = await h.mint(TOKEN_PROGRAM, 6);
    const usdcOracle = (await s.key()).address;
    const [addUsdc, usdc] = await h.addBank(group.address, admin, usdcMint, TOKEN_PROGRAM, bankConfig());
    await run("add usdc bank", admin, [addUsdc], [usdc.address]);
    setPyth(usdcOracle, { price: 1_000_000n, conf: 1_000n, expo: -6, publishTime: t });
    await run("usdc oracle", admin, [h.configureOracle(group.address, admin, usdc.address, 3, usdcOracle, [usdcOracle])], [usdc.address]);
    const lender = await newUser();
    const lenderTokens = await h.tokenAccount(usdcMint, lender.user.address, 1_000_000_000n);
    await run(
      "lend usdc",
      lender.user,
      [h.deposit(group.address, lender.account, lender.user, usdc.address, lenderTokens, usdc.v.liquidity, 1_000_000_000n)],
      [usdc.address],
    );

    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(r.mint, user.address, 50_000_000n);
    tick();
    refreshFeeds();
    setPyth(usdcOracle, { price: 1_000_000n, conf: 1_000n, expo: -6, publishTime: t });
    await run("solend deposit: stale reserve", user, [deposit(b, account, user, tokens, 10_000_000n)], watch(b, account, tokens), true);
    await run("solend deposit", user, [refresh(r), deposit(b, account, user, tokens, 10_000_000n)], watch(b, account, tokens));
    const stranger = await h.tokenAccount(r.mint, user.address, 0n);
    const d = deposit(b, account, user, tokens, 1_000n);
    const notSolend = { ...d, accounts: d.accounts!.map((a) => (a.address === r.reserve ? { ...a, address: stranger } : a)) } as Instruction;
    await run("solend deposit: reserve not Solend's", user, [refresh(r), notSolend], watch(b, account, tokens), true);
    await run("solend deposit: more than the user has", user, [refresh(r), deposit(b, account, user, tokens, 60_000_000n)], watch(b, account, tokens), true);
    // Borrow against it: the Solend balance is priced at the feed times the reserve's rate.
    const usdcTo = await h.tokenAccount(usdcMint, user.address, 0n);
    const rest = ordered([b.address, r.oracle, r.reserve], [usdc.address, usdcOracle]);
    await run(
      "borrow against solend",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc, usdcTo, 5_000_000n, { rest })],
      [account, usdc.address, usdcTo],
    );
    await run(
      "borrow: too much",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc, usdcTo, 4_000_000n, { rest })],
      [account, usdc.address],
      true,
    );
    await run("borrow: refreshed earlier this slot", user, [h.borrow(group.address, account, user, usdc, usdcTo, 100_000n, { rest })], [account, usdc.address]);
    // With a debt, the original's withdrawal fails once its health checks pass: its circuit-breaker gate borrows the
    // bank it still holds (AccountBorrowFailed, a runtime error the port gives as custom error 12). Past health it fails
    // earlier.
    await run(
      "solend withdraw: with a debt",
      user,
      [refresh(r), withdraw(b, account, user, tokens, 1_000_000n, null, rest)],
      watch(b, account, tokens),
      "if-panics",
    );
    await run("solend withdraw: past health", user, [refresh(r), withdraw(b, account, user, tokens, 6_000_000n, null, rest)], watch(b, account, tokens), true);
    await run(
      "repay",
      user,
      [h.repay(group.address, account, user, usdc.address, usdcTo, usdc.v.liquidity, 5_100_000n, { all: true })],
      [account, usdc.address],
    );
    const solendRest = [b.address, r.oracle, r.reserve];
    await run("solend withdraw", user, [refresh(r), withdraw(b, account, user, tokens, 1_000_000n, null, solendRest)], watch(b, account, tokens));
    await run("solend withdraw: no oracles", user, [refresh(r), withdraw(b, account, user, tokens, 100_000n, null, [])], watch(b, account, tokens), true);
    await run(
      "solend withdraw: more than deposited",
      user,
      [refresh(r), withdraw(b, account, user, tokens, 20_000_000n, null, solendRest)],
      watch(b, account, tokens),
      true,
    );
    tick();
    refreshFeeds();
    await run("solend withdraw: stale reserve", user, [withdraw(b, account, user, tokens, 100_000n, null, solendRest)], watch(b, account, tokens), true);
    // Solend's borrowed liquidity (WAD) grows the reserve's total: about 1.1 tokens per collateral token.
    const reserveData = data(r.reserve);
    const extra = reserveData.readBigUInt64LE(259) / 10n;
    poke(r.reserve, 179, le(extra * 10n ** 18n, 16));
    await run("pulse solend bank", user, [refresh(r), h.pulse(group.address, b.address, [r.oracle, r.reserve])], [b.address]);
    await run(
      "solend withdraw at the new rate",
      user,
      [refresh(r), withdraw(b, account, user, tokens, 2_000_000n, null, solendRest)],
      watch(b, account, tokens),
    );
    await run("solend deposit at the new rate", user, [refresh(r), deposit(b, account, user, tokens, 3_000_000n)], watch(b, account, tokens));
    await run("solend withdraw all", user, [refresh(r), withdraw(b, account, user, tokens, 0n, true, [])], watch(b, account, tokens));
    expect(data(b.r.reserve).length).toBe(619);
  });

  it("prices a Solend bank on a Switchboard feed as the original does", async () => {
    tick();
    const r = await newReserve(150_000_000n, true, 9);
    const b = await solendBank(r, 0n);
    const usdcMint = await h.mint(TOKEN_PROGRAM, 6);
    const usdcOracle = (await s.key()).address;
    const [addUsdc, usdc] = await h.addBank(group.address, admin, usdcMint, TOKEN_PROGRAM, bankConfig());
    await run("add usdc bank", admin, [addUsdc], [usdc.address]);
    const usdcFeed = () => setPyth(usdcOracle, { price: 1_000_000n, conf: 1_000n, expo: -6, publishTime: t });
    usdcFeed();
    await run("usdc oracle", admin, [h.configureOracle(group.address, admin, usdc.address, 3, usdcOracle, [usdcOracle])], [usdc.address]);
    const lender = await newUser();
    const lenderTokens = await h.tokenAccount(usdcMint, lender.user.address, 1_000_000_000n);
    await run(
      "lend usdc",
      lender.user,
      [h.deposit(group.address, lender.account, lender.user, usdc.address, lenderTokens, usdc.v.liquidity, 1_000_000_000n)],
      [usdc.address],
    );

    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(r.mint, user.address, 10_000_000_000n);
    await run("switchboard solend deposit", user, [refresh(r), deposit(b, account, user, tokens, 2_000_000_000n)], watch(b, account, tokens));
    const usdcTo = await h.tokenAccount(usdcMint, user.address, 0n);
    const rest = ordered([b.address, r.oracle, r.reserve], [usdc.address, usdcOracle]);
    await run(
      "borrow against a switchboard solend bank",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc, usdcTo, 100_000_000n, { rest })],
      [account, usdc.address, usdcTo],
    );
    await run(
      "borrow: past the switchboard collateral",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc, usdcTo, 200_000_000n, { rest })],
      [account, usdc.address],
      true,
    );
    // The rate moves to about 1.25, then 1.5 (the reserve's borrowed WAD grows its total): pulses, a borrow and the
    // health checks price the collateral through it.
    for (const quarter of [1n, 2n]) {
      tick();
      refreshFeeds();
      usdcFeed();
      const d = data(r.reserve);
      poke(r.reserve, 179, le((d.readBigUInt64LE(259) * quarter * 10n ** 18n) / 4n, 16));
      await run(`pulse switchboard solend bank (${quarter})`, user, [refresh(r), h.pulse(group.address, b.address, [r.oracle, r.reserve])], [b.address]);
      await run(
        `borrow at the new rate (${quarter})`,
        user,
        [refresh(r), h.borrow(group.address, account, user, usdc, usdcTo, 10_000_000n, { rest })],
        [account, usdc.address, usdcTo],
      );
    }
    await run("pulse health with a switchboard solend bank", user, [refresh(r), h.pulseHealth(account, group.address, rest)], [account]);
    // A wrong reserve, a wrong feed, a stale feed: the risk engine's errors for this setup.
    await run(
      "borrow: wrong reserve",
      user,
      [
        refresh(r),
        h.borrow(group.address, account, user, usdc, usdcTo, 1_000n, { rest: ordered([b.address, r.oracle, usdcOracle], [usdc.address, usdcOracle]) }),
      ],
      [account],
      true,
    );
    await run(
      "borrow: wrong feed",
      user,
      [
        refresh(r),
        h.borrow(group.address, account, user, usdc, usdcTo, 1_000n, { rest: ordered([b.address, usdcOracle, r.reserve], [usdc.address, usdcOracle]) }),
      ],
      [account],
      true,
    );
    t += 120n;
    slot += 3n;
    h.setClock(t, slot);
    usdcFeed();
    await run("borrow: stale switchboard feed", user, [refresh(r), h.borrow(group.address, account, user, usdc, usdcTo, 1_000n, { rest })], [account], true);
    refreshFeeds();
    // Enough to repay the debt and its interest.
    h.tokenAccountAt(usdcTo, usdcMint, user.address, data(usdcTo).readBigUInt64LE(64) + 1_000_000n);
    await run("repay", user, [h.repay(group.address, account, user, usdc.address, usdcTo, usdc.v.liquidity, 0n, { all: true })], [account, usdc.address]);
    const solendRest = [b.address, r.oracle, r.reserve];
    await run("switchboard solend withdraw", user, [refresh(r), withdraw(b, account, user, tokens, 500_000_000n, null, solendRest)], watch(b, account, tokens));
    await run("switchboard solend withdraw all", user, [refresh(r), withdraw(b, account, user, tokens, 0n, true, [])], watch(b, account, tokens));
  });

  it("matches the original through random deposits, withdrawals, borrows and rates", async () => {
    // FUZZ_SEED=<seed> reproduces a run, FUZZ_STEPS=<n> lengthens it, FUZZ_VERBOSE=1 prints the failures' codes.
    // Every transaction must match the original's outcome, error code, account bytes and events; where the original
    // fails with a runtime error (a withdrawal with a debt, AccountBorrowFailed), both failing.
    const seed = BigInt(process.env.FUZZ_SEED ?? Date.now());
    const steps = Number(process.env.FUZZ_STEPS ?? 60);
    const rng = new Rng(seed);
    tick();
    const r = await newReserve(1_000_000n + BigInt(rng.int(200_000_000)), rng.chance(50), rng.pick([6, 8, 9]));
    const b = await solendBank(r, 0n);
    const usdcMint = await h.mint(TOKEN_PROGRAM, 6);
    const usdcOracle = (await s.key()).address;
    const [addUsdc, usdc] = await h.addBank(group.address, admin, usdcMint, TOKEN_PROGRAM, bankConfig());
    await run("add usdc bank", admin, [addUsdc], [usdc.address]);
    const usdcFeed = () => setPyth(usdcOracle, { price: 1_000_000n, conf: 1_000n, expo: -6, publishTime: t });
    usdcFeed();
    await run("usdc oracle", admin, [h.configureOracle(group.address, admin, usdc.address, 3, usdcOracle, [usdcOracle])], [usdc.address]);
    const lender = await newUser();
    const lenderTokens = await h.tokenAccount(usdcMint, lender.user.address, 1_000_000_000_000n);
    await run(
      "lend usdc",
      lender.user,
      [h.deposit(group.address, lender.account, lender.user, usdc.address, lenderTokens, usdc.v.liquidity, 500_000_000_000n)],
      [usdc.address],
    );
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(r.mint, user.address, 1_000_000_000_000n);
    const usdcTo = await h.tokenAccount(usdcMint, user.address, 0n);
    // The health accounts: the banks the account has a balance in (tracked from what succeeded), now and then wrong.
    let deposited = false;
    let owing = false;
    const rest = (borrowing = false) => {
      const groups = [...(deposited ? [[b.address, r.oracle, r.reserve]] : []), ...(owing || borrowing ? [[usdc.address, usdcOracle]] : [])];
      if (rng.chance(10)) groups.push([usdc.address, usdcOracle].slice(0, 1));
      return ordered(...groups);
    };
    /** h.run, counting what succeeded: a run that only ever fails would prove little. */
    const ok = new Map<string, number>();
    const go = async (what: string, ...more: Parameters<typeof h.run> extends [string, ...infer R] ? R : never) => {
      const o = await h.run(`fuzz solend (seed ${seed}): ${what}`, ...more);
      if (o === "ok") ok.set(what, (ok.get(what) ?? 0) + 1);
      else if (process.env.FUZZ_VERBOSE) console.log(`${what}: ${o.replace(/.*code: (\d+).*/, "$1")}`);
      return o;
    };
    const amount = () => (rng.chance(25) ? BigInt(rng.int(30)) : rng.chance(50) ? rng.next() % 10_000_000n : rng.next() % 2_000_000_000n);
    for (let i = 0; i < steps; i++) {
      if (rng.chance(40)) {
        tick(BigInt(1 + rng.int(600)));
        refreshFeeds();
        usdcFeed();
      }
      // The reserve refreshed in the same transaction, or left as it was (stale after a tick).
      const fresh = rng.chance(85) ? [refresh(r)] : [];
      switch (rng.int(7)) {
        case 0:
        case 1:
          if ((await go("deposit", user, [...fresh, deposit(b, account, user, tokens, amount())], watch(b, account, tokens), "if-panics")) === "ok")
            deposited = true;
          break;
        case 2:
          await go("withdraw", user, [...fresh, withdraw(b, account, user, tokens, amount(), null, rest())], watch(b, account, tokens), "if-panics");
          break;
        case 3:
          if (
            (await go("withdraw all", user, [...fresh, withdraw(b, account, user, tokens, 0n, true, rest())], watch(b, account, tokens), "if-panics")) === "ok"
          )
            deposited = false;
          break;
        case 4:
          if (
            (await go(
              "borrow",
              user,
              [...fresh, h.borrow(group.address, account, user, usdc, usdcTo, rng.next() % 50_000_000n, { rest: rest(true) })],
              [account, usdc.address, usdcTo],
              "if-panics",
            )) === "ok"
          )
            owing = true;
          break;
        case 5: {
          // Solend's borrowed liquidity (WAD) sets the reserve's rate: up to 1.5 tokens per collateral token.
          poke(r.reserve, 179, le((data(r.reserve).readBigUInt64LE(259) * BigInt(rng.int(11)) * 10n ** 18n) / 20n, 16));
          await go("pulse", user, [refresh(r), h.pulse(group.address, b.address, [r.oracle, r.reserve])], [b.address], "if-panics");
          break;
        }
        default:
          h.tokenAccountAt(usdcTo, usdcMint, user.address, data(usdcTo).readBigUInt64LE(64) + 1_000_000_000n);
          if (
            (await go(
              "repay all",
              user,
              [h.repay(group.address, account, user, usdc.address, usdcTo, usdc.v.liquidity, 0n, { all: true })],
              [account, usdc.address],
              "if-panics",
            )) === "ok"
          )
            owing = false;
      }
    }
    console.log(`fuzz solend (seed ${seed}): succeeded ${JSON.stringify(Object.fromEntries(ok))}`);
    expect(ok.get("deposit") ?? 0, "deposits succeeded").toBeGreaterThan(0);
    expect((ok.get("withdraw") ?? 0) + (ok.get("withdraw all") ?? 0), "withdrawals succeeded").toBeGreaterThan(0);
  });
});
