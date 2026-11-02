// Marginfi part 5 E against the mainnet binary: banks priced at a feed times a rate another program's account holds —
// staked SOL (a validator's SPL single pool: the pool's stake per LST, before and after its on-ramp). The other
// programs' accounts are written into both ledgers (marginfi only reads them); nothing calls those programs.
import { type Address, type Instruction, type KeyPairSigner, address, generateKeyPairSigner, lamports } from "@solana/kit";
import { web3 } from "@anchor-lang/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BN, TOKEN_PROGRAM, pda } from "../../test/harness.js";
import { SYSTEM, report } from "./jito-helpers.js";
import { INSTRUCTIONS, ONE, PROGRAM, bankConfig, fx, marginfiPair, ratio } from "./marginfi-helpers.js";

const SINGLE_POOL = address("SVSPxpvHdN29nkVg9rPapPNDddN5DipNLRUFhyjFThE");
const STAKE = address("Stake11111111111111111111111111111111111111");
const VOTE = address("Vote111111111111111111111111111111111111111");
const MARINADE = address("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
const SPL_STAKE_POOL = address("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
const EXPONENT = address("ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7");
const pk = (a: Address) => new web3.PublicKey(a);

describe("Marginfi v2 port against the mainnet binary: banks priced by another program's rate", () => {
  const h = marginfiPair();
  const { s, setPyth } = h;
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
  const withRest = (ix: Instruction, rest: Address[]): Instruction => ({
    ...ix,
    accounts: [...ix.accounts!, ...rest.map((address) => ({ address, role: 0 }) as never)],
  });
  const data = (a: Address) => Buffer.from((s.original.getAccount(a) as { data: Uint8Array }).data);
  /** An account written into both with this data, owner and lamports. */
  const putAt = (at: Address, d: Buffer, owner: Address, lamportsOf: bigint) => {
    for (const vm of s.vms())
      vm.setAccount({
        address: at,
        data: new Uint8Array(d),
        executable: false,
        lamports: lamports(lamportsOf),
        programAddress: owner,
        space: BigInt(d.length),
      });
  };
  const rentOf = (len: number) => s.original.minimumBalanceForRentExemption(BigInt(len));

  /** A plain SOL bank (asset tag SOL) on a Pyth feed, with another depositor's liquidity to borrow. */
  const solBank = async () => {
    const mint = await h.mint(TOKEN_PROGRAM, 9);
    const oracle = (await s.key()).address;
    const [add, bank] = await h.addBank(
      group.address,
      admin,
      mint,
      TOKEN_PROGRAM,
      bankConfig({ asset_tag: 1, deposit_limit: new BN("10000000000000000"), borrow_limit: new BN("10000000000000000") }),
    );
    await run("add sol bank", admin, [add], [bank.address]);
    const feed = () => setPyth(oracle, { price: 150_000_000n, conf: 100_000n, expo: -6, publishTime: t });
    feed();
    await run("sol oracle", admin, [h.configureOracle(group.address, admin, bank.address, 3, oracle, [oracle])], [bank.address]);
    const lender = await newUser();
    const tokens = await h.tokenAccount(mint, lender.user.address, 1_000_000_000_000_000n);
    await run(
      "lend sol",
      lender.user,
      [h.deposit(group.address, lender.account, lender.user, bank.address, tokens, bank.v.liquidity, 500_000_000_000_000n)],
      [bank.address],
    );
    return { mint, oracle, bank, feed };
  };
  const newUser = async () => {
    const user = await s.funded();
    const account = await s.key();
    await run("account", user, [h.accountInit(group.address, account, user)], [account.address]);
    return { user, account: account.address };
  };

  beforeAll(async () => {
    await h.load();
    admin = h.admin;
    h.setClock(t, slot);
    await run("init fee state", admin, [h.initFeeState(admin, h.feeWallet)], [h.feeState]);
    group = await s.key();
    await run("group init", admin, [h.groupInit(group, admin)], [group.address]);
  });
  afterAll(() => report("marginfi-lst", s));

  it("prices a staked bank at the SOL feed times its pool's stake per LST, before and after the on-ramp", async () => {
    const solOracle = (await s.key()).address;
    const solFeed = () => setPyth(solOracle, { price: 150_000_000n, conf: 100_000n, expo: -6, publishTime: t });
    solFeed();
    const [settings] = await pda(PROGRAM, ["staked_settings", group.address]);
    const settingsIx = (name: string) =>
      s.ix(name, {}, [
        { address: group.address },
        { address: admin.address, signer: admin },
        { address: settings, writable: true },
        { address: INSTRUCTIONS },
      ] as never);
    await run(
      "staked settings",
      admin,
      [
        s.ix(
          "init_staked_settings",
          {
            settings: {
              oracle: pk(solOracle),
              asset_weight_init: fx(ratio(8n, 10n)),
              asset_weight_maint: fx(ratio(9n, 10n)),
              deposit_limit: new BN("1000000000000000"),
              total_asset_value_init_limit: new BN(0),
              oracle_max_age: 60,
              risk_tier: { Collateral: {} },
            },
          },
          [
            { address: group.address },
            { address: admin.address, signer: admin },
            { address: admin.address, signer: admin, writable: true },
            { address: settings, writable: true },
            { address: SYSTEM },
            { address: INSTRUCTIONS },
          ] as never,
        ),
      ],
      [settings],
    );
    // A validator's single pool: its LST mint (supply 1,000 LST), the pool's stake account (a delegated Stake, 1,051 SOL
    // with the pool's 1 SOL bootstrap) and its on-ramp.
    const vote = (await generateKeyPairSigner()).address;
    h.put(vote, Buffer.alloc(3762), VOTE);
    const [stakePool] = await pda(SINGLE_POOL, ["pool", vote]);
    const [lst] = await pda(SINGLE_POOL, ["mint", stakePool]);
    const [solPool] = await pda(SINGLE_POOL, ["stake", stakePool]);
    const [onramp] = await pda(SINGLE_POOL, ["onramp", stakePool]);
    h.put(stakePool, Buffer.alloc(33), SINGLE_POOL);
    const mintData = (supply: bigint) => {
      const m = Buffer.alloc(82);
      m.writeUInt32LE(1, 0);
      Buffer.from(pk(admin.address).toBytes()).copy(m, 4);
      m.writeBigUInt64LE(supply, 36);
      m[44] = 9;
      m[45] = 1;
      return m;
    };
    const setSupply = (supply: bigint) => putAt(lst, mintData(supply), TOKEN_PROGRAM, rentOf(82));
    setSupply(1_000_000_000_000n);
    const stakeData = (tag: number, delegated: bigint) => {
      const d = Buffer.alloc(200);
      d.writeUInt32LE(tag, 0);
      d.writeBigUInt64LE(delegated, 156);
      return d;
    };
    const setStake = (tag: number, delegated: bigint, extra = 0n) => putAt(solPool, stakeData(tag, delegated), STAKE, rentOf(200) + delegated + extra);
    setStake(2, 1_051_000_000_000n);
    putAt(onramp, Buffer.alloc(200), STAKE, rentOf(200));
    const [bankAt] = await pda(PROGRAM, [group.address, lst, new Uint8Array(8)]);
    const v = await h.vaults(bankAt);
    const payer = await s.funded();
    await run(
      "add staked bank",
      payer,
      [
        withRest(
          s.ix("lending_pool_add_bank_permissionless", { bank_seed: new BN(0) }, [
            { address: group.address, writable: true },
            { address: settings },
            { address: payer.address, signer: payer, writable: true },
            { address: lst },
            { address: solPool },
            { address: onramp },
            { address: stakePool },
            { address: vote },
            { address: bankAt, writable: true },
            { address: v.liquidityAuth },
            { address: v.liquidity, writable: true },
            { address: v.insuranceAuth },
            { address: v.insurance, writable: true },
            { address: v.feeAuth },
            { address: v.fee, writable: true },
            { address: TOKEN_PROGRAM },
            { address: SYSTEM },
          ] as never),
          [solOracle, lst, solPool, onramp],
        ),
      ],
      [group.address, bankAt],
    );
    const sol = await solBank();
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(lst, user.address, 100_000_000_000n);
    await run("deposit lst", user, [h.deposit(group.address, account, user, bankAt, tokens, v.liquidity, 10_000_000_000n)], [account, bankAt]);
    const solTo = await h.tokenAccount(sol.mint, user.address, 0n);
    const stakedOracles = [solOracle, lst, solPool, onramp];
    const rest = () => ordered([bankAt, ...stakedOracles], [sol.bank.address, sol.oracle]);
    const borrow = (label: string, amount: bigint, failing = false) =>
      run(
        label,
        user,
        [h.borrow(group.address, account, user, sol.bank, solTo, amount, { rest: rest() })],
        [account, sol.bank.address, solTo, bankAt],
        failing,
      );
    const pulse = (label: string, failing = false) => run(label, user, [h.pulse(group.address, bankAt, stakedOracles)], [bankAt], failing);
    // Before the on-ramp: the delegated stake less the 1 SOL bootstrap, per LST (1.05 SOL).
    await pulse("pulse staked bank (legacy)");
    await borrow("borrow against staked SOL (legacy)", 5_000_000_000n);
    await borrow("borrow: past the staked collateral", 4_000_000_000n, true);
    setStake(1, 0n);
    await pulse("pulse: the pool's stake is not delegated", true);
    setStake(2, 500_000_000n);
    await pulse("pulse: delegated under the bootstrap", true);
    setStake(2, 1_051_000_000_000n);
    setSupply(0n);
    await pulse("pulse: no LST supply", true);
    setSupply(1_000_000_000_000n);
    await run("pulse: the wrong stake account", user, [h.pulse(group.address, bankAt, [solOracle, lst, onramp, onramp])], [bankAt], true);
    // The on-ramp: the pool's and its on-ramp's lamports above rent exemption, per LST plus 1 SOL of phantom tokens.
    await run("enable the on-ramp", admin, [settingsIx("enable_staked_oracle_onramp")], [settings]);
    const propagate = (label: string) =>
      run(
        label,
        payer,
        [s.ix("propagate_staked_settings", {}, [{ address: group.address }, { address: settings }, { address: bankAt, writable: true }] as never)],
        [bankAt],
      );
    await propagate("propagate the on-ramp");
    putAt(onramp, Buffer.alloc(200), STAKE, rentOf(200) + 30_000_000_000n);
    tick();
    solFeed();
    sol.feed();
    await pulse("pulse staked bank (on-ramp)");
    await borrow("borrow against staked SOL (on-ramp)", 1_000_000_000n);
    await run("pulse: another on-ramp", user, [h.pulse(group.address, bankAt, [solOracle, lst, solPool, solPool])], [bankAt], true);
    // Staked oracles off: a staked bank does not price.
    await run("disable staked oracles", admin, [settingsIx("disable_staked_oracles")], [settings]);
    await propagate("propagate the switch-off");
    await pulse("pulse: staked oracles off", true);
    await borrow("borrow: staked oracles off", 1_000n, true);
    expect(data(bankAt).length).toBeGreaterThan(0);
  });

  it("prices mSOL and LST banks at the SOL feed times Marinade's or the stake pool's rate", async () => {
    tick();
    const solOracle = (await s.key()).address;
    const solFeed = () => setPyth(solOracle, { price: 150_000_000n, conf: 100_000n, expo: -6, publishTime: t });
    solFeed();
    const setEpoch = (epoch: bigint) => {
      for (const vm of s.vms()) {
        const c = vm.getClock();
        c.epoch = epoch;
        vm.setClock(c);
      }
    };
    setEpoch(700n);
    // Marinade's state (MinimalMarinadeState after its discriminator): mSOL mint, then the balances its rate sums.
    const marinadeState = (mint: Address, o: { active?: bigint; supply?: bigint; tickets?: bigint; owner?: Address } = {}) => {
      const d = Buffer.alloc(576);
      Buffer.from([216, 146, 107, 94, 104, 75, 182, 177]).copy(d, 0);
      Buffer.from(pk(mint).toBytes()).copy(d, 8);
      d.writeBigUInt64LE(5_000_000_000_000n, 226); // delayed unstake cooling down
      d.writeBigUInt64LE(o.active ?? 1_200_000_000_000_000n, 376); // total active balance
      d.writeBigUInt64LE(20_000_000_000_000n, 496); // available reserve
      d.writeBigUInt64LE(o.supply ?? 1_000_000_000_000_000n, 504); // mSOL supply
      d.writeBigUInt64LE(o.tickets ?? 1_000_000_000_000n, 528); // circulating tickets
      d.writeBigUInt64LE(0n, 568); // emergency cooling down
      return d;
    };
    // An SPL stake pool (Borsh prefix): account type 1, the pool mint, total lamports, pool tokens, last update epoch.
    const stakePool = (mint: Address, o: { total?: bigint; supply?: bigint; epoch?: bigint; type?: number } = {}) => {
      const d = Buffer.alloc(300);
      d[0] = o.type ?? 1;
      Buffer.from(pk(mint).toBytes()).copy(d, 162);
      d.writeBigUInt64LE(o.total ?? 1_150_000_000_000_000n, 258);
      d.writeBigUInt64LE(o.supply ?? 1_000_000_000_000_000n, 266);
      d.writeBigUInt64LE(o.epoch ?? 700n, 274);
      return d;
    };
    const sol = await solBank();
    const lstBank = async (label: string) => {
      const mint = await h.mint(TOKEN_PROGRAM, 9);
      const [add, bank] = await h.addBank(group.address, admin, mint, TOKEN_PROGRAM, bankConfig({ deposit_limit: new BN("10000000000000000") }));
      await run(`add ${label} bank`, admin, [add], [bank.address]);
      return { mint, bank };
    };
    const configure = (label: string, bank: Address, setup: number, rest: Address[], failing = false) =>
      run(label, admin, [h.configureOracle(group.address, admin, bank, setup, solOracle, rest)], [bank], failing);

    // mSOL (PythMSOL, 19): Marinade's state at oracle_keys[1].
    const msol = await lstBank("msol");
    const state = (await s.key()).address;
    putAt(state, marinadeState(msol.mint), MARINADE, rentOf(576));
    const otherState = (await s.key()).address;
    putAt(otherState, marinadeState(sol.mint), MARINADE, rentOf(576));
    await configure("msol oracle: another mint's state", msol.bank.address, 19, [solOracle, otherState], true);
    const fakeState = (await s.key()).address;
    putAt(fakeState, marinadeState(msol.mint), SYSTEM, rentOf(576));
    await configure("msol oracle: not Marinade's", msol.bank.address, 19, [solOracle, fakeState], true);
    await configure("msol oracle", msol.bank.address, 19, [solOracle, state]);
    // LST (PythLST, 22): an SPL stake pool at oracle_keys[1].
    const lst = await lstBank("lst");
    const pool = (await s.key()).address;
    putAt(pool, stakePool(lst.mint), SPL_STAKE_POOL, rentOf(300));
    const otherPool = (await s.key()).address;
    putAt(otherPool, stakePool(sol.mint), SPL_STAKE_POOL, rentOf(300));
    await configure("lst oracle: another mint's pool", lst.bank.address, 22, [solOracle, otherPool], true);
    await configure("lst oracle", lst.bank.address, 22, [solOracle, pool]);

    const { user, account } = await newUser();
    const msolTokens = await h.tokenAccount(msol.mint, user.address, 100_000_000_000n);
    const lstTokens = await h.tokenAccount(lst.mint, user.address, 100_000_000_000n);
    await run(
      "deposit msol",
      user,
      [h.deposit(group.address, account, user, msol.bank.address, msolTokens, msol.bank.v.liquidity, 10_000_000_000n)],
      [account],
    );
    await run("deposit lst", user, [h.deposit(group.address, account, user, lst.bank.address, lstTokens, lst.bank.v.liquidity, 10_000_000_000n)], [account]);
    const solTo = await h.tokenAccount(sol.mint, user.address, 0n);
    const rest = () => ordered([msol.bank.address, solOracle, state], [lst.bank.address, solOracle, pool], [sol.bank.address, sol.oracle]);
    const borrow = (label: string, amount: bigint, failing = false) =>
      run(label, user, [h.borrow(group.address, account, user, sol.bank, solTo, amount, { rest: rest() })], [account, sol.bank.address, solTo], failing);
    await run("pulse msol bank", user, [h.pulse(group.address, msol.bank.address, [solOracle, state])], [msol.bank.address]);
    await run("pulse lst bank", user, [h.pulse(group.address, lst.bank.address, [solOracle, pool])], [lst.bank.address]);
    await borrow("borrow against mSOL and the LST", 5_000_000_000n);
    await borrow("borrow: past the collateral", 5_000_000_000n, true);
    // Rates out of bounds, an empty supply, a stale pool.
    const msolPulse = (label: string) => run(label, user, [h.pulse(group.address, msol.bank.address, [solOracle, state])], [msol.bank.address], true);
    const lstPulse = (label: string) => run(label, user, [h.pulse(group.address, lst.bank.address, [solOracle, pool])], [lst.bank.address], true);
    putAt(state, marinadeState(msol.mint, { supply: 0n }), MARINADE, rentOf(576));
    await msolPulse("pulse: no mSOL supply");
    putAt(state, marinadeState(msol.mint, { active: 4_000_000_000_000_000n }), MARINADE, rentOf(576));
    await msolPulse("pulse: an mSOL rate over 3");
    putAt(state, marinadeState(msol.mint, { active: 0n, tickets: 30_000_000_000_000n }), MARINADE, rentOf(576));
    await msolPulse("pulse: an mSOL rate of 0");
    putAt(state, marinadeState(msol.mint), MARINADE, rentOf(576));
    putAt(pool, stakePool(lst.mint, { supply: 0n }), SPL_STAKE_POOL, rentOf(300));
    await lstPulse("pulse: no pool tokens");
    putAt(pool, stakePool(lst.mint, { epoch: 698n }), SPL_STAKE_POOL, rentOf(300));
    await lstPulse("pulse: a pool two epochs behind");
    putAt(pool, stakePool(lst.mint, { type: 2 }), SPL_STAKE_POOL, rentOf(300));
    await lstPulse("pulse: not a stake pool");
    putAt(pool, stakePool(lst.mint, { total: 3_500_000_000_000_000n }), SPL_STAKE_POOL, rentOf(300));
    await lstPulse("pulse: an LST rate over 3");
    putAt(pool, stakePool(lst.mint, { epoch: 699n }), SPL_STAKE_POOL, rentOf(300));
    await run("pulse lst bank, one epoch behind", user, [h.pulse(group.address, lst.bank.address, [solOracle, pool])], [lst.bank.address]);
    // The rates move: borrows price through them.
    tick();
    solFeed();
    sol.feed();
    putAt(state, marinadeState(msol.mint, { active: 1_300_000_000_000_000n }), MARINADE, rentOf(576));
    await borrow("borrow at the new rates", 500_000_000n);
  });

  it("prices a bank by a Scope entry, dated and within its age", async () => {
    tick();
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
    const sol = await solBank();
    const mint = await h.mint(TOKEN_PROGRAM, 6);
    const [add, bank] = await h.addBank(group.address, admin, mint, TOKEN_PROGRAM, bankConfig());
    await run("add scope bank", admin, [add], [bank.address]);
    const feed = (await s.key()).address;
    // $2.50 as 250,000,000 × 10^-8.
    scopeAccount(7, 250_000_000n, 8n, t, feed);
    await configureScope("scope oracle", bank.address, feed, 7, [feed]);
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(mint, user.address, 10_000_000_000n);
    await run("deposit", user, [h.deposit(group.address, account, user, bank.address, tokens, bank.v.liquidity, 1_000_000_000n)], [account]);
    const solTo = await h.tokenAccount(sol.mint, user.address, 0n);
    const rest = ordered([bank.address, feed], [sol.bank.address, sol.oracle]);
    const pulse = (label: string, failing = false) => run(label, user, [h.pulse(group.address, bank.address, [feed])], [bank.address], failing);
    await pulse("pulse scope bank");
    await run(
      "borrow against scope",
      user,
      [h.borrow(group.address, account, user, sol.bank, solTo, 3_000_000_000n, { rest })],
      [account, sol.bank.address, solTo],
    );
    await run("borrow: past the scope collateral", user, [h.borrow(group.address, account, user, sol.bank, solTo, 5_000_000_000n, { rest })], [account], true);
    tick(61n);
    sol.feed();
    await pulse("pulse: entry older than its age", true);
    scopeAccount(7, 250_000_000n, 8n, t + 5n, feed);
    await pulse("pulse: entry in the future", true);
    scopeAccount(7, 0n, 8n, t, feed);
    await pulse("pulse: entry with no price", true);
    scopeAccount(7, 260_000_000n, 8n, t, feed);
    await pulse("pulse scope bank at a new price");
  });

  it("prices Exponent PT banks along their linear accretion to par, capped by redemption", async () => {
    tick();
    const usdOracle = (await s.key()).address;
    const usdFeed = () => setPyth(usdOracle, { price: 1_000_000n, conf: 1_000n, expo: -6, publishTime: t });
    usdFeed();
    // An Exponent vault (MinimalExponentVault after its discriminator): the PT mint, the start and duration, the SY
    // rates (last seen, all-time high), SY held for PT and the PT supply.
    const vault = (mint: Address, o: { start?: bigint; duration?: bigint; last?: bigint; ath?: bigint; syForPt?: bigint; supply?: bigint } = {}) => {
      const d = Buffer.alloc(457);
      Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]).copy(d, 0);
      Buffer.from(pk(mint).toBytes()).copy(d, 104);
      d.writeUInt32LE(Number(o.start ?? t - 1_000n), 264);
      d.writeUInt32LE(Number(o.duration ?? 10_000n), 268);
      d.writeBigUInt64LE(o.last ?? 1_050_000_000_000n, 337);
      d.writeBigUInt64LE(o.ath ?? o.last ?? 1_050_000_000_000n, 369);
      d.writeBigUInt64LE(o.syForPt ?? 1_000_000_000n, 441);
      d.writeBigUInt64LE(o.supply ?? 1_000_000_000n, 449);
      return d;
    };
    const sol = await solBank();
    const ptBank = async (label: string) => {
      const mint = await h.mint(TOKEN_PROGRAM, 6);
      const [add, bank] = await h.addBank(group.address, admin, mint, TOKEN_PROGRAM, bankConfig({ deposit_limit: new BN("10000000000000000") }));
      await run(`add ${label} bank`, admin, [add], [bank.address]);
      return { mint, bank };
    };
    const setPrice = (label: string, bank: Address, price: bigint, setup: number, rest: Address[], failing = false) =>
      run(label, admin, [h.setOraclePrice(group.address, admin, bank, price, setup, rest)], [bank], failing);

    // PTPyth (25): a USD feed times the PT rate, from a start price of 0.90 (a tenth of the way to maturity: 0.91).
    const pt = await ptBank("pt");
    const v = (await s.key()).address;
    putAt(v, vault(pt.mint), EXPONENT, rentOf(457));
    const otherVault = (await s.key()).address;
    putAt(otherVault, vault(sol.mint), EXPONENT, rentOf(457));
    await setPrice("pt price: another mint's vault", pt.bank.address, (9n * ONE) / 10n, 25, [usdOracle, otherVault], true);
    await setPrice("pt price: start price over 1", pt.bank.address, (11n * ONE) / 10n, 25, [usdOracle, v], true);
    await setPrice("pt price: start price 0", pt.bank.address, 0n, 25, [usdOracle, v], true);
    await setPrice("pt price", pt.bank.address, (9n * ONE) / 10n, 25, [usdOracle, v]);
    // PTFixed (26): the PT rate as the USD price.
    const ptf = await ptBank("fixed pt");
    const vf = (await s.key()).address;
    putAt(vf, vault(ptf.mint), EXPONENT, rentOf(457));
    await setPrice("fixed pt price", ptf.bank.address, (95n * ONE) / 100n, 26, [vf]);

    const { user, account } = await newUser();
    for (const b of [pt, ptf]) {
      const tokens = await h.tokenAccount(b.mint, user.address, 100_000_000_000n);
      await run("deposit pt", user, [h.deposit(group.address, account, user, b.bank.address, tokens, b.bank.v.liquidity, 10_000_000_000n)], [account]);
    }
    const solTo = await h.tokenAccount(sol.mint, user.address, 0n);
    const rest = () => ordered([pt.bank.address, usdOracle, v], [ptf.bank.address, vf], [sol.bank.address, sol.oracle]);
    const ptPulse = (label: string, failing = false) => run(label, user, [h.pulse(group.address, pt.bank.address, [usdOracle, v])], [pt.bank.address], failing);
    await ptPulse("pulse pt bank");
    await run("pulse fixed pt bank", user, [h.pulse(group.address, ptf.bank.address, [vf])], [ptf.bank.address]);
    await run(
      "borrow against pt",
      user,
      [h.borrow(group.address, account, user, sol.bank, solTo, 50_000_000n, { rest: rest() })],
      [account, sol.bank.address, solTo],
    );
    await run(
      "borrow: past the pt collateral",
      user,
      [h.borrow(group.address, account, user, sol.bank, solTo, 100_000_000_000n, { rest: rest() })],
      [account],
      true,
    );
    // Redemption under the linear rate caps it (half the SY behind the PT).
    putAt(v, vault(pt.mint, { syForPt: 500_000_000n }), EXPONENT, rentOf(457));
    await ptPulse("pulse pt bank, capped by redemption");
    // Emergency mode (the SY rate under its all-time high): no price.
    putAt(v, vault(pt.mint, { ath: 1_100_000_000_000n }), EXPONENT, rentOf(457));
    await ptPulse("pulse: vault in emergency mode", true);
    // A schedule past five years, an SY rate past u64, no PT supply.
    putAt(v, vault(pt.mint, { duration: 200_000_000n }), EXPONENT, rentOf(457));
    await ptPulse("pulse: maturity past the horizon", true);
    putAt(v, vault(pt.mint, { supply: 0n }), EXPONENT, rentOf(457));
    await ptPulse("pulse: no PT supply", true);
    // Past maturity: par.
    putAt(v, vault(pt.mint, { start: t - 20_000n }), EXPONENT, rentOf(457));
    tick();
    usdFeed();
    sol.feed();
    await ptPulse("pulse pt bank at maturity");
    await run(
      "borrow at par",
      user,
      [h.borrow(group.address, account, user, sol.bank, solTo, 1_000_000n, { rest: rest() })],
      [account, sol.bank.address, solTo],
    );
  });
});
