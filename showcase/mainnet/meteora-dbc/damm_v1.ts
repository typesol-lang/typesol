// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), licensed under Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// What the DAMM v1 migration (instructions/migration/meteora_damm/) reads of DAMM v1 (the dynamic AMM): its Config,
// which migrate_meteora_damm takes as Account<dynamic_amm::accounts::Config>, and its LockEscrow, which
// migrate_meteora_damm_lock_lp_token takes as Account<LockEscrow> (layouts from DBC's `idls/dynamic_amm.json`, which
// its `declare_program!` builds them from), and validate_config_key of migrate_meteora_damm_initialize_pool.rs.
import { type AccountInfo, type Pubkey, type u8, type u64, pubkey, readData, require, u128 } from "typesol";
import { DEFAULT_PUBKEY } from "./config";
import { PoolError } from "./errors";
import { toBps } from "./fees";
import { POOL_AUTHORITY } from "./process_swap";
import { MIGRATION_FEE_OPTION_CUSTOMIZABLE } from "./state";

export const DAMM_V1_PROGRAM_ID = pubkey("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");

/** sha256("account:Config")[..8] of DAMM v1's Config, as a little-endian u64. */
export const DISC_DAMM_V1_CONFIG: u64 = 9425183130704809115n;
/**
 * DAMM v1's Config is Borsh, 8 + 332 bytes: pool_fees (trade_fee_numerator @8, trade_fee_denominator @16,
 * protocol_trade_fee_numerator @24, protocol_trade_fee_denominator @32), activation_duration @40, vault_config_key @48,
 * pool_creator_authority @80, activation_type @112, partner_fee_numerator @113, padding (219 bytes). It is read at
 * those offsets, after Anchor's Account::try_from checks (in meteora_dbc.ts).
 */
export const DAMM_V1_CONFIG_SIZE: u64 = 340n;

/**
 * DAMM v1's LockEscrow (Borsh, 8 + 145 bytes).
 * @layout borsh
 * @discriminator account:LockEscrow
 */
export interface DammV1LockEscrow {
  pool: Pubkey;
  owner: Pubkey;
  escrow_vault: Pubkey;
  bump: u8;
  total_locked_amount: u64;
  lp_per_token: u128;
  unclaimed_fee_pending: u64;
  a_fee: u64;
  b_fee: u64;
}

/** MigrateMeteoraDammCtx::validate_config_key: the DAMM v1 config's fee is the config's option's, made for DBC's pools. */
export function validateDammV1Config(cfg: AccountInfo, migrationFeeOption: u8): void {
  const tradeFeeNumerator = readData<u64>(cfg, 8n);
  const tradeFeeDenominator = readData<u64>(cfg, 16n);
  // MigrationFeeOption::try_from
  require(migrationFeeOption <= MIGRATION_FEE_OPTION_CUSTOMIZABLE, PoolError.InvalidMigrationFeeOption);
  const baseFeeBps = toBps(u128(tradeFeeNumerator), u128(tradeFeeDenominator));
  // MigrationFeeOption::validate_base_fee (Customizable: nothing to check)
  if (migrationFeeOption !== MIGRATION_FEE_OPTION_CUSTOMIZABLE) {
    const want: u64 =
      migrationFeeOption === 0n ? 25n : migrationFeeOption === 1n ? 30n : migrationFeeOption === 2n ? 100n : migrationFeeOption === 3n ? 200n : migrationFeeOption === 4n ? 400n : 600n;
    require(baseFeeBps === want, PoolError.InvalidMigrationFeeOption);
  }
  require(readData<Pubkey>(cfg, 80n) === POOL_AUTHORITY, PoolError.InvalidConfigAccount);
  require(readData<u64>(cfg, 40n) === 0n, PoolError.InvalidConfigAccount);
  require(readData<u64>(cfg, 113n) === 0n, PoolError.InvalidConfigAccount);
  require(readData<Pubkey>(cfg, 48n) === DEFAULT_PUBKEY, PoolError.InvalidConfigAccount);
}
