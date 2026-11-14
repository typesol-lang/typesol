// Graduation test helpers for showcase/mainnet/meteora-dbc, a port subject to Meteora's Non-commercial Licence (see
// showcase/mainnet/meteora-dbc/LICENSE.md): configs, pools made by the pool creation instructions, swaps to the
// threshold, and the instructions of the third stage (surplus, migration fee, leftover, locker, DAMM v2 migration),
// sent to the mainnet binary and the port side by side (meteora-dbc-helpers.ts). Both VMs carry the programs the
// migration calls as deployed on mainnet (DAMM v2 and the locker, test/programs/SOURCES.md) and DAMM v2's seven
// migration configs read from mainnet (showcase/test/fixtures/meteora-dbc/damm-v2, slot in its slot.txt).
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, address, generateKeyPairSigner, lamports } from "@solana/kit";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { BN, pda } from "../../test/harness.js";
import {
  type Meta,
  type Pair,
  type Params,
  PROGRAM,
  SYSTEM,
  TOKEN,
  TOKEN_2022,
  coded,
  disc,
  extraMetasAddress,
  key,
  loadHook,
  pair,
  writeExtraMetas,
} from "./meteora-dbc-helpers.js";

export const POOL_AUTHORITY = address("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const DAMM_V2 = address("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const LOCKER = address("LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn");
export const DAMM_POOL_AUTHORITY = address("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const MPL = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const MPL_SO = fileURLToPath(new URL("../../test/programs/mpl_token_metadata.so", import.meta.url));
export const DAMM_SO = fileURLToPath(new URL("../../test/programs/meteora_damm_v2.so", import.meta.url));
export const LOCKER_SO = fileURLToPath(new URL("../../test/programs/meteora_locker.so", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/meteora-dbc/damm-v2", import.meta.url));
/** DAMM v2's configs for DBC's migration fee options 0–6 (README of the DBC repository, read from mainnet). */
export const DAMM_CONFIGS = [
  "7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd",
  "2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k",
  "Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp",
  "2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq",
  "AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD",
  "DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u",
  "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
].map((a) => address(a));

export const big = (n: bigint) => new BN(n.toString());
/** SetComputeUnitLimit(1,400,000), sent after the instruction (the runtime reads it from anywhere in the message). */
export const CU_LIMIT: Instruction = {
  programAddress: address("ComputeBudget111111111111111111111111111111"),
  accounts: [],
  data: new Uint8Array([2, 0xc0, 0x5c, 0x15, 0x00]),
};
const ata = async (owner: Address, m: Address, program: Address) => (await t22.findAssociatedTokenPda({ owner, mint: m, tokenProgram: program }))[0];

export interface PoolInfo {
  pool: Address;
  config: Address;
  params: Params;
  baseMint: Address;
  quoteMint: Address;
  baseProgram: Address;
  quoteProgram: Address;
  baseVault: Address;
  quoteVault: Address;
  creator: KeyPairSigner;
  /** the config's fee claimer, also its leftover receiver */
  partner: KeyPairSigner;
  hook: boolean;
}

export interface Migrated {
  dammPool: Address;
  positions: Address[];
  nftMints: Address[];
  nftAccounts: Address[];
  vaults: Address[];
}

export interface Graduation {
  p: Pair;
  hook: Address;
  /** A config made by create_config, create_config2 (`fee`: transfer fee parameters) or create_config_with_transfer_hook. */
  config(params: Params, quoteMint: Address, opts?: { fee?: unknown; hook?: boolean; badge?: boolean }): Promise<{ config: Address; partner: KeyPairSigner }>;
  /** A pool of a new config, made by the pool creation instruction its base token type calls for. */
  pool(params: Params, quoteMint: Address, quoteProgram: Address, opts?: { fee?: unknown; hook?: boolean; badge?: boolean }): Promise<PoolInfo>;
  /** As pool(), or null when both programs refuse the config or the pool (the same way: compared). */
  maybePool(params: Params, quoteMint: Address, quoteProgram: Address, opts?: { fee?: unknown; hook?: boolean; badge?: boolean }): Promise<PoolInfo | null>;
  /** The ATA of `owner` for `m`, made in both, holding `amount` (written). */
  account(owner: Address, m: Address, program: Address, amount?: bigint): Promise<Address>;
  /** A swap of quote in (partial fill: up to the threshold), the trader made with enough quote. */
  buy(pi: PoolInfo, amount: bigint, label?: string): Promise<string>;
  /** Swap until the curve is complete (one partial fill past the threshold). */
  complete(pi: PoolInfo): Promise<void>;
  surplus(pi: PoolInfo, who: "partner" | "creator", signer?: KeyPairSigner, over?: Partial<Record<string, Address>>): Promise<string>;
  migrationFee(pi: PoolInfo, flag: number, signer: KeyPairSigner, over?: Partial<Record<string, Address>>): Promise<string>;
  leftover(pi: PoolInfo, sign: boolean, over?: Partial<Record<string, Address>>): Promise<string>;
  locker(pi: PoolInfo, over?: Partial<Record<string, Address>>): Promise<string>;
  metadata(pi: PoolInfo): Promise<string>;
  /** migration_damm_v2 on DAMM v2 config `dammConfig` (the config's option by default). */
  migrate(
    pi: PoolInfo,
    opts?: { dammConfig?: Address | null; noSecond?: boolean; over?: Partial<Record<string, Address>>; sameNft?: boolean; label?: string },
  ): Promise<{ outcome: string; migrated: Migrated }>;
}

export async function graduation(): Promise<Graduation> {
  const p = await pair();
  for (const [id, so] of [
    [MPL, MPL_SO],
    [DAMM_V2, DAMM_SO],
    [LOCKER, LOCKER_SO],
  ] as const) {
    const bytes = new Uint8Array(readFileSync(so));
    for (const vm of p.vms()) vm.addProgram(id, bytes);
  }
  for (const f of readdirSync(FIXTURES).filter((x) => x.endsWith(".json"))) {
    const a = JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as {
      address: string;
      lamports: string;
      owner: string;
      executable: boolean;
      data: string;
    };
    const data = Buffer.from(a.data, "base64");
    for (const vm of p.vms())
      vm.setAccount({
        address: address(a.address),
        data: new Uint8Array(data),
        executable: a.executable,
        lamports: lamports(BigInt(a.lamports)),
        programAddress: address(a.owner),
        space: BigInt(data.length),
      });
  }
  // the pool authority lends the rent of DAMM v2's and the locker's accounts (flash rent), as it holds SOL on mainnet
  for (const vm of p.vms()) vm.airdrop(POOL_AUTHORITY, lamports(10_000_000_000n));
  const hook = await loadHook(p);
  const [dammEvents] = await pda(DAMM_V2, ["__event_authority"]);
  const [lockerEvents] = await pda(LOCKER, ["__event_authority"]);

  async function account(owner: Address, m: Address, program: Address, amount = 0n) {
    const payer = await p.funded();
    const at = await ata(owner, m, program);
    await p.setup(payer, [t22.getCreateAssociatedTokenIdempotentInstruction({ payer, ata: at, owner, mint: m, tokenProgram: program }) as Instruction]);
    if (amount > 0n)
      for (const vm of p.vms()) {
        const a = vm.getAccount(at);
        if (!a.exists) throw new Error("no account");
        const data = Buffer.from(a.data);
        data.writeBigUInt64LE(amount, 64);
        vm.setAccount({ ...a, data: new Uint8Array(data) });
      }
    return at;
  }

  async function config(params: Params, quoteMint: Address, opts: { fee?: unknown; hook?: boolean; badge?: boolean } = {}, maybe = false) {
    const payer = await p.funded();
    const cfg = await generateKeyPairSigner();
    const name = opts.hook ? "create_config_with_transfer_hook" : opts.fee !== undefined ? "create_config2" : "create_config";
    const args: Record<string, unknown> = { config_parameters: coded(params) };
    if (opts.fee !== undefined) args.transfer_fee_parameters = opts.fee;
    // a token badge for the quote mint, written in both (as create_token_badge leaves it)
    const badge = (await pda(PROGRAM, ["token_badge", quoteMint]))[0];
    if (opts.badge) p.write(badge, Buffer.concat([disc("TokenBadge"), key(quoteMint), Buffer.alloc(128)]));
    const ix = p.ix(name, args, [
      { address: cfg.address, signer: cfg, writable: true },
      { address: payer.address },
      { address: payer.address },
      { address: quoteMint },
      ...(opts.hook ? [{ address: hook }] : []),
      { address: payer.address, signer: payer, writable: true },
      { address: SYSTEM },
      { address: p.eventAuthority },
      { address: PROGRAM },
      ...(opts.badge ? [{ address: badge }] : []),
    ]);
    const o = await p.both("create the config", payer, [ix], [cfg.address]);
    if (maybe && o !== "ok") return null;
    expect(o).toBe("ok");
    return { config: cfg.address, partner: payer };
  }

  async function pool(
    params: Params,
    quoteMint: Address,
    quoteProgram: Address,
    opts: { fee?: unknown; hook?: boolean; badge?: boolean } = {},
  ): Promise<PoolInfo> {
    return (await makePool(params, quoteMint, quoteProgram, opts, false))!;
  }
  async function makePool(
    params: Params,
    quoteMint: Address,
    quoteProgram: Address,
    opts: { fee?: unknown; hook?: boolean; badge?: boolean },
    maybe: boolean,
  ): Promise<PoolInfo | null> {
    const made = await config(params, quoteMint, opts, maybe);
    if (!made) return null;
    const { config: cfg, partner } = made;
    const baseProgram = params.token_type === 1 ? TOKEN_2022 : TOKEN;
    const creator = await p.funded();
    const baseMint = await generateKeyPairSigner();
    const [hi, lo] = Buffer.compare(key(baseMint.address), key(quoteMint)) > 0 ? [baseMint.address, quoteMint] : [quoteMint, baseMint.address];
    const [poolKey] = await pda(PROGRAM, ["pool", cfg, hi, lo]);
    const [baseVault] = await pda(PROGRAM, ["token_vault", baseMint.address, poolKey]);
    const [quoteVault] = await pda(PROGRAM, ["token_vault", quoteMint, poolKey]);
    const watch = [poolKey, baseMint.address, baseVault, quoteVault];
    const badge: Meta[] = opts.badge ? [{ address: (await pda(PROGRAM, ["token_badge", quoteMint]))[0] }] : [];
    let ix: Instruction;
    if (baseProgram === TOKEN) {
      const [metadata] = await pda(MPL, ["metadata", MPL, baseMint.address]);
      watch.push(metadata);
      ix = p.ix("initialize_virtual_pool_with_spl_token", { params: { name: "Token", symbol: "TKN", uri: "" } }, [
        { address: cfg },
        { address: POOL_AUTHORITY },
        { address: creator.address, signer: creator },
        { address: baseMint.address, signer: baseMint, writable: true },
        { address: quoteMint },
        { address: poolKey, writable: true },
        { address: baseVault, writable: true },
        { address: quoteVault, writable: true },
        { address: metadata, writable: true },
        { address: MPL },
        { address: creator.address, signer: creator, writable: true },
        { address: quoteProgram },
        { address: TOKEN },
        { address: SYSTEM },
        { address: p.eventAuthority },
        { address: PROGRAM },
        ...badge,
      ]);
    } else {
      const name = opts.hook ? "initialize_virtual_pool_with_token2022_transfer_hook" : "initialize_virtual_pool_with_token2022";
      ix = p.ix(name, { params: { name: "Token", symbol: "TKN", uri: "" } }, [
        { address: cfg },
        { address: POOL_AUTHORITY },
        { address: creator.address, signer: creator },
        { address: baseMint.address, signer: baseMint, writable: true },
        { address: quoteMint },
        { address: poolKey, writable: true },
        { address: baseVault, writable: true },
        { address: quoteVault, writable: true },
        ...(opts.hook ? [{ address: hook }] : []),
        { address: creator.address, signer: creator, writable: true },
        { address: quoteProgram },
        { address: TOKEN_2022 },
        { address: SYSTEM },
        { address: p.eventAuthority },
        { address: PROGRAM },
        ...badge,
      ]);
    }
    const o = await p.both("create the pool", creator, [ix], watch);
    if (maybe && o !== "ok") return null;
    expect(o).toBe("ok");
    // the hook's validation account, with no extra accounts
    if (opts.hook) await writeExtraMetas(p, hook, baseMint.address, []);
    return {
      pool: poolKey,
      config: cfg,
      params,
      baseMint: baseMint.address,
      quoteMint,
      baseProgram,
      quoteProgram,
      baseVault,
      quoteVault,
      creator,
      partner,
      hook: !!opts.hook,
    };
  }

  async function buy(pi: PoolInfo, amount: bigint, label = "buy") {
    const who = await p.funded();
    const base = await account(who.address, pi.baseMint, pi.baseProgram);
    const quote = await account(who.address, pi.quoteMint, pi.quoteProgram, 10n ** 18n);
    const metas: Meta[] = [
      { address: POOL_AUTHORITY },
      { address: pi.config },
      { address: pi.pool, writable: true },
      { address: quote, writable: true },
      { address: base, writable: true },
      { address: pi.baseVault, writable: true },
      { address: pi.quoteVault, writable: true },
      { address: pi.baseMint, writable: pi.hook },
      { address: pi.quoteMint },
      { address: who.address, signer: who },
      { address: pi.baseProgram },
      { address: pi.quoteProgram },
      { address: PROGRAM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ];
    const params = { amount_0: big(amount), amount_1: big(0n), swap_mode: 1 };
    const ix = pi.hook
      ? p.ix("swap2_with_transfer_hook", { params, transfer_hook_accounts_info: { slices: [{ accounts_type: { TransferHookBase: {} }, length: 2 }] } }, [
          ...metas,
          { address: hook },
          { address: await extraMetasAddress(hook, pi.baseMint) },
        ])
      : p.ix("swap2", { params }, metas);
    return p.both(label, who, [ix], [pi.pool, pi.baseVault, pi.quoteVault, pi.baseMint, base, quote]);
  }

  async function complete(pi: PoolInfo) {
    expect(await buy(pi, 10n ** 17n, "swap to the threshold")).toBe("ok");
  }

  const surplus = async (pi: PoolInfo, who: "partner" | "creator", signer?: KeyPairSigner, over: Partial<Record<string, Address>> = {}) => {
    const s = signer ?? (who === "partner" ? pi.partner : pi.creator);
    const dst = await account(s.address, pi.quoteMint, pi.quoteProgram);
    const ix = p.ix(who === "partner" ? "partner_withdraw_surplus" : "creator_withdraw_surplus", {}, [
      { address: over.poolAuthority ?? POOL_AUTHORITY },
      { address: over.config ?? pi.config },
      { address: over.pool ?? pi.pool, writable: true },
      { address: over.dst ?? dst, writable: true },
      { address: over.quoteVault ?? pi.quoteVault, writable: true },
      { address: over.quoteMint ?? pi.quoteMint },
      { address: s.address, signer: s },
      { address: over.quoteProgram ?? pi.quoteProgram },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
    return p.both(`${who}_withdraw_surplus`, s, [ix], [pi.pool, pi.quoteVault, dst]);
  };

  const migrationFee = async (pi: PoolInfo, flag: number, signer: KeyPairSigner, over: Partial<Record<string, Address>> = {}) => {
    const dst = await account(signer.address, pi.quoteMint, pi.quoteProgram);
    const ix = p.ix("withdraw_migration_fee", { flag }, [
      { address: POOL_AUTHORITY },
      { address: over.config ?? pi.config },
      { address: over.pool ?? pi.pool, writable: true },
      { address: dst, writable: true },
      { address: over.quoteVault ?? pi.quoteVault, writable: true },
      { address: over.quoteMint ?? pi.quoteMint },
      { address: signer.address, signer },
      { address: pi.quoteProgram },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
    return p.both(`withdraw_migration_fee ${flag}`, signer, [ix], [pi.pool, pi.quoteVault, dst]);
  };

  const leftover = async (pi: PoolInfo, sign: boolean, over: Partial<Record<string, Address>> = {}) => {
    const receiver = pi.partner;
    const dst = over.dst ?? (await account(receiver.address, pi.baseMint, pi.baseProgram));
    const payer = await p.funded();
    const ix = p.ix("withdraw_leftover", {}, [
      { address: POOL_AUTHORITY },
      { address: over.config ?? pi.config },
      { address: over.pool ?? pi.pool, writable: true },
      { address: dst, writable: true },
      { address: over.baseVault ?? pi.baseVault, writable: true },
      { address: pi.baseMint },
      sign ? { address: receiver.address, signer: receiver } : { address: over.receiver ?? receiver.address },
      { address: pi.baseProgram },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
    return p.both("withdraw_leftover", payer, [ix], [pi.pool, pi.baseVault, dst, pi.baseMint]);
  };

  const locker = async (pi: PoolInfo, over: Partial<Record<string, Address>> = {}) => {
    const payer = await p.funded();
    const [base] = await pda(PROGRAM, ["base_locker", pi.pool]);
    const [escrow] = await pda(LOCKER, ["escrow", base]);
    const escrowToken = await account(escrow, pi.baseMint, pi.baseProgram);
    const ix = p.ix("create_locker", {}, [
      { address: over.pool ?? pi.pool, writable: true },
      { address: over.config ?? pi.config },
      { address: POOL_AUTHORITY, writable: true },
      { address: over.baseVault ?? pi.baseVault, writable: true },
      { address: pi.baseMint, writable: true },
      { address: over.base ?? base, writable: true },
      { address: over.creator ?? pi.creator.address },
      { address: escrow, writable: true },
      { address: escrowToken, writable: true },
      { address: payer.address, signer: payer, writable: true },
      { address: pi.baseProgram },
      { address: over.locker ?? LOCKER },
      { address: lockerEvents },
      { address: SYSTEM },
    ]);
    return p.both("create_locker", payer, [ix, CU_LIMIT], [pi.pool, pi.baseVault, escrow, escrowToken, POOL_AUTHORITY, payer.address, pi.baseMint]);
  };

  const metadata = async (pi: PoolInfo) => {
    const payer = await p.funded();
    const ix = p.ix("migration_damm_v2_create_metadata", {}, [
      { address: pi.pool },
      { address: pi.config },
      { address: (await pda(PROGRAM, ["damm_v2", pi.pool]))[0] },
      { address: payer.address },
      { address: SYSTEM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
    return p.both("migration_damm_v2_create_metadata", payer, [ix], [pi.pool]);
  };

  async function migrate(
    pi: PoolInfo,
    opts: { dammConfig?: Address | null; noSecond?: boolean; over?: Partial<Record<string, Address>>; sameNft?: boolean; label?: string } = {},
  ) {
    const over = opts.over ?? {};
    const dammConfig = opts.dammConfig === undefined ? DAMM_CONFIGS[pi.params.migration_fee_option]! : opts.dammConfig;
    const payer = await p.funded();
    const cfgKey = dammConfig ?? DAMM_CONFIGS[0]!;
    const [hi, lo] = Buffer.compare(key(pi.baseMint), key(pi.quoteMint)) > 0 ? [pi.baseMint, pi.quoteMint] : [pi.quoteMint, pi.baseMint];
    const [dammPool] = await pda(DAMM_V2, ["pool", cfgKey, hi, lo]);
    const n1 = await generateKeyPairSigner();
    const n2 = opts.sameNft ? n1 : await generateKeyPairSigner();
    const pos = async (m: Address) => [(await pda(DAMM_V2, ["position", m]))[0], (await pda(DAMM_V2, ["position_nft_account", m]))[0]] as const;
    const [pos1, nft1] = await pos(n1.address);
    const [pos2, nft2] = await pos(n2.address);
    const [vaultA] = await pda(DAMM_V2, ["token_vault", pi.baseMint, dammPool]);
    const [vaultB] = await pda(DAMM_V2, ["token_vault", pi.quoteMint, dammPool]);
    const second: Meta[] = opts.noSecond
      ? [{ address: PROGRAM }, { address: PROGRAM }, { address: PROGRAM }]
      : [
          { address: n2.address, signer: n2, writable: true },
          { address: nft2, writable: true },
          { address: pos2, writable: true },
        ];
    const ix = p.ix("migration_damm_v2", {}, [
      { address: over.pool ?? pi.pool, writable: true },
      { address: (await pda(PROGRAM, ["damm_v2", pi.pool]))[0] },
      { address: over.config ?? pi.config },
      { address: POOL_AUTHORITY, writable: true },
      { address: dammPool, writable: true },
      { address: n1.address, signer: n1, writable: true },
      { address: nft1, writable: true },
      { address: pos1, writable: true },
      ...second,
      { address: DAMM_POOL_AUTHORITY },
      { address: over.amm ?? DAMM_V2 },
      { address: pi.baseMint, writable: true },
      { address: pi.quoteMint, writable: true },
      { address: vaultA, writable: true },
      { address: vaultB, writable: true },
      { address: over.baseVault ?? pi.baseVault, writable: true },
      { address: over.quoteVault ?? pi.quoteVault, writable: true },
      { address: payer.address, signer: payer, writable: true },
      { address: pi.baseProgram },
      { address: pi.quoteProgram },
      { address: TOKEN_2022 },
      { address: dammEvents },
      { address: SYSTEM },
      ...(dammConfig ? [{ address: dammConfig }] : []),
    ]);
    const migrated: Migrated = {
      dammPool,
      positions: [pos1, pos2],
      nftMints: [n1.address, n2.address],
      nftAccounts: [nft1, nft2],
      vaults: [vaultA, vaultB],
    };
    const outcome = await p.both(
      opts.label ?? "migration_damm_v2",
      payer,
      [ix, CU_LIMIT],
      [
        pi.pool,
        pi.baseVault,
        pi.quoteVault,
        pi.baseMint,
        pi.quoteMint,
        POOL_AUTHORITY,
        payer.address,
        dammPool,
        pos1,
        pos2,
        n1.address,
        n2.address,
        nft1,
        nft2,
        vaultA,
        vaultB,
      ],
    );
    return { outcome, migrated };
  }

  const maybePool = (params: Params, quoteMint: Address, quoteProgram: Address, opts: { fee?: unknown; hook?: boolean; badge?: boolean } = {}) =>
    makePool(params, quoteMint, quoteProgram, opts, true);
  return {
    p,
    hook,
    config: async (params: Params, quoteMint: Address, opts = {}) => (await config(params, quoteMint, opts))!,
    pool,
    maybePool,
    account,
    buy,
    complete,
    surplus,
    migrationFee,
    leftover,
    locker,
    metadata,
    migrate,
  };
}

/** The DAMM v2 accounts a migration made, read from the original's VM (the port's are compared byte for byte). */
export function dammPool(g: Graduation, m: Migrated) {
  const a = g.p.original.getAccount(m.dammPool);
  if (!a.exists) return null;
  const d = Buffer.from(a.data);
  return { liquidity: d.readBigUInt64LE(360) + (d.readBigUInt64LE(368) << 64n), tokenA: d.readBigUInt64LE(680), tokenB: d.readBigUInt64LE(688) };
}
