/**
 * Branch probes for the Percolator v16 port's settlement functions (Percolator v16 at commit 7b110913, engine 5e3af07):
 * a copy of showcase/mainnet/percolator-v16/ and of one test fixture, written under .typesol/coverage/ (ignored by
 * git), in which every function of the chosen port files logs a probe when it is entered, every `if` logs one in its
 * then-arm and one in its else-arm (an else-arm is added where the source has none) and every loop logs one when its
 * body runs. A probe is a `log64(0xc0de, id, 0, 0, 0)` call, so the probed program answers exactly as the port does
 * (the same bytes and errors; only its logs and compute units differ) and the probes a transaction reached are read
 * from its log lines, failed transactions included.
 *
 * Not probed: the arms of `?:` and the operands of `&&` and `||` (the port writes most multi-way refusals as one `if`
 * with `||`, so those count as one branch: taken or not), and code outside the chosen files.
 *
 * Used by showcase/test/percolator-v16-primitives.test.ts when PERCOLATOR_V16_COVERAGE names a report file, and by the
 * differential harness (percolator-v16-helpers.ts `Diff`) when PERCOLATOR_V16_PORT_COVERAGE does: then the port program
 * itself is the probed copy, its probe lines are left out of the log comparison and its compute units only recorded.
 *
 * The probed files of the settlement of open legs (layers 2 to 7 of NOTES.md section 10). */
export const SETTLEMENT_FILES = ["primitives.ts", "impairment.ts", "claims.ts", "kfsettle.ts", "settlement.ts"];
/**
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const PORT = path.join(ROOT, "showcase/mainnet/percolator-v16");
export const PROBE_TAG = 0xc0den;

export interface Probe {
  id: number;
  file: string;
  line: number;
  fn: string;
  kind: "entry" | "then" | "else" | "loop";
}

/** The function a node is in: its name, or the enclosing variable's for an arrow. */
function functionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name))
      return n.parent.name.text;
  }
  return "(top level)";
}

/** One file's source with its probes inserted; probes appended to `table`. */
function instrumentFile(file: string, source: string, table: Probe[]): string {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: { at: number; text: string; seq?: number }[] = [];
  const probe = (node: ts.Node, kind: Probe["kind"]): string => {
    const id = table.length;
    table.push({ id, file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, fn: functionName(node), kind });
    return `__cov(${PROBE_TAG}n, ${id}n, 0n, 0n, 0n);`;
  };
  /** A probe as the first statement of `stmt`, wrapping it in a block if it is not one. */
  const into = (stmt: ts.Statement, owner: ts.Node, kind: Probe["kind"], after = "") => {
    const p = probe(owner, kind);
    if (ts.isBlock(stmt)) {
      edits.push({ at: stmt.getStart(sf) + 1, text: ` ${p}` });
      if (after) edits.push({ at: stmt.getEnd(), text: after });
    } else {
      edits.push({ at: stmt.getStart(sf), text: `{ ${p} ` });
      edits.push({ at: stmt.getEnd(), text: ` }${after}` });
    }
  };
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body && ts.isBlock(node.body))
      edits.push({ at: node.body.getStart(sf) + 1, text: ` ${probe(node, "entry")}` });
    if (ts.isIfStatement(node)) {
      if (node.elseStatement) {
        into(node.thenStatement, node, "then");
        into(node.elseStatement, node.elseStatement, "else");
      } else {
        const id = table.length + 1;
        into(node.thenStatement, node, "then", ` else { __cov(${PROBE_TAG}n, ${id}n, 0n, 0n, 0n); }`);
        probe(node, "else");
      }
    }
    if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isForOfStatement(node) || ts.isDoStatement(node)) into(node.statement, node, "loop");
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!edits.length) return source;
  // Applied from the end; of two at one place the earlier one (an enclosing statement's) first, so that the inner
  // one's text ends up before it.
  edits.forEach((e, i) => (e.seq = i));
  edits.sort((a, b) => b.at - a.at || a.seq! - b.seq!);
  let out = source;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  // The probe's import, after the file's head comment.
  const firstImport = sf.statements.find((s) => ts.isImportDeclaration(s));
  const at = firstImport ? firstImport.getStart(sf) : 0;
  return `${out.slice(0, at)}import { log64 as __cov } from "typesol";\n${out.slice(at)}`;
}

/**
 * The probed copy: every port file copied, `files` (names in the port directory) probed, the fixture copied beside it
 * at the same relative place. Returns the copy's fixture path and the probe table.
 */
export function instrumentPort(fixture: string, files: string[]): { fixture: string; probes: Probe[] } {
  // One copy per process: two runs at once (a test file and the binary comparison, say) each build their own.
  const base = path.join(ROOT, ".typesol/coverage", String(process.pid));
  rmSync(base, { recursive: true, force: true });
  process.on("exit", () => rmSync(base, { recursive: true, force: true }));
  const portCopy = path.join(base, "showcase/mainnet/percolator-v16");
  mkdirSync(portCopy, { recursive: true });
  const probes: Probe[] = [];
  for (const name of readdirSync(PORT)) {
    if (!name.endsWith(".ts")) continue;
    const src = readFileSync(path.join(PORT, name), "utf8");
    writeFileSync(path.join(portCopy, name), files.includes(name) ? instrumentFile(name, src, probes) : src);
  }
  const fixtureCopy = path.join(base, path.relative(ROOT, fixture));
  // A fixture outside the port directory is copied beside it; the port's own entry (percolator.ts) is already there.
  if (path.dirname(fixture) !== PORT) {
    mkdirSync(path.dirname(fixtureCopy), { recursive: true });
    cpSync(fixture, fixtureCopy);
  }
  return { fixture: fixtureCopy, probes };
}

/** The probe ids a transaction's log lines show. */
export function probesInLogs(logs: string[], hit: Map<number, number>): void {
  const tag = `Program log: 0x${PROBE_TAG.toString(16)}, 0x`;
  for (const l of logs) {
    if (!l.startsWith(tag)) continue;
    const id = Number.parseInt(l.slice(tag.length).split(",")[0]!, 16);
    hit.set(id, (hit.get(id) ?? 0) + 1);
  }
}

/** A report per function: probes reached / probes, and each probe never reached with its line. */
export function coverageReport(probes: Probe[], hit: Map<number, number>): string {
  const byFn = new Map<string, Probe[]>();
  for (const p of probes) {
    const k = `${p.file} ${p.fn}`;
    byFn.set(k, [...(byFn.get(k) ?? []), p]);
  }
  const lines: string[] = [];
  let total = 0;
  let reached = 0;
  for (const [k, ps] of byFn) {
    const missed = ps.filter((p) => !hit.has(p.id));
    total += ps.length;
    reached += ps.length - missed.length;
    const entry = ps.find((p) => p.kind === "entry");
    const calls = entry ? (hit.get(entry.id) ?? 0) : 0;
    lines.push(`${k}: ${ps.length - missed.length}/${ps.length} probes, entered ${calls} times`);
    for (const p of missed) lines.push(`    not reached: ${p.kind} at ${p.file}:${p.line}`);
  }
  return [`${reached}/${total} probes reached`, ...lines].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--build") {
    // `coverage.ts --build <a.ts,b.ts,…> <out-dir>`: the probed port built to <out-dir>/percolator.so, its probe table
    // in <out-dir>/probes.json (for a run of the author's suite with TRACE=1 and PERCOLATOR_TRACE_PROBES=1, read by
    // author-trace-compare.ts --coverage).
    const files = process.argv[3]!.split(",");
    const out = process.argv[4]!;
    mkdirSync(out, { recursive: true });
    const { build } = await import(path.join(ROOT, "dist/compiler/index.js"));
    const c = instrumentPort(path.join(PORT, "percolator.ts"), files);
    const r = build(c.fixture, out, "Perco1ator111111111111111111111111111111111");
    writeFileSync(path.join(out, "probes.json"), JSON.stringify(c.probes));
    console.log(`${r.soPath}: ${c.probes.length} probes (${r.manifest.clang})`);
  } else {
    // Print the probed copy of one file to check the instrumentation by eye.
    const name = process.argv[2] ?? "impairment.ts";
    const probes: Probe[] = [];
    console.log(instrumentFile(name, readFileSync(path.join(PORT, name), "utf8"), probes));
    console.error(`${probes.length} probes`);
  }
}
