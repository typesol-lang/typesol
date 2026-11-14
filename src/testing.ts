/**
 * `typesol/testing`: test a project's program in LiteSVM (an in-process Solana runtime) without the boilerplate.
 *
 *   const t = await testProgram("counter", import.meta.url);
 *   const alice = await t.wallet();
 *   const counter = await t.pda("counter", alice);
 *   t.ok(await t.send(alice, t.ix("initialize", {}, { authority: alice, counter })));
 *   t.ok(await t.send(alice, t.ix("increment", { by: 5n }, { authority: alice, counter })));
 *   expect((await t.account("Counter", counter))?.count).toBe(5n);
 *
 * Accounts are passed by name; their signer / writable flags and fixed addresses (system program, token programs…)
 * come from the IDL, as Anchor's `.accounts({...})` does, and PDAs seeded by constants, arguments or other accounts'
 * keys are derived when left out. Arguments take plain values: bigints or numbers for
 * integers, address strings for Pubkeys, null for an empty Option. Decoded accounts and return data come back the
 * same way (bigints, address strings), and so do the events of a transaction (`t.events(res)`).
 *
 * Needs `litesvm`, which `typesol init` projects have. Instruction data, accounts and return data are encoded and
 * decoded from the IDL by TypeSOL's own Borsh coder (src/idl-coder.ts), events too.
 */
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  isAddress,
  isOffCurveAddress,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IdlCoder } from "./idl-coder.js";
import { TYPESOL_ERRORS } from "./tools/clientgen.js";
import { loadClonedAccounts } from "./tools/clone.js";
import { type SvmConnection, svmConnection } from "./tools/svmrpc.js";
import { buildForTest, findWorkspace } from "./workspace.js";

export { type SvmConnection, svmConnection };
export * from "./testing-stake.js";
/** Load what `typesol clone` wrote (a directory of `<address>.json` accounts and `<address>.so` programs) into a LiteSVM. */
export { loadClonedAccounts };

/** An Anchor IDL (spec 0.1.0), as `typesol build` writes it and Anchor's `Idl` type describes it. */
export interface TestIdl {
  address: string;
  metadata?: unknown;
  instructions: readonly {
    name: string;
    discriminator: readonly number[];
    accounts: readonly unknown[];
    args: readonly { name: string; type: unknown }[];
    returns?: unknown;
  }[];
  accounts?: readonly { name: string; discriminator: readonly number[] }[];
  events?: readonly { name: string; discriminator: readonly number[] }[];
  errors?: readonly { code: number; name: string; msg?: string }[];
  types?: readonly unknown[];
  constants?: readonly unknown[];
}

/**
 * Anchor's `BorshCoder` for the program's IDL (`instruction`, `accounts`, `events`, `types`), which works with BN and
 * PublicKey values. `@anchor-lang/core` is loaded the first time `t.coder` is read: install it to use `t.coder`.
 * The other helpers do not need it.
 */
export interface AnchorBorshCoder {
  instruction: any;
  accounts: any;
  events: any;
  types: any;
}

/** `new BorshCoder(idl)` from `@anchor-lang/core`, found next to typesol or in the project being tested. */
function anchorCoder(idl: TestIdl): AnchorBorshCoder {
  for (const from of [import.meta.url, path.join(process.cwd(), "package.json")]) {
    let anchor: { BorshCoder: new (idl: unknown) => AnchorBorshCoder };
    try {
      // CommonJS: loaded with require, as Node cannot import its classes by name from an ES module.
      anchor = createRequire(from)("@anchor-lang/core");
    } catch {
      continue;
    }
    return new anchor.BorshCoder(idl);
  }
  throw new Error("t.coder is Anchor's BorshCoder: install @anchor-lang/core (npm install -D @anchor-lang/core) to use it");
}

export type Result = TransactionMetadata | FailedTransactionMetadata;
/** An account for an instruction: an address, a keypair (which then signs), or null to leave an optional one out. */
export type AccountInput = Address | KeyPairSigner | null;
/**
 * A PDA seed: text, an address (or keypair), raw bytes, or a bigint as a little-endian u64. A string that is a valid
 * address is taken as one; pass `new TextEncoder().encode(s)` for text that happens to look like an address.
 */
export type SeedInput = string | Address | KeyPairSigner | Uint8Array | bigint;

type IdlType = string | { option: IdlType } | { vec: IdlType } | { array: [IdlType, number] } | { defined: { name: string } };
type IdlSeed = { kind: "const"; value: number[] } | { kind: "arg"; path: string } | { kind: "account"; path: string };
interface IdlAccountItem {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
  pda?: { seeds: IdlSeed[]; program?: IdlSeed };
  /** An account group (Anchor's composite accounts): its fields. */
  accounts?: IdlAccountItem[];
}

/**
 * An instruction's accounts with groups flattened as the generated client does: `pool.vault` becomes `pool_vault`
 * (`poolVault` in `t.ix`), and a seed naming a field of the same group names its flattened account.
 */
function flattenAccounts(items: IdlAccountItem[], prefix = ""): IdlAccountItem[] {
  const out: IdlAccountItem[] = [];
  for (const it of items) {
    if (it.accounts) {
      const group = `${prefix}${it.name}_`;
      const fields = new Set(it.accounts.filter((f) => !f.accounts).map((f) => f.name));
      const local = (sd: IdlSeed): IdlSeed => (sd.kind === "account" && fields.has(sd.path.split(".")[0]!) ? { ...sd, path: `${group}${sd.path}` } : sd);
      for (const f of flattenAccounts(it.accounts, group))
        out.push(f.pda ? { ...f, pda: { seeds: f.pda.seeds.map(local), ...(f.pda.program ? { program: local(f.pda.program) } : {}) } } : f);
      continue;
    }
    out.push({ ...it, name: `${prefix}${it.name}` });
  }
  return out;
}
interface ProgramIdl {
  address: string;
  instructions: { name: string; accounts: IdlAccountItem[]; args: { name: string; type: IdlType }[]; returns?: IdlType }[];
  types?: { name: string; type: { kind: string; fields?: { name: string; type: IdlType }[] } }[];
  errors?: { code: number; name: string }[];
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const isSigner = (v: unknown): v is KeyPairSigner => typeof v === "object" && v !== null && "address" in v && "signTransactions" in v;

export interface TestProgram {
  svm: LiteSVM;
  programId: Address;
  idl: TestIdl;
  /** Anchor's BorshCoder for this IDL; needs `@anchor-lang/core` installed (loaded on first use). */
  readonly coder: AnchorBorshCoder;
  /** A new keypair funded with `sol` SOL (default 10). */
  wallet(sol?: number): Promise<KeyPairSigner>;
  /** The program's PDA for these seeds. */
  pda(...seeds: SeedInput[]): Promise<Address>;
  /** The PDA and its bump. */
  pdaWithBump(...seeds: SeedInput[]): Promise<[Address, number]>;
  /** An instruction of this program, accounts by name (`authority` or `authority`'s snake_case), args as plain values. */
  ix(
    name: string,
    args?: Record<string, unknown>,
    accounts?: Record<string, AccountInput>,
    remaining?: { address: Address; writable?: boolean; signer?: KeyPairSigner }[],
  ): Instruction;
  /** Send instructions in one transaction paid by `payer` (keypairs passed as accounts sign too). */
  send(payer: KeyPairSigner, ...ixs: Instruction[]): Promise<Result>;
  /** The successful result, or a thrown error with the program's logs. */
  ok(res: Result): TransactionMetadata;
  /** The custom error code of a failed transaction (6000+ for the program's error enums); throws if it succeeded. */
  errorCode(res: Result): number;
  /** An account of this program decoded by its IDL type, or null when it does not exist. */
  account<T = Record<string, unknown>>(type: string, address: Address): Promise<T | null>;
  /** A successful instruction's return data, decoded by its IDL `returns` type. */
  returned<T = unknown>(instruction: string, res: Result): T;
  /**
   * The events a successful transaction emitted, decoded by the IDL, in the order the program emitted them: `emit`'s
   * `Program data:` log lines while this program runs, and `emitCpi`'s self-CPIs. Values as `account` gives them.
   */
  events<T = Record<string, unknown>>(res: Result): { name: string; data: T }[];
  /** Lamports of any account (0 when it does not exist). */
  balance(address: Address): bigint;
  /** A kit RPC and subscriptions pair over this LiteSVM, for the generated client (`svmConnection`). */
  connection: SvmConnection;
  /** The name of an error code: the program's own (6000+), TypeSOL's or Anchor's; undefined for others. */
  errorName(code: number): string | undefined;
  /**
   * A mint written straight into the VM (as System CreateAccount + InitializeMint2 would leave it). SPL Token unless
   * `tokenProgram` is Token-2022; no extensions.
   */
  mint(opts: {
    authority: Address;
    decimals?: number;
    supply?: bigint;
    freezeAuthority?: Address;
    tokenProgram?: Address;
    address?: Address;
  }): Promise<Address>;
  /** A token account of `owner` for `mint` holding `amount`, written straight into the VM (at `address`, e.g. an ATA). */
  tokenAccount(opts: { mint: Address; owner: Address; amount?: bigint; tokenProgram?: Address; address?: Address }): Promise<Address>;
  /** The amount a token account holds, or null when it does not exist. */
  tokenBalance(address: Address): bigint | null;
  /** Move the Clock: to a unix timestamp and/or a slot, or forward by `seconds`. */
  warp(to: { unixTimestamp?: bigint; slot?: bigint; seconds?: bigint }): void;
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
/** The first 8 bytes of Anchor's event instruction (sha256("anchor:event")[..8]), which `emitCpi` sends to the program. */
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** Build `program` of the project around `from` (a file URL such as import.meta.url, or a directory) and load it. */
export async function testProgram(program: string, from: string | URL): Promise<TestProgram> {
  const start = typeof from === "string" && !from.startsWith("file:") ? from : path.dirname(fileURLToPath(from));
  const ws = findWorkspace(start);
  if (!ws) throw new Error(`no typesol.json at or above ${start}`);
  if (!ws.programs[program]) throw new Error(`typesol.json has no program "${program}" (it has ${Object.keys(ws.programs).join(", ")})`);
  // Every test file calls this, often in parallel workers: an up-to-date build is reused, and concurrent builds of the
  // same program wait for each other instead of writing over each other's files.
  const built = buildForTest(ws, program);
  const svm = new LiteSVM();
  const programId = built.address as Address;
  svm.addProgramFromFile(programId, built.soPath);
  // Accounts and programs `typesol clone` copied from a cluster (tests/accounts), in place before the first test.
  loadClonedAccounts(svm as never, ws.accounts);
  return programHarness(svm, programId, built.idl as unknown as TestIdl);
}

/** The same helpers for a program already loaded into `svm` at `programId` with this IDL. */
export function programHarness(svm: LiteSVM, programId: Address, idl: TestIdl): TestProgram {
  // Strict: an argument or field left out (other than an Option) or misspelt is an error, not zeros or None.
  const coder = new IdlCoder(idl, { strict: true });
  let anchor: AnchorBorshCoder | undefined;
  const source = idl as unknown as ProgramIdl;
  const pidl: ProgramIdl = { ...source, instructions: source.instructions.map((ix) => ({ ...ix, accounts: flattenAccounts(ix.accounts) })) };
  const types = new Map((pidl.types ?? []).map((t) => [t.name, t]));
  const enc = getAddressEncoder();

  const isOption = (type: IdlType) => typeof type === "object" && "option" in type;
  /** The value of `name` in `o`, by its IDL name or its camelCase spelling. */
  const valueOf = (o: Record<string, unknown>, name: string) => (Object.prototype.hasOwnProperty.call(o, name) ? o[name] : o[camel(name)]);
  /**
   * A struct's or data variant's fields from a plain object, converted: each field by its IDL name or camelCase. A key
   * that names no field, and a field left out that is not an Option, are errors naming them.
   */
  const fieldsToCoder = (o: Record<string, unknown>, fields: { name: string; type: IdlType }[], where: string, owner: string) => {
    const names = fields.map((f) => camel(f.name)).join(", ");
    for (const k of Object.keys(o))
      if (!fields.some((f) => f.name === k || camel(f.name) === k)) throw new Error(`${where} has no field "${k}" (${owner} has ${names || "no fields"})`);
    return Object.fromEntries(
      fields.map((f) => {
        const x = valueOf(o, f.name);
        if (x === undefined && !isOption(f.type))
          throw new Error(`${where}.${camel(f.name)} is missing (${owner} has ${names}; only an Option may be left out)`);
        return [f.name, toCoder(x, f.type, `${where}.${camel(f.name)}`)];
      }),
    );
  };
  /** A plain value → what the coder expects for `type` (integers of 64 bits and more it parses itself). */
  const toCoder = (v: unknown, type: IdlType, where: string): unknown => {
    if (typeof type === "string") {
      if (v === null || v === undefined) throw new Error(`${where} is ${String(v)}, but it is a ${type}, not an Option`);
      if (/^[ui](8|16|32)$/.test(type)) return Number(v);
      if (type === "pubkey") {
        const a = isSigner(v) ? v.address : (v as string);
        if (typeof a !== "string" || !isAddress(a)) throw new Error(`${where}: expected an address`);
        return a;
      }
      return v;
    }
    if ("option" in type) return v === null || v === undefined ? null : toCoder(v, type.option, where);
    if ("vec" in type) return (v as unknown[]).map((x, i) => toCoder(x, type.vec, `${where}[${i}]`));
    if ("array" in type) return (v as unknown[]).map((x, i) => toCoder(x, type.array[0], `${where}[${i}]`));
    const def = types.get(type.defined.name);
    const named = (fields: unknown[] | undefined) =>
      !!fields?.length && fields.every((f) => typeof f === "object" && f !== null && (f as { name?: unknown }).name && (f as { type?: unknown }).type);
    if (def?.type.kind === "struct" && named(def.type.fields) && typeof v === "object" && v !== null && !Array.isArray(v))
      return fieldsToCoder(v as Record<string, unknown>, def.type.fields!, where, def.name);
    const variants = (def?.type as { variants?: { name: string; fields?: unknown[] }[] } | undefined)?.variants;
    const variantOf = (key: unknown) => variants?.find((x) => x.name === key || camel(x.name) === key || x.name.toLowerCase() === String(key).toLowerCase());
    // A unit enum as its index or variant name, as well as Anchor's { Variant: {} }.
    const unitObject = typeof v === "object" && v !== null && Object.keys(v).length === 1 && !Object.values(v)[0];
    const emptyObject = typeof v === "object" && v !== null && Object.keys(v).length === 1 && Object.keys(Object.values(v)[0] as object).length === 0;
    if (def?.type.kind === "enum" && variants && (typeof v === "number" || typeof v === "bigint" || typeof v === "string" || unitObject || emptyObject)) {
      const key = typeof v === "object" ? Object.keys(v as object)[0] : v;
      const same = (x: { name: string }) => x.name === key || camel(x.name) === key || x.name.toLowerCase() === String(key).toLowerCase();
      const i = typeof key === "string" ? variants.findIndex(same) : Number(key);
      const variant = variants[i];
      if (!variant) throw new Error(`${where}: ${String(v)} is not a variant of ${type.defined.name}`);
      // A variant that has fields, named without them: an error naming the first, as for a struct.
      if (named(variant.fields))
        return { [variant.name]: fieldsToCoder({}, variant.fields as { name: string; type: IdlType }[], `${where}.${variant.name}`, variant.name) };
      return { [variant.name]: {} };
    }
    // A variant with fields, { Variant: { field: value } }: its fields converted like a struct's.
    if (def?.type.kind === "enum" && variants && typeof v === "object" && v !== null && Object.keys(v).length === 1) {
      const [key, body] = Object.entries(v as Record<string, unknown>)[0]!;
      const variant = variantOf(key);
      if (!variant) throw new Error(`${where}: ${key} is not a variant of ${type.defined.name}`);
      if (named(variant.fields) && typeof body === "object" && body !== null && !Array.isArray(body))
        return {
          [variant.name]: fieldsToCoder(
            body as Record<string, unknown>,
            variant.fields as { name: string; type: IdlType }[],
            `${where}.${variant.name}`,
            variant.name,
          ),
        };
      return { [variant.name]: body };
    }
    return v;
  };

  /** What the coder decodes (bigints, address strings) with TypeSOL's fixed-layout Options and strings unwrapped. */
  const plain = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(plain);
    if (v instanceof Uint8Array) return v;
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).sort().join(",");
      // Account data keeps Options and FixedStrings in a fixed layout; give them back as the plain value / string.
      if (keys === "is_some,value") return o.is_some ? plain(o.value) : null;
      if (keys === "bytes,len" && Array.isArray(o.bytes)) return Buffer.from((o.bytes as number[]).slice(0, Number(o.len))).toString("utf8");
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x)]));
    }
    return v;
  };

  /** find_program_address, synchronously (sha256 + the curve check), so ix() can fill PDAs in. */
  const findPda = (seeds: Uint8Array[], program: Address): Address => {
    for (let bump = 255; bump >= 0; bump--) {
      const h = createHash("sha256");
      for (const s of seeds) h.update(s);
      h.update(Uint8Array.of(bump));
      h.update(new Uint8Array(enc.encode(program)));
      h.update("ProgramDerivedAddress");
      const a = getAddressDecoder().decode(h.digest());
      if (isOffCurveAddress(a)) return a;
    }
    throw new Error("no off-curve bump for these seeds");
  };

  /** An argument's bytes as a seed: little-endian integers at their width, bool as one byte, Pubkey, UTF-8 text. */
  const argSeed = (v: unknown, type: IdlType): Uint8Array | undefined => {
    if (typeof type !== "string" || v === undefined || v === null) return undefined;
    const int = /^([ui])(8|16|32|64|128)$/.exec(type);
    if (int) {
      const bytes = Number(int[2]) / 8;
      let n = BigInt.asUintN(bytes * 8, BigInt(v as bigint | number));
      const out = new Uint8Array(bytes);
      for (let i = 0; i < bytes; i++, n >>= 8n) out[i] = Number(n & 0xffn);
      return out;
    }
    if (type === "bool") return Uint8Array.of(v ? 1 : 0);
    if (type === "pubkey") return new Uint8Array(enc.encode((isSigner(v) ? v.address : v) as Address));
    if (type === "string") return new TextEncoder().encode(v as string);
    return undefined;
  };
  /** A unit-enum argument as a seed: one byte, its variant index (given as the index or as Anchor's { Variant: {} }). */
  const enumSeed = (v: unknown, type: IdlType): Uint8Array | undefined => {
    if (typeof type !== "object" || !("defined" in type) || v === undefined || v === null) return undefined;
    const def = types.get(type.defined.name) as { type: { kind: string; variants?: { name: string; fields?: unknown[] }[] } } | undefined;
    const variants = def?.type.kind === "enum" ? def.type.variants : undefined;
    if (!variants || variants.some((x) => x.fields?.length)) return undefined;
    if (typeof v === "number" || typeof v === "bigint") return Uint8Array.of(Number(v));
    const name = typeof v === "object" ? Object.keys(v as object)[0] : String(v);
    const i = variants.findIndex((x) => x.name === name || camel(x.name) === name || x.name.toLowerCase() === String(name).toLowerCase());
    return i < 0 ? undefined : Uint8Array.of(i);
  };

  const seedBytes = (s: SeedInput): Uint8Array => {
    if (s instanceof Uint8Array) return s;
    if (typeof s === "bigint") {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, s, true);
      return b;
    }
    if (isSigner(s)) return new Uint8Array(enc.encode(s.address));
    if (isAddress(s)) return new Uint8Array(enc.encode(s));
    return new TextEncoder().encode(s);
  };

  const harness: TestProgram = {
    svm,
    programId,
    idl,
    get coder() {
      return (anchor ??= anchorCoder(idl));
    },
    async wallet(sol = 10) {
      const k = await generateKeyPairSigner();
      svm.airdrop(k.address, lamports(BigInt(Math.round(sol * 1e9))));
      return k;
    },
    async pda(...seeds) {
      return (await harness.pdaWithBump(...seeds))[0];
    },
    async pdaWithBump(...seeds) {
      const [a, bump] = await getProgramDerivedAddress({ programAddress: programId, seeds: seeds.map(seedBytes) });
      return [a, bump];
    },
    ix(name, args = {}, accounts = {}, remaining = []) {
      const def = pidl.instructions.find((i) => i.name === name || i.name === snake(name));
      if (!def) throw new Error(`the program has no instruction "${name}" (it has ${pidl.instructions.map((i) => i.name).join(", ")})`);
      const given = new Map(Object.entries(accounts).map(([k, v]) => [snake(k), v]));
      for (const k of given.keys()) if (!def.accounts.some((a) => a.name === k)) throw new Error(`${def.name} has no account "${k}"`);
      const argsIn = args as Record<string, unknown>;
      // PDAs whose seeds are constants, arguments or other accounts' keys are filled in, as the generated client does.
      const addressOf = (name: string): Address | undefined => {
        const v = given.get(name);
        if (v === undefined || v === null) return def.accounts.find((x) => x.name === name)?.address as Address | undefined; // fixed in the IDL
        return isSigner(v) ? v.address : v;
      };
      for (let progress = true; progress;) {
        progress = false;
        for (const a of def.accounts) {
          if (given.has(a.name) || !a.pda || a.address) continue;
          const seed = (s: IdlSeed): Uint8Array | undefined => {
            if (s.kind === "const") return Uint8Array.from(s.value);
            if (s.kind === "account") {
              const at = s.path.includes(".") ? undefined : addressOf(s.path);
              return at && new Uint8Array(enc.encode(at));
            }
            // `opt.unwrap_or(7)`: an Option argument, or 7 when it is None (Anchor's text for such a seed).
            const fallback = /^(.*)\.unwrap_or\((-?\d+)\)$/.exec(s.path);
            if (fallback) {
              const arg = def.args.find((x) => x.name === fallback[1]);
              const inner = arg && typeof arg.type === "object" && "option" in arg.type ? (arg.type.option as IdlType) : undefined;
              const value = arg && (argsIn[arg.name] ?? argsIn[camel(arg.name)]);
              return inner === undefined ? undefined : argSeed(value === undefined || value === null ? BigInt(fallback[2]!) : value, inner);
            }
            const arg = def.args.find((x) => x.name === s.path);
            const value = arg && (argsIn[arg.name] ?? argsIn[camel(arg.name)]);
            return arg && (argSeed(value, arg.type) ?? enumSeed(value, arg.type));
          };
          const seeds = a.pda.seeds.map(seed);
          const program = a.pda.program ? seed(a.pda.program) : new Uint8Array(enc.encode(programId));
          if (seeds.some((x) => x === undefined) || !program || program.length !== 32) continue;
          given.set(a.name, findPda(seeds as Uint8Array[], getAddressDecoder().decode(program)));
          progress = true;
        }
      }
      const metas = def.accounts.map((a) => {
        let v = given.has(a.name) ? given.get(a.name)! : undefined;
        if (v === undefined && a.address) v = a.address as Address;
        if (v === undefined || v === null) {
          if (!a.optional) throw new Error(`${def.name}: account "${camel(a.name)}" is required`);
          return { address: programId, role: AccountRole.READONLY }; // left out: the program's own id stands in
        }
        if (a.signer && !isSigner(v)) throw new Error(`${def.name}: account "${camel(a.name)}" signs; pass its keypair, not its address`);
        const address = isSigner(v) ? v.address : v;
        const role = a.signer
          ? a.writable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
          : a.writable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY;
        return { address, role, ...(isSigner(v) && a.signer ? { signer: v } : {}) };
      });
      for (const r of remaining)
        metas.push({
          address: r.address,
          role: r.signer ? (r.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : r.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
          ...(r.signer ? { signer: r.signer } : {}),
        });
      const a = args as Record<string, unknown>;
      // Every key names an argument, and every argument but an Option is given: a misspelt one is not sent as zeros.
      const takes = def.args.length ? `it takes ${def.args.map((x) => camel(x.name)).join(", ")}` : "it takes no arguments";
      for (const k of Object.keys(a))
        if (!def.args.some((x) => x.name === k || camel(x.name) === k)) throw new Error(`${def.name} has no argument "${k}" (${takes})`);
      const encoded = Object.fromEntries(
        def.args.map((x) => {
          const v = valueOf(a, x.name);
          if (v === undefined && !isOption(x.type))
            throw new Error(`${def.name}: argument "${camel(x.name)}" is missing (${takes}; only an Option may be left out)`);
          return [x.name, toCoder(v, x.type, `${def.name}(${camel(x.name)})`)];
        }),
      );
      return { programAddress: programId, accounts: metas, data: new Uint8Array(coder.encodeInstruction(def.name, encoded)) } as unknown as Instruction;
    },
    async send(payer, ...ixs) {
      const tx = await pipe(
        createTransactionMessage({ version: 0 }),
        (t) => setTransactionMessageFeePayerSigner(payer, t),
        (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t),
        (t) => appendTransactionMessageInstructions(ixs, t),
        (t) => signTransactionMessageWithSigners(t),
      );
      const res = svm.sendTransaction(tx);
      svm.expireBlockhash();
      return res;
    },
    ok(res) {
      if (res instanceof FailedTransactionMetadata) {
        const m = /Custom\D*(\d+)/.exec(String(res.err()));
        const name = m ? harness.errorName(Number(m[1])) : undefined;
        throw new Error(`transaction failed: ${String(res.err())}${name ? ` (${name})` : ""}\n${res.meta().logs().join("\n")}`);
      }
      return res;
    },
    errorCode(res) {
      if (!(res instanceof FailedTransactionMetadata)) throw new Error("expected the transaction to fail, but it succeeded");
      const m = /Custom\D*(\d+)/.exec(String(res.err()));
      if (!m) throw new Error(`not a custom program error: ${String(res.err())}\n${res.meta().logs().join("\n")}`);
      return Number(m[1]);
    },
    errorName(code) {
      return pidl.errors?.find((e) => e.code === code)?.name ?? TYPESOL_ERRORS[code];
    },
    async mint({ authority, decimals = 6, supply = 0n, freezeAuthority, tokenProgram = TOKEN_PROGRAM, address }) {
      const at = address ?? (await generateKeyPairSigner()).address;
      const data = new Uint8Array(82);
      const view = new DataView(data.buffer);
      view.setUint32(0, 1, true);
      data.set(enc.encode(authority), 4);
      view.setBigUint64(36, supply, true);
      data[44] = decimals;
      data[45] = 1;
      if (freezeAuthority) {
        view.setUint32(46, 1, true);
        data.set(enc.encode(freezeAuthority), 50);
      }
      svm.setAccount({
        address: at,
        data,
        executable: false,
        lamports: lamports(svm.minimumBalanceForRentExemption(82n)),
        programAddress: tokenProgram,
        space: 82n,
      });
      return at;
    },
    async tokenAccount({ mint, owner, amount = 0n, tokenProgram = TOKEN_PROGRAM, address }) {
      const at = address ?? (await generateKeyPairSigner()).address;
      const data = new Uint8Array(165);
      data.set(enc.encode(mint), 0);
      data.set(enc.encode(owner), 32);
      new DataView(data.buffer).setBigUint64(64, amount, true);
      data[108] = 1; // AccountState::Initialized
      svm.setAccount({
        address: at,
        data,
        executable: false,
        lamports: lamports(svm.minimumBalanceForRentExemption(165n)),
        programAddress: tokenProgram,
        space: 165n,
      });
      return at;
    },
    tokenBalance(address) {
      const a = svm.getAccount(address);
      return a.exists && a.data.length >= 72 ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : null;
    },
    warp({ unixTimestamp, slot, seconds }) {
      const clock = svm.getClock();
      if (slot !== undefined) clock.slot = slot;
      if (unixTimestamp !== undefined) clock.unixTimestamp = unixTimestamp;
      if (seconds !== undefined) clock.unixTimestamp += seconds;
      svm.setClock(clock);
    },
    async account<T>(type: string, address: Address) {
      const a = svm.getAccount(address);
      if (!a.exists) return null;
      return plain(coder.decodeAccount(type, Buffer.from(a.data))) as T;
    },
    returned<T>(instruction: string, res: Result) {
      const def = pidl.instructions.find((i) => i.name === instruction || i.name === snake(instruction));
      if (!def?.returns) throw new Error(`${instruction} returns nothing`);
      const data = Buffer.from(harness.ok(res).returnData().data());
      const t = def.returns;
      const short = (n: number) => {
        if (data.length < n) throw new Error(`${instruction} returned ${data.length} bytes; a ${String(t)} needs ${n}`);
      };
      if (typeof t === "string") {
        if (t === "pubkey") return (short(32), getAddressDecoder().decode(data)) as T;
        if (t === "bool") return (short(1), data[0] !== 0) as T;
        if (t === "f32") return (short(4), data.readFloatLE(0)) as T;
        if (t === "f64") return (short(8), data.readDoubleLE(0)) as T;
        if (t === "string" || t === "bytes") {
          // Borsh: a u32 length, then the bytes (UTF-8 for a string).
          short(4);
          const len = data.readUInt32LE(0);
          short(4 + len);
          const body = data.subarray(4, 4 + len);
          return (t === "string" ? body.toString("utf8") : new Uint8Array(body)) as T;
        }
        const int = /^[ui](8|16|32|64|128)$/.exec(t);
        if (!int) throw new Error(`decode ${instruction}'s return data yourself (${t})`);
        const signed = t.startsWith("i");
        const bytes = Number(int[1]) / 8;
        short(bytes);
        let n = 0n;
        for (let i = bytes - 1; i >= 0; i--) n = (n << 8n) | BigInt(data[i]);
        if (signed && n >= 1n << BigInt(bytes * 8 - 1)) n -= 1n << BigInt(bytes * 8);
        return (bytes <= 4 ? Number(n) : n) as T;
      }
      if ("defined" in t) return plain(coder.decodeType(t.defined.name, data)) as T;
      throw new Error(`decode ${instruction}'s return data yourself (${JSON.stringify(t)})`);
    },
    events<T>(res: Result) {
      const done = harness.ok(res);
      // Every inner instruction of the transaction, in order. Not looked up by the top-level instruction's index:
      // a precompile (Ed25519, Secp256k1) is an instruction that logs no invoke line.
      const inner = done.innerInstructions().flat();
      const found: { name: string; data: T }[] = [];
      const add = (bytes: Uint8Array) => {
        const e = coder.decodeEvent(bytes);
        if (e) found.push({ name: e.name, data: plain(e.data) as T });
      };
      // The logs name every program invoked, in order: an `invoke` line deeper than [1] is the next inner instruction
      // (where an emitCpi event is). A data line is this program's while it runs innermost.
      const running: string[] = [];
      let next = 0;
      for (const line of done.logs()) {
        const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
        if (invoke) {
          if (invoke[2] !== "1") {
            const data = inner[next++]?.instruction().data();
            if (invoke[1] === programId && data && data.length >= 8 && EVENT_IX_TAG.equals(data.subarray(0, 8))) add(data.subarray(8));
          }
          running.push(invoke[1]!);
          continue;
        }
        if (/^Program \S+ (success$|failed)/.test(line)) {
          running.pop();
          continue;
        }
        if (running.at(-1) === programId && line.startsWith("Program data: ")) add(Buffer.from(line.slice("Program data: ".length), "base64"));
      }
      return found;
    },
    balance(address) {
      return svm.getBalance(address) ?? 0n;
    },
    connection: svmConnection(svm),
  };
  return harness;
}
