// The graduation instructions of showcase/mainnet/meteora-dbc (a port subject to Meteora's Non-commercial Licence, see
// that directory's LICENSE.md) against Meteora's Dynamic Bonding Curve 0.2.2 on mainnet, side by side
// (meteora-dbc-helpers.ts, meteora-dbc-graduation.ts): partner_withdraw_surplus, creator_withdraw_surplus,
// withdraw_migration_fee, withdraw_leftover, create_locker, migration_damm_v2_create_metadata and migration_damm_v2.
// Both programs call DAMM v2 and the locker as deployed on mainnet, on DAMM v2's migration configs read from mainnet.
// Pools are made by the pool creation instructions and driven to the threshold by swaps; every transaction must give
// the same outcome and error code, the same bytes of every account it touches (the DAMM v2 pool, positions, position
// NFT mints and accounts, vaults, the locker's escrow), the same inner instructions and the same events.
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { present } from "../../test/binaries.js";
import { type Graduation, type PoolInfo, DAMM_CONFIGS, DAMM_V2, DAMM_SO, LOCKER_SO, MPL_SO, dammPool, graduation } from "./meteora-dbc-graduation.js";
import {
  type Params,
  type Vesting,
  ORIGINAL,
  PROGRAM,
  TOKEN,
  TOKEN_2022,
  baseParams,
  builtin,
  constantSupply,
  custom,
  mint,
  noVesting,
  transferFee,
} from "./meteora-dbc-helpers.js";

const E = {
  MathOverflow: 6000,
  TypeCastFailed: 6006,
  InvalidMigrationFeeOption: 6010,
  PoolIsIncompleted: 6014,
  InvalidMigrationOption: 6015,
  NotPermitToDoThisAction: 6022,
  InvalidConfigAccount: 6024,
  SurplusHasBeenWithdraw: 6025,
  LeftoverHasBeenWithdraw: 6026,
  MissingPoolConfigInRemainingAccount: 6030,
  MigrationFeeHasBeenWithdraw: 6040,
  Unauthorized: 6053,
  InvalidPoolAccount: 6075,
  QuoteMintHasNonZeroTransferFee: 6081,
} as const;
const A = {
  ConstraintRaw: 2003,
  ConstraintSeeds: 2006,
  ConstraintAddress: 2012,
  ConstraintHasOne: 2001,
  ConstraintTokenMint: 2014,
  ConstraintTokenOwner: 2015,
  ConstraintDuplicateMutableAccount: 2040,
  AccountNotSigner: 3010,
  AccountDiscriminatorMismatch: 3002,
  AccountOwnedByWrongProgram: 3007,
} as const;

const vesting = (percentage: number, cliff = 86400, periods = 50, bps = 100, frequency = 3600): Vesting => ({
  vesting_percentage: percentage,
  bps_per_period: bps,
  number_of_periods: periods,
  cliff_duration_from_migration_time: cliff,
  frequency,
});
const lockedVesting = {
  amount_per_period: 1_000_000_000n,
  cliff_duration_from_migration_time: 3600n,
  frequency: 60n,
  number_of_period: 10n,
  cliff_unlock_amount: 5_000_000_000n,
};
const customizable = (b: Params, collect: number, dynamic: number, bps: number, mode = 0): Params => ({
  ...b,
  migration_fee_option: 6,
  migrated_pool_fee: { collect_fee_mode: collect, dynamic_fee: dynamic, pool_fee_bps: bps },
  migrated_pool_base_fee_mode: mode,
});

describe.skipIf(!present(ORIGINAL, MPL_SO, DAMM_SO, LOCKER_SO))("showcase/mainnet/meteora-dbc graduation against Meteora DBC 0.2.2 on mainnet", () => {
  let g: Graduation;
  let quoteSpl: Address;
  let quote2022: Address;
  beforeAll(async () => {
    g = await graduation();
    quoteSpl = await mint(g.p, TOKEN, 9);
    quote2022 = await mint(g.p, TOKEN_2022, 6, [{ kind: "metadataPointer" }]);
  }, 300_000);
  afterAll(() => {
    if (!g) return;
    console.log(
      `meteora-dbc graduation: ${g.p.stats.compared} transactions compared, ${g.p.stats.innerCompared} inner instructions; outcomes ${JSON.stringify(g.p.stats.byOutcome)}`,
    );
  });

  /** A pool through its whole graduation: the locker when the config vests, the metadata, the migration. */
  async function graduate(pi: PoolInfo, label: string) {
    await g.complete(pi);
    if (pi.params.locked_vesting.frequency > 0n) expect(await g.locker(pi), `${label}: locker`).toBe("ok");
    expect(await g.metadata(pi), `${label}: metadata`).toBe("ok");
    const r = await g.migrate(pi, { label });
    expect(r.outcome, label).toBe("ok");
    return r.migrated;
  }

  it("every migration progress: what each instruction refuses before and after completion, then the whole graduation", async () => {
    const params: Params = {
      ...baseParams(),
      creator_trading_fee_percentage: 30,
      migration_fee: { fee_percentage: 10, creator_fee_percentage: 40 },
      locked_vesting: lockedVesting,
    };
    const pi = await g.pool(params, quoteSpl, TOKEN);
    const stranger = await g.p.funded();
    // PreBondingCurve: nothing to withdraw, no locker, no migration
    expect(await g.surplus(pi, "partner")).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.surplus(pi, "creator")).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.migrationFee(pi, 0, pi.partner)).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.locker(pi)).toBe(custom(E.NotPermitToDoThisAction));
    expect((await g.migrate(pi)).outcome).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.leftover(pi, true)).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.metadata(pi)).toBe("ok");
    expect(await g.buy(pi, 20_000_000_000n)).toBe("ok");
    expect(await g.surplus(pi, "partner")).toBe(custom(E.NotPermitToDoThisAction));
    // PostBondingCurve (the config vests): withdrawals open, migration waits for the locker
    await g.complete(pi);
    expect(await g.surplus(pi, "partner", stranger)).toBe(custom(E.Unauthorized));
    expect(await g.surplus(pi, "creator", stranger)).toBe(custom(E.Unauthorized));
    expect(await g.surplus(pi, "partner", undefined, { quoteMint: pi.baseMint })).toBe(custom(A.ConstraintTokenMint));
    expect(await g.surplus(pi, "partner", undefined, { config: (await g.config(params, quoteSpl)).config })).toBe(custom(E.Unauthorized));
    expect(await g.surplus(pi, "partner")).toBe("ok");
    expect(await g.surplus(pi, "partner")).toBe(custom(E.SurplusHasBeenWithdraw));
    expect(await g.migrationFee(pi, 0, stranger)).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.migrationFee(pi, 1, pi.partner)).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.migrationFee(pi, 2, pi.partner)).toBe(custom(E.TypeCastFailed));
    expect(await g.migrationFee(pi, 0, pi.partner)).toBe("ok");
    expect(await g.migrationFee(pi, 0, pi.partner)).toBe(custom(E.MigrationFeeHasBeenWithdraw));
    expect((await g.migrate(pi)).outcome).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.leftover(pi, true)).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.locker(pi, { creator: stranger.address })).toBe(custom(A.ConstraintHasOne));
    expect(await g.locker(pi, { base: stranger.address })).toBe(custom(A.ConstraintSeeds));
    expect(await g.locker(pi, { locker: PROGRAM })).toBe(custom(A.ConstraintAddress));
    const other = await g.pool(params, quoteSpl, TOKEN);
    expect(await g.locker(pi, { config: other.config })).toBe(custom(A.ConstraintHasOne));
    expect(await g.locker(pi, { baseVault: other.baseVault })).toBe(custom(A.ConstraintTokenMint));
    expect(await g.locker(pi, { pool: pi.config })).toBe(custom(A.ConstraintSeeds));
    expect(await g.surplus(pi, "partner", undefined, { pool: pi.config })).toBe(custom(E.InvalidPoolAccount));
    expect(await g.surplus(pi, "creator", undefined, { pool: pi.config })).toBe(custom(E.InvalidPoolAccount));
    expect(await g.surplus(pi, "partner", undefined, { quoteVault: other.quoteVault })).toBe(custom(A.ConstraintHasOne));
    expect(await g.surplus(pi, "partner", undefined, { pool: other.pool })).toBe(custom(A.ConstraintHasOne));
    expect(await g.migrationFee(pi, 0, pi.partner, { pool: other.pool })).toBe(custom(A.ConstraintHasOne));
    expect(await g.migrationFee(pi, 0, pi.partner, { config: other.config })).toBe(custom(A.ConstraintHasOne));
    expect(await g.locker(pi)).toBe("ok");
    // LockedVesting: the locker is done; the creator's withdrawals still open
    expect(await g.locker(pi)).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.surplus(pi, "creator")).toBe("ok");
    expect(await g.surplus(pi, "creator")).toBe(custom(E.SurplusHasBeenWithdraw));
    expect(await g.migrationFee(pi, 1, pi.creator)).toBe("ok");
    expect(await g.migrationFee(pi, 1, pi.creator)).toBe(custom(E.MigrationFeeHasBeenWithdraw));
    // migration refusals: no DAMM config, a config of another option, a config of another program, accounts
    expect((await g.migrate(pi, { dammConfig: null })).outcome).toBe(custom(E.MissingPoolConfigInRemainingAccount));
    expect((await g.migrate(pi, { dammConfig: DAMM_CONFIGS[1]! })).outcome).toBe(custom(E.InvalidMigrationFeeOption));
    expect((await g.migrate(pi, { dammConfig: DAMM_CONFIGS[6]! })).outcome).toBe(custom(E.InvalidMigrationFeeOption));
    expect((await g.migrate(pi, { dammConfig: pi.config })).outcome).toBe(custom(A.AccountOwnedByWrongProgram));
    expect((await g.migrate(pi, { over: { baseVault: pi.quoteVault } })).outcome).toBe(custom(A.ConstraintDuplicateMutableAccount));
    expect((await g.migrate(pi, { over: { config: (await g.config(params, quoteSpl)).config } })).outcome).toBe(custom(A.ConstraintHasOne));
    expect((await g.migrate(pi, { over: { amm: PROGRAM } })).outcome).toBe(custom(A.ConstraintAddress));
    expect((await g.migrate(pi, { over: { pool: pi.config } })).outcome).toBe(custom(E.InvalidPoolAccount));
    expect((await g.migrate(pi, { over: { quoteVault: other.quoteVault } })).outcome).toBe(custom(A.ConstraintHasOne));
    expect((await g.migrate(pi, { over: { config: other.config } })).outcome).toBe(custom(A.ConstraintHasOne));
    expect((await g.migrate(pi, { sameNft: true })).outcome).toBe(custom(A.ConstraintRaw));
    expect((await g.migrate(pi, { noSecond: true })).outcome).toBe(builtin("ProgramFailedToComplete"));
    expect((await g.migrate(pi)).outcome).toBe("ok");
    // CreatedPool
    expect((await g.migrate(pi)).outcome).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.locker(pi)).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.leftover(pi, true)).toBe(custom(E.NotPermitToDoThisAction));
    expect(await g.surplus(pi, "partner")).toBe(custom(E.SurplusHasBeenWithdraw));
  });

  it("each fixed fee option (0.25% to 6%) on its DAMM v2 config", async () => {
    for (let option = 0; option < 6; option++) {
      const pi = await g.pool({ ...baseParams(), migration_fee_option: option }, quoteSpl, TOKEN);
      await g.complete(pi);
      // the next option's config: a base fee the option refuses
      expect((await g.migrate(pi, { dammConfig: DAMM_CONFIGS[(option + 1) % 6]! })).outcome).toBe(custom(E.InvalidMigrationFeeOption));
      const m = await g.migrate(pi, { label: `option ${option}` });
      expect(m.outcome).toBe("ok");
      expect(dammPool(g, m.migrated)?.liquidity).toBeGreaterThan(0n);
    }
  });

  it("customizable pools: collect fee modes, the dynamic fee, the fee time and market cap schedulers, compounding", async () => {
    const b = baseParams();
    const scheduler = { number_of_period: 20, sqrt_price_step_bps: 100, scheduler_expiration_duration: 86400, reduction_factor: 100n };
    const cases: [string, Params][] = [
      ["quote token, no dynamic fee", customizable(b, 0, 0, 100)],
      ["output token, dynamic fee", customizable(b, 1, 1, 250)],
      ["quote token, dynamic fee, exponential", customizable(b, 0, 1, 1000, 1)],
      ["dynamic fee at the minimum fee", customizable(b, 1, 1, 10)],
      [
        "market cap scheduler, linear",
        { ...customizable(b, 0, 1, 500, 3), migrated_pool_market_cap_fee_scheduler_params: { ...scheduler, reduction_factor: 1000000n } },
      ],
      ["market cap scheduler, exponential", { ...customizable(b, 1, 0, 500, 4), migrated_pool_market_cap_fee_scheduler_params: scheduler }],
      ["compounding", { ...customizable(b, 2, 0, 100), compounding_fee_bps: 5000 }],
      ["compounding, dynamic fee, every fee compounded", { ...customizable(b, 2, 1, 300), compounding_fee_bps: 10000 }],
      [
        "compounding, market cap scheduler",
        { ...customizable(b, 2, 0, 500, 4), compounding_fee_bps: 0, migrated_pool_market_cap_fee_scheduler_params: scheduler },
      ],
    ];
    for (const [label, params] of cases) {
      const pi = await g.pool(params, quoteSpl, TOKEN);
      await graduate(pi, label);
    }
  });

  it("partner and creator liquidity: unlocked, permanently locked and vested, either side first", async () => {
    const b = baseParams();
    const split = (pl: number, pp: number, cl: number, cp: number, pv = noVesting(), cv = noVesting()): Params => ({
      ...b,
      partner_liquidity_percentage: pl,
      partner_permanent_locked_liquidity_percentage: pp,
      creator_liquidity_percentage: cl,
      creator_permanent_locked_liquidity_percentage: cp,
      partner_liquidity_vesting_info: pv,
      creator_liquidity_vesting_info: cv,
    });
    const cases: [string, Params][] = [
      ["partner first, locked and vested", split(10, 20, 40, 0, vesting(30))],
      ["creator first, vested and locked", split(30, 0, 0, 10, noVesting(), vesting(60, 3600, 10, 500, 86400))],
      ["all permanently locked by the partner", split(0, 100, 0, 0)],
      ["all vested by the creator, cliff only", split(0, 0, 0, 0, noVesting(), vesting(100, 2 * 86400, 0, 0, 0))],
      ["both vest", split(0, 10, 0, 10, vesting(40, 7200, 100, 50, 600), vesting(40, 100, 20, 100, 60))],
      ["equal halves, unlocked and locked", split(50, 0, 0, 50)],
      ["vesting in tiny periods", split(45, 0, 0, 0, noVesting(), vesting(55, 1, 10000, 1, 100))],
    ];
    for (const [label, params] of cases) {
      for (const p of [params, { ...customizable(params, 0, 0, 100) }]) {
        const pi = await g.pool(p, quoteSpl, TOKEN);
        await graduate(pi, `${label} (option ${p.migration_fee_option})`);
      }
    }
  });

  it("Token-2022 bases and quotes, and a fixed supply: the burn, the leftover", async () => {
    const b = baseParams();
    // a Token-2022 base without a transfer fee, on each kind of config
    for (const params of [{ ...b, token_type: 1 }, customizable({ ...b, token_type: 1 }, 1, 1, 200)])
      await graduate(await g.pool(params, quoteSpl, TOKEN), "Token-2022 base");
    // a Token-2022 quote
    for (const params of [b, { ...b, token_type: 1, migration_fee_option: 3 }]) await graduate(await g.pool(params, quote2022, TOKEN_2022), "Token-2022 quote");
    // a fixed supply above what migrates: the rest burns, up to the supply the config lets go, then the leftover
    for (const [pre, post] of [
      [10n ** 17n, 10n ** 17n],
      [10n ** 17n, 9n * 10n ** 16n],
      [10n ** 17n, 6n * 10n ** 16n],
    ] as const) {
      const params = { ...b, token_supply: { pre_migration_token_supply: pre, post_migration_token_supply: post } };
      const pi = await g.pool(params, quoteSpl, TOKEN);
      await graduate(pi, `fixed supply ${pre} / ${post}`);
      const other = await g.pool(params, quoteSpl, TOKEN);
      expect(await g.leftover(pi, false, { config: other.config })).toBe(custom(A.ConstraintHasOne));
      expect(await g.leftover(pi, false, { receiver: (await generateKeyPairSigner()).address })).toBe(custom(A.ConstraintTokenOwner));
      expect(await g.leftover(pi, false, { baseVault: pi.quoteVault })).toBe(custom(A.ConstraintTokenMint));
      expect(await g.leftover(pi, false, { dst: await g.account(pi.creator.address, pi.baseMint, TOKEN) })).toBe(custom(A.ConstraintTokenOwner));
      expect(await g.leftover(pi, false)).toBe("ok");
      expect(await g.leftover(pi, false)).toBe(custom(E.LeftoverHasBeenWithdraw));
    }
    // a dynamic supply has no leftover
    const pi = await g.pool(b, quoteSpl, TOKEN);
    await graduate(pi, "dynamic supply");
    expect(await g.leftover(pi, true)).toBe(custom(E.NotPermitToDoThisAction));
  });

  it("a base transfer fee: the split position, each migrated fee authority option, the leftover signed", async () => {
    const b = constantSupply(baseParams());
    const cases: [string, Params, ReturnType<typeof transferFee>][] = [
      ["immutable fee", b, transferFee(100, 0, 0)],
      ["revoked to zero", b, transferFee(250, 1, 1)],
      ["to the creator", b, transferFee(50, 0, 2)],
      ["to the partner, no fee", b, transferFee(0, 1, 3)],
      [
        "to the creator, partner first, vested",
        {
          ...b,
          partner_liquidity_percentage: 20,
          partner_liquidity_vesting_info: vesting(40),
          creator_liquidity_percentage: 0,
          creator_permanent_locked_liquidity_percentage: 40,
        },
        transferFee(1000, 0, 2),
      ],
      [
        "creator first, dynamic fee",
        { ...b, migrated_pool_fee: { collect_fee_mode: 2, dynamic_fee: 1, pool_fee_bps: 200 }, compounding_fee_bps: 2000 },
        transferFee(10, 0, 3),
      ],
      [
        "all to one side",
        {
          ...b,
          partner_liquidity_percentage: 0,
          partner_permanent_locked_liquidity_percentage: 0,
          creator_liquidity_percentage: 90,
          creator_permanent_locked_liquidity_percentage: 10,
        },
        transferFee(300, 0, 1),
      ],
    ];
    for (const [label, params, fee] of cases) {
      const pi = await g.pool(params, quoteSpl, TOKEN, { fee });
      await g.complete(pi);
      expect(await g.surplus(pi, "partner")).toBe("ok");
      const m = await g.migrate(pi, { label });
      expect(m.outcome, label).toBe("ok");
      if (fee.transfer_fee_basis_points > 0) expect(await g.leftover(pi, false), `${label}: leftover unsigned`).toBe(custom(A.AccountNotSigner));
      expect(await g.leftover(pi, true), `${label}: leftover`).toBe("ok");
    }
  });

  it("a transfer hook pool, its hook revoked at completion", async () => {
    for (const params of [{ ...baseParams(), token_type: 1 }, customizable({ ...baseParams(), token_type: 1, locked_vesting: lockedVesting }, 0, 1, 100)]) {
      const pi = await g.pool(params, quoteSpl, TOKEN, { hook: true });
      await graduate(pi, "transfer hook pool");
      expect(await g.surplus(pi, "creator")).toBe("ok");
    }
  });

  /** Rewrite an account's bytes in both VMs. */
  function patch(at: Address, f: (d: Buffer) => void, owner?: Address) {
    for (const vm of g.p.vms()) {
      const a = vm.getAccount(at);
      if (!a.exists) throw new Error("no account");
      const d = Buffer.from(a.data);
      f(d);
      vm.setAccount({ ...a, data: new Uint8Array(d), ...(owner ? { programAddress: owner } : {}) });
    }
  }
  /** A copy of DAMM v2's config for `option` at a new address, rewritten by `f`, owned by `owner` (DAMM v2). */
  async function dammConfigCopy(option: number, f: (d: Buffer) => void, owner: Address = DAMM_V2) {
    const a = g.p.original.getAccount(DAMM_CONFIGS[option]!);
    if (!a.exists) throw new Error("no config");
    const d = Buffer.from(a.data);
    f(d);
    const at = (await generateKeyPairSigner()).address;
    for (const vm of g.p.vms()) vm.setAccount({ ...a, address: at, data: new Uint8Array(d), programAddress: owner, space: BigInt(d.length) });
    return at;
  }

  it("states and DAMM v2 configs written into the accounts: progress, completion, legacy configs, each config check", async () => {
    // PoolState: quote_reserve @240, migration_progress @308; PoolConfig: migration_option @233, version @236
    const pi = await g.pool(baseParams(), quoteSpl, TOKEN);
    expect(await g.buy(pi, 10_000_000_000n)).toBe("ok");
    patch(pi.pool, (d) => (d[308] = 2));
    expect((await g.migrate(pi)).outcome).toBe(custom(E.PoolIsIncompleted));
    patch(pi.pool, (d) => (d[308] = 9));
    expect((await g.migrate(pi)).outcome).toBe(custom(E.TypeCastFailed));
    expect(await g.locker(pi)).toBe(custom(E.TypeCastFailed));
    expect(await g.leftover(pi, true)).toBe(custom(E.TypeCastFailed));
    patch(pi.pool, (d) => (d[308] = 0));
    await g.complete(pi);
    expect(g.p.original.getAccount(pi.config).exists && Buffer.from((g.p.original.getAccount(pi.config) as { data: Uint8Array }).data)[236]).toBe(1);
    patch(pi.config, (d) => (d[233] = 0));
    expect((await g.migrate(pi)).outcome).toBe(custom(E.InvalidMigrationOption));
    patch(pi.config, (d) => (d[233] = 5));
    expect((await g.migrate(pi)).outcome).toBe(custom(E.InvalidMigrationOption));
    patch(pi.config, (d) => (d[233] = 1));
    // DAMM v2 config checks, in order: base fee mode, fee, schedule, prices, vault config, activation type, creator authority
    const cases: [string, number, (d: Buffer) => void, string][] = [
      ["a rate limiter base fee", 0, (d) => (d[80] = 2), custom(E.InvalidConfigAccount)],
      ["a base fee mode past the enum", 0, (d) => (d[80] = 9), custom(E.TypeCastFailed)],
      ["a period frequency", 0, (d) => d.writeBigUInt64LE(1n, 88), custom(E.InvalidConfigAccount)],
      ["a reduction factor", 0, (d) => d.writeBigUInt64LE(1n, 96), custom(E.InvalidConfigAccount)],
      ["periods", 0, (d) => d.writeUInt16LE(1, 86), custom(E.InvalidConfigAccount)],
      ["another fee", 0, (d) => d.writeBigUInt64LE(2_600_000n, 72), custom(E.InvalidMigrationFeeOption)],
      ["a fee past u64 in bps", 0, (d) => d.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 72), custom(E.InvalidMigrationFeeOption)],
      ["another minimum price", 0, (d) => (d[216] = 1), custom(E.InvalidConfigAccount)],
      ["another maximum price", 0, (d) => (d[232] = 1), custom(E.InvalidConfigAccount)],
      ["a vault config", 0, (d) => (d[8] = 1), custom(E.InvalidConfigAccount)],
      ["slot activation", 0, (d) => (d[200] = 0), custom(E.InvalidConfigAccount)],
      ["an activation type past the enum", 0, (d) => (d[200] = 2), custom(E.TypeCastFailed)],
      ["another creator authority", 0, (d) => (d[40] ^= 1), custom(E.InvalidConfigAccount)],
      ["another discriminator", 0, (d) => (d[0] ^= 1), custom(A.AccountDiscriminatorMismatch)],
      ["an exponential scheduler at the option's fee", 0, (d) => (d[80] = 1), "ok"],
    ];
    expect((await g.migrate(pi, { dammConfig: await dammConfigCopy(0, () => {}, TOKEN) })).outcome).toBe(custom(A.AccountOwnedByWrongProgram));
    for (const [label, option, f, want] of cases)
      expect((await g.migrate(pi, { dammConfig: await dammConfigCopy(option, f), label })).outcome, label).toBe(want);
    // a legacy config (version 0) takes the original path
    const legacy = await g.pool({ ...baseParams(), migration_fee_option: 2 }, quoteSpl, TOKEN);
    await g.complete(legacy);
    patch(legacy.config, (d) => (d[236] = 0));
    expect((await g.migrate(legacy)).outcome).toBe("ok");
  });

  it("a quote mint with a transfer fee (badged), with and without a base fee; legacy configs on the original path", async () => {
    const quoteFee = await mint(g.p, TOKEN_2022, 9, [{ kind: "transferFee", bps: 150, max: 10n ** 12n, authority: true }]);
    const quoteAuthority = await mint(g.p, TOKEN_2022, 9, [{ kind: "transferFee", bps: 0, max: 0n, authority: true }]);
    for (const [label, q, fee] of [
      ["quote fee, Token-2022 base without a fee", quoteFee, null],
      ["quote fee and base fee", quoteFee, transferFee(200, 0, 2)],
      ["a quote fee config authority only", quoteAuthority, null],
    ] as const) {
      const pi = await g.pool(constantSupply(baseParams()), q, TOKEN_2022, { fee, badge: true });
      await g.complete(pi);
      expect(await g.surplus(pi, "creator"), label).toBe("ok");
      expect((await g.migrate(pi, { label })).outcome, label).toBe("ok");
      expect(await g.leftover(pi, true), `${label}: leftover`).toBe("ok");
    }
    // legacy configs (version 0): a quote fee is refused, a base fee goes the original path
    const legacyQuote = await g.pool(constantSupply(baseParams()), quoteFee, TOKEN_2022, { fee: null, badge: true });
    await g.complete(legacyQuote);
    patch(legacyQuote.config, (d) => (d[236] = 0));
    expect((await g.migrate(legacyQuote)).outcome).toBe(custom(E.QuoteMintHasNonZeroTransferFee));
    const legacyBase = await g.pool(constantSupply(baseParams()), quoteSpl, TOKEN, { fee: transferFee(100, 0, 1) });
    await g.complete(legacyBase);
    patch(legacyBase.config, (d) => (d[236] = 0));
    expect((await g.migrate(legacyBase, { label: "legacy, base transfer fee" })).outcome).toBe("ok");
  });

  it("migration_damm_v2_create_metadata takes any accounts", async () => {
    const pi = await g.pool(baseParams(), quoteSpl, TOKEN);
    expect(await g.metadata(pi)).toBe("ok");
  });
});
