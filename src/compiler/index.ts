import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import ts from "typescript";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyze, LIB_PATH } from "./analyze.js";
import { hintForTypeScript, messageForTypeScript } from "./hints.js";
import { emitProgram, type EmitOptions } from "./emit/index.js";
import { buildIdl } from "./idl.js";
import { buildSharedObject, checkToolchain, shortClang, TESTED_TOOLCHAIN, type Sbpf } from "./toolchain.js";
import { BUILTINS_SOURCE, RUNTIME_DIR } from "./toolchain.js";
import type { ProgramModel } from "./model.js";

export { CompileError, formatDiagnostic, type Diagnostic } from "./diagnostics.js";
export type { ProgramModel } from "./model.js";
export { SBPF_VERSIONS, TESTED_TOOLCHAIN, type Sbpf } from "./toolchain.js";

/** The hint the CLI adds under a TypeScript error (what to write instead in a TypeSOL program), for the editor plugin. */
export function typescriptHint(d: ts.Diagnostic): string | undefined {
  return hintForTypeScript(d, ts.flattenDiagnosticMessageText(d.messageText, "\n"), LIB_PATH);
}

/**
 * The message the CLI shows in place of a TypeScript error's, where TypeScript's advice points the wrong way (add the
 * dom library, install @types/node, for a global a program does not have); undefined to keep TypeScript's.
 */
export function typescriptMessage(d: ts.Diagnostic): string | undefined {
  const flat = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  const shown = messageForTypeScript(d, flat);
  return shown === flat ? undefined : shown;
}

export interface Generated {
  model: ProgramModel;
  c: string;
  /** The TypeSOL source files of the program (entry and relative imports). */
  files: string[];
  /** Each source file's text as the compiler read it. */
  texts: Map<string, string>;
}

/** Typecheck, enforce the TypeSOL subset, and generate C. Throws CompileError with every diagnostic. */
export function generate(entry: string, opts: EmitOptions = {}): Generated {
  const analysis = analyze(entry, opts.files);
  analysis.reporter.throwIfAny();
  const c = emitProgram(analysis, opts);
  analysis.reporter.throwIfAny();
  return { model: analysis.model, c, files: analysis.files, texts: analysis.texts };
}

/** What a build was made from, written next to it as <name>.build.json (see `typesol verify`). */
export interface BuildManifest {
  program: string;
  compiler: string;
  /** The first line of `clang --version`: the compiler of the generated C. */
  clang: string;
  /** The platform-tools version (`v1.52`), when the SDK's layout tells it for sure (from 0.44.0). */
  platformTools?: string;
  /** The machine that built it: `process.platform` and `process.arch` (from 0.44.0). */
  host?: { os: string; arch: string };
  /** The TypeScript version that type-checked the sources (pinned: it decides what compiles). */
  typescript: string;
  sbpf: Sbpf;
  profile: boolean;
  /** sha256 of each source file of the program (relative to the entry's directory) and of the runtime header. */
  sources: Record<string, string>;
  /** sha256 of the .so. */
  binary: string;
  /** Set when the build ran in the pinned container (`typesol build --docker`, after 0.44.0): what that environment is. */
  container?: ContainerIdentity;
}

/**
 * The build container of `--docker` (docker/Dockerfile): everything that decides what is inside it, so that another
 * machine can build the same environment and compare. `image` is this machine's local image id; it can differ between
 * machines that built the same Dockerfile (layer dates), so it identifies the image used, not the environment.
 */
export interface ContainerIdentity {
  /** The container platform: `linux/amd64` (before 0.45.0 some programs' binaries depended on the platform-tools host package). */
  platform: string;
  /** sha256 of docker/Dockerfile. */
  dockerfile: string;
  /** The local image id (`sha256:…`). */
  image: string;
  /** The base images, each pinned by digest (`node:24.22.2-bookworm-slim@sha256:…`). */
  base: string[];
  /** The Agave and platform-tools release files, with the sha256 the Dockerfile requires of them. */
  downloads: { url: string; sha256: string }[];
  /**
   * The TypeSOL package installed in the image, as its release record (releases/<version>.json) describes it, and where
   * that record came from (this package, a --release-record file, or the repository's main branch) with its sha256
   * (recorded from 0.45.0 on).
   */
  typesol: {
    version: string;
    shasum: string;
    integrity: string;
    commit: string;
    record?: { kind: "package" | "file" | "repository"; location: string; sha256: string };
  };
  /**
   * The TypeSOL package's npm dependencies, installed by `npm ci` from this lock (every package checked against the
   * integrity it records): `docker/deps/<version>.lock.json`, its sha256, and whether it came from the running
   * package or from the version's own (checked) tarball (recorded from 0.45.0 on).
   */
  deps?: { path: string; sha256: string; source: "package" | "tarball" };
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export interface BuildResult extends Generated {
  manifest: BuildManifest;
  manifestPath: string;
  soPath: string;
  cPath: string;
  idlPath: string;
  idl: ReturnType<typeof buildIdl>;
}

/** A step of `build`, for `onStep`: the C generated (the sources read), the C compiled and linked. */
export type BuildStep = "generated" | "compiled";

/**
 * Full build: `<outDir>/<name>.c`, `<name>.so`, `<name>.json` (Anchor IDL) and `<name>.build.json`, the manifest.
 *
 * The manifest binds the binary to the exact inputs that made it: each source's sha256 is that of the bytes the
 * compiler parsed (read once, checked against the text the TypeScript program holds), the runtime files are hashed
 * before clang reads them, and every input is hashed again once the binary is linked. An input that changed in between
 * (an editor saving a file mid-build) fails the build with no manifest: a previous build's manifest is removed before
 * anything is written, so a reused build (buildForTest) never pairs a binary with sources that did not make it.
 * `onStep` is called after each step (tests use it to change a file at that point).
 */
export function build(
  entry: string,
  outDir: string,
  programAddress: string,
  opts: { sbpf?: Sbpf; profile?: boolean; onStep?: (step: BuildStep) => void } = {},
): BuildResult {
  const runtime: Record<string, string> = {
    "<runtime>/typesol_rt.h": path.join(RUNTIME_DIR, "typesol_rt.h"),
    "<runtime>/typesol_builtins.c": BUILTINS_SOURCE,
  };
  const runtimeHashes = Object.fromEntries(Object.entries(runtime).map(([k, f]) => [k, sha256(readFileSync(f))]));
  const gen = generate(entry, { profile: opts.profile });
  opts.onStep?.("generated");
  const root = path.dirname(path.resolve(entry));
  const changed = (rel: string) =>
    new Error(`${rel} changed while it was being built, so the binary may not be what it holds now: no manifest was written; build again`);
  const sources: Record<string, string> = {};
  for (const f of gen.files) {
    const bytes = readFileSync(f);
    if (decodeSource(bytes) !== gen.texts.get(f)) throw changed(path.relative(root, f));
    sources[path.relative(root, f)] = sha256(bytes);
  }
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, gen.model.name);
  const cPath = `${base}.c`;
  const soPath = `${base}.so`;
  const idlPath = `${base}.json`;
  const manifestPath = `${base}.build.json`;
  rmSync(manifestPath, { force: true });
  writeFileSync(cPath, gen.c);
  // Before clang runs: an untested toolchain is a warning (once), or an error in strict mode.
  const toolchain = checkToolchain();
  buildSharedObject(cPath, soPath, opts.sbpf);
  opts.onStep?.("compiled");
  const idl = buildIdl(gen.model, programAddress);
  writeFileSync(idlPath, JSON.stringify(idl, null, 2) + "\n");
  for (const f of gen.files) if (sha256(readFileSync(f)) !== sources[path.relative(root, f)]) throw changed(path.relative(root, f));
  for (const [k, f] of Object.entries(runtime)) {
    if (sha256(readFileSync(f)) !== runtimeHashes[k]) throw changed(f);
    sources[k] = runtimeHashes[k]!;
  }
  const manifest: BuildManifest = {
    program: gen.model.name,
    compiler: COMPILER_VERSION,
    clang: toolchain.clang,
    ...(toolchain.platformTools ? { platformTools: toolchain.platformTools } : {}),
    host: { os: process.platform, arch: process.arch },
    typescript: ts.version,
    sbpf: opts.sbpf ?? "v0",
    profile: !!opts.profile,
    sources,
    binary: sha256(readFileSync(soPath)),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { ...gen, cPath, soPath, idlPath, idl, manifest, manifestPath };
}

/** A source file's bytes as TypeScript reads them (ts.sys.readFile): UTF-8, or UTF-16 with its byte-order mark, no BOM. */
function decodeSource(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const swapped = Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1)));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.toString("utf16le", 2);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.toString("utf8", 3);
  return b.toString("utf8");
}

/** The package version (one source: package.json), recorded in build manifests and shown by the CLI. */
export const COMPILER_VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

/** A build's toolchain in one line: `clang 20.1.7-rust-dev (…), platform-tools v1.52, darwin-arm64, TypeSOL 0.44.0`. */
export function describeToolchain(m: Pick<BuildManifest, "clang" | "platformTools" | "host" | "compiler" | "container">): string {
  return [
    shortClang(m.clang),
    `platform-tools ${m.platformTools ?? "unknown"}`,
    m.host ? `${m.host.os}-${m.host.arch}` : "host unknown",
    `TypeSOL ${m.compiler}`,
    ...(m.clang === TESTED_TOOLCHAIN.clang ? ["the tested toolchain"] : []),
    ...(m.container ? [`in the build container (Dockerfile ${m.container.dockerfile.slice(0, 12)}…)`] : []),
  ].join(", ");
}

/** What differs between two builds' toolchains and compilers (the fields both record), e.g. ["clang", "TypeSOL version"]. */
export function toolchainDifferences(a: Partial<BuildManifest>, b: Partial<BuildManifest>): string[] {
  const out: string[] = [];
  if (a.compiler !== b.compiler) out.push("TypeSOL version");
  if (a.clang !== b.clang) out.push("clang");
  if (a.platformTools && b.platformTools && a.platformTools !== b.platformTools) out.push("platform-tools");
  if (a.typescript !== b.typescript) out.push("TypeScript");
  if (a.sbpf !== b.sbpf) out.push("SBPF version");
  // The same clang gives the same object code on each host measured. Before 0.45.0 programs linked platform-tools'
  // compiler-builtins, which each host package splits into archive members differently, so one with 128-bit or signed
  // division linked to another layout on another host; a build that links the runtime's builtins (its manifest lists
  // them among the sources) gives the same bytes on each host measured (docs/stability.md). Between two such builds
  // the host is not a difference when both hosts were measured, and "host (not measured)" when one was not.
  const linksRuntimeBuiltins = (m: Partial<BuildManifest>) => !!m.sources?.["<runtime>/typesol_builtins.c"];
  if (a.host && b.host && (a.host.os !== b.host.os || a.host.arch !== b.host.arch)) {
    if (!(linksRuntimeBuiltins(a) && linksRuntimeBuiltins(b))) out.push("host");
    else if (!MEASURED_HOSTS.includes(`${a.host.os}-${a.host.arch}`) || !MEASURED_HOSTS.includes(`${b.host.os}-${b.host.arch}`))
      out.push("host (not measured)");
  }
  return out;
}

/** The hosts (`<os>-<arch>`) on which programs were measured to build to the same bytes (docs/stability.md). */
export const MEASURED_HOSTS: readonly string[] = ["darwin-arm64", "linux-arm64", "linux-x64"];

/** The ELF's own length (it ends with the section header table): a program account keeps it zero-padded. */
export function elfLength(elf: Buffer): number {
  if (elf.length < 0x40 || elf.readUInt32BE(0) !== 0x7f454c46) return elf.length;
  const end = Number(elf.readBigUInt64LE(0x28)) + elf.readUInt16LE(0x3a) * elf.readUInt16LE(0x3c);
  return end > 0 && end <= elf.length ? end : elf.length;
}

/**
 * Whether `deployed` (a .so, e.g. from `solana program dump`) is exactly what `entry` builds to. Program accounts
 * keep the ELF zero-padded to their allocation, so trailing zeros are ignored.
 */
export function verifyBinary(deployed: Buffer, built: Buffer): boolean {
  let end = deployed.length;
  while (end > built.length && deployed[end - 1] === 0) end--;
  return end === built.length && deployed.subarray(0, end).equals(built);
}
