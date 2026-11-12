import ts from "typescript";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  /** Characters the problem spans from line:column (the construct refused), when known. */
  length?: number;
  /** What to write instead, when known (also the message's last line, "hint: …"): for tools and AI agents. */
  hint?: string;
}

export class CompileError extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super(diagnostics.map(formatDiagnostic).join("\n"));
    this.name = "CompileError";
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}:${d.line}:${d.column} - error: ${d.message}`;
}

/** Copies of a type alias's nodes put in place of one use of it, with that use (see substituteAliases). */
const aliasUses = new WeakMap<ts.Node, ts.Node>();

export function markAliasUse(copy: ts.Node, use: ts.Node): void {
  aliasUses.set(copy, use);
}

export function diagnosticAt(node: ts.Node, message: string, hint?: string): Diagnostic {
  // A problem with an aliased type is reported where the alias is used.
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    const use = aliasUses.get(n);
    if (use) {
      node = use;
      break;
    }
  }
  const sf = node.getSourceFile();
  const start = node.getStart(sf);
  const { line, character } = sf.getLineAndCharacterOfPosition(start);
  const length = Math.max(1, node.getEnd() - start);
  if (!hint) return { file: sf.fileName, line: line + 1, column: character + 1, message, length };
  return { file: sf.fileName, line: line + 1, column: character + 1, message: `${message}\nhint: ${hint}`, length, hint };
}

/** Collects diagnostics; `fail` records one and throws to unwind the current construct. */
export class Reporter {
  readonly diagnostics: Diagnostic[] = [];

  /** `hint`: what to write instead, shown as the message's last line ("hint: …") and given to tools as `hint`. */
  error(node: ts.Node, message: string, hint?: string): void {
    this.diagnostics.push(diagnosticAt(node, message, hint));
  }

  fail(node: ts.Node, message: string, hint?: string): never {
    this.error(node, message, hint);
    throw new Bail();
  }

  /** Run `fn`, swallowing a `fail` so analysis can continue with the next construct. */
  guard<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      if (e instanceof Bail) return undefined;
      throw e;
    }
  }

  throwIfAny(): void {
    if (this.diagnostics.length > 0) throw new CompileError(this.diagnostics);
  }
}

class Bail extends Error {}
