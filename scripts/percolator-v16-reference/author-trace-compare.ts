/**
 * Compares two runs of the author's suite of Percolator v16 at commit 7b110913 (engine 5e3af07) recorded with
 * `TRACE=1 scripts/percolator-v16-reference/author-suite.sh` (one against the reference binary built from the author's
 * source, not a deployed program; one against the port), transaction by transaction, test by test.
 *
 *   node scripts/percolator-v16-reference/author-trace-compare.ts <reference-results>/trace <port-results>/trace
 *     [--expect <file>] [--list] [--filtered] [--coverage <probes.json>]
 *
 * Each `<test>.trace` holds one line per transaction the test sent (trace/send_transaction.rs): the instructions'
 * programs and tags, a hash of the instructions and keys, the result, hashes of the return data, of the log lines (the
 * compute-unit lines left out) and of every named account after the transaction, and its compute units. Two lines
 * agree when every field agrees but the compute units. Every aligned pair of lines is compared, and every difference
 * in a test is classed (not only its first):
 *
 * - `reference-over-limit`: the same transaction, the reference exhausted its compute budget (ProgramFailedToComplete
 *   or ComputationalBudgetExceeded), the port succeeded, and the port's test sent nothing more (it failed there);
 * - `inputs differ`: the transactions themselves differ (the test chose what to send from something that differed
 *   before, such as compute units, or from its own randomness);
 * - `outcome differs`: the same transaction gave a different result, return data, log or account state;
 * - `one run sent more`: one side's test stopped (failed) or went on where the other did not (a test whose last
 *   aligned difference is `reference-over-limit` has this by definition: it is not classed again);
 * - `trace on one side only`.
 *
 * A test's differences are expected when every class found in it is listed for that test (one `trace` row per class)
 * and every class listed for it was found; anything else fails the comparison.
 *
 * `main.trace` holds the transactions of threads without a name (the author's bounded-frontier tests replay their
 * words on worker threads, std::thread::scope); their order between threads is not fixed, so main.trace is compared
 * as a multiset of lines (each line with the compute units left out). Equal lines (the same instructions, keys, result,
 * return data, logs and accounts after) cannot be told apart, so which reference line goes with which port line is not
 * known: where every equal line on each side has the same compute units, any pairing gives the same judgement; where
 * the units vary within a group (on either side), each of the port's lines is judged against the group's cheapest
 * reference line, which can only count more excesses than the true pairing, never fewer. Totals do not depend on the
 * pairing.
 *
 * Also counted: transactions compared, identical, different; successes in both, and among identical successes those
 * where the port used more compute units than the reference (whole transactions, the compute-budget instructions
 * included), by the first Percolator instruction of the transaction.
 *
 * The exit status is 1 when either directory holds no trace, a line cannot be read, nothing was compared, or anything
 * differs that the expectations file (default: author-suite-expected.tsv next to this script; kinds `trace` and `cu`)
 * does not list; and also when a listed difference or compute-unit excess was not observed (with `--filtered`, for runs
 * filtered by TEST_FILTER, only where the runs reached that test). `--coverage
 * <probes.json>`: the port's run used a probed port (`coverage.ts --build`, PERCOLATOR_TRACE_PROBES=1); its compute
 * units are then not compared, and the probes its transactions reached are reported per function.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coverageReport, type Probe } from "./coverage.ts";

interface Row {
  key: string;
  ix: string;
  res: string;
  cu: bigint;
  probes: string;
  raw: string;
}

const LINE = /^(\S*) ix=(\S+) res=(\S+) ret=(\S+) logs=(\S+) accs=(\S+) cu=(\d+)(?: probes=(\S*))?$/;

function parse(file: string, n: number, line: string): Row {
  const m = LINE.exec(line);
  if (!m) throw new Error(`${file}:${n + 1}: unreadable trace line: ${line.slice(0, 200)}`);
  const raw = line.replace(/ probes=\S*$/, "");
  return { key: raw.replace(/ cu=\d+$/, ""), ix: m[2]!, res: m[3]!, cu: BigInt(m[7]!), probes: m[8] ?? "", raw };
}

function read(dir: string, name: string): Row[] | undefined {
  const f = path.join(dir, name);
  if (!existsSync(f)) return undefined;
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l, i) => parse(f, i, l));
}

function firstTag(key: string): string {
  return /(?:^|,)(Perc:\d+),/.exec(key.split(" ")[0]! + ",")?.[1] ?? "";
}

function overLimit(res: string): boolean {
  return /ProgramFailedToComplete|ComputationalBudgetExceeded/.test(res);
}

const testName = (file: string) => file.replace(/\.trace$/, "");
// libtest names threads after the test (a::b::c); the trace file name replaces every other character by '.' and a
// name longer than 200 characters by its first 180 and its FNV-1a hash (trace/send_transaction.rs).
function fileKey(test: string): string {
  const name = test.replace(/[^A-Za-z0-9_]/g, ".");
  if (name.length <= 200) return name;
  let h = 0xcbf29ce484222325n;
  for (const c of Buffer.from(name)) h = ((h ^ BigInt(c)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return `${name.slice(0, 180)}-${h.toString(16).padStart(16, "0")}`;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const probesFile = option("--coverage");
const expectFile = option("--expect") ?? path.join(HERE, "author-suite-expected.tsv");
const list = args.includes("--list");
// --filtered: the runs were filtered (TEST_FILTER): a listed difference or excess whose test or instruction the runs
// did not reach is then not required.
const filtered = args.includes("--filtered");
const positional = args.filter((a, i) => !a.startsWith("--") && !["--coverage", "--expect"].includes(args[i - 1] ?? ""));
const [refDir, portDir] = positional;
if (!refDir || !portDir) {
  console.error("usage: author-trace-compare.ts <reference trace dir> <port trace dir> [--expect <file>] [--list] [--coverage <probes.json>]");
  process.exit(2);
}

const failures: string[] = [];
// Per test, the classes of difference listed for it (one row each), and whether each was found.
const traceAllowed = new Map<string, Map<string, { reason: string; seen: boolean }>>();
const cuAllowed = new Map<string, { reason: string; seen: number }>();
for (const line of readFileSync(expectFile, "utf8").split("\n")) {
  if (line.startsWith("#") || line.trim() === "") continue;
  const [kind, binary, , name, reason] = line.split("\t");
  if (kind === "trace") {
    const key = fileKey(name!);
    const kinds = traceAllowed.get(key) ?? new Map<string, { reason: string; seen: boolean }>();
    kinds.set(binary!, { reason: reason!, seen: false });
    traceAllowed.set(key, kinds);
  } else if (kind === "cu") cuAllowed.set(name!, { reason: reason!, seen: 0 });
}

function traces(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    failures.push(`${dir}: not a directory`);
    return [];
  }
  const names = readdirSync(dir).filter((n) => n.endsWith(".trace"));
  if (names.length === 0) failures.push(`${dir}: no trace files`);
  return names;
}
const names = [...new Set([...traces(refDir), ...traces(portDir)])].sort();

let compared = 0;
let identicalTx = 0;
let differentTx = 0;
let unmatched = 0;
let bothOk = 0;
let refCuTotal = 0n;
let portCuTotal = 0n;
let identicalTests = 0;
let ambiguousGroups = 0;
const hit = new Map<number, number>();
const above = new Map<string, { n: number; worst: { name: string; i: number; ref: bigint; port: bigint } }>();
const differences: { name: string; cls: string; text: string; allowed?: string }[] = [];

/** `judgeRef`: the reference's units the port's are judged against (main.trace's ambiguous groups: the cheapest). */
function pair(name: string, i: number, r: Row, p: Row, judgeRef: bigint = r.cu): boolean {
  compared++;
  const same = r.key === p.key;
  if (same) identicalTx++;
  else differentTx++;
  if (same && r.res === "ok") {
    bothOk++;
    refCuTotal += r.cu;
    portCuTotal += p.cu;
    const tag = firstTag(r.key);
    if (!probesFile && tag && p.cu > judgeRef) {
      const a = above.get(tag) ?? { n: 0, worst: { name, i, ref: judgeRef, port: p.cu } };
      a.n++;
      if (p.cu - judgeRef > a.worst.port - a.worst.ref) a.worst = { name, i, ref: judgeRef, port: p.cu };
      above.set(tag, a);
    }
  }
  return same;
}

for (const name of names) {
  const a = read(refDir, name);
  const b = read(portDir, name);
  for (const row of b ?? [])
    for (const id of row.probes ? row.probes.split(",") : []) {
      const k = Number.parseInt(id, 16);
      hit.set(k, (hit.get(k) ?? 0) + 1);
    }
  if (!a || !b) {
    differences.push({ name, cls: "trace on one side only", text: `${a ? "reference" : "port"} only, ${(a ?? b)!.length} transactions` });
    unmatched += (a ?? b)!.length;
    continue;
  }
  if (name === "main.trace") {
    // A multiset: lines sorted by everything but the compute units, then each group of equal lines matched (the
    // file's head says how their compute units are judged).
    const sort = (rows: Row[]) => [...rows].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.cu < y.cu ? -1 : x.cu > y.cu ? 1 : 0));
    const ra = sort(a);
    const rb = sort(b);
    let i = 0;
    let j = 0;
    const onlyRef: string[] = [];
    const onlyPort: string[] = [];
    while (i < ra.length || j < rb.length) {
      if (i < ra.length && j < rb.length && ra[i]!.key === rb[j]!.key) {
        const key = ra[i]!.key;
        let ie = i;
        let je = j;
        while (ie < ra.length && ra[ie]!.key === key) ie++;
        while (je < rb.length && rb[je]!.key === key) je++;
        // Sorted by compute units within the group: one value per side when first and last agree.
        const ambiguous = ra[i]!.cu !== ra[ie - 1]!.cu || rb[j]!.cu !== rb[je - 1]!.cu;
        if (ambiguous) ambiguousGroups++;
        const cheapest = ra[i]!.cu;
        for (; i < ie && j < je; i++, j++) pair(name, i, ra[i]!, rb[j]!, ambiguous ? cheapest : ra[i]!.cu);
        // One side's surplus of equal lines.
        while (i < ie) onlyRef.push(ra[i++]!.raw);
        while (j < je) onlyPort.push(rb[j++]!.raw);
      } else if (j >= rb.length || (i < ra.length && ra[i]!.key < rb[j]!.key)) onlyRef.push(ra[i++]!.raw);
      else onlyPort.push(rb[j++]!.raw);
    }
    unmatched += onlyRef.length + onlyPort.length;
    if (onlyRef.length + onlyPort.length === 0) identicalTests++;
    else
      differences.push({
        name,
        cls: "unnamed threads' transactions differ",
        text: `${onlyRef.length} lines only in the reference's, ${onlyPort.length} only in the port's\n    reference: ${onlyRef.slice(0, 3).join("\n               ")}\n    port:      ${onlyPort.slice(0, 3).join("\n               ")}`,
      });
    continue;
  }
  // Every aligned difference classed; the first of each class shown.
  const found = new Map<string, { n: number; text: string }>();
  const n = Math.min(a.length, b.length);
  let lastClass = "";
  for (let i = 0; i < n; i++) {
    const r = a[i]!;
    const p = b[i]!;
    if (pair(name, i, r, p)) continue;
    let cls: string;
    if (r.ix !== p.ix) cls = "inputs differ";
    else if (overLimit(r.res) && p.res === "ok" && b.length === i + 1) cls = "reference-over-limit";
    else cls = "outcome differs";
    lastClass = cls;
    const f = found.get(cls) ?? { n: 0, text: `transaction ${i}\n    reference: ${r.raw}\n    port:      ${p.raw}` };
    f.n++;
    found.set(cls, f);
  }
  unmatched += Math.abs(a.length - b.length);
  // A different count of transactions, unless the last aligned difference is the reference over its limit (whose
  // definition is that the port's test stopped there).
  if (a.length !== b.length && lastClass !== "reference-over-limit")
    found.set("one run sent more", { n: 1, text: `reference ${a.length}, port ${b.length} transactions` });
  if (found.size === 0) {
    identicalTests++;
    continue;
  }
  const extra = a.length !== b.length ? `; reference ${a.length}, port ${b.length} transactions` : "";
  const allow = traceAllowed.get(testName(name));
  for (const [cls, f] of found) {
    const listed = allow?.get(cls);
    const count = cls === "one run sent more" ? "" : `\n    ${f.n} of ${n} aligned transactions differ in this way${extra}`;
    if (listed) listed.seen = true;
    differences.push({ name, cls, text: `${f.text}${count}`, allowed: listed?.reason });
  }
}

console.log(
  `tests with a trace: ${names.length} (main.trace, the unnamed threads', among them: ${names.includes("main.trace") ? "yes" : "no"}); identical throughout: ${identicalTests}`,
);
console.log(`transactions compared: ${compared}; identical: ${identicalTx}; different: ${differentTx}; on one side only: ${unmatched}`);
if (names.includes("main.trace"))
  console.log(`main.trace: ${ambiguousGroups} groups of equal lines whose compute units vary (judged against their cheapest reference line)`);
console.log(`succeeding identically in both: ${bothOk}; compute units over those: reference ${refCuTotal}, port ${portCuTotal}`);
for (const d of differences) {
  console.log(`${d.allowed ? "expected" : "UNEXPECTED"} ${d.cls}\t${testName(d.name)}\t${d.text}`);
  if (d.allowed) console.log(`    listed: ${d.allowed}`);
  else failures.push(`${testName(d.name)}: ${d.cls}`);
}
if (!probesFile) {
  for (const [tag, a] of [...above].sort()) {
    const allow = cuAllowed.get(tag);
    if (allow) allow.seen = a.n;
    console.log(
      `${allow ? "expected" : "UNEXPECTED"} port above the reference: ${tag} on ${a.n} identical successes (largest: ${testName(a.worst.name)} transaction ${a.worst.i}, reference ${a.worst.ref}, port ${a.worst.port})`,
    );
    if (!allow) failures.push(`port above the reference on ${tag}`);
    else if (list) console.log(`    listed: ${allow.reason}`);
  }
  if (!filtered) for (const [tag, allow] of cuAllowed) if (allow.seen === 0) failures.push(`listed compute-unit excess not observed: ${tag}`);
}
for (const [test, kinds] of traceAllowed)
  for (const [kind, allow] of kinds)
    if (!allow.seen && !(filtered && !names.includes(`${test}.trace`))) failures.push(`listed trace difference not observed: ${test} (${kind})`);
if (compared === 0) failures.push("no transaction compared");
if (probesFile) {
  const probes = JSON.parse(readFileSync(probesFile, "utf8")) as Probe[];
  console.log(coverageReport(probes, hit));
}
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("trace comparison: every difference is listed and every listed one was observed");
