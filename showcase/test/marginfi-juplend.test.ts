// Marginfi part 5 D against the mainnet binary: JupLend banks (lending_pool_add_bank_juplend, juplend_init_position,
// juplend_deposit, juplend_withdraw) over JupLend's mainnet lending, liquidity and rewards programs, loaded into both
// ledgers (test/programs/juplend_*.so, fetched: Business Source License). The liquidity layer, its token reserves and
// the Lendings are made with JupLend's own instructions (fixtures/juplend IDLs); Pyth and Switchboard feeds, and the
// Lending's token exchange price in the risk engine.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, lamports } from "@solana/kit";
import { BN, type Idl, type Program, web3 } from "@anchor-lang/core";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOKEN_2022, TOKEN_PROGRAM, pda } from "../../test/harness.js";
import { SYSTEM, program, report } from "./jito-helpers.js";
import { Rng } from "./fuzz-rng.js";
import { INSTRUCTIONS, ONE, PROGRAM, bankConfig, fx, le, marginfiPair, ratio } from "./marginfi-helpers.js";
import { kitIx, programOn } from "./anchor-svm.js";

const LENDING = address("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
const LIQUIDITY = address("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");
const REWARDS = address("jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar");
const METADATA = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const idl = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8")) as Idl;
const pk = (a: Address) => new web3.PublicKey(a);
/** TokenReserve's supply exchange price (liquidity program; after its discriminator). */
const RESERVE_SUPPLY_PRICE = 78;

describe.skipIf(!existsSync(program("juplend_earn.so")))("Marginfi v2 port against the mainnet binary: JupLend banks", () => {
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
  let liq: Program;
  let lend: Program;
  let rew: Program;
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
  /** An Anchor instruction of JupLend's, signed by the admin. */
  const jx = async (i: Promise<web3.TransactionInstruction>) => kitIx(await i, [admin]);
  let liquidity: Address;
  let authList: Address;
  let lendingAdmin: Address;
  let rewardsAdmin: Address;

  /** A JupLend Lending of a new mint (its token reserve, rate model, rewards model and the Lending's protocol position). */
  type Pool = {
    mint: Address;
    reserve: Address;
    rateModel: Address;
    lending: Address;
    fTokenMint: Address;
    rewardsModel: Address;
    supplyPosition: Address;
    vault: Address;
    oracle: Address;
    swb: boolean;
    price: bigint;
  };
  const pools: Pool[] = [];
  const refreshFeeds = () => {
    for (const p of pools)
      if (p.swb) setSwb(p.oracle, { value: p.price * 10n ** 12n, lastUpdate: t });
      else setPyth(p.oracle, { price: p.price, conf: p.price / 10_000n, expo: -6, publishTime: t });
  };
  const newPool = async (price: bigint, swb = false, decimals = 6): Promise<Pool> => {
    const A = pk(admin.address);
    const mint = await h.mint(TOKEN_PROGRAM, decimals);
    const M = pk(mint);
    const [reserve] = await pda(LIQUIDITY, ["reserve", mint]);
    const [rateModel] = await pda(LIQUIDITY, ["rate_model", mint]);
    await run(
      "juplend token reserve",
      admin,
      [
        await jx(
          liq.methods
            .initTokenReserve()
            .accounts({ authority: A, liquidity: pk(liquidity), authList: pk(authList), mint: M, tokenProgram: pk(TOKEN_PROGRAM) })
            .instruction(),
        ),
      ],
      [reserve],
    );
    const pct = (n: number) => new BN(n * 100);
    const configured = { authority: A, authList: pk(authList), rateModel: pk(rateModel), tokenReserve: pk(reserve) };
    await run(
      "juplend rate and token config",
      admin,
      [
        await jx(
          liq.methods
            .updateRateDataV1({ kink: pct(80), rateAtUtilizationZero: pct(4), rateAtUtilizationKink: pct(10), rateAtUtilizationMax: pct(150) })
            .accounts(configured)
            .instruction(),
        ),
        await jx(
          liq.methods
            .updateTokenConfig({ token: M, fee: new BN(0), maxUtilization: pct(100) })
            .accounts(configured)
            .instruction(),
        ),
      ],
      [reserve, rateModel],
    );
    await run(
      "juplend rewards rate model",
      admin,
      [
        await jx(
          rew.methods
            .initLendingRewardsRateModel()
            .accounts({ authority: A, lendingRewardsAdmin: pk(rewardsAdmin), mint: M })
            .instruction(),
        ),
      ],
      [],
    );
    const [fTokenMint] = await pda(LENDING, ["f_token_mint", mint]);
    const [lending] = await pda(LENDING, ["lending", mint, fTokenMint]);
    const [rewardsModel] = await pda(REWARDS, ["lending_rewards_rate_model", mint]);
    await run(
      "juplend lending",
      admin,
      [
        await jx(
          lend.methods
            .initLending("TKN", pk(LIQUIDITY))
            .accounts({ signer: A, lendingAdmin: pk(lendingAdmin), tokenReservesLiquidity: pk(reserve), tokenProgram: pk(TOKEN_PROGRAM) })
            .accountsPartial({ mint: M, lending: pk(lending), fTokenMint: pk(fTokenMint) })
            .instruction(),
        ),
      ],
      [lending, fTokenMint],
    );
    // (Anchor resolves these from the Lending, so they are built once it exists.)
    await run(
      "juplend lending rewards and protocol",
      admin,
      [
        await jx(
          lend.methods
            .setRewardsRateModel(M)
            .accounts({
              signer: A,
              lendingAdmin: pk(lendingAdmin),
              lending: pk(lending),
              newRewardsRateModel: pk(rewardsModel),
              supplyTokenReservesLiquidity: pk(reserve),
            })
            .instruction(),
        ),
        await jx(
          liq.methods
            .initNewProtocol(M, M, pk(lending))
            .accounts({ authority: A, authList: pk(authList) })
            .instruction(),
        ),
      ],
      [lending, fTokenMint],
    );
    const [supplyPosition] = await pda(LIQUIDITY, ["user_supply_position", mint, lending]);
    await run(
      "juplend protocol permissions",
      admin,
      [
        await jx(
          liq.methods
            .updateUserSupplyConfig({
              mode: 1,
              expandPercent: new BN(2000),
              expandDuration: new BN(172800),
              baseWithdrawalLimit: new BN("18446744073709551615"),
            })
            .accounts({ ...configured, userSupplyPosition: pk(supplyPosition) })
            .instruction(),
        ),
        await jx(
          liq.methods
            .updateUserClass([{ addr: pk(lending), value: 1 }])
            .accounts({ authority: A, authList: pk(authList) })
            .instruction(),
        ),
      ],
      [supplyPosition],
    );
    const [vault] = await pda(ATA_PROGRAM, [liquidity, TOKEN_PROGRAM, mint]);
    const p: Pool = { mint, reserve, rateModel, lending, fTokenMint, rewardsModel, supplyPosition, vault, oracle: (await s.key()).address, swb, price };
    pools.push(p);
    refreshFeeds();
    return p;
  };
  /** JupLend's UpdateRate: the Lending's exchange prices brought up to the token reserve's, as of now. */
  const updateRate = (p: Pool) =>
    jx(
      lend.methods
        .updateRate()
        .accounts({ lending: pk(p.lending), supplyTokenReservesLiquidity: pk(p.reserve), rewardsRateModel: pk(p.rewardsModel) })
        .instruction(),
    );

  type JupBank = { address: Address; v: Awaited<ReturnType<typeof h.vaults>>; fTokenVault: Address; intermediary: Address; claim: Address; p: Pool };
  const addJuplendBank = async (
    p: Pool,
    seed: bigint,
    over: Record<string, unknown> = {},
    opts: { rest?: Address[]; lending?: Address; fTokenMint?: Address } = {},
  ) => {
    const [bank] = await pda(PROGRAM, [group.address, p.mint, new Uint8Array(le(seed, 8))]);
    const v = await h.vaults(bank);
    const [fTokenVault] = await pda(PROGRAM, ["f_token_vault", bank]);
    const [intermediary] = await pda(ATA_PROGRAM, [v.liquidityAuth, TOKEN_PROGRAM, p.mint]);
    const [claim] = await pda(LIQUIDITY, ["user_claim", v.liquidityAuth, p.mint]);
    const b: JupBank = { address: bank, v, fTokenVault, intermediary, claim, p };
    const add = s.ix(
      "lending_pool_add_bank_juplend",
      {
        bank_config: {
          oracle: pk(p.oracle),
          asset_weight_init: fx(ratio(8n, 10n)),
          asset_weight_maint: fx(ratio(9n, 10n)),
          deposit_limit: new BN("1000000000000"),
          oracle_setup: p.swb ? { JuplendSwitchboardPull: {} } : { JuplendPythPull: {} },
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
        { address: p.mint },
        { address: bank, writable: true },
        { address: opts.lending ?? p.lending },
        { address: v.liquidityAuth },
        { address: v.liquidity, writable: true },
        { address: v.insuranceAuth },
        { address: v.insurance, writable: true },
        { address: v.feeAuth },
        { address: v.fee, writable: true },
        { address: opts.fTokenMint ?? p.fTokenMint },
        { address: fTokenVault, writable: true },
        { address: TOKEN_PROGRAM },
        { address: SYSTEM },
        { address: INSTRUCTIONS },
        ...(opts.rest ?? [p.oracle, p.lending]).map((address) => ({ address })),
      ],
    );
    return [add, b] as const;
  };
  /** The JupLend accounts every deposit and withdrawal passes on. */
  const venue = (b: JupBank) => ({
    lendingAdmin: { address: lendingAdmin },
    reserve: { address: b.p.reserve, writable: true },
    position: { address: b.p.supplyPosition, writable: true },
    rateModel: { address: b.p.rateModel },
    vault: { address: b.p.vault, writable: true },
    liquidity: { address: liquidity, writable: true },
  });
  const initPosition = (b: JupBank, payer: KeyPairSigner, tokens: Address, amount: bigint) => {
    const j = venue(b);
    return s.ix("juplend_init_position", { amount: new BN(amount.toString()) }, [
      { address: payer.address, signer: payer, writable: true },
      { address: tokens, writable: true },
      { address: b.address, writable: true },
      { address: b.v.liquidityAuth, writable: true },
      { address: b.v.liquidity, writable: true },
      { address: b.p.mint },
      { address: b.p.lending, writable: true },
      { address: b.p.fTokenMint, writable: true },
      { address: b.fTokenVault, writable: true },
      j.lendingAdmin,
      j.reserve,
      j.position,
      j.rateModel,
      j.vault,
      j.liquidity,
      { address: LIQUIDITY },
      { address: b.p.rewardsModel },
      { address: LENDING },
      { address: TOKEN_PROGRAM },
      { address: ATA_PROGRAM },
      { address: SYSTEM },
    ]);
  };
  const deposit = (b: JupBank, account: Address, user: KeyPairSigner, tokens: Address, amount: bigint, o: { rewards?: Address } = {}) => {
    const j = venue(b);
    return s.ix("juplend_deposit", { amount: new BN(amount.toString()) }, [
      { address: group.address, writable: true },
      { address: account, writable: true },
      { address: user.address, signer: user },
      { address: b.address, writable: true },
      { address: tokens, writable: true },
      { address: b.v.liquidityAuth, writable: true },
      { address: b.v.liquidity, writable: true },
      { address: b.p.mint },
      { address: b.p.lending, writable: true },
      { address: b.p.fTokenMint, writable: true },
      { address: b.fTokenVault, writable: true },
      j.lendingAdmin,
      j.reserve,
      j.position,
      j.rateModel,
      j.vault,
      j.liquidity,
      { address: LIQUIDITY },
      { address: o.rewards ?? b.p.rewardsModel },
      { address: LENDING },
      { address: TOKEN_PROGRAM },
      { address: ATA_PROGRAM },
      { address: SYSTEM },
    ]);
  };
  const withdraw = (
    b: JupBank,
    account: Address,
    user: KeyPairSigner,
    tokens: Address,
    amount: bigint,
    all: boolean | null,
    rest: Address[],
    o: { intermediary?: Address; tokenProgram?: Address } = {},
  ) => {
    const j = venue(b);
    const i = s.ix("juplend_withdraw", { amount: new BN(amount.toString()), withdraw_all: all }, [
      { address: group.address },
      { address: account, writable: true },
      { address: user.address, signer: user },
      { address: b.address, writable: true },
      { address: tokens, writable: true },
      { address: b.v.liquidityAuth, writable: true },
      { address: b.p.mint },
      { address: b.p.lending, writable: true },
      { address: b.p.fTokenMint, writable: true },
      { address: b.fTokenVault, writable: true },
      { address: o.intermediary ?? b.intermediary, writable: true },
      j.lendingAdmin,
      j.reserve,
      j.position,
      j.rateModel,
      j.vault,
      { address: b.claim, writable: true },
      j.liquidity,
      { address: LIQUIDITY },
      { address: b.p.rewardsModel },
      { address: LENDING },
      { address: o.tokenProgram ?? TOKEN_PROGRAM },
      { address: ATA_PROGRAM },
      { address: SYSTEM },
    ]);
    return { ...i, accounts: [...i.accounts!, ...rest.map((address) => ({ address, role: AccountRole.READONLY }))] } as Instruction;
  };
  const watch = (b: JupBank, ...more: Address[]) => [b.address, b.v.liquidity, b.fTokenVault, b.intermediary, b.p.lending, b.p.reserve, b.p.vault, ...more];
  const newUser = async () => {
    const user = await s.funded();
    const account = await s.key();
    await run("account", user, [h.accountInit(group.address, account, user)], [account.address]);
    return { user, account: account.address };
  };
  /** A JupLend bank, activated, with its withdrawal intermediary and the liquidity layer's claim account for it. */
  const juplendBank = async (p: Pool, seed: bigint) => {
    const [add, b] = await addJuplendBank(p, seed);
    await run("add juplend bank", admin, [add], watch(b, group.address));
    const tokens = await h.tokenAccount(p.mint, admin.address, 1_000n);
    await run("juplend init position", admin, [initPosition(b, admin, tokens, 100n)], watch(b, tokens));
    await run(
      "juplend claim account",
      admin,
      [
        await jx(
          liq.methods
            .initClaimAccount(pk(p.mint), pk(b.v.liquidityAuth))
            .accounts({ signer: pk(admin.address) })
            .accountsPartial({ claimAccount: pk(b.claim) })
            .instruction(),
        ),
      ],
      [b.claim],
    );
    h.tokenAccountAt(b.intermediary, p.mint, b.v.liquidityAuth);
    return b;
  };
  /** A plain USDC bank on a Pyth feed with another depositor's liquidity, to borrow against the JupLend collateral. */
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
      vm.addProgramFromFile(LENDING, program("juplend_earn.so"));
      vm.addProgramFromFile(LIQUIDITY, program("juplend_liquidity.so"));
      vm.addProgramFromFile(REWARDS, program("juplend_rewards.so"));
      vm.addProgramFromFile(METADATA, program("mpl_token_metadata.so"));
    }
    admin = h.admin;
    h.setClock(t, slot);
    liq = programOn(idl("./fixtures/juplend/liquidity.idl.json"), s.original, admin.address);
    lend = programOn(idl("./fixtures/juplend/juplend_earn.idl.json"), s.original, admin.address);
    rew = programOn(idl("./fixtures/juplend/lending_reward_rate_model.idl.json"), s.original, admin.address);
    await run("init fee state", admin, [h.initFeeState(admin, h.feeWallet)], [h.feeState]);
    group = await s.key();
    await run("group init", admin, [h.groupInit(group, admin)], [group.address]);
    const A = pk(admin.address);
    [liquidity] = await pda(LIQUIDITY, ["liquidity"]);
    [authList] = await pda(LIQUIDITY, ["auth_list"]);
    [lendingAdmin] = await pda(LENDING, ["lending_admin"]);
    [rewardsAdmin] = await pda(REWARDS, ["lending_rewards_admin"]);
    await run(
      "juplend admins",
      admin,
      [
        await jx(liq.methods.initLiquidity(A, A).accounts({ signer: A }).instruction()),
        await jx(rew.methods.initLendingRewardsAdmin(A, pk(LENDING)).accounts({ signer: A }).instruction()),
        await jx(lend.methods.initLendingAdmin(pk(LIQUIDITY), A, A).accounts({ authority: A }).instruction()),
      ],
      [liquidity, lendingAdmin],
    );
  });
  afterAll(() => report("marginfi-juplend", s));

  it("adds a JupLend bank and activates it, refusing what the original refuses", async () => {
    const p = await newPool(1_000_000n);
    const other = await newPool(1_000_000n);
    const [plain] = await addJuplendBank(p, 0n, { oracle_setup: { PythPushOracle: {} } }, { rest: [p.oracle] });
    await run("add juplend bank: not a JupLend oracle setup", admin, [plain], [group.address], true);
    const [mismatch] = await addJuplendBank(p, 0n, {}, { lending: other.lending, fTokenMint: other.fTokenMint });
    await run("add juplend bank: another mint's lending", admin, [mismatch], [group.address], true);
    const [fToken] = await addJuplendBank(p, 0n, {}, { fTokenMint: other.fTokenMint });
    await run("add juplend bank: another lending's fToken mint", admin, [fToken], [group.address], true);
    const [wrongRest] = await addJuplendBank(p, 0n, {}, { rest: [p.oracle, other.lending] });
    await run("add juplend bank: another lending as its oracle account", admin, [wrongRest], [group.address], true);
    const [notLending] = await addJuplendBank(p, 0n, {}, { lending: p.reserve });
    await run("add juplend bank: not a lending", admin, [notLending], [group.address], true);
    const [add, b] = await addJuplendBank(p, 0n);
    await run("add juplend bank", admin, [add], watch(b, group.address));
    const tokens = await h.tokenAccount(p.mint, admin.address, 1_000n);
    const { user, account } = await newUser();
    const userTokens = await h.tokenAccount(p.mint, user.address, 1_000_000n);
    await run("juplend deposit: bank not activated", user, [deposit(b, account, user, userTokens, 1_000n)], watch(b, account), true);
    await run("juplend init position: too small", admin, [initPosition(b, admin, tokens, 9n)], watch(b, tokens), true);
    await run("juplend init position", admin, [initPosition(b, admin, tokens, 100n)], watch(b, tokens));
    await run("juplend init position: again", admin, [initPosition(b, admin, tokens, 100n)], watch(b, tokens), true);
    // Setting the bank's oracle again checks the Lending it was created with (6501).
    const feed = (await s.key()).address;
    setPyth(feed, { price: 1_000_000n, conf: 100n, expo: -6, publishTime: t });
    await run(
      "configure oracle: another lending",
      admin,
      [h.configureOracle(group.address, admin, b.address, 15, feed, [feed, other.lending])],
      [b.address],
      true,
    );
    await run("configure oracle", admin, [h.configureOracle(group.address, admin, b.address, 15, feed, [feed, p.lending])], [b.address]);
  });

  it("takes deposits into JupLend and gives them back, pricing them at the Lending's exchange price", async () => {
    tick();
    const p = await newPool(1_000_000n);
    const b = await juplendBank(p, 0n);
    const usdc = await usdcBank();
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(p.mint, user.address, 100_000_000n);
    tick();
    refreshFeeds();
    usdc.feed();
    await run("juplend deposit", user, [deposit(b, account, user, tokens, 10_000_000n)], watch(b, account, tokens));
    await run("juplend deposit: more", user, [deposit(b, account, user, tokens, 5_000_001n)], watch(b, account, tokens));
    await run("juplend deposit: more than the user has", user, [deposit(b, account, user, tokens, 900_000_000n)], watch(b, account, tokens), true);
    await run(
      "juplend deposit: another rewards model",
      user,
      [deposit(b, account, user, tokens, 1_000n, { rewards: p.rateModel })],
      watch(b, account, tokens),
      true,
    );
    const usdcTo = await h.tokenAccount(usdc.mint, user.address, 0n);
    const rest = ordered([b.address, p.oracle, p.lending], [usdc.bank.address, usdc.oracle]);
    tick();
    refreshFeeds();
    usdc.feed();
    await run(
      "borrow: lending not updated this second",
      user,
      [h.borrow(group.address, account, user, usdc.bank, usdcTo, 1_000_000n, { rest })],
      [account],
      true,
    );
    await run(
      "borrow against juplend",
      user,
      [await updateRate(p), h.borrow(group.address, account, user, usdc.bank, usdcTo, 6_000_000n, { rest })],
      [account, usdc.bank.address, usdcTo],
    );
    await run(
      "borrow: past the juplend collateral",
      user,
      [await updateRate(p), h.borrow(group.address, account, user, usdc.bank, usdcTo, 9_000_000n, { rest })],
      [account],
      true,
    );
    await run("juplend withdraw with a debt", user, [withdraw(b, account, user, tokens, 1_000_000n, null, rest)], watch(b, account, tokens));
    await run("juplend withdraw: all of it, with a debt", user, [withdraw(b, account, user, tokens, 0n, true, rest)], watch(b, account, tokens), true);
    await run(
      "juplend withdraw: another token program",
      user,
      [withdraw(b, account, user, tokens, 100_000n, null, rest, { tokenProgram: TOKEN_2022 })],
      watch(b, account, tokens),
      true,
    );
    await run("juplend withdraw: no oracles", user, [withdraw(b, account, user, tokens, 100_000n, null, [])], watch(b, account, tokens), true);
    const stray = await h.tokenAccount(p.mint, b.v.liquidityAuth, 0n);
    await run(
      "juplend withdraw: not the bank's intermediary",
      user,
      [withdraw(b, account, user, tokens, 100_000n, null, rest, { intermediary: stray })],
      watch(b, account, tokens),
      true,
    );
    // The liquidity layer's supply price rises (as interest would raise it): the Lending's token price follows on its
    // next update, and the collateral, a withdrawal's fTokens and the cache price with it.
    tick();
    refreshFeeds();
    usdc.feed();
    poke(p.reserve, 8 + RESERVE_SUPPLY_PRICE, le(1_250_000_000_000n, 8));
    // The written-in price owes suppliers more than the vault holds: fill it, as the borrowers' interest would have.
    h.tokenAccountAt(p.vault, p.mint, liquidity, data(p.vault).readBigUInt64LE(64) * 2n);
    await run("pulse juplend bank", user, [await updateRate(p), h.pulse(group.address, b.address, [p.oracle, p.lending])], [b.address, p.lending]);
    expect(data(p.lending).readBigUInt64LE(115)).toBeGreaterThan(1_000_000_000_000n);
    await run(
      "borrow at the new price",
      user,
      [await updateRate(p), h.borrow(group.address, account, user, usdc.bank, usdcTo, 2_000_000n, { rest })],
      [account, usdc.bank.address, usdcTo],
    );
    await run("juplend withdraw at the new price", user, [withdraw(b, account, user, tokens, 333_333n, null, rest)], watch(b, account, tokens));
    await run("juplend deposit at the new price", user, [deposit(b, account, user, tokens, 777_777n)], watch(b, account, tokens));
    // A fixed price (FixedJuplend): $1.10 times the Lending's token exchange price, priced from the Lending alone.
    const fixedRest = ordered([b.address, p.lending], [usdc.bank.address, usdc.oracle]);
    await run(
      "fixed price: not the bank's lending",
      admin,
      [h.setOraclePrice(group.address, admin, b.address, (11n * ONE) / 10n, 8, [usdc.oracle])],
      [b.address],
      true,
    );
    await run("fixed price", admin, [h.setOraclePrice(group.address, admin, b.address, (11n * ONE) / 10n, 8, [p.lending])], [b.address]);
    await run("pulse fixed juplend bank", user, [await updateRate(p), h.pulse(group.address, b.address, [p.lending])], [b.address]);
    await run(
      "borrow against fixed juplend",
      user,
      [await updateRate(p), h.borrow(group.address, account, user, usdc.bank, usdcTo, 500_000n, { rest: fixedRest })],
      [account, usdc.bank.address, usdcTo],
    );
    tick();
    usdc.feed();
    await run(
      "borrow: fixed juplend, lending not updated",
      user,
      [h.borrow(group.address, account, user, usdc.bank, usdcTo, 1_000n, { rest: fixedRest })],
      [account],
      true,
    );
    await run("back to the feed", admin, [h.configureOracle(group.address, admin, b.address, 15, p.oracle, [p.oracle, p.lending])], [b.address]);
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
      Buffer.from(pk(p.mint).toBytes()).copy(d, 8);
      d.writeBigUInt64LE(1_200_000_000_000_000n, 376);
      d.writeBigUInt64LE(1_000_000_000_000_000n, 504);
      putAcct(marinade, d, address("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD"));
    }
    const stakePool = (await s.key()).address;
    {
      const d = Buffer.alloc(300);
      d[0] = 1;
      Buffer.from(pk(p.mint).toBytes()).copy(d, 162);
      d.writeBigUInt64LE(1_150_000_000_000_000n, 258);
      d.writeBigUInt64LE(1_000_000_000_000_000n, 266);
      d.writeBigUInt64LE(700n, 274);
      putAcct(stakePool, d, address("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"));
    }
    for (const [name, setup, acct] of [
      ["msol", 21, marinade],
      ["lst", 24, stakePool],
    ] as const) {
      await run(
        `juplend ${name} oracle: not the lending`,
        admin,
        [h.configureOracle(group.address, admin, b.address, setup, p.oracle, [p.oracle, p.oracle, acct])],
        [b.address],
        true,
      );
      await run(
        `juplend ${name} oracle`,
        admin,
        [h.configureOracle(group.address, admin, b.address, setup, p.oracle, [p.oracle, p.lending, acct])],
        [b.address],
      );
      refreshFeeds();
      await run(`pulse juplend ${name} bank`, user, [await updateRate(p), h.pulse(group.address, b.address, [p.oracle, p.lending, acct])], [b.address]);
      await run(
        `borrow against juplend ${name}`,
        user,
        [
          await updateRate(p),
          h.borrow(group.address, account, user, usdc.bank, usdcTo, 100_000n, {
            rest: ordered([b.address, p.oracle, p.lending, acct], [usdc.bank.address, usdc.oracle]),
          }),
        ],
        [account, usdc.bank.address, usdcTo],
      );
    }
    await run("back to the feed again", admin, [h.configureOracle(group.address, admin, b.address, 15, p.oracle, [p.oracle, p.lending])], [b.address]);
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
    await configureScope("juplend scope oracle: not the lending", b.address, scopeFeedAt, 3, [scopeFeedAt, usdc.oracle], true);
    await configureScope("juplend scope oracle", b.address, scopeFeedAt, 3, [scopeFeedAt, p.lending]);
    await run("pulse juplend scope bank", user, [await updateRate(p), h.pulse(group.address, b.address, [scopeFeedAt, p.lending])], [b.address]);
    await run(
      "borrow against juplend scope",
      user,
      [
        await updateRate(p),
        h.borrow(group.address, account, user, usdc.bank, usdcTo, 100_000n, {
          rest: ordered([b.address, scopeFeedAt, p.lending], [usdc.bank.address, usdc.oracle]),
        }),
      ],
      [account, usdc.bank.address, usdcTo],
    );
    await run("back to the feed once more", admin, [h.configureOracle(group.address, admin, b.address, 15, p.oracle, [p.oracle, p.lending])], [b.address]);
    refreshFeeds();
    // Enough to repay the debt and its interest.
    h.tokenAccountAt(usdcTo, usdc.mint, user.address, data(usdcTo).readBigUInt64LE(64) + 1_000_000n);
    await run(
      "repay",
      user,
      [h.repay(group.address, account, user, usdc.bank.address, usdcTo, usdc.bank.v.liquidity, 0n, { all: true })],
      [account, usdc.bank.address],
    );
    await run("juplend withdraw all", user, [withdraw(b, account, user, tokens, 0n, true, [usdc.bank.address, usdc.oracle])], watch(b, account, tokens));
  });

  it("prices a JupLend bank on a Switchboard feed as the original does", async () => {
    tick();
    const p = await newPool(150_000_000n, true, 9);
    const b = await juplendBank(p, 0n);
    const usdc = await usdcBank();
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(p.mint, user.address, 10_000_000_000n);
    await run("switchboard juplend deposit", user, [deposit(b, account, user, tokens, 2_000_000_000n)], watch(b, account, tokens));
    const usdcTo = await h.tokenAccount(usdc.mint, user.address, 0n);
    const rest = ordered([b.address, p.oracle, p.lending], [usdc.bank.address, usdc.oracle]);
    await run(
      "borrow against switchboard juplend",
      user,
      [await updateRate(p), h.borrow(group.address, account, user, usdc.bank, usdcTo, 100_000_000n, { rest })],
      [account, usdc.bank.address, usdcTo],
    );
    await run("switchboard juplend withdraw with a debt", user, [withdraw(b, account, user, tokens, 100_000_000n, null, rest)], watch(b, account, tokens));
    await run(
      "borrow: wrong lending",
      user,
      [
        await updateRate(p),
        h.borrow(group.address, account, user, usdc.bank, usdcTo, 1_000n, {
          rest: ordered([b.address, p.oracle, usdc.oracle], [usdc.bank.address, usdc.oracle]),
        }),
      ],
      [account],
      true,
    );
  });

  it("rebalances between a JupLend bank and a native bank by their supply rates, as the original does", async () => {
    tick();
    const p = await newPool(1_000_000n);
    const b = await juplendBank(p, 0n);
    // A native bank of the pool's mint, priced by its feed, lent to and lightly borrowed from.
    const [nIx, nBank] = await h.addBank(group.address, admin, p.mint, TOKEN_PROGRAM, bankConfig(), { seed: 7n });
    await run("add a native bank of the mint", admin, [nIx], [nBank.address]);
    await run("its oracle", admin, [h.configureOracle(group.address, admin, nBank.address, 3, p.oracle, [p.oracle])], [nBank.address]);
    const usdc = await usdcBank();
    const lender = await newUser();
    const lenderTokens = await h.tokenAccount(p.mint, lender.user.address, 10_000_000_000n);
    await run(
      "lend into the native bank",
      lender.user,
      [h.deposit(group.address, lender.account, lender.user, nBank.address, lenderTokens, nBank.v.liquidity, 5_000_000_000n)],
      [nBank.address],
    );
    const borrower = await newUser();
    const collateral = await h.tokenAccount(usdc.mint, borrower.user.address, 100_000_000_000n);
    await run(
      "collateral",
      borrower.user,
      [h.deposit(group.address, borrower.account, borrower.user, usdc.bank.address, collateral, usdc.bank.v.liquidity, 50_000_000_000n)],
      [borrower.account],
    );
    const borrowTo = await h.tokenAccount(p.mint, borrower.user.address, 0n);
    tick();
    refreshFeeds();
    usdc.feed();
    await run(
      "borrow from the native bank",
      borrower.user,
      [
        h.borrow(group.address, borrower.account, borrower.user, nBank, borrowTo, 500_000_000n, {
          rest: ordered([nBank.address, p.oracle], [usdc.bank.address, usdc.oracle]),
        }),
      ],
      [borrower.account, nBank.address],
    );
    // The account to rebalance: its tokens in the JupLend bank (no borrowers, no rewards: it pays nothing).
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(p.mint, user.address, 1_000_000_000n);
    await run("juplend deposit", user, [deposit(b, account, user, tokens, 1_000_000_000n)], watch(b, account, tokens));
    const executor = await s.funded();
    const exWallet = await h.tokenAccount(p.mint, executor.address, 0n);
    const [order] = await pda(PROGRAM, ["rebalance_order", account, p.mint]);
    const [pool] = await pda(PROGRAM, ["rebalance_fee_pool", account]);
    await run(
      "place a rebalance order",
      user,
      [
        s.ix(
          "marginfi_account_place_rebalance_order",
          {
            allowed_banks: [b.address, nBank.address].map(pk),
            min_improvement: fx(ONE / 10_000n),
            cooldown_seconds: new BN(60),
            amount: null,
            keeper_tip: new BN(1_000_000),
          },
          [
            { address: group.address },
            { address: account, writable: true },
            { address: user.address, signer: user },
            { address: p.mint },
            { address: order, writable: true },
            { address: user.address, signer: user, writable: true },
            { address: SYSTEM },
          ] as never,
        ),
      ],
      [account, order],
    );
    await run(
      "fund the fee pool",
      user,
      [
        s.ix("marginfi_account_top_up_rebalance_fee_pool", { amount: new BN(5_000_000) }, [
          { address: account },
          { address: pool, writable: true },
          { address: user.address, signer: user, writable: true },
          { address: SYSTEM },
        ] as never),
      ],
      [pool],
    );
    // JupLend's block: the bank, the token reserve, its rewards model, fToken mint and the mint's rate model, then the
    // oracles; the native bank's: the bank and its feed.
    const blockMetas = [
      { address: b.address, role: AccountRole.WRITABLE },
      { address: p.reserve, role: AccountRole.READONLY },
      { address: p.rewardsModel, role: AccountRole.READONLY },
      { address: p.fTokenMint, role: AccountRole.READONLY },
      { address: p.rateModel, role: AccountRole.READONLY },
      { address: p.oracle, role: AccountRole.READONLY },
      { address: p.lending, role: AccountRole.READONLY },
      { address: nBank.address, role: AccountRole.WRITABLE },
      { address: p.oracle, role: AccountRole.READONLY },
    ];
    let seq = 0n;
    type Move = [number, number, bigint];
    const moveArg = (list: Move[]) => list.map(([src, dst, amount]) => ({ src_index: src, dst_index: dst, _pad0: [0, 0, 0, 0, 0, 0], amount: fx(amount) }));
    const health = ordered([b.address, p.oracle, p.lending], [nBank.address, p.oracle]);
    const rebalance = async (label: string, list: Move[], legs: Instruction[], failing = false, metas = blockMetas) => {
      tick();
      refreshFeeds();
      usdc.feed();
      const [record] = await pda(PROGRAM, ["rebalance_record", account, new Uint8Array(le(seq, 8))]);
      const start = s.ix("marginfi_account_start_rebalance", { moves: moveArg(list), execution_seq: new BN(seq.toString()) }, [
        { address: group.address },
        { address: account, writable: true },
        { address: order },
        { address: executor.address },
        { address: record, writable: true },
        { address: executor.address, signer: executor, writable: true },
        { address: INSTRUCTIONS },
        { address: SYSTEM },
      ] as never);
      const end = s.ix("marginfi_account_end_rebalance", {}, [
        { address: group.address },
        { address: account, writable: true },
        { address: order, writable: true },
        { address: record, writable: true },
        { address: executor.address, signer: executor, writable: true },
        { address: pool, writable: true },
        { address: SYSTEM },
      ] as never);
      const o = await run(
        `rebalance: ${label}`,
        executor,
        [
          // The liquidity layer's token reserve (whose rate a JupLend leg reads) and the Lending, brought up to now.
          await jx(
            liq.methods
              .updateExchangePrice(pk(p.mint))
              .accounts({ tokenReserve: pk(p.reserve), rateModel: pk(p.rateModel) })
              .instruction(),
          ),
          await updateRate(p),
          { ...start, accounts: [...start.accounts!, ...metas] } as Instruction,
          ...legs,
          { ...end, accounts: [...end.accounts!, ...metas, ...health.map((address) => ({ address, role: AccountRole.READONLY }))] } as Instruction,
        ],
        [account, order, record, b.address, nBank.address, b.fTokenVault, nBank.v.liquidity, exWallet],
        failing,
      );
      if (o === "ok") seq += 1n;
      return o;
    };
    const fromJuplend = (amount: bigint) => [
      withdraw(b, account, executor, exWallet, amount * 1_000_000n, null, health),
      h.deposit(group.address, account, executor, nBank.address, exWallet, nBank.v.liquidity, amount * 1_000_000n),
    ];
    const intoJuplend = (amount: bigint) => [
      h.withdraw(group.address, account, executor, nBank, exWallet, amount * 1_000_000n, { rest: health }),
      deposit(b, account, executor, exWallet, amount * 1_000_000n),
    ];
    tick(120n);
    await rebalance("into JupLend, which pays nothing", [[1, 0, 10n * ONE]], [], true);
    const wrongModel = blockMetas.map((x) => (x.address === p.rateModel ? { ...x, address: p.reserve } : x));
    await rebalance("another account as the rate model", [[0, 1, 400n * ONE]], fromJuplend(400n), true, wrongModel);
    await rebalance("400 tokens out of JupLend", [[0, 1, 400n * ONE]], fromJuplend(400n));
    // Settlement reads each bank's yield index (its venue's rate: no rewards accounts).
    tick(4_000n);
    refreshFeeds();
    usdc.feed();
    const [record0] = await pda(PROGRAM, ["rebalance_record", account, new Uint8Array(le(0n, 8))]);
    const settleIx = s.ix("marginfi_account_settle_rebalance_tip", {}, [
      { address: group.address },
      { address: account },
      { address: record0, writable: true },
      { address: executor.address, writable: true },
      { address: pool, writable: true },
      { address: executor.address, signer: executor, writable: true },
    ] as never);
    const settleMetas = [
      { address: b.address, role: AccountRole.WRITABLE },
      { address: p.reserve, role: AccountRole.READONLY },
      { address: p.oracle, role: AccountRole.READONLY },
      { address: p.lending, role: AccountRole.READONLY },
      { address: nBank.address, role: AccountRole.WRITABLE },
      { address: p.oracle, role: AccountRole.READONLY },
    ];
    await run(
      "settle the rebalance tip",
      executor,
      [await updateRate(p), { ...settleIx, accounts: [...settleIx.accounts!, ...settleMetas] } as Instruction],
      [record0, pool, executor.address],
    );
    // The Lending's rewards switched on (its rewards model written in): JupLend now pays more, priced with the tokens in.
    const model = Buffer.from(data(p.rewardsModel));
    model.writeBigUInt64LE(0n, 40); // start TVL
    model.writeBigUInt64LE(100_000_000n, 48); // duration
    model.writeBigUInt64LE(t - 1_000n, 56); // start time
    model.writeBigUInt64LE(1_000_000_000_000n, 64); // yearly reward
    poke(p.rewardsModel, 0, model);
    tick(120n);
    await rebalance("200 tokens back into JupLend, with rewards", [[1, 0, 200n * ONE]], intoJuplend(200n));
  });

  it("matches the original through random deposits, withdrawals, borrows and exchange prices", async () => {
    // FUZZ_SEED=<seed> reproduces a run, FUZZ_STEPS=<n> lengthens it, FUZZ_VERBOSE=1 prints the failures' codes.
    // Every transaction must match the original's outcome, error code, account bytes and events, whichever it is.
    const seed = BigInt(process.env.FUZZ_SEED ?? Date.now());
    const steps = Number(process.env.FUZZ_STEPS ?? 60);
    const rng = new Rng(seed);
    const label = (what: string) => `fuzz juplend (seed ${seed}): ${what}`;
    tick();
    const p = await newPool(1_000_000n + BigInt(rng.int(5_000_000)), rng.chance(50), rng.pick([6, 8, 9]));
    const b = await juplendBank(p, 0n);
    const usdc = await usdcBank();
    const { user, account } = await newUser();
    const tokens = await h.tokenAccount(p.mint, user.address, 1_000_000_000_000n);
    const usdcTo = await h.tokenAccount(usdc.mint, user.address, 0n);
    // The health accounts: the banks the account has a balance in (tracked from what succeeded), now and then wrong.
    let deposited = false;
    let owing = false;
    const rest = (borrowing = false) => {
      const groups = [...(deposited ? [[b.address, p.oracle, p.lending]] : []), ...(owing || borrowing ? [[usdc.bank.address, usdc.oracle]] : [])];
      if (rng.chance(10)) groups.push([usdc.bank.address, usdc.oracle].slice(0, 1));
      return ordered(...groups);
    };
    let supplyPrice = 1_000_000_000_000n;
    /** h.run, counting what succeeded: a run that only ever fails would prove little. */
    const ok = new Map<string, number>();
    const go = async (what: string, ...rest: Parameters<typeof h.run> extends [string, ...infer R] ? R : never) => {
      const o = await h.run(label(what), ...rest);
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
              [await updateRate(p), h.borrow(group.address, account, user, usdc.bank, usdcTo, rng.next() % 50_000_000n, { rest: rest(true) })],
              [account, usdc.bank.address, usdcTo],
            )) === "ok"
          )
            owing = true;
          break;
        case 5: {
          // The liquidity layer's supply price only rises; the vault filled so suppliers can be paid.
          supplyPrice += (supplyPrice * BigInt(rng.int(500))) / 10_000n + BigInt(rng.int(1_000_000));
          poke(p.reserve, 8 + RESERVE_SUPPLY_PRICE, le(supplyPrice, 8));
          h.tokenAccountAt(p.vault, p.mint, liquidity, data(p.vault).readBigUInt64LE(64) + 10_000_000_000_000n);
          await go("pulse", user, [await updateRate(p), h.pulse(group.address, b.address, [p.oracle, p.lending])], [b.address, p.lending]);
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
    console.log(`fuzz juplend (seed ${seed}): succeeded ${JSON.stringify(Object.fromEntries(ok))}`);
    expect(ok.get("deposit") ?? 0, "deposits succeeded").toBeGreaterThan(0);
    expect((ok.get("withdraw") ?? 0) + (ok.get("withdraw all") ?? 0), "withdrawals succeeded").toBeGreaterThan(0);
  });
});
