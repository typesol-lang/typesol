// swap and swap2 of showcase/mainnet/meteora-dbc (a port subject to Meteora's Non-commercial Licence, see that
// directory's LICENSE.md) against Meteora's Dynamic Bonding Curve 0.2.2 on mainnet, side by side
// (showcase/test/meteora-dbc-helpers.ts). Configs are made by create_config, create_config2 (a base transfer fee) or
// create_config_with_transfer_hook in both, pools by the pool creation instructions in both (written, as those leave a
// pool, only under a config rewritten to a rate limiter, which pool creation refuses). Every swap must give the same
// outcome, pool, vault and user bytes, and the same events. A random sequence of swaps per pool (every mode, both
// directions, referrals, slippage limits) runs to the migration threshold. Reproduce with FUZZ_SEED=<seed>; lengthen with FUZZ_RUNS=<n> (pools per run).
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner, lamports } from "@solana/kit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, deployFile, pda } from "../../test/harness.js";
const RELAY = fileURLToPath(new URL("./fixtures/meteora-dbc/relay.ts", import.meta.url));
const pdaOf = (seeds: (string | Address)[]) => pda("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN" as Address, seeds);
const MPL = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s" as Address;
const MPL_SO = fileURLToPath(new URL("../../test/programs/mpl_token_metadata.so", import.meta.url));
import { present } from "../../test/binaries.js";
import { Rng } from "./fuzz-rng.js";
import {
  type Ext,
  type Meta,
  type Pair,
  type Params,
  ORIGINAL,
  PROGRAM,
  SYSTEM,
  TOKEN,
  TOKEN_2022,
  baseParams,
  coded,
  constantSupply,
  custom,
  disc,
  key,
  loadHook,
  mint,
  pair,
  transferFee,
} from "./meteora-dbc-helpers.js";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const RUNS = Number(process.env.FUZZ_RUNS ?? 12);
const POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM" as Address;
const INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
const E = {
  AmountIsZero: 6005,
  TypeCastFailed: 6006,
  ExceededSlippage: 6002,
  PoolIsCompleted: 6013,
  InvalidRemainingAccountsLength: 6070,
  InvalidInstructionsSysvar: 6069,
  PoolTypeMismatch: 6076,
  InvalidPoolAccount: 6075,
  InvalidConfigAccount: 6024,
  FailToValidateSingleSwapInstruction: 6043,
} as const;

const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u128le = (n: bigint) => Buffer.concat([u64le(n & ((1n << 64n) - 1n)), u64le(n >> 64n)]);

describe.skipIf(!present(ORIGINAL, MPL_SO))("showcase/mainnet/meteora-dbc swaps against Meteora DBC 0.2.2 on mainnet", () => {
  let p: Pair;
  let hookProgram: Address;
  beforeAll(async () => {
    p = await pair();
    const so = new Uint8Array(readFileSync(MPL_SO));
    for (const vm of p.vms()) vm.addProgram(MPL, so);
    hookProgram = await loadHook(p);
  }, 300_000);

  const ata = async (owner: Address, m: Address, program: Address) => (await t22.findAssociatedTokenPda({ owner, mint: m, tokenProgram: program }))[0];
  /** The associated token account of `owner` for `m`, made in both, its balance written as `amount`. */
  async function account(owner: Address, m: Address, program: Address, amount: bigint) {
    const payer = await p.funded();
    const at = await ata(owner, m, program);
    await p.setup(payer, [t22.getCreateAssociatedTokenIdempotentInstruction({ payer, ata: at, owner, mint: m, tokenProgram: program }) as Instruction]);
    for (const vm of p.vms()) {
      const a = vm.getAccount(at);
      if (!a.exists) throw new Error("no account");
      const data = Buffer.from(a.data);
      data.writeBigUInt64LE(amount, 64);
      vm.setAccount({ ...a, data: new Uint8Array(data) });
    }
    return at;
  }

  const claimers = new Map<Address, KeyPairSigner>();
  /** A config made by create_config in both; `patch` rewrites its bytes after (a rate limiter: what pre-0.2.1 configs hold). */
  async function config(params: Params, quoteMint: Address, patch?: (data: Buffer) => void, opts: { fee?: unknown; hook?: Address } = {}) {
    const payer = await p.funded();
    const cfg = await generateKeyPairSigner();
    const ixName = opts.hook ? "create_config_with_transfer_hook" : opts.fee ? "create_config2" : "create_config";
    const args: Record<string, unknown> = { config_parameters: coded(params) };
    if (opts.fee) args.transfer_fee_parameters = opts.fee;
    const ix = p.ix(ixName, args, [
      { address: cfg.address, signer: cfg, writable: true },
      { address: payer.address },
      { address: payer.address },
      { address: quoteMint },
      ...(opts.hook ? [{ address: opts.hook }] : []),
      { address: payer.address, signer: payer, writable: true },
      { address: SYSTEM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
    expect(await p.both("create the config", payer, [ix], [cfg.address])).toBe("ok");
    claimers.set(cfg.address, payer);
    if (patch)
      for (const vm of p.vms()) {
        const a = vm.getAccount(cfg.address);
        if (!a.exists) throw new Error("no config");
        const data = Buffer.from(a.data);
        patch(data);
        vm.setAccount({ ...a, data: new Uint8Array(data) });
      }
    return cfg.address;
  }

  const creators = new Map<Address, KeyPairSigner>();
  interface PoolInfo {
    pool: Address;
    config: Address;
    baseMint: Address;
    quoteMint: Address;
    baseProgram: Address;
    quoteProgram: Address;
    baseVault: Address;
    quoteVault: Address;
    /** made by the pool creation instruction (else written) */
    made: boolean;
  }
  /** A pool written in both as initialize leaves it: price at the start, the base supply in its vault. */
  /**
   * A pool of `cfg`, made by the pool creation instruction in both (compared like every other transaction):
   * initialize_virtual_pool_with_spl_token for an SPL base, initialize_virtual_pool_with_token2022 for a Token-2022 base
   * (its transfer fee from the config), initialize_virtual_pool_with_token2022_transfer_hook for a TransferHookPool (a
   * transfer hook config). Written into both instead, as those instructions leave a pool, only for a config rewritten to
   * a rate limiter (`written`): pool creation refuses that mode, so only pools made before 0.2.1 have it.
   */
  async function pool(
    cfg: Address,
    params: Params,
    quoteMint: Address,
    quoteProgram: Address,
    baseExts: Ext[] = [],
    hook = false,
    written = false,
  ): Promise<PoolInfo> {
    const baseProgram = params.token_type === 1 ? TOKEN_2022 : TOKEN;
    if (baseProgram === TOKEN_2022 && !written) {
      const creator = await p.funded();
      const baseMint = await generateKeyPairSigner();
      const [hi, lo] = Buffer.compare(key(baseMint.address), key(quoteMint)) > 0 ? [baseMint.address, quoteMint] : [quoteMint, baseMint.address];
      const [poolKey] = await pdaOf(["pool", cfg, hi, lo]);
      const [baseVault] = await pdaOf(["token_vault", baseMint.address, poolKey]);
      const [quoteVault] = await pdaOf(["token_vault", quoteMint, poolKey]);
      const name = hook ? "initialize_virtual_pool_with_token2022_transfer_hook" : "initialize_virtual_pool_with_token2022";
      const ix = p.ix(name, { params: { name: "Token", symbol: "TKN", uri: "" } }, [
        { address: cfg },
        { address: POOL_AUTHORITY },
        { address: creator.address, signer: creator },
        { address: baseMint.address, signer: baseMint, writable: true },
        { address: quoteMint },
        { address: poolKey, writable: true },
        { address: baseVault, writable: true },
        { address: quoteVault, writable: true },
        ...(hook ? [{ address: hookProgram }] : []),
        { address: creator.address, signer: creator, writable: true },
        { address: quoteProgram },
        { address: TOKEN_2022 },
        { address: SYSTEM },
        { address: p.eventAuthority },
        { address: PROGRAM },
      ]);
      expect(await p.both("create the pool", creator, [ix], [poolKey, baseMint.address, baseVault, quoteVault])).toBe("ok");
      creators.set(poolKey, creator);
      return { pool: poolKey, config: cfg, baseMint: baseMint.address, quoteMint, baseProgram, quoteProgram, baseVault, quoteVault, made: true };
    }
    if (baseProgram === TOKEN && !written) {
      const creator = await p.funded();
      const baseMint = await generateKeyPairSigner();
      const [hi, lo] = Buffer.compare(key(baseMint.address), key(quoteMint)) > 0 ? [baseMint.address, quoteMint] : [quoteMint, baseMint.address];
      const [poolKey] = await pdaOf(["pool", cfg, hi, lo]);
      const [baseVault] = await pdaOf(["token_vault", baseMint.address, poolKey]);
      const [quoteVault] = await pdaOf(["token_vault", quoteMint, poolKey]);
      const [metadata] = await pda(MPL, ["metadata", MPL, baseMint.address]);
      const ix = p.ix("initialize_virtual_pool_with_spl_token", { params: { name: "Token", symbol: "TKN", uri: "" } }, [
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
      ]);
      expect(await p.both("create the pool", creator, [ix], [poolKey, baseMint.address, baseVault, quoteVault, metadata])).toBe("ok");
      creators.set(poolKey, creator);
      return { pool: poolKey, config: cfg, baseMint: baseMint.address, quoteMint, baseProgram, quoteProgram, baseVault, quoteVault, made: true };
    }
    const baseMint = await mint(p, baseProgram, params.token_decimal, baseProgram === TOKEN_2022 ? baseExts : []);
    const supply = 10n ** 17n;
    const baseVault = await account(POOL_AUTHORITY, baseMint, baseProgram, supply);
    const quoteVault = await account(POOL_AUTHORITY, quoteMint, quoteProgram, 0n);
    const creatorSigner = await p.funded();
    const creator = creatorSigner.address;
    const poolKey = (await generateKeyPairSigner()).address;
    const state = Buffer.alloc(416);
    key(cfg).copy(state, 64);
    key(creator).copy(state, 96);
    key(baseMint).copy(state, 128);
    key(baseVault).copy(state, 160);
    key(quoteVault).copy(state, 192);
    u64le(supply).copy(state, 224);
    u128le(params.sqrt_start_price).copy(state, 272);
    const clock = p.original.getClock();
    u64le(params.activation_type === 0 ? clock.slot : clock.unixTimestamp).copy(state, 288);
    state[296] = params.token_type;
    state.writeUInt16LE(20, 368);
    p.write(poolKey, Buffer.concat([disc(hook ? "TransferHookPool" : "VirtualPool"), state]));
    creators.set(poolKey, creatorSigner);
    return { pool: poolKey, config: cfg, baseMint, quoteMint, baseProgram, quoteProgram, baseVault, quoteVault, made: false };
  }

  interface Trader {
    who: KeyPairSigner;
    base: Address;
    quote: Address;
  }
  async function trader(pi: PoolInfo, quote = 10n ** 15n, base = 0n): Promise<Trader> {
    const who = await p.funded();
    return {
      who,
      base: await account(who.address, pi.baseMint, pi.baseProgram, base),
      quote: await account(who.address, pi.quoteMint, pi.quoteProgram, quote),
    };
  }

  type Mode = 0 | 1 | 2;
  function swapIx(
    pi: PoolInfo,
    t: Trader,
    quoteToBase: boolean,
    amount0: bigint,
    amount1: bigint,
    mode: Mode | "legacy" | number,
    opts: { referral?: Address; rest?: Address[]; accounts?: Partial<Record<string, Address>> } = {},
  ) {
    const a = { ...pi, ...opts.accounts } as PoolInfo & Record<string, Address>;
    const metas: Meta[] = [
      { address: (opts.accounts?.poolAuthority ?? POOL_AUTHORITY) as Address },
      { address: a.config },
      { address: a.pool, writable: true },
      { address: quoteToBase ? t.quote : t.base, writable: true },
      { address: quoteToBase ? t.base : t.quote, writable: true },
      { address: a.baseVault, writable: true },
      { address: a.quoteVault, writable: true },
      { address: a.baseMint },
      { address: a.quoteMint },
      { address: t.who.address, signer: t.who },
      { address: a.baseProgram },
      { address: a.quoteProgram },
      opts.referral ? { address: opts.referral, writable: true } : { address: PROGRAM },
      { address: p.eventAuthority },
      { address: PROGRAM },
      ...(opts.rest ?? []).map((address) => ({ address })),
    ];
    if (mode === "legacy") return p.ix("swap", { params: { amount_in: new BN(amount0.toString()), minimum_amount_out: new BN(amount1.toString()) } }, metas);
    return p.ix("swap2", { params: { amount_0: new BN(amount0.toString()), amount_1: new BN(amount1.toString()), swap_mode: mode } }, metas);
  }
  const watch = (pi: PoolInfo, t: Trader, extra: Address[] = []) => [pi.pool, pi.baseVault, pi.quoteVault, t.base, t.quote, ...extra];
  const doSwap = (
    label: string,
    pi: PoolInfo,
    t: Trader,
    quoteToBase: boolean,
    a0: bigint,
    a1: bigint,
    mode: Mode | "legacy" | number,
    opts: Parameters<typeof swapIx>[6] = {},
  ) => p.both(label, t.who, [swapIx(pi, t, quoteToBase, a0, a1, mode, opts)], watch(pi, t, opts.referral ? [opts.referral] : []));

  let quoteSpl: Address;
  beforeAll(async () => {
    quoteSpl = await mint(p, TOKEN, 9);
  }, 300_000);

  it("swap and swap2: every mode in both directions, a referral, slippage limits, to the threshold", async () => {
    const params = baseParams();
    const cfg = await config(params, quoteSpl);
    const pi = await pool(cfg, params, quoteSpl, TOKEN);
    const t = await trader(pi);
    expect(await doSwap("legacy swap, quote in", pi, t, true, 1_000_000_000n, 0n, "legacy")).toBe("ok");
    expect(await doSwap("exact in, quote in", pi, t, true, 5_000_000_000n, 1n, 0)).toBe("ok");
    expect(await doSwap("exact in, base in", pi, t, false, 1_000_000_000_000n, 0n, 0)).toBe("ok");
    expect(await doSwap("exact out, base out", pi, t, true, 2_000_000_000_000n, 10n ** 12n, 2)).toBe("ok");
    expect(await doSwap("exact out, quote out", pi, t, false, 100_000_000n, 10n ** 15n, 2)).toBe("ok");
    expect(await doSwap("partial fill, quote in", pi, t, true, 3_000_000_000n, 0n, 1)).toBe("ok");
    const referral = await account((await generateKeyPairSigner()).address, pi.quoteMint, TOKEN, 0n);
    expect(await doSwap("with a referral", pi, t, true, 2_000_000_000n, 0n, 0, { referral })).toBe("ok");
    expect(await doSwap("slippage, exact in", pi, t, true, 1_000_000_000n, 10n ** 15n, 0)).toBe(custom(E.ExceededSlippage));
    expect(await doSwap("slippage, exact out", pi, t, true, 1_000_000_000n, 1n, 2)).toBe(custom(E.ExceededSlippage));
    expect(await doSwap("zero in", pi, t, true, 0n, 0n, 0)).toBe(custom(E.AmountIsZero));
    expect(await doSwap("swap mode 3", pi, t, true, 1n, 0n, 3)).toBe(custom(E.TypeCastFailed));
    expect(await doSwap("exact in past the threshold", pi, t, true, 10n ** 14n, 0n, 0)).not.toBe("");
    expect(await doSwap("partial fill to the threshold", pi, t, true, 10n ** 14n, 0n, 1)).toBe("ok");
    expect(await doSwap("after completion", pi, t, true, 1_000_000n, 0n, 0)).toBe(custom(E.PoolIsCompleted));
  });

  it("swap: the accounts it refuses", async () => {
    const params = baseParams();
    const cfg = await config(params, quoteSpl);
    const pi = await pool(cfg, params, quoteSpl, TOKEN);
    const t = await trader(pi);
    const other = await pool(cfg, params, quoteSpl, TOKEN);
    const hookParams = { ...params, token_type: 1 };
    const hookPool = await pool(await config(hookParams, quoteSpl, undefined, { hook: hookProgram }), hookParams, quoteSpl, TOKEN, [], true);
    const cases: [string, Parameters<typeof swapIx>[6], number | string][] = [
      ["another pool's base vault (another mint)", { accounts: { baseVault: other.baseVault } }, custom(2014)],
      ["another config", { accounts: { config: await config(params, quoteSpl) } }, custom(2001)],
      [
        "a transfer hook pool",
        {
          accounts: {
            pool: hookPool.pool,
            baseVault: hookPool.baseVault,
            quoteVault: hookPool.quoteVault,
            baseMint: hookPool.baseMint,
            baseProgram: TOKEN_2022,
          },
        },
        custom(E.PoolTypeMismatch),
      ],
      ["a config as the pool", { accounts: { pool: cfg } }, custom(E.InvalidPoolAccount)],
      ["a wallet as the pool", { accounts: { pool: t.who.address } }, custom(E.InvalidPoolAccount)],
      ["another pool authority", { accounts: { poolAuthority: t.who.address } }, custom(2012)],
      ["a wrong sysvar", { rest: [SYSTEM] }, custom(E.InvalidInstructionsSysvar)],
      ["two remaining accounts", { rest: [INSTRUCTIONS, INSTRUCTIONS] }, custom(E.InvalidRemainingAccountsLength)],
      ["the instructions sysvar", { rest: [INSTRUCTIONS] }, "ok"],
    ];
    for (const [label, opts, want] of cases) expect(await doSwap(label, pi, t, true, 1_000_000_000n, 0n, 0, opts), label).toBe(want);
  });

  it("fee claims, creation fees and the creator role", async () => {
    const params = { ...baseParams(), creator_trading_fee_percentage: 30, pool_creation_fee: 1_000_000_000n, collect_fee_mode: 1 };
    const cfg = await config(params, quoteSpl);
    const pi = await pool(cfg, params, quoteSpl, TOKEN);
    // the creation fee the pool holds beyond its rent (a pool made by the instruction was charged it there)
    if (!pi.made)
      for (const vm of p.vms()) {
        const a = vm.getAccount(pi.pool);
        if (!a.exists) throw new Error("no pool");
        vm.setAccount({ ...a, lamports: lamports(a.lamports + 1_000_000_000n) });
      }
    const t = await trader(pi);
    expect(await doSwap("fees in base", pi, t, true, 20_000_000_000n, 0n, 0)).toBe("ok");
    expect(await doSwap("fees in quote", pi, t, false, 10n ** 12n, 0n, 0)).toBe("ok");
    const claimer = claimers.get(cfg)!;
    const creator = creators.get(pi.pool)!;
    const dstA = await account(claimer.address, pi.baseMint, TOKEN, 0n);
    const dstB = await account(claimer.address, pi.quoteMint, TOKEN, 0n);
    const cA = await account(creator.address, pi.baseMint, TOKEN, 0n);
    const cB = await account(creator.address, pi.quoteMint, TOKEN, 0n);
    const tradingAccounts = (who: KeyPairSigner, a: Address, b: Address, over: Partial<Record<string, Address>> = {}, withConfig = true): Meta[] => [
      { address: POOL_AUTHORITY },
      ...(withConfig ? [{ address: over.config ?? cfg }] : []),
      { address: over.pool ?? pi.pool, writable: true },
      { address: a, writable: true },
      { address: b, writable: true },
      { address: over.baseVault ?? pi.baseVault, writable: true },
      { address: pi.quoteVault, writable: true },
      { address: pi.baseMint },
      { address: over.quoteMint ?? pi.quoteMint },
      { address: who.address, signer: who },
      { address: TOKEN },
      { address: TOKEN },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ];
    const big = (n: bigint) => new BN(n.toString());
    const partner = (who: KeyPairSigner, a: bigint, b: bigint, over = {}) =>
      p.both(
        "claim_trading_fee",
        who,
        [p.ix("claim_trading_fee", { max_amount_a: big(a), max_amount_b: big(b) }, tradingAccounts(who, dstA, dstB, over))],
        [pi.pool, pi.baseVault, pi.quoteVault, dstA, dstB],
      );
    const creatorClaim = (who: KeyPairSigner, a: bigint, b: bigint, over = {}) =>
      p.both(
        "claim_creator_trading_fee",
        who,
        [p.ix("claim_creator_trading_fee", { max_base_amount: big(a), max_quote_amount: big(b) }, tradingAccounts(who, cA, cB, over, false))],
        [pi.pool, pi.baseVault, pi.quoteVault, cA, cB],
      );
    expect(await partner(t.who, 1n, 1n)).toBe(custom(6053));
    expect(await partner(claimer, 1n, 1n, { quoteMint: pi.baseMint })).not.toBe("ok");
    expect(await partner(claimer, 1000n, 0n)).toBe("ok");
    expect(await partner(claimer, 10n ** 18n, 10n ** 18n)).toBe("ok");
    expect(await partner(claimer, 10n ** 18n, 10n ** 18n)).toBe("ok");
    expect(await creatorClaim(t.who, 1n, 1n)).toBe(custom(6053));
    expect(await creatorClaim(creator, 10n ** 18n, 5n)).toBe("ok");
    expect(await creatorClaim(creator, 10n ** 18n, 10n ** 18n)).toBe("ok");
    expect(await creatorClaim(creator, 1n, 1n, { pool: cfg })).toBe(custom(E.InvalidPoolAccount));

    const receiver = (await generateKeyPairSigner()).address;
    const partnerCreation = (who: KeyPairSigner) =>
      p.both(
        "claim_partner_pool_creation_fee",
        who,
        [
          p.ix("claim_partner_pool_creation_fee", {}, [
            { address: cfg },
            { address: pi.pool, writable: true },
            { address: who.address, signer: who },
            { address: receiver, writable: true },
            { address: p.eventAuthority },
            { address: PROGRAM },
          ]),
        ],
        [pi.pool, receiver],
      );
    expect(await partnerCreation(t.who)).toBe(custom(6053));
    expect(await partnerCreation(claimer)).toBe("ok");
    expect(await partnerCreation(claimer)).toBe(custom(6052));
    const noFee = await config(baseParams(), quoteSpl);
    expect(
      await p.both(
        "no creation fee",
        claimers.get(noFee)!,
        [
          p.ix("claim_partner_pool_creation_fee", {}, [
            { address: noFee },
            { address: pi.pool, writable: true },
            { address: claimers.get(noFee)!.address, signer: claimers.get(noFee)! },
            { address: receiver, writable: true },
            { address: p.eventAuthority },
            { address: PROGRAM },
          ]),
        ],
        [pi.pool, receiver],
      ),
    ).toBe(custom(6054));

    // the protocol's share goes to the treasury, for an operator with ClaimProtocolFee (bit 0)
    const treasury = "6aYhxiNGmG8AyU25rh2R7iFu4pBrqnQHpNUGhmsEXRcm" as Address;
    const op = await p.funded();
    const [operator] = await pdaOf(["operator", op.address]);
    expect(
      await p.both(
        "an operator",
        p.admins[0]!,
        [
          p.ix("create_operator_account", { permission: new BN(1) }, [
            { address: operator, writable: true },
            { address: op.address },
            { address: p.admins[0]!.address, signer: p.admins[0]! },
            { address: p.admins[0]!.address, signer: p.admins[0]!, writable: true },
            { address: SYSTEM },
            { address: p.eventAuthority },
            { address: PROGRAM },
          ]),
        ],
        [operator],
      ),
    ).toBe("ok");
    const protocolCreation = (who: KeyPairSigner, to = treasury) =>
      p.both(
        "claim_protocol_pool_creation_fee",
        who,
        [
          p.ix("claim_protocol_pool_creation_fee", {}, [
            { address: cfg },
            { address: pi.pool, writable: true },
            { address: operator },
            { address: who.address, signer: who },
            { address: to, writable: true },
            { address: p.eventAuthority },
            { address: PROGRAM },
          ]),
        ],
        [pi.pool, to],
      );
    expect(await protocolCreation(t.who)).toBe(custom(6060));
    expect(await protocolCreation(op, receiver)).toBe(custom(2012));
    expect(await protocolCreation(op)).toBe("ok");
    expect(await protocolCreation(op)).toBe("ok");

    // transfer_pool_creator
    const newCreator = (await generateKeyPairSigner()).address;
    const transfer = (who: KeyPairSigner, to: Address, poolKey = pi.pool, rest: Address[] = []) =>
      p.both(
        "transfer_pool_creator",
        who,
        [
          p.ix("transfer_pool_creator", {}, [
            { address: poolKey, writable: true },
            { address: cfg },
            { address: who.address, signer: who },
            { address: to },
            { address: p.eventAuthority },
            { address: PROGRAM },
            ...rest.map((address) => ({ address })),
          ]),
        ],
        [poolKey],
      );
    expect(await transfer(creator, creator.address)).toBe(custom(6036));
    expect(await transfer(t.who, newCreator)).toBe(custom(6053));
    expect(await transfer(creator, newCreator)).toBe("ok");
    expect(await transfer(creator, t.who.address)).toBe(custom(6053));
    // a completed curve (LockedVesting) cannot move it; a migrated pool (CreatedPool) can
    const done = await pool(cfg, params, quoteSpl, TOKEN);
    const doneCreator = creators.get(done.pool)!;
    for (const [progress, want] of [
      [2, custom(6022)],
      [4, custom(E.TypeCastFailed)],
      [3, "ok"],
    ] as const) {
      for (const vm of p.vms()) {
        const a = vm.getAccount(done.pool);
        if (!a.exists) throw new Error("no pool");
        const data = Buffer.from(a.data);
        data[8 + 300] = progress;
        vm.setAccount({ ...a, data: new Uint8Array(data) });
      }
      expect(await transfer(doneCreator, (await generateKeyPairSigner()).address, done.pool), `progress ${progress}`).toBe(want);
    }
  });

  it("claim_protocol_fee2 (its signer the protocol fee program's authority) and create_virtual_pool_metadata", async () => {
    const params = { ...baseParams(), collect_fee_mode: 1 };
    const cfg = await config(params, quoteSpl);
    const pi = await pool(cfg, params, quoteSpl, TOKEN);
    const t = await trader(pi);
    expect(await doSwap("fees in base", pi, t, true, 20_000_000_000n, 0n, 0)).toBe("ok");
    expect(await doSwap("fees in quote", pi, t, false, 10n ** 12n, 0n, 0)).toBe("ok");
    const auth = p.protocolFeeAuthority;
    const rb = await account(auth.address, pi.baseMint, TOKEN, 0n);
    const rq = await account(auth.address, pi.quoteMint, TOKEN, 0n);
    const claim = (receiver: Address, max: bigint, who: KeyPairSigner = auth, over: Partial<Record<string, Address>> = {}) =>
      p.both(
        "claim_protocol_fee2",
        who,
        [
          p.ix("claim_protocol_fee2", { max_amount: new BN(max.toString()) }, [
            { address: receiver, writable: true },
            { address: pi.baseMint },
            { address: over.quoteMint ?? pi.quoteMint },
            { address: TOKEN },
            { address: over.quoteProgram ?? TOKEN },
            { address: cfg },
            { address: pi.pool, writable: true },
            { address: pi.baseVault, writable: true },
            { address: pi.quoteVault, writable: true },
            { address: POOL_AUTHORITY },
            { address: who.address, signer: who },
          ]),
        ],
        [pi.pool, pi.baseVault, pi.quoteVault, receiver],
      );
    expect(await claim(rb, 1n, t.who)).toBe(custom(2012));
    expect(await claim(rb, 1000n)).toBe("ok");
    expect(await claim(rb, 10n ** 18n)).toBe("ok");
    expect(await claim(rb, 10n ** 18n)).toBe("ok");
    expect(await claim(rq, 10n ** 18n)).toBe("ok");
    expect(await claim(rq, 10n ** 18n, auth, { quoteProgram: TOKEN_2022 })).toBe(custom(6068));
    expect(await claim(t.base, 1n, auth, { quoteMint: pi.baseMint })).toBe(custom(2001));
    const stranger = await account(auth.address, quoteSpl === pi.quoteMint ? await mint(p, TOKEN, 6) : quoteSpl, TOKEN, 0n);
    expect(await claim(stranger, 1n)).toBe(custom(6068));
    // the quote surplus share once the curve completes
    expect(await doSwap("to the threshold", pi, t, true, 10n ** 14n, 0n, 1)).toBe("ok");
    expect(await claim(rq, 0n)).toBe("ok");
    expect(await claim(rq, 0n)).toBe("ok");

    const creator = creators.get(pi.pool)!;
    const payer = await p.funded();
    const [md] = await pdaOf(["virtual_pool_metadata", pi.pool]);
    const make = (who: KeyPairSigner, name: string, poolKey = pi.pool) =>
      p.both(
        `metadata ${name}`,
        payer,
        [
          p.ix("create_virtual_pool_metadata", { metadata: { padding: new Array(96).fill(0), name, website: "https://example.com", logo: "" } }, [
            { address: poolKey },
            { address: md, writable: true },
            { address: who.address, signer: who },
            { address: payer.address, signer: payer, writable: true },
            { address: SYSTEM },
            { address: p.eventAuthority },
            { address: PROGRAM },
          ]),
        ],
        [md, payer.address],
      );
    expect(await make(t.who, "not the creator")).toBe(custom(6053));
    expect(await make(creator, "Pool")).toBe("ok");
    expect(await make(creator, "again")).toBe(custom(0));
  });

  it("a rate limiter (a config made before 0.2.1): fees by size, and one swap per pool and transaction", async () => {
    const params = baseParams();
    // base_fee at config offset 8 + 96: cliff u64, second_factor u64 (duration), third_factor u64 (reference), first_factor u16 (bps), mode u8
    const cfg = await config(params, quoteSpl, (d) => {
      d.writeBigUInt64LE(10_000_000n, 104);
      d.writeBigUInt64LE(10n ** 9n, 112);
      d.writeBigUInt64LE(1_000_000_000n, 120);
      d.writeUInt16LE(10, 128);
      d[130] = 2;
    });
    const pi = await pool(cfg, params, quoteSpl, TOKEN, [], false, true);
    const t = await trader(pi);
    expect(await doSwap("rate limited without the sysvar", pi, t, true, 5_000_000_000n, 0n, 0)).toBe(custom(E.FailToValidateSingleSwapInstruction));
    expect(await doSwap("rate limited, exact in", pi, t, true, 5_000_000_000n, 0n, 0, { rest: [INSTRUCTIONS] })).toBe("ok");
    expect(await doSwap("rate limited, exact out", pi, t, true, 10n ** 12n, 10n ** 13n, 2, { rest: [INSTRUCTIONS] })).toBe("ok");
    expect(await doSwap("rate limited, partial", pi, t, true, 3_000_000_000n, 0n, 1, { rest: [INSTRUCTIONS] })).toBe("ok");
    expect(await doSwap("base in is not limited", pi, t, false, 10n ** 12n, 0n, 0)).toBe("ok");
    const two = [swapIx(pi, t, true, 1_000_000_000n, 0n, 0, { rest: [INSTRUCTIONS] }), swapIx(pi, t, true, 1_000_000_000n, 0n, 2, { rest: [INSTRUCTIONS] })];
    expect(await p.both("two swaps in one transaction", t.who, two, watch(pi, t))).toBe(builtinAt(1));
  });
  it("a rate limiter by CPI: the processed sibling instructions (sol_get_processed_sibling_instruction)", async () => {
    const params = baseParams();
    const cfg = await config(params, quoteSpl, (d) => {
      d.writeBigUInt64LE(10_000_000n, 104);
      d.writeBigUInt64LE(10n ** 9n, 112);
      d.writeBigUInt64LE(1_000_000_000n, 120);
      d.writeUInt16LE(10, 128);
      d[130] = 2;
    });
    const pi = await pool(cfg, params, quoteSpl, TOKEN, [], false, true);
    const other = await pool(cfg, params, quoteSpl, TOKEN, [], false, true);
    const t = await trader(pi);
    const t2 = await trader(other);
    const relay = (await generateKeyPairSigner()).address;
    for (const vm of p.vms()) await deployFile(RELAY, { svm: vm, programId: relay });
    /** The relay calling the DBC `n` times with `ix` (its accounts after the DBC's id, its data after n). */
    const via = (n: number, ix: Instruction): Instruction => ({
      programAddress: relay,
      accounts: [{ address: PROGRAM, role: AccountRole.READONLY }, ...(ix.accounts ?? [])] as Instruction["accounts"],
      data: new Uint8Array([n, ...(ix.data ?? [])]),
    });
    const one = (pool: PoolInfo, tr: Trader, rest = [INSTRUCTIONS]) => swapIx(pool, tr, true, 1_000_000_000n, 0n, 0, { rest });
    expect(await p.both("one swap by CPI", t.who, [via(1, one(pi, t))], watch(pi, t))).toBe("ok");
    expect(await p.both("by CPI without the sysvar", t.who, [via(1, one(pi, t, []))], watch(pi, t))).toBe(custom(E.FailToValidateSingleSwapInstruction));
    expect(await p.both("two swaps by CPI on one pool", t.who, [via(2, one(pi, t))], watch(pi, t))).toBe(custom(E.FailToValidateSingleSwapInstruction));
    // the first call's sibling is on another pool: not this pool's swap
    expect(
      await p.both(
        "a swap on another pool first, by CPI",
        t.who,
        [via(1, one(other, t2)), via(1, one(pi, t))],
        [...watch(pi, t), ...watch(other, t2)],
        [t2.who],
      ),
    ).toBe("ok");
    // a top-level swap on the pool before the CPI one
    expect(await p.both("a top-level swap first", t.who, [one(pi, t), via(1, one(pi, t))], watch(pi, t))).toBe(builtinAt(1));
  });
  const builtinAt = (i: number) =>
    `error: TransactionErrorInstructionError { index: ${i}, error: InstructionErrorCustom { code: ${E.FailToValidateSingleSwapInstruction} } }`;

  it(`fuzz: random swap sequences to the threshold (seed ${SEED}, ${RUNS} pools)`, async () => {
    const rng = new Rng(SEED);
    // A Token-2022 quote mint with a zero transfer fee, so configs accept it; its fee is raised to 1% once the configs
    // exist (written in both, as a fee authority's later change would leave it).
    const quoteT22 = await mint(p, TOKEN_2022, 6, [{ kind: "transferFee", bps: 0, max: 0n, authority: false }]);
    const raiseQuoteFee = () => {
      for (const vm of p.vms()) {
        const a = vm.getAccount(quoteT22);
        if (!a.exists) throw new Error("no mint");
        const data = Buffer.from(a.data);
        let off = 166;
        while (data.readUInt16LE(off) !== 1) off += 4 + data.readUInt16LE(off + 2);
        for (const at of [off + 4 + 72, off + 4 + 90]) {
          data.writeBigUInt64LE(10n ** 12n, at + 8);
          data.writeUInt16LE(100, at + 16);
        }
        vm.setAccount({ ...a, data: new Uint8Array(data) });
      }
    };
    const lowerQuoteFee = () => {
      for (const vm of p.vms()) {
        const a = vm.getAccount(quoteT22);
        if (!a.exists) throw new Error("no mint");
        const data = Buffer.from(a.data);
        let off = 166;
        while (data.readUInt16LE(off) !== 1) off += 4 + data.readUInt16LE(off + 2);
        for (const at of [off + 4 + 72, off + 4 + 90]) {
          data.writeBigUInt64LE(0n, at + 8);
          data.writeUInt16LE(0, at + 16);
        }
        vm.setAccount({ ...a, data: new Uint8Array(data) });
      }
    };
    for (let run = 0; run < RUNS; run++) {
      const params = baseParams();
      params.collect_fee_mode = rng.int(2);
      params.creator_trading_fee_percentage = rng.pick([0, 30, 100]);
      if (rng.chance(40))
        params.pool_fees.base_fee = {
          cliff_fee_numerator: 500_000_000n,
          first_factor: rng.pick([10, 20]),
          second_factor: rng.pick([1n, 30n]),
          third_factor: rng.pick([1000n, 2000n]),
          base_fee_mode: 1,
        };
      if (rng.chance(40))
        params.pool_fees.dynamic_fee = {
          bin_step: 1,
          bin_step_u128: 1844674407370955n,
          filter_period: 10,
          decay_period: 120,
          reduction_factor: 5000,
          max_volatility_accumulator: 14_460_000,
          variable_fee_control: rng.pick([1000, 100_000, 16_777_215]),
        };
      const t22quote = rng.chance(30);
      const t22base = rng.chance(30);
      if (t22base) params.token_type = 1;
      // a Token-2022 base with a transfer fee: create_config2's restrictions (constant supply, compounding migration)
      const baseFee = t22base ? rng.pick([0, 50, 1000]) : 0;
      if (baseFee > 0) Object.assign(params, constantSupply(params));
      const limiter = rng.chance(20);
      const quoteMint = t22quote ? quoteT22 : quoteSpl;
      const quoteProgram = t22quote ? TOKEN_2022 : TOKEN;
      // drawn once: the patch runs once per VM
      const reference = BigInt(rng.pick([100_000_000, 1_000_000_000, 10_000_000_000]));
      const increment = rng.pick([1, 10, 100]);
      lowerQuoteFee();
      const cfg = await config(
        params,
        quoteMint,
        limiter
          ? (d) => {
              d.writeBigUInt64LE(10_000_000n, 104);
              d.writeBigUInt64LE(10n ** 9n, 112);
              d.writeBigUInt64LE(reference, 120);
              d.writeUInt16LE(increment, 128);
              d[130] = 2;
            }
          : undefined,
        baseFee > 0 ? { fee: transferFee(baseFee) } : {},
      );
      const pi = await pool(
        cfg,
        params,
        quoteMint,
        quoteProgram,
        // written only under a rate limiter: the base mint's fee as the config gives it
        baseFee > 0 ? [{ kind: "transferFee", bps: baseFee, max: 18446744073709551615n, authority: false }] : [],
        false,
        limiter,
      );
      if (t22quote) raiseQuoteFee();
      const t = await trader(pi, 10n ** 15n, 0n);
      const referral = await account((await generateKeyPairSigner()).address, pi.quoteMint, quoteProgram, 0n);
      const referralBase = await account((await generateKeyPairSigner()).address, pi.baseMint, pi.baseProgram, 0n);
      let done = false;
      for (let step = 0; step < 60 && !done; step++) {
        const [dt, ds] = [BigInt(rng.int(40)), BigInt(rng.int(100))];
        for (const vm of p.vms()) {
          const c = vm.getClock();
          c.unixTimestamp += dt;
          c.slot += ds;
          vm.setClock(c);
        }
        const quoteToBase = rng.chance(70);
        const mode = rng.pick([0, 1, 2, 2, "legacy"] as const);
        const big = rng.chance(10);
        const a0 = quoteToBase
          ? mode === 2
            ? BigInt(1 + rng.int(big ? 4_000_000_000_000 : 400_000_000_000))
            : BigInt(1 + rng.int(big ? 80_000_000_000 : 8_000_000_000))
          : mode === 2
            ? BigInt(1 + rng.int(2_000_000_000))
            : BigInt(1 + rng.int(500_000_000_000));
        const a1 = mode === 2 ? (rng.chance(80) ? 10n ** 15n : BigInt(rng.int(1000))) : rng.chance(80) ? 0n : BigInt(rng.int(1_000_000_000));
        const opts: Parameters<typeof swapIx>[6] = {};
        if (rng.chance(20)) opts.referral = params.collect_fee_mode === 1 && quoteToBase ? referralBase : referral;
        if (limiter || rng.chance(30)) opts.rest = [INSTRUCTIONS];
        const o = await doSwap(
          `run ${run} step ${step} (seed ${SEED}): ${quoteToBase ? "quote in" : "base in"} mode ${mode} ${a0}/${a1}`,
          pi,
          t,
          quoteToBase,
          a0,
          a1,
          mode,
          opts,
        );
        if (o === custom(E.PoolIsCompleted)) done = true;
      }
    }
    console.log(`meteora-dbc swaps (seed ${SEED}): ${p.stats.compared} transactions, outcomes ${JSON.stringify(p.stats.byOutcome)}`);
    expect(p.stats.byOutcome.ok ?? 0).toBeGreaterThan(0);
  }, 3_600_000);
});
