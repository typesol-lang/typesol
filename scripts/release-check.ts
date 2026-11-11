/**
 * The release check: builds the npm tarball of a tagged release from a clean copy of the tag, and records what it
 * holds, so the tarball that is published is the one that was checked and anyone can compare it with the registry.
 *
 *   node scripts/release-check.ts 0.44.0                       check v0.44.0 and pack it → releases/0.44.0.json
 *   node scripts/release-check.ts 0.44.0 --tests               the same, with the test suite (long; off by default)
 *   node scripts/release-check.ts 0.44.0 --verify --registry   compare the record with `npm view … dist`
 *   node scripts/release-check.ts 0.44.0 --verify --shasum <sha1> [--integrity <sha512-…>]
 *   node scripts/release-check.ts 0.44.0 --verify --tarball <file.tgz> [--write]
 *
 * The check exports the tag with `git archive` into a temporary directory (never the working tree, so nothing
 * uncommitted or ignored can reach the package), runs `pnpm install --frozen-lockfile`, `pnpm build` and `pnpm lint`
 * there, checks that package.json's version is the tag's and that CHANGELOG.md has its `## <version> — <date>`
 * section, then runs `npm pack`. It prints the tarball's path, size, sha1 shasum and sha512 integrity (what the
 * registry reports as dist.shasum and dist.integrity) and writes releases/<version>.json: those values, the tag's
 * commit, every file of the package with its sha256, and the Node, pnpm and npm versions used. The tests are not run
 * unless --tests is given, because the documented release steps run them separately before tagging.
 *
 * --verify fetches nothing itself except with --registry (`npm view @typesol/cli@<version> dist --json`). With
 * --tarball (a downloaded tarball, e.g. from `npm pack @typesol/cli@<version>`) it also compares file by file, and
 * --write stores that comparison in the record under "published". Exit 1 when anything differs.
 *
 * What is reproducible: npm pack writes every entry with a fixed date (1985-10-26) and a normalized mode, in a fixed
 * order, so two packs of the same files with the same npm and Node give the same bytes. A different npm (tar headers)
 * or Node (its zlib, which compresses the archive) can give other bytes for the same files; the record therefore also
 * holds the uncompressed archive's sha256 and each file's sha256, which compare across tool versions.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@typesol/cli";

export interface PackedFile {
  /** The path inside the package (the tarball's `package/` prefix removed). */
  path: string;
  size: number;
  sha256: string;
}

export interface Tarball {
  name: string;
  size: number;
  /** sha1 of the .tgz, hex: the registry's dist.shasum. */
  shasum: string;
  /** sha512 of the .tgz as a subresource-integrity string: the registry's dist.integrity. */
  integrity: string;
  /** sha256 of the uncompressed tar: the same for two archives that differ only in their compression. */
  tarSha256: string;
}

export interface ReleaseRecord {
  version: string;
  tag: string;
  commit: string;
  /** The date of the version's CHANGELOG section. */
  released: string;
  /** When this check ran (UTC). */
  checked: string;
  tests: boolean;
  tarball: Tarball;
  files: PackedFile[];
  tools: { node: string; pnpm: string; npm: string };
  /** The published tarball compared with this one (written by --verify --tarball … --write). */
  published?: PublishedComparison;
}

export interface FileComparison {
  same: number;
  differ: string[];
  onlyHere: string[];
  onlyPublished: string[];
}

export interface PublishedComparison {
  shasum: string;
  integrity: string;
  tarSha256?: string;
  sameTarball: boolean;
  files?: FileComparison;
}

/** Why package.json's version is not the one being released, or undefined when it is. */
export function versionProblem(packageJson: string, version: string): string | undefined {
  let found: unknown;
  try {
    found = (JSON.parse(packageJson) as { version?: unknown }).version;
  } catch (e) {
    return `package.json is not valid JSON (${(e as Error).message})`;
  }
  return found === version ? undefined : `package.json has version ${JSON.stringify(found)}, the tag is v${version}`;
}

/** The date of CHANGELOG.md's `## <version> — <YYYY-MM-DD>` heading; throws when there is none. */
export function changelogDate(changelog: string, version: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^## ${escaped} — (\\d{4}-\\d{2}-\\d{2})\\s*$`, "m").exec(changelog);
  if (!m) throw new Error(`CHANGELOG.md has no "## ${version} — <YYYY-MM-DD>" section`);
  return m[1]!;
}

/** The files of a tar archive (regular files only), with pax and GNU long names applied. */
export function readTar(tar: Buffer): { path: string; data: Buffer }[] {
  const out: { path: string; data: Buffer }[] = [];
  const text = (b: Buffer) => b.toString("utf8").replace(/\0.*$/s, "");
  let longName: string | undefined;
  for (let off = 0; off + 512 <= tar.length;) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(header[156]!) || "0";
    const prefix = text(header.subarray(345, 500));
    const name = text(header.subarray(0, 100));
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // A pax header: "<len> path=<name>\n" records; the path one names the next entry.
      for (const rec of data.toString("utf8").split("\n")) {
        const m = /^\d+ path=(.*)$/s.exec(rec);
        if (m) longName = m[1];
      }
      continue;
    }
    if (type === "L") {
      longName = text(data);
      continue;
    }
    if (type === "0" || type === "\0") out.push({ path: longName ?? (prefix ? `${prefix}/${name}` : name), data: Buffer.from(data) });
    longName = undefined;
  }
  return out;
}

/** A packed tarball's identity (the registry's two hashes) and its files' sha256, in path order. */
export function describeTarball(tgz: Buffer, name: string): { tarball: Tarball; files: PackedFile[] } {
  const tar = gunzipSync(tgz);
  const files = readTar(tar)
    .map((f) => ({ path: f.path.replace(/^package\//, ""), size: f.data.length, sha256: createHash("sha256").update(f.data).digest("hex") }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    tarball: {
      name,
      size: tgz.length,
      shasum: createHash("sha1").update(tgz).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}`,
      tarSha256: createHash("sha256").update(tar).digest("hex"),
    },
    files,
  };
}

/** The differences between the recorded tarball and the registry's values; empty when they are the same. */
export function verifyProblems(record: Pick<ReleaseRecord, "version" | "tarball">, dist: { shasum?: string; integrity?: string }): string[] {
  const problems: string[] = [];
  if (!dist.shasum && !dist.integrity) return ["nothing to compare: give --shasum, --integrity, --tarball or --registry"];
  if (dist.shasum !== undefined && dist.shasum !== record.tarball.shasum) problems.push(`shasum: published ${dist.shasum}, recorded ${record.tarball.shasum}`);
  if (dist.integrity !== undefined && dist.integrity !== record.tarball.integrity)
    problems.push(`integrity: published ${dist.integrity}, recorded ${record.tarball.integrity}`);
  return problems;
}

/** Two packages' files compared by path and sha256. */
export function compareFiles(here: PackedFile[], published: PackedFile[]): FileComparison {
  const theirs = new Map(published.map((f) => [f.path, f.sha256]));
  const mine = new Set(here.map((f) => f.path));
  const result: FileComparison = { same: 0, differ: [], onlyHere: [], onlyPublished: [] };
  for (const f of here) {
    const other = theirs.get(f.path);
    if (other === undefined) result.onlyHere.push(f.path);
    else if (other === f.sha256) result.same++;
    else result.differ.push(f.path);
  }
  for (const f of published) if (!mine.has(f.path)) result.onlyPublished.push(f.path);
  return result;
}

/** A release record, checked enough that a hand-edited or truncated file is refused instead of compared. */
export function parseRecord(text: string, version: string): ReleaseRecord {
  const r = JSON.parse(text) as ReleaseRecord;
  const t = r?.tarball;
  if (r?.version !== version || typeof t?.shasum !== "string" || typeof t.integrity !== "string" || !Array.isArray(r.files))
    throw new Error(`not a release record for ${version} (version, tarball.shasum, tarball.integrity and files are required)`);
  return r;
}

const recordPath = (version: string) => path.join(ROOT, "releases", `${version}.json`);
const run = (cmd: string, args: string[], cwd: string) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.error?.message ?? `exit ${r.status}`})`);
};
const output = (cmd: string, args: string[], cwd = ROOT) => execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

function check(version: string, opts: { tests: boolean; out?: string }): void {
  const tag = `v${version}`;
  const commit = output("git", ["rev-parse", "--verify", `${tag}^{commit}`]);
  const work = mkdtempSync(path.join(os.tmpdir(), `typesol-release-${version}-`));
  const src = path.join(work, "src");
  mkdirSync(src);
  try {
    // git archive writes only what the tag's commit tracks: no node_modules, dist, keypairs or local edits.
    const archive = execFileSync("git", ["archive", "--format=tar", commit], { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024 });
    const untar = spawnSync("tar", ["-x", "-C", src], { input: archive });
    if (untar.status !== 0) throw new Error(`could not unpack the archive of ${tag}: ${untar.stderr?.toString()}`);
    const problem = versionProblem(readFileSync(path.join(src, "package.json"), "utf8"), version);
    if (problem) throw new Error(problem);
    const released = changelogDate(readFileSync(path.join(src, "CHANGELOG.md"), "utf8"), version);
    run("pnpm", ["install", "--frozen-lockfile"], src);
    run("pnpm", ["build"], src);
    run("pnpm", ["lint"], src);
    if (opts.tests) run("pnpm", ["test"], src);
    else console.log("\n(tests not run: the release steps run `pnpm test` before tagging; --tests runs them here too)");
    // prepack would only run `pnpm build` again (and print into the --json output); dist/ was just built from the tag.
    const packed = JSON.parse(output("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], src)) as { filename: string }[];
    const name = path.basename(packed[0]!.filename);
    const outDir = path.resolve(opts.out ?? path.join(os.tmpdir(), `typesol-release-${version}`));
    mkdirSync(outDir, { recursive: true });
    const tgzPath = path.join(outDir, name);
    renameSync(path.join(work, name), tgzPath);
    const { tarball, files } = describeTarball(readFileSync(tgzPath), name);
    const record: ReleaseRecord = {
      version,
      tag,
      commit,
      released,
      checked: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      tests: opts.tests,
      tarball,
      files,
      tools: { node: process.version, pnpm: output("pnpm", ["--version"], src), npm: output("npm", ["--version"], src) },
    };
    // A record already verified against the registry keeps that comparison when the check runs again.
    const previous = existsSync(recordPath(version)) ? (JSON.parse(readFileSync(recordPath(version), "utf8")) as ReleaseRecord) : undefined;
    if (previous?.published) record.published = previous.published;
    mkdirSync(path.dirname(recordPath(version)), { recursive: true });
    writeFileSync(recordPath(version), `${JSON.stringify(record, null, 1)}\n`);
    console.log(
      [
        "",
        `tarball    ${tgzPath}`,
        `size       ${tarball.size} bytes, ${files.length} files`,
        `shasum     ${tarball.shasum}`,
        `integrity  ${tarball.integrity}`,
        `commit     ${commit} (${tag})`,
        `record     ${path.relative(process.cwd(), recordPath(version))}`,
        "",
        `publish exactly this file:  npm publish ${tgzPath} --access public`,
        `then:                       node scripts/release-check.ts ${version} --verify --registry`,
      ].join("\n"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function verify(version: string, opts: { registry: boolean; shasum?: string; integrity?: string; tarball?: string; write: boolean }): number {
  const file = recordPath(version);
  if (!existsSync(file)) throw new Error(`${path.relative(process.cwd(), file)} does not exist: run the check for ${version} first`);
  const record = parseRecord(readFileSync(file, "utf8"), version);
  let dist: { shasum?: string; integrity?: string } = { shasum: opts.shasum, integrity: opts.integrity };
  let files: FileComparison | undefined;
  let tarSha256: string | undefined;
  if (opts.registry) dist = JSON.parse(output("npm", ["view", `${PACKAGE}@${version}`, "dist", "--json"])) as typeof dist;
  if (opts.tarball) {
    const theirs = describeTarball(readFileSync(opts.tarball), path.basename(opts.tarball));
    dist = { shasum: theirs.tarball.shasum, integrity: theirs.tarball.integrity };
    tarSha256 = theirs.tarball.tarSha256;
    files = compareFiles(record.files, theirs.files);
  }
  const problems = verifyProblems(record, dist);
  console.log(problems.length ? `MISMATCH  ${PACKAGE}@${version}\n  ${problems.join("\n  ")}` : `match     ${PACKAGE}@${version}  ${record.tarball.shasum}`);
  if (files) {
    console.log(
      `  files: ${files.same} the same, ${files.differ.length} differ, ${files.onlyHere.length} only here, ${files.onlyPublished.length} only published`,
    );
    for (const [what, list] of [
      ["differs", files.differ],
      ["only here", files.onlyHere],
      ["only published", files.onlyPublished],
    ] as const)
      for (const f of list) console.log(`    ${what.padEnd(14)} ${f}`);
    if (tarSha256 && problems.length && tarSha256 === record.tarball.tarSha256) console.log("  the archives are the same before compression");
  }
  if (opts.write) {
    if (!dist.shasum || !dist.integrity) throw new Error("--write needs both hashes (from --tarball, --registry, or --shasum and --integrity)");
    record.published = {
      shasum: dist.shasum,
      integrity: dist.integrity,
      ...(tarSha256 ? { tarSha256 } : {}),
      sameTarball: problems.length === 0,
      ...(files ? { files } : {}),
    };
    writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
    console.log(`  recorded under "published" in ${path.relative(process.cwd(), file)}`);
  }
  const filesDiffer = files && (files.differ.length || files.onlyHere.length || files.onlyPublished.length);
  return problems.length || filesDiffer ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  const version = args[0];
  try {
    if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version))
      throw new Error("usage: node scripts/release-check.ts <version> [--tests] [--out <dir>] | <version> --verify (--registry | --shasum … | --tarball …)");
    if (args.includes("--verify"))
      process.exitCode = verify(version, {
        registry: args.includes("--registry"),
        shasum: opt("--shasum"),
        integrity: opt("--integrity"),
        tarball: opt("--tarball"),
        write: args.includes("--write"),
      });
    else check(version, { tests: args.includes("--tests"), out: opt("--out") });
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
