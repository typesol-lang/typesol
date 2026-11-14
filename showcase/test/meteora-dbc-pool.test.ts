// initialize_virtual_pool_with_spl_token of showcase/mainnet/meteora-dbc (a port subject to Meteora's Non-commercial
// Licence, see that directory's LICENSE.md) against Meteora's Dynamic Bonding Curve 0.2.2 on mainnet, side by side
// (showcase/test/meteora-dbc-helpers.ts), with Metaplex Token Metadata as deployed on mainnet in both
// (test/programs/mpl_token_metadata.so, fetched by scripts/fetch-programs.sh). Pools made by the instruction, then
// swaps on them, among them the first swap at the minimum fee, in the same transaction as the pool's creation.
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN } from "../../test/harness.js";
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
  custom,
  mint,
  pair,
} from "./meteora-dbc-helpers.js";

const MPL = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const MPL_SO = fileURLToPath(new URL("../../test/programs/mpl_token_metadata.so", import.meta.url));
const POOL_AUTHORITY = address("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
const INSTRUCTIONS = address("Sysvar1nstructions1111111111111111111111111");
const enc = getAddressEncoder();
const cmp = (a: Address, b: Address) => Buffer.compare(Buffer.from(enc.encode(a)), Buffer.from(enc.encode(b)));

describe.skipIf(!present(ORIGINAL, MPL_SO))("showcase/mainnet/meteora-dbc pool creation against Meteora DBC 0.2.2 on mainnet", () => {
  let p: Pair;
  let quote: Address;
  beforeAll(async () => {
    p = await pair();
    const so = new Uint8Array(readFileSync(MPL_SO));
    for (const vm of p.vms()) vm.addProgram(MPL, so);
    quote = await mint(p, TOKEN, 9);
  }, 300_000);

  async function config(params: Params) {
    const payer = await p.funded();
    const cfg = await generateKeyPairSigner();
    const ix = p.ix("create_config", { config_parameters: coded(params) }, [
      { address: cfg.address, signer: cfg, writable: true },
      { address: payer.address },
      { address: payer.address },
      { address: quote },
      { address: payer.address, signer: payer, writable: true },
      { address: SYSTEM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
    expect(await p.both("create the config", payer, [ix], [cfg.address])).toBe("ok");
    return cfg.address;
  }

  interface Made {
    pool: Address;
    baseMint: KeyPairSigner;
    baseVault: Address;
    quoteVault: Address;
    metadata: Address;
    ix: Instruction;
  }
  async function initIx(
    cfg: Address,
    creator: KeyPairSigner,
    payer: KeyPairSigner,
    opts: { quoteMint?: Address; name?: string; metadataProgram?: Address } = {},
  ): Promise<Made> {
    const baseMint = await generateKeyPairSigner();
    const q = opts.quoteMint ?? quote;
    const [hi, lo] = cmp(baseMint.address, q) > 0 ? [baseMint.address, q] : [q, baseMint.address];
    const [pool] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["pool", enc.encode(cfg), enc.encode(hi), enc.encode(lo)] });
    const [baseVault] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["token_vault", enc.encode(baseMint.address), enc.encode(pool)] });
    const [quoteVault] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: ["token_vault", enc.encode(q), enc.encode(pool)] });
    const [metadata] = await getProgramDerivedAddress({ programAddress: MPL, seeds: ["metadata", enc.encode(MPL), enc.encode(baseMint.address)] });
    const accounts: Meta[] = [
      { address: cfg },
      { address: POOL_AUTHORITY },
      { address: creator.address, signer: creator },
      { address: baseMint.address, signer: baseMint, writable: true },
      { address: q },
      { address: pool, writable: true },
      { address: baseVault, writable: true },
      { address: quoteVault, writable: true },
      { address: metadata, writable: true },
      { address: opts.metadataProgram ?? MPL },
      { address: payer.address, signer: payer, writable: true },
      { address: TOKEN },
      { address: TOKEN },
      { address: SYSTEM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ];
    const ix = p.ix(
      "initialize_virtual_pool_with_spl_token",
      { params: { name: opts.name ?? "Token", symbol: "TKN", uri: "https://example.com/t.json" } },
      accounts,
    );
    return { pool, baseMint, baseVault, quoteVault, metadata, ix };
  }
  const watchOf = (m: Made, payer: Address) => [m.pool, m.baseMint.address, m.baseVault, m.quoteVault, m.metadata, payer];

  /** A trader's associated accounts for both mints, made in both (the quote one funded by writing its balance). */
  async function trader(baseMint: Address) {
    const who = await p.funded();
    const at = async (m: Address, amount: bigint) => {
      const [a] = await t22.findAssociatedTokenPda({ owner: who.address, mint: m, tokenProgram: TOKEN });
      await p.setup(who, [
        t22.getCreateAssociatedTokenIdempotentInstruction({ payer: who, ata: a, owner: who.address, mint: m, tokenProgram: TOKEN }) as Instruction,
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
    return { who, quote: await at(quote, 10n ** 15n), base: await at(baseMint, 0n) };
  }
  function swapIx(cfg: Address, m: Made, t: { who: KeyPairSigner; quote: Address; base: Address }, amount: bigint, rest: Address[] = []) {
    return p.ix("swap2", { params: { amount_0: new BN(amount.toString()), amount_1: new BN(0), swap_mode: 0 } }, [
      { address: POOL_AUTHORITY },
      { address: cfg },
      { address: m.pool, writable: true },
      { address: t.quote, writable: true },
      { address: t.base, writable: true },
      { address: m.baseVault, writable: true },
      { address: m.quoteVault, writable: true },
      { address: m.baseMint.address },
      { address: quote },
      { address: t.who.address, signer: t.who },
      { address: TOKEN },
      { address: TOKEN },
      { address: PROGRAM },
      { address: p.eventAuthority },
      { address: PROGRAM },
      ...rest.map((a) => ({ address: a })),
    ]);
  }

  it("creates pools with every token authority option, a creation fee and fixed supply; swaps on them", async () => {
    for (const [label, params] of [
      ["creator update authority", baseParams()],
      ["immutable metadata", { ...baseParams(), token_update_authority: 1 }],
      ["partner update authority", { ...baseParams(), token_update_authority: 2 }],
      ["creation fee", { ...baseParams(), pool_creation_fee: 50_000_000n }],
      ["fixed supply", { ...baseParams(), token_supply: { pre_migration_token_supply: 10n ** 17n, post_migration_token_supply: 10n ** 17n } }],
      ["slot activation", { ...baseParams(), activation_type: 0 }],
    ] as [string, Params][]) {
      const cfg = await config(params);
      const creator = await p.funded();
      const m = await initIx(cfg, creator, creator, { name: label });
      expect(await p.both(label, creator, [m.ix], watchOf(m, creator.address)), label).toBe("ok");
      const t = await trader(m.baseMint.address);
      expect(await p.both(`${label}: a swap`, t.who, [swapIx(cfg, m, t, 5_000_000_000n)], [m.pool, m.baseVault, m.quoteVault, t.quote, t.base]), label).toBe(
        "ok",
      );
    }
  });

  it("the first swap at the minimum fee, in the pool's creation transaction", async () => {
    const params = {
      ...baseParams(),
      enable_first_swap_with_min_fee: true,
      pool_fees: {
        ...baseParams().pool_fees,
        base_fee: { cliff_fee_numerator: 500_000_000n, first_factor: 10, second_factor: 60n, third_factor: 10_000_000n, base_fee_mode: 0 },
      },
    };
    const cfg = await config(params);
    const creator = await p.funded();
    const m = await initIx(cfg, creator, creator);
    // the creator's accounts for the new mint must exist before the swap: an idempotent ATA creation between them
    const [base] = await t22.findAssociatedTokenPda({ owner: creator.address, mint: m.baseMint.address, tokenProgram: TOKEN });
    const [q] = await t22.findAssociatedTokenPda({ owner: creator.address, mint: quote, tokenProgram: TOKEN });
    await p.setup(creator, [
      t22.getCreateAssociatedTokenIdempotentInstruction({ payer: creator, ata: q, owner: creator.address, mint: quote, tokenProgram: TOKEN }) as Instruction,
    ]);
    for (const vm of p.vms()) {
      const x = vm.getAccount(q);
      if (!x.exists) throw new Error("no account");
      const data = Buffer.from(x.data);
      data.writeBigUInt64LE(10n ** 15n, 64);
      vm.setAccount({ ...x, data: new Uint8Array(data) });
    }
    const ata = t22.getCreateAssociatedTokenIdempotentInstruction({
      payer: creator,
      ata: base,
      owner: creator.address,
      mint: m.baseMint.address,
      tokenProgram: TOKEN,
    }) as Instruction;
    const t = { who: creator, quote: q, base };
    const out = await p.both(
      "create and swap at the minimum fee",
      creator,
      [m.ix, ata, swapIx(cfg, m, t, 5_000_000_000n, [INSTRUCTIONS])],
      [...watchOf(m, creator.address), base, q],
    );
    expect(out).toBe("ok");
    // without the sysvar the same first swap pays the scheduled fee
    const m2 = await initIx(cfg, creator, creator);
    const [base2] = await t22.findAssociatedTokenPda({ owner: creator.address, mint: m2.baseMint.address, tokenProgram: TOKEN });
    const ata2 = t22.getCreateAssociatedTokenIdempotentInstruction({
      payer: creator,
      ata: base2,
      owner: creator.address,
      mint: m2.baseMint.address,
      tokenProgram: TOKEN,
    }) as Instruction;
    expect(
      await p.both(
        "create and swap, no sysvar",
        creator,
        [m2.ix, ata2, swapIx(cfg, m2, { who: creator, quote: q, base: base2 }, 5_000_000_000n)],
        [m2.pool, base2, q],
      ),
    ).toBe("ok");
    // the protocol's quote fee (pool offset 8 + 248): 40% of the scheduled minimum's share against 50% at period 0
    const fee = (pool: Address) => {
      const a = p.original.getAccount(pool);
      if (!a.exists) throw new Error("no pool");
      return Buffer.from(a.data).readBigUInt64LE(8 + 248);
    };
    expect(fee(m.pool) * 5n).toBe(fee(m2.pool) * 4n);
  });

  it("refusals", async () => {
    const creator = await p.funded();
    const cfg = await config(baseParams());
    const t22cfg = await config({ ...baseParams(), token_type: 1 });
    const other = await mint(p, TOKEN, 6);
    const cases: [string, Address, Parameters<typeof initIx>[3], string][] = [
      ["a Token-2022 config", t22cfg, {}, custom(6017)],
      ["another quote mint", cfg, { quoteMint: other }, custom(2001)],
      ["another metadata program", cfg, { metadataProgram: TOKEN }, custom(2012)],
    ];
    for (const [label, c, opts, want] of cases) {
      const m = await initIx(c, creator, creator, opts);
      expect(await p.both(label, creator, [m.ix], watchOf(m, creator.address)), label).toBe(want);
    }
    const m = await initIx(cfg, creator, creator);
    expect(await p.both("once", creator, [m.ix], watchOf(m, creator.address))).toBe("ok");
    void TOKEN_2022;
  });
});
