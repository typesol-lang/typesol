// DAMM v1 graduation helpers for showcase/mainnet/meteora-dbc, a port subject to Meteora's Non-commercial Licence (see
// showcase/mainnet/meteora-dbc/LICENSE.md): the fourth stage's instructions (migration_meteora_damm_create_metadata,
// migrate_meteora_damm, migrate_meteora_damm_lock_lp_token, migrate_meteora_damm_claim_lp_token) sent to the mainnet
// binary and the port side by side, on a Graduation (meteora-dbc-graduation.ts). Both VMs get DAMM v1 and the dynamic
// vault as deployed on mainnet (test/programs/SOURCES.md), DAMM v1's six migration configs and the wrapped SOL vault
// read from mainnet (showcase/test/fixtures/meteora-dbc/damm-v1, slot in its slot.txt). Other vaults are made by the
// vault program's own `initialize` in both.
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, address, getAddressDecoder, lamports } from "@solana/kit";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pda } from "../../test/harness.js";
import { type Graduation, type PoolInfo, type PoolOpts, CU_LIMIT, MPL, POOL_AUTHORITY, WSOL } from "./meteora-dbc-graduation.js";
import { type Params, PROGRAM, SYSTEM, TOKEN, key } from "./meteora-dbc-helpers.js";

export { WSOL };

export const DAMM_V1 = address("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB");
export const VAULT_PROGRAM = address("24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi");
export const DAMM_V1_SO = fileURLToPath(new URL("../../test/programs/meteora_damm_v1.so", import.meta.url));
export const VAULT_SO = fileURLToPath(new URL("../../test/programs/meteora_vault.so", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/meteora-dbc/damm-v1", import.meta.url));
const MAINNET = fileURLToPath(new URL("./fixtures/meteora-dbc/mainnet", import.meta.url));
/** The dynamic vault's base key (its vaults are PDAs ["vault", mint, base]). */
const VAULT_BASE = address("HWzXGcGHy4tcpYfaRDCyLNzXqBTv3E6BttpCH2vJxArv");
const RENT = address("SysvarRent111111111111111111111111111111111");
const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** DAMM v1's configs for DBC's migration fee options 0–5 (README of the DBC repository, read from mainnet). */
export const DAMM_V1_CONFIGS = [
  "8f848CEy8eY6PhJ3VcemtBDzPPSD4Vq7aJczLZ3o8MmX",
  "HBxB8Lf14Yj8pqeJ8C4qDb5ryHL7xwpuykz31BLNYr7S",
  "7v5vBdUQHTNeqk1HnduiXcgbvCyVEZ612HLmYkQoAkik",
  "EkvP7d5yKxovj884d2DwmBQbrHUWRLGK6bympzrkXGja",
  "9EZYAJrcqNWNQzP2trzZesP7XKMHA1jEomHzbRsdX8R2",
  "8cdKo87jZU2R12KY1BUjjRPwyjgdNjLGqSGQyrDshhud",
].map((a) => address(a));
/** PoolConfig's migration_option and migration_fee_option (offsets in the account). */
export const CONFIG_MIGRATION_OPTION = 233;
export const CONFIG_MIGRATION_FEE_OPTION = 243;
const disc = (bytes: number[]) => new Uint8Array(bytes);
const IX = {
  vaultInitialize: disc([175, 175, 109, 31, 13, 152, 155, 237]),
  createLockEscrow: disc([54, 87, 165, 19, 69, 227, 218, 224]),
};

export interface V1Vault {
  vault: Address;
  tokenVault: Address;
  lpMint: Address;
}

/** The accounts of a DAMM v1 pool made (or to be made) by migrate_meteora_damm for a DBC pool. */
export interface V1Migrated {
  dammConfig: Address;
  dammPool: Address;
  lpMint: Address;
  a: V1Vault;
  b: V1Vault;
  aVaultLp: Address;
  bVaultLp: Address;
  protocolFeeA: Address;
  protocolFeeB: Address;
  mintMetadata: Address;
  /** the pool authority's LP account (its ATA of the LP mint) */
  poolLp: Address;
  migrationMetadata: Address;
}

export interface V1 {
  g: Graduation;
  /** A pool of a new config, its migration option then rewritten to DAMM v1 (0) in both, as configs made before 0.2.1 hold it. */
  pool(params: Params, quoteMint: Address, quoteProgram: Address, opts?: PoolOpts): Promise<PoolInfo>;
  /** Rewrite a config's or pool's bytes in both VMs. */
  patch(at: Address, f: (d: Buffer) => void, owner?: Address): void;
  /** The dynamic vault of `mint`, made by the vault program's `initialize` in both when it does not exist yet. */
  vault(mint: Address): Promise<V1Vault>;
  /** The DAMM v1 accounts of a pool's migration on `dammConfig` (the config's fee option's by default). */
  accounts(pi: PoolInfo, dammConfig?: Address): Promise<V1Migrated>;
  metadata(pi: PoolInfo, over?: Partial<Record<string, Address>>): Promise<string>;
  migrate(
    pi: PoolInfo,
    opts?: { dammConfig?: Address; over?: Partial<Record<string, Address>>; label?: string; makeVaults?: boolean; payer?: KeyPairSigner },
  ): Promise<{ outcome: string; m: V1Migrated }>;
  /** DAMM v1's create_lock_escrow for `owner` and the escrow's LP account, in both. */
  lockEscrow(m: V1Migrated, owner: Address): Promise<{ lockEscrow: Address; escrowVault: Address }>;
  lock(pi: PoolInfo, m: V1Migrated, owner: Address, over?: Partial<Record<string, Address>>): Promise<string>;
  claim(pi: PoolInfo, m: V1Migrated, owner: Address, over?: Partial<Record<string, Address>>, sender?: KeyPairSigner): Promise<string>;
}

const ata = async (owner: Address, m: Address, program: Address = TOKEN) => (await t22.findAssociatedTokenPda({ owner, mint: m, tokenProgram: program }))[0];
const ordered = (a: Address, b: Address) => (Buffer.compare(key(a), key(b)) > 0 ? [a, b] : [b, a]);

/** Load DAMM v1, the dynamic vault and the DAMM v1 fixtures (and the wrapped SOL mint) into a Graduation's two VMs. */
export function graduationV1(g: Graduation): V1 {
  const { p } = g;
  for (const [id, so] of [
    [DAMM_V1, DAMM_V1_SO],
    [VAULT_PROGRAM, VAULT_SO],
  ] as const) {
    const bytes = new Uint8Array(readFileSync(so));
    for (const vm of p.vms()) vm.addProgram(id, bytes);
  }
  const files = [
    ...readdirSync(FIXTURES)
      .filter((x) => x.endsWith(".json"))
      .map((f) => path.join(FIXTURES, f)),
    path.join(MAINNET, `${WSOL}.json`),
  ];
  for (const f of files) {
    const a = JSON.parse(readFileSync(f, "utf8")) as { address: string; lamports: string; owner: string; executable: boolean; data: string };
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

  const patch = (at: Address, f: (d: Buffer) => void, owner?: Address) => {
    for (const vm of p.vms()) {
      const a = vm.getAccount(at);
      if (!a.exists) throw new Error("no account");
      const d = Buffer.from(a.data);
      f(d);
      vm.setAccount({ ...a, data: new Uint8Array(d), ...(owner ? { programAddress: owner } : {}) });
    }
  };

  async function pool(params: Params, quoteMint: Address, quoteProgram: Address, opts: PoolOpts = {}) {
    const pi = await g.pool(params, quoteMint, quoteProgram, opts);
    patch(pi.config, (d) => (d[CONFIG_MIGRATION_OPTION] = 0));
    return pi;
  }

  async function vault(mint: Address): Promise<V1Vault> {
    const [v] = await pda(VAULT_PROGRAM, ["vault", mint, VAULT_BASE]);
    const [tokenVault] = await pda(VAULT_PROGRAM, ["token_vault", v]);
    if (mint === WSOL) {
      // the mainnet vault: its LP mint is the one it records (at 8 + 1 + 2 + 8 + 32 * 3)
      const a = p.original.getAccount(v);
      if (!a.exists) throw new Error("no wrapped SOL vault");
      return { vault: v, tokenVault, lpMint: getAddressDecoder().decode(Buffer.from(a.data).subarray(115, 147)) };
    }
    const [lpMint] = await pda(VAULT_PROGRAM, ["lp_mint", v]);
    if (!p.original.getAccount(v).exists) {
      const payer = await p.funded();
      const ix: Instruction = {
        programAddress: VAULT_PROGRAM,
        accounts: [
          { address: v, role: 1 },
          { address: payer.address, role: 3, signer: payer },
          { address: tokenVault, role: 1 },
          { address: mint, role: 0 },
          { address: lpMint, role: 1 },
          { address: RENT, role: 0 },
          { address: TOKEN, role: 0 },
          { address: SYSTEM, role: 0 },
        ] as Instruction["accounts"],
        data: IX.vaultInitialize,
      };
      await p.setup(payer, [ix]);
    }
    return { vault: v, tokenVault, lpMint };
  }

  async function accounts(pi: PoolInfo, dammConfig?: Address): Promise<V1Migrated> {
    const cfg = dammConfig ?? DAMM_V1_CONFIGS[pi.params.migration_fee_option] ?? DAMM_V1_CONFIGS[0]!;
    const [hi, lo] = ordered(pi.baseMint, pi.quoteMint);
    const [dammPool] = await pda(DAMM_V1, [hi!, lo!, cfg]);
    const [lpMint] = await pda(DAMM_V1, ["lp_mint", dammPool]);
    const derive = async (mint: Address): Promise<V1Vault> => {
      if (mint === WSOL) return vault(WSOL);
      const [v] = await pda(VAULT_PROGRAM, ["vault", mint, VAULT_BASE]);
      return { vault: v, tokenVault: (await pda(VAULT_PROGRAM, ["token_vault", v]))[0], lpMint: (await pda(VAULT_PROGRAM, ["lp_mint", v]))[0] };
    };
    const a = await derive(pi.baseMint);
    const b = await derive(pi.quoteMint);
    return {
      dammConfig: cfg,
      dammPool,
      lpMint,
      a,
      b,
      aVaultLp: (await pda(DAMM_V1, [a.vault, dammPool]))[0],
      bVaultLp: (await pda(DAMM_V1, [b.vault, dammPool]))[0],
      protocolFeeA: (await pda(DAMM_V1, ["fee", pi.baseMint, dammPool]))[0],
      protocolFeeB: (await pda(DAMM_V1, ["fee", pi.quoteMint, dammPool]))[0],
      mintMetadata: (await pda(MPL, ["metadata", MPL, lpMint]))[0],
      poolLp: await ata(POOL_AUTHORITY, lpMint),
      migrationMetadata: (await pda(PROGRAM, ["meteora", pi.pool]))[0],
    };
  }

  async function metadata(pi: PoolInfo, over: Partial<Record<string, Address>> = {}) {
    const payer = await p.funded();
    const at = over.metadata ?? (await pda(PROGRAM, ["meteora", over.seed ?? pi.pool]))[0];
    const ix = p.ix("migration_meteora_damm_create_metadata", {}, [
      { address: over.pool ?? pi.pool },
      { address: over.config ?? pi.config },
      { address: at, writable: true },
      { address: payer.address, signer: payer, writable: true },
      { address: SYSTEM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
    return p.both("migration_meteora_damm_create_metadata", payer, [ix], [at, pi.pool, payer.address]);
  }

  async function migrate(
    pi: PoolInfo,
    opts: { dammConfig?: Address; over?: Partial<Record<string, Address>>; label?: string; makeVaults?: boolean; payer?: KeyPairSigner } = {},
  ) {
    const over = opts.over ?? {};
    if (opts.makeVaults !== false) {
      await vault(pi.baseMint);
      await vault(pi.quoteMint);
    }
    const m = await accounts(pi, opts.dammConfig);
    const payer = opts.payer ?? (await p.funded());
    const ix = p.ix("migrate_meteora_damm", {}, [
      { address: over.pool ?? pi.pool, writable: true },
      { address: over.metadata ?? m.migrationMetadata, writable: true },
      { address: over.config ?? pi.config },
      { address: over.poolAuthority ?? POOL_AUTHORITY, writable: true },
      { address: m.dammPool, writable: true },
      { address: m.dammConfig },
      { address: m.lpMint, writable: true },
      { address: pi.baseMint, writable: true },
      { address: pi.quoteMint },
      { address: m.a.vault, writable: true },
      { address: m.b.vault, writable: true },
      { address: m.a.tokenVault, writable: true },
      { address: m.b.tokenVault, writable: true },
      { address: m.a.lpMint, writable: true },
      { address: m.b.lpMint, writable: true },
      { address: m.aVaultLp, writable: true },
      { address: m.bVaultLp, writable: true },
      { address: over.baseVault ?? pi.baseVault, writable: true },
      { address: over.quoteVault ?? pi.quoteVault, writable: true },
      { address: m.poolLp, writable: true },
      { address: m.protocolFeeA, writable: true },
      { address: m.protocolFeeB, writable: true },
      { address: payer.address, signer: payer, writable: true },
      { address: RENT },
      { address: m.mintMetadata, writable: true },
      { address: MPL },
      { address: over.amm ?? DAMM_V1 },
      { address: VAULT_PROGRAM },
      { address: over.tokenProgram ?? TOKEN },
      { address: ATA_PROGRAM },
      { address: SYSTEM },
    ]);
    const outcome = await p.both(
      opts.label ?? "migrate_meteora_damm",
      payer,
      [ix, CU_LIMIT],
      [
        pi.pool,
        m.migrationMetadata,
        pi.baseVault,
        pi.quoteVault,
        pi.baseMint,
        pi.quoteMint,
        POOL_AUTHORITY,
        payer.address,
        m.dammPool,
        m.lpMint,
        m.a.vault,
        m.b.vault,
        m.a.tokenVault,
        m.b.tokenVault,
        m.a.lpMint,
        m.b.lpMint,
        m.aVaultLp,
        m.bVaultLp,
        m.poolLp,
        m.protocolFeeA,
        m.protocolFeeB,
        m.mintMetadata,
      ],
    );
    return { outcome, m };
  }

  async function lockEscrow(m: V1Migrated, owner: Address) {
    const [escrow] = await pda(DAMM_V1, ["lock_escrow", m.dammPool, owner]);
    const escrowVault = await ata(escrow, m.lpMint);
    if (!p.original.getAccount(escrow).exists) {
      const payer = await p.funded();
      const ix: Instruction = {
        programAddress: DAMM_V1,
        accounts: [
          { address: m.dammPool, role: 0 },
          { address: escrow, role: 1 },
          { address: owner, role: 0 },
          { address: m.lpMint, role: 0 },
          { address: payer.address, role: 3, signer: payer },
          { address: SYSTEM, role: 0 },
        ] as Instruction["accounts"],
        data: IX.createLockEscrow,
      };
      await p.setup(payer, [
        ix,
        t22.getCreateAssociatedTokenIdempotentInstruction({ payer, ata: escrowVault, owner: escrow, mint: m.lpMint, tokenProgram: TOKEN }) as Instruction,
      ]);
    }
    return { lockEscrow: escrow, escrowVault };
  }

  async function lock(pi: PoolInfo, m: V1Migrated, owner: Address, over: Partial<Record<string, Address>> = {}) {
    const e = over.lockEscrow
      ? { lockEscrow: over.lockEscrow, escrowVault: over.escrowVault ?? (await ata(over.lockEscrow, m.lpMint)) }
      : await lockEscrow(m, owner);
    const payer = await p.funded();
    const ix = p.ix("migrate_meteora_damm_lock_lp_token", {}, [
      { address: over.pool ?? pi.pool },
      { address: over.metadata ?? m.migrationMetadata, writable: true },
      { address: over.poolAuthority ?? POOL_AUTHORITY, writable: true },
      { address: over.dammPool ?? m.dammPool, writable: true },
      { address: over.lpMint ?? m.lpMint },
      { address: e.lockEscrow, writable: true },
      { address: over.owner ?? owner },
      { address: over.source ?? m.poolLp, writable: true },
      { address: over.escrowVault ?? e.escrowVault, writable: true },
      { address: over.amm ?? DAMM_V1 },
      { address: m.a.vault },
      { address: m.b.vault },
      { address: m.aVaultLp },
      { address: m.bVaultLp },
      { address: m.a.lpMint },
      { address: m.b.lpMint },
      { address: TOKEN },
    ]);
    return p.both(
      "migrate_meteora_damm_lock_lp_token",
      payer,
      [ix, CU_LIMIT],
      [m.migrationMetadata, m.dammPool, e.lockEscrow, m.poolLp, e.escrowVault, POOL_AUTHORITY],
    );
  }

  async function claim(pi: PoolInfo, m: V1Migrated, owner: Address, over: Partial<Record<string, Address>> = {}, sender?: KeyPairSigner) {
    const dst = over.destination ?? (await g.account(owner, m.lpMint, TOKEN));
    const s = sender ?? (await p.funded());
    const ix = p.ix("migrate_meteora_damm_claim_lp_token", {}, [
      { address: over.pool ?? pi.pool },
      { address: over.metadata ?? m.migrationMetadata, writable: true },
      { address: over.poolAuthority ?? POOL_AUTHORITY, writable: true },
      { address: over.lpMint ?? m.lpMint },
      { address: over.source ?? m.poolLp, writable: true },
      { address: dst, writable: true },
      { address: over.owner ?? owner },
      { address: s.address, signer: s },
      { address: TOKEN },
    ]);
    return p.both("migrate_meteora_damm_claim_lp_token", s, [ix], [m.migrationMetadata, m.poolLp, dst]);
  }

  return { g, pool, patch, vault, accounts, metadata, migrate, lockEscrow, lock, claim };
}

/** The LP amounts a DAMM v1 migration recorded (MeteoraDammMigrationMetadata, read from the original's VM). */
export function v1Metadata(v: V1, m: V1Migrated) {
  const a = v.g.p.original.getAccount(m.migrationMetadata);
  if (!a.exists) return null;
  const d = Buffer.from(a.data);
  return {
    partnerLocked: d.readBigUInt64LE(136),
    partner: d.readBigUInt64LE(144),
    creatorLocked: d.readBigUInt64LE(152),
    creator: d.readBigUInt64LE(160),
    status: [...d.subarray(169, 173)],
  };
}

/** A token account's amount in the original's VM. */
export function tokenAmount(v: V1, at: Address) {
  const a = v.g.p.original.getAccount(at);
  return a.exists ? Buffer.from(a.data).readBigUInt64LE(64) : null;
}
