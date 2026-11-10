import { type FieldType, type ProgramModel, type RbTreeInst, INT_INFO } from "../model.js";
import { fieldC, scalarC } from "./shared.js";

/**
 * The C functions of each RedBlackTree instance (`rbTreeAt<K, V>(…, compare?)`): its key order, and lib-sokoban 0.3's
 * get_addr, _insert and _remove over runtime/typesol_rt.h's structural functions (ts_rbt_*), with the node stride a
 * constant. Each returns SUCCESS or the error a comparator helper failed with; results go through `out`.
 */
export function emitRbTrees(model: ProgramModel): string[] {
  const out: string[] = [];
  for (const t of model.rbTrees.values()) out.push(...emitTree(model, t));
  return out;
}

function emitTree(model: ProgramModel, t: RbTreeInst): string[] {
  const K = fieldC(t.keyType);
  const V = fieldC(t.valueType);
  const S = t.stride;
  const ks = t.keySize;
  const vs = t.valueSize;
  const p = t.c;
  const cmp = t.compare ? helperCompare(t) : defaultCompare(model, t.keyType);
  return [
    `/* RedBlackTree<${t.key.split("|").slice(0, 2).join(", ")}>: lib-sokoban 0.3, stride ${S}${t.compare ? `, ordered by ${t.compare.display}` : ""} */`,
    `static inline __attribute__((always_inline)) uint64_t ${p}_cmp(TsParams *params, const ${K} *a, const ${K} *b, int *out) {`,
    `  (void)params;`,
    ...cmp.map((l) => `  ${l}`),
    `}`,
    `/* get_addr: the node holding \`key\`, or 0. */`,
    `static __attribute__((noinline, unused)) uint64_t ${p}_find(TsParams *params, const TsRbt *t, const ${K} *key, uint32_t *out) {`,
    `  uint32_t i = TS_RBT_ROOT(t->base);`,
    `  while (i != 0) {`,
    `    int c;`,
    `    TS_TRY(${p}_cmp(params, key, (const ${K} *)(ts_rbt_node(t, ${S}, i) + 16), &c));`,
    `    if (c == 0) break;`,
    `    i = ts_rbt_reg(t, ${S}, i, c < 0 ? TS_RBT_LEFT : TS_RBT_RIGHT);`,
    `  }`,
    `  *out = i;`,
    `  return SUCCESS;`,
    `}`,
    `/* _insert: the node now holding \`key\` (an equal key keeps its node and takes the value), or 0 when a new key finds the tree full. */`,
    `static __attribute__((noinline, unused)) uint64_t ${p}_insert(TsParams *params, const TsRbt *t, const ${K} *key, const ${V} *value, uint32_t *out) {`,
    `  uint32_t parent = TS_RBT_ROOT(t->base);`,
    `  if (parent == 0) {`,
    `    uint32_t i = ts_rbt_add_node(t, ${S}, key, ${ks}, value, ${vs});`,
    `    TS_RBT_ROOT(t->base) = i;`,
    `    *out = i;`,
    `    return SUCCESS;`,
    `  }`,
    `  for (;;) {`,
    `    int c;`,
    `    TS_TRY(${p}_cmp(params, key, (const ${K} *)(ts_rbt_node(t, ${S}, parent) + 16), &c));`,
    `    if (c == 0) {`,
    `      ts_memcpy(ts_rbt_node(t, ${S}, parent) + ${16 + ks}, value, ${vs});`,
    `      *out = parent;`,
    `      return SUCCESS;`,
    `    }`,
    `    uint32_t dir = c < 0 ? TS_RBT_LEFT : TS_RBT_RIGHT;`,
    `    uint32_t target = ts_rbt_reg(t, ${S}, parent, dir);`,
    `    if (target == 0) {`,
    `      if (TS_RBT_SIZE(t->base) >= t->cap) {`,
    `        *out = 0;`,
    `        return SUCCESS;`,
    `      }`,
    `      uint32_t i = ts_rbt_add_node(t, ${S}, key, ${ks}, value, ${vs});`,
    `      ts_rbt_link_leaf(t, ${S}, parent, i, dir);`,
    `      *out = i;`,
    `      return SUCCESS;`,
    `    }`,
    `    parent = target;`,
    `  }`,
    `}`,
    `/* _remove: the node that held \`key\` (now free, its key and value bytes as they were), or 0. */`,
    `static __attribute__((noinline, unused)) uint64_t ${p}_remove(TsParams *params, const TsRbt *t, const ${K} *key, uint32_t *out) {`,
    `  uint32_t i;`,
    `  TS_TRY(${p}_find(params, t, key, &i));`,
    `  if (i != 0) ts_rbt_remove_node(t, ${S}, i);`,
    `  *out = i;`,
    `  return SUCCESS;`,
    `}`,
    `/* removeAt: node \`i\` unlinked and freed as _remove frees the node it finds; 0 (nothing written) for index 0 or a node`,
    `   in no tree (not the root, no parent: a freed or never used one). Past the capacity panics as get_node does. */`,
    `static __attribute__((noinline, unused)) uint32_t ${p}_remove_at(const TsRbt *t, uint32_t i) {`,
    `  if (i == 0 || (TS_RBT_ROOT(t->base) != i && ts_rbt_reg(t, ${S}, i, TS_RBT_PARENT) == 0)) return 0;`,
    `  ts_rbt_remove_node(t, ${S}, i);`,
    `  return i;`,
    `}`,
    ``,
  ];
}

/** A comparator helper `(a: K, b: K) => int`: called as compare(searched, nodeKey), its sign the order. */
function helperCompare(t: RbTreeInst): string[] {
  const h = t.compare!;
  const arg = (side: "a" | "b") => {
    const pt = h.params[0]!.type;
    if (pt.kind === "structRef") return `(TSS_${pt.struct} *)${side}`;
    if (pt.kind === "pubkey") return `*${side}`;
    if (pt.kind === "bool") return `(*${side} != 0)`;
    return `*${side}`;
  };
  const ret = h.returns as { kind: "int"; name: keyof typeof INT_INFO };
  return [
    `${scalarC(ret)} r;`,
    `TS_TRY(fn_${h.name}(params, ${arg("a")}, ${arg("b")}, &r));`,
    // Signed: an unsigned result is refused where the tree is made (views.ts), as it could never say "less".
    `*out = r < 0 ? -1 : r > 0 ? 1 : 0;`,
    `return SUCCESS;`,
  ];
}

/** The default order: Rust's derived Ord, field by field in declaration order (integers by value, Pubkeys bytewise). */
function defaultCompare(model: ProgramModel, key: FieldType): string[] {
  const lines: string[] = [];
  let n = 0;
  const walk = (t: FieldType, a: string, b: string) => {
    switch (t.kind) {
      case "int":
      case "bool":
      case "enum":
        lines.push(`if (${a} != ${b}) {`, `  *out = ${a} < ${b} ? -1 : 1;`, `  return SUCCESS;`, `}`);
        return;
      case "pubkey": {
        const c = `k${n++}`;
        lines.push(`int64_t ${c} = ts_key_cmp(&${a}, &${b});`, `if (${c} != 0) {`, `  *out = (int)${c};`, `  return SUCCESS;`, `}`);
        return;
      }
      case "struct":
        for (const f of model.structs.get(t.name)!.fields) walk(f.type, `${a}.${f.name}`, `${b}.${f.name}`);
        return;
      case "array":
        for (let i = 0; i < t.len; i++) walk(t.elem, `${a}[${i}]`, `${b}[${i}]`);
        return;
      default:
        throw new Error(`unreachable: no default order for ${t.kind}`);
    }
  };
  walk(key, "(*a)", "(*b)");
  lines.push(`*out = 0;`, `return SUCCESS;`);
  return lines;
}
