// swap2_with_transfer_hook, claim_trading_fee2 and claim_creator_trading_fee2 of showcase/mainnet/meteora-dbc (a port
// subject to Meteora's Non-commercial Licence, see that directory's LICENSE.md) against Meteora's Dynamic Bonding Curve
// 0.2.2 on mainnet, side by side (showcase/test/meteora-dbc-helpers.ts), on TransferHookPools made by
// initialize_virtual_pool_with_token2022_transfer_hook in both, with the fixture hook
// (showcase/test/fixtures/meteora-dbc/hook.ts) loaded in both. The hook's validation account is written in both, so
// each kind of extra account meta (a fixed address, PDAs from literal, instruction-data, account-key and account-data
// seeds, a PDA of another program, a key read from account data) and each refusal of the resolver
// (spl-transfer-hook-interface's add_extra_accounts_for_execute_cpi, spl-tlv-account-resolution) can be tried: every
// transaction must give the same outcome, account bytes, inner instructions (the transfer's account list included) and
// events.
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, pda } from "../../test/harness.js";
import { present } from "../../test/binaries.js";
import {
  type HookMeta,
  type Meta,
  type Pair,
  type Params,
  EXECUTE_DISC,
  ORIGINAL,
  PROGRAM,
  SYSTEM,
  TOKEN,
  TOKEN_2022,
  baseParams,
  builtin,
  coded,
  custom,
  extraMetasAddress,
  extraMetasData,
  key,
  loadHook,
  mint,
  pair,
  writeExtraMetas,
} from "./meteora-dbc-helpers.js";

const POOL_AUTHORITY = "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM" as Address;
const INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111" as Address;
const E = {
  MathOverflow: 6000,
  InvalidRemainingAccountsLength: 6070,
  InvalidInstructionsSysvar: 6069,
  MissingRemainingAccountForTransferHook: 6071,
  NoTransferHookProgram: 6072,
  DuplicatedRemainingAccountTypes: 6073,
  PoolTypeMismatch: 6076,
  InvalidRemainingAccountSliceType: 6077,
  PoolIsCompleted: 6013,
  Unauthorized: 6053,
} as const;
/** spl-transfer-hook-interface's TransferHookError::IncorrectAccount, spl-tlv-account-resolution's AccountResolutionError. */
const HOOK_INCORRECT_ACCOUNT = 2_110_272_652;
const RES = (n: number) => 2_724_315_840 + n;
const RES_INCORRECT_ACCOUNT = RES(0);
const RES_INVALID_BYTES_FOR_SEED = RES(9);
const RES_INSTRUCTION_DATA_TOO_SMALL = RES(11);
const RES_ACCOUNT_NOT_FOUND = RES(12);
const RES_ACCOUNT_DATA_TOO_SMALL = RES(15);
const TLV_TYPE_NOT_FOUND = 1_202_666_432;

type Slice = [type: "base" | "referral", length: number];
const slicesArg = (slices: Slice[]) => ({
  slices: slices.map(([t, length]) => ({ accounts_type: t === "base" ? { TransferHookBase: {} } : { TransferHookBaseReferral: {} }, length })),
});
const big = (n: bigint) => new BN(n.toString());

describe.skipIf(!present(ORIGINAL))("showcase/mainnet/meteora-dbc transfer-hook instructions against Meteora DBC 0.2.2 on mainnet", () => {
  let p: Pair;
  let hook: Address;
  let quote: Address;
  beforeAll(async () => {
    p = await pair();
    hook = await loadHook(p);
    quote = await mint(p, TOKEN, 9);
  }, 300_000);

  const claimers = new Map<Address, KeyPairSigner>();
  async function config(params: Params, hookProgram: Address | null) {
    const payer = await p.funded();
    const cfg = await generateKeyPairSigner();
    const ix = p.ix(hookProgram ? "create_config_with_transfer_hook" : "create_config", { config_parameters: coded(params) }, [
      { address: cfg.address, signer: cfg, writable: true },
      { address: payer.address },
      { address: payer.address },
      { address: quote },
      ...(hookProgram ? [{ address: hookProgram }] : []),
      { address: payer.address, signer: payer, writable: true },
      { address: SYSTEM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
    expect(await p.both("create the config", payer, [ix], [cfg.address])).toBe("ok");
    claimers.set(cfg.address, payer);
    return cfg.address;
  }

  interface PoolInfo {
    pool: Address;
    config: Address;
    baseMint: Address;
    baseVault: Address;
    quoteVault: Address;
    creator: KeyPairSigner;
    validation: Address;
  }
  /** A TransferHookPool (or with `plain`, a Token-2022 VirtualPool) made in both. */
  async function makePool(params: Params, plain = false): Promise<PoolInfo> {
    const cfg = await config(params, plain ? null : hook);
    const creator = await p.funded();
    const baseMint = await generateKeyPairSigner();
    const [hi, lo] = Buffer.compare(key(baseMint.address), key(quote)) > 0 ? [baseMint.address, quote] : [quote, baseMint.address];
    const [poolKey] = await pda(PROGRAM, ["pool", cfg, hi, lo]);
    const [baseVault] = await pda(PROGRAM, ["token_vault", baseMint.address, poolKey]);
    const [quoteVault] = await pda(PROGRAM, ["token_vault", quote, poolKey]);
    const name = plain ? "initialize_virtual_pool_with_token2022" : "initialize_virtual_pool_with_token2022_transfer_hook";
    const ix = p.ix(name, { params: { name: "Hooked", symbol: "HK", uri: "" } }, [
      { address: cfg },
      { address: POOL_AUTHORITY },
      { address: creator.address, signer: creator },
      { address: baseMint.address, signer: baseMint, writable: true },
      { address: quote },
      { address: poolKey, writable: true },
      { address: baseVault, writable: true },
      { address: quoteVault, writable: true },
      ...(plain ? [] : [{ address: hook }]),
      { address: creator.address, signer: creator, writable: true },
      { address: TOKEN },
      { address: TOKEN_2022 },
      { address: SYSTEM },
      { address: p.eventAuthority },
      { address: PROGRAM },
    ]);
    expect(await p.both("create the pool", creator, [ix], [poolKey, baseMint.address, baseVault, quoteVault])).toBe("ok");
    return {
      pool: poolKey,
      config: cfg,
      baseMint: baseMint.address,
      baseVault,
      quoteVault,
      creator,
      validation: await extraMetasAddress(hook, baseMint.address),
    };
  }

  const ata = async (owner: Address, m: Address, program: Address) => (await t22.findAssociatedTokenPda({ owner, mint: m, tokenProgram: program }))[0];
  async function account(owner: Address, m: Address, program: Address, amount: bigint) {
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
  interface Trader {
    who: KeyPairSigner;
    base: Address;
    quote: Address;
  }
  async function trader(pi: PoolInfo): Promise<Trader> {
    const who = await p.funded();
    return { who, base: await account(who.address, pi.baseMint, TOKEN_2022, 0n), quote: await account(who.address, quote, TOKEN, 10n ** 15n) };
  }

  /** swap2_with_transfer_hook (or `name`), the remaining accounts `rest` (role from each Meta), `slices` as given. */
  function swapIx(
    pi: PoolInfo,
    t: Trader,
    quoteToBase: boolean,
    amount0: bigint,
    opts: { amount1?: bigint; mode?: number; referral?: Address; rest?: Meta[]; slices?: Slice[]; name?: string; over?: Partial<Record<string, Address>> } = {},
  ) {
    const metas: Meta[] = [
      { address: POOL_AUTHORITY },
      { address: pi.config },
      { address: opts.over?.pool ?? pi.pool, writable: true },
      { address: quoteToBase ? t.quote : t.base, writable: true },
      { address: quoteToBase ? t.base : t.quote, writable: true },
      { address: opts.over?.baseVault ?? pi.baseVault, writable: true },
      { address: opts.over?.quoteVault ?? pi.quoteVault, writable: true },
      { address: opts.over?.baseMint ?? pi.baseMint, writable: true },
      { address: quote },
      { address: t.who.address, signer: t.who },
      { address: TOKEN_2022 },
      { address: TOKEN },
      opts.referral ? { address: opts.referral, writable: true } : { address: PROGRAM },
      { address: p.eventAuthority },
      { address: PROGRAM },
      ...(opts.rest ?? []),
    ];
    const params = { amount_0: big(amount0), amount_1: big(opts.amount1 ?? 0n), swap_mode: opts.mode ?? 0 };
    if (opts.name === "swap2") return p.ix("swap2", { params }, metas);
    return p.ix("swap2_with_transfer_hook", { params, transfer_hook_accounts_info: slicesArg(opts.slices ?? []) }, metas);
  }
  const watch = (pi: PoolInfo, t: Trader, extra: Address[] = []) => [pi.pool, pi.baseVault, pi.quoteVault, pi.baseMint, t.base, t.quote, ...extra];
  const swap = (label: string, pi: PoolInfo, t: Trader, quoteToBase: boolean, amount0: bigint, opts: Parameters<typeof swapIx>[4] = {}) =>
    p.both(label, t.who, [swapIx(pi, t, quoteToBase, amount0, opts)], watch(pi, t, opts.referral ? [opts.referral] : []));
  /** The hook's accounts as a slice: the given extras, then the hook program and the validation account. */
  const hookRest = (pi: PoolInfo, extras: Meta[] = []): Meta[] => [...extras, { address: hook }, { address: pi.validation }];

  const params = (): Params => ({ ...baseParams(), token_type: 1, collect_fee_mode: 1, creator_trading_fee_percentage: 50 });

  it("swaps, referrals and fee claims with each kind of extra account; the completing swap revokes the hook", async () => {
    const pi = await makePool(params());
    const t = await trader(pi);
    const fixed = (await generateKeyPairSigner()).address;
    const fixedProgram = (await generateKeyPairSigner()).address;
    // base out (the pool authority's transfer from the base vault): a fixed address and a literal PDA
    await writeExtraMetas(p, hook, pi.baseMint, [{ address: fixed, writable: true }, { seeds: [{ literal: "counter" }] }]);
    const [counter] = await pda(hook, ["counter"]);
    const out1 = hookRest(pi, [{ address: fixed, writable: true }, { address: counter }]);
    expect(await swap("quote in, base out", pi, t, true, 5_000_000_000n, { rest: out1, slices: [["base", out1.length]] })).toBe("ok");
    // the extras in another order than the list's, and the instructions sysvar first
    const out2 = hookRest(pi, [{ address: counter }, { address: fixed, writable: true }]);
    expect(
      await swap("another order, with the sysvar", pi, t, true, 1_000_000_000n, {
        rest: [{ address: INSTRUCTIONS }, ...out2],
        slices: [["base", out2.length]],
      }),
    ).toBe("ok");
    // base in (the trader's transfer): seeds from the instruction data (the amount), an account key (the destination),
    // an account's data (the source's owner), a PDA of another program (the first extra), a key read from account data
    const amount = 1_000_000_000n;
    const metas: HookMeta[] = [
      { address: fixedProgram },
      { seeds: [{ literal: "amount" }, { ixData: [8, 8] }] },
      { seeds: [{ accountKey: 2 }, { accountData: [0, 32, 32] }], writable: true },
      { seeds: [{ literal: "ext" }, { accountKey: 1 }], program: 5 },
      { keyFromAccountData: [0, 32] },
    ];
    await writeExtraMetas(p, hook, pi.baseMint, metas);
    const amountLe = Buffer.alloc(8);
    amountLe.writeBigUInt64LE(amount);
    const [byAmount] = await pda(hook, [new Uint8Array(Buffer.concat([Buffer.from("amount"), amountLe]))]);
    const [byKeys] = await pda(hook, [new Uint8Array(key(pi.baseVault)), new Uint8Array(key(t.who.address))]);
    const [external] = await pda(fixedProgram, ["ext", pi.baseMint]);
    const in1 = hookRest(pi, [
      { address: fixedProgram },
      { address: byAmount },
      { address: byKeys, writable: true },
      { address: external },
      { address: t.who.address },
    ]);
    expect(await swap("base in, five kinds of extra accounts", pi, t, false, amount, { rest: in1, slices: [["base", in1.length]] })).toBe("ok");
    // the writable PDA passed read-only: the runtime refuses the escalation in the transfer
    const ro = in1.map((m) => ({ ...m, writable: false }));
    expect(await swap("a writable extra passed read-only", pi, t, false, amount, { rest: ro, slices: [["base", ro.length]] })).toBe(
      builtin("PrivilegeEscalation"),
    );
    // the hook itself refuses 13
    const [by13] = await pda(hook, [new Uint8Array(Buffer.concat([Buffer.from("amount"), Buffer.from([13, 0, 0, 0, 0, 0, 0, 0])]))]);
    const in13 = hookRest(pi, [
      { address: fixedProgram },
      { address: by13 },
      { address: byKeys, writable: true },
      { address: external },
      { address: t.who.address },
    ]);
    expect(await swap("the hook refuses", pi, t, false, 13n, { rest: in13, slices: [["base", in13.length]] })).not.toBe("ok");

    // an extra that is the source itself (read-only in execute: de-escalated), and no list at all (only the program)
    await writeExtraMetas(p, hook, pi.baseMint, [{ address: pi.baseVault, writable: true }]);
    const own = hookRest(pi, [{ address: pi.baseVault, writable: true }]);
    expect(await swap("the source as an extra", pi, t, true, 1_000_000_000n, { rest: own, slices: [["base", own.length]] })).toBe("ok");
    expect(await swap("no validation account passed", pi, t, true, 1_000_000_000n, { rest: [{ address: hook }], slices: [["base", 1]] })).toBe("ok");

    // a referral on base fees (collect mode 1, quote in): its own slice
    await writeExtraMetas(p, hook, pi.baseMint, [{ seeds: [{ literal: "counter" }] }]);
    const ref = await account((await generateKeyPairSigner()).address, pi.baseMint, TOKEN_2022, 0n);
    const h = hookRest(pi, [{ address: counter }]);
    expect(
      await swap("a referral", pi, t, true, 2_000_000_000n, {
        referral: ref,
        rest: [...h, ...h],
        slices: [
          ["base", h.length],
          ["referral", h.length],
        ],
      }),
    ).toBe("ok");
    expect(await swap("a referral without its slice", pi, t, true, 2_000_000_000n, { referral: ref, rest: h, slices: [["base", h.length]] })).toBe(
      custom(E.MissingRemainingAccountForTransferHook),
    );

    // the claims: base with the hook's slice, quote plain
    const claimer = claimers.get(pi.config)!;
    const dst = { a: await account(claimer.address, pi.baseMint, TOKEN_2022, 0n), b: await account(claimer.address, quote, TOKEN, 0n) };
    const cdst = { a: await account(pi.creator.address, pi.baseMint, TOKEN_2022, 0n), b: await account(pi.creator.address, quote, TOKEN, 0n) };
    const claim = (name: "claim_trading_fee2" | "claim_creator_trading_fee2", who: KeyPairSigner, a: bigint, b: bigint, rest: Meta[], slices: Slice[]) => {
      const d = name === "claim_trading_fee2" ? dst : cdst;
      const accounts: Meta[] = [
        { address: POOL_AUTHORITY },
        ...(name === "claim_trading_fee2" ? [{ address: pi.config }] : []),
        { address: pi.pool, writable: true },
        { address: d.a, writable: true },
        { address: d.b, writable: true },
        { address: pi.baseVault, writable: true },
        { address: pi.quoteVault, writable: true },
        { address: pi.baseMint },
        { address: quote },
        { address: who.address, signer: who },
        { address: TOKEN_2022 },
        { address: TOKEN },
        { address: p.eventAuthority },
        { address: PROGRAM },
        ...rest,
      ];
      const args = name === "claim_trading_fee2" ? { max_amount_a: big(a), max_amount_b: big(b) } : { max_base_amount: big(a), max_quote_amount: big(b) };
      return p.both(
        name,
        who,
        [p.ix(name, { ...args, transfer_hook_accounts_info: slicesArg(slices) }, accounts)],
        [pi.pool, pi.baseVault, pi.quoteVault, d.a, d.b],
      );
    };
    expect(await swap("fees in quote", pi, t, false, 10n ** 11n, { rest: h, slices: [["base", h.length]] })).toBe("ok");
    expect(await claim("claim_trading_fee2", t.who, 1n, 1n, h, [["base", h.length]])).toBe(custom(E.Unauthorized));
    expect(await claim("claim_trading_fee2", claimer, 10n ** 18n, 0n, [], [])).toBe(custom(E.MissingRemainingAccountForTransferHook));
    expect(await claim("claim_trading_fee2", claimer, 1n, 1n, h, [["referral", h.length]])).toBe(custom(E.InvalidRemainingAccountSliceType));
    expect(
      await claim(
        "claim_trading_fee2",
        claimer,
        1n,
        1n,
        [...h, ...h],
        [
          ["base", h.length],
          ["base", h.length],
        ],
      ),
    ).toBe(custom(E.DuplicatedRemainingAccountTypes));
    expect(await claim("claim_trading_fee2", claimer, 1n, 1n, h, [["base", h.length + 1]])).toBe(custom(E.InvalidRemainingAccountsLength));
    expect(await claim("claim_trading_fee2", claimer, 1n, 1n, [...h, { address: SYSTEM }], [["base", h.length]])).toBe(
      custom(E.InvalidRemainingAccountsLength),
    );
    expect(await claim("claim_trading_fee2", claimer, 0n, 10n ** 18n, [], [["base", 0]])).toBe("ok");
    expect(
      await claim("claim_trading_fee2", claimer, 10n ** 18n, 10n ** 18n, h, [
        ["base", 0],
        ["base", h.length],
      ]),
    ).toBe("ok");
    expect(await claim("claim_creator_trading_fee2", t.who, 1n, 1n, h, [["base", h.length]])).toBe(custom(E.Unauthorized));
    expect(await claim("claim_creator_trading_fee2", pi.creator, 10n ** 18n, 10n ** 18n, h, [["base", h.length]])).toBe("ok");

    // to the threshold: the completing swap revokes the hook program and its authority
    expect(await swap("partial fill to the threshold", pi, t, true, 10n ** 14n, { mode: 1, rest: h, slices: [["base", h.length]] })).toBe("ok");
    expect(await swap("after completion", pi, t, true, 1_000_000n, { rest: h, slices: [["base", h.length]] })).toBe(custom(E.PoolIsCompleted));
    expect(await claim("claim_creator_trading_fee2", pi.creator, 10n ** 18n, 0n, h, [["base", h.length]])).not.toBe("");
    expect(await claim("claim_trading_fee2", claimer, 10n ** 18n, 0n, h, [["base", h.length]])).toBe(custom(E.NoTransferHookProgram));
    expect(await claim("claim_trading_fee2", claimer, 10n ** 18n, 0n, [], [])).toBe("ok");
  });

  it("the accounts and slices it refuses", async () => {
    const pi = await makePool(params());
    const t = await trader(pi);
    const plain = await makePool(params(), true);
    const tp = await trader(plain);
    await writeExtraMetas(p, hook, pi.baseMint, [{ seeds: [{ literal: "counter" }] }]);
    const [counter] = await pda(hook, ["counter"]);
    const h = hookRest(pi, [{ address: counter }]);
    const base = { rest: h, slices: [["base", h.length]] as Slice[] };
    const cases: [string, PoolInfo, Trader, Parameters<typeof swapIx>[4], string][] = [
      ["a VirtualPool", plain, tp, {}, custom(E.PoolTypeMismatch)],
      ["swap2 on a TransferHookPool", pi, t, { ...base, name: "swap2" }, custom(E.PoolTypeMismatch)],
      ["no hook accounts", pi, t, {}, custom(E.MissingRemainingAccountForTransferHook)],
      ["slices longer than the accounts", pi, t, { rest: h, slices: [["base", h.length + 1]] }, custom(E.MathOverflow)],
      [
        "two accounts before the slices",
        pi,
        t,
        { rest: [{ address: INSTRUCTIONS }, ...h, { address: SYSTEM }], slices: [["base", h.length]] },
        custom(E.InvalidRemainingAccountsLength),
      ],
      ["a wrong sysvar", pi, t, { rest: [{ address: SYSTEM }, ...h], slices: [["base", h.length]] }, custom(E.InvalidInstructionsSysvar)],
      [
        "duplicated base slices",
        pi,
        t,
        {
          rest: [...h, ...h],
          slices: [
            ["base", h.length],
            ["base", h.length],
          ],
        },
        custom(E.DuplicatedRemainingAccountTypes),
      ],
      ["the hook program missing", pi, t, { rest: h.slice(0, 1).concat(h.slice(2)), slices: [["base", 2]] }, custom(HOOK_INCORRECT_ACCOUNT)],
      ["an extra account missing", pi, t, { rest: h.slice(1), slices: [["base", 2]] }, custom(RES_INCORRECT_ACCOUNT)],
      ["the base vault of another pool", pi, t, { ...base, over: { baseVault: plain.baseVault } }, custom(2014)],
      [
        "slippage before the slices are parsed",
        pi,
        t,
        {
          amount1: 10n ** 18n,
          rest: [...h, ...h],
          slices: [
            ["base", h.length],
            ["base", h.length],
          ],
        },
        custom(6002),
      ],
    ];
    for (const [label, pool, tr, opts, want] of cases) expect(await swap(label, pool, tr, true, 1_000_000_000n, opts), label).toBe(want);
  });

  it("the resolver's refusals: malformed lists and seeds", async () => {
    const pi = await makePool(params());
    const t = await trader(pi);
    const [counter] = await pda(hook, ["counter"]);
    const rest = hookRest(pi, [{ address: counter }]);
    const tlv = (value: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(value.length);
      return Buffer.concat([EXECUTE_DISC, len, value]);
    };
    const list = (count: number, entries: Buffer) => {
      const c = Buffer.alloc(4);
      c.writeUInt32LE(count);
      return Buffer.concat([c, entries]);
    };
    const valid = extraMetasData([{ seeds: [{ literal: "counter" }] }]);
    const raw = (bytes: number[]) => ({ raw: new Uint8Array(bytes) });
    const cases: [string, HookMeta[] | Buffer, string][] = [
      ["an empty validation account", Buffer.alloc(0), builtin("InvalidAccountData")],
      ["zeros only", Buffer.alloc(40), custom(TLV_TYPE_NOT_FOUND)],
      ["another TLV type only", Buffer.concat([Buffer.alloc(8, 7), Buffer.alloc(4), Buffer.alloc(12)]), custom(TLV_TYPE_NOT_FOUND)],
      ["another TLV type first", Buffer.concat([Buffer.alloc(8, 7), Buffer.from([1, 0, 0, 0, 9]), valid]), "ok"],
      ["an entry past the end", Buffer.concat([EXECUTE_DISC, Buffer.from([200, 0, 0, 0]), Buffer.alloc(10)]), builtin("InvalidAccountData")],
      ["a truncated header", Buffer.concat([valid, Buffer.from([1, 2, 3])]), builtin("InvalidAccountData")],
      ["zeros after the list", Buffer.concat([valid, Buffer.alloc(5)]), "ok"],
      ["a list shorter than its count", tlv(list(2, Buffer.from(valid.subarray(16)))), custom(1)],
      ["a list without its count", tlv(Buffer.alloc(3)), custom(1)],
      ["a list with stray bytes", tlv(Buffer.concat([valid.subarray(12), Buffer.alloc(2)])), builtin("InvalidArgument")],
      ["a meta of kind 5", [raw([5])], builtin("InvalidAccountData")],
      ["a seed of kind 9", [raw([1, 9])], builtin("InvalidAccountData")],
      ["a literal longer than its room", [raw([1, 1, 31])], custom(RES_INVALID_BYTES_FOR_SEED)],
      ["instruction data past the end", [{ seeds: [{ ixData: [10, 8] }] }], custom(RES_INSTRUCTION_DATA_TOO_SMALL)],
      ["an account key out of range", [{ seeds: [{ accountKey: 9 }] }], custom(RES_ACCOUNT_NOT_FOUND)],
      ["account data past the end", [{ seeds: [{ accountData: [3, 0, 5] }] }], custom(RES_ACCOUNT_DATA_TOO_SMALL)],
      ["another program out of range", [{ seeds: [{ literal: "x" }], program: 7 }], custom(RES_ACCOUNT_NOT_FOUND)],
      ["a key from the instruction data", [{ keyFromIxData: 0 }], custom(RES_INSTRUCTION_DATA_TOO_SMALL)],
      ["a key past an account's data", [{ keyFromAccountData: [3, 0] }], custom(RES_ACCOUNT_DATA_TOO_SMALL)],
      ["a key from an unknown account", [{ keyFromAccountData: [8, 0] }], custom(RES_ACCOUNT_NOT_FOUND)],
      ["a key config of kind 0", [raw([2, 0])], builtin("InvalidAccountData")],
      ["a seed longer than 32 bytes", [{ seeds: [{ accountData: [0, 0, 40] }] }], "error"],
      ["16 seeds", [{ seeds: Array.from({ length: 16 }, () => ({ accountKey: 1 })) }], "error"],
    ];
    for (const [label, metas, want] of cases) {
      await writeExtraMetas(p, hook, pi.baseMint, metas);
      const out = await swap(label, pi, t, true, 1_000_000_000n, { rest, slices: [["base", rest.length]] });
      if (want === "error") expect(out, label).not.toBe("ok");
      else expect(out, label).toBe(want);
    }
  });

  it("compared", () => {
    console.log(
      `meteora-dbc hooks: ${p.stats.compared} transactions, ${p.stats.innerCompared} inner instructions; outcomes ${JSON.stringify(p.stats.byOutcome)}`,
    );
    expect(p.stats.byOutcome.ok ?? 0).toBeGreaterThan(10);
  });
});
