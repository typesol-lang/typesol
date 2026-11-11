/**
 * A release's manifest: the compiler and toolchain that built it, and the sha256 of the SBF binary, IDL and C that
 * every program in a source tree builds to, with the reference binaries the differential tests compare against and
 * the test corpus. Two manifests of the same sources diff program by program, so anyone can check a claim such as
 * "programs that use none of the new features build to the same binaries", or redo it after either side upgrades.
 *
 *   node scripts/release-manifest.ts --out manifest.json
 *   node scripts/release-manifest.ts --compiler node_modules/@typesol/cli --sources ../typesol-0.37.0 --out a.json
 *   node scripts/release-manifest.ts --diff a.json b.json
 *
 * --compiler: a @typesol/cli package (or this checkout, the default; run `pnpm build` first). --sources: the tree
 * whose examples/ and ports (showcase/program-examples/, or showcase/ after 0.38.0) are built (default: this checkout). Every program is built at one address, so
 * the IDLs compare too. --programs a.ts,b.ts builds only those (paths relative to --sources).
 *
 * The cross-host check (CI, on every change): test/golden/binaries.json holds what a fixed set of programs builds to
 * in the reference environment, the --docker container (linux/amd64, platform-tools v1.52), with this checkout's
 * compiler. --check builds the same programs with the active toolchain and compares:
 *
 *   node scripts/release-manifest.ts --docker --programs <list> --out test/golden/binaries.json   regenerate it
 *   node scripts/release-manifest.ts --check test/golden/binaries.json                             compare (exit 1)
 *
 * --docker runs this script inside the build image (built first if needed) with this checkout mounted read-only and
 * no network. The C and the IDL must match on every host; the binary must match on linux-x64, the reference's host.
 * On another host a binary can differ for programs that link compiler-builtins' 128-bit or signed division, whose
 * build differs between platform-tools host packages (docs/stability.md), so there it is reported, not failed.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ADDRESS = "11111111111111111111111111111112";
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const here = fileURLToPath(new URL("..", import.meta.url));
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

type Manifest = {
  compiler: string;
  toolchain: {
    clang: string;
    platformTools?: string;
    node: string;
    typescript: string;
    runtime: string;
    /** `<process.platform>-<process.arch>` of the machine that built (recorded after 0.44.0). */
    host?: string;
    /** The sha256 of docker/Dockerfile when it was built in the build container (--docker). */
    container?: string;
  };
  sources: { root: string; commit?: string };
  programs: Record<string, { so: string; idl: string; c: string; bytes: number } | { error: string }>;
  /** Left out with --programs (a set, not a release). */
  references?: Record<string, string>;
  corpus?: { files: number; sha256: string };
};

if (args[0] === "--diff") {
  const [a, b] = [args[1], args[2]].map((f) => JSON.parse(readFileSync(f!, "utf8")) as Manifest);
  const names = [...new Set([...Object.keys(a!.programs), ...Object.keys(b!.programs)])].sort();
  const rows = { same: [] as string[], binary: [] as string[], idl: [] as string[], only: [] as string[] };
  for (const n of names) {
    const [x, y] = [a!.programs[n], b!.programs[n]];
    if (!x || !y || "error" in x || "error" in y) {
      if (!x || !y || "error" in x !== "error" in y) rows.only.push(n);
      continue;
    }
    if (x.so === y.so && x.idl === y.idl) rows.same.push(n);
    else if (x.so !== y.so) rows.binary.push(n);
    else rows.idl.push(n);
  }
  console.log(`${a!.compiler} → ${b!.compiler}`);
  console.log(`  same binary and IDL: ${rows.same.length}`);
  console.log(`  binary differs: ${rows.binary.length}${rows.binary.length ? `\n    ${rows.binary.join("\n    ")}` : ""}`);
  console.log(`  IDL differs (same binary): ${rows.idl.length}${rows.idl.length ? `\n    ${rows.idl.join("\n    ")}` : ""}`);
  console.log(`  built by only one: ${rows.only.length}${rows.only.length ? `\n    ${rows.only.join("\n    ")}` : ""}`);
  process.exit(0);
}

if (args.includes("--docker")) process.exit(await inContainer());

/** This script again, in the build container: the checkout read-only at /repo, the output's directory writable. */
async function inContainer(): Promise<number> {
  if (opt("--compiler") || opt("--sources") || args.includes("--check"))
    throw new Error("--docker builds this checkout with its own compiler: leave out --compiler, --sources and --check");
  const out = path.resolve(opt("--out") ?? "manifest.json");
  const docker = (await import(pathToFileURL(path.join(here, "dist/tools/docker.js")).href)) as typeof import("../dist/tools/docker.js");
  // Any recorded version's image has the same toolchain (one Dockerfile); its own TypeSOL is not used here.
  const version = docker.recordedVersions().at(-1);
  if (!version) throw new Error("no release record in releases/: the build image needs one");
  const image = docker.ensureImage(version);
  let commit = "";
  try {
    commit = execFileSync("git", ["-C", here, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    /* not a checkout */
  }
  const pass = args.filter((a, i) => a !== "--docker" && a !== "--out" && args[i - 1] !== "--out");
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--platform",
      docker.DOCKER_PLATFORM,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--cap-drop",
      "ALL",
      "--user",
      docker.containerUser(),
      ...docker.limits(),
      "--mount",
      `type=bind,src=${here},dst=/repo,readonly`,
      "--mount",
      `type=bind,src=${path.dirname(out)},dst=/out`,
      image.tag,
      "node",
      "/repo/scripts/release-manifest.ts",
      ...pass,
      "--out",
      `/out/${path.basename(out)}`,
      "--container",
      image.identity.dockerfile,
      ...(commit ? ["--commit", commit] : []),
    ],
    { stdio: "inherit" },
  );
  return r.status ?? 1;
}

const compilerRoot = path.resolve(opt("--compiler") ?? here);
const sourceRoot = path.resolve(opt("--sources") ?? here);
const out = opt("--out") ?? "manifest.json";
const compiler = (await import(pathToFileURL(path.join(compilerRoot, "dist/compiler/index.js")).href)) as {
  build: (entry: string, outDir: string, address: string) => { soPath: string; idlPath: string; cPath: string };
  COMPILER_VERSION: string;
};
const toolchain = (await import(pathToFileURL(path.join(compilerRoot, "dist/compiler/toolchain.js")).href)) as {
  toolchainVersion: () => string;
  findToolchain: () => { clang: string; sdk: string };
  /** From 0.44.0: the version the SDK's marker file and link agree on. */
  platformToolsVersion?: () => string | undefined;
};
const ts = (await import(pathToFileURL(path.join(compilerRoot, "node_modules/typescript/lib/typescript.js")).href).catch(() => import("typescript"))) as {
  default?: { version: string };
  version?: string;
};

const files = (dir: string): string[] => {
  let found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of entries.sort()) {
    const p = path.join(dir, f);
    if (f === "node_modules" || f === "target") continue;
    if (statSync(p).isDirectory()) found = found.concat(files(p));
    else found.push(p);
  }
  return found;
};

const host = `${process.platform}-${process.arch}`;
const buildOne = (entry: string, dir: string) => {
  const r = compiler.build(entry, dir, ADDRESS);
  const so = readFileSync(r.soPath);
  return { so: sha256(so), idl: sha256(readFileSync(r.idlPath)), c: sha256(readFileSync(r.cPath)), bytes: so.length };
};

if (opt("--check")) {
  const reference = JSON.parse(readFileSync(opt("--check")!, "utf8")) as Manifest;
  const refHost = reference.toolchain.host ?? "unknown";
  const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-check-"));
  let failed = 0;
  let hostOnly = 0;
  console.log(`reference: ${opt("--check")} (${reference.toolchain.container ? "build container, " : ""}${refHost}); this host: ${host}`);
  try {
    for (const [i, [rel, want]] of Object.entries(reference.programs).entries()) {
      if ("error" in want) continue;
      const got = buildOne(path.join(sourceRoot, rel), path.join(dir, String(i)));
      const text = got.c === want.c && got.idl === want.idl;
      if (text && got.so === want.so) console.log(`  same      ${rel} (${got.bytes} bytes)`);
      else if (!text) {
        failed++;
        console.log(
          `  STALE     ${rel}: ${got.c === want.c ? "" : "the C "}${got.c !== want.c && got.idl !== want.idl ? "and " : ""}${got.idl === want.idl ? "" : "the IDL "}differ from the reference. ` +
            "If the compiler or the program changed on purpose, regenerate the reference (see the top of scripts/release-manifest.ts)",
        );
      } else if (host === refHost) {
        failed++;
        console.log(`  DIFFERS   ${rel}: the same C and IDL build to another binary here (${got.so.slice(0, 16)}…, reference ${want.so.slice(0, 16)}…)`);
      } else {
        hostOnly++;
        console.log(`  host      ${rel}: another binary on ${host} with the same C and IDL (expected for programs that link compiler-builtins' division)`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(
    failed
      ? `${failed} program(s) differ from the reference`
      : `no difference${hostOnly ? `, apart from ${hostOnly} binary(ies) on a host other than the reference's (${refHost})` : ": every program builds to the reference's bytes"}`,
  );
  process.exit(failed ? 1 : 0);
}

const programs: Manifest["programs"] = {};
const scratch = mkdtempSync(path.join(os.tmpdir(), "typesol-manifest-"));
// The programs: examples/, and the mainnet ports and program-examples ports (examples/ and test/ports/ up to 0.38.0,
// showcase/mainnet/ and showcase/program-examples/ after).
const roots = ["examples", "test/ports", "showcase/mainnet", "showcase/program-examples"].map((d) => path.join(sourceRoot, d)).filter((d) => existsSync(d));
// --programs a.ts,b.ts: only those entries (paths relative to --sources), e.g. the small set the cross-host check builds.
const only = opt("--programs")
  ?.split(",")
  .filter(Boolean)
  .map((p) => path.join(sourceRoot, p));
const entries = only ?? roots.flatMap((d) => files(d)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));
for (const [i, entry] of entries.entries()) {
  const rel = path.relative(sourceRoot, entry);
  try {
    programs[rel] = buildOne(entry, path.join(scratch, String(i)));
  } catch (e) {
    // Files that are not programs on their own (modules other files import) are listed with why.
    programs[rel] = {
      error: String((e as Error).message)
        .split("\n")[0]!
        .replace(sourceRoot, ".")
        .slice(0, 200),
    };
  }
}
rmSync(scratch, { recursive: true, force: true });

// A set (--programs) is not a release: no reference binaries or corpus, which change with every test.
const references: Record<string, string> = {};
const corpusHash = createHash("sha256");
let corpusFiles = 0;
if (!only) {
  for (const f of files(path.join(sourceRoot, "test/programs"))) if (f.endsWith(".so")) references[path.relative(sourceRoot, f)] = sha256(readFileSync(f));
  for (const f of files(path.join(sourceRoot, "test")).filter((f) => !f.endsWith(".so"))) {
    corpusFiles++;
    corpusHash
      .update(`${path.relative(sourceRoot, f)}\0`)
      .update(readFileSync(f))
      .update("\0");
  }
}
let commit: string | undefined = opt("--commit");
try {
  commit ??= execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  /* not a checkout (or the container, where --commit gives it) */
}
const clang = toolchain.findToolchain().clang;
const manifest: Manifest = {
  compiler: compiler.COMPILER_VERSION,
  toolchain: {
    clang: toolchain.toolchainVersion(),
    // An older compiler package cannot tell: then the version in the resolved clang path (~/.cache/solana/v1.52/…), if any.
    platformTools: toolchain.platformToolsVersion?.() ?? /[/\\](v\d+\.\d+(?:\.\d+)?)[/\\]platform-tools[/\\]/.exec(realpathSync(clang))?.[1],
    node: process.version,
    typescript: ts.default?.version ?? ts.version ?? "",
    runtime: sha256(readFileSync(path.join(compilerRoot, "runtime/typesol_rt.h"))),
    host,
    ...(opt("--container") ? { container: opt("--container") } : {}),
  },
  sources: { root: path.basename(sourceRoot), ...(commit ? { commit } : {}) },
  programs,
  ...(only ? {} : { references, corpus: { files: corpusFiles, sha256: corpusHash.digest("hex") } }),
};
writeFileSync(out, `${JSON.stringify(manifest, null, 1)}\n`);
const built = Object.values(programs).filter((p) => !("error" in p)).length;
console.log(`${built} programs built (${entries.length - built} modules), ${Object.keys(references).length} reference binaries → ${out}`);
