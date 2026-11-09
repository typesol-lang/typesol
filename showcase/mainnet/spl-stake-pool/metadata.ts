// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// The pool token's Metaplex metadata (processor.rs process_create_pool_token_metadata,
// process_update_pool_token_metadata; inline_mpl_token_metadata.rs): CreateTokenMetadata (17) and
// UpdateTokenMetadata (18). Each decodes its own arguments from instructionData() (three Borsh Strings; anything else
// is BorshIoError) and then logs its "Instruction: …" line, as the entrypoint does before calling the processor.
// NOT PORTED YET: these panic until a later part ports them (also on data the original refuses with BorshIoError).
import { type RemainingAccounts, panic } from "typesol";

/** Tag 17: CreateTokenMetadata { name, symbol, uri }. */
export function createTokenMetadata(rest: RemainingAccounts): void {
  panic("not ported yet");
}

/** Tag 18: UpdateTokenMetadata { name, symbol, uri }. */
export function updateTokenMetadata(rest: RemainingAccounts): void {
  panic("not ported yet");
}
