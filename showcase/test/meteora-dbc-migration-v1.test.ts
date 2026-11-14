// The DAMM v1 migration of showcase/mainnet/meteora-dbc (a port subject to Meteora's Non-commercial Licence, see that
// directory's LICENSE.md) against Meteora's Dynamic Bonding Curve 0.2.2 on mainnet, side by side
// (meteora-dbc-helpers.ts, meteora-dbc-graduation.ts, meteora-dbc-graduation-v1.ts):
// migration_meteora_damm_create_metadata, migrate_meteora_damm, migrate_meteora_damm_lock_lp_token and
// migrate_meteora_damm_claim_lp_token. Both programs call DAMM v1 and the dynamic vault as deployed on mainnet, on
// DAMM v1's six migration configs read from mainnet. Configs are made for DAMM v2 and their migration option is then
// rewritten to DAMM v1 in both ledgers (create_config refuses DAMM v1 since 0.2.1; older configs hold it). Every
// transaction must give the same outcome and error code, the same bytes of every account it touches (the DAMM v1
// pool, its LP mint and LP metadata, the vaults, their token accounts and LP mints, the pool's vault LP accounts,
// the protocol fee accounts, the lock escrows and their LP accounts, the LP accounts of the pool authority, partner
// and creator, the migration metadata), the same inner instructions and the same events.
import { type Address, type KeyPairSigner, generateKeyPairSigner, lamports } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { present } from "../../test/binaries.js";
import { type Graduation, type PoolInfo, DAMM_CONFIGS, DAMM_SO, LOCKER_SO, MPL_SO, POOL_AUTHORITY, graduation } from "./meteora-dbc-graduation.js";
import {
  type V1,
  type V1Migrated,
  CONFIG_MIGRATION_FEE_OPTION,
  CONFIG_MIGRATION_OPTION,
  DAMM_V1,
  DAMM_V1_CONFIGS,
  DAMM_V1_SO,
  VAULT_SO,
  WSOL,
  graduationV1,
  tokenAmount,
  v1Metadata,
} from "./meteora-dbc-graduation-v1.js";
import { type Params, type Vesting, ORIGINAL, PROGRAM, TOKEN, TOKEN_2022, baseParams, custom, mint, noVesting } from "./meteora-dbc-helpers.js";

const E = {
  MathOverflow: 6000,
  TypeCastFailed: 6006,
  InvalidMigrationFeeOption: 6010,
  PoolIsIncompleted: 6014,
  InvalidMigrationOption: 6015,
  NotPermitToDoThisAction: 6022,
  InvalidOwnerAccount: 6023,
  InvalidConfigAccount: 6024,
  LeftoverHasBeenWithdraw: 6026,
  InvalidAccount: 6038,
  UndeterminedError: 6045,
} as const;
const A = {
  InvalidProgramId: 3008,
  ConstraintHasOne: 2001,
  ConstraintSeeds: 2006,
  ConstraintAssociated: 2009,
  ConstraintAddress: 2012,
  ConstraintTokenOwner: 2015,
  ConstraintDuplicateMutableAccount: 2040,
  AccountDiscriminatorNotFound: 3001,
  AccountDiscriminatorMismatch: 3002,
  AccountDidNotDeserialize: 3003,
  AccountOwnedByWrongProgram: 3007,
  AccountNotInitialized: 3012,
} as const;
/** The System Program's AccountAlreadyInUse (an `init` of an account that exists). */
const ALREADY_IN_USE = custom(0);

const vesting = (percentage: number): Vesting => ({
  vesting_percentage: percentage,
  bps_per_period: 100,
  number_of_periods: 50,
  cliff_duration_from_migration_time: 86400,
  frequency: 3600,
});
const lockedVesting = {
  amount_per_period: 1_000_000_000n,
  cliff_duration_from_migration_time: 3600n,
  frequency: 60n,
  number_of_period: 10n,
  cliff_unlock_amount: 5_000_000_000n,
};
const split = (pl: number, pp: number, cl: number, cp: number, pv = noVesting(), cv = noVesting()): Params => ({
  ...baseParams(),
  partner_liquidity_percentage: pl,
  partner_permanent_locked_liquidity_percentage: pp,
  creator_liquidity_percentage: cl,
  creator_permanent_locked_liquidity_percentage: cp,
  partner_liquidity_vesting_info: pv,
  creator_liquidity_vesting_info: cv,
});

describe.skipIf(!present(ORIGINAL, MPL_SO, DAMM_SO, LOCKER_SO, DAMM_V1_SO, VAULT_SO))(
  "showcase/mainnet/meteora-dbc DAMM v1 migration against Meteora DBC 0.2.2 on mainnet",
  () => {
    let g: Graduation;
    let v: V1;
    let quoteSpl: Address;
    beforeAll(async () => {
      g = await graduation();
      v = graduationV1(g);
      quoteSpl = await mint(g.p, TOKEN, 9);
    }, 300_000);
    afterAll(() => {
      if (!g) return;
      console.log(
        `meteora-dbc DAMM v1 migration: ${g.p.stats.compared} transactions compared, ${g.p.stats.innerCompared} inner instructions; outcomes ${JSON.stringify(g.p.stats.byOutcome)}`,
      );
    });

    /** A pool through the curve (and the locker when the config vests), its metadata, its DAMM v1 migration. */
    async function graduate(pi: PoolInfo, label: string, dammConfig?: Address) {
      await g.complete(pi);
      if (pi.params.locked_vesting.frequency > 0n) expect(await g.locker(pi), `${label}: locker`).toBe("ok");
      expect(await v.metadata(pi), `${label}: metadata`).toBe("ok");
      const r = await v.migrate(pi, { label, dammConfig });
      expect(r.outcome, label).toBe("ok");
      return r.m;
    }

    /** transfer_pool_creator with the migration metadata (or `rest`) as its remaining accounts. */
    async function transferCreator(pi: PoolInfo, rest: Address[]) {
      const to = (await generateKeyPairSigner()).address;
      const ix = g.p.ix("transfer_pool_creator", {}, [
        { address: pi.pool, writable: true },
        { address: pi.config },
        { address: pi.creator.address, signer: pi.creator },
        { address: to },
        { address: g.p.eventAuthority },
        { address: PROGRAM },
        ...rest.map((address) => ({ address })),
      ]);
      return g.p.both("transfer_pool_creator", pi.creator, [ix], [pi.pool]);
    }

    /**
     * Lock and claim both sides' LP in `order` (p = partner, c = creator; L = lock, C = claim), each twice: the second
     * is refused, and a side with nothing to lock or claim is refused the first time.
     */
    async function settle(pi: PoolInfo, m: V1Migrated, order: string[], label: string) {
      const md = v1Metadata(v, m)!;
      for (const step of order) {
        const owner = step[0] === "p" ? pi.partner.address : pi.creator.address;
        const amount = step[1] === "L" ? (step[0] === "p" ? md.partnerLocked : md.creatorLocked) : step[0] === "p" ? md.partner : md.creator;
        const send = () => (step[1] === "L" ? v.lock(pi, m, owner) : v.claim(pi, m, owner));
        expect(await send(), `${label}: ${step}`).toBe(amount > 0n ? "ok" : custom(E.NotPermitToDoThisAction));
        expect(await send(), `${label}: ${step} again`).toBe(custom(E.NotPermitToDoThisAction));
      }
    }

    it("every migration progress: what each instruction refuses before and after completion, then the whole graduation", async () => {
      const params: Params = {
        ...split(20, 30, 25, 25),
        creator_trading_fee_percentage: 30,
        migration_fee: { fee_percentage: 10, creator_fee_percentage: 40 },
        locked_vesting: lockedVesting,
      };
      const pi = await v.pool(params, quoteSpl, TOKEN);
      const other = await v.pool(params, quoteSpl, TOKEN);
      const stranger = await g.p.funded();
      // no metadata yet: the migration's AccountLoader of an account never created (3007)
      expect((await v.migrate(pi)).outcome).toBe(custom(A.AccountOwnedByWrongProgram));
      // PreBondingCurve: the metadata can be made at any time, once
      expect(await v.metadata(pi, { config: other.config })).toBe(custom(A.ConstraintHasOne));
      expect(await v.metadata(pi, { pool: pi.config })).toBe(custom(A.AccountDiscriminatorMismatch));
      expect(await v.metadata(pi, { config: pi.pool })).toBe(custom(A.AccountDiscriminatorMismatch));
      expect(await v.metadata(pi, { seed: other.pool })).toBe(custom(A.ConstraintSeeds));
      expect(await v.metadata(pi)).toBe("ok");
      expect(await v.metadata(pi)).toBe(ALREADY_IN_USE);
      expect((await v.migrate(pi)).outcome).toBe(custom(E.NotPermitToDoThisAction));
      expect(await g.buy(pi, 20_000_000_000n)).toBe("ok");
      expect((await v.migrate(pi)).outcome).toBe(custom(E.NotPermitToDoThisAction));
      // PostBondingCurve (the config vests): the migration waits for the locker
      await g.complete(pi);
      expect((await v.migrate(pi)).outcome).toBe(custom(E.NotPermitToDoThisAction));
      expect(await g.surplus(pi, "partner")).toBe("ok");
      expect(await g.migrationFee(pi, 0, pi.partner)).toBe("ok");
      expect(await g.locker(pi)).toBe("ok");
      // LockedVesting: the creator's withdrawals still open
      expect(await g.surplus(pi, "creator")).toBe("ok");
      // migration refusals, one account at a time
      // (the other pool's metadata made at PostBondingCurve)
      await g.complete(other);
      expect(await v.metadata(other)).toBe("ok");
      expect(await g.locker(other)).toBe("ok");
      const otherAccounts = await v.accounts(other);
      expect((await v.migrate(pi, { over: { metadata: otherAccounts.migrationMetadata } })).outcome).toBe(custom(A.ConstraintHasOne));
      expect((await v.migrate(pi, { over: { config: other.config } })).outcome).toBe(custom(A.ConstraintHasOne));
      expect((await v.migrate(pi, { over: { quoteVault: other.quoteVault } })).outcome).toBe(custom(A.ConstraintHasOne));
      expect((await v.migrate(pi, { over: { baseVault: other.baseVault } })).outcome).toBe(custom(A.ConstraintHasOne));
      expect((await v.migrate(pi, { over: { baseVault: pi.quoteVault } })).outcome).toBe(custom(A.ConstraintDuplicateMutableAccount));
      expect((await v.migrate(pi, { over: { pool: pi.config } })).outcome).toBe(custom(A.AccountDiscriminatorMismatch));
      expect((await v.migrate(pi, { over: { config: pi.pool } })).outcome).toBe(custom(A.AccountDiscriminatorMismatch));
      expect((await v.migrate(pi, { over: { poolAuthority: stranger.address } })).outcome).toBe(custom(A.ConstraintAddress));
      expect((await v.migrate(pi, { over: { amm: PROGRAM } })).outcome).toBe(custom(A.ConstraintAddress));
      expect((await v.migrate(pi, { over: { tokenProgram: TOKEN_2022 } })).outcome).toBe(custom(A.InvalidProgramId));
      expect((await v.migrate(pi, { dammConfig: DAMM_V1_CONFIGS[1]! })).outcome).toBe(custom(E.InvalidMigrationFeeOption));
      expect((await v.migrate(pi, { dammConfig: DAMM_CONFIGS[0]! })).outcome).toBe(custom(A.AccountOwnedByWrongProgram));
      expect((await v.migrate(pi, { dammConfig: pi.config })).outcome).toBe(custom(A.AccountOwnedByWrongProgram));
      expect((await v.migrate(pi, { dammConfig: (await generateKeyPairSigner()).address })).outcome).toBe(custom(A.AccountNotInitialized));
      const m = (await v.migrate(pi, { label: "the migration" })).m;
      expect(v1Metadata(v, m)?.partner).toBeGreaterThan(0n);
      // CreatedPool: no second migration, the leftover only for a fixed supply
      expect((await v.migrate(pi)).outcome).toBe(custom(E.NotPermitToDoThisAction));
      expect(await g.locker(pi)).toBe(custom(E.NotPermitToDoThisAction));
      expect(await g.leftover(pi, true)).toBe(custom(E.NotPermitToDoThisAction));
      expect(await g.migrationFee(pi, 1, pi.creator)).toBe("ok");
      // the creator role cannot move while LP is unclaimed or unlocked (transfer_pool_creator reads the metadata)
      expect(await transferCreator(pi, [])).toBe(custom(E.InvalidAccount));
      expect(await transferCreator(pi, [otherAccounts.migrationMetadata])).toBe(custom(E.InvalidAccount));
      expect(await transferCreator(pi, [m.migrationMetadata])).toBe(custom(E.NotPermitToDoThisAction));

      // lock and claim refusals, one account at a time
      const otherMigrated = (await v.migrate(other, { label: "the other migration" })).m;
      const partner = pi.partner.address;
      const creator = pi.creator.address;
      const partnerEscrow = await v.lockEscrow(m, partner);
      const creatorEscrow = await v.lockEscrow(m, creator);
      const strangerEscrow = await v.lockEscrow(m, stranger.address);
      const otherEscrow = await v.lockEscrow(otherMigrated, partner);
      const neverMade = (await generateKeyPairSigner()).address;
      expect(await v.lock(pi, m, stranger.address)).toBe(custom(E.InvalidOwnerAccount));
      expect(await v.lock(pi, m, partner, { lockEscrow: creatorEscrow.lockEscrow, escrowVault: creatorEscrow.escrowVault })).toBe(custom(A.ConstraintHasOne));
      expect(await v.lock(pi, m, partner, { lockEscrow: otherEscrow.lockEscrow, escrowVault: otherEscrow.escrowVault })).toBe(custom(A.ConstraintHasOne));
      expect(await v.lock(pi, m, partner, { lockEscrow: neverMade })).toBe(custom(A.AccountNotInitialized));
      expect(await v.lock(pi, m, partner, { lockEscrow: m.dammPool })).toBe(custom(A.AccountDiscriminatorMismatch));
      expect(await v.lock(pi, m, partner, { lockEscrow: pi.pool })).toBe(custom(A.AccountOwnedByWrongProgram));
      expect(await v.lock(pi, m, partner, { metadata: otherMigrated.migrationMetadata })).toBe(custom(A.ConstraintHasOne));
      expect(await v.lock(pi, m, partner, { lpMint: otherMigrated.lpMint })).toBe(custom(A.ConstraintHasOne));
      expect(await v.lock(pi, m, partner, { pool: other.pool })).toBe(custom(A.ConstraintHasOne));
      expect(await v.lock(pi, m, partner, { source: await g.account(partner, m.lpMint, TOKEN) })).toBe(custom(A.ConstraintTokenOwner));
      expect(await v.lock(pi, m, partner, { poolAuthority: stranger.address })).toBe(custom(A.ConstraintAddress));
      expect(await v.lock(pi, m, partner, { amm: PROGRAM })).toBe(custom(A.ConstraintAddress));
      expect(await v.claim(pi, m, stranger.address)).toBe(custom(E.InvalidOwnerAccount));
      expect(await v.claim(pi, m, partner, { destination: await g.account(stranger.address, m.lpMint, TOKEN) })).toBe(custom(A.ConstraintTokenOwner));
      expect(await v.claim(pi, m, partner, { destination: await g.account(partner, quoteSpl, TOKEN) })).toBe(custom(A.ConstraintAssociated));
      expect(await v.claim(pi, m, partner, { source: await g.account(stranger.address, m.lpMint, TOKEN) })).toBe(custom(A.ConstraintTokenOwner));
      // the partner's own LP account as the source too: two Account<TokenAccount> that are one account
      expect(await v.claim(pi, m, partner, { source: await g.account(partner, m.lpMint, TOKEN) })).toBe(custom(A.ConstraintDuplicateMutableAccount));
      expect(await v.claim(pi, m, partner, { source: await g.account(POOL_AUTHORITY, quoteSpl, TOKEN) })).toBe(custom(A.ConstraintAssociated));
      expect(await v.claim(pi, m, partner, { metadata: otherMigrated.migrationMetadata })).toBe(custom(A.ConstraintHasOne));
      expect(await v.claim(pi, m, partner, { lpMint: otherMigrated.lpMint })).toBe(custom(A.ConstraintHasOne));
      expect(await v.claim(pi, m, partner, { pool: other.pool })).toBe(custom(A.ConstraintHasOne));
      expect(await v.claim(pi, m, partner, { poolAuthority: stranger.address })).toBe(custom(A.ConstraintAddress));
      // a DAMM v1 account of another type, shorter than a Config, as the DAMM v1 config
      expect((await v.migrate(other, { dammConfig: strangerEscrow.lockEscrow, label: "a lock escrow as the config" })).outcome).toBe(
        custom(A.AccountDiscriminatorMismatch),
      );
      void partnerEscrow;
      // lock and claim at the other progress values (written into the pool)
      for (const [progress, want] of [
        [0, custom(E.NotPermitToDoThisAction)],
        [1, custom(E.NotPermitToDoThisAction)],
        [2, custom(E.NotPermitToDoThisAction)],
        [4, custom(E.TypeCastFailed)],
      ] as const) {
        v.patch(pi.pool, (d) => (d[308] = progress));
        expect(await v.lock(pi, m, partner), `lock at progress ${progress}`).toBe(want);
        expect(await v.claim(pi, m, partner), `claim at progress ${progress}`).toBe(want);
        v.patch(pi.pool, (d) => (d[308] = 3));
      }
      // either side, in an order, each once
      await settle(pi, m, ["cC", "pL", "cL", "pC"], "all four");
      expect(tokenAmount(v, m.poolLp)).toBe(0n);
      // now the creator role can move
      expect(await transferCreator(pi, [m.migrationMetadata])).toBe("ok");
    });

    it("each fixed fee option (0.25% to 6%) on its DAMM v1 config, and the customizable option on any", async () => {
      for (let option = 0; option < 6; option++) {
        const pi = await v.pool({ ...baseParams(), migration_fee_option: option }, quoteSpl, TOKEN);
        await g.complete(pi);
        expect(await v.metadata(pi)).toBe("ok");
        // the next option's config: a base fee the option refuses
        expect((await v.migrate(pi, { dammConfig: DAMM_V1_CONFIGS[(option + 1) % 6]! })).outcome).toBe(custom(E.InvalidMigrationFeeOption));
        expect((await v.migrate(pi, { label: `option ${option}` })).outcome).toBe("ok");
      }
      // Customizable (6): validate_base_fee checks nothing, so any of DBC's DAMM v1 configs
      for (const cfg of [DAMM_V1_CONFIGS[0]!, DAMM_V1_CONFIGS[5]!]) {
        const pi = await v.pool(
          { ...baseParams(), migration_fee_option: 6, migrated_pool_fee: { collect_fee_mode: 0, dynamic_fee: 0, pool_fee_bps: 100 } },
          quoteSpl,
          TOKEN,
        );
        await graduate(pi, `customizable on ${cfg}`, cfg);
      }
    });

    /** Rewrite an account's bytes at a new address (owned by `owner`) in both VMs. */
    async function copy(at: Address, f: (d: Buffer) => void, owner: Address = DAMM_V1, length?: number) {
      const a = g.p.original.getAccount(at);
      if (!a.exists) throw new Error("no account");
      const d = Buffer.from(a.data).subarray(0, length);
      f(d);
      const to = (await generateKeyPairSigner()).address;
      for (const vm of g.p.vms()) vm.setAccount({ ...a, address: to, data: new Uint8Array(d), programAddress: owner, space: BigInt(d.length) });
      return to;
    }

    it("DAMM v1 configs and states written into the accounts: each config check, progress, completion, the option", async () => {
      const pi = await v.pool(baseParams(), quoteSpl, TOKEN);
      expect(await v.metadata(pi)).toBe("ok");
      expect(await g.buy(pi, 10_000_000_000n)).toBe("ok");
      // PoolState: migration_progress @308; PoolConfig: migration_option @233, migration_fee_option @243,
      // migration_base_threshold @272
      v.patch(pi.pool, (d) => (d[308] = 2));
      expect((await v.migrate(pi)).outcome).toBe(custom(E.PoolIsIncompleted));
      v.patch(pi.pool, (d) => (d[308] = 9));
      expect((await v.migrate(pi)).outcome).toBe(custom(E.TypeCastFailed));
      v.patch(pi.pool, (d) => (d[308] = 0));
      await g.complete(pi);
      for (const [label, f, want] of [
        ["DAMM v2", (d: Buffer) => (d[CONFIG_MIGRATION_OPTION] = 1), custom(E.InvalidMigrationOption)],
        ["an option past the enum", (d: Buffer) => (d[CONFIG_MIGRATION_OPTION] = 5), custom(E.InvalidMigrationOption)],
        ["a fee option past the enum", (d: Buffer) => (d[CONFIG_MIGRATION_FEE_OPTION] = 7), custom(E.InvalidMigrationFeeOption)],
        ["a base threshold above the base", (d: Buffer) => d.writeBigUInt64LE(1n << 62n, 272), custom(E.UndeterminedError)],
      ] as const) {
        const before = Buffer.from((g.p.original.getAccount(pi.config) as { data: Uint8Array }).data);
        v.patch(pi.config, f);
        expect((await v.migrate(pi)).outcome, label).toBe(want);
        v.patch(pi.config, (d) => before.copy(d));
      }
      // the metadata of a pool whose config is not DAMM v1's
      const v2 = await g.pool(baseParams(), quoteSpl, TOKEN);
      expect(await v.metadata(v2)).toBe(custom(E.InvalidMigrationOption));
      v.patch(v2.config, (d) => (d[CONFIG_MIGRATION_OPTION] = 5));
      expect(await v.metadata(v2)).toBe(custom(E.InvalidMigrationOption));
      // DAMM v1 config checks, in order: owner, discriminator, the fee option's fee, the creator authority, the
      // activation duration, the partner fee, the vault config
      const base = DAMM_V1_CONFIGS[0]!;
      const cases: [string, (d: Buffer) => void, Address, string][] = [
        ["another owner", () => {}, TOKEN, custom(A.AccountOwnedByWrongProgram)],
        ["another discriminator", (d) => (d[0] ^= 1), DAMM_V1, custom(A.AccountDiscriminatorMismatch)],
        ["another fee", (d) => d.writeBigUInt64LE(300n, 8), DAMM_V1, custom(E.InvalidMigrationFeeOption)],
        ["a zero fee denominator", (d) => d.writeBigUInt64LE(0n, 16), DAMM_V1, custom(E.MathOverflow)],
        ["a fee past u64 in bps", (d) => (d.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 8), d.writeBigUInt64LE(1n, 16)), DAMM_V1, custom(E.TypeCastFailed)],
        ["another creator authority", (d) => (d[80] ^= 1), DAMM_V1, custom(E.InvalidConfigAccount)],
        ["a public config", (d) => d.fill(0, 80, 112), DAMM_V1, custom(E.InvalidConfigAccount)],
        ["an activation duration", (d) => d.writeBigUInt64LE(1n, 40), DAMM_V1, custom(E.InvalidConfigAccount)],
        ["a partner fee", (d) => d.writeBigUInt64LE(1n, 113), DAMM_V1, custom(E.InvalidConfigAccount)],
        ["a vault config", (d) => (d[48] = 1), DAMM_V1, custom(E.InvalidConfigAccount)],
      ];
      for (const [label, f, owner, want] of cases) expect((await v.migrate(pi, { dammConfig: await copy(base, f, owner), label })).outcome, label).toBe(want);
      // shorter than a discriminator (3001), or than a Config (Borsh: 3003)
      expect((await v.migrate(pi, { dammConfig: await copy(base, () => {}, DAMM_V1, 4) })).outcome).toBe(custom(A.AccountDiscriminatorNotFound));
      expect((await v.migrate(pi, { dammConfig: await copy(base, () => {}, DAMM_V1, 120) })).outcome).toBe(custom(A.AccountDidNotDeserialize));
      expect((await v.migrate(pi, { label: "after the refusals" })).outcome).toBe("ok");
    });

    it("partner and creator LP: unlocked and locked, locked and claimed in any order, a self-partnered creator", async () => {
      // [partner unlocked, partner locked, creator unlocked, creator locked]: create_config wants some liquidity locked
      // now, so a split with none is written into a config made with another (as configs before 0.2.1 could hold it)
      const cases: [string, number[], string[], boolean][] = [
        ["partner unlocked and locked, creator locked", [20, 30, 0, 50], ["pL", "cL", "pC", "cC"], false],
        ["creator first", [10, 10, 40, 40], ["cL", "cC", "pC", "pL"], false],
        ["all locked by the partner", [0, 100, 0, 0], ["pC", "cC", "cL", "pL"], false],
        ["all unlocked by the creator", [0, 0, 100, 0], ["cL", "pL", "pC", "cC"], false],
        ["claims first, odd percentages", [33, 17, 29, 21], ["pC", "cC", "pL", "cL"], false],
        ["a self-partnered creator", [20, 30, 25, 25], [], true],
        ["a self-partnered creator, nothing unlocked", [0, 60, 0, 40], [], true],
        ["a self-partnered creator, nothing locked", [60, 0, 40, 0], [], true],
      ];
      for (const [label, [pl, pp, cl, cp], order, self] of cases) {
        const pi = await v.pool(split(25, 25, 25, 25), quoteSpl, TOKEN, { selfPartnered: self });
        // PoolConfig: partner_permanent_locked @239, partner_liquidity @240, creator_permanent_locked @241, creator_liquidity @242
        v.patch(pi.config, (d) => d.set([pp!, pl!, cp!, cl!], 239));
        const m = await graduate(pi, label);
        const md = v1Metadata(v, m)!;
        expect(md.partner + md.partnerLocked + md.creator + md.creatorLocked, label).toBe(tokenAmount(v, m.poolLp));
        if (!self) {
          await settle(pi, m, order, label);
          continue;
        }
        // one owner: both sides' LP at once, then nothing
        const owner = pi.creator.address;
        const lockable = md.partnerLocked + md.creatorLocked;
        const claimable = md.partner + md.creator;
        expect(await v.claim(pi, m, owner), `${label}: claim`).toBe(claimable > 0n ? "ok" : custom(E.NotPermitToDoThisAction));
        expect(await v.claim(pi, m, owner), `${label}: claim again`).toBe(custom(E.NotPermitToDoThisAction));
        expect(await v.lock(pi, m, owner), `${label}: lock`).toBe(lockable > 0n ? "ok" : custom(E.NotPermitToDoThisAction));
        expect(await v.lock(pi, m, owner), `${label}: lock again`).toBe(custom(E.NotPermitToDoThisAction));
        expect(tokenAmount(v, m.poolLp)).toBe(0n);
      }
      // a creator who is the partner, after one side was settled as the other's (status written into the metadata)
      const pi = await v.pool(split(20, 30, 25, 25), quoteSpl, TOKEN, { selfPartnered: true });
      const m = await graduate(pi, "self-partnered, a side settled");
      v.patch(m.migrationMetadata, (d) => (d[170] = 1));
      expect(await v.lock(pi, m, pi.creator.address)).toBe(custom(E.NotPermitToDoThisAction));
      v.patch(m.migrationMetadata, (d) => (d[172] = 1));
      expect(await v.claim(pi, m, pi.creator.address)).toBe(custom(E.NotPermitToDoThisAction));
      // vested shares (a config made for DAMM v2 with vesting): DAMM v1 has no vesting, so that LP stays with the
      // pool authority
      const vested = await v.pool(split(20, 10, 20, 10, vesting(25), vesting(15)), quoteSpl, TOKEN);
      const mv = await graduate(vested, "vested shares");
      await settle(vested, mv, ["pL", "pC", "cL", "cC"], "vested shares");
      expect(tokenAmount(v, mv.poolLp)).toBeGreaterThan(0n);
    });

    it("token programs, wrapped SOL in its mainnet vault, a fixed supply: the burn, the leftover", async () => {
      const b = baseParams();
      // Token-2022 on either side: DAMM v1's path takes SPL Token accounts only (3007)
      const quote2022 = await mint(g.p, TOKEN_2022, 6, [{ kind: "metadataPointer" }]);
      for (const [label, params, quote, quoteProgram] of [
        ["a Token-2022 base", { ...b, token_type: 1 }, quoteSpl, TOKEN],
        ["a Token-2022 quote", b, quote2022, TOKEN_2022],
      ] as const) {
        const pi = await v.pool(params, quote, quoteProgram);
        await g.complete(pi);
        expect(await v.metadata(pi), label).toBe("ok");
        expect((await v.migrate(pi, { makeVaults: false, label })).outcome, label).toBe(custom(A.AccountOwnedByWrongProgram));
      }
      // a transfer hook pool is a TransferHookPool, not a VirtualPool, to Anchor's AccountLoader
      const hooked = await v.pool({ ...b, token_type: 1 }, quoteSpl, TOKEN, { hook: true });
      expect(await v.metadata(hooked)).toBe(custom(A.AccountDiscriminatorMismatch));
      // wrapped SOL: the vault DAMM v1 deposits into is the mainnet one
      const sol = await v.pool({ ...split(30, 20, 30, 20), migration_fee_option: 2 }, WSOL, TOKEN);
      const ms = await graduate(sol, "wrapped SOL");
      await settle(sol, ms, ["pL", "cC", "cL", "pC"], "wrapped SOL");
      // the base mint's dynamic vault not made yet: DAMM v1's own account check refuses it (AccountNotInitialized)
      const unmade = await v.pool(b, quoteSpl, TOKEN);
      await g.complete(unmade);
      expect(await v.metadata(unmade)).toBe("ok");
      await v.vault(quoteSpl);
      const r = await v.migrate(unmade, { makeVaults: false, label: "no base vault" });
      expect(r.outcome).toBe(custom(A.AccountNotInitialized));
      expect((await v.migrate(unmade, { label: "base vault made" })).outcome).toBe("ok");
      // a fixed supply above what migrates: the rest burns, up to the supply the config lets go, then the leftover
      for (const [pre, post] of [
        [10n ** 17n, 10n ** 17n],
        [10n ** 17n, 9n * 10n ** 16n],
        [10n ** 17n, 6n * 10n ** 16n],
      ] as const) {
        const pi = await v.pool({ ...b, token_supply: { pre_migration_token_supply: pre, post_migration_token_supply: post } }, quoteSpl, TOKEN);
        await graduate(pi, `fixed supply ${pre} / ${post}`);
        expect(await g.leftover(pi, false)).toBe("ok");
        expect(await g.leftover(pi, false)).toBe(custom(E.LeftoverHasBeenWithdraw));
      }
    });

    it("a payer without the rent to repay: the flash rent's transfer fails", async () => {
      const pi = await v.pool(baseParams(), quoteSpl, TOKEN);
      await g.complete(pi);
      expect(await v.metadata(pi)).toBe("ok");
      const poor: KeyPairSigner = await generateKeyPairSigner();
      for (const vm of g.p.vms()) vm.airdrop(poor.address, lamports(10_000_000n));
      // the System Program's transfer back to the pool authority: InsufficientFunds (1)
      expect((await v.migrate(pi, { payer: poor, label: "a poor payer" })).outcome).toBe(custom(1));
    });
  },
);
