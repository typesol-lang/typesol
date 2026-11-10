import ts from "typescript";
import { calleeName } from "../analyze.js";
import { type FieldType, type Helper, type RbTreeInst, type ScalarType, type ValueType, INT_INFO, isScalar, optionKey, sameType, typeName } from "../model.js";
import { CallEmitter } from "./calls.js";
import { type Local, type Ref, type Value, U32, U64, fieldC, optC, valueC } from "./shared.js";

/** The run-time offset views a native program reads its account with. */
const VIEW_FNS = new Set(["loadRawAt", "loadRawMutAt", "rawArrayAt", "rawArrayMutAt", "rbTreeAt", "rbTreeMutAt"]);
/** Tree methods that hand out a reference into a node (bound to a const, they alias the tree). */
const TREE_REFS = new Set(["get", "remove", "removeAt", "min", "max", "nodeAt"]);
const TREE_METHODS =
  "length, capacity, initialize(), get(key), insert(key, value), remove(key), removeAt(index), min(), max(), addrOf(key), nodeAt(index), for … of and reversed()";

/**
 * Views of native account data at offsets known only at run time (Phoenix's market at byte 576, its trees sized by
 * the market header, Serum's slabs): `loadRawAt` / `loadRawMutAt` (a fixed-layout struct), `rawArrayAt` /
 * `rawArrayMutAt` (a run-time number of elements in place) and `rbTreeAt` / `rbTreeMutAt`, lib-sokoban 0.3's
 * RedBlackTree<K, V, N> byte for byte. Each checks its bounds once, when it is made (ProgramError::AccountDataTooSmall),
 * with the owner, writability and claim checks of loadRaw / loadRawMut.
 */
export abstract class ViewEmitter extends CallEmitter {
  /** C names of the trees a `for … of` is walking: their structure may not change in the loop (Rust's borrow). */
  protected iteratingTrees = new Set<string>();

  /** The view function a call names (loadRawAt …), or undefined. */
  protected viewFn(node: ts.Expression): string | undefined {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (!ts.isCallExpression(node)) return undefined;
    const fn = this.exportName(node.expression);
    return fn && VIEW_FNS.has(fn) ? fn : undefined;
  }

  /** The tree a name holds (`const book = rbTreeMutAt<…>(…)`), with its instance. */
  protected treeOf(node: ts.Expression): { local: Local; inst: RbTreeInst; writable: boolean } | undefined {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (!ts.isIdentifier(node)) return undefined;
    const l = this.lookup(node.text);
    if (l?.type.kind !== "rbTree") return undefined;
    return { local: l, inst: this.model.rbTrees.get(l.type.inst)!, writable: l.type.writable };
  }

  /**
   * `const x = loadRawAt<T>(…)` and the other views, or `const o = tree.get(k)` / `remove` / `min` / `max` / `nodeAt`
   * when it hands out a reference into a node: declared here (true), else left to the general binding (false).
   */
  protected bindView(d: ts.VariableDeclaration, init: ts.Expression, name: string, c: string, mutable: boolean): boolean {
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    const fn = this.viewFn(init);
    if (fn) {
      if (mutable) this.fail(d, `bind ${fn}(…) with const`);
      const call = init as ts.CallExpression;
      if (fn === "loadRawAt" || fn === "loadRawMutAt") {
        const v = this.loadRawAt(call, fn === "loadRawMutAt");
        this.line(`${valueC(v.type)}${c} = ${v.c};`);
        this.scopes.at(-1)!.set(name, { c, type: v.type, mutable: false, paths: [`@${c}`], decl: d });
      } else if (fn === "rawArrayAt" || fn === "rawArrayMutAt") {
        const type = this.rawArrayAt(call, fn === "rawArrayMutAt", c);
        this.scopes.at(-1)!.set(name, { c, type, mutable: false, paths: [`@${c}`], decl: d });
      } else {
        const type = this.rbTreeAt(call, fn === "rbTreeMutAt", c);
        this.scopes.at(-1)!.set(name, { c, type, mutable: false });
      }
      return true;
    }
    if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && TREE_REFS.has(init.expression.name.text)) {
      const tree = this.treeOf(init.expression.expression);
      const method = init.expression.name.text;
      if (!tree) return false;
      const ref = method === "min" || method === "max" || method === "nodeAt" || !isScalar(tree.inst.valueType);
      if (!ref) return false;
      if (mutable) this.fail(d, `bind ${method}(…) with const: it refers to a node of the tree`);
      const v = this.treeCall(init)!.value!;
      const ct = valueC(v.type);
      this.line(`${ct.endsWith("*") ? ct : `${ct} `}${c} = ${v.c};`);
      this.scopes.at(-1)!.set(name, { c, type: v.type, mutable: false, paths: [`@${tree.local.c}[]`], decl: d });
      return true;
    }
    return false;
  }

  /** The struct type argument of loadRawAt<T>: a fixed-size struct without a BigVec. */
  private rawAtStruct(node: ts.CallExpression, fn: string) {
    const targ = node.typeArguments?.[0];
    const s = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
    if (!s || s.size === undefined || s.vec) {
      if (s?.bigVec) this.fail(node, `${s.name} ends in a BigVec, whose room runs to the end of the account: read it with loadRaw / loadRawMut, from byte 0`);
      this.fail(node, `${fn} needs a fixed-size struct type: ${fn}<MyStruct>(account, offset)`);
    }
    if (s.layout === "borsh") this.fail(node, `${s.name} is @layout borsh: ${fn} reads fixed layouts only`);
    return s;
  }

  /** A u64 argument evaluated into a temporary, in argument order. */
  private u64Arg(node: ts.Expression, prefix: string): string {
    const t = this.tmp(prefix);
    this.line(`uint64_t ${t} = ${this.expect(this.expr(node, U64), U64, node).c};`);
    return t;
  }

  /** The view's account and offset (and capacity), evaluated left to right, then the owner check (3007). */
  private viewStart(node: ts.CallExpression, fn: string, mut: boolean, counts: boolean) {
    const want = counts ? 3 : 2;
    const extra = fn.startsWith("rbTree") ? 4 : want;
    if (node.arguments.length < want || node.arguments.length > extra)
      this.fail(
        node,
        counts
          ? `${fn}<…>(account, offset, capacity${fn.startsWith("rbTree") ? ", compare?" : ""}) takes the account, the byte offset and the element count`
          : `${fn}<T>(account, offset) takes one remaining account or AccountInfo parameter and the byte offset`,
      );
    const { h, param } = this.rawAccount(node, fn, mut);
    const off = this.u64Arg(node.arguments[1]!, "off");
    const cap = counts ? this.u64Arg(node.arguments[2]!, "cap") : undefined;
    this.line(this.viewOwnerCheck(h));
    return { h, param, off, cap };
  }

  /** `loadRawAt<T>(acct, offset)` / `loadRawMutAt`: a fixed-layout struct at a run-time byte offset. */
  protected loadRawAt(node: ts.CallExpression, mut: boolean): Value {
    const fn = mut ? "loadRawMutAt" : "loadRawAt";
    const s = this.rawAtStruct(node, fn);
    const { h, param, off } = this.viewStart(node, fn, mut, false);
    this.line(`if (${off} > ${h}->data_len || ${h}->data_len - ${off} < sizeof(TSS_${s.name})) ${this.programErrorFail("AccountDataTooSmall", node)};`);
    if (mut) this.claimRawMut(node, h, param);
    return { c: `((TSS_${s.name} *)(${h}->data + ${off}))`, type: { kind: "structRef", struct: s.name, writable: mut } };
  }

  /** `rawArrayAt<T>(acct, offset, capacity)` / `rawArrayMutAt`: `capacity` elements in place, bound to `c` (and `c__n`). */
  protected rawArrayAt(node: ts.CallExpression, mut: boolean, c: string): ValueType {
    const fn = mut ? "rawArrayMutAt" : "rawArrayAt";
    const targ = node.typeArguments?.[0];
    const elem = targ && node.typeArguments!.length === 1 ? this.localElem(targ) : undefined;
    if (!elem) this.fail(node, `${fn}<T>: T is an integer, boolean, Pubkey, enum, FixedString<N> or a fixed-size struct (one type argument)`);
    const size = this.fieldBytes(elem);
    const { h, param, off, cap } = this.viewStart(node, fn, mut, true);
    const bytes = this.tmp("bytes");
    this.line(`uint64_t ${bytes};`);
    this.line(
      `if (ts_mul_overflow_u64(${cap}, ${size}, &${bytes}) || ${off} > ${h}->data_len || ${h}->data_len - ${off} < ${bytes}) ${this.programErrorFail("AccountDataTooSmall", node)};`,
    );
    if (mut) this.claimRawMut(node, h, param);
    this.line(`${fieldC(elem)} *${c} = (${fieldC(elem)} *)(${h}->data + ${off});`);
    this.line(`uint64_t ${c}__n = ${cap};`);
    // Named in scope, so a loop over it moved into a function of its own is given the count (see outlinedLoop).
    this.scopes.at(-1)!.set(`__${c}__n`, { c: `${c}__n`, type: U64, mutable: false });
    return { kind: "rawArray", elem, writable: mut };
  }

  /** The place a RawArray local names: a list of `n` elements with no stored length (see Ref.vec). */
  private rawArrayRef(l: Local): Ref {
    const t = l.type as ValueType & { kind: "rawArray" };
    return {
      lv: l.c,
      type: { kind: "vec", elem: t.elem, big: true, raw: true },
      writable: t.writable,
      vec: { len: `${l.c}__n`, items: l.c, fixed: "", elemSize: this.fieldBytes(t.elem), resizable: false, big: `${l.c}__n`, slice: true, raw: true },
    };
  }

  /** Rust's alignment of a field type (repr(C), as on SBF): for the node layout check. */
  private alignOf(t: FieldType): number {
    switch (t.kind) {
      case "int":
        return Math.min(INT_INFO[t.name].bytes, 8);
      case "struct":
        return Math.max(1, ...this.model.structs.get(t.name)!.fields.map((f) => this.alignOf(f.type)));
      case "array":
        return this.alignOf(t.elem);
      case "fstring":
        return 4;
      default:
        return 1;
    }
  }

  /** Why the default order cannot compare this key type, or undefined. */
  private unordered(t: FieldType): string | undefined {
    if (t.kind === "int" || t.kind === "bool" || t.kind === "enum" || t.kind === "pubkey") return undefined;
    if (t.kind === "array") return this.unordered(t.elem);
    if (t.kind === "struct") {
      for (const f of this.model.structs.get(t.name)!.fields) {
        const why = this.unordered(f.type);
        if (why) return why;
      }
      return undefined;
    }
    return `a ${typeName(t)} field`;
  }

  /**
   * `rbTreeAt<K, V>(acct, offset, capacity, compare?)` / `rbTreeMutAt`: lib-sokoban 0.3's RedBlackTree<K, V, capacity>
   * at a run-time offset (32 + capacity × (16 + size(K) + size(V)) bytes), bound to `c` (a TsRbt).
   */
  protected rbTreeAt(node: ts.CallExpression, mut: boolean, c: string): ValueType {
    const fn = mut ? "rbTreeMutAt" : "rbTreeAt";
    const [kn, vn] = node.typeArguments ?? [];
    if (!kn || !vn || node.typeArguments!.length !== 2) this.fail(node, `${fn}<K, V>(account, offset, capacity, compare?) takes the key and value types`);
    const key = this.localElem(kn);
    const value = this.localElem(vn);
    if (!key || key.kind === "fstring") this.fail(kn, `${fn}: the key is an integer, boolean, Pubkey, enum or fixed-size struct`);
    if (!value || !(isScalar(value) || value.kind === "struct")) this.fail(vn, `${fn}: the value is an integer, boolean, Pubkey, enum or fixed-size struct`);
    const ks = this.fieldBytes(key);
    const vs = this.fieldBytes(value);
    const stride = 16 + ks + vs;
    // sokoban's assert_proper_alignment, and the padding Rust's repr(C) RBNode { key, value } would hold: TypeSOL
    // structs are packed, so the bytes match only when there is none (spell padding out as fields, as Rust ports do).
    if (stride % 8)
      this.fail(
        node,
        `a node is 16 + ${ks} + ${vs} = ${stride} bytes, not a multiple of 8 (sokoban asserts it): add ${8 - (stride % 8)} bytes of padding to ${typeName(value)}`,
      );
    if (ks % this.alignOf(key) || vs % this.alignOf(value) || ks % this.alignOf(value))
      this.fail(
        node,
        `Rust would pad RBNode<${typeName(key)}, ${typeName(value)}> (alignment): give the key and value sizes that are multiples of their alignment`,
      );
    const cmpNode = node.arguments[3];
    let compare: Helper | undefined;
    if (cmpNode) {
      const name = ts.isIdentifier(cmpNode) ? calleeName(cmpNode, this.model.helperDecls, this.checker) : undefined;
      if (name && this.model.generics.has(name))
        this.fail(cmpNode, `the comparator is a plain function (not generic): (a: ${typeName(key)}, b: ${typeName(key)}) => i8`);
      compare = name ? this.model.helpers.get(name) : undefined;
      if (!compare) this.fail(cmpNode, `the comparator is a named function (a: ${typeName(key)}, b: ${typeName(key)}) => i8, declared in the program`);
      const ok = (p: Helper["params"][number]) =>
        !p.account && (p.type.kind === "structRef" ? key.kind === "struct" && p.type.struct === key.name : sameType(p.type, key));
      if (compare.params.length !== 2 || !compare.params.every(ok) || compare.returns?.kind !== "int")
        this.fail(
          cmpNode,
          `${compare.display} must take two ${typeName(key)} keys and return an integer (negative, 0 or positive): (a: ${typeName(key)}, b: ${typeName(key)}) => i8`,
        );
    } else {
      const why = this.unordered(key);
      if (why) this.fail(kn, `${typeName(key)} has no default order (${why}): pass a comparator, ${fn}<K, V>(account, offset, capacity, compare)`);
    }
    const instKey = `${typeName(key)}|${typeName(value)}|${compare?.name ?? ""}`;
    if (!this.model.rbTrees.has(instKey))
      this.model.rbTrees.set(instKey, {
        key: instKey,
        c: `ts_rbt${this.model.rbTrees.size}`,
        keyType: key,
        valueType: value,
        keySize: ks,
        valueSize: vs,
        stride,
        compare,
      });
    const { h, param, off, cap } = this.viewStart(node, fn, mut, true);
    const bytes = this.tmp("bytes");
    this.line(`uint64_t ${bytes};`);
    // bump_index is a u32 that reaches capacity + 1: a capacity of u32::MAX or more has no tree (no account holds one).
    this.line(
      `if (${cap} >= 0xFFFFFFFFULL || ts_mul_overflow_u64(${cap}, ${stride}, &${bytes}) || ts_add_overflow_u64(${bytes}, 32, &${bytes}) || ${off} > ${h}->data_len || ${h}->data_len - ${off} < ${bytes}) ${this.programErrorFail("AccountDataTooSmall", node)};`,
    );
    if (mut) this.claimRawMut(node, h, param);
    this.line(`TsRbt ${c} = {${h}->data + ${off}, ${cap}};`);
    return { kind: "rbTree", inst: instKey, writable: mut };
  }

  /** A pointer to a key or value given to a tree method: a struct place as it is, anything else in a temporary. */
  private treeOperand(node: ts.Expression, t: FieldType): string {
    if (t.kind === "struct") {
      let inner = node;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      if (ts.isObjectLiteralExpression(inner)) {
        const tmp = this.tmp("rbk");
        this.line(`TSS_${t.name} ${tmp};`);
        this.writeAggregate({ lv: tmp, type: t, writable: true }, inner, true);
        return `(&${tmp})`;
      }
      const place = this.structPlace(node);
      if (!place) this.fail(node, `expected a ${t.name}: an object literal or another ${t.name}`);
      if (place.struct !== t.name) this.fail(node, `expected a ${t.name}, got a ${place.struct}`);
      return place.ptr;
    }
    const vt = this.storageValueType(t);
    if (!vt || t.kind === "fstring") this.fail(node, `a ${typeName(t)} key or value is not supported here`);
    const v = this.expect(this.expr(node, vt), vt, node);
    const tmp = this.tmp("rbv");
    if (t.kind === "pubkey") this.line(`SolPubkey ${tmp} = *(${v.c});`);
    else this.line(`${fieldC(t)} ${tmp} = ${v.c};`);
    return `(&${tmp})`;
  }

  /** The value stored in node `idx` (0: none) as an expression result: a nullable reference, or an Option copy. */
  private nodeValue(tree: { local: Local; inst: RbTreeInst; writable: boolean }, idx: string): Value {
    const { inst } = tree;
    const off = 16 + inst.keySize;
    const at = `(ts_rbt_node(&${tree.local.c}, ${inst.stride}, ${idx}) + ${off})`;
    if (inst.valueType.kind === "struct") {
      const p = this.tmp("rbval");
      this.line(`TSS_${inst.valueType.name} *${p} = ${idx} ? (TSS_${inst.valueType.name} *)${at} : NULL;`);
      return { c: p, type: { kind: "structRef", struct: inst.valueType.name, writable: tree.writable, nullable: true } };
    }
    const scalar = inst.valueType as ScalarType;
    this.model.options.set(optionKey(scalar), scalar);
    const o = this.tmp("rbopt");
    this.line(`${optC(scalar)} ${o};`);
    this.line(`${o}.some = ${idx} != 0;`);
    this.line(`if (${idx}) ts_memcpy(&${o}.v, ${at}, ${inst.valueSize}); else ts_memzero(&${o}.v, ${inst.valueSize});`);
    return { c: o, type: { kind: "option", inner: scalar } as ValueType };
  }

  protected treeCall(node: ts.CallExpression): { value: Value | undefined } | undefined {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    this.unbound(callee.expression);
    const tree = this.treeOf(callee.expression);
    if (!tree) return undefined;
    const { inst, local } = tree;
    const t = local.c;
    const S = inst.stride;
    const method = callee.name.text;
    const args = node.arguments;
    const arity = (n: number, form: string) => {
      if (args.length !== n) this.fail(node, `${method}(${form}) takes ${n === 0 ? "no arguments" : form}`);
    };
    const writes = () => {
      if (!tree.writable) this.fail(node, `${method}() changes the tree: make it with rbTreeMutAt`);
      if (this.iteratingTrees.has(t))
        this.fail(
          node,
          `${method}() would change the tree a for … of is walking: collect the keys in the loop, then ${method} after it (as Rust's borrow requires)`,
        );
    };
    switch (method) {
      case "initialize": {
        arity(0, "");
        writes();
        this.line(`ts_rbt_initialize(&${t});`);
        return { value: undefined };
      }
      case "insert": {
        arity(2, "key, value");
        writes();
        // An insert may reuse a freed node or overwrite a value: references into the tree's nodes end here.
        this.assertNotAliased([`@${t}`], node);
        const k = this.treeOperand(args[0]!, inst.keyType);
        const v = this.treeOperand(args[1]!, inst.valueType);
        const r = this.tmp("rbi");
        this.line(`uint32_t ${r};`);
        this.line(`TS_TRY(${inst.c}_insert(params, &${t}, ${k}, ${v}, &${r}));`);
        this.model.options.set("u32", U32);
        const o = this.tmp("rbopt");
        this.line(`${optC(U32)} ${o};`);
        this.line(`${o}.some = ${r} != 0;`);
        this.line(`${o}.v = ${r};`);
        return { value: { c: o, type: { kind: "option", inner: U32 } as ValueType } };
      }
      case "remove":
      case "get":
      case "addrOf": {
        arity(1, "key");
        if (method === "remove") writes();
        const k = this.treeOperand(args[0]!, inst.keyType);
        const r = this.tmp("rbi");
        this.line(`uint32_t ${r};`);
        this.line(`TS_TRY(${inst.c}_${method === "remove" ? "remove" : "find"}(params, &${t}, ${k}, &${r}));`);
        if (method === "addrOf") return { value: { c: r, type: U32 } };
        return { value: this.nodeValue(tree, r) };
      }
      case "removeAt": {
        // remove(key) for a node already found (addrOf, an entry's index): the same writes, no second search.
        arity(1, "index");
        writes();
        const i = this.expect(this.expr(args[0]!, U32), U32, args[0]!);
        const r = this.tmp("rbi");
        this.line(`uint32_t ${r} = ${inst.c}_remove_at(&${t}, ${i.c});`);
        return { value: this.nodeValue(tree, r) };
      }
      case "min":
      case "max": {
        arity(0, "");
        const r = this.tmp("rbi");
        this.line(`uint32_t ${r} = ts_rbt_find_${method}(&${t}, ${S}, TS_RBT_ROOT(${t}.base));`);
        const e = this.tmp("rbe");
        this.line(`TsRbtEntry ${e} = {${r} ? ts_rbt_node(&${t}, ${S}, ${r}) : NULL, ${r}};`);
        return { value: { c: e, type: { kind: "rbEntry", inst: inst.key, writable: tree.writable, nullable: true } } };
      }
      case "nodeAt": {
        arity(1, "index");
        // sokoban's get_node(i): node i whether or not it holds a key; 0 or past the capacity panics as Rust's indexing.
        const i = this.expect(this.expr(args[0]!, U32), U32, args[0]!);
        const r = this.tmp("rbi");
        this.line(`uint32_t ${r} = ${i.c};`);
        const e = this.tmp("rbe");
        this.line(`TsRbtEntry ${e} = {ts_rbt_node(&${t}, ${S}, ${r}), ${r}};`);
        return { value: { c: e, type: { kind: "rbEntry", inst: inst.key, writable: tree.writable } } };
      }
      case "reversed":
        this.fail(node, "reversed() walks the tree from its largest key in a for … of: for (const e of tree.reversed())");
    }
    this.fail(node, `a RedBlackTree has ${TREE_METHODS}, not ${method}()`);
  }

  /** A tree node a property is read on: an entry local, or `e!` / `tree.min()!` (checked), as a TsRbtEntry. */
  private entryOf(node: ts.Expression): { c: string; inst: RbTreeInst; writable: boolean } | undefined {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    let bang = false;
    if (ts.isNonNullExpression(node)) {
      bang = true;
      node = node.expression;
      while (ts.isParenthesizedExpression(node)) node = node.expression;
    }
    let v: Value | undefined;
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l?.type.kind === "rbEntry") v = { c: l.c, type: l.type };
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && this.treeOf(node.expression.expression)) {
      const m = node.expression.name.text;
      if (m === "nodeAt" || (bang && (m === "min" || m === "max"))) v = this.treeCall(node)!.value;
    }
    if (!v || v.type.kind !== "rbEntry") return undefined;
    if (bang && v.type.nullable) this.line(`if (${v.c}.index == 0) TS_FAIL(TS_ERR_UNWRAP, "TypeSOL: the tree is empty");`);
    return { c: v.c, inst: this.model.rbTrees.get(v.type.inst)!, writable: v.type.writable };
  }

  protected viewRef(node: ts.Expression): Ref | undefined {
    // `loadRaw<T>(acct).field`, `loadRawAt<T>(acct, offset).inner.b`: a read-only view read where it is made, its checks
    // made there. A writable view claims its account once per instruction: it is bound to a const instead.
    if (ts.isCallExpression(node)) {
      const fn = this.exportName(node.expression);
      if (fn === "loadRaw" || fn === "loadRawAt") {
        const v = fn === "loadRaw" ? this.loadRaw(node, false) : this.loadRawAt(node, false);
        const struct = (v.type as ValueType & { kind: "structRef" }).struct;
        return { lv: `(*${v.c})`, type: { kind: "struct", name: struct }, writable: false, ...(v.bigCap ? { bigCap: v.bigCap } : {}) };
      }
      if (fn === "loadRawMut" || fn === "loadRawMutAt")
        this.fail(
          node,
          `bind ${fn}(…) to a const first, as a writable view claims its account once per instruction: const v = ${fn}<…>(account${fn === "loadRawMutAt" ? ", offset" : ""})`,
        );
      return undefined;
    }
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      return l?.type.kind === "rawArray" ? this.rawArrayRef(l) : undefined;
    }
    if (ts.isPropertyAccessExpression(node) && (node.name.text === "key" || node.name.text === "value")) {
      const e = this.entryOf(node.expression);
      if (!e) return undefined;
      const { inst } = e;
      if (node.name.text === "key") return { lv: `(*(${fieldC(inst.keyType)} *)(${e.c}.node + 16))`, type: inst.keyType, writable: false };
      return { lv: `(*(${fieldC(inst.valueType)} *)(${e.c}.node + ${16 + inst.keySize}))`, type: inst.valueType, writable: e.writable };
    }
    // `o!` on a tree's get / remove result (a nullable reference), or `tree.get(k)!` itself: checked, then the struct.
    if (ts.isNonNullExpression(node)) {
      let inner = node.expression;
      while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
      let v: Value | undefined;
      if (ts.isIdentifier(inner)) {
        const l = this.lookup(inner.text);
        if (l?.type.kind === "structRef" && l.type.nullable) v = { c: l.c, type: l.type };
      } else if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && this.treeOf(inner.expression.expression)) {
        const m = inner.expression.name.text;
        if (m === "get" || m === "remove" || m === "removeAt") v = this.treeCall(inner)!.value;
      }
      if (!v || v.type.kind !== "structRef") return undefined;
      this.line(`if (${v.c} == NULL) TS_FAIL(TS_ERR_UNWRAP, "TypeSOL: the key is not in the tree");`);
      return { lv: `(*${v.c})`, type: { kind: "struct", name: v.type.struct }, writable: v.type.writable };
    }
    return undefined;
  }

  /** `rbTreeMutAt(…).min()`, `rawArrayAt(…).get(i)`: a view used without binding it. */
  private unbound(node: ts.Expression): void {
    const fn = this.viewFn(node);
    // loadRawAt(…).field reads in place, loadRawMutAt(…).field names its own fix (viewRef).
    if (fn && fn !== "loadRawAt" && fn !== "loadRawMutAt")
      this.fail(node, `bind ${fn}(…) to a const first: const v = ${fn}<…>(account, offset${fn.startsWith("load") ? "" : ", capacity"})`);
  }

  protected viewProperty(node: ts.PropertyAccessExpression): Value | undefined {
    const field = node.name.text;
    // `rbTreeAt(…).length` / `.capacity`: a read-only tree made for the one read.
    let inner: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
    if (this.viewFn(inner) === "rbTreeAt" && (field === "length" || field === "capacity")) {
      const t = this.tmp("rbt");
      this.rbTreeAt(inner as ts.CallExpression, false, t);
      return field === "length" ? { c: `TS_RBT_SIZE(${t}.base)`, type: U64 } : { c: `${t}.cap`, type: U64 };
    }
    this.unbound(node.expression);
    const tree = this.treeOf(node.expression);
    if (tree) {
      if (field === "length") return { c: `TS_RBT_SIZE(${tree.local.c}.base)`, type: U64 };
      if (field === "capacity") return { c: `${tree.local.c}.cap`, type: U64 };
      this.fail(node.name, `a RedBlackTree has ${TREE_METHODS}, not ${field}`);
    }
    if (field === "index") {
      const e = this.entryOf(node.expression);
      if (e) return { c: `${e.c}.index`, type: U32 };
    }
    return undefined;
  }
}
