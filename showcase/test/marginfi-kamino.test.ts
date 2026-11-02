// Marginfi part 5 C against the mainnet binary: Kamino banks (lending_pool_add_bank_kamino, kamino_init_obligation,
// kamino_deposit, kamino_withdraw, propagate_kamino_market_emergency) over klend's mainnet program, loaded into both
// ledgers (test/programs/kamino_lending.so, fetched: Business Source License). Markets and reserves are made with
// klend's own instructions and the reserve's settings written into its config (klend 1.25's layout,
// fixtures/kamino/kamino_lending.idl.json); Pyth and Switchboard feeds, the reserve's rate in the risk engine, emergency
// mode taking the collateral's borrowing power.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, lamports } from "@solana/kit";
import { BorshCoder, web3 } from "@anchor-lang/core";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BN, TOKEN_PROGRAM, pda } from "../../test/harness.js";
import { SYSTEM, key, program, report } from "./jito-helpers.js";
import { Rng } from "./fuzz-rng.js";
import { INSTRUCTIONS, ONE, PROGRAM, bankConfig, fx, le, marginfiPair, ratio } from "./marginfi-helpers.js";

const KLEND = address("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const FARMS = address("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");
const RENT = address("SysvarRent111111111111111111111111111111111");
const KIDL = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/kamino/kamino_lending.idl.json", import.meta.url)), "utf8"));
const kcoder = new BorshCoder(KIDL);
const FIDL = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/kamino/kamino_farms.idl.json", import.meta.url)), "utf8"));
const fcoder = new BorshCoder(FIDL);
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const pk = (a: Address) => new web3.PublicKey(a);
type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };
const metas = (accounts: Meta[]) =>
  accounts.map((a) => ({
    address: a.address,
    role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
    ...(a.signer ? { signer: a.signer } : {}),
  })) as Instruction["accounts"];
const kix = (name: string, args: Record<string, unknown>, accounts: Meta[]): Instruction => ({
  programAddress: KLEND,
  accounts: metas(accounts),
  data: new Uint8Array(kcoder.instruction.encode(name, args)),
});

const fix = (name: string, args: Record<string, unknown>, accounts: Meta[]): Instruction => ({
  programAddress: FARMS,
  accounts: metas(accounts),
  data: new Uint8Array(fcoder.instruction.encode(name, args)),
});

/** klend's zero-copy layouts as the IDL gives them (no implicit padding): an account's field offsets. */
type T = string | { array: [T, number] } | { defined: { name: string } };
const SIZES: Record<string, number> = { u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32 };
const typeOf = (name: string) => KIDL.types.find((x: { name: string }) => x.name === name);
const sizeOf = (t: T): number => {
  if (typeof t === "string") return SIZES[t]!;
  if ("array" in t) return sizeOf(t.array[0]) * t.array[1];
  const d = typeOf(t.defined.name);
  return d.type.kind === "enum" ? 1 : d.type.fields.reduce((n: number, f: { type: T }) => n + sizeOf(f.type), 0);
};
const kOffset = (account: string, path: string) => {
  let at = 8;
  let type: T = { defined: { name: account } };
  for (const part of path.split(".")) {
    const [, name, index] = /^(\w+)(?:\[(\d+)\])?$/.exec(part)!;
    let found = false;
    for (const f of typeOf((type as { defined: { name: string } }).defined.name).type.fields) {
      if (f.name === name) {
        type = f.type;
        found = true;
        break;
      }
      at += sizeOf(f.type);
    }
    if (!found) throw new Error(`no ${name} in ${account}`);
    if (index !== undefined) {
      const e: T = (type as { array: [T, number] }).array[0];
      at += sizeOf(e) * Number(index);
      type = e;
    }
  }
  return at;
};

describe.skipIf(!existsSync(program("kamino_lending.so")))("Marginfi v2 port against the mainnet binary: Kamino banks", () => {
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
  const blank = async (owner: Address, space: number) => {
    const a = (await s.key()).address;
    for (const vm of s.vms())
      vm.setAccount({
        address: a,
        data: new Uint8Array(space),
        executable: false,
        lamports: lamports(200_000_000n),
        programAddress: owner,
        space: BigInt(space),
      });
    return a;
  };

  type Market = { address: Address; lma: Address };
  type Reserve = {
    market: Market;
    mint: Address;
    reserve: Address;
    supply: Address;
    colMint: Address;
    colSupply: Address;
    /** Prices the marginfi bank (Pyth or Switchboard); klend prices the reserve with its own Pyth feed, klendOracle. */
    oracle: Address;
    klendOracle: Address;
    swb: boolean;
    price: bigint;
  };
  const reserves: Reserve[] = [];
  const refreshFeeds = () => {
    for (const r of reserves) {
      if (r.swb) setSwb(r.oracle, { value: r.price * 10n ** 12n, lastUpdate: t });
      setPyth(r.klendOracle, { price: r.price, conf: r.price / 10_000n, expo: -6, publishTime: t });
    }
  };
  /** klend's RefreshReserve (a Pyth or Switchboard price) and RefreshObligation (its deposit reserves after it). */
  const refresh = (r: Reserve) =>
    kix("refresh_reserve", {}, [
      { address: r.reserve, writable: true },
      { address: r.market.address },
      { address: r.klendOracle },
      { address: KLEND },
      { address: KLEND },
      { address: KLEND },
    ]);
  const refreshObligation = (r: Reserve, obligation: Address) => {
    const i = kix("refresh_obligation", {}, [{ address: r.market.address }, { address: obligation, writable: true }]);
    return { ...i, accounts: [...i.accounts!, { address: r.reserve, role: AccountRole.READONLY }] } as Instruction;
  };
  const newMarket = async (): Promise<Market> => {
    const market = await s.key();
    for (const vm of s.vms())
      vm.setAccount({
        address: market.address,
        data: new Uint8Array(sizeOf({ defined: { name: "LendingMarket" } }) + 8),
        executable: false,
        lamports: lamports(100_000_000n),
        programAddress: KLEND,
        space: BigInt(sizeOf({ defined: { name: "LendingMarket" } }) + 8),
      });
    const [lma] = await pda(KLEND, ["lma", market.address]);
    await run(
      "klend init market",
      admin,
      [
        kix("init_lending_market", { quote_currency: Array.from(Buffer.alloc(32)) }, [
          { address: admin.address, signer: admin, writable: true },
          { address: market.address, writable: true },
          { address: lma },
          { address: SYSTEM },
          { address: RENT },
          { address: INSTRUCTIONS },
        ]),
      ],
      [market.address],
    );
    return { address: market.address, lma };
  };
  /** A klend reserve of a new mint (seeded by the admin), its settings written into its config. */
  const newReserve = async (market: Market, price: bigint, swb = false, decimals = 6): Promise<Reserve> => {
    const mint = await h.mint(TOKEN_PROGRAM, decimals);
    const reserve = await blank(KLEND, sizeOf({ defined: { name: "Reserve" } }) + 8);
    const [supply] = await pda(KLEND, ["reserve_liq_supply", reserve]);
    const [feeReceiver] = await pda(KLEND, ["fee_receiver", reserve]);
    const [colMint] = await pda(KLEND, ["reserve_coll_mint", reserve]);
    const [colSupply] = await pda(KLEND, ["reserve_coll_supply", reserve]);
    const klendOracle = (await s.key()).address;
    const oracle = swb ? (await s.key()).address : klendOracle;
    const r: Reserve = { market, mint, reserve, supply, colMint, colSupply, oracle, klendOracle, swb, price };
    reserves.push(r);
    refreshFeeds();
    const source = await h.tokenAccount(mint, admin.address, 10n ** BigInt(decimals + 6));
    await run(
      "klend init reserve",
      admin,
      [
        kix("init_reserve", {}, [
          { address: admin.address, signer: admin, writable: true },
          { address: market.address },
          { address: market.lma },
          { address: reserve, writable: true },
          { address: mint },
          { address: supply, writable: true },
          { address: feeReceiver, writable: true },
          { address: colMint, writable: true },
          { address: colSupply, writable: true },
          { address: source, writable: true },
          { address: RENT },
          { address: TOKEN_PROGRAM },
          { address: TOKEN_PROGRAM },
          { address: SYSTEM },
          { address: INSTRUCTIONS },
        ]),
      ],
      [reserve, supply, colMint, colSupply],
    );
    const at = (path: string) => kOffset("Reserve", path);
    const put = (path: string, v: bigint, n: number) => poke(reserve, at(path), le(v, n));
    put("config.status", 0n, 1);
    put("config.loan_to_value_pct", 75n, 1);
    put("config.liquidation_threshold_pct", 85n, 1);
    put("config.borrow_factor_pct", 100n, 8);
    put("config.deposit_limit", 10n ** 18n, 8);
    put("config.borrow_limit", 10n ** 18n, 8);
    for (let i = 0; i < 11; i++) {
      put(`config.borrow_rate_curve.points[${i}].utilization_rate_bps`, i === 0 ? 0n : 10000n, 4);
      put(`config.borrow_rate_curve.points[${i}].borrow_rate_bps`, i === 0 ? 100n : 1000n, 4);
    }
    put("config.token_info.max_age_price_seconds", 60n, 8);
    put("config.token_info.max_age_twap_seconds", 240n, 8);
    poke(reserve, at("config.token_info.pyth_configuration.price"), key(klendOracle));
    poke(reserve, at("config.token_info.name"), Buffer.from("TOKEN"));
    await run("klend refresh reserve", admin, [refresh(r)], [reserve]);
    return r;
  };

  type KaminoBank = { address: Address; v: Awaited<ReturnType<typeof h.vaults>>; obligation: Address; userMetadata: Address; r: Reserve };
  const addKaminoBank = async (
    r: Reserve,
    seed: bigint,
    over: Record<string, unknown> = {},
    opts: { rest?: Address[]; reserve?: Address; obligation?: Address } = {},
  ) => {
    const [bank] = await pda(PROGRAM, [group.address, r.mint, new Uint8Array(le(seed, 8))]);
    const v = await h.vaults(bank);
    const [obligation] = await pda(KLEND, [Uint8Array.of(0), Uint8Array.of(0), v.liquidityAuth, r.market.address, SYSTEM, SYSTEM]);
    const [userMetadata] = await pda(KLEND, ["user_meta", v.liquidityAuth]);
    const b: KaminoBank = { address: bank, v, obligation, userMetadata, r };
    const add = s.ix(
      "lending_pool_add_bank_kamino",
      {
        bank_config: {
          oracle: pk(r.oracle),
          asset_weight_init: fx(ratio(8n, 10n)),
          asset_weight_maint: fx(ratio(9n, 10n)),
          deposit_limit: new BN("1000000000000000"),
          oracle_setup: r.swb ? { KaminoSwitchboardPull: {} } : { KaminoPythPush: {} },
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
        { address: r.mint },
        { address: bank, writable: true },
        { address: opts.reserve ?? r.reserve },
        { address: opts.obligation ?? obligation },
        { address: v.liquidityAuth },
        { address: v.liquidity, writable: true },
        { address: v.insuranceAuth },
        { address: v.insurance, writable: true },
        { address: v.feeAuth },
        { address: v.fee, writable: true },
        { address: TOKEN_PROGRAM },
        { address: SYSTEM },
        { address: INSTRUCTIONS },
        ...(opts.rest ?? [r.oracle, r.reserve]).map((address) => ({ address })),
      ],
    );
    return [add, b] as const;
  };
  /** The venue accounts every Kamino instruction ends with (no farms: marginfi's id for each one left out). */
  const venue = (b: KaminoBank, mintWritable: boolean, collateral: "supply" = "supply"): Meta[] => [
    { address: b.r.market.address },
    { address: b.r.market.lma },
    { address: b.r.reserve, writable: true },
    { address: b.r.mint, writable: mintWritable },
    { address: b.r.supply, writable: true },
    { address: b.r.colMint, writable: true },
    { address: collateral === "supply" ? b.r.colSupply : b.r.colSupply, writable: true },
    { address: PROGRAM },
    { address: PROGRAM },
    { address: KLEND },
    { address: FARMS },
    { address: TOKEN_PROGRAM },
    { address: TOKEN_PROGRAM },
    { address: INSTRUCTIONS },
  ];
  const vaultAccounts = (b: KaminoBank, tokens: Address): Meta[] => [
    { address: tokens, writable: true },
    { address: b.v.liquidityAuth, writable: true },
    { address: b.v.liquidity, writable: true },
    { address: b.obligation, writable: true },
  ];
  const initObligation = (b: KaminoBank, payer: KeyPairSigner, tokens: Address, amount: bigint) => {
    const [tokensMeta, auth, vault, obligation] = vaultAccounts(b, tokens);
    return s.ix("kamino_init_obligation", { amount: new BN(amount.toString()) }, [
      { address: payer.address, signer: payer, writable: true },
      { address: b.address },
      tokensMeta!,
      auth!,
      vault!,
      obligation!,
      { address: b.userMetadata, writable: true },
      ...venue(b, true),
      { address: RENT },
      { address: SYSTEM },
    ]);
  };
  const deposit = (b: KaminoBank, account: Address, user: KeyPairSigner, tokens: Address, amount: bigint, refreshReserve: boolean | null = null) =>
    s.ix("kamino_deposit", { amount: new BN(amount.toString()), refresh_reserve: refreshReserve }, [
      { address: group.address },
      { address: account, writable: true },
      { address: user.address, signer: user },
      { address: b.address, writable: true },
      ...vaultAccounts(b, tokens),
      ...venue(b, false),
    ]);
  const withdraw = (b: KaminoBank, account: Address, user: KeyPairSigner, tokens: Address, amount: bigint, flags: number | null, rest: Address[]) => {
    const i = s.ix("kamino_withdraw", { amount: new BN(amount.toString()), flags }, [
      { address: group.address },
      { address: account, writable: true },
      { address: user.address, signer: user },
      { address: b.address, writable: true },
      ...vaultAccounts(b, tokens),
      ...venue(b, true),
    ]);
    return { ...i, accounts: [...i.accounts!, ...rest.map((address) => ({ address, role: AccountRole.READONLY }))] } as Instruction;
  };
  const watch = (b: KaminoBank, ...more: Address[]) => [b.address, b.v.liquidity, b.obligation, b.r.reserve, b.r.supply, b.r.colSupply, ...more];
  const both = (r: Reserve, b: KaminoBank) => [refresh(r), refreshObligation(r, b.obligation)];
  const newUser = async () => {
    const user = await s.funded();
    const account = await s.key();
    await run("account", user, [h.accountInit(group.address, account, user)], [account.address]);
    return { user, account: account.address };
  };
  const kaminoBank = async (r: Reserve, seed: bigint) => {
    const [add, b] = await addKaminoBank(r, seed);
    await run("add kamino bank", admin, [add], watch(b, group.address));
    const tokens = await h.tokenAccount(r.mint, admin.address, 1_000n);
    await run("kamino init obligation", admin, [refresh(r), initObligation(b, admin, tokens, 100n)], watch(b, tokens, b.userMetadata));
    return b;
  };
  /** A plain USDC bank on a Pyth feed with another depositor's liquidity, to borrow against the Kamino collateral. */
  const usdcBank = async () => {
    const mint = await h.mint(TOKEN_PROGRAM, 6);
    const oracle = (await s.key()).address;
    const [add, bank] = await h.addBank(group.address, admin, mint, TOKEN_PROGRAM, bankConfig());
    await run("add usdc bank", admin, [add], [bank.address]);
    const feed = () => setPyth(oracle, { price: 1_000_000n, conf: 1_000n, expo: -6, publishTime: t });
    feed();
    await run("usdc oracle", admin, [h.configureOracle(group.address, admin, bank.address, 3, oracle, [oracle])], [bank.address]);
    const lender = await newUser();
    const tokens = await h.tokenAccount(mint, lender.user.address, 1_000_000_000_000n);
    await run(
      "lend usdc",
      lender.user,
      [h.deposit(group.address, lender.account, lender.user, bank.address, tokens, bank.v.liquidity, 500_000_000_000n)],
      [bank.address],
    );
    return { mint, oracle, bank, feed };
  };

  beforeAll(async () => {
    await h.load();
    for (const vm of s.vms()) {
      vm.addProgramFromFile(KLEND, program("kamino_lending.so"));
      vm.addProgramFromFile(FARMS, program("kamino_farms.so"));
    }
    admin = h.admin;
    h.setClock(t, slot);
    await run("init fee state", admin, [h.initFeeState(admin, h.feeWallet)], [h.feeState]);
    group = await s.key();
    await run("group init", admin, [h.groupInit(group, admin)], [group.address]);
  });
  afterAll(() => report("marginfi-kamino", s));

  it("adds Kamino banks and their obligations, refusing what the original refuses", async () => {
    const market = await newMarket();
    const r = await newReserve(market, 1_000_000n);
    const other = await newReserve(market, 2_000_000n);
    for (const [label, over, opts] of [
      ["solend setup", { oracle_setup: { SolendPythPull: {} } }, {}],
      ["plain pyth setup", { oracle_setup: { PythPushOracle: {} } }, {}],
      ["one oracle account", {}, { rest: [r.oracle] }],
      ["wrong feed", {}, { rest: [other.oracle, r.reserve] }],
      ["wrong reserve key", {}, { rest: [r.oracle, other.reserve] }],
      ["reserve of another mint", {}, { reserve: other.reserve }],
      ["obligation of another owner", {}, { obligation: other.reserve }],
      ["weights out of order", { asset_weight_init: fx(ratio(95n, 100n)) }, {}],
    ] as const) {
      const [add] = await addKaminoBank(r, 7n, over as Record<string, unknown>, opts as { rest?: Address[]; reserve?: Address; obligation?: Address });
      await run(`add kamino bank: ${label}`, admin, [add], [group.address], true);
    }
    const b = await kaminoBank(r, 0n);
    expect(data(b.obligation).length).toBe(sizeOf({ defined: { name: "Obligation" } }) + 8);
    const [add2, b2] = await addKaminoBank(other, 0n);
    await run("add another kamino bank", admin, [add2], watch(b2, group.address));
    const tokens = await h.tokenAccount(other.mint, admin.address, 1_000n);
    await run("kamino init obligation: 9 tokens", admin, [refresh(other), initObligation(b2, admin, tokens, 9n)], watch(b2, tokens), true);
    await run("kamino init obligation", admin, [refresh(other), initObligation(b2, admin, tokens, 50n)], watch(b2, tokens, b2.userMetadata));
    await run("kamino init obligation: again", admin, [refresh(other), initObligation(b2, admin, tokens, 50n)], watch(b2, tokens), true);
  });

  it("takes deposits into Kamino and gives them back, pricing them at the reserve's rate", async () => {
    tick();
    const market = await newMarket();
    const r = await newReserve(market, 1_000_000n);
    const b = await kaminoBank(r, 0n);
    const usdc = await usdcBank();
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(r.mint, user.address, 100_000_000n);
    tick();
    refreshFeeds();
    usdc.feed();
    await run("kamino deposit: obligation not refreshed", user, [refresh(r), deposit(b, account, user, tokens, 10_000_000n)], watch(b, account, tokens), true);
    await run("kamino deposit", user, [...both(r, b), deposit(b, account, user, tokens, 10_000_000n)], watch(b, account, tokens));
    // An account klend does not own as the reserve: Anchor loads it before any constraint (3007).
    const stranger = await h.tokenAccount(r.mint, user.address, 0n);
    const d = deposit(b, account, user, tokens, 1_000n);
    const notKlend = { ...d, accounts: d.accounts!.map((a) => (a.address === r.reserve ? { ...a, address: stranger } : a)) } as Instruction;
    await run("kamino deposit: reserve not klend's", user, [...both(r, b), notKlend], watch(b, account, tokens), true);
    await run("kamino deposit, refreshing the reserve", user, [...both(r, b), deposit(b, account, user, tokens, 5_000_000n, true)], watch(b, account, tokens));
    await run(
      "kamino deposit: more than the user has",
      user,
      [...both(r, b), deposit(b, account, user, tokens, 900_000_000n)],
      watch(b, account, tokens),
      true,
    );
    const usdcTo = await h.tokenAccount(usdc.mint, user.address, 0n);
    const rest = ordered([b.address, r.oracle, r.reserve], [usdc.bank.address, usdc.oracle]);
    await run(
      "borrow against kamino",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc.bank, usdcTo, 6_000_000n, { rest })],
      [account, usdc.bank.address, usdcTo],
    );
    await run(
      "borrow: past the kamino collateral",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc.bank, usdcTo, 6_000_000n, { rest })],
      [account],
      true,
    );
    // Kamino's withdrawals check health at the end like any other (the bank is not held then).
    await run("kamino withdraw with a debt", user, [...both(r, b), withdraw(b, account, user, tokens, 1_000_000n, null, rest)], watch(b, account, tokens));
    await run("kamino withdraw: more", user, [...both(r, b), withdraw(b, account, user, tokens, 2_000_000n, null, rest)], watch(b, account, tokens));
    await run(
      "kamino withdraw: all of it, with a debt",
      user,
      [...both(r, b), withdraw(b, account, user, tokens, 0n, 1, rest)],
      watch(b, account, tokens),
      true,
    );
    await run("kamino withdraw: no oracles", user, [...both(r, b), withdraw(b, account, user, tokens, 100_000n, null, [])], watch(b, account, tokens), true);
    await run(
      "kamino withdraw, refreshing the reserve",
      user,
      [...both(r, b), withdraw(b, account, user, tokens, 100_000n, 2, rest)],
      watch(b, account, tokens),
    );
    // The rate moves (the reserve's borrowed Fraction grows its total): the pulse and borrow price through it.
    tick();
    refreshFeeds();
    usdc.feed();
    const supply = data(r.reserve).readBigUInt64LE(kOffset("Reserve", "collateral.mint_total_supply"));
    poke(r.reserve, kOffset("Reserve", "liquidity.borrowed_amount_sf"), le((supply / 5n) << 60n, 16));
    await run("pulse kamino bank", user, [refresh(r), h.pulse(group.address, b.address, [r.oracle, r.reserve])], [b.address]);
    await run(
      "borrow at the new rate",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc.bank, usdcTo, 500_000n, { rest })],
      [account, usdc.bank.address, usdcTo],
    );
    await run("kamino withdraw at the new rate", user, [...both(r, b), withdraw(b, account, user, tokens, 500_000n, null, rest)], watch(b, account, tokens));
    // A fixed price (FixedKamino): $1.10 times the reserve's rate, priced from the reserve alone.
    const fixedRest = ordered([b.address, r.reserve], [usdc.bank.address, usdc.oracle]);
    await run(
      "fixed price: not the bank's reserve",
      admin,
      [h.setOraclePrice(group.address, admin, b.address, (11n * ONE) / 10n, 8, [usdc.oracle])],
      [b.address],
      true,
    );
    await run("fixed price", admin, [h.setOraclePrice(group.address, admin, b.address, (11n * ONE) / 10n, 8, [r.reserve])], [b.address]);
    await run("pulse fixed kamino bank", user, [refresh(r), h.pulse(group.address, b.address, [r.reserve])], [b.address]);
    await run(
      "borrow against fixed kamino",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc.bank, usdcTo, 300_000n, { rest: fixedRest })],
      [account, usdc.bank.address, usdcTo],
    );
    tick();
    usdc.feed();
    await run(
      "borrow: fixed kamino, reserve stale",
      user,
      [h.borrow(group.address, account, user, usdc.bank, usdcTo, 1_000n, { rest: fixedRest })],
      [account],
      true,
    );
    await run("back to the feed", admin, [h.configureOracle(group.address, admin, b.address, 6, r.oracle, [r.oracle, r.reserve])], [b.address]);
    // mSOL and LST rates inside the venue bank (an mSOL or LST mint's reserve): Marginfi reads Marinade's state or an
    // SPL stake pool (written in), whose mint must be the bank's.
    const setEpochTo = (epoch: bigint) => {
      for (const vm of s.vms()) {
        const c = vm.getClock();
        c.epoch = epoch;
        vm.setClock(c);
      }
    };
    setEpochTo(700n);
    const putAcct = (at: Address, d: Buffer, owner: Address) => {
      for (const vm of s.vms())
        vm.setAccount({
          address: at,
          data: new Uint8Array(d),
          executable: false,
          lamports: lamports(vm.minimumBalanceForRentExemption(BigInt(d.length))),
          programAddress: owner,
          space: BigInt(d.length),
        });
    };
    const marinade = (await s.key()).address;
    {
      const d = Buffer.alloc(576);
      Buffer.from([216, 146, 107, 94, 104, 75, 182, 177]).copy(d, 0);
      Buffer.from(pk(r.mint).toBytes()).copy(d, 8);
      d.writeBigUInt64LE(1_200_000_000_000_000n, 376);
      d.writeBigUInt64LE(1_000_000_000_000_000n, 504);
      putAcct(marinade, d, address("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD"));
    }
    const stakePool = (await s.key()).address;
    {
      const d = Buffer.alloc(300);
      d[0] = 1;
      Buffer.from(pk(r.mint).toBytes()).copy(d, 162);
      d.writeBigUInt64LE(1_150_000_000_000_000n, 258);
      d.writeBigUInt64LE(1_000_000_000_000_000n, 266);
      d.writeBigUInt64LE(700n, 274);
      putAcct(stakePool, d, address("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"));
    }
    for (const [name, setup, acct] of [
      ["msol", 20, marinade],
      ["lst", 23, stakePool],
    ] as const) {
      await run(
        `kamino ${name} oracle: not the reserve`,
        admin,
        [h.configureOracle(group.address, admin, b.address, setup, r.oracle, [r.oracle, r.oracle, acct])],
        [b.address],
        true,
      );
      await run(
        `kamino ${name} oracle`,
        admin,
        [h.configureOracle(group.address, admin, b.address, setup, r.oracle, [r.oracle, r.reserve, acct])],
        [b.address],
      );
      await run(`pulse kamino ${name} bank`, user, [refresh(r), h.pulse(group.address, b.address, [r.oracle, r.reserve, acct])], [b.address]);
      await run(
        `borrow against kamino ${name}`,
        user,
        [
          refresh(r),
          h.borrow(group.address, account, user, usdc.bank, usdcTo, 100_000n, {
            rest: ordered([b.address, r.oracle, r.reserve, acct], [usdc.bank.address, usdc.oracle]),
          }),
        ],
        [account, usdc.bank.address, usdcTo],
      );
    }
    await run("back to the feed again", admin, [h.configureOracle(group.address, admin, b.address, 6, r.oracle, [r.oracle, r.reserve])], [b.address]);
    // Scope's OraclePrices (its discriminator, the mappings key, 512 dated prices of 56 bytes), written into both.
    const scopeAccount = (entry: number, value: bigint, exp: bigint, ts: bigint, at?: Address) => {
      const d = Buffer.alloc(8 + 32 + 512 * 56);
      Buffer.from([89, 128, 118, 221, 6, 72, 180, 146]).copy(d, 0);
      const o = 8 + 32 + entry * 56;
      d.writeBigUInt64LE(value, o);
      d.writeBigUInt64LE(exp, o + 8);
      d.writeBigUInt64LE(ts, o + 24);
      for (const vm of s.vms())
        vm.setAccount({
          address: at!,
          data: new Uint8Array(d),
          executable: false,
          lamports: lamports(vm.minimumBalanceForRentExemption(BigInt(d.length))),
          programAddress: address("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ"),
          space: BigInt(d.length),
        });
      return at!;
    };
    const configureScope = (label: string, bank: Address, oracle: Address, entry: number, rest: Address[], failing = false) =>
      run(
        label,
        admin,
        [
          {
            ...s.ix("lending_pool_configure_bank_oracle_scope", { oracle: pk(oracle), entry_index: entry }, [
              { address: group.address },
              { address: admin.address, signer: admin },
              { address: bank, writable: true },
              { address: INSTRUCTIONS },
            ] as never),
          },
        ].map((i) => ({ ...i, accounts: [...i.accounts!, ...rest.map((address) => ({ address, role: 0 }) as never)] })),
        [bank],
        failing,
      );
    const scopeFeedAt = (await s.key()).address;
    scopeAccount(3, 110_000_000n, 8n, t, scopeFeedAt);
    await configureScope("kamino scope oracle: not the reserve", b.address, scopeFeedAt, 3, [scopeFeedAt, usdc.oracle], true);
    await configureScope("kamino scope oracle", b.address, scopeFeedAt, 3, [scopeFeedAt, r.reserve]);
    await run("pulse kamino scope bank", user, [refresh(r), h.pulse(group.address, b.address, [scopeFeedAt, r.reserve])], [b.address]);
    await run(
      "borrow against kamino scope",
      user,
      [
        refresh(r),
        h.borrow(group.address, account, user, usdc.bank, usdcTo, 100_000n, {
          rest: ordered([b.address, scopeFeedAt, r.reserve], [usdc.bank.address, usdc.oracle]),
        }),
      ],
      [account, usdc.bank.address, usdcTo],
    );
    await run("back to the feed once more", admin, [h.configureOracle(group.address, admin, b.address, 6, r.oracle, [r.oracle, r.reserve])], [b.address]);
    refreshFeeds();
    // Emergency mode: the collateral backs no new borrows (Initial), but stays for Maintenance.
    poke(r.reserve, kOffset("Reserve", "config.emergency_mode"), Buffer.from([1]));
    await run(
      "borrow: reserve in emergency mode",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc.bank, usdcTo, 1_000n, { rest })],
      [account],
      true,
    );
    await run("pulse health: reserve in emergency mode", user, [refresh(r), h.pulseHealth(account, group.address, rest)], [account]);
    poke(r.reserve, kOffset("Reserve", "config.emergency_mode"), Buffer.from([0]));
    poke(market.address, kOffset("LendingMarket", "emergency_mode"), Buffer.from([1]));
    const propagate = (reserve: Address, m: Address, bank: Address) =>
      s.ix("propagate_kamino_market_emergency", {}, [{ address: reserve }, { address: m }, { address: bank, writable: true }]);
    await run("propagate market emergency", user, [propagate(r.reserve, market.address, b.address)], [b.address]);
    await run("propagate: reserve of another market", user, [propagate(r.reserve, (await newMarket()).address, b.address)], [b.address], true);
    await run("propagate: the usdc bank", user, [propagate(r.reserve, market.address, usdc.bank.address)], [usdc.bank.address], true);
    // klend refuses to refresh a market in emergency mode, so it ends before the borrow: the bank keeps the flag.
    poke(market.address, kOffset("LendingMarket", "emergency_mode"), Buffer.from([0]));
    await run(
      "borrow: market in emergency mode",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc.bank, usdcTo, 1_000n, { rest })],
      [account],
      true,
    );
    await run("pulse health: market in emergency mode", user, [refresh(r), h.pulseHealth(account, group.address, rest)], [account]);
    await run("propagate the end of the emergency", user, [propagate(r.reserve, market.address, b.address)], [b.address]);
    await run(
      "borrow after the emergency",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc.bank, usdcTo, 1_000n, { rest })],
      [account, usdc.bank.address, usdcTo],
    );
    // Enough to repay the debt and its interest.
    h.tokenAccountAt(usdcTo, usdc.mint, user.address, data(usdcTo).readBigUInt64LE(64) + 1_000_000n);
    await run(
      "repay",
      user,
      [h.repay(group.address, account, user, usdc.bank.address, usdcTo, usdc.bank.v.liquidity, 0n, { all: true })],
      [account, usdc.bank.address],
    );
    // The written-in borrows grew the reserve's total, not its vault: put the rate back before taking everything out.
    poke(r.reserve, kOffset("Reserve", "liquidity.borrowed_amount_sf"), le(0n, 16));
    await run(
      "kamino withdraw all",
      user,
      [...both(r, b), withdraw(b, account, user, tokens, 0n, 3, [usdc.bank.address, usdc.oracle])],
      watch(b, account, tokens),
    );
  });

  it("prices a Kamino bank on a Switchboard feed as the original does", async () => {
    tick();
    const market = await newMarket();
    const r = await newReserve(market, 150_000_000n, true, 9);
    const b = await kaminoBank(r, 0n);
    const usdc = await usdcBank();
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(r.mint, user.address, 10_000_000_000n);
    await run("switchboard kamino deposit", user, [...both(r, b), deposit(b, account, user, tokens, 2_000_000_000n)], watch(b, account, tokens));
    const usdcTo = await h.tokenAccount(usdc.mint, user.address, 0n);
    const rest = ordered([b.address, r.oracle, r.reserve], [usdc.bank.address, usdc.oracle]);
    await run(
      "borrow against switchboard kamino",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc.bank, usdcTo, 100_000_000n, { rest })],
      [account, usdc.bank.address, usdcTo],
    );
    tick();
    refreshFeeds();
    usdc.feed();
    const supply = data(r.reserve).readBigUInt64LE(kOffset("Reserve", "collateral.mint_total_supply"));
    poke(r.reserve, kOffset("Reserve", "liquidity.borrowed_amount_sf"), le((supply / 3n) << 60n, 16));
    await run("pulse switchboard kamino bank", user, [refresh(r), h.pulse(group.address, b.address, [r.oracle, r.reserve])], [b.address]);
    await run(
      "borrow at the new switchboard rate",
      user,
      [refresh(r), h.borrow(group.address, account, user, usdc.bank, usdcTo, 10_000_000n, { rest })],
      [account, usdc.bank.address, usdcTo],
    );
    await run(
      "switchboard kamino withdraw with a debt",
      user,
      [...both(r, b), withdraw(b, account, user, tokens, 100_000_000n, null, rest)],
      watch(b, account, tokens),
    );
    await run(
      "borrow: wrong reserve",
      user,
      [
        refresh(r),
        h.borrow(group.address, account, user, usdc.bank, usdcTo, 1_000n, {
          rest: ordered([b.address, r.oracle, usdc.oracle], [usdc.bank.address, usdc.oracle]),
        }),
      ],
      [account],
      true,
    );
  });

  it("matches the original through random deposits, withdrawals, borrows and rates", async () => {
    // FUZZ_SEED=<seed> reproduces a run, FUZZ_STEPS=<n> lengthens it, FUZZ_VERBOSE=1 prints the failures' codes.
    // Every transaction must match the original's outcome, error code, account bytes and events, whichever it is.
    const seed = BigInt(process.env.FUZZ_SEED ?? Date.now());
    const steps = Number(process.env.FUZZ_STEPS ?? 60);
    const rng = new Rng(seed);
    tick();
    const market = await newMarket();
    const r = await newReserve(market, 1_000_000n + BigInt(rng.int(200_000_000)), rng.chance(50), rng.pick([6, 8, 9]));
    const b = await kaminoBank(r, 0n);
    const usdc = await usdcBank();
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(r.mint, user.address, 1_000_000_000_000n);
    const usdcTo = await h.tokenAccount(usdc.mint, user.address, 0n);
    // The health accounts: the banks the account has a balance in (tracked from what succeeded), now and then wrong.
    let deposited = false;
    let owing = false;
    const rest = (borrowing = false) => {
      const groups = [...(deposited ? [[b.address, r.oracle, r.reserve]] : []), ...(owing || borrowing ? [[usdc.bank.address, usdc.oracle]] : [])];
      if (rng.chance(10)) groups.push([usdc.bank.address, usdc.oracle].slice(0, 1));
      return ordered(...groups);
    };
    /** h.run, counting what succeeded: a run that only ever fails would prove little. */
    const ok = new Map<string, number>();
    const go = async (what: string, ...more: Parameters<typeof h.run> extends [string, ...infer R] ? R : never) => {
      const o = await h.run(`fuzz kamino (seed ${seed}): ${what}`, ...more);
      if (o === "ok") ok.set(what, (ok.get(what) ?? 0) + 1);
      else if (process.env.FUZZ_VERBOSE) console.log(`${what}: ${o.replace(/.*code: (\d+).*/, "$1")}`);
      return o;
    };
    const amount = () => (rng.chance(25) ? BigInt(rng.int(30)) : rng.chance(50) ? rng.next() % 10_000_000n : rng.next() % 2_000_000_000n);
    for (let i = 0; i < steps; i++) {
      if (rng.chance(40)) {
        tick(BigInt(1 + rng.int(600)));
        refreshFeeds();
        usdc.feed();
      }
      // The reserve and obligation refreshed first, or only the reserve, or neither (stale after a tick).
      const fresh = rng.chance(80) ? both(r, b) : rng.chance(50) ? [refresh(r)] : [];
      switch (rng.int(7)) {
        case 0:
        case 1:
          if ((await go("deposit", user, [...fresh, deposit(b, account, user, tokens, amount())], watch(b, account, tokens))) === "ok") deposited = true;
          break;
        case 2:
          await go("withdraw", user, [...fresh, withdraw(b, account, user, tokens, amount(), null, rest())], watch(b, account, tokens));
          break;
        case 3:
          // Taking everything out of the reserve needs its liquidity: the written-in borrows are put back first.
          poke(r.reserve, kOffset("Reserve", "liquidity.borrowed_amount_sf"), le(0n, 16));
          if ((await go("withdraw all", user, [...fresh, withdraw(b, account, user, tokens, 0n, 1, rest())], watch(b, account, tokens))) === "ok")
            deposited = false;
          break;
        case 4:
          if (
            (await go(
              "borrow",
              user,
              [refresh(r), h.borrow(group.address, account, user, usdc.bank, usdcTo, rng.next() % 50_000_000n, { rest: rest(true) })],
              [account, usdc.bank.address, usdcTo],
            )) === "ok"
          )
            owing = true;
          break;
        case 5: {
          // The reserve's borrowed Fraction grows its total: a rate up to 1.5 liquidity per collateral token.
          const supply = data(r.reserve).readBigUInt64LE(kOffset("Reserve", "collateral.mint_total_supply"));
          poke(r.reserve, kOffset("Reserve", "liquidity.borrowed_amount_sf"), le(((supply * BigInt(rng.int(11))) / 20n) << 60n, 16));
          await go("pulse", user, [refresh(r), h.pulse(group.address, b.address, [r.oracle, r.reserve])], [b.address]);
          break;
        }
        default:
          h.tokenAccountAt(usdcTo, usdc.mint, user.address, data(usdcTo).readBigUInt64LE(64) + 1_000_000_000n);
          if (
            (await go(
              "repay all",
              user,
              [h.repay(group.address, account, user, usdc.bank.address, usdcTo, usdc.bank.v.liquidity, 0n, { all: true })],
              [account, usdc.bank.address],
            )) === "ok"
          )
            owing = false;
      }
    }
    console.log(`fuzz kamino (seed ${seed}): succeeded ${JSON.stringify(Object.fromEntries(ok))}`);
    expect(ok.get("deposit") ?? 0, "deposits succeeded").toBeGreaterThan(0);
    expect((ok.get("withdraw") ?? 0) + (ok.get("withdraw all") ?? 0), "withdrawals succeeded").toBeGreaterThan(0);
  });

  it("harvests a Kamino farm's reward into the fee wallet as the original does", async () => {
    tick();
    const market = await newMarket();
    const r = await newReserve(market, 1_000_000n);
    // kfarms: a global config, the reserve's collateral farm (made by klend), a reward in it, funded.
    const globalConfig = await blank(FARMS, 8 + 2136);
    const [treasuryAuthority] = await pda(FARMS, ["authority", globalConfig]);
    await run(
      "kfarms init global config",
      admin,
      [
        fix("initialize_global_config", {}, [
          { address: admin.address, signer: admin, writable: true },
          { address: globalConfig, writable: true },
          { address: treasuryAuthority },
          { address: SYSTEM },
        ]),
      ],
      [globalConfig],
    );
    const farm = await blank(FARMS, 8 + 8336);
    const [farmAuthority] = await pda(FARMS, ["authority", farm]);
    await run(
      "klend init farms for reserve",
      admin,
      [
        kix("init_farms_for_reserve", { mode: 0 }, [
          { address: admin.address, signer: admin, writable: true },
          { address: market.address },
          { address: market.lma },
          { address: r.reserve, writable: true },
          { address: FARMS },
          { address: globalConfig },
          { address: farm, writable: true },
          { address: farmAuthority },
          { address: RENT },
          { address: SYSTEM },
          { address: INSTRUCTIONS },
        ]),
      ],
      [r.reserve, farm],
    );
    const rewardMint = await h.mint(TOKEN_PROGRAM, 6);
    const [rewardVault] = await pda(FARMS, ["rvault", farm, rewardMint]);
    const [treasuryVault] = await pda(FARMS, ["tvault", globalConfig, rewardMint]);
    const curve = Buffer.alloc(8 + 4 + 16);
    curve.writeUInt32LE(1, 8);
    curve.writeBigUInt64LE(1_000_000n, 20);
    const adminRewards = await h.tokenAccount(rewardMint, admin.address, 1_000_000_000_000n);
    await run(
      "kfarms init reward",
      admin,
      [
        fix("initialize_reward", {}, [
          { address: admin.address, signer: admin, writable: true },
          { address: farm, writable: true },
          { address: globalConfig },
          { address: rewardMint },
          { address: rewardVault, writable: true },
          { address: treasuryVault, writable: true },
          { address: farmAuthority },
          { address: treasuryAuthority },
          { address: TOKEN_PROGRAM },
          { address: SYSTEM },
          { address: RENT },
        ]),
        fix("update_farm_config", { mode: 16, data: curve }, [
          { address: admin.address, signer: admin, writable: true },
          { address: farm, writable: true },
          { address: FARMS },
        ]),
        fix("add_rewards", { amount: new BN(1_000_000_000_000), reward_index: new BN(0) }, [
          { address: admin.address, signer: admin, writable: true },
          { address: farm, writable: true },
          { address: rewardMint },
          { address: rewardVault, writable: true },
          { address: farmAuthority },
          { address: adminRewards, writable: true },
          { address: FARMS },
          { address: TOKEN_PROGRAM },
        ]),
      ],
      [farm, rewardVault],
    );
    // A Kamino bank whose obligation joins the farm, and a deposit staked in it.
    const [add, b] = await addKaminoBank(r, 0n);
    await run("add kamino bank", admin, [add], watch(b, group.address));
    const [userState] = await pda(FARMS, ["user", farm, b.obligation]);
    const withFarm = (i: Instruction) =>
      ({
        ...i,
        accounts: i.accounts!.map((m, j, all) => {
          // The two optional farm accounts, marginfi's id when left out: the first is the user state.
          const first = all.findIndex((x) => x.address === PROGRAM);
          if (j === first) return { address: userState, role: AccountRole.WRITABLE };
          if (j === first + 1) return { address: farm, role: AccountRole.WRITABLE };
          return m;
        }),
      }) as Instruction;
    const seed = await h.tokenAccount(r.mint, admin.address, 1_000n);
    await run("kamino init obligation with a farm", admin, [refresh(r), withFarm(initObligation(b, admin, seed, 100n))], watch(b, seed, userState, farm));
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(r.mint, user.address, 1_000_000_000n);
    await run(
      "kamino deposit into the farm",
      user,
      [...both(r, b), withFarm(deposit(b, account, user, tokens, 500_000_000n))],
      watch(b, account, tokens, userState, farm),
    );
    // An hour of rewards, then the harvest: from the authority's reward account to the fee wallet's.
    t += 3600n;
    slot += 9000n;
    h.setClock(t, slot);
    const [userRewards] = await pda(ATA_PROGRAM, [b.v.liquidityAuth, TOKEN_PROGRAM, rewardMint]);
    const [destination] = await pda(ATA_PROGRAM, [h.feeWallet, TOKEN_PROGRAM, rewardMint]);
    h.tokenAccountAt(userRewards, rewardMint, b.v.liquidityAuth);
    h.tokenAccountAt(destination, rewardMint, h.feeWallet);
    const refreshUser = fix("refresh_user_state", {}, [{ address: userState, writable: true }, { address: farm, writable: true }, { address: FARMS }]);
    const harvest = (dst: Address, bank = b.address) =>
      s.ix("kamino_harvest_reward", { reward_index: new BN(0) }, [
        { address: bank },
        { address: h.feeState },
        { address: dst, writable: true },
        { address: b.v.liquidityAuth, writable: true },
        { address: userState, writable: true },
        { address: farm, writable: true },
        { address: globalConfig },
        { address: rewardMint },
        { address: userRewards, writable: true },
        { address: rewardVault, writable: true },
        { address: treasuryVault, writable: true },
        { address: farmAuthority },
        { address: PROGRAM },
        { address: FARMS },
        { address: TOKEN_PROGRAM },
      ]);
    const wrong = await h.tokenAccount(rewardMint, admin.address, 0n);
    await run("harvest: not the fee wallet's account", admin, [refreshUser, harvest(wrong)], [destination, userRewards], true);
    const usdc = await usdcBank();
    await run("harvest: not a kamino bank", admin, [refreshUser, harvest(destination, usdc.bank.address)], [destination], true);
    await run("harvest", admin, [refreshUser, harvest(destination)], [destination, userRewards, userState, farm, rewardVault, treasuryVault]);
    expect(data(destination).readBigUInt64LE(64)).toBeGreaterThan(0n);
    await run("harvest again", admin, [refreshUser, harvest(destination)], [destination, userRewards, userState, farm, rewardVault]);
  });
});
