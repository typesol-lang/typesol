// Typed CPIs from a native program (test/integrations/native-cpi.test.ts): one @fallback entry, every account a
// remaining account, every program `programAt<P>(…)`, as a port of SPL Stake Pool takes them. The tags from 20 on are
// the same calls hand-encoded with invoke, to compare compute units.
import {
  ProgramError,
  type RemainingAccount,
  type StakeProgram,
  type SystemProgram,
  type TokenInterface,
  type StakeHistorySysvar,
  type u64,
  i64,
  instructionData,
  invoke,
  log,
  programAt,
  readonly,
  readonlySigner,
  remainingAccounts,
  require,
  returnData,
  sysvarAt,
  u32,
  u8,
  writable,
  writableSigner,
} from "typesol";

/** A helper taking the Stake program as a type: a programAt value passes as one. */
function deactivateWith(stake: StakeProgram, account: RemainingAccount, clock: RemainingAccount, authority: RemainingAccount, bump: u8): void {
  stake.deactivate(account, clock, authority, ["authority", bump]);
}

/** A helper taking the StakeHistory sysvar: effective, activating and deactivating stake of `epoch`, packed. */
function historyOf(history: StakeHistorySysvar, epoch: u64): u64 {
  return history.effective(epoch) * 1_000_000n + history.activating(epoch) * 1000n + history.deactivating(epoch);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const rest = remainingAccounts();
  if (tag === 0n) {
    // initialize(stake, rent) with the staker and withdrawer from the data, no lockup.
    const stake = programAt<StakeProgram>(rest.get(2n));
    stake.initialize(rest.get(0n), rest.get(1n), data.readPubkey(1n), data.readPubkey(33n));
  } else if (tag === 1n) {
    // The same with a lockup: unix timestamp and epoch (u64s at 65 and 73), custodian at 81.
    const stake = programAt<StakeProgram>(rest.get(2n));
    stake.initialize(rest.get(0n), rest.get(1n), data.readPubkey(1n), data.readPubkey(33n), {
      unixTimestamp: i64(data.readU64(65n)),
      epoch: data.readU64(73n),
      custodian: data.readPubkey(81n),
    });
  } else if (tag === 2n) {
    // delegate(stake, vote, clock, history, config, PDA authority)
    const stake = programAt<StakeProgram>(rest.get(6n));
    stake.delegate(rest.get(0n), rest.get(1n), rest.get(2n), rest.get(3n), rest.get(4n), rest.get(5n), ["authority", data.readU8(1n)]);
  } else if (tag === 3n) {
    // split(stake, split, PDA authority, lamports at 2)
    const stake = programAt<StakeProgram>(rest.get(3n));
    stake.split(rest.get(0n), rest.get(1n), rest.get(2n), data.readU64(2n), ["authority", data.readU8(1n)]);
  } else if (tag === 4n) {
    // merge(destination, source, clock, history, PDA authority)
    const stake = programAt<StakeProgram>(rest.get(5n));
    stake.merge(rest.get(0n), rest.get(1n), rest.get(2n), rest.get(3n), rest.get(4n), ["authority", data.readU8(1n)]);
  } else if (tag === 5n) {
    // deactivate(stake, clock, PDA authority)
    const stake = programAt<StakeProgram>(rest.get(3n));
    stake.deactivate(rest.get(0n), rest.get(1n), rest.get(2n), ["authority", data.readU8(1n)]);
  } else if (tag === 6n) {
    // withdraw(stake, to, clock, history, PDA authority, lamports at 2)
    const stake = programAt<StakeProgram>(rest.get(5n));
    stake.withdraw(rest.get(0n), rest.get(1n), rest.get(2n), rest.get(3n), rest.get(4n), data.readU64(2n), ["authority", data.readU8(1n)]);
  } else if (tag === 7n) {
    // authorize(stake, clock, PDA authority, new authority at 3, staker (0) or withdrawer (1) at 2)
    const stake = programAt<StakeProgram>(rest.get(3n));
    const bump = data.readU8(1n);
    if (data.readU8(2n) === 0n) stake.authorize(rest.get(0n), rest.get(1n), rest.get(2n), data.readPubkey(3n), "staker", ["authority", bump]);
    else stake.authorize(rest.get(0n), rest.get(1n), rest.get(2n), data.readPubkey(3n), "withdrawer", ["authority", bump]);
  } else if (tag === 8n) {
    // The minimum delegation, logged.
    log(programAt<StakeProgram>(rest.get(0n)).getMinimumDelegation());
  } else if (tag === 9n) {
    // withdraw with the lockup custodian (a signing wallet) during the lockup.
    const stake = programAt<StakeProgram>(rest.get(6n));
    stake.withdraw(rest.get(0n), rest.get(1n), rest.get(2n), rest.get(3n), rest.get(4n), data.readU64(2n), rest.get(5n), ["authority", data.readU8(1n)]);
  } else if (tag === 10n) {
    // authorize a new withdrawer with the lockup custodian signing.
    const stake = programAt<StakeProgram>(rest.get(4n));
    stake.authorize(rest.get(0n), rest.get(1n), rest.get(2n), data.readPubkey(2n), "withdrawer", rest.get(3n), ["authority", data.readU8(1n)]);
  } else if (tag === 11n) {
    // deactivate through a helper that takes StakeProgram.
    deactivateWith(programAt<StakeProgram>(rest.get(3n)), rest.get(0n), rest.get(1n), rest.get(2n), data.readU8(1n));
  } else if (tag === 12n) {
    // The StakeHistory sysvar as a remaining account: count, newest epoch and one epoch's entry, logged.
    const history = sysvarAt<StakeHistorySysvar>(rest.get(0n));
    log(history.count);
    log(history.latestEpoch);
    log(historyOf(history, data.readU64(1n)));
    log(history.has(data.readU64(1n)) ? 1n : 0n);
  } else if (tag === 13n) {
    // A wallet authority (it signed the transaction): no signerSeeds.
    const stake = programAt<StakeProgram>(rest.get(3n));
    stake.deactivate(rest.get(0n), rest.get(1n), rest.get(2n));
  } else if (tag === 30n) {
    // mintTo(mint, to, PDA mint authority, amount at 2)
    const token = programAt<TokenInterface>(rest.get(3n));
    token.mintTo(rest.get(0n), rest.get(1n), rest.get(2n), data.readU64(2n), ["authority", data.readU8(1n)]);
  } else if (tag === 31n) {
    // burn(from, mint, owner wallet, amount at 1)
    const token = programAt<TokenInterface>(rest.get(3n));
    token.burn(rest.get(0n), rest.get(1n), rest.get(2n), data.readU64(1n));
  } else if (tag === 32n) {
    // transferChecked(from, mint, to, owner wallet, amount at 1): the decimals are the mint's.
    const token = programAt<TokenInterface>(rest.get(4n));
    token.transferChecked(rest.get(0n), rest.get(1n), rest.get(2n), rest.get(3n), data.readU64(1n));
  } else if (tag === 33n) {
    // system transfer(from wallet, to, lamports at 1)
    const system = programAt<SystemProgram>(rest.get(2n));
    system.transfer(rest.get(0n), rest.get(1n), data.readU64(1n));
  } else if (tag === 34n) {
    // system createAccount(payer, new account, lamports at 1, space at 9, owner at 17)
    const system = programAt<SystemProgram>(rest.get(2n));
    system.createAccount(rest.get(0n), rest.get(1n), data.readU64(1n), data.readU64(9n), data.readPubkey(17n));
  } else if (tag === 35n) {
    // system allocate + assign of the PDA ["vault", bump] to the owner at 2: the stake pool's create_stake_account.
    const system = programAt<SystemProgram>(rest.get(1n));
    const bump = data.readU8(1n);
    system.allocate(rest.get(0n), 200n, ["vault", bump]);
    system.assign(rest.get(0n), data.readPubkey(2n), ["vault", bump]);
  } else if (tag === 20n) {
    // Raw: split
    invoke(rest.get(3n), [writable(rest.get(0n)), writable(rest.get(1n)), readonlySigner(rest.get(2n))], [u32(3n), data.readU64(2n)], [
      "authority",
      data.readU8(1n),
    ]);
  } else if (tag === 21n) {
    // Raw: delegate
    invoke(
      rest.get(6n),
      [writable(rest.get(0n)), readonly(rest.get(1n)), readonly(rest.get(2n)), readonly(rest.get(3n)), readonly(rest.get(4n)), readonlySigner(rest.get(5n))],
      [u32(2n)],
      ["authority", data.readU8(1n)],
    );
  } else if (tag === 22n) {
    // Raw: GetMinimumDelegation and its return data
    const program = rest.get(0n);
    invoke(program, [], [u32(13n)]);
    log(returnData<u64>(program));
  } else if (tag === 23n) {
    // Raw: deactivate
    invoke(rest.get(3n), [writable(rest.get(0n)), readonly(rest.get(1n)), readonlySigner(rest.get(2n))], [u32(5n)], ["authority", data.readU8(1n)]);
  } else if (tag === 24n) {
    // Raw: system transfer
    invoke(rest.get(2n), [writableSigner(rest.get(0n)), writable(rest.get(1n))], [u32(2n), data.readU64(1n)]);
  } else if (tag === 25n) {
    // Raw: token mintTo
    invoke(rest.get(3n), [writable(rest.get(0n)), writable(rest.get(1n)), readonlySigner(rest.get(2n))], [u8(7n), data.readU64(2n)], [
      "authority",
      data.readU8(1n),
    ]);
  } else {
    require(false, ProgramError.InvalidInstructionData);
  }
}
