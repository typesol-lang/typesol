// The differential harness for showcase/mainnet/percolator against Percolator v12.20 as deployed on mainnet
// (test/programs/percolator_v12.so, program BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw, built from
// aeyakovenko/percolator-prog 06f86fb and aeyakovenko/percolator 3f55f87, Apache-2.0; fetched by
// scripts/fetch-programs.sh, not kept in the repository). The original and the port run in two LiteSVMs under the same
// program id and the same Clock. Every account is made the same way in both VMs (the same keypairs, the same bytes),
// so addresses and bytes agree; `both()` then sends one transaction to each and requires:
//
// - the same outcome (the same error and code on a failure);
// - the same log lines, all but the runtime's compute-unit lines ("consumed N of M compute units");
// - the same inner instructions, in order: each one's stack height, program, accounts and data bytes;
// - the same return data;
// - the same lamports, owner and data in every account the transaction names, the fee payer and any others asked for
//   (the 1.5 MB slab compared byte for byte).
//
// The instruction builders follow the account lists of the original's own LiteSVM tests (tests/common/mod.rs) and the
// wire layout of `Instruction::decode` (src/percolator.rs `mod ix`), for all 27 tags. The slab offsets below were
// read from slabs the mainnet binary itself initialised (percolator-layout.test.ts checks them against it).
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { Clock, FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { build } from "../../src/compiler/index.js";
import { present } from "../../test/binaries.js";
import { deployFile, pda, send } from "../../test/harness.js";

export const PROGRAM = address("BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw");
export const ORIGINAL = fileURLToPath(new URL("../../test/programs/percolator_v12.so", import.meta.url));
export const PORT = fileURLToPath(new URL("../mainnet/percolator/percolator.ts", import.meta.url));
/** Tests skip when the mainnet binary has not been fetched (scripts/fetch-programs.sh), or fail under CI_REQUIRE_ALL. */
export const HAVE_ORIGINAL = present(ORIGINAL);
export const SYSTEM = address("11111111111111111111111111111111");
export const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const CLOCK = address("SysvarC1ock11111111111111111111111111111111");
export const RENT = address("SysvarRent111111111111111111111111111111111");
/** The Pyth Solana Receiver, owner of PriceUpdateV2 accounts. */
export const PYTH_RECEIVER = address("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/** Chainlink's OCR2 store program, the other oracle owner the program accepts. */
export const CHAINLINK = address("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
export const SOL = 1_000_000_000n;

/**
 * The matcher TradeCpi calls: aeyakovenko/percolator-match 199b139 ported to TypeSOL (showcase/mainnet/percolator/
 * matcher). No build of it is deployed for v12.20, so the same TypeSOL matcher runs beside the original and the port.
 */
export const MATCHER = address("8ZkPArZsFAcB4gVSPNv8TxYyJPLMAFb8Bi44DVxQWuoD");
export const MATCHER_SRC = fileURLToPath(new URL("../mainnet/percolator/matcher/matcher.ts", import.meta.url));
export const MATCHER_CTX_LEN = 320;
/**
 * A matcher that answers what its context account says (showcase/test/fixtures/percolator-rogue-matcher.ts): the
 * answers the real matcher never gives, for TradeCpi's refusals of them, and a reentrant call.
 */
export const ROGUE = address("8ZkPArZsFAcB4gRv44PwpcbktceGuo8QmWuEXaBskJWQ");
export const ROGUE_SRC = fileURLToPath(new URL("./fixtures/percolator-rogue-matcher.ts", import.meta.url));
const built = new Map<string, Uint8Array>();
/** A TypeSOL program's binary, built once per test process. */
export function fixtureBinary(src: string, id: Address): Uint8Array {
  let so = built.get(src);
  if (!so) {
    const out = mkdtempSync(path.join(os.tmpdir(), "typesol-percolator-fixture-"));
    so = new Uint8Array(readFileSync(build(src, out, id, {}).soPath));
    rmSync(out, { recursive: true, force: true });
    built.set(src, so);
  }
  return so;
}

/** The Clock both VMs start with. */
export const SLOT = 300_000_000n;
export const UNIX_TIMESTAMP = 1_770_000_000n;

// ---- The slab (as the SBF binary lays it out: u128 / i128 aligned to 8) ---------------------------------------------

export const MAX_ACCOUNTS = 4096;
export const HEADER_LEN = 136;
export const CONFIG_LEN = 400;
export const ENGINE_OFF = HEADER_LEN + CONFIG_LEN; // 536
export const ACCOUNT_LEN = 360;
export const ENGINE_LEN = 1_492_160;
export const RISK_BUF_OFF = ENGINE_OFF + ENGINE_LEN; // 1_492_696
export const RISK_BUF_LEN = 160;
export const GEN_TABLE_OFF = RISK_BUF_OFF + RISK_BUF_LEN; // 1_492_856
export const SLAB_LEN = GEN_TABLE_OFF + MAX_ACCOUNTS * 8; // 1_525_624
export const MAGIC = 0x504552434f4c4154n;

/** SlabHeader field offsets (from the slab's start). */
export const H = { magic: 0, version: 8, bump: 12, flags: 13, admin: 16, nonce: 48, matCounter: 56, insuranceAuthority: 72, insuranceOperator: 104 } as const;

/** MarketConfig field offsets (from the slab's start: HEADER_LEN + the field's offset in the struct). */
export const C = Object.fromEntries(
  Object.entries({
    collateralMint: 0,
    vault: 32,
    indexFeedId: 64,
    maxStalenessSecs: 96,
    confFilterBps: 104,
    vaultAuthorityBump: 106,
    invert: 107,
    unitScale: 108,
    fundingHorizonSlots: 112,
    fundingKBps: 120,
    fundingMaxPremiumBps: 128,
    fundingMaxE9PerSlot: 136,
    hyperpAuthority: 144,
    hyperpMarkE6: 176,
    lastOraclePublishTime: 184,
    oraclePriceCapE2bps: 192,
    lastEffectivePriceE6: 200,
    minOraclePriceCapE2bps: 208,
    insuranceWithdrawMaxBps: 216,
    tvlInsuranceCapMult: 218,
    insuranceWithdrawCooldownSlots: 224,
    lastHyperpIndexSlot: 248,
    lastMarkPushSlot: 256,
    lastInsuranceWithdrawSlot: 272,
    markEwmaE6: 288,
    markEwmaLastSlot: 296,
    markEwmaHalflifeSlots: 304,
    initRestartSlot: 312,
    permissionlessResolveStaleSlots: 320,
    lastGoodOracleSlot: 328,
    maintenanceFeePerSlot: 336,
    feeSweepCursorWord: 352,
    feeSweepCursorBit: 360,
    markMinFee: 368,
    forceCloseDelaySlots: 376,
    newAccountFee: 384,
  }).map(([k, v]) => [k, HEADER_LEN + v]),
) as Record<string, number>;

/** RiskEngine field offsets (from the slab's start). */
export const E = Object.fromEntries(
  Object.entries({
    vault: 0,
    insurance: 16,
    params: 32,
    currentSlot: 200,
    marketMode: 208,
    resolvedPrice: 216,
    resolvedSlot: 224,
    resolvedPayoutHNum: 232,
    resolvedPayoutHDen: 248,
    resolvedPayoutReady: 264,
    resolvedKLongTerminalDelta: 272,
    resolvedKShortTerminalDelta: 288,
    resolvedLivePrice: 304,
    lastCrankSlot: 312,
    cTot: 320,
    pnlPosTot: 336,
    pnlMaturedPosTot: 352,
    gcCursor: 368,
    adlMultLong: 376,
    adlMultShort: 392,
    adlCoeffLong: 408,
    adlCoeffShort: 424,
    adlEpochLong: 440,
    adlEpochShort: 448,
    adlEpochStartKLong: 456,
    adlEpochStartKShort: 472,
    oiEffLongQ: 488,
    oiEffShortQ: 504,
    sideModeLong: 520,
    sideModeShort: 521,
    storedPosCountLong: 528,
    storedPosCountShort: 536,
    staleAccountCountLong: 544,
    staleAccountCountShort: 552,
    phantomDustBoundLongQ: 560,
    phantomDustBoundShortQ: 576,
    materializedAccountCount: 592,
    negPnlAccountCount: 600,
    lastOraclePrice: 608,
    fundPxLast: 616,
    lastMarketSlot: 624,
    fLongNum: 632,
    fShortNum: 648,
    fEpochStartLongNum: 664,
    fEpochStartShortNum: 680,
    used: 696,
    numUsedAccounts: 1208,
    freeHead: 1210,
    nextFree: 1212,
    prevFree: 9404,
    accounts: 17600,
  }).map(([k, v]) => [k, ENGINE_OFF + v]),
) as Record<string, number>;

/** RiskParams field offsets within the params block. */
export const P = {
  maintenanceMarginBps: 0,
  initialMarginBps: 8,
  tradingFeeBps: 16,
  maxAccounts: 24,
  maxCrankStalenessSlots: 32,
  liquidationFeeBps: 40,
  liquidationFeeCap: 48,
  minLiquidationAbs: 64,
  minNonzeroMmReq: 80,
  minNonzeroImReq: 96,
  hMin: 112,
  hMax: 120,
  resolvePriceDeviationBps: 128,
  maxAccrualDtSlots: 136,
  maxAbsFundingE9PerSlot: 144,
  minFundingLifetimeSlots: 152,
  maxActivePositionsPerSide: 160,
} as const;

/** Account field offsets within one 360-byte account. */
export const A = {
  capital: 0,
  kind: 16,
  pnl: 24,
  reservedPnl: 40,
  positionBasisQ: 56,
  adlABasis: 72,
  adlKSnap: 88,
  fSnap: 104,
  adlEpochSnap: 120,
  matcherProgram: 128,
  matcherContext: 160,
  owner: 192,
  feeCredits: 224,
  lastFeeSlot: 240,
  schedPresent: 248,
  schedRemainingQ: 256,
  schedAnchorQ: 272,
  schedStartSlot: 288,
  schedHorizon: 296,
  schedReleaseQ: 304,
  pendingPresent: 320,
  pendingRemainingQ: 328,
  pendingHorizon: 344,
  pendingCreatedSlot: 352,
} as const;
export const accountAt = (idx: number) => E.accounts + idx * ACCOUNT_LEN;

/** PercolatorError codes by name (Custom(n), in declaration order). */
export const PE = Object.fromEntries(
  [
    "InvalidMagic",
    "InvalidVersion",
    "AlreadyInitialized",
    "NotInitialized",
    "InvalidSlabLen",
    "InvalidOracleKey",
    "OracleStale",
    "OracleConfTooWide",
    "InvalidVaultAta",
    "InvalidMint",
    "ExpectedSigner",
    "ExpectedWritable",
    "OracleInvalid",
    "EngineInsufficientBalance",
    "EngineUndercollateralized",
    "EngineUnauthorized",
    "EngineInvalidMatchingEngine",
    "EnginePnlNotWarmedUp",
    "EngineOverflow",
    "EngineAccountNotFound",
    "EngineNotAnLPAccount",
    "EnginePositionSizeMismatch",
    "EngineRiskReductionOnlyMode",
    "EngineAccountKindMismatch",
    "InvalidTokenAccount",
    "InvalidTokenProgram",
    "InvalidConfigParam",
    "HyperpTradeNoCpiDisabled",
    "EngineCorruptState",
    "CatchupRequired",
    "DepositCapExceeded",
    "InsuranceWithdrawCooldown",
    "InsuranceWithdrawCapExceeded",
  ].map((n, i) => [n, i]),
) as Record<string, number>;

export type Result = TransactionMetadata | FailedTransactionMetadata;
export type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

// ---- Bytes ---------------------------------------------------------------------------------------------------------

const enc = getAddressEncoder();
export const key = (a: string) => Buffer.from(enc.encode(address(a)));
export const u8 = (n: number | bigint) => Buffer.from([Number(n)]);
export const u16 = (n: number | bigint) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(Number(n));
  return b;
};
export const u32 = (n: number | bigint) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n));
  return b;
};
export const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(n)));
  return b;
};
export const i64 = u64;
export const u128 = (n: bigint) => {
  const v = BigInt.asUintN(128, n);
  return Buffer.concat([u64(v & 0xffffffffffffffffn), u64(v >> 64n)]);
};
export const i128 = u128;
export const U64_MAX = 0xffffffffffffffffn;
export const I128_MAX = (1n << 127n) - 1n;
export const readU128 = (b: Buffer, at: number) => b.readBigUInt64LE(at) | (b.readBigUInt64LE(at + 8) << 64n);
export const readI128 = (b: Buffer, at: number) => BigInt.asIntN(128, readU128(b, at));
export const writeU128 = (b: Buffer, at: number, v: bigint) => u128(v).copy(b, at);

/** A mint's 82 bytes (SPL Token). */
export function mintBytes(o: { decimals?: number; authority?: Address; supply?: bigint; initialized?: number } = {}): Buffer {
  const b = Buffer.alloc(82);
  b.writeUInt32LE(o.authority ? 1 : 0, 0);
  if (o.authority) key(o.authority).copy(b, 4);
  b.writeBigUInt64LE(o.supply ?? 0n, 36);
  b[44] = o.decimals ?? 9;
  b[45] = o.initialized ?? 1;
  return b;
}

/** A token account's 165 bytes (SPL Token). */
export function tokenAccountBytes(o: { mint: Address; owner: Address; amount?: bigint; state?: number; delegate?: Address; closeAuthority?: Address }): Buffer {
  const b = Buffer.alloc(165);
  key(o.mint).copy(b, 0);
  key(o.owner).copy(b, 32);
  b.writeBigUInt64LE(o.amount ?? 0n, 64);
  if (o.delegate) {
    b.writeUInt32LE(1, 72);
    key(o.delegate).copy(b, 76);
  }
  b[108] = o.state ?? 1;
  if (o.closeAuthority) {
    b.writeUInt32LE(1, 129);
    key(o.closeAuthority).copy(b, 133);
  }
  return b;
}

export interface PythPrice {
  feedId: Buffer;
  price: bigint;
  expo: number;
  conf?: bigint;
  publishTime: bigint;
  /** The VerificationLevel tag at byte 40: 1 = Full (the only one the program accepts). */
  verification?: number;
  len?: number;
}

/** A Pyth PriceUpdateV2 account (Full verification): the PriceFeedMessage at byte 41, 134 bytes allocated. */
export function pythBytes(p: PythPrice): Buffer {
  const b = Buffer.alloc(p.len ?? 134);
  b[40] = p.verification ?? 1;
  p.feedId.copy(b, 41);
  b.writeBigInt64LE(p.price, 73);
  b.writeBigUInt64LE(p.conf ?? 0n, 81);
  b.writeInt32LE(p.expo, 89);
  b.writeBigInt64LE(p.publishTime, 93);
  return b;
}

export const FEED = Buffer.alloc(32, 0xab);

// ---- Outcomes and logs -----------------------------------------------------------------------------------------------

export const outcome = (r: Result) => (r instanceof FailedTransactionMetadata ? `error: ${String(r.err())}` : "ok");
export const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
/** A custom program error of the instruction at `index` (PercolatorError code). */
export const custom = (code: number, index = 0) =>
  `error: TransactionErrorInstructionError { index: ${index}, error: ${code === 0 ? "InstructionErrorCustom { code: 0 }" : `InstructionErrorCustom { code: ${code} }`} }`;
/** A built-in error of the instruction at `index` (its name as LiteSVM prints it). */
export const builtin = (name: string, index = 0) => `error: TransactionErrorInstructionError { index: ${index}, error: ${name} }`;
export const pe = (name: keyof typeof PE | string, index = 0) => custom(PE[name]!, index);

/** The log lines compared: the runtime's compute-unit lines dropped. */
export function lines(r: Result): string[] {
  return meta(r)
    .logs()
    .filter((l) => !/ consumed \d+ of \d+ compute units$/.test(l));
}

/** Each inner instruction: outer index, stack height, program index, account indexes, data (hex). */
export function inner(r: Result): string[] {
  return meta(r)
    .innerInstructions()
    .flatMap((list, outer) =>
      list.map((i) => {
        const c = i.instruction();
        return `${outer}: ${i.stackHeight()} ${c.programIdIndex()} [${[...c.accounts()].join(",")}] ${Buffer.from(c.data()).toString("hex")}`;
      }),
    );
}

/** The return data: program id and bytes, in hex. */
export const returnData = (r: Result) => {
  const d = meta(r).returnData();
  return `${Buffer.from(d.programId()).toString("hex")} ${Buffer.from(d.data()).toString("hex")}`;
};

// ---- Instructions ------------------------------------------------------------------------------------------------------

export function instruction(data: Buffer, accounts: Meta[]): Instruction {
  return {
    programAddress: PROGRAM,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(data),
  };
}
export const w = (a: Address): Meta => ({ address: a, writable: true });
export const r = (a: Address): Meta => ({ address: a });
export const s = (k: KeyPairSigner): Meta => ({ address: k.address, signer: k });
export const ws = (k: KeyPairSigner): Meta => ({ address: k.address, signer: k, writable: true });

/** InitMarket's arguments (src/percolator.rs `Instruction::InitMarket` and `read_risk_params`). */
export interface InitMarketArgs {
  admin: Address;
  mint: Address;
  feedId: Buffer;
  maxStalenessSecs: bigint;
  confFilterBps: number;
  invert: number;
  unitScale: number;
  initialMarkPriceE6: bigint;
  maintenanceFeePerSlot: bigint;
  minOraclePriceCapE2bps: bigint;
  hMin: bigint;
  maintenanceMarginBps: bigint;
  initialMarginBps: bigint;
  tradingFeeBps: bigint;
  maxAccounts: bigint;
  newAccountFee: bigint;
  hMax: bigint;
  maxCrankStalenessSlots: bigint;
  liquidationFeeBps: bigint;
  liquidationFeeCap: bigint;
  resolvePriceDeviationBps: bigint;
  minLiquidationAbs: bigint;
  minNonzeroMmReq: bigint;
  minNonzeroImReq: bigint;
  /** The 66-byte extended tail; null leaves it out (the defaults apply). */
  tail: {
    insuranceWithdrawMaxBps: number;
    insuranceWithdrawCooldownSlots: bigint;
    permissionlessResolveStaleSlots: bigint;
    fundingHorizonSlots: bigint;
    fundingKBps: bigint;
    fundingMaxPremiumBps: bigint;
    fundingMaxE9PerSlot: bigint;
    markMinFee: bigint;
    forceCloseDelaySlots: bigint;
  } | null;
}

/** The arguments of a plain non-Hyperp market (Pyth feed FEED, no fees): change what a test needs. */
export function defaultInitArgs(admin: Address, mint: Address): InitMarketArgs {
  return {
    admin,
    mint,
    feedId: FEED,
    maxStalenessSecs: 3600n,
    confFilterBps: 500,
    invert: 0,
    unitScale: 0,
    initialMarkPriceE6: 0n,
    maintenanceFeePerSlot: 0n,
    minOraclePriceCapE2bps: 0n,
    hMin: 0n,
    maintenanceMarginBps: 500n,
    initialMarginBps: 1000n,
    tradingFeeBps: 0n,
    maxAccounts: BigInt(MAX_ACCOUNTS),
    newAccountFee: 0n,
    hMax: 1n,
    maxCrankStalenessSlots: 1000n,
    liquidationFeeBps: 50n,
    liquidationFeeCap: 1_000_000_000_000n,
    resolvePriceDeviationBps: 100n,
    minLiquidationAbs: 0n,
    minNonzeroMmReq: 1n,
    minNonzeroImReq: 2n,
    tail: {
      insuranceWithdrawMaxBps: 0,
      insuranceWithdrawCooldownSlots: 0n,
      permissionlessResolveStaleSlots: 5000n,
      fundingHorizonSlots: 500n,
      fundingKBps: 100n,
      fundingMaxPremiumBps: 500n,
      fundingMaxE9PerSlot: 1000n,
      markMinFee: 0n,
      forceCloseDelaySlots: 100n,
    },
  };
}

export function initMarketData(a: InitMarketArgs): Buffer {
  const parts = [
    u8(0),
    key(a.admin),
    key(a.mint),
    a.feedId,
    u64(a.maxStalenessSecs),
    u16(a.confFilterBps),
    u8(a.invert),
    u32(a.unitScale),
    u64(a.initialMarkPriceE6),
    u128(a.maintenanceFeePerSlot),
    u64(a.minOraclePriceCapE2bps),
    u64(a.hMin),
    u64(a.maintenanceMarginBps),
    u64(a.initialMarginBps),
    u64(a.tradingFeeBps),
    u64(a.maxAccounts),
    u128(a.newAccountFee),
    u64(a.hMax),
    u64(a.maxCrankStalenessSlots),
    u64(a.liquidationFeeBps),
    u128(a.liquidationFeeCap),
    u64(a.resolvePriceDeviationBps),
    u128(a.minLiquidationAbs),
    u128(a.minNonzeroMmReq),
    u128(a.minNonzeroImReq),
  ];
  if (a.tail)
    parts.push(
      u16(a.tail.insuranceWithdrawMaxBps),
      u64(a.tail.insuranceWithdrawCooldownSlots),
      u64(a.tail.permissionlessResolveStaleSlots),
      u64(a.tail.fundingHorizonSlots),
      u64(a.tail.fundingKBps),
      i64(a.tail.fundingMaxPremiumBps),
      i64(a.tail.fundingMaxE9PerSlot),
      u64(a.tail.markMinFee),
      u64(a.tail.forceCloseDelaySlots),
    );
  return Buffer.concat(parts);
}

/** The market's accounts as the tests keep them. */
export interface Market {
  slab: Address;
  admin: KeyPairSigner;
  mint: Address;
  vault: Address;
  vaultPda: Address;
  bump: number;
  oracle: Address;
  feedId: Buffer;
}

/** A user (or LP) of a market: its keypair and token account. */
export interface User {
  key: KeyPairSigner;
  ata: Address;
}

/** An LP bound to a matcher: its slot, the matcher program and context, and its PDA ["lp", slab, idx]. */
export interface Lp {
  idx: number;
  matcher: Address;
  ctx: Address;
  pda: Address;
}

/** The matcher's Init parameters (percolator-match `InitParams`): kind 0 Passive, 1 vAMM. */
export interface MatcherParams {
  kind: number;
  tradingFeeBps: number;
  baseSpreadBps: number;
  maxTotalBps: number;
  impactKBps: number;
  liquidityNotionalE6: bigint;
  maxFillAbs: bigint;
  maxInventoryAbs: bigint;
}

export const passiveMatcher = (o: Partial<MatcherParams> = {}): MatcherParams => ({
  kind: 0,
  tradingFeeBps: 5,
  baseSpreadBps: 10,
  maxTotalBps: 200,
  impactKBps: 0,
  liquidityNotionalE6: 0n,
  maxFillAbs: 1n << 100n,
  maxInventoryAbs: 0n,
  ...o,
});

/** The matcher's Init (tag 2): LP PDA, context (writable). */
export function matcherInit(lpPda: Address, ctx: Address, p: MatcherParams): Instruction {
  return {
    programAddress: MATCHER,
    accounts: [
      { address: lpPda, role: AccountRole.READONLY },
      { address: ctx, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array(
      Buffer.concat([
        u8(2),
        u8(p.kind),
        u32(p.tradingFeeBps),
        u32(p.baseSpreadBps),
        u32(p.maxTotalBps),
        u32(p.impactKBps),
        u128(p.liquidityNotionalE6),
        u128(p.maxFillAbs),
        u128(p.maxInventoryAbs),
      ]),
    ),
  };
}

/** The LP PDA of slot `idx`. */
export async function lpPda(m: Market, idx: number): Promise<Address> {
  return (await pda(PROGRAM, ["lp", m.slab, u16(idx)]))[0];
}

/** Every instruction's data and accounts, by tag. */
export const ix = {
  initMarket: (m: Market, a: InitMarketArgs) =>
    instruction(initMarketData(a), [ws(m.admin), w(m.slab), r(m.mint), w(m.vault), r(TOKEN), r(CLOCK), r(RENT), r(m.oracle), r(SYSTEM)]),
  initUser: (m: Market, u: User, fee: bigint) =>
    instruction(Buffer.concat([u8(1), u64(fee)]), [ws(u.key), w(m.slab), w(u.ata), w(m.vault), r(TOKEN), r(CLOCK)]),
  initLp: (m: Market, u: User, matcherProgram: Address, matcherContext: Address, fee: bigint) =>
    instruction(Buffer.concat([u8(2), key(matcherProgram), key(matcherContext), u64(fee)]), [ws(u.key), w(m.slab), w(u.ata), w(m.vault), r(TOKEN), r(CLOCK)]),
  deposit: (m: Market, u: User, idx: number, amount: bigint) =>
    instruction(Buffer.concat([u8(3), u16(idx), u64(amount)]), [ws(u.key), w(m.slab), w(u.ata), w(m.vault), r(TOKEN), r(CLOCK)]),
  withdraw: (m: Market, u: User, idx: number, amount: bigint) =>
    instruction(Buffer.concat([u8(4), u16(idx), u64(amount)]), [ws(u.key), w(m.slab), w(m.vault), w(u.ata), r(m.vaultPda), r(TOKEN), r(CLOCK), r(m.oracle)]),
  /** KeeperCrank, format 1: (idx, policy) per candidate; policy 0 FullClose, 1 ExactPartial(q), 0xff touch only. */
  crank: (m: Market, caller: KeyPairSigner, callerIdx: number, candidates: [number, number, bigint?][] = []) =>
    instruction(
      Buffer.concat([u8(5), u16(callerIdx), u8(1), ...candidates.map(([i, p, q]) => Buffer.concat([u16(i), u8(p), ...(p === 1 ? [u128(q ?? 0n)] : [])]))]),
      [ws(caller), w(m.slab), r(CLOCK), r(m.oracle)],
    ),
  tradeNoCpi: (m: Market, user: KeyPairSigner, lp: KeyPairSigner, lpIdx: number, userIdx: number, size: bigint) =>
    instruction(Buffer.concat([u8(6), u16(lpIdx), u16(userIdx), i128(size)]), [ws(user), ws(lp), w(m.slab), r(CLOCK), r(m.oracle)]),
  /** TradeCpi: user (signer), LP owner, slab, clock, oracle, matcher program, matcher context, LP PDA, then the tail. */
  tradeCpi: (m: Market, user: KeyPairSigner, lpOwner: Address, lp: Lp, userIdx: number, size: bigint, limitPriceE6 = 0n, tail: Meta[] = []) =>
    instruction(Buffer.concat([u8(10), u16(lp.idx), u16(userIdx), i128(size), u64(limitPriceE6)]), [
      ws(user),
      r(lpOwner),
      w(m.slab),
      r(CLOCK),
      r(m.oracle),
      r(lp.matcher),
      w(lp.ctx),
      r(lp.pda),
      ...tail,
    ]),
  liquidate: (m: Market, caller: KeyPairSigner, target: number) =>
    instruction(Buffer.concat([u8(7), u16(target)]), [ws(caller), w(m.slab), r(CLOCK), r(m.oracle)]),
  closeAccount: (m: Market, u: User, idx: number) =>
    instruction(Buffer.concat([u8(8), u16(idx)]), [ws(u.key), w(m.slab), w(m.vault), w(u.ata), r(m.vaultPda), r(TOKEN), r(CLOCK), r(m.oracle)]),
  topUpInsurance: (m: Market, u: User, amount: bigint) =>
    instruction(Buffer.concat([u8(9), u64(amount)]), [ws(u.key), w(m.slab), w(u.ata), w(m.vault), r(TOKEN), r(CLOCK)]),
  closeSlab: (m: Market, adminAta: Address) => instruction(Buffer.from([13]), [ws(m.admin), w(m.slab), w(m.vault), r(m.vaultPda), w(adminAta), r(TOKEN)]),
  updateConfig: (m: Market, signer: KeyPairSigner, a: { horizon: bigint; kBps: bigint; maxPremiumBps: bigint; maxE9PerSlot: bigint; tvlCapMult: number }) =>
    instruction(Buffer.concat([u8(14), u64(a.horizon), u64(a.kBps), i64(a.maxPremiumBps), i64(a.maxE9PerSlot), u16(a.tvlCapMult)]), [
      ws(signer),
      w(m.slab),
      r(CLOCK),
      r(m.oracle),
    ]),
  pushHyperpMark: (m: Market, authority: KeyPairSigner, priceE6: bigint, timestamp: bigint) =>
    instruction(Buffer.concat([u8(17), u64(priceE6), i64(timestamp)]), [ws(authority), w(m.slab)]),
  setOraclePriceCap: (m: Market, signer: KeyPairSigner, cap: bigint) => instruction(Buffer.concat([u8(18), u64(cap)]), [ws(signer), w(m.slab), r(CLOCK)]),
  resolveMarket: (m: Market, signer: KeyPairSigner) => instruction(Buffer.from([19]), [ws(signer), w(m.slab), r(CLOCK), r(m.oracle)]),
  withdrawInsurance: (m: Market, signer: KeyPairSigner, ata: Address) =>
    instruction(Buffer.from([20]), [ws(signer), w(m.slab), w(ata), w(m.vault), r(TOKEN), r(m.vaultPda)]),
  adminForceCloseAccount: (m: Market, signer: KeyPairSigner, idx: number, ownerAta: Address) =>
    instruction(Buffer.concat([u8(21), u16(idx)]), [ws(signer), w(m.slab), w(m.vault), w(ownerAta), r(m.vaultPda), r(TOKEN), r(CLOCK), r(m.oracle)]),
  withdrawInsuranceLimited: (m: Market, signer: KeyPairSigner, ata: Address, amount: bigint) =>
    instruction(Buffer.concat([u8(23), u64(amount)]), [ws(signer), w(m.slab), w(ata), w(m.vault), r(TOKEN), r(m.vaultPda), r(CLOCK)]),
  reclaimEmptyAccount: (m: Market, idx: number) => instruction(Buffer.concat([u8(25), u16(idx)]), [w(m.slab), r(CLOCK)]),
  settleAccount: (m: Market, idx: number) => instruction(Buffer.concat([u8(26), u16(idx)]), [w(m.slab), r(CLOCK), r(m.oracle)]),
  depositFeeCredits: (m: Market, u: User, idx: number, amount: bigint) =>
    instruction(Buffer.concat([u8(27), u16(idx), u64(amount)]), [ws(u.key), w(m.slab), w(u.ata), w(m.vault), r(TOKEN), r(CLOCK)]),
  convertReleasedPnl: (m: Market, u: User, idx: number, amount: bigint) =>
    instruction(Buffer.concat([u8(28), u16(idx), u64(amount)]), [ws(u.key), w(m.slab), r(CLOCK), r(m.oracle)]),
  resolvePermissionless: (m: Market) => instruction(Buffer.from([29]), [w(m.slab), r(CLOCK)]),
  /** ForceCloseResolved: the seventh account (the oracle) is not read. */
  forceCloseResolved: (m: Market, idx: number, ownerAta: Address) =>
    instruction(Buffer.concat([u8(30), u16(idx)]), [w(m.slab), w(m.vault), w(ownerAta), r(m.vaultPda), r(TOKEN), r(CLOCK), r(m.oracle)]),
  catchupAccrue: (m: Market) => instruction(Buffer.from([31]), [w(m.slab), r(CLOCK), r(m.oracle)]),
  updateAuthority: (m: Market, current: KeyPairSigner, kind: number, newKey: Address, newSigner?: KeyPairSigner) =>
    instruction(Buffer.concat([u8(32), u8(kind), key(newKey)]), [ws(current), newSigner ? ws(newSigner) : w(newKey), w(m.slab)]),
};

/** Edit an instruction's account list. */
export function accounts(i: Instruction, edit: (list: { address: Address; role: AccountRole; signer?: KeyPairSigner }[]) => void): Instruction {
  const list = [...(i.accounts ?? [])] as { address: Address; role: AccountRole; signer?: KeyPairSigner }[];
  edit(list);
  return { ...i, accounts: list as Instruction["accounts"] };
}
export const truncate = (i: Instruction, n: number) => accounts(i, (l) => l.splice(n));
export const replace = (i: Instruction, at: number, a: Address) =>
  accounts(i, (l) => {
    const role =
      l[at]!.role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : l[at]!.role === AccountRole.READONLY_SIGNER ? AccountRole.READONLY : l[at]!.role;
    l[at] = { address: a, role };
  });
export const readonly = (i: Instruction, at: number) =>
  accounts(i, (l) => {
    l[at] = { ...l[at]!, role: l[at]!.role === AccountRole.WRITABLE_SIGNER ? AccountRole.READONLY_SIGNER : AccountRole.READONLY };
  });
export const unsigned = (i: Instruction, at: number) =>
  accounts(i, (l) => {
    l[at] = { address: l[at]!.address, role: l[at]!.role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : AccountRole.READONLY };
  });
export const withData = (i: Instruction, data: Buffer): Instruction => ({ ...i, data: new Uint8Array(data) });

/** SetComputeUnitLimit (Compute Budget). */
export const computeUnits = (units: number): Instruction => ({
  programAddress: address("ComputeBudget111111111111111111111111111111"),
  accounts: [],
  data: new Uint8Array([2, ...u32(units)]),
});

/** An SPL Token Transfer (tag 3) signed by the source's owner: tokens sent (to the vault, say) without the program. */
export function tokenTransfer(source: Address, dest: Address, owner: KeyPairSigner, amount: bigint): Instruction {
  return {
    programAddress: TOKEN,
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: dest, role: AccountRole.WRITABLE },
      { address: owner.address, role: AccountRole.READONLY_SIGNER, signer: owner },
    ] as Instruction["accounts"],
    data: new Uint8Array(Buffer.concat([u8(3), u64(amount)])),
  };
}

// ---- The two VMs -------------------------------------------------------------------------------------------------------

/** One compared transaction's compute units, and whether it succeeded (in both: the outcomes are compared). */
export interface CuRow {
  label: string;
  original: bigint;
  port: bigint;
  ok: boolean;
  /** Whether the transaction has a top-level instruction of the program (the compute-unit rule applies to it). */
  percolator: boolean;
}

/** The original alone, for tests that read the binary's own behaviour (the layout test). */
export function originalVm(): LiteSVM {
  const vm = new LiteSVM();
  vm.addProgram(PROGRAM, new Uint8Array(readFileSync(ORIGINAL)));
  vm.setClock(new Clock(SLOT, UNIX_TIMESTAMP - 1000n, 700n, 701n, UNIX_TIMESTAMP));
  vm.withLogBytesLimit();
  return vm;
}

/**
 * The original and the port side by side, the accounts made in both, and the comparison. `rows` keeps every compared
 * transaction's compute units in order, `cu` the last of each label.
 */
export class Diff {
  readonly cu: Record<string, [bigint, bigint]> = {};
  readonly rows: CuRow[] = [];
  compared = 0;
  /** The original's log lines of the last compared transaction (for messages). */
  lastLogs = "";
  last: Result | undefined;
  slot = SLOT;
  unixTimestamp = UNIX_TIMESTAMP;
  private constructor(
    readonly original: LiteSVM,
    readonly port: LiteSVM,
    private readonly newKey: () => Promise<KeyPairSigner>,
  ) {}

  static async create(keys: () => Promise<KeyPairSigner> = generateKeyPairSigner): Promise<Diff> {
    const port = (await deployFile(PORT, { programId: PROGRAM })).svm;
    const original = new LiteSVM();
    original.addProgram(PROGRAM, new Uint8Array(readFileSync(ORIGINAL)));
    const d = new Diff(original, port, keys);
    for (const vm of d.vms) {
      vm.withLogBytesLimit();
      vm.addProgram(MATCHER, fixtureBinary(MATCHER_SRC, MATCHER));
      vm.addProgram(ROGUE, fixtureBinary(ROGUE_SRC, ROGUE));
    }
    d.setClock(SLOT, UNIX_TIMESTAMP);
    return d;
  }

  get vms(): readonly [LiteSVM, LiteSVM] {
    return [this.original, this.port];
  }

  /** Both VMs' Clock at `slot` and `unixTimestamp`. */
  setClock(slot: bigint, unixTimestamp: bigint = this.unixTimestamp + (slot - this.slot) / 2n): void {
    this.slot = slot;
    this.unixTimestamp = unixTimestamp;
    for (const vm of this.vms) vm.setClock(new Clock(slot, unixTimestamp - 1000n, 700n, 701n, unixTimestamp));
  }

  /** A keypair with `sol` SOL in both VMs. */
  async funded(sol = 100n): Promise<KeyPairSigner> {
    const k = await this.newKey();
    for (const vm of this.vms) vm.airdrop(k.address, lamports(sol * SOL));
    return k;
  }

  async address(): Promise<Address> {
    return (await this.newKey()).address;
  }

  /** Write the same account into both VMs (rent-exempt for its size unless `lamports` is given). */
  write(at: Address, owner: Address, data: Buffer, lamportsHeld?: bigint, executable = false): void {
    for (const vm of this.vms)
      vm.setAccount({
        address: at,
        data: new Uint8Array(data),
        executable,
        lamports: lamports(lamportsHeld ?? vm.minimumBalanceForRentExemption(BigInt(data.length))),
        programAddress: owner,
        space: BigInt(data.length),
      });
  }

  /** An account's data in the original (a view of getAccount's copy). */
  data(a: Address): Buffer {
    const acct = this.original.getAccount(a);
    if (!acct.exists) throw new Error(`${a} does not exist`);
    return Buffer.from(acct.data.buffer, acct.data.byteOffset, acct.data.byteLength);
  }

  /** Change an account's bytes in both VMs (its lamports and owner kept unless given). */
  patch(a: Address, edit: (data: Buffer) => void, opts: { lamports?: bigint; owner?: Address } = {}): void {
    const acct = this.original.getAccount(a);
    if (!acct.exists) throw new Error(`${a} does not exist`);
    const data = Buffer.from(acct.data);
    edit(data);
    this.write(a, opts.owner ?? acct.programAddress, data, opts.lamports ?? BigInt(acct.lamports));
  }

  bytes(vm: LiteSVM, a: Address): string {
    const acct = vm.getAccount(a);
    return acct.exists ? `${acct.lamports} ${acct.programAddress} ${Buffer.from(acct.data).toString("hex")}` : "missing";
  }

  /** The account is the same in both VMs; a slab that differs is reported by its first differing bytes, not 3 MB of hex. */
  expectSame(at: Address, message: string): void {
    const [o, p] = [this.original.getAccount(at), this.port.getAccount(at)];
    const same = o.exists ? p.exists && o.lamports === p.lamports && o.programAddress === p.programAddress && Buffer.compare(o.data, p.data) === 0 : !p.exists;
    if (same) return;
    if (o.exists && p.exists && o.data.length === p.data.length && o.data.length > 4096) {
      const diffs: string[] = [];
      for (let i = 0; i < o.data.length && diffs.length < 16; i++)
        if (o.data[i] !== p.data[i]) diffs.push(`@${i} (${describe(i)}): original ${o.data[i]} port ${p.data[i]}`);
      expect(diffs.length === 0 ? `lamports ${p.lamports} owner ${p.programAddress}` : diffs.join("\n"), message).toBe(
        diffs.length === 0 ? `lamports ${o.lamports} owner ${o.programAddress}` : "",
      );
    }
    expect(this.bytes(this.port, at), message).toBe(this.bytes(this.original, at));
  }

  /**
   * Send to both: the same outcome, log lines, inner instructions, return data and account bytes, and, when the
   * transaction succeeds and names Percolator at the top level, fewer compute units in the port (see `compare`).
   */
  async both(label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[] = []): Promise<string> {
    const [a, b] = [await send(this.original, payer, ixs), await send(this.port, payer, ixs)];
    return this.compare(label, payer, ixs, a, b, watch);
  }

  /**
   * The comparison `both` makes, of a transaction already sent to each VM (`a` the original's result, `b` the port's).
   * Compute units: a transaction that succeeds and has a top-level instruction of the program (PROGRAM) must cost the
   * port fewer units than the original. A transaction with none (the matcher's Init, an SPL Token transfer: the same
   * program on both sides) is not a Percolator instruction and is exempt, by program id.
   */
  compare(label: string, payer: KeyPairSigner, ixs: Instruction[], a: Result, b: Result, watch: Address[] = []): string {
    this.compared++;
    const logs = (res: Result) => meta(res).logs().join("\n");
    const why = `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`;
    expect(outcome(b), why).toBe(outcome(a));
    expect(lines(b), `${label}: logs\n${why}`).toEqual(lines(a));
    expect(inner(b), `${label}: inner instructions\n${why}`).toEqual(inner(a));
    expect(returnData(b), `${label}: return data`).toBe(returnData(a));
    const named = new Set<Address>([payer.address, ...watch]);
    for (const i of ixs) for (const m of i.accounts ?? []) named.add(m.address);
    for (const at of named) {
      const acct = this.original.getAccount(at);
      if (acct.exists && acct.executable) continue;
      if (at === CLOCK || at === RENT) continue;
      this.expectSame(at, `${label}: ${at}`);
    }
    this.cu[label] = [meta(a).computeUnitsConsumed(), meta(b).computeUnitsConsumed()];
    const percolator = ixs.some((i) => i.programAddress === PROGRAM);
    const [cuOriginal, cuPort] = [meta(a).computeUnitsConsumed(), meta(b).computeUnitsConsumed()];
    if (outcome(a) === "ok" && percolator)
      expect(`${cuPort} < ${cuOriginal}: ${cuPort < cuOriginal}`, `${label}: the port's compute units (left) below the original's (right)`).toBe(
        `${cuPort} < ${cuOriginal}: true`,
      );
    this.rows.push({ label, original: meta(a).computeUnitsConsumed(), port: meta(b).computeUnitsConsumed(), ok: outcome(a) === "ok", percolator });
    this.lastLogs = logs(a);
    this.last = a;
    // PERCOLATOR_TRACE=1 prints each compared transaction's outcome and compute units.
    if (process.env.PERCOLATOR_TRACE) console.log(`${label}: ${outcome(a)} (${meta(a).computeUnitsConsumed()} / ${meta(b).computeUnitsConsumed()} CU)`);
    return outcome(a);
  }

  async ok(label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[] = []): Promise<void> {
    const got = await this.both(label, payer, ixs, watch);
    expect(got, `${label}\n${this.lastLogs}`).toBe("ok");
  }

  async fails(label: string, payer: KeyPairSigner, ixs: Instruction[], expected: string, watch: Address[] = []): Promise<void> {
    const got = await this.both(label, payer, ixs, watch);
    expect(got, `${label}\n${this.lastLogs}`).toBe(expected);
  }

  // ---- Accounts -------------------------------------------------------------------------------------------------------

  async mint(decimals = 9): Promise<Address> {
    const k = await this.address();
    this.write(k, TOKEN, mintBytes({ decimals }));
    return k;
  }

  async tokenAccount(mint: Address, owner: Address, amount = 0n, extra: Partial<Parameters<typeof tokenAccountBytes>[0]> = {}): Promise<Address> {
    const k = await this.address();
    this.write(k, TOKEN, tokenAccountBytes({ mint, owner, amount, ...extra }));
    return k;
  }

  /** A token account's amount in the original. */
  amount(a: Address): bigint {
    return this.data(a).readBigUInt64LE(64);
  }

  /** A Pyth PriceUpdateV2 account at `at` (a new address by default), owned by the Pyth receiver. */
  async pyth(p: PythPrice, at?: Address, owner: Address = PYTH_RECEIVER): Promise<Address> {
    const a = at ?? (await this.address());
    this.write(a, owner, pythBytes(p));
    return a;
  }

  /** The market's oracle moved to `price` (expo -6) published at the Clock's timestamp (or `publishTime`). */
  setPrice(m: Market, price: bigint, publishTime = this.unixTimestamp, expo = -6, conf = 0n): void {
    this.write(m.oracle, PYTH_RECEIVER, pythBytes({ feedId: m.feedId, price, expo, conf, publishTime }));
  }

  /**
   * A market's accounts: a zeroed slab of SLAB_LEN bytes owned by the program, a mint, the vault (a token account of
   * the vault PDA, empty) and a Pyth account at `price` (expo -6, published now); not initialized yet. `slab` gives the
   * slab's keypair, for a test that signs with it.
   */
  async newMarket(o: { price?: bigint; slabLen?: number; feedId?: Buffer; decimals?: number; slab?: KeyPairSigner } = {}): Promise<Market> {
    const admin = await this.funded(100n);
    const mint = await this.mint(o.decimals ?? 9);
    // A test that signs with the slab's keypair passes it (`slab`); otherwise the keypair is not kept.
    const slab = o.slab?.address ?? (await this.address());
    this.write(slab, PROGRAM, Buffer.alloc(o.slabLen ?? SLAB_LEN));
    const [vaultPda, bump] = await pda(PROGRAM, ["vault", slab]);
    const vault = await this.tokenAccount(mint, vaultPda);
    const feedId = o.feedId ?? FEED;
    const oracle = await this.pyth({ feedId, price: o.price ?? 100_000_000n, expo: -6, publishTime: this.unixTimestamp });
    return { slab, admin, mint, vault, vaultPda, bump, oracle, feedId };
  }

  /** A new market initialized through both(), with `edit` (then `prepare`) applied to the default arguments. */
  async market(
    o: { edit?: (a: InitMarketArgs) => void; price?: bigint; label?: string; prepare?: (m: Market, a: InitMarketArgs) => void } = {},
  ): Promise<Market> {
    const m = await this.newMarket({ price: o.price });
    const args = defaultInitArgs(m.admin.address, m.mint);
    o.edit?.(args);
    // `prepare` sees the market's accounts before InitMarket (another oracle written at m.oracle, say).
    o.prepare?.(m, args);
    await this.ok(o.label ?? "InitMarket", m.admin, [computeUnits(1_400_000), ix.initMarket(m, args)]);
    return m;
  }

  /** A funded keypair and a token account of the market's mint holding `amount`. */
  async user(m: Market, amount = 1_000n * SOL): Promise<User> {
    const k = await this.funded(10n);
    return { key: k, ata: await this.tokenAccount(m.mint, k.address, amount) };
  }

  /**
   * An LP bound to the TypeSOL matcher: a 320-byte context owned by the matcher, InitLP naming it (through both()), and
   * the matcher's Init with the LP PDA of the slot InitLP took.
   */
  async lp(m: Market, u: User, deposit: bigint, p: MatcherParams = passiveMatcher(), label = "LP"): Promise<Lp> {
    const ctx = await this.address();
    this.write(ctx, MATCHER, Buffer.alloc(MATCHER_CTX_LEN));
    const idx = this.freeHead(m);
    await this.ok(`${label}: InitLP`, u.key, [ix.initLp(m, u, MATCHER, ctx, deposit)]);
    const at = await lpPda(m, idx);
    await this.ok(`${label}: matcher Init`, u.key, [matcherInit(at, ctx, p)]);
    return { idx, matcher: MATCHER, ctx, pda: at };
  }

  /** The free head of the original's slab (the index InitUser / InitLP will take). */
  freeHead(m: Market): number {
    return this.data(m.slab).readUInt16LE(E.freeHead);
  }
}

/** Which field a slab offset falls in (for failure messages). */
export function describe(at: number): string {
  const find = (table: Record<string, number>, base = 0) => {
    let best = "";
    let bestAt = -1;
    for (const [k, v] of Object.entries(table)) if (v + base <= at && v + base > bestAt) [best, bestAt] = [k, v + base];
    return `${best}+${at - bestAt}`;
  };
  if (at < HEADER_LEN) return `header.${find(H)}`;
  if (at < ENGINE_OFF) return `config.${find(C)}`;
  if (at >= RISK_BUF_OFF && at < GEN_TABLE_OFF) return `riskBuffer+${at - RISK_BUF_OFF}`;
  if (at >= GEN_TABLE_OFF) return `generation[${Math.floor((at - GEN_TABLE_OFF) / 8)}]`;
  if (at >= E.accounts) {
    const idx = Math.floor((at - E.accounts) / ACCOUNT_LEN);
    return `accounts[${idx}].${find(A, accountAt(idx))}`;
  }
  if (at >= E.params && at < E.currentSlot) return `engine.params.${find(P, E.params)}`;
  return `engine.${find(E)}`;
}

/**
 * Compute units by instruction (the first word of each label after its last ": "), over the successful transactions
 * with a top-level Percolator instruction: count, and the original's and the port's mean and largest. PERCOLATOR_CU=1
 * prints it after each test file.
 */
export function cuSummary(rows: readonly CuRow[]): Record<string, { n: number; originalMean: number; portMean: number; originalMax: number; portMax: number }> {
  const out: Record<string, { n: number; originalMean: number; portMean: number; originalMax: number; portMax: number }> = {};
  for (const r of rows) {
    if (!r.ok || !r.percolator) continue;
    const name = r.label.split(": ").at(-1)!.split(" ")[0]!;
    const e = (out[name] ??= { n: 0, originalMean: 0, portMean: 0, originalMax: 0, portMax: 0 });
    e.originalMean = (e.originalMean * e.n + Number(r.original)) / (e.n + 1);
    e.portMean = (e.portMean * e.n + Number(r.port)) / (e.n + 1);
    e.n++;
    e.originalMax = Math.max(e.originalMax, Number(r.original));
    e.portMax = Math.max(e.portMax, Number(r.port));
  }
  for (const e of Object.values(out)) [e.originalMean, e.portMean] = [Math.round(e.originalMean), Math.round(e.portMean)];
  return out;
}
