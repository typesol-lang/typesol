// A test fixture for showcase/test/meteora-dbc*.test.ts (which are subject to Meteora's Non-commercial Licence, see
// showcase/mainnet/meteora-dbc/LICENSE.md): a Token-2022 transfer hook loaded into both VMs. Its ExtraAccountMetaList
// (["extra-account-metas", mint]) is written by the tests, so any list, valid or not, can be tried. Token-2022 calls
// `execute` on every transfer of a base mint whose TransferHook extension points here, with the extra accounts the list
// resolves to after the four standard ones (and the list itself, when it exists): the hook refuses a transfer of
// exactly 13 units and logs how many accounts it got.
import { type AccountInfo, type Mint, type TokenAccount, type u64, isTransferring, log, remainingAccounts, require } from "typesol";

/** @discriminator spl-transfer-hook-interface:execute */
export function execute(source: TokenAccount, mint: Mint, destination: TokenAccount, owner: AccountInfo, amount: u64): void {
  require(isTransferring(source), "the hook runs only inside a transfer");
  require(amount !== 13n, "the hook refuses 13");
  log(`hook: ${amount} with ${remainingAccounts().length} more accounts`);
}
