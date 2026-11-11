// The figures docs/audit.md and docs/architecture.md quote about the code, computed from this checkout:
//   node scripts/audit-stats.ts          rewrite them (and the version and month the line counts are "at")
//   node scripts/audit-stats.ts --check  fail when a figure is out of date (test/cli/audit-stats.test.ts runs this)
// Lines are counted as `wc -l` counts them. In docs/audit.md's scope table, a row's Files cell names its files: the
// first with its path, the others relative to the first's directory (`src/compiler/emit/alias.ts`, `storage.ts`); a
// row that names a directory has no line count. The check compares the numbers only, so a release does not have to
// rewrite the doc unless a figure moved.
import { readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT = "docs/audit.md";
const ARCHITECTURE = "docs/architecture.md";

const lines = (rel: string): number => {
  const text = readFileSync(path.join(ROOT, rel), "utf8");
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
};
const fmt = (n: number) => n.toLocaleString("en-US");
const tsFiles = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : [],
  );

/** A Files cell's files, or undefined when it names a directory (no line count). */
function cellFiles(cell: string): string[] | undefined {
  const names = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  if (!names.length) return undefined;
  const dir = path.posix.dirname(names[0]!);
  const files = names.map((n, i) => (i === 0 || n.includes("/") ? n : `${dir}/${n}`));
  for (const f of files) {
    let isFile = false;
    try {
      isFile = statSync(path.join(ROOT, f)).isFile();
    } catch {
      throw new Error(`${AUDIT}: ${f} (in "${cell.trim()}") does not exist`);
    }
    if (!isFile) return undefined;
  }
  return files;
}

/** The docs with every figure recomputed; `stamp` replaces the version and month the counts are "at". */
export function auditDocs(stamp?: { version: string; month: string }): Record<string, string> {
  let audit = readFileSync(path.join(ROOT, AUDIT), "utf8");
  // The scope table: | Priority | Component | Files | Lines | Why |
  audit = audit.replace(
    /^(\| [^|\n]+ \| [^|\n]+ \| )([^|\n]+)( \| )([^|\n]*)( \| [^\n]*\|)$/gm,
    (row, a: string, files: string, b: string, count: string, rest: string) => {
      if (/^Files$|^---/.test(files.trim())) return row;
      const list = cellFiles(files);
      return `${a}${files}${b}${list ? fmt(list.reduce((n, f) => n + lines(f), 0)) : ""}${rest}`;
    },
  );
  audit = audit.replace(/(`lib\/typesol\.d\.ts` \()[\d,]+( lines\))/, (_, a: string, b: string) => `${a}${fmt(lines("lib/typesol.d.ts"))}${b}`);
  if (stamp) audit = audit.replace(/Line counts at [^ ]+ \([^)]+\)\./, `Line counts at ${stamp.version} (${stamp.month}).`);
  // The compiler as a whole, rounded to the thousand (prose, not a table).
  const compiler = tsFiles("src/compiler").reduce((n, f) => n + lines(f), 0);
  const architecture = readFileSync(path.join(ROOT, ARCHITECTURE), "utf8").replace(
    /the compiler's [\d,]+ lines/,
    `the compiler's ${fmt(Math.round(compiler / 1000) * 1000)} lines`,
  );
  return { [AUDIT]: audit, [ARCHITECTURE]: architecture };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const stale: string[] = [];
    for (const [file, text] of Object.entries(auditDocs())) {
      const now = readFileSync(path.join(ROOT, file), "utf8").split("\n");
      text.split("\n").forEach((l, i) => {
        if (l !== now[i]) stale.push(`${file}:${i + 1}\n  now:    ${now[i]}\n  wanted: ${l}`);
      });
    }
    if (stale.length) {
      console.error(`out of date (run node scripts/audit-stats.ts):\n${stale.join("\n")}`);
      process.exit(1);
    }
  } else {
    const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
    const month = new Date().toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    for (const [file, text] of Object.entries(auditDocs({ version, month }))) writeFileSync(path.join(ROOT, file), text);
  }
}
