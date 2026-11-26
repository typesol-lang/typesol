// The differential harness for showcase/mainnet/percolator-v16, the port of Percolator v16 at commit 7b110913 (engine
// 5e3af07): aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0. The reference is the Rust build of
// those commits (test/programs/percolator_v16.so, scripts/percolator-v16-reference/build.sh), reproducible but not a
// deployed program: no v16 build is deployed that could serve as one. Reference and port run in two LiteSVMs under the
// same program id and the same Clock, every account made the same way in both; `send()` then sends one transaction to
// each and requires:
//
// - the same outcome (the same error and code on a failure);
// - the same log lines, all but the runtime's compute-unit lines (v16 logs nothing of its own: panics only);
// - the same inner instructions, in order: each one's stack height, program, accounts and data bytes;
// - the same return data;
// - the same lamports, owner, length and data of every account the transaction names, the fee payer and any others
//   asked for. v16 creates and grows accounts itself (InitPortfolio reallocates a portfolio to its length, asset
//   activation grows the market by one slot), so lengths are part of the comparison;
// - and records both compute-unit counts. The port must use fewer on every transaction that succeeds and has a
//   top-level instruction of the program (`cu: "fewer"`, the default once a port exists).
//
// The heap. The reference's entrypoint is pinocchio 0.11's `entrypoint!` with its default bump allocator, which
// believes the heap is MAX_HEAP_LENGTH = 256 KiB whatever the transaction requested: an allocation past the frame the
// runtime actually maps is an access violation, not an allocation failure. Every instruction allocates (the account
// shim alone builds three Vecs and an Rc per account), so `send()` puts the author's own preamble before the
// instructions, as tests/support/v16_svm.rs does: RequestHeapFrame(256 KiB), then SetComputeUnitLimit(1,400,000).
// A test that wants another frame or limit passes `heap` / `cu_limit` (null leaves the instruction out), and the same
// transaction goes to both.
//
// This file reuses the v12.20 harness's byte, token-account, outcome and log helpers (percolator-helpers.ts) and
// adds what differs: the program, the binaries, the preamble, the comparison of grown accounts, the v16 layouts
// (percolator-v16-layout.ts) and the instruction builders, which follow the original's `Instruction::decode` wire
// layout (src/v16_program.rs) and the account lists of its own LiteSVM tests (tests/support/v16_svm.rs).
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  AccountRole,
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressDecoder,
  lamports,
} from "@solana/kit";
import { Clock, ComputeBudget, FailedTransactionMetadata, LiteSVM } from "litesvm";
import { createHash, getRandomValues } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { build } from "../../src/compiler/index.js";
import { TESTED_TOOLCHAIN, findToolchain } from "../../src/compiler/toolchain.js";
import { present, required } from "../../test/binaries.js";
import { pda, send as sendTx } from "../../test/harness.js";
import { Rng } from "./fuzz-rng.js";
import { SETTLEMENT_FILES, PROBE_TAG, type Probe, coverageReport, instrumentPort, probesInLogs } from "../../scripts/percolator-v16-reference/coverage.ts";
import {
  type CuRow,
  type Meta,
  builtin,
  custom,
  type Result,
  SOL,
  TOKEN,
  CLOCK,
  RENT,
  inner,
  key,
  meta,
  mintBytes,
  outcome,
  returnData,
  tokenAccountBytes,
  u8,
  u16,
  u32,
  u64,
  u128,
} from "./percolator-helpers.js";
import { MARKET, PORTFOLIO, layout, marketLen, offsetOf, sizeOf } from "./percolator-v16-layout.js";

export { SOL, TOKEN, CLOCK, RENT, custom, builtin, outcome, meta, inner, key, u8, u16, u32, u64, u128, w, r, s, ws } from "./percolator-helpers.js";

/** The program id the author's tests use (`declare_id!` in src/v16_program.rs); both binaries run under it. */
export const PROGRAM = address("Perco1ator111111111111111111111111111111111");
export const REFERENCE = fileURLToPath(new URL("../../test/programs/percolator_v16.so", import.meta.url));
export const PORT = fileURLToPath(new URL("../mainnet/percolator-v16/percolator.ts", import.meta.url));
/** An address made of one repeated byte (fixed program ids for the matchers). */
const fixedAddress = (byte: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
/** The matchers the author's tests load (built by scripts/percolator-v16-reference/build.sh beside the program). */
export const MATCHERS = {
  /** aeyakovenko/percolator-match 60aac3a, matcher ABI v3. */
  match: { id: fixedAddress(0x16), file: fileURLToPath(new URL("../../test/programs/percolator_v16_match.so", import.meta.url)) },
  /** percolator-prog's tests/fixtures/auth_matcher. */
  auth: { id: fixedAddress(0x17), file: fileURLToPath(new URL("../../test/programs/percolator_v16_auth_matcher.so", import.meta.url)) },
  /** percolator-prog's tests/fixtures/hostile_matcher. */
  hostile: {
    id: fixedAddress(0x18),
    file: fileURLToPath(new URL("../../test/programs/percolator_v16_hostile_matcher.so", import.meta.url)),
  },
} as const;
/**
 * Whether the v16 suites must run: CI_REQUIRE_ALL naming the "built" group (or =1; test/binaries.ts). Then a missing
 * reference or matcher binary or a missing port source fails the test file instead of skipping it, and so does a test
 * file that compared no transaction (the check after each file, below). Without it (a local checkout without the
 * binaries built), the suites skip, and each file prints how many transactions it compared.
 */
export const STRICT = required("built");
/** Tests skip when the reference has not been built, or fail under CI_REQUIRE_ALL naming its group (test/binaries.ts). */
export const HAVE_REFERENCE = present(REFERENCE, ...Object.values(MATCHERS).map((m) => m.file));
/**
 * The tags whose handlers are ported (showcase/mainnet/percolator-v16/percolator.ts dispatches them; every other decoded
 * tag ends in the port's placeholder).
 */
export const PORTED_TAGS = new Set<number>([
  0, 1, 3, 4, 5, 6, 8, 9, 10, 13, 19, 24, 28, 30, 32, 34, 35, 36, 37, 38, 39, 40, 42, 43, 44, 45, 46, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61,
  62, 63, 64, 65, 66, 67, 68, 69, 70,
]);
/** Whether the port exists (under STRICT a missing port source is an error, not a skip). */
export const HAVE_PORT = existsSync(PORT);
if (STRICT && !HAVE_PORT) throw new Error(`CI_REQUIRE_ALL=${process.env.CI_REQUIRE_ALL}: the port's source ${PORT} is missing`);
export const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const SYSTEM = address("11111111111111111111111111111111");
/** The Clock both VMs start with. */
export const SLOT = 300_000_000n;
export const UNIX_TIMESTAMP = 1_770_000_000n;
/** The author's preamble: tests/support/v16_svm.rs requests a 256 KiB heap and the full 1.4M compute units. */
export const HEAP_FRAME = 256 * 1024;
export const CU_LIMIT = 1_400_000;
/** The raised compute budget the reference is run again under where it runs out (`Diff.send`). */
export const RAISED_CU_LIMIT = 20_000_000n;

// ---- The run's seed ---------------------------------------------------------------------------------------------------

/**
 * Every key a v16 test makes (the Diff's default keys and the World's) comes from this seed, so that a run is replayed
 * whole by setting it: PERCOLATOR_V16_SEED=<n>. Unset, each run draws a new one, so that the keys (account addresses,
 * PDA bumps, vault addresses, the order of keys in a transaction) differ from run to run. The scenario generators keep
 * their own seeds (PERCOLATOR_FUZZ_SEED and the like, fixed by default), printed beside it. The seed is printed at the
 * start of each test file (with --silent=false) and put in front of every failure's message, with the port binary's
 * sha256 and its clang.
 */
export const RUN_SEED: bigint = BigInt(process.env.PERCOLATOR_V16_SEED ?? getRandomValues(new BigUint64Array(1))[0]! & 0xffff_ffff_ffffn);
/** The scenario seed most v16 files use (PERCOLATOR_FUZZ_SEED, 1618 by default). */
export const FUZZ_SEED: bigint = BigInt(process.env.PERCOLATOR_FUZZ_SEED ?? "1618");
/** The port binary of this file's last build: its sha256 and the clang that built it (for the failure line). */
let portBuilt = "";
const seedLine = () => `PERCOLATOR_V16_SEED=${RUN_SEED} PERCOLATOR_FUZZ_SEED=${FUZZ_SEED}${portBuilt ? ` (port ${portBuilt})` : ""}`;
beforeAll(() => console.log(`percolator-v16 replay: ${seedLine()}`));
afterEach(({ task }) => {
  if (task.result?.state !== "fail") return;
  for (const e of task.result.errors ?? []) if (!e.message?.startsWith("[replay")) e.message = `[replay with ${seedLine()}] ${e.message}`;
});

/**
 * The transactions this test file compared (every `Diff.compare`, whichever Diff): with the port, and with the reference
 * binary on both sides (the harness's own check). Printed after the file (with --silent=false); under STRICT a file that
 * compared none fails there, so that a run in which the suites skipped, or ran without sending anything, cannot pass.
 * A file whose evidence is not transactions (vectors through a test program) adds them with `countVectors`.
 */
const comparedInFile = { port: 0, reference: 0, vectors: 0 };
/** Vectors compared with the original's answers in a test program over the port's functions (see `comparedInFile`). */
export function countVectors(n: number): void {
  comparedInFile.vectors += n;
}
afterAll(() => {
  const { port, reference, vectors } = comparedInFile;
  console.log(
    `percolator-v16 compared: ${port} transactions with the port, ${reference} with the reference on both sides${vectors ? `, ${vectors} vectors` : ""}`,
  );
  if (STRICT && port + reference + vectors === 0)
    throw new Error(
      `CI_REQUIRE_ALL=${process.env.CI_REQUIRE_ALL}: this test file compared no transaction with the reference (its suites skipped or sent nothing)`,
    );
});

/** A source of keys drawn from the run's seed and `salt` (each caller its own stream). */
export function seededKeys(salt: bigint): () => Promise<KeyPairSigner> {
  const rng = new Rng(RUN_SEED * 0x9e37_79b9n + salt);
  return () => createKeyPairSignerFromPrivateKeyBytes(rng.bytes(32));
}
/** The Diffs' default keys: one stream for the file. */
const defaultKeys = seededKeys(0x16dec0den);

/**
 * The port built and loaded into a new LiteSVM. The platform-tools the build uses are a link shared with every other
 * process on the machine (the Agave installer's `dependencies/platform-tools`, which `cargo-build-sbf` of another
 * version re-points), so the build must use the tested toolchain throughout: the link is resolved before and after it,
 * and the binary's manifest must name the tested clang. A build from another clang is not the port the tables measure
 * (and before the runtime's C builtins for clang 22, faulted at its first 128-bit multiplication); one made while the
 * link moved may mix two toolchains. PERCOLATOR_V16_ANY_TOOLCHAIN=1 allows an untested one on purpose.
 */
export function loadPort(file: string, programId: Address = PROGRAM): LiteSVM {
  const tc = findToolchain("v0");
  const tools = path.join(tc.sdk, "dependencies/platform-tools");
  const before = realpathSync(tools);
  const out = mkdtempSync(path.join(os.tmpdir(), "typesol-percolator-v16-"));
  try {
    const res = build(file, out, programId);
    const after = realpathSync(tools);
    if (before !== after) throw new Error(`the platform-tools link moved during the port's build (${before} → ${after}): build again`);
    if (res.manifest.clang !== TESTED_TOOLCHAIN.clang && !process.env.PERCOLATOR_V16_ANY_TOOLCHAIN)
      throw new Error(`the port was built by ${res.manifest.clang} (${before}), not the tested ${TESTED_TOOLCHAIN.clang}`);
    const bytes = readFileSync(res.soPath);
    portBuilt = `sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}…, ${bytes.length} bytes, ${res.manifest.clang.split(" (")[0]}`;
    const svm = new LiteSVM();
    svm.addProgram(programId, new Uint8Array(bytes));
    return svm;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** A test program of the v16 tests (a fixture over the port's functions) built as `loadPort` builds, at a seeded id. */
export async function deployV16(file: string): Promise<{ svm: LiteSVM; programId: Address }> {
  const programId = (await seededKeys(0xf1c7n)()).address;
  return { svm: loadPort(file, programId), programId };
}

// ---- Instructions ------------------------------------------------------------------------------------------------------

/** RequestHeapFrame (Compute Budget, tag 1). */
export const requestHeapFrame = (bytes: number): Instruction => ({ programAddress: COMPUTE_BUDGET, accounts: [], data: new Uint8Array([1, ...u32(bytes)]) });
/** SetComputeUnitLimit (Compute Budget, tag 2). */
export const computeUnitLimit = (units: number): Instruction => ({ programAddress: COMPUTE_BUDGET, accounts: [], data: new Uint8Array([2, ...u32(units)]) });

/** A v16 instruction: the program's id, the accounts in order, the data. */
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

/** InitMarket's arguments, in wire order (tag 0, `decode_init_market_body`: 218 bytes after the tag). */
export interface InitMarketArgs {
  maxPortfolioAssets: number;
  hMin: bigint;
  hMax: bigint;
  initialPrice: bigint;
  minNonzeroMmReq: bigint;
  minNonzeroImReq: bigint;
  maintenanceMarginBps: bigint;
  initialMarginBps: bigint;
  maxTradingFeeBps: bigint;
  tradeFeeBaseBps: bigint;
  liquidationFeeBps: bigint;
  liquidationFeeCap: bigint;
  minLiquidationAbs: bigint;
  maxPriceMoveBpsPerSlot: bigint;
  maxAccrualDtSlots: bigint;
  maxAbsFundingE9PerSlot: bigint;
  minFundingLifetimeSlots: bigint;
  maxAccountBSettlementChunks: bigint;
  maxBankruptCloseChunks: bigint;
  maxBankruptCloseLifetimeSlots: bigint;
  publicBChunkAtoms: bigint;
  maintenanceFeePerSlot: bigint;
}

/** The author's default market (tests/support/v16_svm.rs `MarketConfig::default()` and `init_market`), one asset. */
export function defaultInitArgs(o: Partial<InitMarketArgs> = {}): InitMarketArgs {
  return {
    maxPortfolioAssets: 1,
    hMin: 0n,
    hMax: 10n,
    initialPrice: 1_000_000n,
    minNonzeroMmReq: 1n,
    minNonzeroImReq: 2n,
    maintenanceMarginBps: 10_000n,
    initialMarginBps: 10_000n,
    maxTradingFeeBps: 10_000n,
    tradeFeeBaseBps: 0n,
    liquidationFeeBps: 0n,
    liquidationFeeCap: 0n,
    minLiquidationAbs: 0n,
    maxPriceMoveBpsPerSlot: 1_000n,
    maxAccrualDtSlots: 4n,
    maxAbsFundingE9PerSlot: 0n,
    minFundingLifetimeSlots: 4n,
    maxAccountBSettlementChunks: 1n,
    maxBankruptCloseChunks: 1n,
    maxBankruptCloseLifetimeSlots: 100n,
    // percolator::MAX_VAULT_TVL
    publicBChunkAtoms: 10_000_000_000_000_000n,
    maintenanceFeePerSlot: 0n,
    ...o,
  };
}

export function initMarketData(a: InitMarketArgs): Buffer {
  return Buffer.concat([
    u8(0),
    u16(a.maxPortfolioAssets),
    u64(a.hMin),
    u64(a.hMax),
    u64(a.initialPrice),
    u128(a.minNonzeroMmReq),
    u128(a.minNonzeroImReq),
    u64(a.maintenanceMarginBps),
    u64(a.initialMarginBps),
    u64(a.maxTradingFeeBps),
    u64(a.tradeFeeBaseBps),
    u64(a.liquidationFeeBps),
    u128(a.liquidationFeeCap),
    u128(a.minLiquidationAbs),
    u64(a.maxPriceMoveBpsPerSlot),
    u64(a.maxAccrualDtSlots),
    u64(a.maxAbsFundingE9PerSlot),
    u64(a.minFundingLifetimeSlots),
    u64(a.maxAccountBSettlementChunks),
    u64(a.maxBankruptCloseChunks),
    u64(a.maxBankruptCloseLifetimeSlots),
    u128(a.publicBChunkAtoms),
    u128(a.maintenanceFeePerSlot),
  ]);
}

/** ConfigureHybridOracle's arguments (tag 34), in wire order. */
export interface HybridArgs {
  asset: number;
  marketId: bigint;
  nowSlot?: bigint;
  nowUnixTs?: bigint;
  count: number;
  flags: number;
  maxStaleness: bigint;
  softStale: bigint;
  halflife: bigint;
  minFee: bigint;
  invert: number;
  unitScale: bigint;
  confBps: bigint;
  /** Three 32-byte feeds (zero past the legs). */
  feeds: Uint8Array[];
  sequence: bigint;
  epoch: bigint;
}

export function hybridData(a: HybridArgs): Buffer {
  const feed = (i: number) => Buffer.from(a.feeds[i] ?? new Uint8Array(32));
  return Buffer.concat([
    u8(34),
    u16(a.asset),
    u64(a.marketId),
    u64(a.nowSlot ?? 1n),
    u64(a.nowUnixTs ?? 1n),
    u8(a.count),
    u8(a.flags),
    u64(a.maxStaleness),
    u64(a.softStale),
    u64(a.halflife),
    u64(a.minFee),
    u8(a.invert),
    u32(Number(a.unitScale)),
    u16(Number(a.confBps)),
    feed(0),
    feed(1),
    feed(2),
    u64(a.sequence),
    u64(a.epoch),
  ]);
}

/** A market's accounts (made by `Diff.newMarket`). */
export interface Market {
  market: Address;
  admin: KeyPairSigner;
  mint: Address;
  /** The vault authority PDA, `[b"vault", market]`. */
  vaultPda: Address;
  bump: number;
  /** The canonical vault: the vault PDA's associated token account of the mint (empty). */
  vault: Address;
}

/** The Associated Token Account program: the original pins each vault to the vault PDA's ATA of the mint. */
/** A portfolio account's full length (9,563 bytes). */
export const PORTFOLIO_LEN = PORTFOLIO.len;
/** The error of the program's instruction (behind the two preamble instructions): custom or built-in. */
export const err = (code: number) => custom(code, 2);
export const errB = (name: string) => builtin(name, 2);

export const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** SPL Token-2022, which the original does not accept as its token program. */
export const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export const ix = {
  /** Tag 0: admin (signer), market (writable, owned by the program), mint. */
  initMarket: (m: Market, a: InitMarketArgs) =>
    instruction(initMarketData(a), [{ address: m.admin.address, signer: m.admin, writable: true }, { address: m.market, writable: true }, { address: m.mint }]),
  /** Tag 1: owner (signer), market (writable), portfolio (writable, owned by the program). */
  initPortfolio: (m: Market, owner: KeyPairSigner, portfolio: Address) =>
    instruction(u8(1), [
      { address: owner.address, signer: owner, writable: true },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
    ]),
  /** Tag 3: owner (signer), market (w), portfolio (w), source token account (w), vault (w), token program. */
  deposit: (
    m: Market,
    owner: KeyPairSigner,
    portfolio: Address,
    source: Address,
    id: bigint,
    sequence: bigint,
    amount: bigint,
    tokenProgram: Address = TOKEN,
  ) =>
    instruction(Buffer.concat([u8(3), u64(id), u64(sequence), u128(amount)]), [
      { address: owner.address, signer: owner, writable: true },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
      { address: source, writable: true },
      { address: m.vault, writable: true },
      { address: tokenProgram },
    ]),
  /**
   * Tag 4: owner (signer), market (w), portfolio (w), destination token account (w), vault (w), the vault authority
   * PDA, token program.
   */
  withdraw: (m: Market, owner: KeyPairSigner, portfolio: Address, dest: Address, id: bigint, sequence: bigint, amount: bigint, tokenProgram: Address = TOKEN) =>
    instruction(Buffer.concat([u8(4), u64(id), u64(sequence), u128(amount)]), [
      { address: owner.address, signer: owner, writable: true },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
      { address: dest, writable: true },
      { address: m.vault, writable: true },
      { address: m.vaultPda },
      { address: tokenProgram },
    ]),
  /** Tag 48: market (w), portfolio (w), and optionally a cranker portfolio (w). Anyone may send it. */
  syncMaintenanceFee: (m: Market, portfolio: Address, nowSlot: bigint, cranker?: Address) =>
    instruction(Buffer.concat([u8(48), u64(nowSlot)]), [
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
      ...(cranker ? [{ address: cranker, writable: true }] : []),
    ]),
  /** Tag 32: current authority (signer), the new authority (a signer unless the key is zero), market (w). */
  updateAuthority: (m: Market, current: KeyPairSigner, incoming: Meta, epoch: bigint, newKey: Address) =>
    instruction(Buffer.concat([u8(32), u64(epoch), key(newKey)]), [
      { address: current.address, signer: current },
      incoming,
      { address: m.market, writable: true },
    ]),
  /** Tag 65: as UpdateAuthority, for one role of one asset. */
  updateAssetAuthority: (m: Market, current: KeyPairSigner, incoming: Meta, asset: number, marketId: bigint, epoch: bigint, kind: number, newKey: Address) =>
    instruction(Buffer.concat([u8(65), u16(asset), u64(marketId), u64(epoch), u8(kind), key(newKey)]), [
      { address: current.address, signer: current },
      incoming,
      { address: m.market, writable: true },
    ]),
  /** Tags 37, 49, 58 (a u16 bps value) and 59 (a u128 fee): admin (signer), market (w). */
  marketPolicy: (m: Market, admin: KeyPairSigner, tag: 37 | 49 | 58 | 59, value: bigint, sequence: bigint, epoch: bigint) =>
    instruction(Buffer.concat([u8(tag), tag === 59 ? u128(value) : u16(Number(value)), u64(sequence), u64(epoch)]), [
      { address: admin.address, signer: admin },
      { address: m.market, writable: true },
    ]),
  /** Tag 51: authority (signer), market (w). */
  backingFeePolicy: (m: Market, authority: KeyPairSigner, domain: number, marketId: bigint, fee: number, share: number, sequence: bigint, epoch: bigint) =>
    instruction(Buffer.concat([u8(51), u16(domain), u64(marketId), u16(fee), u16(share), u64(sequence), u64(epoch)]), [
      { address: authority.address, signer: authority },
      { address: m.market, writable: true },
    ]),
  /** Tag 55: authority (signer), market (w). */
  tradeFeePolicy: (m: Market, authority: KeyPairSigner, fee: bigint, sequence: bigint, epoch: bigint) =>
    instruction(Buffer.concat([u8(55), u64(fee), u64(sequence), u64(epoch)]), [
      { address: authority.address, signer: authority },
      { address: m.market, writable: true },
    ]),
  /** Tag 38: admin (signer), market (w). */
  permissionlessResolve: (m: Market, admin: KeyPairSigner, frontier: bigint, stale: bigint, forceClose: bigint, sequence: bigint, epoch: bigint) =>
    instruction(Buffer.concat([u8(38), u64(frontier), u64(stale), u64(forceClose), u64(sequence), u64(epoch)]), [
      { address: admin.address, signer: admin },
      { address: m.market, writable: true },
    ]),
  /** Tag 60: authority (signer), market (w), primary mint, secondary mint, then the old vaults. */
  baseUnitMints: (m: Market, authority: KeyPairSigner, primary: Address, secondary: Address, epoch: bigint, oldVaults: Address[] = []) =>
    instruction(Buffer.concat([u8(60), key(primary), key(secondary), u64(epoch)]), [
      { address: authority.address, signer: authority },
      { address: m.market, writable: true },
      { address: primary },
      { address: secondary },
      ...oldVaults.map((v) => ({ address: v })),
    ]),
  /** Tag 53: authority (signer), market (w), ledger (w). */
  syncBackingLedger: (m: Market, authority: KeyPairSigner, ledger: Address, domain: number) =>
    instruction(Buffer.concat([u8(53), u16(domain)]), [
      { address: authority.address, signer: authority },
      { address: m.market, writable: true },
      { address: ledger, writable: true },
    ]),
  /** Tag 54: authority (signer), market (w), ledger (w). */
  syncInsuranceLedger: (m: Market, authority: KeyPairSigner, ledger: Address) =>
    instruction(u8(54), [
      { address: authority.address, signer: authority },
      { address: m.market, writable: true },
      { address: ledger, writable: true },
    ]),
  /**
   * Tag 34 (decode_configure_hybrid_oracle_body, 179 bytes after the tag): admin (signer), market (w), then one oracle
   * account per leg (`legs`, read-only).
   */
  configureHybridOracle: (m: Market, admin: KeyPairSigner, a: HybridArgs, legs: Address[]) =>
    instruction(hybridData(a), [{ address: admin.address, signer: admin }, { address: m.market, writable: true }, ...legs.map((l) => ({ address: l }))]),
  /** Tag 35: authority (signer), market (w). */
  configureEwmaMark: (
    m: Market,
    authority: KeyPairSigner,
    a: { asset: number; marketId: bigint; nowSlot?: bigint; mark: bigint; halflife: bigint; minFee: bigint; sequence: bigint; epoch: bigint },
  ) =>
    instruction(
      Buffer.concat([u8(35), u16(a.asset), u64(a.marketId), u64(a.nowSlot ?? 1n), u64(a.mark), u64(a.halflife), u64(a.minFee), u64(a.sequence), u64(a.epoch)]),
      [
        { address: authority.address, signer: authority },
        { address: m.market, writable: true },
      ],
    ),
  /** Tag 62: authority (signer), market (w). */
  configureAuthMark: (
    m: Market,
    authority: KeyPairSigner,
    a: { asset: number; marketId: bigint; nowSlot?: bigint; mark: bigint; sequence: bigint; epoch: bigint },
  ) =>
    instruction(Buffer.concat([u8(62), u16(a.asset), u64(a.marketId), u64(a.nowSlot ?? 1n), u64(a.mark), u64(a.sequence), u64(a.epoch)]), [
      { address: authority.address, signer: authority },
      { address: m.market, writable: true },
    ]),
  /** Tags 36 (PushEwmaMark) and 63 (PushAuthMark): authority (signer), market (w). */
  pushMark: (
    tag: 36 | 63,
    m: Market,
    authority: KeyPairSigner,
    a: { asset: number; marketId: bigint; nowSlot?: bigint; mark: bigint; sequence: bigint; epoch: bigint },
  ) =>
    instruction(Buffer.concat([u8(tag), u16(a.asset), u64(a.marketId), u64(a.nowSlot ?? 1n), u64(a.mark), u64(a.sequence), u64(a.epoch)]), [
      { address: authority.address, signer: authority },
      { address: m.market, writable: true },
    ]),
  /** Tag 68: LP owner (signer), market, LP portfolio (w), then matcher program, context, delegate (when given). */
  setMatcherConfig: (
    m: Market,
    owner: KeyPairSigner,
    portfolio: Address,
    a: { id: bigint; sequence: bigint; epoch: bigint; frontier: bigint; enabled: number; cap: number; expiry: bigint },
    matcher?: { program: Address; context: Address; delegate: Address },
  ) =>
    instruction(Buffer.concat([u8(68), u64(a.id), u64(a.sequence), u64(a.epoch), u64(a.frontier), u8(a.enabled), u16(a.cap), u64(a.expiry)]), [
      { address: owner.address, signer: owner, writable: true },
      { address: m.market },
      { address: portfolio, writable: true },
      ...(matcher ? [{ address: matcher.program }, { address: matcher.context }, { address: matcher.delegate }] : []),
    ]),
  /**
   * Tag 40: authority (signer), market (w), then for a permissionless activation's fee the source token account (w),
   * the vault (w) and the token program.
   */
  assetLifecycle: (
    m: Market,
    authority: KeyPairSigner,
    a: {
      action: number;
      asset: number;
      marketId: bigint;
      epoch: bigint;
      nowSlot?: bigint;
      price?: bigint;
      maxInitFee?: bigint;
      authorities?: [Address, Address, Address, Address];
    },
    fee?: { source: Address; tokenProgram?: Address },
  ) => {
    const auth = a.authorities ?? [authority.address, authority.address, authority.address, authority.address];
    return instruction(
      Buffer.concat([
        u8(40),
        u8(a.action),
        u16(a.asset),
        u64(a.marketId),
        u64(a.epoch),
        u64(a.nowSlot ?? 0n),
        u64(a.price ?? 0n),
        u128(a.maxInitFee ?? 0n),
        ...auth.map(key),
      ]),
      [
        { address: authority.address, signer: authority, writable: true },
        { address: m.market, writable: true },
        ...(fee ? [{ address: fee.source, writable: true }, { address: m.vault, writable: true }, { address: fee.tokenProgram ?? TOKEN }] : []),
      ],
    );
  },
  /** Tag 69: authority (signer), market (w). */
  restartAssetOracle: (
    m: Market,
    authority: KeyPairSigner,
    a: { asset: number; marketId: bigint; nowSlot?: bigint; price: bigint; sequence: bigint; epoch: bigint },
  ) =>
    instruction(Buffer.concat([u8(69), u16(a.asset), u64(a.marketId), u64(a.nowSlot ?? 1n), u64(a.price), u64(a.sequence), u64(a.epoch)]), [
      { address: authority.address, signer: authority },
      { address: m.market, writable: true },
    ]),
  /** Tag 70: authority (signer), market (w). */
  canonicalizeSpentBacking: (m: Market, authority: KeyPairSigner, asset: number, marketId: bigint, epoch: bigint) =>
    instruction(Buffer.concat([u8(70), u16(asset), u64(marketId), u64(epoch)]), [
      { address: authority.address, signer: authority },
      { address: m.market, writable: true },
    ]),
  /**
   * Tag 6: signer A, signer B, market (w), portfolio A (w), portfolio B (w). A positive size makes A long; `exec` is
   * the reported print, `fee` the signed fee rate, `cap` the backing-fee cap.
   */
  tradeNoCpi: (
    m: Market,
    a: KeyPairSigner,
    b: KeyPairSigner,
    pa: Address,
    pb: Address,
    t: { aId: bigint; aEpoch: bigint; bId: bigint; bEpoch: bigint; asset: number; marketId: bigint; size: bigint; exec: bigint; fee: bigint; cap: number },
  ) =>
    instruction(
      Buffer.concat([
        u8(6),
        u64(t.aId),
        u64(t.aEpoch),
        u64(t.bId),
        u64(t.bEpoch),
        u16(t.asset),
        u64(t.marketId),
        u128(BigInt.asUintN(128, t.size)),
        u64(t.exec),
        u64(t.fee),
        u16(t.cap),
      ]),
      [
        { address: a.address, signer: a },
        { address: b.address, signer: b },
        { address: m.market, writable: true },
        { address: pa, writable: true },
        { address: pb, writable: true },
      ],
    ),
  /**
   * Tag 66: signer A, signer B, market (w), portfolio A (w), portfolio B (w); the legs (asset, market id, signed size,
   * print, fee each, A long for a positive size), then both ids and position epochs.
   */
  batchTradeNoCpi: (
    m: Market,
    a: KeyPairSigner,
    b: KeyPairSigner,
    pa: Address,
    pb: Address,
    t: { aId: bigint; aEpoch: bigint; bId: bigint; bEpoch: bigint; legs: { asset: number; marketId: bigint; size: bigint; exec: bigint; fee: bigint }[] },
  ) =>
    instruction(
      Buffer.concat([
        u8(66),
        u8(t.legs.length),
        ...t.legs.map((l) => Buffer.concat([u16(l.asset), u64(l.marketId), u128(BigInt.asUintN(128, l.size)), u64(l.exec), u64(l.fee)])),
        u64(t.aId),
        u64(t.aEpoch),
        u64(t.bId),
        u64(t.bEpoch),
      ]),
      [
        { address: a.address, signer: a },
        { address: b.address, signer: b },
        { address: m.market, writable: true },
        { address: pa, writable: true },
        { address: pb, writable: true },
      ],
    ),
  /**
   * Tag 10: signer A, market (w), portfolio A (w), portfolio B (w), the matcher program, its context (w), the delegate,
   * then the tail (each with its own flags).
   */
  tradeCpi: (
    m: Market,
    a: KeyPairSigner,
    pa: Address,
    pb: Address,
    matcher: { program: Address; context: Address; delegate: Address },
    t: {
      aId: bigint;
      aEpoch: bigint;
      bId: bigint;
      bEpoch: bigint;
      bSequence: bigint;
      asset: number;
      marketId: bigint;
      size: bigint;
      fee: bigint;
      limit: bigint;
      cap: number;
    },
    tail: Meta[] = [],
  ) =>
    instruction(
      Buffer.concat([
        u8(10),
        u64(t.aId),
        u64(t.aEpoch),
        u64(t.bId),
        u64(t.bEpoch),
        u64(t.bSequence),
        u16(t.asset),
        u64(t.marketId),
        u128(BigInt.asUintN(128, t.size)),
        u64(t.fee),
        u64(t.limit),
        u16(t.cap),
      ]),
      [
        { address: a.address, signer: a },
        { address: m.market, writable: true },
        { address: pa, writable: true },
        { address: pb, writable: true },
        { address: matcher.program },
        { address: matcher.context, writable: true },
        { address: matcher.delegate },
        ...tail,
      ],
    ),
  /**
   * Tag 67: the accounts of TradeCpi; the legs (asset, market id, signed size, fee, limit price each), then both ids
   * and position epochs, B's matcher sequence, the slippage and fee caps.
   */
  batchTradeCpi: (
    m: Market,
    a: KeyPairSigner,
    pa: Address,
    pb: Address,
    matcher: { program: Address; context: Address; delegate: Address },
    t: {
      aId: bigint;
      aEpoch: bigint;
      bId: bigint;
      bEpoch: bigint;
      bSequence: bigint;
      maxSlippage: bigint;
      maxFee: bigint;
      legs: { asset: number; marketId: bigint; size: bigint; fee: bigint; limit: bigint }[];
    },
    tail: Meta[] = [],
  ) =>
    instruction(
      Buffer.concat([
        u8(67),
        u8(t.legs.length),
        ...t.legs.map((l) => Buffer.concat([u16(l.asset), u64(l.marketId), u128(BigInt.asUintN(128, l.size)), u64(l.fee), u64(l.limit)])),
        u64(t.aId),
        u64(t.aEpoch),
        u64(t.bId),
        u64(t.bEpoch),
        u64(t.bSequence),
        u128(t.maxSlippage),
        u128(t.maxFee),
      ]),
      [
        { address: a.address, signer: a },
        { address: m.market, writable: true },
        { address: pa, writable: true },
        { address: pb, writable: true },
        { address: matcher.program },
        { address: matcher.context, writable: true },
        { address: matcher.delegate },
        ...tail,
      ],
    ),
  /** Tag 28: owner (signer), market (w), portfolio (w). */
  /** Tag 43: owner (signer), market (w), portfolio (w); portfolio_id, position_epoch u64, asset u16, b_delta_budget u128. */
  forfeitRecoveryLeg: (m: Market, owner: KeyPairSigner, portfolio: Address, id: bigint, epoch: bigint, asset: number, budget: bigint) =>
    instruction(Buffer.concat([u8(43), u64(id), u64(epoch), u16(asset), u128(budget)]), [
      { address: owner.address, signer: owner, writable: true },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
    ]),
  convertReleasedPnl: (m: Market, owner: KeyPairSigner, portfolio: Address, id: bigint, epoch: bigint, amount: bigint) =>
    instruction(Buffer.concat([u8(28), u64(id), u64(epoch), u128(amount)]), [
      { address: owner.address, signer: owner, writable: true },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
    ]),
  /**
   * Tag 5: owner (a signer when given as a key pair: the cranker's portfolio needs it), market (w), portfolio (w), then
   * the oracle accounts of the hints in order and, optionally, the cranker's portfolio (w). Each hint is an asset and
   * how many oracle accounts follow for it.
   */
  crank: (
    m: Market,
    owner: KeyPairSigner | Address,
    portfolio: Address,
    nowSlot: bigint,
    hints: { asset: number; accounts: number }[],
    tail: Address[] = [],
    cranker?: Address,
  ) =>
    instruction(Buffer.concat([u8(5), u64(nowSlot), u8(hints.length), ...hints.map((h) => Buffer.concat([u16(h.asset), u8(h.accounts)]))]), [
      typeof owner === "string" ? { address: owner } : { address: owner.address, signer: owner },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
      ...tail.map((a) => ({ address: a })),
      ...(cranker ? [{ address: cranker, writable: true }] : []),
    ]),
  /**
   * Tag 30 (CloseResolved): owner (a signer when given as a key pair), market (w), portfolio (w), destination token
   * account (w), vault (w), vault authority, token program; fee_rate_per_slot u128 (unused by the program).
   */
  closeResolved: (m: Market, owner: KeyPairSigner | Address, portfolio: Address, dest: Address, feeRate = 0n, tokenProgram: Address = TOKEN) =>
    instruction(Buffer.concat([u8(30), u128(feeRate)]), [
      typeof owner === "string" ? { address: owner } : { address: owner.address, signer: owner },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
      { address: dest, writable: true },
      { address: m.vault, writable: true },
      { address: m.vaultPda },
      { address: tokenProgram },
    ]),
  /** Tag 5 on a Resolved market: as CloseResolved's accounts, with at most one hint (an asset with no oracle account). */
  resolvedCrank: (m: Market, owner: KeyPairSigner | Address, portfolio: Address, dest: Address, hint?: number, tokenProgram: Address = TOKEN) =>
    instruction(Buffer.concat([u8(5), u64(0n), u8(hint === undefined ? 0 : 1), ...(hint === undefined ? [] : [Buffer.concat([u16(hint), u8(0)])])]), [
      typeof owner === "string" ? { address: owner } : { address: owner.address, signer: owner },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
      { address: dest, writable: true },
      { address: m.vault, writable: true },
      { address: m.vaultPda },
      { address: tokenProgram },
    ]),
  /** Tag 44: owner (signer), market (w), portfolio (w); portfolio_id, position_epoch u64, asset u16, reduce_q u128. */
  rebalanceReduce: (m: Market, owner: KeyPairSigner, portfolio: Address, id: bigint, epoch: bigint, asset: number, reduceQ: bigint) =>
    instruction(Buffer.concat([u8(44), u64(id), u64(epoch), u16(asset), u128(reduceQ)]), [
      { address: owner.address, signer: owner, writable: true },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
    ]),
  /**
   * Tag 42: owner (signer), market (w), portfolio (w), and for a deposit the source token account (w), the vault (w)
   * and the token program; portfolio_id, position_epoch u64, optional_deposit u128.
   */
  cureAndCancelClose: (
    m: Market,
    owner: KeyPairSigner,
    portfolio: Address,
    id: bigint,
    epoch: bigint,
    deposit: bigint,
    source?: Address,
    tokenProgram: Address = TOKEN,
  ) =>
    instruction(Buffer.concat([u8(42), u64(id), u64(epoch), u128(deposit)]), [
      { address: owner.address, signer: owner, writable: true },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
      ...(source ? [{ address: source, writable: true }, { address: m.vault, writable: true }, { address: tokenProgram }] : []),
    ]),
  /** Tag 19: admin (signer), market (w); asset_generation_frontier, authority_epoch u64. */
  resolveMarket: (m: Market, admin: KeyPairSigner, frontier: bigint, epoch: bigint) =>
    instruction(Buffer.concat([u8(19), u64(frontier), u64(epoch)]), [
      { address: admin.address, signer: admin, writable: true },
      { address: m.market, writable: true },
    ]),
  /** Tag 39: market (w); now_slot u64 (the Clock's is used). Anyone may send it. */
  resolveStalePermissionless: (m: Market, nowSlot = 0n) => instruction(Buffer.concat([u8(39), u64(nowSlot)]), [{ address: m.market, writable: true }]),
  /** Tag 45: market (w); anyone may send it. */
  finalizeResetSide: (m: Market, asset: number, side: number) =>
    instruction(Buffer.concat([u8(45), u16(asset), u8(side)]), [{ address: m.market, writable: true }]),
  /**
   * Tags 9 (TopUpInsurance: asset 0) and 56 (TopUpInsuranceDomain: `domain`): signer, market (w), source token account
   * (w), vault (w), token program, and optionally an insurance ledger (w); [domain u16,] market_id, intent_id,
   * authority_epoch u64, amount u128.
   */
  topUpInsurance: (
    m: Market,
    signer: KeyPairSigner,
    source: Address,
    a: { domain?: number; marketId: bigint; intent: bigint; epoch: bigint; amount: bigint },
    ledger?: Address,
    tokenProgram: Address = TOKEN,
  ) =>
    instruction(
      Buffer.concat([
        u8(a.domain === undefined ? 9 : 56),
        ...(a.domain === undefined ? [] : [u16(a.domain)]),
        u64(a.marketId),
        u64(a.intent),
        u64(a.epoch),
        u128(a.amount),
      ]),
      [
        { address: signer.address, signer },
        { address: m.market, writable: true },
        { address: source, writable: true },
        { address: m.vault, writable: true },
        { address: tokenProgram },
        ...(ledger ? [{ address: ledger, writable: true }] : []),
      ],
    ),
  /** Tag 24 (TopUpBackingBucket): accounts as TopUpInsurance's (the ledger a backing-domain ledger). */
  topUpBacking: (
    m: Market,
    signer: KeyPairSigner,
    source: Address,
    a: { domain: number; marketId: bigint; intent: bigint; epoch: bigint; fee: number; share: number; amount: bigint; expiry: bigint },
    ledger?: Address,
    tokenProgram: Address = TOKEN,
  ) =>
    instruction(Buffer.concat([u8(24), u16(a.domain), u64(a.marketId), u64(a.intent), u64(a.epoch), u16(a.fee), u16(a.share), u128(a.amount), u64(a.expiry)]), [
      { address: signer.address, signer },
      { address: m.market, writable: true },
      { address: source, writable: true },
      { address: m.vault, writable: true },
      { address: tokenProgram },
      ...(ledger ? [{ address: ledger, writable: true }] : []),
    ]),
  /**
   * Tags 50 (WithdrawBackingBucket) and 57 (WithdrawInsuranceAsset: `index` an asset): authority (a signer when a key
   * pair), market (w), destination (w), vault (w), vault authority, token program, optionally a ledger (w);
   * domain or asset u16, market_id, authority_epoch u64, amount u128.
   */
  withdrawReserve: (
    tag: 50 | 57,
    m: Market,
    authority: KeyPairSigner | Address,
    dest: Address,
    a: { index: number; marketId: bigint; epoch: bigint; amount: bigint },
    ledger?: Address,
    tokenProgram: Address = TOKEN,
  ) =>
    instruction(Buffer.concat([u8(tag), u16(a.index), u64(a.marketId), u64(a.epoch), u128(a.amount)]), [
      typeof authority === "string" ? { address: authority } : { address: authority.address, signer: authority },
      { address: m.market, writable: true },
      { address: dest, writable: true },
      { address: m.vault, writable: true },
      { address: m.vaultPda },
      { address: tokenProgram },
      ...(ledger ? [{ address: ledger, writable: true }] : []),
    ]),
  /** Tag 52 (WithdrawBackingBucketEarnings): authority, market (w), ledger (w), destination (w), vault (w), vault authority, token program. */
  withdrawEarnings: (
    m: Market,
    authority: KeyPairSigner | Address,
    ledger: Address,
    dest: Address,
    a: { index: number; marketId: bigint; epoch: bigint; amount: bigint },
    tokenProgram: Address = TOKEN,
  ) =>
    instruction(Buffer.concat([u8(52), u16(a.index), u64(a.marketId), u64(a.epoch), u128(a.amount)]), [
      typeof authority === "string" ? { address: authority } : { address: authority.address, signer: authority },
      { address: m.market, writable: true },
      { address: ledger, writable: true },
      { address: dest, writable: true },
      { address: m.vault, writable: true },
      { address: m.vaultPda },
      { address: tokenProgram },
    ]),
  /**
   * Tag 13 (CloseSlab): admin (signer, w), market (w), vault (w), vault authority, destination (w), token program, then
   * the secondary vault and destination (w) when the market has a second mint, the primary mint (w) when retired
   * insurance is burned, and the residue destination (w) for a native mint; authority_epoch u64.
   */
  closeSlab: (m: Market, admin: KeyPairSigner, dest: Address, epoch: bigint, tail: Address[] = [], tokenProgram: Address = TOKEN) =>
    instruction(Buffer.concat([u8(13), u64(epoch)]), [
      { address: admin.address, signer: admin, writable: true },
      { address: m.market, writable: true },
      { address: m.vault, writable: true },
      { address: m.vaultPda },
      { address: dest, writable: true },
      { address: tokenProgram },
      ...tail.map((a) => ({ address: a, writable: true })),
    ]),
  /** Tag 46 (ClaimResolvedPayoutTopup): owner, market (w), portfolio (w), then for a payout the destination (w), the
   * vault (w), the vault authority and the token program. */
  claimPayoutTopup: (m: Market, owner: KeyPairSigner | Address, portfolio: Address, dest?: Address, tokenProgram: Address = TOKEN) =>
    instruction(u8(46), [
      typeof owner === "string" ? { address: owner } : { address: owner.address, signer: owner },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
      ...(dest ? [{ address: dest, writable: true }, { address: m.vault, writable: true }, { address: m.vaultPda }, { address: tokenProgram }] : []),
    ]),
  /** Tag 61 (SwapSecondaryForPrimary): authority (signer), market, primary source (w), primary vault (w), secondary
   * destination (w), secondary vault (w), vault authority, token program; amount u128, authority_epoch u64. */
  swapSecondary: (
    m: Market,
    authority: KeyPairSigner,
    primarySource: Address,
    secondaryDest: Address,
    secondaryVault: Address,
    amount: bigint,
    epoch: bigint,
    tokenProgram: Address = TOKEN,
  ) =>
    instruction(Buffer.concat([u8(61), u128(amount), u64(epoch)]), [
      { address: authority.address, signer: authority },
      { address: m.market },
      { address: primarySource, writable: true },
      { address: m.vault, writable: true },
      { address: secondaryDest, writable: true },
      { address: secondaryVault, writable: true },
      { address: m.vaultPda },
      { address: tokenProgram },
    ]),
  /** Tag 64 (ForceCloseAbandonedAsset): cranker (signer), market (w), portfolio a (w), portfolio b (w); asset u16,
   * now_slot u64, close_q u128. */
  forceCloseAbandoned: (m: Market, cranker: KeyPairSigner, a: Address, b: Address, asset: number, closeQ: bigint, nowSlot = 0n) =>
    instruction(Buffer.concat([u8(64), u16(asset), u64(nowSlot), u128(closeQ)]), [
      { address: cranker.address, signer: cranker },
      { address: m.market, writable: true },
      { address: a, writable: true },
      { address: b, writable: true },
    ]),
  /** Tag 8: closer (signer), market (w), portfolio (w). */
  closePortfolio: (m: Market, closer: KeyPairSigner, portfolio: Address, id: bigint, sequence: bigint, epoch: bigint) =>
    instruction(Buffer.concat([u8(8), u64(id), u64(sequence), u64(epoch)]), [
      { address: closer.address, signer: closer, writable: true },
      { address: m.market, writable: true },
      { address: portfolio, writable: true },
    ]),
};

// ---- Reading accounts -----------------------------------------------------------------------------------------------------

/** A little-endian unsigned integer of `size` bytes at `at`. */
export function readUint(b: Uint8Array, at: number, size: number): bigint {
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i]!);
  return v;
}

/** A field of a struct of the layout table, `path` naming nested fields (`config.max_market_slots`), at `base`. */
export function field(b: Uint8Array, base: number, struct: string, path: string): bigint {
  const at = base + offsetOf(struct, path);
  let type = struct;
  for (const part of path.split(".")) type = layout(type).find((r) => r.name === part)!.type;
  return readUint(b, at, sizeOf(type));
}

/** The 32 bytes of a key field as an address-comparable buffer. */
export const keyAt = (b: Uint8Array, at: number) => Buffer.from(b.subarray(at, at + 32));

/** Offsets of the market account's parts: the wrapper config, the group header and asset slot `i` (its engine part). */
export const marketAt = {
  wrapper: (path: string) => MARKET.wrapper + offsetOf("WrapperConfig", path),
  group: (path: string) => MARKET.group + offsetOf("GroupHeader", path),
  slot: (i: number) => MARKET.slots + i * MARKET.slotLen,
  /** A field of slot `i`'s oracle profile (the first 424 bytes of its wrapper). */
  profile: (i: number, path: string) => MARKET.slots + i * MARKET.slotLen + offsetOf("AssetOracleProfile", path),
  /** A field of slot `i`'s engine slot. */
  engine: (i: number, path: string) => MARKET.slots + i * MARKET.slotLen + offsetOf("AssetSlot", "engine") + offsetOf("EngineAssetSlot", path),
};
export const portfolioAt = (path: string) => PORTFOLIO.state + offsetOf("Portfolio", path);

/** Which part of a market account an offset falls in (for failure messages). */
export function describeMarket(at: number): string {
  const find = (struct: string, base: number) => {
    const rows = layout(struct).filter((r) => r.offset + base <= at);
    const f = rows.at(-1);
    return f ? `${f.name}+${at - base - f.offset}` : `+${at - base}`;
  };
  if (at < MARKET.wrapper) return `header+${at}`;
  if (at < MARKET.group) return `wrapper.${find("WrapperConfig", MARKET.wrapper)}`;
  if (at < MARKET.slots) return `group.${find("GroupHeader", MARKET.group)}`;
  const i = Math.floor((at - MARKET.slots) / MARKET.slotLen);
  const within = MARKET.slots + i * MARKET.slotLen;
  return at - within < 512 ? `slot[${i}].wrapper+${at - within}` : `slot[${i}].engine.${find("EngineAssetSlot", within + 512)}`;
}

// ---- The two VMs --------------------------------------------------------------------------------------------------------

/** How compute units are judged: `fewer` (the port below the reference on success) or `record` (only recorded). */
export type CuRule = "fewer" | "record";

/** One send's options: accounts to compare beyond those named, the preamble's heap frame and compute-unit limit. */
export interface SendOptions {
  watch?: Address[];
  /** RequestHeapFrame bytes (default 256 KiB); null leaves the instruction out (the runtime's 32 KiB). */
  heap?: number | null;
  /** SetComputeUnitLimit (default 1,400,000); null leaves it out. */
  cuLimit?: number | null;
}

/**
 * PERCOLATOR_V16_PORT_COVERAGE=<report file>: the port program is a copy with branch probes in the settlement's files
 * (or those PERCOLATOR_V16_PORT_COVERAGE_FILES names)
 * (scripts/percolator-v16-reference/coverage.ts); its probe lines are left out of the log comparison, its compute units
 * only recorded (the probes cost them), and the probes the compared transactions reached are reported (the file is
 * rewritten after each).
 */
const COVERAGE = process.env.PERCOLATOR_V16_PORT_COVERAGE;
const PROBE_LINE = `Program log: 0x${PROBE_TAG.toString(16)}, `;

/** The runtime's compute-unit line of a program invocation, whole (`Program <id> consumed <n> of <m> compute units`). */
const CU_LINE = /^Program [1-9A-HJ-NP-Za-km-z]{32,44} consumed \d+ of \d+ compute units$/;
/**
 * The log lines compared: all but the runtime's compute-unit lines (matched whole, so that a program's own line ending
 * in the same words is still compared). On the port's side of a coverage run (PERCOLATOR_V16_PORT_COVERAGE) the branch
 * probes' lines are dropped too; in every other run nothing else is, so an extra line of the port is a difference
 * whatever it begins with.
 */
export function lines(r: Result, probes = false): string[] {
  return meta(r)
    .logs()
    .filter((l) => !CU_LINE.test(l) && !(probes && l.startsWith(PROBE_LINE)));
}
let coverage: { file: string; probes: Probe[]; hit: Map<number, number> } | undefined;
function portCoverage(): { file: string; probes: Probe[]; hit: Map<number, number> } {
  if (!coverage) {
    // PERCOLATOR_V16_PORT_COVERAGE_FILES=<a,b,…>: other port files to probe (the settlement's by default).
    const files = process.env.PERCOLATOR_V16_PORT_COVERAGE_FILES?.split(",") ?? SETTLEMENT_FILES;
    const c = instrumentPort(PORT, files);
    coverage = { file: c.fixture, probes: c.probes, hit: new Map() };
  }
  return coverage;
}

/** The reference alone (a LiteSVM with the reference program and the matchers), for tests of its own behaviour. */
export function referenceVm(): LiteSVM {
  const vm = new LiteSVM();
  vm.addProgram(PROGRAM, new Uint8Array(readFileSync(REFERENCE)));
  for (const m of Object.values(MATCHERS)) vm.addProgram(m.id, new Uint8Array(readFileSync(m.file)));
  vm.setClock(new Clock(SLOT, UNIX_TIMESTAMP - 1000n, 700n, 701n, UNIX_TIMESTAMP));
  vm.withLogBytesLimit();
  return vm;
}

/**
 * The reference and the port side by side, the accounts made in both, and the comparison. `rows` keeps every compared
 * transaction's compute units in order, `cu` the last of each label.
 */
export class Diff {
  readonly cu: Record<string, [bigint, bigint]> = {};
  readonly rows: CuRow[] = [];
  compared = 0;
  /** The reference's log lines of the last compared transaction (for messages). */
  lastLogs = "";
  last: Result | undefined;
  slot = SLOT;
  unixTimestamp = UNIX_TIMESTAMP;
  private constructor(
    readonly reference: LiteSVM,
    readonly port: LiteSVM,
    readonly cuRule: CuRule,
    private readonly newKey: () => Promise<KeyPairSigner>,
    /** What the second VM runs: the port, or the reference again (the harness's own check). */
    readonly which: "port" | "reference" = "port",
  ) {}

  /**
   * Both VMs. `port` picks the second program: the TypeSOL port (showcase/mainnet/percolator-v16/percolator.ts, the
   * default) or `"reference"`, the reference binary again, which checks the harness itself (the two sides must then
   * agree on everything, compute units included; `cu` defaults to `record` there).
   */
  static async create(o: { port?: "port" | "reference"; cu?: CuRule; keys?: () => Promise<KeyPairSigner> } = {}): Promise<Diff> {
    const which = o.port ?? "port";
    const reference = referenceVm();
    let port: LiteSVM;
    if (which === "reference") port = referenceVm();
    else {
      port = loadPort(COVERAGE ? portCoverage().file : PORT);
      for (const m of Object.values(MATCHERS)) port.addProgram(m.id, new Uint8Array(readFileSync(m.file)));
      port.withLogBytesLimit();
      if (COVERAGE) {
        const budget = new ComputeBudget();
        budget.computeUnitLimit = 100_000_000n;
        port = port.withComputeBudget(budget);
      }
    }
    const d = new Diff(reference, port, o.cu ?? (which === "reference" || COVERAGE ? "record" : "fewer"), o.keys ?? defaultKeys, which);
    d.setClock(SLOT, UNIX_TIMESTAMP);
    return d;
  }

  get vms(): readonly [LiteSVM, LiteSVM] {
    return [this.reference, this.port];
  }

  /** Programs added to both VMs after `create` (a test's own matchers), loaded into the raised reference too. */
  private readonly programs: [Address, Uint8Array][] = [];

  /** A program loaded into both VMs (and into the reference run under a raised budget, `send`) at `id`. */
  addProgram(id: Address, so: Uint8Array): void {
    this.programs.push([id, so]);
    for (const vm of this.vms) vm.addProgram(id, new Uint8Array(so));
    this.raisedVm?.addProgram(id, new Uint8Array(so));
  }

  /** Both VMs' Clock at `slot` and `unixTimestamp`. */
  setClock(slot: bigint, unixTimestamp: bigint = this.unixTimestamp + (slot - this.slot) / 2n): void {
    this.slot = slot;
    this.unixTimestamp = unixTimestamp;
    for (const vm of this.vms) vm.setClock(new Clock(slot, unixTimestamp - 1000n, 700n, 701n, unixTimestamp));
  }

  /**
   * A keypair with `sol` SOL in both VMs: a system account written directly (LiteSVM's airdrop draws on a finite
   * faucet, which a long run of set-ups empties).
   */
  async funded(sol = 100n): Promise<KeyPairSigner> {
    const k = await this.newKey();
    this.write(k.address, SYSTEM, new Uint8Array(0), sol * SOL);
    return k;
  }

  async address(): Promise<Address> {
    return (await this.newKey()).address;
  }

  /** Write the same account into both VMs (rent-exempt for its size unless `lamportsHeld` is given). */
  write(at: Address, owner: Address, data: Uint8Array, lamportsHeld?: bigint, executable = false): void {
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

  /** An account's data in the reference (a copy). */
  data(a: Address): Buffer {
    const acct = this.reference.getAccount(a);
    if (!acct.exists) throw new Error(`${a} does not exist`);
    return Buffer.from(acct.data);
  }

  /** Change an account's bytes in both VMs (its lamports and owner kept unless given). */
  patch(a: Address, edit: (data: Buffer) => void, o: { lamports?: bigint; owner?: Address } = {}): void {
    const acct = this.reference.getAccount(a);
    if (!acct.exists) throw new Error(`${a} does not exist`);
    const data = Buffer.from(acct.data);
    edit(data);
    this.write(a, o.owner ?? acct.programAddress, data, o.lamports ?? BigInt(acct.lamports));
  }

  /**
   * The account is the same in both VMs: existence, lamports, owner, executable flag, length and bytes. A large account
   * that differs is reported by its first differing bytes and the fields they fall in, not by its hex.
   */
  expectSame(at: Address, message: string, reference: LiteSVM = this.reference): void {
    const [o, p] = [reference.getAccount(at), this.port.getAccount(at)];
    const head = (a: typeof o) =>
      a.exists ? `lamports ${a.lamports} owner ${a.programAddress} executable ${a.executable} length ${a.data.length}` : "missing";
    expect(head(p), `${message}: account`).toBe(head(o));
    if (!o.exists || !p.exists || Buffer.compare(o.data, p.data) === 0) return;
    const diffs: string[] = [];
    for (let i = 0; i < o.data.length && diffs.length < 16; i++)
      if (o.data[i] !== p.data[i]) diffs.push(`@${i} (${this.describe(at, i)}): reference ${o.data[i]} port ${p.data[i]}`);
    expect(diffs.join("\n"), `${message}: data`).toBe("");
  }

  /** Which field an offset of an account falls in: market offsets by the layout table, others by offset. */
  describe(at: Address, offset: number): string {
    const d = this.reference.getAccount(at);
    if (d.exists && d.programAddress === PROGRAM && d.data.length >= MARKET.slots && d.data[10] === 1) return describeMarket(offset);
    if (d.exists && d.programAddress === PROGRAM && d.data[10] === 2 && offset >= PORTFOLIO.state && offset < PORTFOLIO.matcherConfig) {
      const rows = layout("Portfolio").filter((r) => r.offset + PORTFOLIO.state <= offset);
      const f = rows.at(-1)!;
      return `portfolio.${f.name}+${offset - PORTFOLIO.state - f.offset}`;
    }
    return `+${offset}`;
  }

  /** The preamble and the instructions: what `send` gives both VMs. */
  transaction(ixs: Instruction[], o: SendOptions = {}): Instruction[] {
    const heap = o.heap === undefined ? HEAP_FRAME : o.heap;
    const cuLimit = o.cuLimit === undefined ? CU_LIMIT : o.cuLimit;
    return [...(heap === null ? [] : [requestHeapFrame(heap)]), ...(cuLimit === null ? [] : [computeUnitLimit(cuLimit)]), ...ixs];
  }

  /**
   * Send to both (behind the preamble) and compare (see `compare`). Returns the reference's outcome. Where the
   * reference runs out of compute units and the port succeeds, the transaction is run again in a third VM: the
   * reference under a compute budget of RAISED_CU_LIMIT (`raisedReference`), every account the comparison covers (the
   * fee payer, the transaction's accounts, `watch`) set first to exactly what the reference held before the
   * transaction, an account that did not exist then removed; the port's result is then compared whole with that run
   * (outcome, logs, inner instructions, return data, and each account as the third VM left it, a closed one as
   * missing), the reference's accounts take that run's (a closed one removed), and the case is recorded in `raised`
   * (its label, both compute units) and returned as "ok".
   */
  async send(label: string, payer: KeyPairSigner, ixs: Instruction[], o: SendOptions = {}): Promise<string> {
    const tx = this.transaction(ixs, o);
    const watch = o.watch ?? [];
    const before = this.snapshot(this.named(payer, tx, watch));
    const [a, b] = [await sendTx(this.reference, payer, tx), await sendTx(this.port, payer, tx)];
    if (
      outcome(a) !== "ok" &&
      outcome(b) === "ok" &&
      meta(a)
        .logs()
        .some((l) => l.includes("exceeded CUs meter"))
    ) {
      const vm = this.raisedReference();
      this.restore(vm, before);
      const c = await sendTx(vm, payer, tx);
      const got = this.compare(`${label} (the reference under a raised compute budget)`, payer, tx, c, b, watch, vm);
      this.restore(this.reference, this.snapshot(before.keys(), vm));
      this.raised.push({ label, reference: meta(c).computeUnitsConsumed(), port: meta(b).computeUnitsConsumed() });
      return got;
    }
    return this.compare(label, payer, tx, a, b, watch);
  }

  /** The accounts a comparison covers: the fee payer, every account of the instructions, `watch`. */
  private named(payer: KeyPairSigner, ixs: Instruction[], watch: Address[]): Set<Address> {
    const named = new Set<Address>([payer.address, ...watch]);
    for (const i of ixs) for (const m of i.accounts ?? []) named.add(m.address);
    return named;
  }

  /**
   * The state of `addresses` in `vm` (the reference by default): each account's copy, or null where none exists.
   * Programs and sysvars are left out: they are the same in every VM of the Diff (the Clock is set in each).
   */
  snapshot(addresses: Iterable<Address>, vm: LiteSVM = this.reference): Map<Address, ReturnType<LiteSVM["getAccount"]> | null> {
    const out = new Map<Address, ReturnType<LiteSVM["getAccount"]> | null>();
    for (const at of addresses) {
      if (at.startsWith("Sysvar")) continue;
      const acct = vm.getAccount(at);
      if (acct.exists && acct.executable) continue;
      out.set(at, acct.exists ? { ...acct, data: new Uint8Array(acct.data) } : null);
    }
    return out;
  }

  /** Make `vm`'s accounts those of a snapshot: each written as recorded, one recorded as missing removed. */
  restore(vm: LiteSVM, state: Map<Address, ReturnType<LiteSVM["getAccount"]> | null>): void {
    for (const [at, acct] of state)
      if (acct?.exists) vm.setAccount({ ...acct, data: new Uint8Array(acct.data) });
      // LiteSVM keeps no account of zero lamports: that is how the runtime removes one.
      else vm.setAccount({ address: at, data: new Uint8Array(0), executable: false, lamports: lamports(0n), programAddress: SYSTEM, space: 0n });
  }

  /** The transactions the reference ran past its limit and the port completed (`send`). */
  readonly raised: { label: string; reference: bigint; port: bigint }[] = [];
  private raisedVm: LiteSVM | undefined;

  /**
   * The reference under a compute budget of RAISED_CU_LIMIT units and the author's 256 KiB heap, its Clock the Diff's,
   * with the programs `addProgram` added. Its accounts other than those `send` sets before each run are never read.
   */
  raisedReference(): LiteSVM {
    if (!this.raisedVm) {
      const budget = new ComputeBudget();
      budget.computeUnitLimit = RAISED_CU_LIMIT;
      budget.heapSize = HEAP_FRAME;
      this.raisedVm = referenceVm().withComputeBudget(budget);
      for (const [id, so] of this.programs) this.raisedVm.addProgram(id, new Uint8Array(so));
    }
    this.raisedVm.setClock(new Clock(this.slot, this.unixTimestamp - 1000n, 700n, 701n, this.unixTimestamp));
    return this.raisedVm;
  }

  /**
   * The comparison `send` makes, of a transaction already sent to each VM (`a` the reference's result, `b` the port's).
   * Compute units are recorded for every transaction; under `fewer`, one that succeeds and has a top-level instruction
   * of the program must cost the port fewer than the reference.
   */
  compare(label: string, payer: KeyPairSigner, ixs: Instruction[], a: Result, b: Result, watch: Address[] = [], raisedVm?: LiteSVM): string {
    this.compared++;
    comparedInFile[this.which]++;
    const raised = raisedVm !== undefined;
    const reference = raisedVm ?? this.reference;
    const logs = (res: Result) => meta(res).logs().join("\n");
    const why = `${label}\nreference:\n${logs(a)}\nport:\n${logs(b)}`;
    expect(outcome(b), why).toBe(outcome(a));
    if (COVERAGE) {
      probesInLogs(meta(b).logs(), portCoverage().hit);
      writeFileSync(COVERAGE, `${coverageReport(portCoverage().probes, portCoverage().hit)}\n`);
    }
    expect(lines(b, COVERAGE !== undefined && this.which === "port"), `${label}: logs\n${why}`).toEqual(lines(a));
    expect(inner(b), `${label}: inner instructions\n${why}`).toEqual(inner(a));
    expect(returnData(b), `${label}: return data`).toBe(returnData(a));
    for (const at of this.named(payer, ixs, watch)) {
      const acct = reference.getAccount(at);
      if (acct.exists && acct.executable) continue;
      if (at === CLOCK || at === RENT) continue;
      this.expectSame(at, `${label}: ${at}`, reference);
    }
    const [cuReference, cuPort] = [meta(a).computeUnitsConsumed(), meta(b).computeUnitsConsumed()];
    this.cu[label] = [cuReference, cuPort];
    const percolator = ixs.some((i) => i.programAddress === PROGRAM);
    if (this.cuRule === "fewer" && outcome(a) === "ok" && percolator)
      expect(`${cuPort} < ${cuReference}: ${cuPort < cuReference}`, `${label}: the port's compute units (left) below the reference's (right)`).toBe(
        `${cuPort} < ${cuReference}: true`,
      );
    this.rows.push({ label, original: cuReference, port: cuPort, ok: outcome(a) === "ok", percolator });
    // PERCOLATOR_V16_CU_FILE=<path> appends each compared transaction's tag and compute units (for the README's table).
    const cuFile = process.env.PERCOLATOR_V16_CU_FILE;
    const first = ixs.find((i) => i.programAddress === PROGRAM);
    if (cuFile && this.cuRule === "fewer" && first?.data?.length)
      appendFileSync(
        cuFile,
        JSON.stringify({ tag: first.data[0], reference: String(cuReference), port: String(cuPort), ok: outcome(a) === "ok", ...(raised ? { raised } : {}) }) +
          "\n",
      );
    this.lastLogs = logs(a);
    this.last = a;
    // PERCOLATOR_TRACE=1 prints each compared transaction's outcome and compute units.
    if (process.env.PERCOLATOR_TRACE) console.log(`${label}: ${outcome(a)} (${cuReference} / ${cuPort} CU)`);
    return outcome(a);
  }

  async ok(label: string, payer: KeyPairSigner, ixs: Instruction[], o: SendOptions = {}): Promise<void> {
    const got = await this.send(label, payer, ixs, o);
    expect(got, `${label}\n${this.lastLogs}`).toBe("ok");
  }

  async fails(label: string, payer: KeyPairSigner, ixs: Instruction[], expected: string, o: SendOptions = {}): Promise<void> {
    const got = await this.send(label, payer, ixs, o);
    expect(got, `${label}\n${this.lastLogs}`).toBe(expected);
  }

  // ---- Accounts ---------------------------------------------------------------------------------------------------------

  async mint(decimals = 6): Promise<Address> {
    const k = await this.address();
    this.write(k, TOKEN, mintBytes({ decimals }));
    return k;
  }

  async tokenAccount(mint: Address, owner: Address, amount = 0n): Promise<Address> {
    const k = await this.address();
    this.write(k, TOKEN, tokenAccountBytes({ mint, owner, amount }));
    return k;
  }

  /** A portfolio's id (the program-assigned incarnation id after the engine state) in the reference. */
  portfolioId(p: Address): bigint {
    return this.data(p).readBigUInt64LE(9539);
  }

  /** A portfolio's owner-state sequence in the reference. */
  portfolioSequence(p: Address): bigint {
    return this.data(p).readBigUInt64LE(9547);
  }

  /** A portfolio's position epoch (bits 1 to 49 of its matcher control word) in the reference. */
  positionEpoch(p: Address): bigint {
    return (this.data(p).readBigUInt64LE(9531) >> 1n) & 0x1_ffff_ffff_ffffn;
  }

  /** A token account's amount in the reference. */
  amount(a: Address): bigint {
    return this.data(a).readBigUInt64LE(64);
  }

  /**
   * A market's accounts, not initialized: a zeroed market account of `capacity` asset slots owned by the program, a
   * mint, and the vault (a token account of the vault PDA, empty).
   */
  async newMarket(o: { capacity?: number; decimals?: number } = {}): Promise<Market> {
    const admin = await this.funded(100n);
    const mint = await this.mint(o.decimals ?? 6);
    const market = await this.address();
    this.write(market, PROGRAM, new Uint8Array(marketLen(o.capacity ?? 1)));
    const [vaultPda, bump] = await pda(PROGRAM, ["vault", market]);
    // The canonical vault: the vault PDA's associated token account of the mint (verify_vault_token_account).
    const [vault] = await pda(ATA_PROGRAM, [vaultPda, TOKEN, mint]);
    this.write(vault, TOKEN, tokenAccountBytes({ mint, owner: vaultPda, amount: 0n }));
    return { market, admin, mint, vaultPda, bump, vault };
  }

  /** A new market initialized through `send()` with the default arguments (`edit` applied). */
  async market(o: { capacity?: number; args?: Partial<InitMarketArgs>; label?: string } = {}): Promise<Market> {
    const m = await this.newMarket({ capacity: o.capacity });
    await this.ok(o.label ?? "InitMarket", m.admin, [ix.initMarket(m, defaultInitArgs(o.args))]);
    return m;
  }

  /**
   * A portfolio account owned by the program, zeroed, of `len` bytes (the full length by default; InitPortfolio
   * reallocates a shorter one) holding the rent of the full length, and its owner.
   */
  async newPortfolio(len: number = PORTFOLIO.len): Promise<{ owner: KeyPairSigner; portfolio: Address }> {
    const owner = await this.funded(10n);
    const portfolio = await this.address();
    this.write(portfolio, PROGRAM, new Uint8Array(len), this.reference.minimumBalanceForRentExemption(BigInt(PORTFOLIO.len)));
    return { owner, portfolio };
  }
}

/** Whether a result failed (for tests that branch on it). */
export const failed = (r: Result) => r instanceof FailedTransactionMetadata;
