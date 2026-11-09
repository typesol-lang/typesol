// What to write instead, for the TypeScript errors and the syntax a newcomer to TypeSOL meets first. TypeScript's own
// suggestions (install @types/node, add the dom library, return a Promise) point the wrong way for a Solana program.
import { readFileSync } from "node:fs";
import ts from "typescript";

let libNames: Set<string> | undefined;
/** The functions and values lib/typesol.d.ts exports, so "Cannot find name 'log'" can say where log comes from. */
function typesolExports(libPath: string): Set<string> {
  if (!libNames) {
    libNames = new Set();
    try {
      for (const m of readFileSync(libPath, "utf8").matchAll(/^export declare (?:function|const) (\w+)/gm)) libNames.add(m[1]!);
    } catch {
      // Without the library file there is nothing to suggest.
    }
  }
  return libNames;
}

const MINMAX_HINT = 'Math works on numbers; use min(a, b) and max(a, b) from "typesol", which take bigints';
const BIGINT_HINT = "integers (u64, u32, i64 …) are bigint in TypeSOL: write 1n, not 1, and take u64, not number";

/** A sentence to add to a TypeScript diagnostic, or undefined when TypeScript's own message says enough. */
export function hintForTypeScript(d: ts.Diagnostic, message: string, libPath: string): string | undefined {
  // The whole source line, so a Math.max(…) is seen even when TypeScript marks only the assignment around it.
  let line = "";
  if (d.file && d.start !== undefined) {
    const text = d.file.text;
    const from = text.lastIndexOf("\n", d.start - 1) + 1;
    const to = text.indexOf("\n", d.start);
    line = text.slice(from, to < 0 ? undefined : to);
  }
  // Cannot find name 'x' (2304), with TypeScript's advice to install @types/node (2580, 2591), a test runner's types
  // (2582, 2593) or the dom library (2584).
  const name = /^Cannot find name '([^']+)'/.exec(message)?.[1];
  if (name !== undefined) {
    if (name === "console") return 'a program writes logs with log("…") from "typesol"';
    if (name === "Math") return MINMAX_HINT;
    if (typesolExports(libPath).has(name)) return `import { ${name} } from "typesol"`;
    return undefined;
  }
  switch (d.code) {
    case 2367: // This comparison appears to be unintentional because the types 'bigint' and 'number' have no overlap.
    case 2365: // Operator '+=' cannot be applied to types 'bigint' and 'number'.
    case 2322: // Type 'number' is not assignable to type 'bigint'.
    case 2345: // Argument of type 'bigint' is not assignable to parameter of type 'number'.
      if (/\bMath\.\w+\(/.test(line)) return MINMAX_HINT;
      if (/\bbigint\b/.test(message) && (/\bnumber\b/.test(message) || /'-?\d+'/.test(message))) return BIGINT_HINT;
      return undefined;
    case 7053: // Element implicitly has an 'any' type because expression of type '0' can't be used to index type 'FixedArray<…>'.
    case 7015: // Element implicitly has an 'any' type because index expression is not of type 'number'.
      if (/FixedArray|Vec|FixedVec|FixedString/.test(message))
        return "indexing with [ ] is not supported: use .get(i) and .set(i, value), with i a bigint (0n)";
      return undefined;
    case 1064: // The return type of an async function … must be the global Promise<T> type.
      return "async is not supported: an instruction runs start to finish within one call; remove async";
    case 2540: // Cannot assign to 'x' because it is a read-only property.
      return "to change an account, take it as Mut<T> (Mut<Signer> for a signer whose lamports change)";
    case 2344: // Type 'TokenAccount' does not satisfy the constraint 'StakeProgram | SystemProgram | …'.
      if (/\bprogramAt\s*</.test(line))
        return "programAt<P> takes a program: StakeProgram, SystemProgram, TokenProgram, Token2022Program, TokenInterface, AssociatedTokenProgram or MemoProgram (sysvarAt<StakeHistorySysvar> for the sysvar); read other accounts with loadRaw / loadAccount";
      if (/\bsysvarAt\s*</.test(line)) return "sysvarAt<S> takes StakeHistorySysvar; programs go through programAt<P>";
      return undefined;
    default:
      return undefined;
  }
}

/** Plain words for the syntax kinds the compiler refuses, and what to use instead. */
const SYNTAX: Partial<Record<ts.SyntaxKind, string>> = {
  [ts.SyntaxKind.ClassDeclaration]: "classes are not supported: describe account data with an interface and logic with functions",
  [ts.SyntaxKind.ElementAccessExpression]: "indexing with [ ] is not supported: use .get(i) and .set(i, value) (i is a bigint)",
  [ts.SyntaxKind.TemplateExpression]: "template strings are not supported: log the parts one by one, or use an error enum member for a message",
  [ts.SyntaxKind.SpreadElement]: "spread (...) is not supported: copy the fields one by one",
  [ts.SyntaxKind.ArrayLiteralExpression]: "array literals are only allowed inline as seeds or CPI lists; declare local arrays with fixedArray<T, N>(fill)",
  [ts.SyntaxKind.FunctionExpression]: "function expressions are not supported: declare a function at the top level",
  [ts.SyntaxKind.AwaitExpression]: "await is not supported: an instruction runs start to finish within one call",
  [ts.SyntaxKind.TypeOfExpression]: "typeof is not supported at run time: the types are known when the program compiles",
  [ts.SyntaxKind.DeleteExpression]: "delete is not supported: account fields always exist; set the value instead",
  [ts.SyntaxKind.ModuleDeclaration]: "namespaces are not supported: use separate files and import from them",
};

/** "ClassDeclaration is not supported …" in words a TypeScript developer recognizes. */
export function unsupportedSyntax(kind: ts.SyntaxKind, where: "top level" | "expression"): string {
  const known = SYNTAX[kind];
  if (known) return known;
  return where === "top level"
    ? `this kind of statement (${ts.SyntaxKind[kind]}) is not supported at the top level of a TypeSOL file`
    : `this syntax (${ts.SyntaxKind[kind]}) is not supported in TypeSOL expressions`;
}
