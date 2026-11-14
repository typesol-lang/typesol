// initialize_virtual_pool_with_token2022 and initialize_virtual_pool_with_token2022_transfer_hook of
// showcase/mainnet/meteora-dbc (a port subject to Meteora's Non-commercial Licence, see that directory's LICENSE.md)
// against Meteora's Dynamic Bonding Curve 0.2.2 on mainnet, side by side (showcase/test/meteora-dbc-helpers.ts). Pools
// with a Token-2022 base mint carrying its metadata in itself, the config's transfer fee, and for a transfer hook config
// the hook program (the fixture hook, showcase/test/fixtures/meteora-dbc/hook.ts, loaded in both); each token
// authority option, a creation fee, slot activation, accounts funded before creation, and the refusals.
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, generateKeyPairSigner, lamports } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, pda } from "../../test/harness.js";
import { present } from "../../test/binaries.js";
import {
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
  key,
  loadHook,
  mint,
  pair,
  transferFee,
} from "./meteora-dbc-helpers.js";

const POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM" as Address;
const E = { InvalidQuoteMint: 6008, InvalidTokenType: 6017, InvalidTokenAuthorityOption: 6037, DeprecatedBaseFeeMode: 6078 } as const;

describe.skipIf(!present(ORIGINAL))("showcase/mainnet/meteora-dbc Token-2022 pool creation against Meteora DBC 0.2.2 on mainnet", () => {
  let p: Pair;
  let quote: Address;
  let hook: Address;
  beforeAll(async () => {
    p = await pair();
    hook = await loadHook(p);
    quote = await mint(p, TOKEN, 9);
  }, 300_000);

  type ConfigIx = "create_config" | "create_config2" | "create_config_with_transfer_hook";
  async function config(ixName: ConfigIx, params: Params, opts: { quoteMint?: Address; fee?: unknown; hookProgram?: Address } = {}) {
    const payer = await p.funded();
    const cfg = await generateKeyPairSigner();
    const args: Record<string, unknown> = { config_parameters: coded(params) };
    if (ixName === "create_config2") args.transfer_fee_parameters = opts.fee ?? null;
    const ix = p.ix(ixName, args, [
      { address: cfg.address, signer: cfg, writable: true },
      { address: payer.address },
      { address: payer.address },
      { address: opts.quoteMint ?? quote },
      ...(ixName === "create_config_with_transfer_hook" ? [{ address: opts.hookProgram ?? hook }] : []),
      { address: payer.address, signer: payer, writable: true },
      { address: SYSTEM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
    expect(await p.both(`create the config (${ixName})`, payer, [ix], [cfg.address])).toBe("ok");
    return { cfg: cfg.address, partner: payer };
  }
  /** Rewrite a config's bytes in both VMs. */
  function patch(cfg: Address, f: (d: Buffer) => void) {
    for (const vm of p.vms()) {
      const a = vm.getAccount(cfg);
      if (!a.exists) throw new Error("no config");
      const d = Buffer.from(a.data);
      f(d);
      vm.setAccount({ ...a, data: new Uint8Array(d) });
    }
  }

  interface Made {
    pool: Address;
    baseMint: KeyPairSigner;
    baseVault: Address;
    quoteVault: Address;
    ix: Instruction;
  }
  async function initIx(
    kind: "token2022" | "hook",
    cfg: Address,
    creator: KeyPairSigner,
    payer: KeyPairSigner,
    opts: { quoteMint?: Address; quoteProgram?: Address; baseVault?: Address; hookProgram?: Address; tokenProgram?: Address; baseMint?: KeyPairSigner } = {},
  ): Promise<Made> {
    const baseMint = opts.baseMint ?? (await generateKeyPairSigner());
    const q = opts.quoteMint ?? quote;
    const [hi, lo] = Buffer.compare(key(baseMint.address), key(q)) > 0 ? [baseMint.address, q] : [q, baseMint.address];
    const [poolKey] = await pda(PROGRAM, ["pool", cfg, hi, lo]);
    const [baseVault] = await pda(PROGRAM, ["token_vault", baseMint.address, poolKey]);
    const [quoteVault] = await pda(PROGRAM, ["token_vault", q, poolKey]);
    const accounts: Meta[] = [
      { address: cfg },
      { address: POOL_AUTHORITY },
      { address: creator.address, signer: creator },
      { address: baseMint.address, signer: baseMint, writable: true },
      { address: q },
      { address: poolKey, writable: true },
      { address: opts.baseVault ?? baseVault, writable: true },
      { address: quoteVault, writable: true },
      ...(kind === "hook" ? [{ address: opts.hookProgram ?? hook }] : []),
      { address: payer.address, signer: payer, writable: true },
      { address: opts.quoteProgram ?? TOKEN },
      { address: opts.tokenProgram ?? TOKEN_2022 },
      { address: SYSTEM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ];
    const name = kind === "hook" ? "initialize_virtual_pool_with_token2022_transfer_hook" : "initialize_virtual_pool_with_token2022";
    const ix = p.ix(name, { params: { name: "Token", symbol: "TKN", uri: "https://example.com/t.json" } }, accounts);
    return { pool: poolKey, baseMint, baseVault, quoteVault, ix };
  }
  const watchOf = (m: Made, ...more: Address[]) => [m.pool, m.baseMint.address, m.baseVault, m.quoteVault, ...more];
  const create = async (label: string, kind: "token2022" | "hook", cfg: Address, opts: Parameters<typeof initIx>[4] = {}, payer?: KeyPairSigner) => {
    const creator = await p.funded();
    const m = await initIx(kind, cfg, creator, payer ?? creator, opts);
    return { m, creator, out: await p.both(label, payer ?? creator, [m.ix], watchOf(m, creator.address, (payer ?? creator).address)) };
  };

  /** A trader's associated accounts for both mints, the quote one funded by writing its balance. */
  async function trader(baseMint: Address, quoteMint = quote, quoteProgram: Address = TOKEN) {
    const who = await p.funded();
    const at = async (m: Address, program: Address, amount: bigint) => {
      const [a] = await t22.findAssociatedTokenPda({ owner: who.address, mint: m, tokenProgram: program });
      await p.setup(who, [
        t22.getCreateAssociatedTokenIdempotentInstruction({ payer: who, ata: a, owner: who.address, mint: m, tokenProgram: program }) as Instruction,
      ]);
      for (const vm of p.vms()) {
        const x = vm.getAccount(a);
        if (!x.exists) throw new Error("no account");
        const data = Buffer.from(x.data);
        data.writeBigUInt64LE(amount, 64);
        vm.setAccount({ ...x, data: new Uint8Array(data) });
      }
      return a;
    };
    return { who, quote: await at(quoteMint, quoteProgram, 10n ** 15n), base: await at(baseMint, TOKEN_2022, 0n) };
  }
  function swapIx(
    cfg: Address,
    m: Made,
    t: { who: KeyPairSigner; quote: Address; base: Address },
    quoteToBase: boolean,
    amount: bigint,
    quoteMint = quote,
    quoteProgram: Address = TOKEN,
  ) {
    return p.ix("swap2", { params: { amount_0: new BN(amount.toString()), amount_1: new BN(0), swap_mode: 0 } }, [
      { address: POOL_AUTHORITY },
      { address: cfg },
      { address: m.pool, writable: true },
      { address: quoteToBase ? t.quote : t.base, writable: true },
      { address: quoteToBase ? t.base : t.quote, writable: true },
      { address: m.baseVault, writable: true },
      { address: m.quoteVault, writable: true },
      { address: m.baseMint.address },
      { address: quoteMint },
      { address: t.who.address, signer: t.who },
      { address: TOKEN_2022 },
      { address: quoteProgram },
      { address: PROGRAM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
  }

  it("initialize_virtual_pool_with_token2022: every token authority, transfer fees, a creation fee; swaps on the pools", async () => {
    const t22params = { ...baseParams(), token_type: 1 };
    const cases: [string, ConfigIx, Params, unknown][] = [
      ["creator update authority", "create_config", t22params, null],
      ["immutable metadata", "create_config", { ...t22params, token_update_authority: 1 }, null],
      ["partner update authority", "create_config", { ...t22params, token_update_authority: 2 }, null],
      ["creation fee, slot activation", "create_config", { ...t22params, pool_creation_fee: 50_000_000n, activation_type: 0 }, null],
      ["create_config2 without a transfer fee", "create_config2", t22params, null],
      ["transfer fee 1%, partner withheld, revoke to zero", "create_config2", constantSupply(baseParams()), transferFee(100)],
      ["transfer fee 10%, creator withheld, creator authority", "create_config2", constantSupply(baseParams()), transferFee(1000, 1, 2)],
      ["zero fee, partner authority", "create_config2", constantSupply(baseParams()), transferFee(0, 1, 3)],
      ["transfer fee 0.5%, immutable", "create_config2", constantSupply(baseParams()), transferFee(50, 0, 0)],
    ];
    for (const [label, ixName, params, fee] of cases) {
      const { cfg } = await config(ixName, params, { fee });
      const { m, out } = await create(label, "token2022", cfg);
      expect(out, label).toBe("ok");
      const t = await trader(m.baseMint.address);
      const watch = [m.pool, m.baseVault, m.quoteVault, t.quote, t.base];
      expect(await p.both(`${label}: quote in`, t.who, [swapIx(cfg, m, t, true, 5_000_000_000n)], watch), label).toBe("ok");
      expect(await p.both(`${label}: base in`, t.who, [swapIx(cfg, m, t, false, 1_000_000_000n)], watch), label).toBe("ok");
    }
  });

  it("a Token-2022 quote mint, a payer other than the creator, accounts funded before creation", async () => {
    const quoteT22 = await mint(p, TOKEN_2022, 6, [{ kind: "transferFee", bps: 0, max: 0n, authority: false }]);
    const { cfg } = await config("create_config", { ...baseParams(), token_type: 1 }, { quoteMint: quoteT22 });
    const { m, out } = await create("a Token-2022 quote", "token2022", cfg, { quoteMint: quoteT22, quoteProgram: TOKEN_2022 });
    expect(out).toBe("ok");
    const t = await trader(m.baseMint.address, quoteT22, TOKEN_2022);
    expect(
      await p.both("swap", t.who, [swapIx(cfg, m, t, true, 5_000_000_000n, quoteT22, TOKEN_2022)], [m.pool, m.baseVault, m.quoteVault, t.quote, t.base]),
    ).toBe("ok");

    const { cfg: plain } = await config("create_config", { ...baseParams(), token_type: 1 });
    const payer = await p.funded();
    expect((await create("another payer", "token2022", plain, {}, payer)).out).toBe("ok");
    // the base mint and the base vault funded first (a top-up, then Allocate and Assign), less and more than their rent
    for (const funding of [1n, 10_000_000n]) {
      const baseMint = await generateKeyPairSigner();
      const creator = await p.funded();
      const m2 = await initIx("token2022", plain, creator, creator, { baseMint });
      for (const vm of p.vms())
        for (const a of [baseMint.address, m2.baseVault])
          vm.setAccount({ address: a, data: new Uint8Array(), executable: false, lamports: lamports(funding), programAddress: SYSTEM, space: 0n });
      expect(await p.both(`funded with ${funding}`, creator, [m2.ix], watchOf(m2, creator.address))).toBe("ok");
    }
  });

  it("initialize_virtual_pool_with_token2022_transfer_hook: every token authority (mint authorities kept), a creation fee", async () => {
    const params = { ...baseParams(), token_type: 1 };
    for (const [label, over] of [
      ["creator update authority", {}],
      ["immutable", { token_update_authority: 1 }],
      ["partner update authority", { token_update_authority: 2 }],
      ["creator update and mint authority", { token_update_authority: 3 }],
      ["partner update and mint authority", { token_update_authority: 4 }],
      ["creation fee", { pool_creation_fee: 1_000_000_000n }],
    ] as [string, Partial<Params>][]) {
      const { cfg } = await config("create_config_with_transfer_hook", { ...params, ...over });
      expect((await create(label, "hook", cfg)).out, label).toBe("ok");
    }
  });

  it("refusals", async () => {
    const t22params = { ...baseParams(), token_type: 1 };
    const { cfg } = await config("create_config", t22params);
    const { cfg: spl } = await config("create_config", baseParams());
    const { cfg: hooked } = await config("create_config_with_transfer_hook", t22params);
    const other = await mint(p, TOKEN, 6);
    const stranger = (await generateKeyPairSigner()).address;
    const cases: [string, "token2022" | "hook", Address, Parameters<typeof initIx>[4], string][] = [
      ["an SPL config", "token2022", spl, {}, custom(E.InvalidTokenType)],
      ["a transfer hook config", "token2022", hooked, {}, custom(3002)],
      ["a plain config for the hook instruction", "hook", cfg, {}, custom(3002)],
      ["another quote mint", "token2022", cfg, { quoteMint: other }, custom(2001)],
      ["another base vault", "token2022", cfg, { baseVault: stranger }, custom(2006)],
      ["SPL Token as the token program", "token2022", cfg, { tokenProgram: TOKEN }, custom(3008)],
      ["another hook program", "hook", hooked, { hookProgram: TOKEN }, custom(2012)],
      ["a hook program that is not executable", "hook", hooked, { hookProgram: stranger }, custom(2007)],
    ];
    for (const [label, kind, c, opts, want] of cases) expect((await create(label, kind, c, opts)).out, label).toBe(want);

    // the payer as the base mint: funded, so `init`'s path for funded accounts refuses it (4101)
    const payer = await p.funded();
    const m = await initIx("token2022", cfg, payer, payer, { baseMint: payer });
    expect(await p.both("the payer as the base mint", payer, [m.ix], watchOf(m, payer.address))).toBe(custom(4101));

    // configs rewritten in both: a mint authority on a plain config, a rate limiter (pre-0.2.1)
    const { cfg: minting } = await config("create_config", t22params);
    // token_update_authority at 8 + 238: CreatorUpdateAndMintAuthority, which create_config refuses without a hook
    patch(minting, (d) => (d[8 + 238] = 3));
    expect((await create("a mint authority on a plain config", "token2022", minting)).out).toBe(custom(E.InvalidTokenAuthorityOption));
    const { cfg: limited } = await config("create_config", t22params);
    patch(limited, (d) => {
      d.writeBigUInt64LE(10_000_000n, 104);
      d.writeBigUInt64LE(10n ** 9n, 112);
      d.writeBigUInt64LE(1_000_000_000n, 120);
      d.writeUInt16LE(10, 128);
      d[130] = 2;
    });
    expect((await create("a rate limiter", "token2022", limited)).out).toBe(custom(E.DeprecatedBaseFeeMode));
    const once = await create("once", "token2022", cfg);
    expect(once.out).toBe("ok");
    const again = await initIx("token2022", cfg, once.creator, once.creator, { baseMint: once.m.baseMint });
    expect(await p.both("twice", once.creator, [again.ix], watchOf(again))).toBe(custom(0));
  });
});
