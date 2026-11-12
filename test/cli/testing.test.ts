// typesol/testing: accounts by name with the IDL's flags and fixed addresses, plain argument and result values.
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import type { Address } from "@solana/kit";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { programHarness } from "../../src/testing.js";
import { deployFile } from "../harness.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}.ts`, import.meta.url));

describe("typesol/testing", () => {
  it("fills signer/writable flags and fixed program addresses, leaves optional accounts out with null", async () => {
    const d = await deployFile(fixture("optional"));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    const bank = await t.pda("bank", owner);
    t.ok(await t.send(owner, t.ix("open", {}, { owner, bank }))); // systemProgram from the IDL's address
    const add = (b: typeof bank | null) => t.ix("maybeAdd", { amount: 7n }, { owner, bank: b, referrer: null });
    expect(t.returned("maybeAdd", await t.send(owner, add(bank)))).toBe(1n);
    expect(t.returned("maybe_add", await t.send(owner, add(null)))).toBe(0n);
    expect(await t.account<{ owner: string; total: bigint }>("Bank", bank)).toEqual({ owner: owner.address, total: 7n });
    expect(t.balance(bank)).toBeGreaterThan(0n);
  });

  it("derives PDA accounts from the IDL's seeds when they are left out", async () => {
    const d = await deployFile(fixture("optional"));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    t.ok(await t.send(owner, t.ix("open", {}, { owner }))); // bank = PDA ["bank", owner]
    const bank = await t.pda("bank", owner);
    expect((await t.account<{ owner: string }>("Bank", bank))?.owner).toBe(owner.address);

    const f = await deployFile(fixture("forof"));
    const u = programHarness(f.svm, f.programId, f.idl as never);
    const admin = await u.wallet();
    const who = (await u.wallet()).address;
    u.ok(await u.send(admin, u.ix("setup", {}, { admin }))); // created at its PDA: derived
    const ledger = await u.pda("ledger", admin);
    u.ok(await u.send(admin, u.ix("add", { who, amount: 5n }, { admin, ledger }))); // no seeds in this instruction: passed
    expect((await u.account<{ entries: { amount: bigint }[] }>("Ledger", ledger))?.entries[0].amount).toBe(5n);
  });

  it("derives ATAs whose token program has a fixed address, and PDAs seeded by unit-enum arguments", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-testing-"));
    const file = path.join(dir, "seeds.ts");
    writeFileSync(
      file,
      `import { type AccountInfo, type Ata, type Mint, type Seeds, type Signer, type TokenAccount, type TokenProgram } from "typesol";
export enum Side { Bid, Ask }
export function holder(owner: AccountInfo, mint: Mint, ata: Ata<TokenAccount, "owner", "mint">, tokenProgram: TokenProgram): void {}
export function book(payer: Signer, book: Seeds<AccountInfo, ["book", "@side"]>, side: Side): void {}
`,
    );
    const d = await deployFile(file);
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = (await t.wallet()).address;
    const mint = (await t.wallet()).address;
    const built = t.ix("holder", {}, { owner, mint });
    const [expected] = await findAssociatedTokenPda({ owner, mint, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address });
    expect(built.accounts![2].address).toBe(expected);
    const payer = await t.wallet();
    expect(t.ix("book", { side: 1 }, { payer }).accounts![1].address).toBe(await t.pda("book", Uint8Array.of(1)));
    expect(t.ix("book", { side: { ask: {} } }, { payer }).accounts![1].address).toBe(await t.pda("book", Uint8Array.of(1)));
  });

  // docs/test-your-program.md, "Seeds of other widths" and "Expecting an error": the snippets there are these lines.
  it("derives a PDA with a u16 seed, and asserts an error code", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-testing-"));
    const file = path.join(dir, "vault.ts");
    writeFileSync(
      file,
      `import { type Init, type Mut, type Seeds, type Signer, type SystemProgram, type u16, type u64, type u8, require } from "typesol";
export enum VaultError { TooMuch = "Amount above the limit" }
export interface Vault { index: u16; bump: u8; }
export function open(owner: Mut<Signer>, vault: Init<Vault>, systemProgram: SystemProgram, index: u16): void {
  vault.bump = vault.create(owner, ["vault", owner.key, index]);
  vault.index = index;
}
export function spend(owner: Signer, vault: Seeds<Mut<Vault>, ["vault", "@owner", "@vault.index"], "bump">, amount: u64): void {
  require(amount <= 10n, VaultError.TooMuch);
}
`,
    );
    const d = await deployFile(file);
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const alice = await t.wallet();
    const u16 = (n: number) => {
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, n, true); // little-endian, as the program reads a u16 seed
      return b;
    };
    const vault = await t.pda("vault", alice, u16(3));
    t.ok(await t.send(alice, t.ix("open", { index: 3 }, { owner: alice, vault })));
    t.ok(await t.send(alice, t.ix("spend", { amount: 5n }, { owner: alice, vault })));
    const res = await t.send(alice, t.ix("spend", { amount: 50n }, { owner: alice, vault }));
    expect(t.errorCode(res)).toBe(6000);
    expect(t.errorName(t.errorCode(res))).toBe("TooMuch");
    // A bare bigint seed is 8 bytes: another address.
    expect(await t.pda("vault", alice, 3n)).not.toBe(vault);
  });

  it("converts data-enum variants with fields like structs", async () => {
    const d = await deployFile(fileURLToPath(new URL("../fixtures/enumstr.ts", import.meta.url)));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    const board = await t.pda("board", owner);
    t.ok(await t.send(owner, t.ix("setup", {}, { owner })));
    // A bigint for a u8 field and a camelCase variant key, both converted for the Anchor coder.
    expect(t.returned("run", await t.send(owner, t.ix("run", { cmd: { say: { text: "abc", times: 2n } } }, { owner, board })))).toBe(6n);
  });

  it("says what is wrong with an instruction it cannot build", async () => {
    const d = await deployFile(fixture("optional"));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    expect(() => t.ix("nope")).toThrow(/no instruction "nope"/);
    expect(() => t.ix("open", {}, {})).toThrow(/account "owner" is required/);
    expect(() => t.ix("open", {}, { owner, bank: owner.address, extra: owner.address })).toThrow(/has no account "extra"/);
    expect(() => t.errorCode(t.ok as never)).toThrow();
  });

  it("converts arguments (Options, Pubkeys, u16) and decodes struct return data", async () => {
    const d = await deployFile(fixture("retdata"));
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const owner = await t.wallet();
    const q = t.returned<Record<string, unknown>>("preview", await t.send(owner, t.ix("preview", { price: 21n, limit: 4n }, { owner })));
    expect(q).toMatchObject({ owner: owner.address, price: 42n, fee: 5, open: false });
    expect(q).toMatchObject({ limit: 4n, label: "preview" }); // fixed-layout Option and FixedString as plain values
    const n = await t.send(owner, t.ix("preview", { price: 1n, limit: null }, { owner }));
    expect(t.returned<{ limit: bigint | null }>("preview", n).limit).toBeNull();
    expect(() => t.ix("preview", { price: 1n, limit: null }, { owner: owner.address })).toThrow(/signs; pass its keypair/);
  });
  it("writes mints and token accounts, moves the clock and names errors", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-testing-"));
    const file = path.join(dir, "tokens.ts");
    writeFileSync(
      file,
      `import { type Mint, type TokenAccount, type TokenInterface, type i64, now, require, u64 } from "typesol";
export enum Gate { TooEarly = "too early" }
/** amount * 100 + decimals, once the clock is past \`at\`. */
export function read(mint: Mint, account: TokenAccount, tokenProgram: TokenInterface, at: i64): u64 {
  require(now() >= at, Gate.TooEarly);
  require(account.mint === mint.key, "mint");
  return account.amount * 100n + u64(mint.decimals);
}
`,
    );
    const d = await deployFile(file);
    const t = programHarness(d.svm, d.programId, d.idl as never);
    const payer = await t.wallet();
    for (const tokenProgram of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"] as Address[]) {
      const mint = await t.mint({ authority: payer.address, decimals: 9, supply: 1_000n, tokenProgram });
      const account = await t.tokenAccount({ mint, owner: payer.address, amount: 250n, tokenProgram });
      expect(t.tokenBalance(account)).toBe(250n);
      const at = t.svm.getClock().unixTimestamp + 3_600n;
      const read = () => t.send(payer, t.ix("read", { at }, { mint, account, tokenProgram }));
      const early = await read();
      expect(t.errorName(t.errorCode(early))).toBe("TooEarly");
      expect(() => t.ok(early)).toThrow(/code: 6000 } } \(TooEarly\)/);
      t.warp({ seconds: 3_600n });
      expect(t.returned("read", t.ok(await read()))).toBe(250n * 100n + 9n);
    }
    expect(t.errorName(5100)).toBe("ArithmeticOverflow");
    expect(t.errorName(1)).toBeUndefined();
    expect(t.tokenBalance((await t.wallet()).address)).toBeNull();
  });

  it("testProgram from parallel processes: one build, the others wait and reuse it; a source change rebuilds once", async () => {
    // vitest runs test files in parallel workers, and each calls testProgram: they used to rebuild into the same
    // target/<name>/ at once and load each other's half-written files.
    const ROOT = fileURLToPath(new URL("../..", import.meta.url));
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-testing-race-")));
    expect(spawnSync("node", [path.join(ROOT, "dist/cli.js"), "init", ".", "--name", "race"], { cwd: dir }).status).toBe(0);
    const child = `
      const { buildForTest, findWorkspace } = await import(${JSON.stringify(path.join(ROOT, "dist/workspace.js"))});
      const { testProgram } = await import(${JSON.stringify(path.join(ROOT, "dist/testing.js"))});
      const rebuilt = buildForTest(findWorkspace(process.argv[1]), "race").rebuilt;
      const t = await testProgram("race", process.argv[1]);
      const alice = await t.wallet();
      t.ok(await t.send(alice, t.ix("initialize", {}, { authority: alice, counter: await t.pda("counter", alice) })));
      console.log(JSON.stringify({ rebuilt, instructions: t.idl.instructions.map((i) => i.name) }));`;
    const run = () =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const p = spawn("node", ["--input-type=module", "-e", child, dir], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => resolve({ code, out, err }));
      });
    const round = async () => {
      const res = await Promise.all([run(), run(), run()]);
      for (const r of res) expect(r.code, r.err).toBe(0);
      return res.map((r) => JSON.parse(r.out.trim().split("\n").at(-1)!) as { rebuilt: boolean; instructions: string[] });
    };
    const first = await round();
    expect(first.filter((r) => r.rebuilt)).toHaveLength(1);
    expect((await round()).filter((r) => r.rebuilt)).toHaveLength(0);
    const entry = path.join(dir, "programs/race.ts");
    writeFileSync(entry, readFileSync(entry, "utf8") + "\nexport function ping(counter: Account<Counter>): void {}\n");
    const changed = await round();
    expect(changed.filter((r) => r.rebuilt)).toHaveLength(1);
    for (const r of changed) expect(r.instructions).toContain("ping");
    rmSync(dir, { recursive: true, force: true });
  }, 240_000);
});
