// Test helpers for showcase/mainnet/meteora-dbc, a port subject to Meteora's Non-commercial Licence (see
// showcase/mainnet/meteora-dbc/LICENSE.md): the port and Meteora's Dynamic Bonding Curve as deployed on mainnet
// (test/programs/meteora_dbc.so, release 0.2.2) side by side, each in its own LiteSVM under the program's id with the
// same clock. Both get the same transactions; each must give the same outcome, the same bytes of every watched
// account, the same inner instructions (the events travel in self-CPIs) and the same return data.
import { getCreateAccountInstruction } from "@solana-program/system";
import * as token from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { BN, deployFile, pda, send, type Deployed } from "../../test/harness.js";

export const PROGRAM = address("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const ORIGINAL = fileURLToPath(new URL("../../test/programs/meteora_dbc.so", import.meta.url));
export const PORT = fileURLToPath(new URL("../mainnet/meteora-dbc/meteora_dbc.ts", import.meta.url));
export const TOKEN = address(token.TOKEN_PROGRAM_ADDRESS);
export const TOKEN_2022 = address(t22.TOKEN_2022_PROGRAM_ADDRESS);
export const SYSTEM = address("11111111111111111111111111111111");
export const T22_NATIVE_MINT = address("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
/** DBC's two admins (instructions/admin/auth.rs), each loaded by one lddw per 8-byte word. */
const ADMINS = [address("5unTfT2kssBuNvHPY6LbJfJpLqEcdMxGYLWHwShaeTLi"), address("DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX")] as const;
/** The protocol fee program's authority PDA (constants.rs, const_pda.rs), the only signer of claim_protocol_fee2: two lddw per word. */
const PROTOCOL_FEE_AUTHORITY = address("FkU5rQCWQM131skHCpcEbK8P1JrQGsBgqXe55w525SSF");

export type Result = TransactionMetadata | FailedTransactionMetadata;
export type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

const enc = getAddressEncoder();
export const key = (a: Address) => Buffer.from(enc.encode(a));
export const disc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
export const outcome = (r: Result) => (r instanceof FailedTransactionMetadata ? `error: ${String(r.err())}` : "ok");
const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
export const custom = (code: number) => `error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: ${code} } }`;
/** An error at instruction 0 whose name LiteSVM prints (a ProgramError without a custom code). */
export const builtin = (name: string) => `error: TransactionErrorInstructionError { index: 0, error: ${name} }`;

/** The inner instructions of a transaction: stack height, program, account indexes and data. */
const inner = (r: Result) =>
  meta(r)
    .innerInstructions()
    .map((list) =>
      list.map((i) => {
        const c = i.instruction();
        return `${i.stackHeight()} ${c.programIdIndex()} ${Buffer.from(c.accounts()).toString("hex")} ${Buffer.from(c.data()).toString("hex")}`;
      }),
    );
const returned = (r: Result) => {
  const d = meta(r).returnData();
  return `${Buffer.from(d.programId()).toString("hex")} ${Buffer.from(d.data()).toString("hex")}`;
};

/** The original and the port loaded side by side, with the admins replaced by test keys in both. */
export interface Pair {
  d: Deployed;
  original: LiteSVM;
  admins: KeyPairSigner[];
  /** A test key in place of the protocol fee authority PDA. */
  protocolFeeAuthority: KeyPairSigner;
  eventAuthority: Address;
  vms(): readonly [LiteSVM, LiteSVM];
  funded(): Promise<KeyPairSigner>;
  ix(name: string, args: Record<string, unknown>, accounts: Meta[]): Instruction;
  /** Send to both: the same outcome, watched account bytes, inner instructions and return data. Returns the outcome. */
  both(label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[], extraSigners?: KeyPairSigner[]): Promise<string>;
  /** Set up in both (must succeed in both). */
  setup(payer: KeyPairSigner, ixs: Instruction[]): Promise<void>;
  /** Write an account in both. */
  write(addr: Address, data: Buffer, owner?: Address): void;
  bytes(vm: LiteSVM, a: Address): string;
  stats: { compared: number; innerCompared: number; byOutcome: Record<string, number> };
}

export async function pair(): Promise<Pair> {
  const so = Buffer.from(readFileSync(ORIGINAL));
  const source = mkdtempSync(path.join(os.tmpdir(), "meteora-dbc-port-"));
  cpSync(path.dirname(PORT), source, { recursive: true });
  const admins: KeyPairSigner[] = [];
  const protocolFeeAuthority = await generateKeyPairSigner();
  for (const admin of [...ADMINS, PROTOCOL_FEE_AUTHORITY]) {
    const signer = admin === PROTOCOL_FEE_AUTHORITY ? protocolFeeAuthority : await generateKeyPairSigner();
    if (admin !== PROTOCOL_FEE_AUTHORITY) admins.push(signer);
    const [from, to] = [key(admin), key(signer.address)];
    for (let c = 0; c < 4; c++) {
      const [was, now] = [from.readBigUInt64LE(c * 8), to.readBigUInt64LE(c * 8)];
      let patched = 0;
      for (let i = 0; i + 16 <= so.length; i += 8)
        if (so[i] === 0x18 && so.readUInt32LE(i + 4) === Number(was & 0xffffffffn) && so[i + 8] === 0 && so.readUInt32LE(i + 12) === Number(was >> 32n)) {
          so.writeUInt32LE(Number(now & 0xffffffffn), i + 4);
          so.writeUInt32LE(Number(now >> 32n), i + 12);
          patched++;
        }
      expect(patched, `key ${admin}, word ${c}`).toBe(admin === PROTOCOL_FEE_AUTHORITY ? 2 : 1);
    }
    for (const f of readdirSync(source))
      if (f.endsWith(".ts")) writeFileSync(path.join(source, f), readFileSync(path.join(source, f), "utf8").replaceAll(admin, signer.address));
  }
  const d = await deployFile(path.join(source, path.basename(PORT)), { programId: PROGRAM });
  const original = new LiteSVM();
  original.addProgram(PROGRAM, new Uint8Array(so));
  for (const vm of [original, d.svm]) {
    const clock = vm.getClock();
    clock.unixTimestamp = 1_800_000_000n;
    clock.epoch = 900n;
    clock.slot = 470_000_000n;
    vm.setClock(clock);
    for (const s of [...admins, protocolFeeAuthority]) vm.airdrop(s.address, lamports(100_000_000_000n));
  }
  const [eventAuthority] = await pda(PROGRAM, ["__event_authority"]);
  const stats = { compared: 0, innerCompared: 0, byOutcome: {} as Record<string, number> };
  const vms = () => [original, d.svm] as const;
  const bytes = (vm: LiteSVM, a: Address) => {
    const acct = vm.getAccount(a);
    return acct.exists ? `${acct.lamports} ${acct.programAddress} ${acct.executable} ${Buffer.from(acct.data).toString("hex")}` : "missing";
  };
  const p: Pair = {
    d,
    original,
    admins,
    protocolFeeAuthority,
    eventAuthority,
    vms,
    stats,
    bytes,
    async funded() {
      const s = await generateKeyPairSigner();
      for (const vm of vms()) vm.airdrop(s.address, lamports(100_000_000_000n));
      return s;
    },
    ix(name, args, accounts) {
      return {
        programAddress: PROGRAM,
        accounts: accounts.map((a) => ({
          address: a.address,
          role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
          ...(a.signer ? { signer: a.signer } : {}),
        })) as Instruction["accounts"],
        data: new Uint8Array(d.coder.instruction.encode(name, args)),
      };
    },
    async both(label, payer, ixs, watch) {
      const [a, b] = [await send(original, payer, ixs), await send(d.svm, payer, ixs)];
      stats.compared++;
      const logs = (r: Result) => meta(r).logs().join("\n");
      expect(outcome(b), `${label}\noriginal:\n${logs(a)}\nport:\n${logs(b)}`).toBe(outcome(a));
      const events = (r: Result) =>
        r instanceof FailedTransactionMetadata
          ? []
          : inner(r)
              .flat()
              .filter((x) => x.startsWith("2 "));
      for (const w of watch)
        expect(bytes(d.svm, w), `${label}: ${w}\noriginal's events: ${events(a).join("\n")}\nport's events: ${events(b).join("\n")}`).toBe(bytes(original, w));
      if (!(a instanceof FailedTransactionMetadata)) {
        expect(inner(b), `${label}: inner instructions (events)`).toEqual(inner(a));
        stats.innerCompared += inner(a).flat().length;
        expect(returned(b), `${label}: return data`).toBe(returned(a));
        const logged = (r: Result) =>
          meta(r)
            .logs()
            .filter((l) => l.startsWith("Program data:"));
        expect(logged(b), `${label}: events in the logs (emit!)`).toEqual(logged(a));
      }
      const o = outcome(a);
      const short =
        o === "ok" ? "ok" : (/code: (\d+)/.exec(o)?.[1] ?? o.replace(/^error: TransactionErrorInstructionError \{ index: \d+, error: /, "").slice(0, 40));
      stats.byOutcome[short] = (stats.byOutcome[short] ?? 0) + 1;
      return o;
    },
    async setup(payer, ixs) {
      for (const vm of vms()) {
        const r = await send(vm, payer, ixs);
        if (r instanceof FailedTransactionMetadata) throw new Error(`setup failed: ${String(r.err())}\n${r.meta().logs().join("\n")}`);
      }
    },
    write(addr, data, owner = PROGRAM) {
      for (const vm of vms())
        vm.setAccount({
          address: addr,
          data: new Uint8Array(data),
          executable: false,
          lamports: lamports(vm.minimumBalanceForRentExemption(BigInt(data.length))),
          programAddress: owner,
          space: BigInt(data.length),
        });
    },
  };
  return p;
}

// ---- mints ------------------------------------------------------------------------------------------------------

export type Ext =
  | { kind: "transferFee"; bps: number; max: bigint; authority: boolean; newerBps?: number; newerEpoch?: bigint }
  | { kind: "closeAuthority" }
  | { kind: "permanentDelegate" }
  | { kind: "metadataPointer" };

/** A mint of SPL Token (no extensions) or Token-2022 with `exts`, set up in both VMs; `at` puts it at that address. */
export async function mint(p: Pair, program: Address, decimals: number, exts: Ext[] = [], at?: Address): Promise<Address> {
  const payer = await p.funded();
  const m = await generateKeyPairSigner();
  const t22exts = exts.map((e) => {
    switch (e.kind) {
      case "transferFee":
        return {
          __kind: "TransferFeeConfig" as const,
          transferFeeConfigAuthority: payer.address,
          withdrawWithheldAuthority: payer.address,
          withheldAmount: 0n,
          olderTransferFee: { epoch: 0n, maximumFee: e.max, transferFeeBasisPoints: e.bps },
          newerTransferFee: { epoch: 0n, maximumFee: e.max, transferFeeBasisPoints: e.bps },
        };
      case "closeAuthority":
        return { __kind: "MintCloseAuthority" as const, closeAuthority: payer.address };
      case "permanentDelegate":
        return { __kind: "PermanentDelegate" as const, delegate: payer.address };
      case "metadataPointer":
        return { __kind: "MetadataPointer" as const, authority: payer.address, metadataAddress: m.address };
    }
  });
  const space = program === TOKEN ? 82 : t22exts.length ? t22.getMintSize(t22exts) : 82;
  const init: Instruction[] = [];
  for (const e of exts) {
    if (e.kind === "transferFee")
      init.push(
        t22.getInitializeTransferFeeConfigInstruction({
          mint: m.address,
          transferFeeConfigAuthority: e.authority ? payer.address : null,
          withdrawWithheldAuthority: payer.address,
          transferFeeBasisPoints: e.bps,
          maximumFee: e.max,
        }) as Instruction,
      );
    if (e.kind === "closeAuthority")
      init.push(t22.getInitializeMintCloseAuthorityInstruction({ mint: m.address, closeAuthority: payer.address }) as Instruction);
    if (e.kind === "permanentDelegate") init.push(t22.getInitializePermanentDelegateInstruction({ mint: m.address, delegate: payer.address }) as Instruction);
    if (e.kind === "metadataPointer")
      init.push(t22.getInitializeMetadataPointerInstruction({ mint: m.address, authority: payer.address, metadataAddress: m.address }) as Instruction);
  }
  await p.setup(payer, [
    getCreateAccountInstruction({ payer, newAccount: m, lamports: p.original.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: program }),
    ...init,
    (program === TOKEN ? token.getInitializeMint2Instruction : t22.getInitializeMint2Instruction)({
      mint: m.address,
      decimals,
      mintAuthority: payer.address,
    }) as Instruction,
  ]);
  // A newer transfer fee scheduled for a later epoch: written in place (Token-2022 schedules it two epochs ahead).
  const fee = exts.find((e) => e.kind === "transferFee");
  for (const vm of p.vms()) {
    const a = vm.getAccount(m.address);
    if (!a.exists) throw new Error("mint missing");
    const data = Buffer.from(a.data);
    if (fee && fee.kind === "transferFee" && fee.newerEpoch !== undefined) {
      // TLV: find TransferFeeConfig (type 1) after the account type byte at 165
      let off = 166;
      while (off + 4 <= data.length && data.readUInt16LE(off) !== 1) off += 4 + data.readUInt16LE(off + 2);
      const v = off + 4;
      data.writeBigUInt64LE(fee.newerEpoch, v + 90);
      data.writeUInt16LE(fee.newerBps ?? fee.bps, v + 90 + 16);
    }
    vm.setAccount({ ...a, address: at ?? m.address, data: new Uint8Array(data) });
  }
  return at ?? m.address;
}

// ---- config parameters --------------------------------------------------------------------------------------------

const Q64 = 1n << 64n;
export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673521066979257578248091n;

export interface Point {
  sqrt_price: bigint;
  liquidity: bigint;
}

/** A plain struct of ConfigParameters as the coder takes it (snake_case, BN for 64-bit and wider). */
export interface Params {
  pool_fees: {
    base_fee: { cliff_fee_numerator: bigint; first_factor: number; second_factor: bigint; third_factor: bigint; base_fee_mode: number };
    dynamic_fee: null | {
      bin_step: number;
      bin_step_u128: bigint;
      filter_period: number;
      decay_period: number;
      reduction_factor: number;
      max_volatility_accumulator: number;
      variable_fee_control: number;
    };
  };
  collect_fee_mode: number;
  migration_option: number;
  activation_type: number;
  token_type: number;
  token_decimal: number;
  partner_liquidity_percentage: number;
  partner_permanent_locked_liquidity_percentage: number;
  creator_liquidity_percentage: number;
  creator_permanent_locked_liquidity_percentage: number;
  migration_quote_threshold: bigint;
  sqrt_start_price: bigint;
  locked_vesting: {
    amount_per_period: bigint;
    cliff_duration_from_migration_time: bigint;
    frequency: bigint;
    number_of_period: bigint;
    cliff_unlock_amount: bigint;
  };
  migration_fee_option: number;
  token_supply: null | { pre_migration_token_supply: bigint; post_migration_token_supply: bigint };
  creator_trading_fee_percentage: number;
  token_update_authority: number;
  migration_fee: { fee_percentage: number; creator_fee_percentage: number };
  migrated_pool_fee: { collect_fee_mode: number; dynamic_fee: number; pool_fee_bps: number };
  pool_creation_fee: bigint;
  partner_liquidity_vesting_info: Vesting;
  creator_liquidity_vesting_info: Vesting;
  migrated_pool_base_fee_mode: number;
  migrated_pool_market_cap_fee_scheduler_params: {
    number_of_period: number;
    sqrt_price_step_bps: number;
    scheduler_expiration_duration: number;
    reduction_factor: bigint;
  };
  enable_first_swap_with_min_fee: boolean;
  compounding_fee_bps: number;
  padding: number[];
  curve: Point[];
}
export interface Vesting {
  vesting_percentage: number;
  bps_per_period: number;
  number_of_periods: number;
  cliff_duration_from_migration_time: number;
  frequency: number;
}
export const noVesting = (): Vesting => ({
  vesting_percentage: 0,
  bps_per_period: 0,
  number_of_periods: 0,
  cliff_duration_from_migration_time: 0,
  frequency: 0,
});

/** sqrt(price) in Q64.64 for a price given as num / den. */
export function sqrtQ64(num: bigint, den: bigint): bigint {
  const x = (num << 128n) / den;
  let r = 1n << 64n;
  for (let i = 0; i < 200; i++) {
    const n = (r + x / r) >> 1n;
    if (n === r || n === r + 1n) break;
    r = n;
  }
  while (r * r > x) r--;
  return r;
}

/** A config that create_config accepts: an SPL base, a two-segment curve, DAMM v2 at a fixed 0.25% fee. */
export function baseParams(): Params {
  const start = sqrtQ64(1n, 1_000_000n);
  const mid = start * 4n;
  const end = start * 10n;
  return {
    pool_fees: { base_fee: { cliff_fee_numerator: 25_000_000n, first_factor: 0, second_factor: 0n, third_factor: 0n, base_fee_mode: 0 }, dynamic_fee: null },
    collect_fee_mode: 0,
    migration_option: 1,
    activation_type: 1,
    token_type: 0,
    token_decimal: 6,
    partner_liquidity_percentage: 50,
    partner_permanent_locked_liquidity_percentage: 0,
    creator_liquidity_percentage: 0,
    creator_permanent_locked_liquidity_percentage: 50,
    migration_quote_threshold: 80_000_000_000n,
    sqrt_start_price: start,
    locked_vesting: { amount_per_period: 0n, cliff_duration_from_migration_time: 0n, frequency: 0n, number_of_period: 0n, cliff_unlock_amount: 0n },
    migration_fee_option: 0,
    token_supply: null,
    creator_trading_fee_percentage: 0,
    token_update_authority: 0,
    migration_fee: { fee_percentage: 0, creator_fee_percentage: 0 },
    migrated_pool_fee: { collect_fee_mode: 0, dynamic_fee: 0, pool_fee_bps: 0 },
    pool_creation_fee: 0n,
    partner_liquidity_vesting_info: noVesting(),
    creator_liquidity_vesting_info: noVesting(),
    migrated_pool_base_fee_mode: 0,
    migrated_pool_market_cap_fee_scheduler_params: { number_of_period: 0, sqrt_price_step_bps: 0, scheduler_expiration_duration: 0, reduction_factor: 0n },
    enable_first_swap_with_min_fee: false,
    compounding_fee_bps: 0,
    padding: [0, 0],
    curve: [
      { sqrt_price: mid, liquidity: 20_000_000_000_000n * Q64 },
      { sqrt_price: end, liquidity: 20_000_000_000_000n * Q64 },
    ],
  };
}

/** A config create_config2 takes with a base transfer fee: constant supply, customizable migration fee, compounding. */
export const constantSupply = (b: Params): Params => ({
  ...b,
  token_type: 1,
  token_supply: { pre_migration_token_supply: 10n ** 17n, post_migration_token_supply: 10n ** 17n },
  migration_fee_option: 6,
  migrated_pool_fee: { collect_fee_mode: 2, dynamic_fee: 0, pool_fee_bps: 100 },
});
export const transferFee = (bps: number, withheld = 0, migrated = 1) => ({
  transfer_fee_basis_points: bps,
  withheld_authority: withheld,
  migrated_transfer_fee_authority_option: migrated,
});

/** Params as the Anchor coder encodes them: bigint → BN. */
export function coded(x: unknown): unknown {
  if (typeof x === "bigint") return new BN(x.toString());
  if (Array.isArray(x)) return x.map(coded);
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, coded(v)]));
  return x;
}

// ---- a transfer hook program (showcase/test/fixtures/meteora-dbc/hook.ts) -----------------------------------------

export const HOOK_SOURCE = fileURLToPath(new URL("./fixtures/meteora-dbc/hook.ts", import.meta.url));

/** The fixture hook, built and loaded into both VMs at a new address. */
export async function loadHook(p: Pair): Promise<Address> {
  const hook = (await generateKeyPairSigner()).address;
  for (const vm of p.vms()) await deployFile(HOOK_SOURCE, { svm: vm, programId: hook });
  return hook;
}

/** spl-transfer-hook-interface's validation account: ["extra-account-metas", mint] of the hook program. */
export const extraMetasAddress = async (hook: Address, mint: Address) => (await pda(hook, ["extra-account-metas", mint]))[0];

/** sha256("spl-transfer-hook-interface:execute")[..8], the ExtraAccountMetaList's TLV type. */
export const EXECUTE_DISC = createHash("sha256").update("spl-transfer-hook-interface:execute").digest().subarray(0, 8);

/** A seed of an extra account (spl-tlv-account-resolution's Seed, packed). */
export type HookSeed =
  | { literal: Uint8Array | string }
  | { ixData: [index: number, length: number] }
  | { accountKey: number }
  | { accountData: [account: number, offset: number, length: number] };
/** An ExtraAccountMeta: a fixed address, a PDA of the hook (or of the program at account `program`), or a key read from data. */
export type HookMeta = (
  | { address: Address }
  | { seeds: HookSeed[]; program?: number }
  | { keyFromIxData: number }
  | { keyFromAccountData: [account: number, offset: number] }
  | { raw: Uint8Array }
) & { signer?: boolean; writable?: boolean };

/** The 35 bytes of one ExtraAccountMeta: discriminator, 32-byte address config, is_signer, is_writable. */
export function packMeta(m: HookMeta): Buffer {
  const out = Buffer.alloc(35);
  if ("raw" in m) Buffer.from(m.raw).copy(out);
  else if ("address" in m) key(m.address).copy(out, 1);
  else if ("seeds" in m) {
    out[0] = m.program === undefined ? 1 : 128 + m.program;
    let at = 1;
    for (const s of m.seeds) {
      if ("literal" in s) {
        const b = typeof s.literal === "string" ? Buffer.from(s.literal) : Buffer.from(s.literal);
        out[at] = 1;
        out[at + 1] = b.length;
        b.copy(out, at + 2);
        at += 2 + b.length;
      } else if ("ixData" in s) {
        out.set([2, ...s.ixData], at);
        at += 3;
      } else if ("accountKey" in s) {
        out.set([3, s.accountKey], at);
        at += 2;
      } else {
        out.set([4, ...s.accountData], at);
        at += 4;
      }
    }
  } else if ("keyFromIxData" in m) out.set([2, 1, m.keyFromIxData], 0);
  else out.set([2, 2, ...m.keyFromAccountData], 0);
  out[33] = m.signer ? 1 : 0;
  out[34] = m.writable ? 1 : 0;
  return out;
}

/** An ExtraAccountMetaList's bytes: the TLV entry (type, u32 length) holding a u32 count and the metas. */
export function extraMetasData(metas: HookMeta[]): Buffer {
  const list = Buffer.concat([Buffer.alloc(4), ...metas.map(packMeta)]);
  list.writeUInt32LE(metas.length, 0);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(list.length);
  return Buffer.concat([EXECUTE_DISC, len, list]);
}

/** Write the validation account of `mint` under `hook` in both VMs (`data` as given, or the list of `metas`). */
export async function writeExtraMetas(p: Pair, hook: Address, mint: Address, metas: HookMeta[] | Buffer): Promise<Address> {
  const at = await extraMetasAddress(hook, mint);
  p.write(at, Buffer.isBuffer(metas) ? metas : extraMetasData(metas), hook);
  return at;
}
