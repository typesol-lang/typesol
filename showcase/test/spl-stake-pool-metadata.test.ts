// showcase/mainnet/spl-stake-pool against SPL Stake Pool as deployed on mainnet (test/programs/spl_stake_pool.so):
// the pool token's Metaplex metadata, CreateTokenMetadata (17) and UpdateTokenMetadata (18). Both VMs also run Metaplex
// Token Metadata (test/programs/mpl_token_metadata.so), so each transaction's outcome, logs (Metaplex's lines among
// them) and the bytes of every account it names (the metadata account and the payer's lamports included) must agree.
// Metaplex is fetched by scripts/fetch-programs.sh (not kept in the repository); without it the file is skipped.
import { type Address, type Instruction, type KeyPairSigner, AccountRole } from "@solana/kit";
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  Diff,
  MPL_METADATA,
  MPL_METADATA_SO,
  type Pool,
  PROGRAM,
  STAKE_POOL_SIZE,
  SYSTEM,
  TOKEN,
  TOKEN_2022,
  builtin,
  custom,
  ix,
  metadataAddress,
  u8,
  u32,
} from "./spl-stake-pool-helpers.js";

/** StakePoolError codes. */
const E = { InvalidProgramAddress: 1, InvalidState: 2, WrongManager: 6, SignatureMissing: 7, WrongPoolMint: 10, InvalidMetadataAccount: 36 } as const;

const diffs: Diff[] = [];
/** Metaplex's compute units in each compared transaction (from the original's logs). */
const cpiUnits: Record<string, bigint> = {};
/** Diff.both, also noting Metaplex's compute units. */
function track(d: Diff): Diff {
  const both = d.both.bind(d);
  d.both = async (label, payer, ixs, watch) => {
    const got = await both(label, payer, ixs, watch);
    cpiUnits[label] = metaplexUnits(d.lastLogs);
    return got;
  };
  return d;
}
async function diff(): Promise<Diff> {
  const d = track((await Diff.create()).withMetaplex());
  diffs.push(d);
  return d;
}

/** A Borsh String of raw bytes (a length that may lie, bytes that may not be UTF-8). */
const raw = (bytes: Buffer, len = bytes.length) => Buffer.concat([u32(len), bytes]);
const str = (text: string) => raw(Buffer.from(text, "utf8"));

/** The instruction with its account list changed. */
function accounts(i: Instruction, edit: (list: { address: Address; role: AccountRole; signer?: KeyPairSigner }[]) => void): Instruction {
  const list = [...(i.accounts ?? [])].map((a) => ({ ...a })) as { address: Address; role: AccountRole; signer?: KeyPairSigner }[];
  edit(list);
  return { ...i, accounts: list as Instruction["accounts"] };
}
const truncate = (i: Instruction, n: number) => accounts(i, (l) => l.splice(n));
/** Account `at` replaced by `address`, with the same role but no signature. */
const replace = (i: Instruction, at: number, address: Address) =>
  accounts(i, (l) => {
    const role =
      l[at]!.role === AccountRole.READONLY_SIGNER ? AccountRole.READONLY : l[at]!.role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : l[at]!.role;
    l[at] = { address, role };
  });
/** Account `at` with another role (and no signature unless the role is a signer's and it had one). */
const role = (i: Instruction, at: number, r: AccountRole) =>
  accounts(i, (l) => {
    const signs = r === AccountRole.READONLY_SIGNER || r === AccountRole.WRITABLE_SIGNER;
    l[at] = { address: l[at]!.address, role: r, ...(signs && l[at]!.signer ? { signer: l[at]!.signer } : {}) };
  });
/** The same accounts with other data. */
const withData = (i: Instruction, data: Buffer): Instruction => ({ ...i, data: new Uint8Array(data) });

describe.skipIf(!existsSync(MPL_METADATA_SO))("token metadata", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  /** Pays for the metadata account (not the fee payer, so that its signature can be left out). */
  let funder: KeyPairSigner;
  let p: Pool;
  let md: Address;
  const create = (name = "Stake Pool Token", symbol = "SPT", uri = "https://example.com/spt.json", q = p, metadata = md) =>
    ix.createTokenMetadata(q, q.manager, funder, metadata, name, symbol, uri);
  const update = (name = "Staked SOL", symbol = "stSOL", uri = "https://example.com/stsol.json", q = p, metadata = md) =>
    ix.updateTokenMetadata(q, q.manager, metadata, name, symbol, uri);

  beforeAll(async () => {
    d = await diff();
    payer = await d.funded(10_000n);
    funder = await d.funded(10n);
    p = await d.createPool(payer, { label: "initialize (metadata)" });
    md = await metadataAddress(p.mint);
  });

  it("refuses an update before the metadata exists", async () => {
    const got = await d.both("update before create", payer, [update()]);
    expect(got).not.toBe("ok");
  });

  it("refuses data that is not three Borsh Strings, before logging anything", async () => {
    const name = str("Stake Pool Token");
    const symbol = str("SPT");
    const uri = str("https://example.com/spt.json");
    const bad: [string, Buffer][] = [
      ["tag only", Buffer.alloc(0)],
      ["short name length", Buffer.from([1, 0])],
      ["name past the end", raw(Buffer.from("abc"), 4)],
      ["no symbol", name],
      ["no uri", Buffer.concat([name, symbol])],
      ["uri length short", Buffer.concat([name, symbol, Buffer.from([0, 0, 0])])],
      ["uri past the end", Buffer.concat([name, symbol, raw(Buffer.from("https://x"), 10)])],
      ["trailing byte", Buffer.concat([name, symbol, uri, u8(0)])],
      ["trailing string", Buffer.concat([name, symbol, uri, str("")])],
      // Not UTF-8 (str::from_utf8 refuses each): a stray continuation byte, overlong forms, a surrogate, past U+10FFFF,
      // bytes that never appear, a sequence cut short by the end of the string or by an ASCII byte.
      ["continuation byte", Buffer.concat([raw(Buffer.from([0x41, 0x80])), symbol, uri])],
      ["overlong C0 80", Buffer.concat([raw(Buffer.from([0xc0, 0x80])), symbol, uri])],
      ["overlong C1 BF", Buffer.concat([raw(Buffer.from([0xc1, 0xbf])), symbol, uri])],
      ["overlong E0 80 80", Buffer.concat([name, raw(Buffer.from([0xe0, 0x80, 0x80])), uri])],
      ["overlong E0 9F BF", Buffer.concat([name, raw(Buffer.from([0xe0, 0x9f, 0xbf])), uri])],
      ["overlong F0 8F BF BF", Buffer.concat([name, symbol, raw(Buffer.from([0xf0, 0x8f, 0xbf, 0xbf]))])],
      ["surrogate ED A0 80", Buffer.concat([name, symbol, raw(Buffer.from([0xed, 0xa0, 0x80]))])],
      ["surrogate ED BF BF", Buffer.concat([raw(Buffer.from([0xed, 0xbf, 0xbf])), symbol, uri])],
      ["past U+10FFFF F4 90 80 80", Buffer.concat([raw(Buffer.from([0xf4, 0x90, 0x80, 0x80])), symbol, uri])],
      ["F5", Buffer.concat([raw(Buffer.from([0xf5, 0x80, 0x80, 0x80])), symbol, uri])],
      ["FF", Buffer.concat([name, raw(Buffer.from([0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0xff])), uri])],
      ["cut at the end", Buffer.concat([raw(Buffer.from([0x61, 0xe2, 0x82])), symbol, uri])],
      ["cut by the next string", Buffer.concat([raw(Buffer.from([0xf0, 0x9f, 0x98])), raw(Buffer.from([0x80])), uri])],
      ["cut by ASCII", Buffer.concat([raw(Buffer.from([0xe2, 0x41, 0x82])), symbol, uri])],
      ["bad third byte", Buffer.concat([raw(Buffer.from([0xe2, 0x82, 0x41])), symbol, uri])],
      ["bad fourth byte", Buffer.concat([raw(Buffer.from([0xf0, 0x9f, 0x98, 0xc0])), symbol, uri])],
      ["non-ASCII after 8 ASCII", Buffer.concat([name, symbol, raw(Buffer.concat([Buffer.from("https://"), Buffer.from([0x80])]))])],
    ];
    for (const [label, args] of bad)
      for (const [tag, i] of [
        [17, create()],
        [18, update()],
      ] as const)
        expect(await d.both(`decode ${tag}: ${label}`, payer, [withData(i, Buffer.concat([u8(tag), args]))]), `${tag}: ${label}`).toBe(builtin("BorshIoError"));
  });

  it("runs out of heap where the original does, for a length past the end of the data", async () => {
    // Borsh allocates min(length, 1 MiB) bytes before reading a String. The heap the entrypoint leaves (DECODE_HEAP in
    // metadata.ts) is 32686 bytes less 48 per account and 72 per distinct account, less the Strings before.
    const create8 = 32686 - 120 * 8;
    const update5 = 32686 - 120 * 5;
    const abc = raw(Buffer.from("abc"));
    const cases: [string, Instruction, Buffer, string][] = [
      ["create: name at the limit", create(), raw(Buffer.from("abc"), create8), builtin("BorshIoError")],
      ["create: name past the limit", create(), raw(Buffer.from("abc"), create8 + 1), builtin("ProgramFailedToComplete")],
      ["create: name u32 max", create(), raw(Buffer.from("abc"), 0xffffffff), builtin("ProgramFailedToComplete")],
      ["create: symbol at the limit", create(), Buffer.concat([abc, raw(Buffer.from("x"), create8 - 3)]), builtin("BorshIoError")],
      ["create: symbol past the limit", create(), Buffer.concat([abc, raw(Buffer.from("x"), create8 - 2)]), builtin("ProgramFailedToComplete")],
      ["create: uri at the limit", create(), Buffer.concat([abc, raw(Buffer.from("12345")), raw(Buffer.alloc(0), create8 - 8)]), builtin("BorshIoError")],
      [
        "create: uri past the limit",
        create(),
        Buffer.concat([abc, raw(Buffer.from("12345")), raw(Buffer.alloc(0), create8 - 7)]),
        builtin("ProgramFailedToComplete"),
      ],
      ["update: name at the limit", update(), raw(Buffer.alloc(0), update5), builtin("BorshIoError")],
      ["update: name past the limit", update(), raw(Buffer.alloc(0), update5 + 1), builtin("ProgramFailedToComplete")],
      // A duplicate account shares its first's lamports and data cells: 72 bytes more.
      ["update: duplicates at the limit", replace(update(), 4, p.pool), raw(Buffer.alloc(0), update5 + 72), builtin("BorshIoError")],
      ["update: duplicates past the limit", replace(update(), 4, p.pool), raw(Buffer.alloc(0), update5 + 73), builtin("ProgramFailedToComplete")],
      ["update: no accounts", accounts(update(), (l) => l.splice(0)), raw(Buffer.alloc(0), 32687), builtin("ProgramFailedToComplete")],
    ];
    for (const [label, i, args, want] of cases) {
      const sent = withData(i, Buffer.concat([u8(label.startsWith("create") ? 17 : 18), args]));
      expect(await d.both(label, payer, [sent]), label).toBe(want);
      // Out of memory: the allocator's line, then Rust's abort, which names no location.
      if (want !== builtin("BorshIoError"))
        expect(
          d.lastLogs
            .split("\n")
            .filter((l) => !/ consumed \d+ of \d+ compute units$/.test(l))
            .slice(-2),
          label,
        ).toEqual(["Program log: Error: memory allocation failed, out of memory", `Program ${PROGRAM} failed: SBF program panicked`]);
    }
  });

  it("decodes random byte strings as the original does", async () => {
    // Bytes drawn around UTF-8's edges (ASCII, continuation bytes, every lead byte, encodings of code points near the
    // surrogates and U+10FFFF), in one of the three Strings. With the metadata account of another mint, data that
    // decodes ends in InvalidMetadataAccount after the instruction's line; the rest is BorshIoError before it.
    let seed = 0x5eed1234;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
    const points = [0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xfffd, 0xffff, 0x10000, 0x10ffff, 0x1f600];
    const piece = (): number[] => {
      const r = next();
      if (r < 0.3) return [Math.floor(next() * 0x80)];
      if (r < 0.45) return [0x80 + Math.floor(next() * 0x40)];
      if (r < 0.65) return [0xc0 + Math.floor(next() * 0x40)];
      if (r < 0.9) return [...Buffer.from(String.fromCodePoint(pick(points)), "utf8")];
      // A surrogate or a code point past U+10FFFF, encoded as UTF-8 would if it allowed them.
      const c = pick([0xd800, 0xdbff, 0xdc00, 0xdfff, 0x110000, 0x13ffff]);
      return c < 0x10000
        ? [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)]
        : [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)];
    };
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    const valid = (b: Buffer) => {
      try {
        utf8.decode(b);
        return true;
      } catch {
        return false;
      }
    };
    const other = await metadataAddress(p.reserve);
    let decoded = 0;
    for (let k = 0; k < 160; k++) {
      const bytes: number[] = [];
      const pieces = 1 + Math.floor(next() * 4);
      for (let j = 0; j < pieces; j++) bytes.push(...piece());
      // Long ASCII runs around the bytes, for the eight-at-a-time path.
      const b = Buffer.concat([Buffer.alloc(Math.floor(next() * 12), 0x61), Buffer.from(bytes), Buffer.alloc(Math.floor(next() * 12), 0x62)]);
      const strings = [str("Pool"), str("POOL"), str("https://example.com/p.json")];
      strings[k % 3] = raw(b);
      const tag = k % 2 === 0 ? 17 : 18;
      const i = tag === 17 ? replace(create(), 5, other) : replace(update(), 3, other);
      const want = valid(b) ? custom(E.InvalidMetadataAccount) : builtin("BorshIoError");
      if (valid(b)) decoded++;
      expect(await d.both(`decode ${tag}: random ${k} (${b.toString("hex")})`, payer, [withData(i, Buffer.concat([u8(tag), ...strings]))])).toBe(want);
    }
    // Both kinds are well represented.
    expect(decoded).toBeGreaterThan(30);
    expect(decoded).toBeLessThan(130);
  });

  it("counts accounts and checks them in the original's order", async () => {
    const c = create();
    const n = (i: Instruction, k: number) => truncate(i, k);
    expect(await d.both("create: 7 accounts", payer, [n(c, 7)])).toBe(builtin("NotEnoughAccountKeys"));
    expect(await d.both("update: 4 accounts", payer, [n(update(), 4)])).toBe(builtin("NotEnoughAccountKeys"));
    // Create: payer signature, System program, the payer's owner, the pool's owner, Metaplex, then the pool.
    expect(await d.both("create: payer not signing", payer, [role(c, 4, AccountRole.WRITABLE)])).toBe(custom(E.SignatureMissing));
    expect(await d.both("create: wrong system program", payer, [replace(c, 7, TOKEN)])).toBe(builtin("IncorrectProgramId"));
    const owned = await d.funded(10n);
    d.write(owned.address, TOKEN, Buffer.alloc(0), 10_000_000_000n);
    expect(await d.both("create: payer not a wallet", payer, [ix.createTokenMetadata(p, p.manager, owned, md, "a", "b", "c")])).toBe(
      builtin("IncorrectProgramId"),
    );
    const foreign = await d.allocated(payer, STAKE_POOL_SIZE, SYSTEM);
    const blank = await d.allocated(payer, STAKE_POOL_SIZE, PROGRAM);
    const short = await d.allocated(payer, 100n, PROGRAM);
    for (const [label, at, want] of [
      ["foreign", foreign, builtin("IncorrectProgramId")],
      ["uninitialized", blank, custom(E.InvalidState)],
      ["too short", short, builtin("BorshIoError")],
    ] as const) {
      expect(await d.both(`create: ${label} pool`, payer, [replace(c, 0, at)])).toBe(want);
      expect(await d.both(`update: ${label} pool`, payer, [replace(update(), 0, at)])).toBe(want);
    }
    expect(await d.both("create: wrong metadata program", payer, [replace(c, 6, TOKEN)])).toBe(builtin("IncorrectProgramId"));
    expect(await d.both("update: wrong metadata program", payer, [replace(update(), 4, SYSTEM)])).toBe(builtin("IncorrectProgramId"));
    // The pool's checks: manager (key, then signature), withdraw authority, mint (create), metadata address.
    const other = await d.funded(1n);
    for (const [tag, i] of [
      ["create", c],
      ["update", update()],
    ] as const) {
      expect(await d.both(`${tag}: wrong manager`, payer, [replace(i, 1, other.address)])).toBe(custom(E.WrongManager));
      expect(await d.both(`${tag}: manager not signing`, payer, [role(i, 1, AccountRole.READONLY)])).toBe(custom(E.SignatureMissing));
      expect(await d.both(`${tag}: wrong withdraw authority`, payer, [replace(i, 2, p.deposit)])).toBe(custom(E.InvalidProgramAddress));
      expect(await d.both(`${tag}: metadata of another mint`, payer, [replace(i, tag === "create" ? 5 : 3, await metadataAddress(p.reserve))])).toBe(
        custom(E.InvalidMetadataAccount),
      );
    }
    expect(await d.both("create: wrong mint", payer, [replace(c, 3, p.managerFee)])).toBe(custom(E.WrongPoolMint));
    // The metadata account must be writable for Metaplex: the CPI fails the same way in both.
    expect(await d.both("create: metadata read-only", payer, [role(c, 5, AccountRole.READONLY)])).not.toBe("ok");
  });

  it("creates the metadata, signed by the withdraw authority", async () => {
    await d.ok("create metadata", payer, [create()]);
    const acct = d.original.getAccount(md);
    expect(acct.exists && acct.programAddress).toBe(MPL_METADATA);
    // Once it exists, a second create fails in Metaplex.
    expect(await d.both("create metadata again", payer, [create("Again", "AGN", "https://example.com/again.json")])).not.toBe("ok");
  });

  it("updates it with any strings Metaplex takes", async () => {
    await d.ok("update metadata", payer, [update()]);
    await d.ok("update metadata: empty", payer, [update("", "", "")]);
    await d.ok("update metadata: unicode", payer, [update("Ŝtake ✓ 🥩", "€Ω", "https://例え.jp/ü.json")]);
    // Metaplex's limits: name 32 bytes, symbol 10, uri 200.
    await d.ok("update metadata: longest", payer, [update("n".repeat(32), "s".repeat(10), "u".repeat(200))]);
    expect(await d.both("update metadata: name too long", payer, [update("n".repeat(33))])).not.toBe("ok");
    expect(await d.both("update metadata: symbol too long", payer, [update("Staked SOL", "s".repeat(11))])).not.toBe("ok");
    expect(await d.both("update metadata: uri too long", payer, [update("Staked SOL", "stSOL", `https://${"u".repeat(193)}`)])).not.toBe("ok");
    // Far longer than Metaplex takes: the whole data is still decoded and passed on.
    expect(await d.both("update metadata: 700-byte uri", payer, [update("Staked SOL", "stSOL", "€".repeat(233))])).not.toBe("ok");
    // About the most data a transaction (1232 bytes) can carry with these accounts.
    expect(await d.both("update metadata: 1000-byte name", payer, [update("n".repeat(1000), "", "")])).not.toBe("ok");
    await d.ok("update metadata: again", payer, [update("Staked SOL 2", "stSOL2", "https://example.com/2.json")]);
  });

  it("passes a Token-2022 pool mint on to Metaplex, which refuses it", async () => {
    // The original takes any pool mint (check_mint unpacks Token-2022 ones too). This Token Metadata build refuses
    // CreateMetadataAccountV3 for a Token-2022 mint ("Instruction not supported for ProgrammableNonFungible assets",
    // 0x99), the same in both.
    const q = await d.createPool(payer, { tokenProgram: TOKEN_2022, label: "initialize (Token-2022, metadata)" });
    const at = await metadataAddress(q.mint);
    expect(await d.both("create metadata (Token-2022)", payer, [create("Token-2022 Pool", "T22", "https://example.com/t22.json", q, at)])).toBe(
      "error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: 153 } }",
    );
    expect(await d.both("update metadata (Token-2022, none yet)", payer, [update("Token-2022 Pool", "T22", "https://example.com/t22.json", q, at)])).not.toBe(
      "ok",
    );
  });

  it("takes the manager as the payer", async () => {
    const q = await d.createPool(payer, { label: "initialize (metadata, manager pays)" });
    const at = await metadataAddress(q.mint);
    await d.ok("create metadata (manager pays)", payer, [ix.createTokenMetadata(q, q.manager, q.manager, at, "Pool", "POOL", "https://example.com/p.json")]);
    await d.ok("update metadata (manager pays)", payer, [ix.updateTokenMetadata(q, q.manager, at, "Pool 2", "POOL2", "https://example.com/p2.json")]);
  });
});

/** The compute units Metaplex (and the System program under it) used in a transaction's logs: the same in both. */
function metaplexUnits(logs: string): bigint {
  const m = new RegExp(`Program ${MPL_METADATA} consumed (\\d+) of`).exec(logs);
  return m ? BigInt(m[1]!) : 0n;
}

describe.skipIf(!existsSync(MPL_METADATA_SO))("compute units", () => {
  it("reports compute units", () => {
    const all: Record<string, [bigint, bigint]> = {};
    let compared = 0;
    for (const d of diffs) {
      Object.assign(all, d.cu);
      compared += d.compared;
    }
    const rows: [string, string][] = [
      ["create metadata", "create metadata"],
      ["create (manager pays)", "create metadata (manager pays)"],
      ["update metadata", "update metadata"],
      ["update (empty)", "update metadata: empty"],
      ["update (unicode)", "update metadata: unicode"],
      ["update (Metaplex maximum)", "update metadata: longest"],
      ["create (Token-2022, refused)", "create metadata (Token-2022)"],
    ];
    console.log(`${"".padEnd(29)} ${"total".padStart(17)}         ${"without Metaplex".padStart(22)}`);
    for (const [name, label] of rows) {
      const got = all[label];
      expect(got, label).toBeDefined();
      const [a, b] = got!;
      const inner = cpiUnits[label] ?? 0n;
      const [ownA, ownB] = [a - inner, b - inner];
      const pct = (x: bigint, y: bigint) => `${((Number(y) / Number(x)) * 100).toFixed(0)}%`.padStart(4);
      console.log(
        `${name.padEnd(29)} ${String(a).padStart(7)} ${String(b).padStart(7)} ${pct(a, b)}   ${String(ownA).padStart(7)} ${String(ownB).padStart(7)} ${pct(ownA, ownB)}`,
      );
      expect(b, `${name}: TypeSOL ${b} vs original ${a}`).toBeLessThan(a);
      expect(ownB, `${name}: TypeSOL ${ownB} vs original ${ownA} without Metaplex`).toBeLessThan(ownA);
    }
    console.log(`${compared} transactions compared`);
    expect(compared).toBeGreaterThan(100);
  });
});
