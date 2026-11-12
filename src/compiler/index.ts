import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import ts from "typescript";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyze, LIB_PATH } from "./analyze.js";
import { hintForTypeScript } from "./hints.js";
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

export interface Generated {
  model: ProgramModel;
  c: string;
  /** The TypeSOL source files of the program (entry and relative imports). */
  files: string[];
}

/** Typecheck, enforce the TypeSOL subset, and generate C. Throws CompileError with every diagnostic. */
export function generate(entry: string, opts: EmitOptions = {}): Generated {
  const analysis = analyze(entry, opts.files);
  analysis.reporter.throwIfAny();
  const c = emitProgram(analysis, opts);
  analysis.reporter.throwIfAny();
  return { model: analysis.model, c, files: analysis.files };
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

/** Full build: `<outDir>/<name>.c`, `<name>.so`, `<name>.json` (Anchor IDL). */
export function build(entry: string, outDir: string, programAddress: string, opts: { sbpf?: Sbpf; profile?: boolean } = {}): BuildResult {
  const gen = generate(entry, { profile: opts.profile });
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, gen.model.name);
  const cPath = `${base}.c`;
  const soPath = `${base}.so`;
  const idlPath = `${base}.json`;
  writeFileSync(cPath, gen.c);
  // Before clang runs: an untested toolchain is a warning (once), or an error in strict mode.
  const toolchain = checkToolchain();
  buildSharedObject(cPath, soPath, opts.sbpf);
  const idl = buildIdl(gen.model, programAddress);
  writeFileSync(idlPath, JSON.stringify(idl, null, 2) + "\n");
  const root = path.dirname(path.resolve(entry));
  const sources: Record<string, string> = {};
  for (const f of gen.files) sources[path.relative(root, f)] = sha256(readFileSync(f));
  sources["<runtime>/typesol_rt.h"] = sha256(readFileSync(path.join(RUNTIME_DIR, "typesol_rt.h")));
  sources["<runtime>/typesol_builtins.c"] = sha256(readFileSync(BUILTINS_SOURCE));
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
  const manifestPath = `${base}.build.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { ...gen, cPath, soPath, idlPath, idl, manifest, manifestPath };
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
