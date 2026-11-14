/**
 * A Borsh coder driven by an Anchor IDL (spec 0.1.0): instruction data, account data, events and the IDL's defined
 * types. `typesol/testing` encodes arguments and decodes accounts, return data and events with it.
 *
 * It reads the IDL as Anchor's TypeScript `BorshCoder` does (test/client/idl-coder.test.ts compares the two byte for
 * byte): the discriminators are the IDL's own, `serialization` and `repr` do not change the layout (account data is read
 * field after field), and Options, Vecs, strings and enums are Borsh's. Values:
 *
 * - u8 to u32, i8 to i32, f32, f64: numbers. u64 and wider: bigints (a number or a decimal string is taken too).
 * - bool: a boolean. pubkey: an address string (32 bytes are taken too).
 * - string: a string. bytes: a Buffer (a Uint8Array or a number[] is taken too).
 * - option: null for None. vec and array: arrays. A struct: an object by the IDL's field names ("0", "1"… for a tuple
 *   struct). An enum: `{ Variant: { field: value } }` (`{ Variant: {} }` for a variant without fields).
 *
 * A type the IDL can name but this coder does not handle (`coption`) fails when the coder is made, naming the type.
 *
 * By default a struct field or argument left undefined is written as zeros when its size is fixed, and keys that name
 * no field are ignored, as Anchor's coder does. With `{ strict: true }` (what `typesol/testing` uses) both are errors
 * naming the field; an Option may still be left out (None).
 */
import { getAddressDecoder, getAddressEncoder, isAddress } from "@solana/kit";

export type IdlTypeSpec =
  | string
  | { option: IdlTypeSpec }
  | { coption: IdlTypeSpec }
  | { vec: IdlTypeSpec }
  | { array: [IdlTypeSpec, number | { generic: string }] }
  | { defined: { name: string; generics?: IdlGenericArg[] } }
  | { generic: string };
export type IdlGenericArg = { kind: "type"; type: IdlTypeSpec } | { kind: "const"; value: string };
export type IdlFieldsSpec = { name: string; type: IdlTypeSpec }[] | IdlTypeSpec[];
export interface IdlTypeDefSpec {
  name: string;
  generics?: ({ kind: "type"; name: string } | { kind: "const"; name: string; type?: string })[];
  type:
    { kind: "struct"; fields?: IdlFieldsSpec } | { kind: "enum"; variants: { name: string; fields?: IdlFieldsSpec }[] } | { kind: "type"; alias: IdlTypeSpec };
}
/** The parts of an IDL the coder reads. */
export interface CoderIdl {
  instructions: readonly { name: string; discriminator: readonly number[]; args: readonly { name: string; type: unknown }[] }[];
  accounts?: readonly { name: string; discriminator: readonly number[] }[];
  events?: readonly { name: string; discriminator: readonly number[] }[];
  types?: readonly unknown[];
}
export interface IdlCoderOptions {
  /** A missing field or argument that is not an Option, or a key that names none, is an error (default false). */
  strict?: boolean;
}

const INTS: Record<string, { bytes: number; signed: boolean }> = {
  u8: { bytes: 1, signed: false },
  i8: { bytes: 1, signed: true },
  u16: { bytes: 2, signed: false },
  i16: { bytes: 2, signed: true },
  u32: { bytes: 4, signed: false },
  i32: { bytes: 4, signed: true },
};
const BIGS: Record<string, { bytes: number; signed: boolean }> = {
  u64: { bytes: 8, signed: false },
  i64: { bytes: 8, signed: true },
  u128: { bytes: 16, signed: false },
  i128: { bytes: 16, signed: true },
  u256: { bytes: 32, signed: false },
  i256: { bytes: 32, signed: true },
};
const FIXED: Record<string, number> = { bool: 1, f32: 4, f64: 8, pubkey: 32 };
for (const [k, v] of Object.entries({ ...INTS, ...BIGS })) FIXED[k] = v.bytes;

/** Generic parameters of the type being read, by name. */
type Env = Map<string, IdlGenericArg>;
const NO_ENV: Env = new Map();

const describe = (t: unknown) => (typeof t === "string" ? t : JSON.stringify(t));

/** Named fields of a struct or variant, or a tuple's fields named "0", "1"… (as Anchor's coder names them). */
function fieldsOf(fields: IdlFieldsSpec | undefined): { name: string; type: IdlTypeSpec }[] {
  if (!fields?.length) return [];
  if (typeof fields[0] === "object" && fields[0] !== null && "name" in fields[0] && (fields[0] as { name?: unknown }).name)
    return fields as { name: string; type: IdlTypeSpec }[];
  return (fields as IdlTypeSpec[]).map((type, i) => ({ name: String(i), type }));
}

class Writer {
  private buf = Buffer.alloc(256);
  len = 0;
  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  /** `n` bytes written by `f` at the current end. */
  write(n: number, f: (b: Buffer, at: number) => void) {
    this.room(n);
    f(this.buf, this.len);
    this.len += n;
  }
  bytes(b: Uint8Array) {
    this.write(b.length, (buf, at) => buf.set(b, at));
  }
  done(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.len));
  }
}

export class IdlCoder {
  private readonly types: Map<string, IdlTypeDefSpec>;
  private readonly instructions: Map<string, { discriminator: Buffer; args: { name: string; type: IdlTypeSpec }[] }>;
  private readonly accountDefs: Map<string, { discriminator: Buffer; type: IdlTypeSpec }>;
  private readonly eventDefs: [string, { discriminator: Buffer; type: IdlTypeSpec }][];
  private readonly strict: boolean;
  private readonly enc = getAddressEncoder();
  private readonly dec = getAddressDecoder();

  constructor(idl: CoderIdl, options: IdlCoderOptions = {}) {
    this.strict = options.strict ?? false;
    const types = (idl.types ?? []) as IdlTypeDefSpec[];
    this.types = new Map(types.map((t) => [t.name, t]));
    // Every layout is checked now, as Anchor's coder builds them all when it is made.
    this.instructions = new Map(
      idl.instructions.map((ix) => {
        const args = ix.args.map((a) => ({ name: a.name, type: a.type as IdlTypeSpec }));
        for (const a of args) this.check(a.type, NO_ENV, [], false, a.name);
        return [ix.name, { discriminator: Buffer.from(ix.discriminator), args }];
      }),
    );
    if (idl.accounts?.length && !idl.types) throw new Error("Accounts require `idl.types`");
    this.accountDefs = new Map(
      (idl.accounts ?? []).map((acc) => {
        if (!this.types.has(acc.name)) throw new Error(`Account not found: ${acc.name}`);
        const type: IdlTypeSpec = { defined: { name: acc.name } };
        this.check(type, NO_ENV, [], false, acc.name);
        return [acc.name, { discriminator: Buffer.from(acc.discriminator), type }];
      }),
    );
    if (idl.events?.length && !idl.types) throw new Error("Events require `idl.types`");
    this.eventDefs = (idl.events ?? []).map((ev) => {
      if (!this.types.has(ev.name)) throw new Error(`Event not found: ${ev.name}`);
      const type: IdlTypeSpec = { defined: { name: ev.name } };
      this.check(type, NO_ENV, [], false, ev.name);
      return [ev.name, { discriminator: Buffer.from(ev.discriminator), type }];
    });
    for (const t of types) if (!t.generics?.length) this.check({ defined: { name: t.name } }, NO_ENV, [], false, t.name);
  }

  // ---- the IDL's shapes ----

  private resolve(type: IdlTypeSpec, env: Env): IdlTypeSpec {
    if (typeof type === "object" && "generic" in type) {
      const arg = env.get(type.generic);
      if (arg?.kind !== "type") throw new Error(`IDL generic ${type.generic} has no type argument`);
      return arg.type;
    }
    return type;
  }
  private arrayLen(len: number | { generic: string }, env: Env): number {
    if (typeof len === "number") return len;
    const arg = env.get(len.generic);
    if (arg?.kind !== "const") throw new Error(`IDL array length ${len.generic} has no const argument`);
    return Number(arg.value);
  }
  /** A defined type and the environment its fields are read in. */
  private definition(type: { defined: { name: string; generics?: IdlGenericArg[] } }, env: Env): [IdlTypeDefSpec, Env] {
    const def = this.types.get(type.defined.name);
    if (!def) throw new Error(`Type not found: ${type.defined.name}`);
    const inner: Env = new Map();
    (def.generics ?? []).forEach((g, i) => {
      const arg = type.defined.generics?.[i];
      if (!arg) throw new Error(`${def.name}: missing generic argument ${g.name}`);
      inner.set(g.name, arg.kind === "type" ? { kind: "type", type: this.resolve(arg.type, env) } : arg);
    });
    return [def, inner];
  }

  /** Throws for a shape the coder cannot read, naming it. A type may only contain itself inside an option or vec. */
  private check(type: IdlTypeSpec, env: Env, stack: string[], wrapped: boolean, where: string): void {
    type = this.resolve(type, env);
    if (typeof type === "string") {
      if (type in FIXED || type === "string" || type === "bytes") return;
      throw new Error(`${where}: the IDL type ${type} is not supported`);
    }
    if ("option" in type) return this.check(type.option, env, stack, true, where);
    if ("vec" in type) return this.check(type.vec, env, stack, true, where);
    if ("array" in type) {
      this.arrayLen(type.array[1], env);
      return this.check(type.array[0], env, stack, wrapped, where);
    }
    if ("defined" in type) {
      const name = type.defined.name;
      if (stack.includes(name)) {
        if (!wrapped) throw new Error(`Recursive type must be wrapped in an option or vector: ${name}`);
        return;
      }
      const [def, inner] = this.definition(type, env);
      const next = [...stack, name];
      if (def.type.kind === "struct") for (const f of fieldsOf(def.type.fields)) this.check(f.type, inner, next, false, `${name}.${f.name}`);
      else if (def.type.kind === "enum")
        for (const v of def.type.variants) for (const f of fieldsOf(v.fields)) this.check(f.type, inner, next, false, `${name}.${v.name}.${f.name}`);
      else if (def.type.kind === "type") this.check(def.type.alias, inner, next, false, name);
      else throw new Error(`${name}: the IDL type kind ${(def.type as { kind: string }).kind} is not supported`);
      return;
    }
    throw new Error(`${where}: the IDL type ${describe(type)} is not supported`);
  }

  /** The type's size when every value of it has the same size (as Anchor's layouts give a span), else undefined. */
  private fixedSize(type: IdlTypeSpec, env: Env, stack: string[] = []): number | undefined {
    type = this.resolve(type, env);
    if (typeof type === "string") return FIXED[type];
    if ("array" in type) {
      const n = this.fixedSize(type.array[0], env, stack);
      return n !== undefined && n > 0 ? n * this.arrayLen(type.array[1], env) : undefined;
    }
    if ("defined" in type && !stack.includes(type.defined.name)) {
      const [def, inner] = this.definition(type, env);
      const next = [...stack, type.defined.name];
      if (def.type.kind === "type") return this.fixedSize(def.type.alias, inner, next);
      if (def.type.kind !== "struct") return undefined; // an enum is read by its tag
      let total = 0;
      for (const f of fieldsOf(def.type.fields)) {
        const n = this.fixedSize(f.type, inner, next);
        if (n === undefined) return undefined;
        total += n;
      }
      return total;
    }
    return undefined;
  }

  // ---- encoding ----

  private bigint(v: unknown, t: string, where: string): bigint {
    const { bytes, signed } = BIGS[t]!;
    let n: bigint;
    if (typeof v === "bigint") n = v;
    else {
      const s = String(v);
      if (!/^-?\d+$/.test(s)) throw new Error(`${where}: ${s} is not an integer (${t})`);
      n = BigInt(s);
    }
    const bits = BigInt(bytes * 8);
    const [min, max] = signed ? [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n] : [0n, (1n << bits) - 1n];
    if (n < min || n > max) throw new RangeError(`${where}: ${n} is out of range for ${t}`);
    return n;
  }

  private pubkey(v: unknown, where: string): Uint8Array {
    if (typeof v === "string") {
      if (!isAddress(v)) throw new Error(`${where}: expected an address`);
      return new Uint8Array(this.enc.encode(v));
    }
    if (v instanceof Uint8Array && v.length === 32) return v;
    // An object with Solana web3.js 1.x's PublicKey methods.
    const o = v as { toBuffer?: () => Uint8Array; toBytes?: () => Uint8Array } | null;
    const b = typeof o?.toBuffer === "function" ? o.toBuffer() : typeof o?.toBytes === "function" ? o.toBytes() : undefined;
    if (b instanceof Uint8Array && b.length === 32) return b;
    throw new Error(`${where}: expected an address`);
  }

  private write(w: Writer, type: IdlTypeSpec, v: unknown, env: Env, where: string): void {
    type = this.resolve(type, env);
    if (typeof type === "string") {
      const int = INTS[type];
      // Buffer's own writers, as Anchor's layouts use them: the same range errors and the same rounding.
      if (int) return w.write(int.bytes, (b, at) => (int.signed ? b.writeIntLE(v as number, at, int.bytes) : b.writeUIntLE(v as number, at, int.bytes)));
      const big = BIGS[type];
      if (big) {
        let n = BigInt.asUintN(big.bytes * 8, this.bigint(v, type, where));
        return w.write(big.bytes, (b, at) => {
          for (let i = 0; i < big.bytes; i++, n >>= 8n) b[at + i] = Number(n & 0xffn);
        });
      }
      switch (type) {
        case "bool":
          return w.write(1, (b, at) => (b[at] = v ? 1 : 0));
        case "f32":
          return w.write(4, (b, at) => b.writeFloatLE(v as number, at));
        case "f64":
          return w.write(8, (b, at) => b.writeDoubleLE(v as number, at));
        case "pubkey":
          return w.bytes(this.pubkey(v, where));
        case "string":
        case "bytes": {
          if (type === "string" && typeof v !== "string" && !(v instanceof Uint8Array)) throw new TypeError(`${where}: expected a string`);
          if (type === "bytes" && !(v instanceof Uint8Array) && !Array.isArray(v)) throw new TypeError(`${where}: expected bytes`);
          const body = type === "string" ? Buffer.from(v as string, "utf8") : Buffer.from(v as Uint8Array);
          w.write(4, (b, at) => b.writeUInt32LE(body.length, at));
          return w.bytes(body);
        }
      }
      throw new Error(`${where}: the IDL type ${type} is not supported`);
    }
    if ("option" in type) {
      if (v === null || v === undefined) return w.write(1, (b, at) => (b[at] = 0));
      w.write(1, (b, at) => (b[at] = 1));
      return this.write(w, type.option, v, env, where);
    }
    if ("vec" in type) {
      const items = this.items(v, where);
      w.write(4, (b, at) => b.writeUInt32LE(items.length, at));
      items.forEach((x, i) => this.write(w, type.vec, x, env, `${where}[${i}]`));
      return;
    }
    if ("array" in type) {
      const items = this.items(v, where);
      const len = this.arrayLen(type.array[1], env);
      if (items.length !== len) throw new RangeError(`${where}: expected ${len} items, received ${items.length}`);
      items.forEach((x, i) => this.write(w, type.array[0], x, env, `${where}[${i}]`));
      return;
    }
    if ("defined" in type) {
      const [def, inner] = this.definition(type, env);
      if (def.type.kind === "type") return this.write(w, def.type.alias, v, inner, where);
      if (def.type.kind === "struct") return this.fields(w, fieldsOf(def.type.fields), v, inner, where);
      if (def.type.kind === "enum") {
        if (typeof v !== "object" || v === null) throw new TypeError(`${where}: expected a variant of ${def.name}, as { Variant: {…} }`);
        // The first variant (in the IDL's order) the object names, as Anchor's coder picks it.
        const i = def.type.variants.findIndex((x) => Object.prototype.hasOwnProperty.call(v, x.name));
        if (i < 0) throw new Error(`${where}: no variant of ${def.name} in { ${Object.keys(v).join(", ")} }`);
        const variant = def.type.variants[i]!;
        if (i > 255) throw new RangeError(`${def.name}: more than 256 variants`);
        w.write(1, (b, at) => (b[at] = i));
        const fields = fieldsOf(variant.fields);
        if (fields.length) this.fields(w, fields, (v as Record<string, unknown>)[variant.name], inner, `${where}.${variant.name}`);
        return;
      }
    }
    throw new Error(`${where}: the IDL type ${describe(type)} is not supported`);
  }

  private items(v: unknown, where: string): unknown[] {
    if (Array.isArray(v)) return v;
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<unknown>);
    throw new TypeError(`${where}: expected an array`);
  }

  /**
   * A struct's fields in order. A field left undefined is written as zeros when its size is fixed (what Anchor's coder
   * does); a variable-size one cannot be, and throws. Strict: a missing field that is not an Option, and a key that
   * names no field, throw.
   */
  private fields(w: Writer, fields: { name: string; type: IdlTypeSpec }[], v: unknown, env: Env, where: string) {
    if (fields.length && (typeof v !== "object" || v === null))
      throw new TypeError(`${where}: expected an object with ${fields.map((f) => f.name).join(", ")}`);
    const o = v as Record<string, unknown>;
    if (this.strict && typeof o === "object" && o !== null)
      for (const k of Object.keys(o))
        if (!fields.some((f) => f.name === k))
          throw new Error(`${where}: no field "${k}" (${fields.length ? `the fields are ${fields.map((f) => f.name).join(", ")}` : "it has no fields"})`);
    for (const f of fields) {
      const x = o[f.name];
      if (x === undefined) {
        const isOption = (() => {
          const t = this.resolve(f.type, env);
          return typeof t === "object" && "option" in t;
        })();
        if (isOption) {
          this.write(w, f.type, null, env, `${where}.${f.name}`);
          continue;
        }
        if (this.strict) throw new Error(`${where}.${f.name}: missing (only an Option may be left out)`);
        const n = this.fixedSize(f.type, env);
        if (n === undefined) throw new Error(`${where}.${f.name}: missing`);
        w.write(n, (b, at) => b.fill(0, at, at + n));
        continue;
      }
      this.write(w, f.type, x, env, `${where}.${f.name}`);
    }
  }

  /** Instruction data: the IDL's discriminator, then the arguments. */
  encodeInstruction(name: string, args: Record<string, unknown>): Buffer {
    const ix = this.instructions.get(name);
    if (!ix) throw new Error(`Unknown method: ${name}`);
    if (ix.args.length && (args === null || typeof args !== "object" || Array.isArray(args)))
      throw new Error(`Invalid arguments for instruction "${name}": expected an object with fields { ${ix.args.map((a) => a.name).join(", ")} }`);
    const isOption = (t: IdlTypeSpec) => typeof t === "object" && "option" in t;
    const missing = ix.args.filter((a) => !isOption(a.type) && !Object.prototype.hasOwnProperty.call(args, a.name)).map((a) => `\`${a.name}\``);
    if (missing.length) throw new Error(`Invalid arguments for instruction "${name}": missing field${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`);
    if (this.strict && args !== null && typeof args === "object")
      for (const k of Object.keys(args))
        if (!ix.args.some((a) => a.name === k))
          throw new Error(
            `Invalid arguments for instruction "${name}": no argument \`${k}\` (${ix.args.length ? `it takes ${ix.args.map((a) => a.name).join(", ")}` : "it takes none"})`,
          );
    const w = new Writer();
    w.bytes(ix.discriminator);
    this.fields(w, ix.args, args ?? {}, NO_ENV, name);
    return w.done();
  }

  /** Account data: the discriminator, then the account's fields. */
  encodeAccount(name: string, value: unknown): Buffer {
    const acc = this.accountDefs.get(name);
    if (!acc) throw new Error(`Account not found: ${name}`);
    const w = new Writer();
    w.bytes(acc.discriminator);
    this.write(w, acc.type, value, NO_ENV, name);
    return w.done();
  }

  /** A defined type's bytes. */
  encodeType(name: string, value: unknown): Buffer {
    const def = this.types.get(name);
    if (!def || def.generics?.length) throw new Error(`Unknown type: ${name}`);
    const w = new Writer();
    this.write(w, { defined: { name } }, value, NO_ENV, name);
    return w.done();
  }

  // ---- decoding ----

  private need(b: Buffer, at: number, n: number, what: string) {
    if (at + n > b.length) throw new RangeError(`${what}: need ${n} bytes at offset ${at}, the data has ${b.length}`);
  }

  /** The value of `type` at `at`, and the offset after it. */
  private read(b: Buffer, at: number, type: IdlTypeSpec, env: Env, where: string): [unknown, number] {
    type = this.resolve(type, env);
    if (typeof type === "string") {
      const int = INTS[type];
      if (int) {
        this.need(b, at, int.bytes, where);
        return [int.signed ? b.readIntLE(at, int.bytes) : b.readUIntLE(at, int.bytes), at + int.bytes];
      }
      // Data cut short (return data loses its trailing zero bytes) is read as Anchor's coder reads it: a wide integer
      // from the bytes that are there, the missing high bytes zero; a pubkey from them, padded with zeros in front.
      const big = BIGS[type];
      if (big) {
        const have = b.subarray(at, at + big.bytes);
        let n = 0n;
        for (let i = have.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(have[i]!);
        return [big.signed ? BigInt.asIntN(big.bytes * 8, n) : n, at + big.bytes];
      }
      switch (type) {
        case "bool": {
          this.need(b, at, 1, where);
          const x = b[at]!;
          if (x > 1) throw new Error(`Invalid bool: ${x}`);
          return [x === 1, at + 1];
        }
        case "f32":
          this.need(b, at, 4, where);
          return [b.readFloatLE(at), at + 4];
        case "f64":
          this.need(b, at, 8, where);
          return [b.readDoubleLE(at), at + 8];
        case "pubkey": {
          const have = b.subarray(at, at + 32);
          const key = new Uint8Array(32);
          key.set(have, 32 - have.length);
          return [this.dec.decode(key), at + 32];
        }
        case "string":
        case "bytes": {
          this.need(b, at, 4, where);
          const len = b.readUInt32LE(at);
          this.need(b, at + 4, len, where);
          const body = b.subarray(at + 4, at + 4 + len);
          return [type === "string" ? body.toString("utf8") : body, at + 4 + len];
        }
      }
      throw new Error(`${where}: the IDL type ${type} is not supported`);
    }
    if ("option" in type) {
      this.need(b, at, 1, where);
      if (b[at] === 0) return [null, at + 1];
      if (b[at] !== 1) throw new Error(`Invalid option ${where}`);
      return this.read(b, at + 1, type.option, env, where);
    }
    if ("vec" in type || "array" in type) {
      let count: number;
      let elem: IdlTypeSpec;
      if ("vec" in type) {
        this.need(b, at, 4, where);
        count = b.readUInt32LE(at);
        at += 4;
        elem = type.vec;
      } else {
        count = this.arrayLen(type.array[1], env);
        elem = type.array[0];
      }
      // A count the data cannot hold is refused before reading: elements of a fixed size need count × size bytes, others
      // at least a byte each. Unlike a value on its own, an element may not run past the end.
      const size = this.fixedSize(elem, env);
      const left = Math.max(0, b.length - at);
      if (size !== undefined && size > 0 ? count * size > left : size === undefined && count > left)
        throw new RangeError(`${where}: ${count} items do not fit in the ${left} bytes left`);
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const [x, next] = this.read(b, at, elem, env, `${where}[${i}]`);
        if (next > b.length) throw new RangeError(`${where}[${i}]: read past the end of the data`);
        out.push(x);
        at = next;
      }
      return [out, at];
    }
    if ("defined" in type) {
      const [def, inner] = this.definition(type, env);
      if (def.type.kind === "type") return this.read(b, at, def.type.alias, inner, where);
      if (def.type.kind === "struct") return this.readFields(b, at, fieldsOf(def.type.fields), inner, where);
      if (def.type.kind === "enum") {
        this.need(b, at, 1, where);
        const variant = def.type.variants[b[at]!];
        if (!variant) throw new Error(`${where}: ${b[at]} is not a variant of ${def.name}`);
        const [body, next] = this.readFields(b, at + 1, fieldsOf(variant.fields), inner, `${where}.${variant.name}`);
        return [{ [variant.name]: body }, next];
      }
    }
    throw new Error(`${where}: the IDL type ${describe(type)} is not supported`);
  }

  private readFields(b: Buffer, at: number, fields: { name: string; type: IdlTypeSpec }[], env: Env, where: string): [Record<string, unknown>, number] {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const [x, next] = this.read(b, at, f.type, env, `${where}.${f.name}`);
      out[f.name] = x;
      at = next;
    }
    return [out, at];
  }

  /** An account's fields, after checking its discriminator. Bytes after the fields are ignored. */
  decodeAccount(name: string, data: Uint8Array): Record<string, unknown> {
    const acc = this.accountDefs.get(name);
    if (!acc) throw new Error(`Account not found: ${name}`);
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (acc.discriminator.compare(b.subarray(0, acc.discriminator.length)) !== 0) throw new Error("Invalid account discriminator");
    return this.read(b, acc.discriminator.length, acc.type, NO_ENV, name)[0] as Record<string, unknown>;
  }

  /** A defined type read from the start of `data`. Bytes after it are ignored. */
  decodeType(name: string, data: Uint8Array): unknown {
    const def = this.types.get(name);
    if (!def || def.generics?.length) throw new Error(`Unknown type: ${name}`);
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return this.read(b, 0, { defined: { name } }, NO_ENV, name)[0];
  }

  /**
   * An event's name and fields from its bytes (the discriminator, then the fields), as Anchor's `coder.events.decode`
   * gives them from the same bytes in base64; null when the bytes start with none of the IDL's event discriminators.
   */
  decodeEvent(data: Uint8Array): { name: string; data: Record<string, unknown> } | null {
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    for (const [name, ev] of this.eventDefs)
      if (ev.discriminator.equals(b.subarray(0, ev.discriminator.length)))
        return { name, data: this.read(b, ev.discriminator.length, ev.type, NO_ENV, name)[0] as Record<string, unknown> };
    return null;
  }

  /** An instruction's arguments read back from its data (after checking the discriminator). */
  decodeInstruction(name: string, data: Uint8Array): Record<string, unknown> {
    const ix = this.instructions.get(name);
    if (!ix) throw new Error(`Unknown method: ${name}`);
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (ix.discriminator.compare(b.subarray(0, ix.discriminator.length)) !== 0) throw new Error(`Invalid instruction discriminator for ${name}`);
    return this.readFields(b, ix.discriminator.length, ix.args, NO_ENV, name)[0];
  }
}
