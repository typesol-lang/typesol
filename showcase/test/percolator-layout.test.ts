// The slab layout as Percolator v12.20's mainnet binary lays it out (u128 / i128 aligned to 8 on SBF), read from
// slabs the binary itself initialises and changes, not from the Rust source: percolator-helpers.ts takes its offsets
// from here, and so does the port's state.ts (the same numbers, checked by the differential tests byte for byte).
import { type Address, generateKeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { describe, expect, it } from "vitest";
import { acct, pda, send } from "../../test/harness.js";
import {
  A,
  ACCOUNT_LEN,
  C,
  CONFIG_LEN,
  E,
  ENGINE_OFF,
  FEED,
  GEN_TABLE_OFF,
  H,
  HAVE_ORIGINAL,
  MAGIC,
  MAX_ACCOUNTS,
  P,
  PROGRAM,
  PYTH_RECEIVER,
  RISK_BUF_OFF,
  SLAB_LEN,
  SOL,
  TOKEN,
  UNIX_TIMESTAMP,
  accountAt,
  computeUnits,
  defaultInitArgs,
  ix,
  key,
  meta,
  mintBytes,
  originalVm,
  pythBytes,
  readI128,
  readU128,
  tokenAccountBytes,
} from "./percolator-helpers.js";

function put(vm: LiteSVM, at: Address, owner: Address, data: Buffer): void {
  vm.setAccount({
    address: at,
    data: new Uint8Array(data),
    executable: false,
    lamports: lamports(vm.minimumBalanceForRentExemption(BigInt(data.length))),
    programAddress: owner,
    space: BigInt(data.length),
  });
}

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20 slab layout (mainnet binary)", () => {
  it("SLAB_LEN: the binary logs the length it wants", async () => {
    const vm = originalVm();
    const admin = await generateKeyPairSigner();
    vm.airdrop(admin.address, lamports(10n * SOL));
    const slab = (await generateKeyPairSigner()).address;
    put(vm, slab, PROGRAM, Buffer.alloc(1000));
    const mint = (await generateKeyPairSigner()).address;
    put(vm, mint, TOKEN, mintBytes());
    const m = { slab, admin, mint, vault: mint, vaultPda: mint, bump: 0, oracle: mint, feedId: FEED };
    const res = await send(vm, admin, [ix.initMarket(m, defaultInitArgs(admin.address, mint))]);
    expect(res).toBeInstanceOf(FailedTransactionMetadata);
    // slab_guard: sol_log_64(SLAB_LEN, data.len(), 0, 0, 0), then InvalidSlabLen.
    expect(meta(res).logs()).toContain(`Program log: 0x${SLAB_LEN.toString(16)}, 0x${(1000).toString(16)}, 0x0, 0x0, 0x0`);
  });

  it("header, config, engine, accounts, risk buffer and generation table", async () => {
    const vm = originalVm();
    const admin = await generateKeyPairSigner();
    vm.airdrop(admin.address, lamports(100n * SOL));
    const slab = (await generateKeyPairSigner()).address;
    put(vm, slab, PROGRAM, Buffer.alloc(SLAB_LEN));
    const mint = (await generateKeyPairSigner()).address;
    put(vm, mint, TOKEN, mintBytes());
    const [vaultPda, bump] = await pda(PROGRAM, ["vault", slab]);
    const vault = (await generateKeyPairSigner()).address;
    put(vm, vault, TOKEN, tokenAccountBytes({ mint, owner: vaultPda }));
    const oracle = (await generateKeyPairSigner()).address;
    put(vm, oracle, PYTH_RECEIVER, pythBytes({ feedId: FEED, price: 123_456_789n, expo: -6, publishTime: UNIX_TIMESTAMP - 5n }));
    const m = { slab, admin, mint, vault, vaultPda, bump, oracle, feedId: FEED };
    const args = defaultInitArgs(admin.address, mint);
    // Distinct values, so that every field is found where the table says.
    Object.assign(args, {
      maxStalenessSecs: 3601n,
      confFilterBps: 501,
      maintenanceFeePerSlot: 7n,
      minOraclePriceCapE2bps: 11n,
      hMin: 2n,
      hMax: 13n,
      maintenanceMarginBps: 501n,
      initialMarginBps: 1001n,
      tradingFeeBps: 3n,
      maxAccounts: 4000n,
      newAccountFee: 17n,
      maxCrankStalenessSlots: 999n,
      liquidationFeeBps: 51n,
      liquidationFeeCap: (1n << 80n) + 5n,
      resolvePriceDeviationBps: 101n,
      minLiquidationAbs: 9n,
      minNonzeroMmReq: 1_000_000_001n,
      minNonzeroImReq: 2_000_000_003n,
    });
    args.tail = {
      insuranceWithdrawMaxBps: 33,
      insuranceWithdrawCooldownSlots: 44n,
      permissionlessResolveStaleSlots: 5001n,
      fundingHorizonSlots: 501n,
      fundingKBps: 102n,
      fundingMaxPremiumBps: 503n,
      fundingMaxE9PerSlot: 1004n,
      markMinFee: 55n,
      forceCloseDelaySlots: 66n,
    };
    const res = await send(vm, admin, [computeUnits(1_400_000), ix.initMarket(m, args)]);
    expect(res, meta(res).logs().join("\n")).not.toBeInstanceOf(FailedTransactionMetadata);
    const d = Buffer.from(acct(vm, slab).data);
    expect(d.length).toBe(SLAB_LEN);
    expect(CONFIG_LEN).toBe(400);
    expect(ENGINE_OFF).toBe(536);
    // Header.
    expect(d.readBigUInt64LE(H.magic)).toBe(MAGIC);
    expect(d[H.bump]).toBe(bump);
    expect(d[H.flags]).toBe(8); // FLAG_ORACLE_INITIALIZED
    expect(Buffer.from(d.subarray(H.admin, H.admin + 32))).toEqual(Buffer.from(d.subarray(H.insuranceAuthority, H.insuranceAuthority + 32)));
    // Config.
    expect(d.readBigUInt64LE(C.maxStalenessSecs)).toBe(3601n);
    expect(d.readUInt16LE(C.confFilterBps)).toBe(501);
    expect(d[C.vaultAuthorityBump]).toBe(bump);
    expect(d.readBigUInt64LE(C.fundingHorizonSlots)).toBe(501n);
    expect(d.readBigUInt64LE(C.fundingKBps)).toBe(102n);
    expect(d.readBigInt64LE(C.fundingMaxPremiumBps)).toBe(503n);
    expect(d.readBigInt64LE(C.fundingMaxE9PerSlot)).toBe(1004n);
    expect(d.readBigInt64LE(C.lastOraclePublishTime)).toBe(UNIX_TIMESTAMP - 5n);
    expect(d.readBigUInt64LE(C.oraclePriceCapE2bps)).toBe(11n);
    expect(d.readBigUInt64LE(C.lastEffectivePriceE6)).toBe(123_456_789n);
    expect(d.readBigUInt64LE(C.minOraclePriceCapE2bps)).toBe(11n);
    expect(d.readUInt16LE(C.insuranceWithdrawMaxBps)).toBe(33);
    expect(d.readBigUInt64LE(C.insuranceWithdrawCooldownSlots)).toBe(44n);
    expect(d.readBigUInt64LE(C.markEwmaHalflifeSlots)).toBe(100n);
    expect(d.readBigUInt64LE(C.permissionlessResolveStaleSlots)).toBe(5001n);
    expect(readU128(d, C.maintenanceFeePerSlot)).toBe(7n);
    expect(d.readBigUInt64LE(C.markMinFee)).toBe(55n);
    expect(d.readBigUInt64LE(C.forceCloseDelaySlots)).toBe(66n);
    expect(readU128(d, C.newAccountFee)).toBe(17n);
    // Engine params.
    const p = E.params;
    expect(d.readBigUInt64LE(p + P.maintenanceMarginBps)).toBe(501n);
    expect(d.readBigUInt64LE(p + P.initialMarginBps)).toBe(1001n);
    expect(d.readBigUInt64LE(p + P.tradingFeeBps)).toBe(3n);
    expect(d.readBigUInt64LE(p + P.maxAccounts)).toBe(4000n);
    expect(d.readBigUInt64LE(p + P.maxCrankStalenessSlots)).toBe(999n);
    expect(d.readBigUInt64LE(p + P.liquidationFeeBps)).toBe(51n);
    expect(readU128(d, p + P.liquidationFeeCap)).toBe((1n << 80n) + 5n);
    expect(readU128(d, p + P.minLiquidationAbs)).toBe(9n);
    expect(readU128(d, p + P.minNonzeroMmReq)).toBe(1_000_000_001n);
    expect(readU128(d, p + P.minNonzeroImReq)).toBe(2_000_000_003n);
    expect(d.readBigUInt64LE(p + P.hMin)).toBe(2n);
    expect(d.readBigUInt64LE(p + P.hMax)).toBe(13n);
    expect(d.readBigUInt64LE(p + P.resolvePriceDeviationBps)).toBe(101n);
    expect(d.readBigUInt64LE(p + P.maxAccrualDtSlots)).toBe(10_000_000n);
    expect(d.readBigUInt64LE(p + P.maxAbsFundingE9PerSlot)).toBe(10_000n);
    expect(d.readBigUInt64LE(p + P.minFundingLifetimeSlots)).toBe(10_000_000n);
    expect(d.readBigUInt64LE(p + P.maxActivePositionsPerSide)).toBe(4000n);
    // Engine state.
    expect(d.readBigUInt64LE(E.currentSlot)).toBe(d.readBigUInt64LE(E.lastMarketSlot));
    expect(d.readBigUInt64LE(E.lastCrankSlot)).toBe(d.readBigUInt64LE(E.currentSlot));
    expect(readU128(d, E.adlMultLong)).toBe(10n ** 15n);
    expect(readU128(d, E.adlMultShort)).toBe(10n ** 15n);
    expect(d.readBigUInt64LE(E.lastOraclePrice)).toBe(123_456_789n);
    expect(d.readBigUInt64LE(E.fundPxLast)).toBe(123_456_789n);
    expect(d.readUInt16LE(E.numUsedAccounts)).toBe(0);
    expect(d.readUInt16LE(E.freeHead)).toBe(0);
    expect(d.readUInt16LE(E.nextFree)).toBe(1);
    expect(d.readUInt16LE(E.nextFree + 2 * (MAX_ACCOUNTS - 1))).toBe(0xffff);
    expect(d.readUInt16LE(E.prevFree)).toBe(0xffff);
    expect(d.readUInt16LE(E.prevFree + 2 * (MAX_ACCOUNTS - 1))).toBe(MAX_ACCOUNTS - 2);
    for (const i of [0, 1, MAX_ACCOUNTS - 1]) expect(readU128(d, accountAt(i) + A.adlABasis)).toBe(10n ** 15n);
    expect(accountAt(MAX_ACCOUNTS)).toBe(RISK_BUF_OFF);

    // A user: its account's fields where the table says, and the generation table.
    const user = await generateKeyPairSigner();
    vm.airdrop(user.address, lamports(10n * SOL));
    const ata = (await generateKeyPairSigner()).address;
    put(vm, ata, TOKEN, tokenAccountBytes({ mint, owner: user.address, amount: 1000n }));
    const r1 = await send(vm, user, [ix.initUser(m, { key: user, ata }, 500n)]);
    expect(r1, meta(r1).logs().join("\n")).not.toBeInstanceOf(FailedTransactionMetadata);
    const d1 = Buffer.from(acct(vm, slab).data);
    expect(readU128(d1, accountAt(0) + A.capital)).toBe(500n - 17n);
    expect(Buffer.from(d1.subarray(accountAt(0) + A.owner, accountAt(0) + A.owner + 32))).toEqual(key(user.address));
    expect(d1.readBigUInt64LE(accountAt(0) + A.lastFeeSlot)).toBe(d.readBigUInt64LE(E.currentSlot));
    expect(readU128(d1, E.cTot)).toBe(483n);
    expect(readU128(d1, E.insurance)).toBe(17n);
    expect(readU128(d1, E.vault)).toBe(500n);
    expect(d1.readBigUInt64LE(E.used)).toBe(1n);
    expect(d1.readUInt16LE(E.numUsedAccounts)).toBe(1);
    expect(d1.readUInt16LE(E.freeHead)).toBe(1);
    expect(d1.readBigUInt64LE(E.materializedAccountCount)).toBe(1n);
    expect(d1.readBigUInt64LE(H.matCounter)).toBe(1n);
    expect(d1.readBigUInt64LE(GEN_TABLE_OFF)).toBe(1n);
    expect(readI128(d1, accountAt(0) + A.feeCredits)).toBe(0n);
    expect(ACCOUNT_LEN).toBe(360);
  });
});
