import ts from "typescript";
import { argIdlName, fieldIdlName, resolveScalarType, snakeCase } from "../analyze.js";
import { INT_INFO, type AccountParam, type FieldType, type IdlSeed, type IntName, isScalar, scalarSize, typeName } from "../model.js";
import {
  accountLimit,
  MAX_SEEDS,
  PUBKEY,
  U64,
  type Value,
  type Ref,
  type CpiAcct,
  isStable,
  cString,
  fieldC,
  scalarStorageC,
  optC,
  vecCount,
} from "./shared.js";
import { borshIdentical, borshNativeStructUnsupported } from "./borsh.js";
import { ViewEmitter } from "./views.js";

/**
 * Writes a value's bytes after a byte list's length: through `put(src, n)` (room-checked copies), or straight into the
 * room (`dst + at`, `cap - at` bytes left; advance `at`) for an encoder that reports what it wrote.
 */
type ByteWriter = (put: (src: string, n: string) => void, room: { dst: string; cap: string; at: string }) => void;

/** Seeds and signer seeds, the byte buffers and Borsh serialization every CPI builds on, remaining-account ranges. */
export abstract class CpiCoreEmitter extends ViewEmitter {
  /**
   * Lower a seeds array literal into a `SolSignerSeed[]` with `extra` spare slots. Also describes
   * the seeds in Anchor IDL terms when every element is a constant, an argument or an account path.
   */
  protected seeds(node: ts.Expression, extra: number): { name: string; count: number; idl: IdlSeed[] | undefined } {
    if (!ts.isArrayLiteralExpression(node)) this.fail(node, "seeds must be an array literal");
    if (node.elements.length > MAX_SEEDS) this.fail(node, `at most ${MAX_SEEDS} seeds`);
    const parts: string[] = [];
    let idl: IdlSeed[] | undefined = [];
    // Without calls or writes among the seeds, nothing can change a seed before the CPI reads it: account fields are
    // then passed in place instead of copied.
    const mutates = (n: ts.Node): boolean =>
      ts.isCallExpression(n) ||
      (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ts.isPrefixUnaryExpression(n) ||
      ts.isPostfixUnaryExpression(n) ||
      ts.forEachChild(n, mutates) === true;
    const inPlace = !node.elements.some(mutates);
    const mark = this.lines.length;
    for (const el of node.elements) {
      const desc = this.describeSeed(el);
      if (!desc) idl = undefined;
      else idl?.push(desc);
      if (ts.isStringLiteral(el)) {
        const len = Buffer.byteLength(el.text, "utf8");
        if (len > 32) this.fail(el, "a seed can be at most 32 bytes");
        parts.push(`{(const uint8_t *)${cString(el.text)}, ${len}}`);
        continue;
      }
      // bigEndian(x): the integer's bytes most significant first (Rust's `x.to_be_bytes()`).
      if (ts.isCallExpression(el) && this.exportName(el.expression) === "bigEndian") {
        if (el.arguments.length !== 1) this.fail(el, "bigEndian(value) takes one integer");
        const v = this.expr(el.arguments[0]!);
        if (v.type.kind !== "int" || v.literal !== undefined)
          this.fail(el, "bigEndian(value) takes a typed integer (an argument, a field or a local), not a literal");
        const info = INT_INFO[(v.type as { name: IntName }).name];
        const t = this.tmp("seed");
        this.line(`uint8_t ${t}[${info.bytes}];`);
        this.line(
          `{ ${info.c} ${t}_v = ${v.c}; for (int ${t}_i = 0; ${t}_i < ${info.bytes}; ${t}_i++) ${t}[${t}_i] = ((const uint8_t *)&${t}_v)[${info.bytes - 1} - ${t}_i]; }`,
        );
        parts.push(`{${t}, ${info.bytes}}`);
        continue;
      }
      // Each seed is copied when it is evaluated, so later seeds (helper calls) cannot change earlier ones.
      const v = this.expr(el);
      if (v.type.kind === "pubkey" && (isStable(v.c) || (inPlace && /^\(&d_\w+(->\w+)+\)$/.test(v.c))))
        parts.push(`{(const uint8_t *)${v.c.startsWith("(") ? v.c : `(${v.c})`}, 32}`);
      else if (v.type.kind === "int" && inPlace && v.literal === undefined && /^d_\w+(->\w+)+$/.test(v.c))
        parts.push(`{(const uint8_t *)&${v.c}, ${INT_INFO[(v.type as { name: IntName }).name].bytes}}`);
      else if (v.type.kind === "pubkey") {
        const t = this.tmp("seed");
        this.line(`SolPubkey ${t} = *(${v.c});`);
        parts.push(`{(const uint8_t *)&${t}, 32}`);
      } else if (v.type.kind === "string") {
        const t = this.tmp("seed");
        this.line(`TS_Str ${t} = ${this.ownedString(v).c};`);
        parts.push(`{${t}.ptr, ${t}.len}`);
      } else if (v.type.kind === "int") {
        const typed = v.literal !== undefined ? this.literal(v.literal, U64, el) : v;
        const info = INT_INFO[(typed.type as { name: IntName }).name];
        const t = this.tmp("seed");
        this.line(`${info.c} ${t} = ${typed.c};`);
        parts.push(`{(const uint8_t *)&${t}, ${info.bytes}}`);
      } else if (v.type.kind === "enum") {
        // A unit enum value is its variant index, one byte (as in Seeds<…> and Borsh).
        const t = this.tmp("seed");
        this.line(`uint8_t ${t} = (uint8_t)(${v.c});`);
        parts.push(`{(const uint8_t *)&${t}, 1}`);
      } else this.fail(el, "seeds can be strings, Pubkeys, integers or unit enum values");
    }
    // The same list again (escrow: the vault transfer, then its close) reuses the array declared for the first, when
    // nothing was copied into temporaries (every entry points at a literal or at the place itself, so the array reads
    // what a new one would), it has no spare slot (callers never write into those arrays) and it is still in scope.
    const key = parts.join(", ");
    const reusable = extra === 0 && parts.length > 0 && this.lines.length === mark;
    const known = reusable ? this.seedArrays.get(key) : undefined;
    if (known && this.scopes.includes(known.scope) && this.lines[known.at]?.trim() === known.text) return { name: known.name, count: parts.length, idl };
    const name = this.tmp("seeds");
    const slots = parts.length + extra;
    this.line(`SolSignerSeed ${name}[${Math.max(slots, 1)}] = {${parts.join(", ")}};`);
    if (reusable) this.seedArrays.set(key, { name, scope: this.scopes[this.scopes.length - 1]!, at: this.lines.length - 1, text: this.lines.at(-1)!.trim() });
    return { name, count: parts.length, idl };
  }

  protected describeSeed(el: ts.Expression): IdlSeed | undefined {
    // Anchor's IDL records `x.to_be_bytes()` as the argument (or field) itself, without the byte order.
    if (ts.isCallExpression(el) && this.exportName(el.expression) === "bigEndian" && el.arguments.length === 1) return this.describeSeed(el.arguments[0]!);
    if (ts.isStringLiteral(el)) return { kind: "const", value: [...Buffer.from(el.text, "utf8")] };
    if (ts.isBigIntLiteral(el)) {
      const value = BigInt(el.text.slice(0, -1).replace(/_/g, ""));
      if (value > INT_INFO.u64.max) this.fail(el, `${value} does not fit in u64`);
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(value);
      return { kind: "const", value: [...b] };
    }
    // `opt ?? 0n` on an Option argument: Anchor's IDL keeps the Rust expression's text, `opt.unwrap_or(0)`.
    if (
      ts.isBinaryExpression(el) &&
      el.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isBigIntLiteral(el.right) &&
      ts.isIdentifier(el.left)
    ) {
      const arg = this.describeSeed(el.left);
      if (arg?.kind === "arg") return { kind: "arg", path: `${arg.path}.unwrap_or(${BigInt(el.right.text.slice(0, -1).replace(/_/g, ""))})` };
    }
    // Only the argument itself, not a local that shadows its name.
    if (ts.isIdentifier(el) && this.ix?.args.some((a) => a.name === el.text) && this.lookup(el.text) === this.args.get(el.text))
      return {
        kind: "arg",
        path: argIdlName(
          el.text,
          this.ix.accounts.map((o) => o.name),
        ),
      };
    if (ts.isIdentifier(el) && !this.lookup(el.text)) {
      const k = this.model.constants.get(el.text);
      if (k && typeof k.value === "string") return { kind: "const", value: [...Buffer.from(k.value, "utf8")] };
      if (k && typeof k.value === "object") return { kind: "const", value: k.value.pubkey };
      if (k && typeof k.value === "bigint") {
        // Little-endian two's complement in the constant's width (16 bytes for u128/i128), as the program hashes it.
        const bytes = k.type ? scalarSize(k.type) : 8;
        const v = BigInt.asUintN(bytes * 8, k.value);
        return { kind: "const", value: Array.from({ length: bytes }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn)) };
      }
    }
    if (ts.isPropertyAccessExpression(el) && this.accountAt(el.expression)) {
      const a = this.accountAt(el.expression);
      if (a && el.name.text === "key") return { kind: "account", path: snakeCase(a.name) };
      if (a && (a.kind.kind === "account" || a.kind.kind === "init" || a.kind.kind === "zeroed" || a.kind.kind === "initIfNeeded")) {
        const f = a.kind.struct.fields.find((x) => x.name === el.name.text);
        if (f && isScalar(f.type)) return { kind: "account", path: `${snakeCase(a.name)}.${f.idlName ?? fieldIdlName(f.name)}`, account: a.kind.struct.name };
      }
    }
    return undefined;
  }

  protected recordPda(account: AccountParam, idl: IdlSeed[] | undefined): void {
    if (this.ix && idl && !this.ix.pdas.has(account.name)) this.ix.pdas.set(account.name, idl);
  }

  /**
   * Emit a CPI to the program account `program` with these metas (account, writable, signer), and then (`tail`) a range
   * of the remaining accounts, read-only (a Merkle proof).
   */
  protected cpi(
    program: string,
    metas: [string, boolean, boolean][],
    buf: string,
    len: string,
    seeds: { name: string; count: number | string },
    tail?: { from: string; to: string; asPassed?: boolean },
  ) {
    const m = this.tmp("metas");
    const fixed = metas.map(([acc, w, sg]) => `{&${acc}->key, ${w}, ${sg}}`).join(", ");
    if (!tail) {
      this.line(`SolAccountMeta ${m}[${metas.length}] = {${fixed}};`);
      this.line(`TS_TRY(ts_cpi(params, ${program}, ${buf}, ${len}, ${m}, ${metas.length}, ${seeds.name}, ${seeds.count}));`);
      return;
    }
    const n = this.ix!.accounts.length;
    const cnt = this.tmp("nmetas");
    const i = this.tmp("ri");
    this.line(
      `if (${metas.length} + (${tail.to} - ${tail.from}) > TS_MAX_ACCOUNTS) TS_FAIL(TS_ERR_TOO_MANY_ACCOUNTS, "TypeSOL: the CPI lists more than ${accountLimit(this.model)} accounts");`,
    );
    this.line(`TS_METAS(${m}, ${fixed});`);
    this.line(`uint64_t ${cnt} = ${metas.length};`);
    this.line(
      `for (uint64_t ${i} = ${n} + ${tail.from}; ${i} < ${n} + ${tail.to}; ${i}++) ${m}[${cnt}++] = (SolAccountMeta){&params->ka[${i}]->key, ${tail.asPassed ? `params->ka[${i}]->is_writable` : 0}, 0};`,
    );
    this.line(`TS_TRY(ts_cpi(params, ${program}, ${buf}, ${len}, ${m}, ${cnt}, ${seeds.name}, ${seeds.count}));`);
  }

  /**
   * The seeds a CPI is signed with, or none: then a declared authority must be a Signer. A remaining account (a
   * CpiAcct without `param`) is left to the runtime, which refuses a signer meta for an account that did not sign.
   */
  protected signerSeeds(node: ts.Expression | undefined, authority: AccountParam | CpiAcct, at: ts.Node): { name: string; count: number | string } {
    if (!node) {
      const declared = "c" in authority ? authority.param : authority;
      if (declared && declared.kind.kind !== "signer") this.fail(at, "the authority must be a Signer, or pass signerSeeds for a PDA authority");
      return { name: "NULL", count: 0 };
    }
    return this.signingSeeds(node);
  }

  /** Seeds to sign a CPI with: an array literal, or a helper's SignerSeeds parameter. */
  protected signingSeeds(node: ts.Expression): { name: string; count: number | string } {
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l?.type.kind === "signerSeeds") return { name: l.c, count: `${l.c}__n` };
    }
    return this.seeds(node, 0);
  }

  /**
   * Several PDAs signing one CPI: `[["vault", owner.key, vaultBump], ["fees", feeBump]]` (or SignerSeeds parameters
   * in the list). Undefined for a single seed list, which keeps the one-signer code.
   */
  protected signerSets(node: ts.Expression): { ptr: string; count: number } | undefined {
    const isSet = (e: ts.Expression) => ts.isArrayLiteralExpression(e) || (ts.isIdentifier(e) && this.lookup(e.text)?.type.kind === "signerSeeds");
    if (!ts.isArrayLiteralExpression(node) || node.elements.length === 0 || !node.elements.every(isSet)) return undefined;
    if (node.elements.length > 16) this.fail(node, "at most 16 PDAs can sign one CPI");
    const sets = node.elements.map((e) => this.signingSeeds(e));
    const arr = this.tmp("signers");
    this.line(`SolSignerSeeds ${arr}[${sets.length}] = {${sets.map((s) => `{${s.name}, ${s.count}}`).join(", ")}};`);
    return { ptr: arr, count: sets.length };
  }

  /** Object literal properties by name, refusing others. */
  protected literalProps(o: ts.ObjectLiteralExpression, allowed: string[], what: string): Map<string, ts.Expression> {
    const props = new Map<string, ts.Expression>();
    for (const q of o.properties) {
      if (ts.isPropertyAssignment(q) && ts.isIdentifier(q.name)) props.set(q.name.text, q.initializer);
      else if (ts.isShorthandPropertyAssignment(q)) props.set(q.name.text, q.name);
      else this.fail(q, `write ${what}'s fields as name: value`);
    }
    for (const [k, v] of props) if (!allowed.includes(k)) this.fail(v, `${what} has no field ${k} (${allowed.join(", ")})`);
    return props;
  }

  /** `acct.key` of an account parameter, as an expression to serialize. */
  protected keyOf(n: ts.Expression): ts.Expression {
    const f = ts.factory;
    const e = f.createPropertyAccessExpression(n, "key");
    ts.setTextRange(e, n);
    (e as { parent?: ts.Node }).parent = n.parent;
    return e;
  }

  /**
   * `remainingAccounts()` (or a const bound to it): every remaining account; `rest.slice(a, b?)`: indexes a..b of them
   * (both checked against the count, 5104). C expressions for the range, relative to the first remaining account, and
   * `base`, the index of that account among the instruction's (a helper's RemainingAccounts parameter carries it).
   */
  protected remainingRange(node: ts.Expression): { from: string; to: string; base: string } | undefined {
    const sliced = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "slice";
    if (!this.isRemaining(node) && !(sliced && this.isRemaining((node.expression as ts.PropertyAccessExpression).expression))) return undefined;
    // In a helper: the RemainingAccounts parameter (remainingBase refuses remainingAccounts() there, with a hint).
    const n = this.ix ? this.ix.accounts.length : this.remainingBase(sliced ? (node.expression as ts.PropertyAccessExpression).expression : node);
    const count = `(params->ka_num - ${n})`;
    if (this.isRemaining(node)) return { from: "0", to: count, base: String(n) };
    if (!ts.isCallExpression(node)) return undefined;
    if (node.arguments.length < 1 || node.arguments.length > 2) this.fail(node, "slice(start, end?) takes one or two indexes");
    // Both ends may equal the count (an empty slice at the end).
    const from = this.index(node.arguments[0]!, `${count} + 1`);
    const to = node.arguments[1] ? this.index(node.arguments[1], `${count} + 1`) : count;
    this.line(`if (${from} > ${to}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: remaining accounts slice out of range");`);
    return { from, to, base: String(n) };
  }

  /**
   * A byte buffer written front to back. Its C declaration is patched in afterwards so it is
   * exactly as large as the fixed content, and only falls back to `max` when strings make it dynamic.
   */
  protected byteBuffer(prefix: string, max: number, errorCode: string, what: string) {
    const buf = this.tmp(prefix);
    const len = this.tmp(`${prefix}len`);
    const declAt = this.lines.length;
    this.line(`/* ${buf} */`);
    this.line(`uint64_t ${len} = 0;`);
    let fixed = 0;
    let dynamic = false;
    const put = (src: string, n: string, bytes?: number) => {
      // Once a variable-size piece was written the offset is only known at runtime: check every later write,
      // fixed-size ones included, so nothing lands past the buffer.
      if (bytes === undefined) dynamic = true;
      else fixed += bytes;
      if (dynamic) this.line(`if (${len} + ${n} > ${max}) TS_FAIL(${errorCode}, "TypeSOL: ${what} too large");`);
      this.line(`ts_memcpy(${buf} + ${len}, ${src}, ${n});`);
      this.line(`${len} += ${n};`);
    };
    const finish = (at: ts.Node) => {
      if (fixed > max) this.fail(at, `${what} is at least ${fixed} bytes; the limit is ${max}`);
      this.lines[declAt] = this.lines[declAt].replace(`/* ${buf} */`, `uint8_t ${buf}[${dynamic ? max : Math.max(fixed, 1)}];`);
    };
    return { buf, len, put, finish };
  }

  /** Append a value's Borsh encoding through `put(srcPointer, byteCount)`. */
  protected serialize(v: Value, node: ts.Node, put: (src: string, n: string, bytes?: number) => void) {
    if (v.isNull) this.fail(node, "a bare null has no type here; pass an Option value (e.g. a local declared `const x: u64 | null = null`)");
    const typed = v.literal !== undefined ? this.literal(v.literal, U64, node) : v;
    if (typed.type.kind === "int" && typed.type.name === "u256") this.fail(node, "u256 is for computation: convert to u128 (or smaller) to send it");
    if (typed.type.kind === "pubkey") {
      put(`(${typed.c})`, "32", 32);
    } else if (typed.type.kind === "string") {
      const t = this.tmp("s");
      const l = this.tmp("slen");
      this.line(`TS_Str ${t} = ${typed.c};`);
      this.line(`uint32_t ${l} = (uint32_t)${t}.len;`);
      put(`&${l}`, "4", 4);
      put(`${t}.ptr`, `${t}.len`);
    } else if (typed.type.kind === "option") {
      // Borsh Option: tag byte, then the value only when Some (so the size is dynamic).
      const inner = typed.type.inner;
      const t = this.tmp("o");
      this.line(`${optC(inner)} ${t} = ${typed.c};`);
      put(`&${t}.some`, "1", 1);
      put(`&${t}.v`, `(${t}.some ? ${(inner as { kind: string }).kind === "struct" ? this.fieldBytes(inner as unknown as FieldType) : scalarSize(inner)} : 0)`);
    } else if (isScalar(typed.type)) {
      const ct = scalarStorageC(typed.type);
      const bytes = scalarSize(typed.type);
      const t = this.tmp("arg");
      this.line(`${ct} ${t} = (${ct})(${typed.c});`);
      put(`&${t}`, String(bytes), bytes);
    } else this.fail(node, `${typeName(typed.type)} cannot be serialized here`);
  }

  /** Borsh-encode a data-enum place: the tag byte, then the active variant's fields. */
  protected serializeDataEnum(node: ts.Expression, name: string, put: (src: string, n: string, bytes?: number) => void) {
    const src = this.ref(node);
    if (!src || src.type.kind !== "dataEnum" || src.type.name !== name) this.fail(node, `expected a ${name}`);
    this.serializeDataEnumLv(src.lv, name, put);
  }

  protected serializeDataEnumLv(lv: string, name: string, put: (src: string, n: string, bytes?: number) => void) {
    const src = { lv };
    const e = this.model.dataEnums.get(name)!;
    put(`&${src.lv}.tag`, "1", 1);
    this.line(`switch (${src.lv}.tag) {`);
    e.variants.forEach((v, i) => {
      this.line(`case ${i}: {`);
      for (const f of v.fields) {
        const at = `${src.lv}.v.${v.name}.${f.name}`;
        if (f.type.kind === "string") {
          // Borsh String: u32 length, then the bytes.
          const n = this.tmp("sl");
          this.line(`uint32_t ${n} = (uint32_t)${at}.len;`);
          put(`&${n}`, "4");
          put(`${at}.ptr`, `${at}.len`);
          continue;
        }
        if (f.type.kind === "dataEnum" && this.model.dataEnums.get(f.type.name)?.variable) {
          this.serializeDataEnumLv(at, f.type.name, put);
          continue;
        }
        const n = this.fieldBytes(f.type);
        // put() with no static size: the payload differs by variant.
        put(`&${at}`, String(n));
      }
      this.line(`break; }`);
    });
    this.line(`}`);
  }

  /** Structs reachable through the fields of struct `name` (not including itself unless it recurses). */
  protected nestedStructs(name: string): Set<string> {
    const out = new Set<string>();
    const visit = (t: FieldType) => {
      if (t.kind === "struct") {
        if (out.has(t.name)) return;
        out.add(t.name);
        this.model.structs.get(t.name)?.fields.forEach((f) => visit(f.type));
      } else if (t.kind === "array" || t.kind === "vec") visit(t.elem);
      else if (t.kind === "option" && t.inner.kind === "struct") visit(t.inner);
      else if (t.kind === "dataEnum") this.model.dataEnums.get(t.name)?.variants.forEach((v) => v.fields.forEach((f) => visit(f.type)));
    };
    this.model.structs.get(name)?.fields.forEach((f) => visit(f.type));
    return out;
  }

  /** Structs whose IDL description is the fixed layout: account data, arguments, and everything nested in them. */
  protected fixedLayoutStructs(): Set<string> {
    const out = new Set<string>();
    const visit = (t: FieldType) => {
      if (t.kind === "struct") {
        if (out.has(t.name)) return;
        out.add(t.name);
        this.model.structs.get(t.name)?.fields.forEach((f) => visit(f.type));
      } else if (t.kind === "array" || t.kind === "vec") visit(t.elem);
      else if (t.kind === "option" && t.inner.kind === "struct") visit(t.inner);
      else if (t.kind === "dataEnum") this.model.dataEnums.get(t.name)?.variants.forEach((v) => v.fields.forEach((f) => visit(f.type)));
    };
    for (const name of [...this.model.accountStructs, ...this.model.argStructs]) visit({ kind: "struct", name });
    return out;
  }

  /**
   * Byte builders on a `FixedVec<u8, N>` (a local list or one in account data), for a native program's hand-built byte
   * strings (Phoenix's event batches: `[15] ‖ Borsh(header) ‖ events`, a u16 count patched in, truncated back to the
   * header after each flush): `pushLE` (an integer at its width), `pushKey` (32 bytes), `pushBorsh` (a value's Borsh
   * encoding, the codecs invoke, events and storeBorsh use), `setLE(offset, v)` (overwrite within the length) and
   * `truncate(n)`. Every write is bounds-checked (5104) and the length moves only once all of it fit, so a failed call
   * appends nothing.
   */
  protected byteListMethod(node: ts.CallExpression, method: string, v: Ref): Value | undefined {
    const args = node.arguments;
    const info = v.vec!;
    const vt = v.type as FieldType & { kind: "vec" };
    if (info.cap === undefined || info.heap || info.big !== undefined || vt.elem.kind !== "int" || vt.elem.name !== "u8")
      this.fail(node.expression, `${method}() builds bytes in a FixedVec<u8, N> (a local list, or one in account data)`);
    if (!v.writable) this.fail(node, this.readOnly(v));
    const cap = info.cap;
    const bytes = `((uint8_t *)${info.items})`;
    const count = vecCount(info);
    /** An integer at a width: the type argument's, or the value's own (a bare literal has none). */
    const intValue = (valueNode: ts.Expression, fn: string): Value & { type: { kind: "int"; name: IntName } } => {
      const targ = node.typeArguments?.[0];
      const t = targ ? resolveScalarType(targ, this.scope) : undefined;
      if (targ && (!t || t.kind !== "int")) this.fail(targ, `${fn}<T>: T is an integer type (u8 … u128, i8 … i128)`);
      const val = t ? this.expect(this.expr(valueNode, t), t, valueNode) : this.expr(valueNode);
      if (val.literal !== undefined) this.fail(valueNode, `${fn} needs the integer's width: ${fn}<u16>(…) or ${fn}(u16(…))`);
      if (val.type.kind !== "int")
        this.fail(valueNode, `${fn} takes an integer (u8 … u128, i8 … i128)${val.type.kind === "pubkey" ? "; a Pubkey is pushKey(key)" : ""}`);
      if (val.type.name === "u256") this.fail(valueNode, "u256 is for computation: convert to u128 (or smaller) first");
      return val as Value & { type: { kind: "int"; name: IntName } };
    };
    switch (method) {
      case "truncate": {
        // Vec::truncate, but a length past the current one fails (Rust's `drain(n..)` panics there) instead of doing nothing.
        if (args.length !== 1) this.fail(node, "truncate(length) takes the new length");
        const k = this.expect(this.expr(args[0], U64), U64, args[0]);
        const n = this.tmp("n");
        this.line(`uint64_t ${n} = ${k.c};`);
        this.line(`if (${n} > ${count}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: truncate() past the FixedVec's length");`);
        this.line(`${info.len} = (uint32_t)${n};`);
        return undefined;
      }
      case "setLE": {
        // `data[off..off + size].copy_from_slice(&v.to_le_bytes())`: within the length, as Rust's slice indexing.
        if (args.length !== 2) this.fail(node, "setLE(offset, value) takes a byte offset and an integer");
        const off = this.expect(this.expr(args[0], U64), U64, args[0]);
        const o = this.tmp("off");
        this.line(`uint64_t ${o} = ${off.c};`);
        const val = intValue(args[1]!, "setLE");
        const size = scalarSize(val.type);
        const ct = scalarStorageC(val.type);
        const w = this.tmp("le");
        this.line(`${ct} ${w} = (${ct})(${val.c});`);
        this.line(`if (${o} > ${count} || ${count} - ${o} < ${size}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: setLE() past the FixedVec's length");`);
        this.line(`ts_memcpy(${bytes} + ${o}, &${w}, ${size});`);
        return undefined;
      }
    }
    if (args.length !== 1) this.fail(node, `${method}(value) takes one value`);
    const arg = args[0]!;
    // The value first (as JS evaluates the argument before the call runs), then its bytes after the current length.
    let write: ByteWriter;
    if (method === "pushLE") {
      const val = intValue(arg, "pushLE");
      const ct = scalarStorageC(val.type);
      const w = this.tmp("le");
      this.line(`${ct} ${w} = (${ct})(${val.c});`);
      write = (put) => put(`&${w}`, String(scalarSize(val.type)));
    } else if (method === "pushKey") {
      if (node.typeArguments?.length) this.fail(node, "pushKey(key) takes no type argument");
      const k = this.expect(this.expr(arg, PUBKEY), PUBKEY, arg);
      const t = this.tmp("key");
      this.line(`SolPubkey ${t} = *(${k.c});`);
      write = (put) => put(`&${t}`, "32");
    } else write = this.borshPiece(node, arg);
    const at = this.tmp("at");
    this.line(`uint64_t ${at} = ${count};`);
    write(
      (src, n) => {
        this.line(`if (${n} > ${cap} - ${at}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: ${method}() past the FixedVec's room");`);
        this.line(`ts_memcpy(${bytes} + ${at}, ${src}, ${n});`);
        this.line(`${at} += ${n};`);
      },
      { dst: bytes, cap: String(cap), at },
    );
    this.line(`${info.len} = (uint32_t)${at};`);
    return undefined;
  }

  /**
   * `pushBorsh(value)`: lower the value now and return the writer of its Borsh bytes. Structs (a place, or an object
   * literal given its type: `pushBorsh<Header>({ … })`) are their fixed layout when that is their Borsh form, else go
   * through the struct's Borsh encoder (storeBorsh's); data enums are a tag and the variant's fields, FixedArrays their
   * elements, lists a u32 count and their elements, and integers, booleans, Pubkeys, strings and Options as in invoke
   * data.
   */
  private borshPiece(node: ts.CallExpression, arg: ts.Expression): ByteWriter {
    const targ = node.typeArguments?.[0];
    let r: Ref | undefined;
    if (ts.isObjectLiteralExpression(arg)) {
      const name = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? targ.typeName.text : undefined;
      const type: FieldType | undefined =
        name && this.model.structs.get(name)?.size !== undefined
          ? { kind: "struct", name }
          : name && this.model.dataEnums.has(name)
            ? { kind: "dataEnum", name }
            : undefined;
      if (!type)
        this.fail(arg, "pushBorsh({ … }) needs the value's type: buf.pushBorsh<Header>({ … }) (a struct or data enum), or bind it to a typed const first");
      const t = this.tmp("bv");
      this.line(`${fieldC(type)} ${t};`);
      if (type.kind === "struct") this.line(`ts_memzero(&${t}, sizeof(${t}));`);
      this.writeAggregate({ lv: t, type, writable: true }, arg, true);
      r = { lv: t, type, writable: true };
    } else if (targ) this.fail(targ, "pushBorsh<T> takes a type only for an object literal; the value's own type is used otherwise");
    const kind = r?.type.kind ?? this.peekKind(arg);
    if (kind === "struct" || kind === "array" || kind === "dataEnum") {
      r ??= this.ref(arg)!;
      const place = r;
      if (place.type.kind === "dataEnum") {
        const name = place.type.name;
        const e = this.model.dataEnums.get(name)!;
        // Fixed-size payloads are packed in the variant's C struct as Borsh lays them out: the tag, then one copy.
        if (e.variants.every((v) => v.fields.every((f) => borshIdentical(f.type, this.model))))
          return (put) => {
            put(`&${place.lv}.tag`, "1");
            if (e.variants.every((v) => !v.fields.length)) return;
            this.line(`switch (${place.lv}.tag) {`);
            e.variants.forEach((v, i) => {
              const size = v.fields.reduce((n, f) => n + this.fieldBytes(f.type), 0);
              if (!size) return;
              this.line(`case ${i}: {`);
              put(`&${place.lv}.v.${v.name}`, String(size));
              this.line(`break; }`);
            });
            this.line(`}`);
          };
        return (put) => this.serializeDataEnumLv(place.lv, name, (src, n) => put(src, n));
      }
      if (borshIdentical(place.type, this.model)) {
        const n = this.fieldBytes(place.type);
        return (put) => put(`&${place.lv}`, String(n));
      }
      if (place.type.kind === "array")
        this.fail(arg, `${typeName(place.type)} has no Borsh form of its own here (its elements hold Options, data enums or text)`);
      const s = this.model.structs.get((place.type as { name: string }).name)!;
      const why = borshNativeStructUnsupported(s, this.model);
      if (why) this.fail(arg, `pushBorsh cannot encode ${s.name}: ${why}`);
      this.model.borshNative.add(s.name);
      return (_put, room) => {
        // The encoder writes into the room left and reports how much it wrote; the length moves only afterwards.
        const w = this.tmp("bw");
        this.line(`uint64_t ${w} = 0;`);
        this.line(
          `if (ts_benc_${s.name}(&${place.lv}, ${room.dst} + ${room.at}, ${room.cap} - ${room.at}, &${w})) TS_FAIL(TS_ERR_INDEX, "TypeSOL: pushBorsh() past the FixedVec's room");`,
        );
        this.line(`${room.at} += ${w};`);
      };
    }
    const list = kind === "vec" ? this.listSpan(arg) : undefined;
    if (list) {
      // A Borsh Vec: the count as u32, then the elements (their fixed layout is their Borsh form).
      if (!borshIdentical(list.elem, this.model)) this.fail(arg, `a list of ${typeName(list.elem)} has no Borsh form of its own here`);
      const size = this.fieldBytes(list.elem);
      const c = this.tmp("vn");
      this.line(`uint32_t ${c} = (uint32_t)${list.count};`);
      return (put) => {
        put(`&${c}`, "4");
        put(`(const uint8_t *)${list.items}`, `(uint64_t)${c} * ${size}`);
      };
    }
    const val = this.expr(arg);
    if (val.literal !== undefined) this.fail(arg, "pushBorsh needs the integer's width: pushLE<u16>(…), pushBorsh(u16(…))");
    // serialize() emits its temporaries between the pieces; collect them and replay into the writer.
    return (put) => this.serialize(val, arg, (src, n) => put(src, n));
  }
}
