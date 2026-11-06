// showcase/mainnet/raydium-amm against Raydium AMM v4 as deployed on mainnet (test/programs/raydium_amm_v4.so). Both run
// in their own LiteSVM under the same program id with the same clock. Raydium's three fixed keys (its admin, the pool
// fee destination and the lamports collector) are replaced by test keys in both, so the admin instructions run too:
// in the original where its code loads each key (four 64-bit immediates, lddw), in the port in its source. Every
// transaction must have the same outcome, the same account bytes and the same log lines (the ray_log records and the
// original's messages; the port's own failure lines, "Error n …", and compute-unit lines are left out).
import * as token from "@solana-program/token";
import { getCreateAccountInstruction } from "@solana-program/system";
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { deployFile, pda, send, type Deployed } from "../../test/harness.js";

const PROGRAM = address("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const ORIGINAL = fileURLToPath(new URL("../../test/programs/raydium_amm_v4.so", import.meta.url));
const PORT = fileURLToPath(new URL("../mainnet/raydium-amm/raydium_amm.ts", import.meta.url));
const TOKEN = address(token.TOKEN_PROGRAM_ADDRESS);
const ATA = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM = address("11111111111111111111111111111111");
const RENT = address("SysvarRent111111111111111111111111111111111");
const KEYS = {
  admin: "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ",
  fee: "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
  collector: "Rayyxz4cjBTQo7XTT1fhVNqFWK21TjiWcrtPgC3czbL",
} as const;

type Result = TransactionMetadata | FailedTransactionMetadata;
type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

const enc = getAddressEncoder();
const key = (a: string) => Buffer.from(enc.encode(address(a)));
const u8 = (n: number) => Buffer.from([n]);
const u64 = (n: bigint) => Buffer.from(BigUint64Array.of(n).buffer);
const outcome = (r: Result) => (r instanceof FailedTransactionMetadata ? `error: ${String(r.err())}` : "ok");
const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
/** The log lines both must share: everything but compute-unit lines and the port's own failure / panic lines. */
const lines = (r: Result) =>
  meta(r)
    .logs()
    .filter((l) => !/ consumed \d+ of \d+ compute units$/.test(l) && !/^Program log: (Error \d+ |Error: |TypeSOL: |panicked at)/.test(l));

describe("showcase/mainnet/raydium-amm against Raydium AMM v4 on mainnet", () => {
  let d: Deployed;
  let original: LiteSVM;
  let admin: KeyPairSigner;
  let collector: KeyPairSigner;
  let feeOwner: KeyPairSigner;
  const cu: Record<string, [bigint, bigint]> = {};
  let compared = 0;

  beforeAll(async () => {
    admin = await generateKeyPairSigner();
    collector = await generateKeyPairSigner();
    feeOwner = await generateKeyPairSigner();
    const swap: [string, Address][] = [
      [KEYS.admin, admin.address],
      [KEYS.fee, feeOwner.address],
      [KEYS.collector, collector.address],
    ];
    const so = Buffer.from(readFileSync(ORIGINAL));
    for (const [was, now] of swap) {
      const [from, to] = [key(was), key(now)];
      for (let c = 0; c < 4; c++) {
        const [a, b] = [from.readBigUInt64LE(c * 8), to.readBigUInt64LE(c * 8)];
        let patched = 0;
        for (let i = 0; i + 16 <= so.length; i += 8)
          if (so[i] === 0x18 && so.readUInt32LE(i + 4) === Number(a & 0xffffffffn) && so[i + 8] === 0 && so.readUInt32LE(i + 12) === Number(a >> 32n)) {
            so.writeUInt32LE(Number(b & 0xffffffffn), i + 4);
            so.writeUInt32LE(Number(b >> 32n), i + 12);
            patched++;
          }
        expect(patched, `${was}, part ${c}`).toBe(was === KEYS.admin ? 5 : 1);
      }
    }
    const source = mkdtempSync(path.join(os.tmpdir(), "raydium-amm-port-"));
    cpSync(path.dirname(PORT), source, { recursive: true });
    for (const f of readdirSync(source)) {
      let text = readFileSync(path.join(source, f), "utf8");
      for (const [was, now] of swap) text = text.replaceAll(was, now);
      writeFileSync(path.join(source, f), text);
    }
    d = await deployFile(path.join(source, path.basename(PORT)), { programId: PROGRAM });
    original = new LiteSVM();
    original.addProgram(PROGRAM, new Uint8Array(so));
    for (const vm of [original, d.svm]) {
      const clock = vm.getClock();
      clock.unixTimestamp = 1_800_000_000n;
      clock.epoch = 900n;
      vm.setClock(clock);
      for (const s of [admin, collector, feeOwner]) vm.airdrop(s.address, lamports(100_000_000_000n));
    }
  });
  const vms = () => [original, d.svm] as const;

  const ix = (data: Buffer, accounts: Meta[]): Instruction => ({
    programAddress: PROGRAM,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(data),
  });
  const funded = async () => {
    const s = await generateKeyPairSigner();
    for (const vm of vms()) vm.airdrop(s.address, lamports(100_000_000_000n));
    return s;
  };
  const bytes = (vm: LiteSVM, a: Address) => {
    const acct = vm.getAccount(a);
    return acct.exists ? `${acct.lamports} ${acct.programAddress} ${Buffer.from(acct.data).toString("hex")}` : "missing";
  };
  const setup = async (payer: KeyPairSigner, ixs: Instruction[]) => {
    for (const vm of vms()) {
      const r = await send(vm, payer, ixs);
      if (r instanceof FailedTransactionMetadata) throw new Error(`setup failed: ${String(r.err())}\n${r.meta().logs().join("\n")}`);
    }
  };
  /** Send to both: the same outcome, account bytes and log lines. */
  const both = async (label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[]) => {
    const [a, b] = [await send(original, payer, ixs), await send(d.svm, payer, ixs)];
    compared++;
    const logs = (r: Result) => meta(r).logs().join("\n");
    expect(outcome(b), `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`).toBe(outcome(a));
    expect(lines(b), `${label}: logs`).toEqual(lines(a));
    for (const w of watch) expect(bytes(d.svm, w), `${label}: ${w}`).toBe(bytes(original, w));
    cu[label] = [meta(a).computeUnitsConsumed(), meta(b).computeUnitsConsumed()];
    return outcome(a);
  };
  const custom = (code: number) => `error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: ${code} } }`;

  async function mint(payer: KeyPairSigner, decimals: number) {
    const m = await generateKeyPairSigner();
    await setup(payer, [
      getCreateAccountInstruction({ payer, newAccount: m, lamports: original.minimumBalanceForRentExemption(82n), space: 82, programAddress: TOKEN }),
      token.getInitializeMint2Instruction({ mint: m.address, decimals, mintAuthority: payer.address }) as Instruction,
    ]);
    return m.address;
  }
  async function account(payer: KeyPairSigner, m: Address, owner: Address, amount: bigint) {
    const a = await generateKeyPairSigner();
    await setup(payer, [
      getCreateAccountInstruction({ payer, newAccount: a, lamports: original.minimumBalanceForRentExemption(165n), space: 165, programAddress: TOKEN }),
      token.getInitializeAccount3Instruction({ account: a.address, mint: m, owner }) as Instruction,
      ...(amount > 0n ? [token.getMintToInstruction({ mint: m, token: a.address, mintAuthority: payer, amount }) as Instruction] : []),
    ]);
    return a.address;
  }
  const ataOf = async (owner: Address, m: Address) => (await pda(ATA, [owner, TOKEN, m]))[0];

  interface Pool {
    market: Address;
    amm: Address;
    authority: Address;
    nonce: number;
    lpMint: Address;
    coinMint: Address;
    pcMint: Address;
    coinVault: Address;
    pcVault: Address;
    target: Address;
    config: Address;
    creator: KeyPairSigner;
    userLp: Address;
  }
  const all = (p: Pool, more: Address[] = []) => [p.amm, p.target, p.coinVault, p.pcVault, p.lpMint, p.userLp, ...more];

  async function config(): Promise<Address> {
    const [cfg] = await pda(PROGRAM, ["amm_config_account_seed"]);
    if (original.getAccount(cfg).exists) return cfg;
    expect(
      await both("create_config", admin, [ix(u8(14), [{ address: admin.address, signer: admin, writable: true }, { address: cfg, writable: true }, { address: admin.address }, { address: SYSTEM }])], [cfg]),
    ).toBe("ok");
    return cfg;
  }

  /** A pool of two fresh mints (coin 6 decimals, pc 9), created with Initialize2 in its 19-account form. */
  async function pool(opts: { coin?: bigint; pc?: bigint; openTime?: bigint; legacy?: boolean } = {}): Promise<Pool> {
    const creator = await funded();
    const cfg = await config();
    const coinMint = await mint(creator, 6);
    const pcMint = await mint(creator, 9);
    const coinAmount = opts.coin ?? 1_000_000_000n;
    const pcAmount = opts.pc ?? 50_000_000_000_000n;
    const userCoin = await account(creator, coinMint, creator.address, coinAmount * 10n);
    const userPc = await account(creator, pcMint, creator.address, pcAmount * 10n);
    const market = (await generateKeyPairSigner()).address;
    const assoc = async (seed: string) => (await pda(PROGRAM, [PROGRAM, market, seed]))[0];
    const [authority, nonce] = await pda(PROGRAM, ["amm authority"]);
    const p: Pool = {
      market,
      amm: await assoc("amm_associated_seed"),
      authority,
      nonce,
      lpMint: await assoc("lp_mint_associated_seed"),
      coinMint,
      pcMint,
      coinVault: await assoc("coin_vault_associated_seed"),
      pcVault: await assoc("pc_vault_associated_seed"),
      target: await assoc("target_associated_seed"),
      config: cfg,
      creator,
      userLp: "" as Address,
    };
    p.userLp = await ataOf(creator.address, p.lpMint);
    const data = Buffer.concat([u8(1), u8(nonce), u64(opts.openTime ?? 0n), u64(pcAmount), u64(coinAmount)]);
    const metas: Meta[] = [
      { address: TOKEN },
      { address: ATA },
      { address: SYSTEM },
      { address: RENT },
      { address: p.amm, writable: true },
      { address: authority },
      ...(opts.legacy ? [{ address: (await generateKeyPairSigner()).address, writable: true }] : []),
      { address: p.lpMint, writable: true },
      { address: coinMint },
      { address: pcMint },
      { address: p.coinVault, writable: true },
      { address: p.pcVault, writable: true },
      { address: p.target, writable: true },
      { address: cfg },
      { address: feeOwner.address, writable: true },
      ...(opts.legacy ? [{ address: (await generateKeyPairSigner()).address }] : []),
      { address: market },
      { address: creator.address, signer: creator, writable: true },
      { address: userCoin, writable: true },
      { address: userPc, writable: true },
      { address: p.userLp, writable: true },
    ];
    expect(await both("initialize2", creator, [ix(data, metas)], all(p, [userCoin, userPc]))).toBe("ok");
    return p;
  }

  /** A trader with token accounts of both mints (the pool creator, the mint authority, funds them). */
  async function trader(p: Pool, coin: bigint, pc: bigint) {
    const t = await funded();
    return {
      signer: t,
      coin: await account(p.creator, p.coinMint, t.address, coin),
      pc: await account(p.creator, p.pcMint, t.address, pc),
      lp: await account(p.creator, p.lpMint, t.address, 0n),
    };
  }
  type Trader = Awaited<ReturnType<typeof trader>>;

  /** v1 swap accounts (17, or 18 with the target orders account), or v2's 8. */
  function swapMetas(p: Pool, t: Trader, from: "coin" | "pc", form: 17 | 18 | 8): Meta[] {
    const src = from === "coin" ? t.coin : t.pc;
    const dst = from === "coin" ? t.pc : t.coin;
    const user: Meta[] = [{ address: src, writable: true }, { address: dst, writable: true }, { address: t.signer.address, signer: t.signer }];
    if (form === 8)
      return [{ address: TOKEN }, { address: p.amm, writable: true }, { address: p.authority }, { address: p.coinVault, writable: true }, { address: p.pcVault, writable: true }, ...user];
    const filler = { address: SYSTEM };
    return [
      { address: TOKEN },
      { address: p.amm, writable: true },
      { address: p.authority },
      filler,
      ...(form === 18 ? [{ address: p.target, writable: true }] : []),
      { address: p.coinVault, writable: true },
      { address: p.pcVault, writable: true },
      ...Array(8).fill(filler), // the order book's program, market, bids, asks, event queue, vaults and signer
      ...user,
    ];
  }
  const swapIx = (p: Pool, t: Trader, from: "coin" | "pc", form: 17 | 18 | 8, baseIn: boolean, a: bigint, b: bigint) =>
    ix(Buffer.concat([u8(form === 8 ? (baseIn ? 16 : 17) : baseIn ? 9 : 11), u64(a), u64(b)]), swapMetas(p, t, from, form));
  const depositIx = (p: Pool, t: Trader, maxCoin: bigint, maxPc: bigint, base: bigint, otherMin?: bigint) =>
    ix(Buffer.concat([u8(3), u64(maxCoin), u64(maxPc), u64(base), ...(otherMin !== undefined ? [u64(otherMin)] : [])]), [
      { address: TOKEN },
      { address: p.amm, writable: true },
      { address: p.authority },
      { address: p.target, writable: true },
      { address: p.lpMint, writable: true },
      { address: p.coinVault, writable: true },
      { address: p.pcVault, writable: true },
      { address: t.coin, writable: true },
      { address: t.pc, writable: true },
      { address: t.lp, writable: true },
      { address: t.signer.address, signer: t.signer },
    ]);
  const withdrawIx = (p: Pool, t: Trader, amount: bigint, mins?: [bigint, bigint]) =>
    ix(Buffer.concat([u8(4), u64(amount), ...(mins ? [u64(mins[0]), u64(mins[1])] : [])]), [
      { address: TOKEN },
      { address: p.amm, writable: true },
      { address: p.authority },
      { address: p.target, writable: true },
      { address: p.lpMint, writable: true },
      { address: p.coinVault, writable: true },
      { address: p.pcVault, writable: true },
      { address: t.lp, writable: true },
      { address: t.coin, writable: true },
      { address: t.pc, writable: true },
      { address: t.signer.address, signer: t.signer },
    ]);
  const watch = (p: Pool, t: Trader) => all(p, [t.coin, t.pc, t.lp]);

  it("creates the config and pools (19- and 21-account forms, open now or later)", async () => {
    await pool();
    await pool({ legacy: true });
    await pool({ openTime: 1_900_000_000n });
  });

  it("swaps both ways, base in and base out, v1 (17 / 18 accounts) and v2", async () => {
    const p = await pool();
    const t = await trader(p, 10_000_000_000n, 500_000_000_000_000n);
    for (const form of [17, 18, 8] as const)
      for (const from of ["coin", "pc"] as const) {
        expect(await both(`swap in ${from} ${form}`, t.signer, [swapIx(p, t, from, form, true, from === "coin" ? 1_000_000n : 40_000_000_000n, 1n)], watch(p, t))).toBe("ok");
        expect(await both(`swap out ${from} ${form}`, t.signer, [swapIx(p, t, from, form, false, 10n ** 15n, from === "coin" ? 30_000_000_000n : 500_000n)], watch(p, t))).toBe("ok");
      }
  });

  it("refuses swaps as the original does", async () => {
    const p = await pool();
    const t = await trader(p, 10_000_000_000n, 500_000_000_000_000n);
    const cases: [string, Instruction][] = [
      ["slippage", swapIx(p, t, "coin", 17, true, 1_000_000n, 10n ** 18n)],
      ["max in", swapIx(p, t, "coin", 8, false, 1n, 30_000_000_000n)],
      ["more than held", swapIx(p, t, "coin", 17, true, 10n ** 15n, 1n)],
      ["zero in", swapIx(p, t, "pc", 8, true, 0n, 0n)],
      ["the whole pool out", swapIx(p, t, "pc", 17, false, 10n ** 18n, 1_000_000_000n)],
      ["wrong count", ix(Buffer.concat([u8(9), u64(1n), u64(1n)]), swapMetas(p, t, "coin", 17).slice(0, 16))],
      ["short data", ix(Buffer.concat([u8(9), u64(1n)]), swapMetas(p, t, "coin", 17))],
      ["v2 short of accounts", ix(Buffer.concat([u8(16), u64(1n), u64(1n)]), swapMetas(p, t, "coin", 8).slice(0, 6))],
    ];
    for (const [label, i] of cases) expect(await both(`swap: ${label}`, t.signer, [i], watch(p, t))).not.toBe("ok");
    // A swap into the pool's own vault, and an unrelated token program.
    const bad = swapMetas(p, t, "coin", 8);
    bad[6] = { address: p.pcVault, writable: true };
    expect(await both("swap: to the vault", t.signer, [ix(Buffer.concat([u8(16), u64(1_000n), u64(1n)]), bad)], watch(p, t))).toBe(custom(42));
    const wrongProgram = swapMetas(p, t, "coin", 8);
    wrongProgram[0] = { address: SYSTEM };
    expect(await both("swap: token program", t.signer, [ix(Buffer.concat([u8(16), u64(1_000n), u64(1n)]), wrongProgram)], watch(p, t))).toBe(custom(38));
  });

  it("deposits and withdraws, with and without the optional minimums", async () => {
    const p = await pool();
    const t = await trader(p, 10_000_000_000n, 500_000_000_000_000n);
    expect(await both("deposit base coin", t.signer, [depositIx(p, t, 100_000_000n, 10n ** 15n, 0n)], watch(p, t))).toBe("ok");
    expect(await both("deposit base pc", t.signer, [depositIx(p, t, 10n ** 12n, 1_000_000_000_000n, 1n, 1n)], watch(p, t))).toBe("ok");
    expect(await both("deposit, other below its minimum", t.signer, [depositIx(p, t, 100_000_000n, 10n ** 15n, 0n, 10n ** 15n)], watch(p, t))).toBe(custom(30));
    expect(await both("deposit, zero", t.signer, [depositIx(p, t, 0n, 1n, 0n)], watch(p, t))).toBe(custom(29));
    expect(await both("deposit past u64", t.signer, [depositIx(p, t, 2n ** 64n - 1n, 1n, 0n)], watch(p, t))).not.toBe("ok");
    // Swaps grow x * y: the next deposit and withdrawal set P&L aside.
    for (let i = 0; i < 6; i++) await both(`churn ${i}`, t.signer, [swapIx(p, t, i % 2 ? "pc" : "coin", 8, true, i % 2 ? 30_000_000_000n : 900_000n, 1n)], watch(p, t));
    const lp = BigInt(token.getTokenDecoder().decode(original.getAccount(t.lp).data).amount);
    expect(await both("withdraw half", t.signer, [withdrawIx(p, t, lp / 2n)], watch(p, t))).toBe("ok");
    expect(await both("withdraw with minimums", t.signer, [withdrawIx(p, t, lp / 4n, [1n, 1n])], watch(p, t))).toBe("ok");
    expect(await both("withdraw, minimums missed", t.signer, [withdrawIx(p, t, lp / 8n, [10n ** 15n, 1n])], watch(p, t))).toBe(custom(30));
    expect(await both("withdraw more than held", t.signer, [withdrawIx(p, t, 10n ** 18n)], watch(p, t))).toBe(custom(40));
  });

  it("lets the admin set parameters and the P&L owner take the P&L", async () => {
    const p = await pool();
    const t = await trader(p, 10_000_000_000n, 500_000_000_000_000n);
    const set = (data: Buffer, signer: KeyPairSigner) => ix(data, [{ address: p.amm, writable: true }, { address: signer.address, signer }]);
    expect(await both("set status, not the admin", t.signer, [set(Buffer.concat([u8(6), u8(0), u64(2n)]), t.signer)], [p.amm])).toBe(custom(21));
    expect(await both("set status 3", admin, [set(Buffer.concat([u8(6), u8(0), u64(3n)]), admin)], [p.amm])).toBe("ok");
    expect(await both("swap while withdraw-only", t.signer, [swapIx(p, t, "coin", 8, true, 1_000n, 1n)], watch(p, t))).toBe(custom(22));
    expect(await both("set status 6", admin, [set(Buffer.concat([u8(6), u8(0), u64(6n)]), admin)], [p.amm])).toBe("ok");
    expect(await both("set status 9", admin, [set(Buffer.concat([u8(6), u8(0), u64(9n)]), admin)], [p.amm])).toBe(custom(29));
    expect(await both("set state 4", admin, [set(Buffer.concat([u8(6), u8(1), u64(4n)]), admin)], [p.amm])).toBe("ok");
    const fees = (n: bigint) => Buffer.concat([5n, 10000n, 25n, 10000n, 12n, 100n, n, 10000n].map(u64));
    expect(await both("set fees", admin, [set(Buffer.concat([u8(6), u8(2), fees(30n)]), admin)], [p.amm])).toBe("ok");
    expect(await both("set fees, invalid", admin, [set(Buffer.concat([u8(6), u8(2), fees(10000n)]), admin)], [p.amm])).toBe(custom(48));
    expect(await both("set open time", admin, [set(Buffer.concat([u8(6), u8(3), u64(5n)]), admin)], [p.amm])).toBe("ok");
    expect(await both("set params, bad param", admin, [set(Buffer.concat([u8(6), u8(7), u64(5n)]), admin)], [p.amm])).not.toBe("ok");
    for (let i = 0; i < 8; i++) await both(`pnl churn ${i}`, t.signer, [swapIx(p, t, i % 2 ? "pc" : "coin", 8, true, i % 2 ? 300_000_000_000n : 9_000_000n, 1n)], watch(p, t));
    const pnlCoin = await account(p.creator, p.coinMint, admin.address, 0n);
    const pnlPc = await account(p.creator, p.pcMint, admin.address, 0n);
    const take = ix(u8(7), [
      { address: TOKEN },
      { address: p.amm, writable: true },
      { address: p.config },
      { address: p.authority },
      { address: p.coinVault, writable: true },
      { address: p.pcVault, writable: true },
      { address: pnlCoin, writable: true },
      { address: pnlPc, writable: true },
      { address: admin.address, signer: admin },
      { address: p.target, writable: true },
    ]);
    await both("withdraw pnl", admin, [take], all(p, [pnlCoin, pnlPc]));
  });

  it("updates the config and refuses the instructions it no longer supports", async () => {
    const cfg = await config();
    const upd = (data: Buffer, s: KeyPairSigner) => ix(data, [{ address: s.address, signer: s }, { address: cfg, writable: true }]);
    const someone = await funded();
    expect(await both("config: pnl owner", admin, [upd(Buffer.concat([u8(15), u8(0), key(someone.address)]), admin)], [cfg])).toBe("ok");
    expect(await both("config: cancel owner", admin, [upd(Buffer.concat([u8(15), u8(1), key(someone.address)]), admin)], [cfg])).toBe("ok");
    expect(await both("config: default owner", admin, [upd(Buffer.concat([u8(15), u8(1), Buffer.alloc(32)]), admin)], [cfg])).toBe(custom(29));
    expect(await both("config: fee", admin, [upd(Buffer.concat([u8(15), u8(2), u64(0n)]), admin)], [cfg])).toBe("ok");
    expect(await both("config: bad param", admin, [upd(Buffer.concat([u8(15), u8(3), u64(1n)]), admin)], [cfg])).not.toBe("ok");
    expect(await both("config: not the admin", someone, [upd(Buffer.concat([u8(15), u8(2), u64(1n)]), someone)], [cfg])).toBe(custom(21));
    expect(await both("create config again", admin, [ix(u8(14), [{ address: admin.address, signer: admin, writable: true }, { address: cfg, writable: true }, { address: admin.address }, { address: SYSTEM }])], [cfg])).toBe(custom(55));
    for (const tag of [0, 2, 5, 8, 10, 12, 13, 19, 255]) expect(await both(`tag ${tag}`, someone, [ix(u8(tag), [])], [])).not.toBe("ok");
    expect(await both("no data", someone, [ix(Buffer.alloc(0), [])], [])).not.toBe("ok");
  });

  it("sends excess lamports of program accounts to the collector", async () => {
    const p = await pool();
    for (const vm of vms()) {
      const a = vm.getAccount(p.amm);
      vm.setAccount({ ...a, lamports: a.lamports + 12_345n } as never);
    }
    const take = ix(u8(18), [{ address: collector.address, signer: collector, writable: true }, { address: p.authority }, { address: TOKEN }, { address: p.amm, writable: true }]);
    expect(await both("excess lamports", collector, [take], [p.amm, collector.address])).toBe("ok");
  });

  it("matches the original on random swaps, deposits and withdrawals", async () => {
    let seed = BigInt(process.env.FUZZ_SEED ?? 7);
    const rnd = (n: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return (seed >> 11n) % n;
    };
    const p = await pool({ coin: 5_000_000_000n, pc: 3_000_000_000_000n });
    const t = await trader(p, 50_000_000_000n, 30_000_000_000_000n);
    const steps = Number(process.env.FUZZ_STEPS ?? 60);
    for (let i = 0; i < steps; i++) {
      const k = rnd(5n);
      const forms = [17, 18, 8] as const;
      const form = forms[Number(rnd(3n))]!;
      const from = rnd(2n) ? "coin" : "pc";
      let i0: Instruction;
      if (k <= 1n) i0 = swapIx(p, t, from, form, true, 1n + rnd(from === "coin" ? 2_000_000_000n : 1_000_000_000_000n), rnd(3n) ? 0n : rnd(10n ** 12n));
      else if (k === 2n) i0 = swapIx(p, t, from, form, false, rnd(4n) ? 10n ** 15n : rnd(10n ** 12n), 1n + rnd(from === "coin" ? 500_000_000_000n : 1_000_000_000n));
      else if (k === 3n) i0 = depositIx(p, t, 1n + rnd(1_000_000_000n), 1n + rnd(1_000_000_000_000n), rnd(2n));
      else {
        const lp = BigInt(token.getTokenDecoder().decode(original.getAccount(t.lp).data).amount);
        i0 = withdrawIx(p, t, lp === 0n ? 1n : 1n + rnd(lp));
      }
      await both(`fuzz ${i}`, t.signer, [i0], watch(p, t));
    }
  });

  it("reports compute units", () => {
    const rows = Object.entries(cu).filter(([l]) => /^(swap (in|out)|deposit base|withdraw half|initialize2)/.test(l));
    for (const [l, [a, b]] of rows) console.log(`${l.padEnd(24)} original ${String(a).padStart(7)}  TypeSOL ${String(b).padStart(7)}  ${((Number(b) / Number(a)) * 100).toFixed(0)}%`);
    console.log(`${compared} transactions compared`);
    expect(compared).toBeGreaterThan(50);
  });
});
