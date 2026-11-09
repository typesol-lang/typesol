/**
 * Reading generated C, for moving a loop into a function of its own (StatementEmitter.outlinedLoop): which names a
 * piece of C uses, which it declares itself, and which are the runtime's, so that every other name it uses is one
 * of the caller's variables the new function has to be given.
 */

/** Identifiers, numbers and punctuation of `c`, without comments, string and character literals. */
export function cTokens(c: string): string[] {
  const bare = c.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, " 0 ");
  return bare.match(/[A-Za-z_]\w*|\d\w*|->|\S/g) ?? [];
}

const isIdent = (t: string | undefined) => t !== undefined && /^[A-Za-z_]/.test(t);

/** C keywords (and the type words of declarations, which never name a variable). */
const KEYWORDS = new Set(
  (
    "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short " +
    "signed sizeof static struct switch typedef union unsigned void volatile while _Bool _Static_assert __attribute__ __asm__ __typeof__"
  ).split(" "),
);

/** The names the C uses as variables or functions (not the fields after `.` or `->`). */
export function usedNames(toks: string[]): Set<string> {
  const out = new Set<string>();
  toks.forEach((t, i) => {
    if (isIdent(t) && !KEYWORDS.has(t) && toks[i - 1] !== "." && toks[i - 1] !== "->") out.add(t);
  });
  return out;
}

/**
 * The variables and labels the C declares: `T x = …;`, `T *x, *y = …;`, `T x[n];`, a `for (T i = …;` and `label:`.
 * A declaration starts a statement, so a name it misses is only taken for one of the caller's (and the loop then
 * stays where it is).
 */
export function declaredNames(toks: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < toks.length; i++) {
    const prev = toks[i - 1];
    const start = i === 0 || prev === ";" || prev === "{" || prev === "}" || (prev === "(" && toks[i - 2] === "for");
    if (!start || !isIdent(toks[i])) continue;
    if (toks[i + 1] === ":" && !KEYWORDS.has(toks[i]!)) {
      out.add(toks[i]!);
      continue;
    }
    let j = i;
    while (toks[j] === "const" || toks[j] === "static" || toks[j] === "struct" || toks[j] === "unsigned") j++;
    if (!isIdent(toks[j]) || KEYWORDS.has(toks[j]!)) continue;
    j++; // the type
    for (;;) {
      while (toks[j] === "*" || toks[j] === "const") j++;
      const name = toks[j];
      const after = toks[j + 1];
      if (!isIdent(name) || KEYWORDS.has(name!) || !["=", ";", "[", ",", ")"].includes(after!)) break;
      out.add(name!);
      // Past this declarator's initializer, to the next one (a comma at depth 0) or the statement's end.
      j++;
      let depth = 0;
      while (j < toks.length) {
        const t = toks[j]!;
        if (t === "(" || t === "[" || t === "{") depth++;
        else if (t === ")" || t === "]" || t === "}") {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && (t === "," || t === ";")) break;
        j++;
      }
      if (toks[j] !== ",") break;
      j++;
    }
  }
  return out;
}

/**
 * Names that are the runtime's or the SDK's, never one of a function's variables: runtime functions and macros,
 * generated types and constants, helpers (`fn_…`), syscalls, other loops' functions. The emitter's own temporaries
 * with a `ts_` prefix are labels (`ts_continue_12`), which a loop declares itself.
 */
export function isGlobalName(n: string): boolean {
  return (
    /^(?:ts_(?!\w*_\d+$)|TS_|TSS_|TSE_|TSV_|TSK_|TSF_|TSW_|Ts[A-Z]|fn_|sol_|Sol[A-Z]|SOL_|__builtin_)/.test(n) ||
    /^(?:SUCCESS|NULL|true|false|abort|bool|u?int(?:8|16|32|64)_t|__u?int128_t|size_t)$/.test(n) ||
    /^(?:fn|ix)_\w+__loop\d+$/.test(n) // a loop inside the loop, moved out first
  );
}

/** A C parameter list (`TsParams *params, uint64_t p_rest`) as name → declaration. */
export function parameterDecls(signature: string): Map<string, string> {
  const inner = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  const out = new Map<string, string>();
  for (const p of inner.split(",")) {
    const decl = p.trim();
    const name = decl.match(/(\w+)\s*$/)?.[1];
    if (name) out.set(name, decl);
  }
  return out;
}
