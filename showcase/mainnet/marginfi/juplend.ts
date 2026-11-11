// A port of marginfi v2 (mrgnlabs/marginfi-v2 @ c5d440f6), Copyright mrgnlabs, licensed under the Apache License, Version 2.0.
// Marginfi's JupLend integration (programs/marginfi/src/instructions/juplend and programs/juplend-mocks of
// mrgnlabs/marginfi-v2 @ c5d440f6): JupLend's Lending account as juplend-mocks declares it (zero-copy, packed), whose
// discriminator is Anchor's for an account named Lending.
import type { Pubkey, u16, u64, u8 } from "typesol";

/**
 * @repr c packed
 * @serialization bytemuck
 */
export interface Lending {
  mint: Pubkey;
  f_token_mint: Pubkey;
  lending_id: u16;
  decimals: u8;
  rewards_rate_model: Pubkey;
  liquidity_exchange_price: u64;
  token_exchange_price: u64;
  last_update_timestamp: u64;
  token_reserves_liquidity: Pubkey;
  supply_position_on_liquidity: Pubkey;
  bump: u8;
}
