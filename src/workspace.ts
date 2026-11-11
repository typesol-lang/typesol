/**
 * Projects: `typesol init` scaffolds one, `typesol.json` lists its programs, `typesol build` / `typesol deploy`
 * work on all of them.
 *
 *   {
 *     "programs": { "counter": { "path": "programs/counter.ts", "address": "…" } },
 *     "out": "target",
 *     "sbpf": "v0"
 *   }
 *
 * Program keypairs live in `<out>/deploy/<name>-keypair.json` (created on first build; keep them, never commit them).
 * The address is recorded in typesol.json on first build, so a lost or swapped keypair is caught before deploying.
 */
import { agentsMd, CLAUDE_MD, cursorRule, MCP_JSON } from "./ai.js";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { writeClient } from "./tools/clientgen.js";
import { build, COMPILER_VERSION, SBPF_VERSIONS, type BuildManifest, type BuildResult, type Sbpf } from "./compiler/index.js";
import { checkToolchain, RUNTIME_DIR, toolchainInfo } from "./compiler/toolchain.js";
import { loadOrCreateKeypair } from "./keys.js";
import { TEMPLATES, type TemplateName } from "./templates.js";

export const CONFIG = "typesol.json";

/** A program entry in typesol.json: its entry file and (recorded on first build) its address. */
export interface ProgramEntry {
  path: string;
  address?: string;
}

export interface Workspace {
  root: string;
  file: string;
  programs: Record<string, ProgramEntry>;
  out: string;
  sbpf: Sbpf;
  /** Cluster accounts `typesol clone` copies for the tests (Anchor's `[test.validator.clone]`). */
  clone: string[];
  /** Where cloned accounts are kept and testProgram loads them from (default tests/accounts). */
  accounts: string;
}

export function findWorkspace(dir: string): Workspace | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const file = path.join(d, CONFIG);
    if (existsSync(file)) return readWorkspace(file);
    if (path.dirname(d) === d) return undefined;
  }
}

function readWorkspace(file: string): Workspace {
  let raw: { programs?: Record<string, string | ProgramEntry>; out?: string; sbpf?: Sbpf; clone?: unknown; accounts?: unknown };
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`);
  }
  if (raw.sbpf !== undefined && !SBPF_VERSIONS.includes(raw.sbpf)) throw new Error(`${file}: "sbpf" must be one of ${SBPF_VERSIONS.join(", ")}`);
  if (raw.out !== undefined && typeof raw.out !== "string") throw new Error(`${file}: "out" must be a directory path`);
  if (!raw.programs || typeof raw.programs !== "object" || !Object.keys(raw.programs).length)
    throw new Error(`${file}: "programs" must map names to entry files`);
  const programs: Record<string, ProgramEntry> = {};
  for (const [name, entry] of Object.entries(raw.programs)) {
    const e = typeof entry === "string" ? { path: entry } : entry;
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !e || typeof e.path !== "string" || (e.address !== undefined && typeof e.address !== "string"))
      throw new Error(`${file}: program "${name}" needs a snake_case name and { "path": "…", "address"?: "…" } (or just the path)`);
    programs[name] = e;
  }
  if (raw.clone !== undefined && (!Array.isArray(raw.clone) || raw.clone.some((a) => typeof a !== "string")))
    throw new Error(`${file}: "clone" must be a list of base58 addresses`);
  if (raw.accounts !== undefined && typeof raw.accounts !== "string") throw new Error(`${file}: "accounts" must be a directory path`);
  return {
    root: path.dirname(file),
    file,
    programs,
    out: raw.out ?? "target",
    sbpf: raw.sbpf ?? "v0",
    clone: (raw.clone as string[] | undefined) ?? [],
    accounts: path.resolve(path.dirname(file), (raw.accounts as string | undefined) ?? "tests/accounts"),
  };
}

export interface ProgramPaths {
  name: string;
  entry: string;
  outDir: string;
  keypair: string;
}

export function programPaths(ws: Workspace, name: string): ProgramPaths {
  const entry = ws.programs[name];
  if (!entry) throw new Error(`no program "${name}" in ${CONFIG} (have: ${Object.keys(ws.programs).join(", ")})`);
  const out = path.resolve(ws.root, ws.out);
  return { name, entry: path.resolve(ws.root, entry.path), outDir: path.join(out, name), keypair: path.join(out, "deploy", `${name}-keypair.json`) };
}

/** The configured program whose entry file is `file`, if any. */
export function programForEntry(ws: Workspace, file: string): string | undefined {
  const abs = path.resolve(file);
  return Object.keys(ws.programs).find((n) => programPaths(ws, n).entry === abs);
}

/**
 * The program's keypair (created on first use) checked against the address recorded in typesol.json, which is
 * recorded on first build. A mismatch means the keypair was lost or replaced: deploying would create a new program.
 * Building and testing only need the address: without the keypair (a fresh clone, CI) they use the recorded one,
 * and only deploying (`needKeypair`) refuses.
 */
export function programAddress(ws: Workspace, name: string, opts: { needKeypair?: boolean } = {}): { address: string; created: boolean; keyless?: boolean } {
  const paths = programPaths(ws, name);
  const recorded = ws.programs[name].address;
  if (recorded && !existsSync(paths.keypair) && !opts.needKeypair) return { address: recorded, created: false, keyless: true };
  if (recorded && !existsSync(paths.keypair))
    throw new Error(
      `${name}: ${path.relative(ws.root, paths.keypair)} is missing, but ${CONFIG} records ${recorded}. Restore the keypair (it is the program's address); removing "address" from ${CONFIG} would give the program a new address.`,
    );
  mkdirSync(path.dirname(paths.keypair), { recursive: true });
  const { address, created } = loadOrCreateKeypair(paths.keypair);
  if (recorded && recorded !== address)
    throw new Error(`${name}: ${path.relative(ws.root, paths.keypair)} is ${address}, but ${CONFIG} records ${recorded}. Restore the right keypair.`);
  if (!recorded) {
    const raw = JSON.parse(readFileSync(ws.file, "utf8")) as { programs: Record<string, string | ProgramEntry> };
    raw.programs[name] = { path: ws.programs[name].path, address };
    writeFileSync(ws.file, JSON.stringify(raw, null, 2) + "\n");
    ws.programs[name].address = address;
  }
  return { address, created };
}

/** Build every program (or the ones named). */
export function buildWorkspace(
  ws: Workspace,
  names = Object.keys(ws.programs),
  opts: { sbpf?: Sbpf; profile?: boolean; needKeypair?: boolean } = {},
): { paths: ProgramPaths; address: string; created: boolean; keyless?: boolean; result: BuildResult; clientPath: string }[] {
  return names.map((name) => {
    const paths = programPaths(ws, name);
    // Every build of a program writes the same files (<name>.c, .o, .so, …), and the first one creates its keypair:
    // another process building it at the same time (vitest runs test files in parallel workers) would overwrite them.
    return withBuildLock(paths.outDir, () => {
      const { address, created, keyless } = programAddress(ws, name, { needKeypair: opts.needKeypair });
      const result = build(paths.entry, paths.outDir, address, { sbpf: opts.sbpf ?? ws.sbpf, profile: opts.profile });
      // The TypeScript client (docs/client.md) is written with the build, from the same IDL.
      const clientPath = writeClient(result.idl, path.join(paths.outDir, `${result.model.name}.client.ts`)).path;
      return { paths, address, created, keyless, result, clientPath };
    });
  });
}

/** What a test needs of a built program. */
export interface BuiltProgram {
  address: string;
  soPath: string;
  idl: BuildResult["idl"];
  /** False when the existing build was up to date and was loaded instead of rebuilt. */
  rebuilt: boolean;
}

/**
 * The program built for a test: the existing build when it is up to date (same sources, runtime header, TypeSOL,
 * TypeScript, clang and platform-tools versions, host, SBPF version and address, not a --profile build, and the .so the manifest records),
 * else a fresh one. Concurrent callers (parallel test workers) wait for each other instead of building over each other.
 */
export function buildForTest(ws: Workspace, name: string): BuiltProgram {
  const paths = programPaths(ws, name);
  return withBuildLock(paths.outDir, () => {
    const { address } = programAddress(ws, name);
    const current = upToDateBuild(paths, address, ws.sbpf);
    if (current) return { ...current, rebuilt: false };
    const result = build(paths.entry, paths.outDir, address, { sbpf: ws.sbpf });
    writeClient(result.idl, path.join(paths.outDir, `${result.model.name}.client.ts`));
    return { address, soPath: result.soPath, idl: result.idl, rebuilt: true };
  });
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** The existing build of a program if building it again would give the same files, else undefined. */
function upToDateBuild(paths: ProgramPaths, address: string, sbpf: Sbpf): Omit<BuiltProgram, "rebuilt"> | undefined {
  // The compiler names a program's files after its entry file (programs/counter.ts → counter.so).
  const base = path.join(paths.outDir, path.basename(paths.entry).replace(/\.ts$/, ""));
  const files = { manifest: `${base}.build.json`, so: `${base}.so`, idl: `${base}.json`, client: `${base}.client.ts` };
  if (!Object.values(files).every((f) => existsSync(f))) return undefined;
  let manifest: BuildManifest;
  let idl: BuildResult["idl"];
  try {
    manifest = JSON.parse(readFileSync(files.manifest, "utf8")) as BuildManifest;
    idl = JSON.parse(readFileSync(files.idl, "utf8")) as BuildResult["idl"];
  } catch {
    return undefined;
  }
  if (manifest.compiler !== COMPILER_VERSION || manifest.typescript !== ts.version || manifest.sbpf !== sbpf || manifest.profile) return undefined;
  if ((idl as { address?: string }).address !== address || !manifest.sources || typeof manifest.sources !== "object") return undefined;
  if (sha256(readFileSync(files.so)) !== manifest.binary) return undefined;
  const root = path.dirname(paths.entry);
  for (const [rel, hash] of Object.entries(manifest.sources)) {
    const file = rel === "<runtime>/typesol_rt.h" ? path.join(RUNTIME_DIR, "typesol_rt.h") : path.resolve(root, rel);
    if (!existsSync(file) || sha256(readFileSync(file)) !== hash) return undefined;
  }
  // A new import changes the importing file, so every source of the current program is in the list; the runtime and
  // the entry must be there too (a manifest from another layout).
  if (!manifest.sources["<runtime>/typesol_rt.h"] || !manifest.sources[path.basename(paths.entry)]) return undefined;
  // A manifest from before 0.44.0 has no host: rebuild once to record the toolchain in full.
  if (!manifest.host || manifest.host.os !== process.platform || manifest.host.arch !== process.arch) return undefined;
  // Last, as it runs clang: updated platform-tools may compile the same C differently.
  const toolchain = toolchainInfo();
  if (manifest.clang !== toolchain.clang || manifest.platformTools !== toolchain.platformTools) return undefined;
  // A reused build came from this toolchain too: the same warning (or refusal) as building it.
  checkToolchain(toolchain);
  return { address, soPath: files.so, idl };
}

/** How long a build lock may be held before a waiter treats it as abandoned (a build takes seconds to a few minutes). */
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_POLL_MS = 100;

/**
 * Run `fn` holding `<dir>/.typesol-build.lock`, created exclusively: one build of a program at a time across processes.
 * The lock records its holder's host and pid; a lock whose process is gone (on this host) or that is older than
 * LOCK_STALE_MS is taken over, so a crashed or killed build does not block the next one.
 */
export function withBuildLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, ".typesol-build.lock");
  const me = `${os.hostname()} ${process.pid} ${Date.now()}`;
  const deadline = Date.now() + LOCK_STALE_MS + 60_000;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lock, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, me);
      } finally {
        closeSync(fd);
      }
      try {
        return fn();
      } finally {
        // Only our own lock: a waiter may have taken it over after LOCK_STALE_MS.
        try {
          if (readFileSync(lock, "utf8") === me) unlinkSync(lock);
        } catch {
          // Already gone.
        }
      }
    }
    const holder = readLock(lock);
    if (holder !== undefined && isStale(holder, lock)) {
      // Read again just before removing it: another waiter may have replaced the stale lock with its own meanwhile.
      if (readLock(lock) === holder)
        try {
          unlinkSync(lock);
        } catch {
          // Removed by another waiter.
        }
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock} (held by ${holder ?? "?"}); delete it if no build is running`);
    sleepSync(LOCK_POLL_MS);
  }
}

function readLock(lock: string): string | undefined {
  try {
    return readFileSync(lock, "utf8");
  } catch {
    return undefined;
  }
}

function isStale(holder: string, lock: string): boolean {
  const [host, pid] = holder.split(" ");
  let age: number;
  try {
    age = Date.now() - statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  if (age > LOCK_STALE_MS) return true;
  // An empty or partly written lock: its writer is between open and write, unless it died there.
  if (!host || !pid || !/^\d+$/.test(pid)) return age > 10_000;
  if (host !== os.hostname()) return false;
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch (e) {
    // EPERM: the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** Block this thread (builds are synchronous, so waiting for one is too). */
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/** The `solana program deploy` arguments for one built program (deploying again upgrades it). */
export function deployArgs(soPath: string, keypair: string, opts: { url?: string; payer?: string; config?: string }): string[] {
  const args = ["program", "deploy", soPath, "--program-id", keypair, "--use-rpc"];
  if (opts.config) args.unshift("-C", opts.config);
  if (opts.url) args.push("--url", opts.url);
  if (opts.payer) args.push("--keypair", opts.payer);
  return args;
}

/** Create a project: typesol.json, one program from a template, its LiteSVM test, configs (editor settings included). Refuses to overwrite files. */
export function scaffold(dir: string, name: string, template: TemplateName = "counter"): string[] {
  const t = TEMPLATES[template];
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`program name "${name}" must be snake_case`);
  const files: Record<string, string> = {
    [CONFIG]: JSON.stringify({ programs: { [name]: { path: `programs/${name}.ts` } }, out: "target", sbpf: "v0" }, null, 2) + "\n",
    [`programs/${name}.ts`]: t.program,
    "programs/tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            types: [],
            lib: ["ES2022"],
            // TypeSOL's own errors in the editor (with the workspace's TypeScript; see docs/cli.md).
            plugins: [{ name: "typesol/ts-plugin" }],
          },
          include: ["**/*.ts"],
        },
        null,
        2,
      ) + "\n",
    [`tests/${name}.test.ts`]: t.test(name),
    "package.json":
      JSON.stringify(
        {
          name,
          private: true,
          type: "module",
          scripts: {
            build: "typesol build",
            // The tests and the typecheck import the client the build writes: build first.
            pretest: "typesol build --quiet",
            test: "vitest run",
            pretypecheck: "typesol build --quiet",
            typecheck: "tsc -p tsconfig.json",
            deploy: "typesol deploy",
          },
          engines: { node: ">=22.12" },
          devDependencies: {
            // Published as @typesol/cli, installed under the name programs import ("typesol", "typesol/workspace").
            typesol: `npm:@typesol/cli@^${COMPILER_VERSION}`,
            "@types/node": "^22.0.0",
            typescript: "^6.0.3",
            "@anchor-lang/core": "^1.2.1",
            "@solana/kit": "^8.5.0",
            litesvm: "^1.6.1",
            vitest: "^5.0.5",
            ...t.devDependencies,
          },
        },
        null,
        2,
      ) + "\n",
    // AI coding agents: the rules (AGENTS.md, and CLAUDE.md / Cursor's rules pointing at the same text) and the
    // TypeSOL MCP server (check, IDL, docs as tools).
    "AGENTS.md": agentsMd(name),
    "CLAUDE.md": CLAUDE_MD,
    ".cursor/rules/typesol.mdc": cursorRule(),
    ".mcp.json": MCP_JSON,
    ".cursor/mcp.json": MCP_JSON,
    // VS Code loads tsconfig plugins (typesol/ts-plugin) only with the workspace's TypeScript: offer to switch to it.
    ".vscode/settings.json":
      JSON.stringify({ "typescript.tsdk": "node_modules/typescript/lib", "typescript.enablePromptUseWorkspaceTsdk": true }, null, 2) + "\n",
    // target/deploy/*-keypair.json are the programs' addresses: never commit them, but keep a backup.
    ".gitignore":
      "node_modules/\n# target/deploy/*-keypair.json are the programs' addresses (and upgrade keys): never commit them, but BACK THEM UP.\n# Without it, a fresh clone still builds and tests at the address recorded in typesol.json, but cannot deploy.\ntarget/\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ["node"],
          },
          include: ["tests/**/*.ts"],
        },
        null,
        2,
      ) + "\n",
  };
  const existing = Object.keys(files).filter((f) => existsSync(path.join(dir, f)));
  if (existing.length) throw new Error(`refusing to overwrite: ${existing.join(", ")}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return Object.keys(files);
}

/**
 * Add a program to an existing project: programs/<name>.ts and tests/<name>.test.ts from a template, and its entry in
 * typesol.json. Returns the files written and the template's extra devDependencies the package.json lacks.
 */
export function addProgram(ws: Workspace, name: string, template: TemplateName = "counter"): { files: string[]; missing: string[] } {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`program name "${name}" must be snake_case`);
  if (ws.programs[name]) throw new Error(`${CONFIG} already has a program "${name}"`);
  const t = TEMPLATES[template];
  const files: Record<string, string> = { [`programs/${name}.ts`]: t.program, [`tests/${name}.test.ts`]: t.test(name) };
  const existing = Object.keys(files).filter((f) => existsSync(path.join(ws.root, f)));
  if (existing.length) throw new Error(`refusing to overwrite: ${existing.join(", ")}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ws.root, file)), { recursive: true });
    writeFileSync(path.join(ws.root, file), text);
  }
  const raw = JSON.parse(readFileSync(ws.file, "utf8")) as { programs: Record<string, string | ProgramEntry> };
  raw.programs[name] = { path: `programs/${name}.ts` };
  writeFileSync(ws.file, JSON.stringify(raw, null, 2) + "\n");
  ws.programs[name] = { path: `programs/${name}.ts` };
  const pkgFile = path.join(ws.root, "package.json");
  const pkg = existsSync(pkgFile)
    ? (JSON.parse(readFileSync(pkgFile, "utf8")) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> })
    : {};
  const have = { ...pkg.dependencies, ...pkg.devDependencies };
  const missing = Object.entries(t.devDependencies ?? {})
    .filter(([dep]) => !(dep in have))
    .map(([dep, v]) => `${dep}@${v}`);
  return { files: [...Object.keys(files), CONFIG], missing };
}
