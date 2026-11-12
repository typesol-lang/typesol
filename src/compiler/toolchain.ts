import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_DIR = fileURLToPath(new URL("../../runtime/", import.meta.url));

/** SBPF versions the C SDK targets: v0 (default, every cluster), v1 and v2 (where the feature gates are active). */
export type Sbpf = "v0" | "v1" | "v2";

/** Executable names: platform-tools ship .exe files on Windows. */
const EXE = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);
export const SBPF_VERSIONS: readonly Sbpf[] = ["v0", "v1", "v2"];

export interface Toolchain {
  sdk: string;
  clang: string;
  lld: string;
  linkerScript: string;
  includes: string[];
  libDir: string;
  /**
   * platform-tools' compiler-builtins Rust library for this SBPF version. Not linked (programs link the runtime's own
   * builtins, runtime/typesol_builtins.c, which build the same on each host measured); its presence tells that the
   * platform-tools have this SBPF version's libraries, and the builtins tests compare against it.
   */
  compilerBuiltins: string;
}

/** The runtime's compiler builtins, compiled with each program and linked in place of compiler-builtins. */
export const BUILTINS_SOURCE = path.join(RUNTIME_DIR, "typesol_builtins.c");

/** What is missing when there is no toolchain to build with, so `doctor` and `init` can say which commands to run. */
export class ToolchainMissing extends Error {
  constructor(
    /** "agave": no Agave CLI (no SDK); "platform-tools": the CLI without its platform-tools; "sbpf-libraries": platform-tools without this SBPF version. */
    readonly kind: "agave" | "platform-tools" | "sbpf-libraries",
    /** What is missing, in one clause. */
    readonly summary: string,
    fix: string,
  ) {
    super(`${summary}. ${fix}`);
    this.name = "ToolchainMissing";
  }
}

/** Locate the Solana C SDK that ships with the Agave CLI's platform-tools. */
export function findToolchain(sbpf: Sbpf = "v0", host: { platform: string; arch: string } = process): Toolchain {
  // Where the Agave installer puts it, or next to `cargo-build-sbf` on PATH (custom --data-dir, Homebrew, Docker…).
  const onPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((dir) => [path.join(dir, "platform-tools-sdk/sbf"), path.join(dir, "sdk/sbf")])
    .filter((p) => existsSync(path.join(path.dirname(path.dirname(p)), EXE("cargo-build-sbf"))));
  const override = process.env.TYPESOL_SBF_SDK;
  if (override && !existsSync(path.join(override, "c/sbf.mk")))
    throw new Error(`TYPESOL_SBF_SDK=${override} is not a platform-tools-sdk/sbf directory (no c/sbf.mk there)`);
  const candidates = [
    override,
    path.join(os.homedir(), ".local/share/solana/install/active_release/bin/platform-tools-sdk/sbf"),
    path.join(os.homedir(), ".local/share/solana/install/active_release/bin/sdk/sbf"),
    ...onPath,
  ].filter((p): p is string => !!p);
  const sdk = candidates.find((p) => existsSync(path.join(p, "c/sbf.mk")));
  if (!sdk)
    throw linuxArm64(host)
      ? new ToolchainMissing(
          "agave",
          "no Solana SBF SDK: TYPESOL_SBF_SDK is not set, and there is no Agave CLI for Linux arm64",
          `Install the platform-tools' linux-aarch64 package and the SDK's C files:${block(installLines("agave", host))}`,
        )
      : new ToolchainMissing(
          "agave",
          "the Agave CLI is not installed (no Solana SBF SDK under ~/.local/share/solana/install/active_release or next to cargo-build-sbf on PATH)",
          `Set TYPESOL_SBF_SDK to a platform-tools-sdk/sbf directory, or install the Agave CLI and its platform-tools:${block(installLines("agave", host))}`,
        );
  const llvm = path.join(sdk, "dependencies/platform-tools/llvm");
  const clang = path.join(llvm, "bin", EXE("clang"));
  if (!existsSync(clang))
    throw new ToolchainMissing(
      "platform-tools",
      // On Linux arm64 there is no Agave CLI: the SDK found is the one TYPESOL_SBF_SDK names.
      linuxArm64(host)
        ? `the SBF SDK at ${sdk} has no platform-tools (nothing under ${sdk}/dependencies)`
        : `the Agave CLI is installed, but not its platform-tools (nothing under ${sdk}/dependencies)`,
      `Install them once:${block(installLines("platform-tools", host))}`,
    );
  // Newest clang resource directory (numeric order: "9" < "19").
  const clangInc = readdirSync(path.join(llvm, "lib/clang"))
    .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b))
    .at(-1)!;
  const target = sbpf === "v0" ? "sbpf" : `sbpf${sbpf}`;
  const rustlib = path.join(sdk, `dependencies/platform-tools/rust/lib/rustlib/${target}-solana-solana/lib`);
  const builtins = existsSync(rustlib) ? readdirSync(rustlib).find((f) => f.startsWith("libcompiler_builtins-") && f.endsWith(".rlib")) : undefined;
  if (!builtins)
    throw new ToolchainMissing(
      "sbpf-libraries",
      `these platform-tools have no SBPF ${sbpf} libraries (${rustlib})`,
      `Build for another --sbpf, or install the tested ones:${block(installLines("platform-tools", host))}`,
    );
  return {
    sdk,
    clang,
    lld: path.join(llvm, "bin", EXE("ld.lld")),
    linkerScript: path.join(sdk, "c/sbf.ld"),
    includes: [path.join(sdk, "c/inc"), path.join(llvm, "lib/clang", clangInc, "include"), path.join(llvm, `${target}/include`), RUNTIME_DIR],
    libDir: path.join(llvm, `lib/${target}`),
    compilerBuiltins: path.join(rustlib, builtins),
  };
}

/** Compile generated C to an SBF shared object (same flags as the SDK's sbf.mk for the chosen SBPF version). */
/** The SBF stack frame of one function. */
export const STACK_FRAME = 4096;

/** clang's flags for SBF objects (the SDK's sbf.mk for the chosen SBPF version, plus TypeSOL's warnings). */
export function sbfCflags(sbpf: Sbpf = "v0"): string[] {
  return [
    "-Werror",
    "-Wno-parentheses-equality",
    // Generated checks may be always true/false (`a === a`, `enumByte >= 256` for a 256-variant enum); that is not an error.
    "-Wno-tautological-compare",
    // SBPF v0 gives every function a fixed 4 KiB stack frame; past it the program corrupts memory instead of failing.
    // v1 and v2 grow frames dynamically, so the limit does not apply there.
    ...(sbpf === "v0" ? [`-Wframe-larger-than=${STACK_FRAME}`] : []),
    "-O2",
    "-fno-builtin",
    // One section per function and constant, so the linker's --gc-sections can drop what nothing reaches.
    "-ffunction-sections",
    "-fdata-sections",
    "-std=c17",
    "-target",
    "sbf",
    "-fPIC",
    ...(sbpf === "v0" ? [] : [`-mcpu=${sbpf}`]),
  ];
}

/** The flags runtime/typesol_builtins.c is compiled with: the program's, and the SBPF version (its assembly differs). */
export function builtinsCflags(sbpf: Sbpf = "v0"): string[] {
  return [...sbfCflags(sbpf), `-DTS_SBPF_${sbpf.toUpperCase()}`];
}

export function buildSharedObject(cFile: string, outSo: string, sbpf: Sbpf = "v0", tc = findToolchain(sbpf)): void {
  const obj = outSo.replace(/\.so$/, ".o");
  const builtinsObj = outSo.replace(/\.so$/, ".builtins.o");
  const cflags = sbfCflags(sbpf);
  const incs = tc.includes.flatMap((i, n) => (n < 2 ? ["-isystem", i] : ["-I", i]));
  try {
    run(tc.clang, [...cflags, ...incs, "-o", obj, "-c", cFile]);
  } catch (e) {
    const message = (e as Error).message;
    if (!STACK_OVER.test(message)) throw e;
    // Compiled again with debug info for clang's frame layout: which locals take the room.
    const layoutFlags = cflags.filter((f) => f !== "-Werror" && !f.startsWith("-Wframe-larger-than"));
    const res = spawnSync(tc.clang, [...layoutFlags, ...incs, "-g", "-w", "-Rpass-analysis=stack-frame-layout", "-o", obj, "-c", cFile], {
      encoding: "utf8",
      // A large program's remarks (one per function, every slot listed) run past the default 1 MiB.
      maxBuffer: 256 * 1024 * 1024,
    });
    rmSync(obj, { force: true });
    throw stackError(message, frameLayouts(res.stderr ?? ""), readFileSync(cFile, "utf8"));
  }
  try {
    // The builtins (128-bit multiplication, division and shifts, signed 64-bit division) from the runtime's C, after
    // the program's object. platform-tools' compiler-builtins library has the same instructions in each host package
    // but split into other archive members, so the linker laid them out in another order on each host; this does not.
    run(tc.clang, [...builtinsCflags(sbpf), "-o", builtinsObj, "-c", BUILTINS_SOURCE]);
    linkSharedObject([obj, builtinsObj], outSo, tc);
  } finally {
    rmSync(obj, { force: true }); // the object files are only intermediates
    rmSync(builtinsObj, { force: true });
  }
}

/** Link SBF objects into a program: libc from platform-tools, nothing from its Rust libraries. */
export function linkSharedObject(objects: string[], outSo: string, tc: Toolchain, extra: string[] = []): void {
  run(tc.lld, [
    "-z",
    "notext",
    "-shared",
    "--Bdynamic",
    tc.linkerScript,
    "--entry",
    "entrypoint",
    "-L",
    tc.libDir,
    "-z",
    "max-page-size=4096",
    // Drop unreachable code (the builtins a program does not call) and the symbol tables, which the loader never
    // reads: smaller programs cost less rent and upload time.
    "--gc-sections",
    "--strip-all",
    "-lc",
    "-o",
    outSo,
    ...objects,
    ...extra,
  ]);
  const missing = unresolvedSymbols(readFileSync(outSo)).filter((s) => !isSyscall(s));
  if (missing.length) {
    rmSync(outSo, { force: true });
    // Another clang may call a builtin the tested one never does: say that first, as it is then the likely cause.
    let info: ToolchainInfo | undefined;
    try {
      info = toolchainInfo(tc);
    } catch {
      /* the version cannot be read: no claim about it */
    }
    const t = TESTED_TOOLCHAIN;
    throw new Error(
      (info && !info.tested
        ? `this toolchain is not the tested one (${shortClang(info.clang)}${info.platformTools ? `, platform-tools ${info.platformTools}` : ""}; ` +
          `TESTED_TOOLCHAIN is ${shortClang(t.clang)}, platform-tools ${t.platformTools}), and its clang may call compiler builtins the tested one ` +
          `does not, which runtime/typesol_builtins.c does not define: build with the tested toolchain (the command is below). `
        : "") +
        `the program calls ${missing.join(", ")}, which neither the runtime nor libc defines and the SBF loader cannot resolve as a syscall ` +
        `(with the tested toolchain, a compiler builtin missing from runtime/typesol_builtins.c is a TypeSOL bug: please report it with the program)` +
        (info && !info.tested ? `. The tested toolchain:${block([INSTALL_TESTED_TOOLCHAIN[1]])}` : ""),
    );
  }
}

/**
 * The syscalls a TypeSOL program may leave to the SBF loader: every one the SDK's headers declare (`@SYSCALL` in
 * platform-tools-sdk/sbf/c/inc/sol/inc/*.inc) and every one runtime/typesol_rt.h declares itself, with `abort`.
 * test/cli/toolchain.test.ts checks that this is exactly that set.
 */
export const SYSCALLS: readonly string[] = [
  "abort",
  "sol_alt_bn128_compression",
  "sol_alt_bn128_group_op",
  "sol_big_mod_exp",
  "sol_blake3",
  "sol_create_program_address",
  "sol_curve_validate_point",
  "sol_get_clock_sysvar",
  "sol_get_epoch_rewards_sysvar",
  "sol_get_epoch_schedule_sysvar",
  "sol_get_last_restart_slot",
  "sol_get_rent_sysvar",
  "sol_get_return_data",
  "sol_get_stack_height",
  "sol_invoke_signed_c",
  "sol_keccak256",
  "sol_log_",
  "sol_log_64_",
  "sol_log_compute_units_",
  "sol_log_data",
  "sol_log_pubkey",
  "sol_memcpy_",
  "sol_memmove_",
  "sol_memset_",
  "sol_panic_",
  "sol_poseidon",
  "sol_remaining_compute_units",
  "sol_secp256k1_recover",
  "sol_set_return_data",
  "sol_sha256",
  "sol_try_find_program_address",
];

/** Whether the SBF loader resolves `name` as a syscall for a TypeSOL program (one of SYSCALLS). */
export function isSyscall(name: string): boolean {
  return SYSCALLS.includes(name);
}

/** The undefined symbols of an SBF shared object's dynamic symbol table (what the loader resolves as syscalls). */
export function unresolvedSymbols(elf: Buffer): string[] {
  if (elf.length < 0x40 || elf.readUInt32BE(0) !== 0x7f454c46) throw new Error("not an ELF file");
  const shoff = Number(elf.readBigUInt64LE(0x28));
  const shentsize = elf.readUInt16LE(0x3a);
  const shnum = elf.readUInt16LE(0x3c);
  const section = (i: number) => {
    const at = shoff + i * shentsize;
    return {
      type: elf.readUInt32LE(at + 4),
      offset: Number(elf.readBigUInt64LE(at + 0x18)),
      size: Number(elf.readBigUInt64LE(at + 0x20)),
      link: elf.readUInt32LE(at + 0x28),
    };
  };
  const out: string[] = [];
  for (let i = 0; i < shnum; i++) {
    const s = section(i);
    if (s.type !== 11) continue; // SHT_DYNSYM
    const strtab = section(s.link);
    for (let at = s.offset + 24; at + 24 <= s.offset + s.size; at += 24) {
      if (elf.readUInt16LE(at + 6) !== 0) continue; // st_shndx: defined
      const nameAt = strtab.offset + elf.readUInt32LE(at);
      const end = elf.indexOf(0, nameAt);
      const name = elf.toString("latin1", nameAt, end);
      if (name) out.push(name);
    }
  }
  return out;
}

/**
 * The toolchain this release is tested with: CI installs exactly this Agave CLI and platform-tools, and every
 * execution, differential and fuzz test runs on binaries this clang built. The C TypeSOL emits is only checked
 * against this backend; another clang can compile it differently (how struct arguments are passed, for one), so
 * binaries from another toolchain are outside what the tests cover. Changing it is a release note.
 */
export const TESTED_TOOLCHAIN = {
  agave: "3.1.10",
  platformTools: "v1.52",
  clang: "clang version 20.1.7-rust-dev (https://github.com/anza-xyz/llvm-project.git 78496716176191b2dfb728e5e38501812e7467db)",
} as const;

/** The commands that install the tested toolchain (the Agave CLI, then its platform-tools). */
export const INSTALL_TESTED_TOOLCHAIN = [
  `sh -c "$(curl -sSfL https://release.anza.xyz/v${TESTED_TOOLCHAIN.agave}/install)"`,
  `cargo-build-sbf --install-only --force-tools-install --tools-version ${TESTED_TOOLCHAIN.platformTools}`,
] as const;

/**
 * The Agave installer adds its bin directory to PATH in ~/.profile only, which the shell that ran it does not read:
 * without this line the next command is "cargo-build-sbf: command not found".
 */
export const AGAVE_PATH = 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"';

/**
 * Linux arm64: Anza publishes no Agave CLI for it (its installer fails with a 404), but platform-tools has a
 * linux-aarch64 package. The C SDK (headers and linker script, text) comes from the x86_64 Agave release, as in the
 * --docker image, and TYPESOL_SBF_SDK points the compiler at the result. Building and LiteSVM tests work; deploying
 * needs a Solana CLI from another host.
 */
const ARM64_SDK = "$HOME/.local/share/typesol-sdk";
/** A path under ARM64_SDK as a shell word: quoted, as AGAVE_PATH quotes $HOME, so a HOME with a space works. */
const arm64Path = (rest: string) => `"${ARM64_SDK}${rest}"`;
export const linuxArm64 = (host: { platform: string; arch: string } = process) => host.platform === "linux" && host.arch === "arm64";
export const LINUX_ARM64_INSTALL: readonly string[] = [
  `mkdir -p ${arm64Path("/sbf/dependencies/platform-tools")}`,
  `curl -sSfL https://github.com/anza-xyz/agave/releases/download/v${TESTED_TOOLCHAIN.agave}/solana-release-x86_64-unknown-linux-gnu.tar.bz2 | tar -xj -C ${arm64Path("")} --strip-components=3 solana-release/bin/platform-tools-sdk/sbf/c`,
  `curl -sSfL https://github.com/anza-xyz/platform-tools/releases/download/${TESTED_TOOLCHAIN.platformTools}/platform-tools-linux-aarch64.tar.bz2 | tar -xj -C ${arm64Path("/sbf/dependencies/platform-tools")}`,
  `touch ${arm64Path(`/sbf/dependencies/platform-tools-${TESTED_TOOLCHAIN.platformTools}.md`)}`,
  `export TYPESOL_SBF_SDK=${arm64Path("/sbf")}`,
];

/**
 * What to run to get the tested toolchain on this host: from nothing ("agave"), or when the Agave CLI is there and
 * its platform-tools are not. `cargo-build-sbf --version` downloads nothing and `cargo-build-sbf --force-tools-install`
 * alone needs a Cargo project; only `--install-only` installs the platform-tools by themselves.
 */
export function installCommands(from: "agave" | "platform-tools", host: { platform: string; arch: string } = process): string[] {
  if (linuxArm64(host)) return [...LINUX_ARM64_INSTALL];
  return from === "agave" ? [INSTALL_TESTED_TOOLCHAIN[0], AGAVE_PATH, INSTALL_TESTED_TOOLCHAIN[1]] : [INSTALL_TESTED_TOOLCHAIN[1]];
}

/**
 * The note printed on its own line above an install command, when what it does is not obvious; undefined for the
 * others. A note is a `#` line holding no character a shell treats specially (no parentheses, `;`, `$`, quotes,
 * `<`, `>`, `|`, `&`, `!`, `*`, `?`, brackets or braces), so a pasted block runs the same: bash and fish skip it as
 * a comment, and zsh, whose interactive shells do not read comments unless `interactive_comments` is set (the macOS
 * default), answers "command not found: #" and runs nothing from that line. A command line never carries a trailing
 * comment: zsh would hand it to the command as arguments (test/cli/doctor.test.ts pastes the blocks into each shell).
 */
export function installNote(command: string): string | undefined {
  if (command === AGAVE_PATH) return "# The installer adds this line to ~/.profile for new shells, and this shell needs it now:";
  if (command === INSTALL_TESTED_TOOLCHAIN[1])
    return "# Once: this downloads the platform-tools, about 0.5 GB and up to 1.6 GB unpacked, and prints nothing for a minute or two:";
  if (command.startsWith("export TYPESOL_SBF_SDK=")) return "# Add this line to ~/.profile too, for new shells:";
  if (command.includes("/platform-tools-linux-aarch64.")) return "# About 515 MB, 1.6 GB unpacked, and quiet for a minute or two:";
  if (command.includes("/solana-release-")) return "# About 215 MB, for the C headers and linker script of the SDK only:";
  return undefined;
}

/** installCommands with each command's note on the line above it: the lines `init`, `doctor` and the build print. */
export function installLines(from: "agave" | "platform-tools", host: { platform: string; arch: string } = process): string[] {
  return installCommands(from, host).flatMap((c) => {
    const note = installNote(c);
    return note ? [note, c] : [c];
  });
}

/** An install block inside an error message: each line on its own, indented, after the sentence that ends with ":". */
const block = (lines: readonly string[]) => lines.map((l) => `\n    ${l}`).join("");

// One `clang --version` per clang a process uses: up-to-date checks and manifests ask for it on every build.
const clangVersions = new Map<string, string>();

/** The clang version string (the first line of `clang --version`), for build manifests. */
export function toolchainVersion(tc = findToolchain()): string {
  let v = clangVersions.get(tc.clang);
  if (v === undefined) {
    v = execFileSync(tc.clang, ["--version"], { encoding: "utf8" }).split("\n")[0]!.trim();
    clangVersions.set(tc.clang, v);
  }
  return v;
}

/**
 * The platform-tools version of an SDK, or undefined when it cannot be told for sure. cargo-build-sbf records the
 * installed version as an empty `dependencies/platform-tools-<version>.md` next to `dependencies/platform-tools`,
 * which links into `~/.cache/solana/<version>/platform-tools`; both have to agree when both are there.
 */
export function platformToolsVersion(tc: Pick<Toolchain, "sdk"> = findToolchain()): string | undefined {
  const deps = path.join(tc.sdk, "dependencies");
  let markers: string[];
  try {
    markers = readdirSync(deps).flatMap((f) => /^platform-tools-(v\d+\.\d+(?:\.\d+)?)\.md$/.exec(f)?.[1] ?? []);
  } catch {
    return undefined;
  }
  let linked: string | undefined;
  try {
    linked = /[/\\](v\d+\.\d+(?:\.\d+)?)[/\\]platform-tools$/.exec(realpathSync(path.join(deps, "platform-tools")))?.[1];
  } catch {
    /* no platform-tools directory */
  }
  if (linked) return markers.length === 0 || markers.includes(linked) ? linked : undefined;
  return markers.length === 1 ? markers[0] : undefined;
}

/** A clang version line made short enough for a message: `clang 20.1.7-rust-dev (anza-xyz/llvm-project 78496716)`. */
export function shortClang(version: string): string {
  return version
    .replace(/^clang version /, "clang ")
    .replace(/\(https:\/\/github\.com\/([^\s)]+?)(?:\.git)? ([0-9a-f]{8})[0-9a-f]*\)/, "($1 $2)")
    .trim();
}

export interface ToolchainInfo {
  clang: string;
  platformTools?: string;
  /** The clang is the one the release is tested with. */
  tested: boolean;
}

/** The active toolchain's versions, and whether it is the tested one (the clang is what compiles, so it decides). */
export function toolchainInfo(tc = findToolchain()): ToolchainInfo {
  const clang = toolchainVersion(tc);
  return { clang, platformTools: platformToolsVersion(tc), tested: clang === TESTED_TOOLCHAIN.clang };
}

/** What to say about a toolchain that is not the tested one; undefined for the tested one. */
export function untestedToolchainMessage(info: ToolchainInfo, strict = false): string | undefined {
  if (info.tested) return undefined;
  const t = TESTED_TOOLCHAIN;
  return (
    `${strict ? "refusing to build with" : "this build uses"} ${shortClang(info.clang)}${info.platformTools ? ` (platform-tools ${info.platformTools})` : ""}; ` +
    `TypeSOL is tested with ${shortClang(t.clang)} (platform-tools ${t.platformTools}, Agave ${t.agave}). ` +
    `Binaries from an untested toolchain are not covered by the project's tests` +
    (strict ? ", and an untested toolchain is an error with --toolchain-strict or TYPESOL_TOOLCHAIN=strict" : "") +
    `. Install the tested one:${block([INSTALL_TESTED_TOOLCHAIN[1]])}`
  );
}

let strictFlag = false;
let warned = false;

/** `--toolchain-strict`: refuse an untested toolchain for the rest of the process, as TYPESOL_TOOLCHAIN=strict does. */
export function setToolchainStrict(on = true): void {
  strictFlag = on;
}

/** Whether an untested toolchain is an error: `--toolchain-strict` or TYPESOL_TOOLCHAIN=strict ("warn", the default). */
export function toolchainStrict(): boolean {
  const env = process.env.TYPESOL_TOOLCHAIN;
  if (env && env !== "strict" && env !== "warn") throw new Error(`TYPESOL_TOOLCHAIN=${env}: expected "strict" or "warn"`);
  return strictFlag || env === "strict";
}

/**
 * Before a build: an untested toolchain gets one warning per process on stderr (a workspace or a test run builds many
 * programs), or an error in strict mode. `info` is the active toolchain's, unless given.
 */
export function checkToolchain(info: ToolchainInfo = toolchainInfo(), warn: (message: string) => void = (m) => console.error(`warning: ${m}`)): ToolchainInfo {
  const message = untestedToolchainMessage(info);
  if (!message) return info;
  if (toolchainStrict()) throw new Error(untestedToolchainMessage(info, true));
  if (!warned) {
    warned = true;
    warn(message);
  }
  return info;
}

const STACK_OVER = /stack frame size \((\d+)\) exceeds limit \((\d+)\) in '(\w+)'/;

/** One variable slot of a function's stack frame as clang laid it out: its size and the C variables sharing it. */
export interface FrameSlot {
  size: number;
  vars: { name: string; line: number }[];
}

/** clang's `-Rpass-analysis=stack-frame-layout` remarks: each function's variable slots. */
export function frameLayouts(remarks: string): Map<string, FrameSlot[]> {
  const out = new Map<string, FrameSlot[]>();
  for (const block of remarks.split(/^Function: /m).slice(1)) {
    const lines = block.split("\n");
    const fn = lines[0]!.trim().split(/\s/)[0]!;
    const slots: FrameSlot[] = [];
    let slot: FrameSlot | undefined;
    for (const l of lines.slice(1)) {
      const off = /^Offset: \[SP-?\d+\], Type: (\w+), Align: \d+, Size: (\d+)/.exec(l);
      if (off) {
        slot = off[1] === "Variable" ? { size: Number(off[2]), vars: [] } : undefined;
        if (slot) slots.push(slot);
        continue;
      }
      const v = /^ {4}(\w+) @ .*:(\d+)(\s|$)/.exec(l);
      if (v && slot) slot.vars.push({ name: v[1]!, line: Number(v[2]) });
      else slot = undefined;
    }
    out.set(fn, slots);
  }
  return out;
}

/**
 * clang's frame-size errors in the program's terms: which instruction or helper, how much, the locals that take the
 * room (from `layouts`, clang's frame layout of the generated C `c`) and what to do.
 */
export function stackError(message: string, layouts = new Map<string, FrameSlot[]>(), c = ""): Error {
  const over = [...message.matchAll(new RegExp(STACK_OVER.source, "g"))];
  // clang inlines helpers into their callers, so an instruction's frame includes theirs.
  const what = (fn: string) =>
    fn.startsWith("ix_") ? `instruction ${fn.slice(3)} (with the helpers inlined into it)` : fn.startsWith("fn_") ? `helper ${fn.slice(3)}()` : fn;
  // Anything else clang reported in the same run stays in the message.
  const rest = message
    .split("\n")
    .filter((l) => / error: /.test(l) && !/-Wframe-larger-than/.test(l))
    .join("\n");
  const cLines = c.split("\n");
  // The C function a line of the generated C belongs to.
  const fnAt = (line: number): string | undefined => {
    for (let i = line - 1; i >= 0; i--) {
      const m = /^(?:__attribute__\(\(noinline\)\) )?static uint64_t ((?:fn|ix)_\w+)\(.*\) \{$/.exec(cLines[i] ?? "");
      if (m) return m[1];
    }
    return undefined;
  };
  // The source location nearest a line: the generated C carries one in its runtime messages ("(file.ts:12)").
  const near = (line: number): string | undefined => {
    for (let d = 0; d < 40; d++)
      for (const i of [line - 1 + d, line - 1 - d]) {
        const m = /\(([\w.-]+\.ts):(\d+)\)/.exec(cLines[i] ?? "");
        if (m) return `${m[1]}:${m[2]}`;
      }
    return undefined;
  };
  // The C functions' bodies, and the struct and list locals of the helpers `fn` calls that clang may inline into it.
  const bodies = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const l of cLines) {
    const m = /^(__attribute__\(\(noinline\)\) )?static uint64_t ((?:fn|ix)_\w+)\(.*\) \{$/.exec(l);
    if (m) bodies.set(m[2]!, (current = []));
    else if (l === "}") current = undefined;
    else current?.push(l);
  }
  const noinline = new Set(cLines.flatMap((l) => /^__attribute__\(\(noinline\)\) static uint64_t ((?:fn|ix)_\w+)\(/.exec(l)?.[1] ?? []));
  const inlinedLocals = (fn: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (f: string) => {
      for (const l of bodies.get(f) ?? [])
        for (const call of l.matchAll(/\b(fn_\w+)\(/g)) {
          const callee = call[1]!;
          if (seen.has(callee) || noinline.has(callee)) continue;
          seen.add(callee);
          for (const d of bodies.get(callee) ?? []) {
            const local = /^\s+TS[SFE]_\w+ l_(\w+?)_\d+(__v)?;$/.exec(d);
            if (local) out.push(`\`${local[1]}\` (${callee.slice(3)}())`);
          }
          visit(callee);
        }
    };
    visit(fn);
    return out;
  };
  const describe = (name: string): string => {
    const local = /^l_(\w+?)_\d+(__v|__h)?$/.exec(name);
    if (local) return `\`${local[1]}\``;
    if (/^p_\w+$/.test(name)) return `parameter \`${name.slice(2)}\``;
    const temps: [RegExp, string][] = [
      [/^fv\d+$/, "a list literal's temporary"],
      [/^st\d+$/, "a struct literal's temporary"],
      [/^de\d+$/, "a data enum literal's temporary"],
      [/^evv\d+$/, "an event's FixedVec"],
      [/^bv\d+$/, "a pushBorsh value"],
      [/^t\d+$/, "a helper's result"],
      [/^s\d+$/, "a log line's text"],
    ];
    return temps.find(([re]) => re.test(name))?.[1] ?? `a temporary (${name})`;
  };
  const locals = (fn: string): string => {
    const slots = (layouts.get(fn) ?? []).filter((s) => s.size >= 64).sort((a, b) => b.size - a.size);
    if (!slots.length) return "";
    const shown = slots.slice(0, 5).map((s) => {
      const names = s.vars.map((v) => {
        const owner = fnAt(v.line);
        const at = near(v.line);
        const where = [owner && owner !== fn ? `in ${what(owner).replace(" (with the helpers inlined into it)", "")}` : "", at ? `near ${at}` : ""]
          .filter(Boolean)
          .join(", ");
        return `${describe(v.name)}${where ? ` (${where})` : ""}`;
      });
      // Variables whose lifetimes do not overlap share a slot. clang names no variable of an inlined helper.
      return `${s.size} bytes: ${names.length ? [...new Set(names)].join(" / ") : "unnamed"}`;
    });
    const unnamed = slots.slice(0, 5).some((s) => !s.vars.length);
    const inlined = unnamed ? inlinedLocals(fn) : [];
    return (
      `\n  biggest locals: ${shown.join("; ")}` +
      (unnamed
        ? inlined.length
          ? `\n  (unnamed: locals of the helpers inlined into it, among ${inlined.join(", ")}, or copies clang made)`
          : "\n  (unnamed: copies clang made)"
        : "")
    );
  };
  return new Error(
    over.map((m) => `${what(m[3]!)} needs ${m[1]} bytes of stack; SBPF v0 gives each function ${m[2]}${locals(m[3]!)}`).join("\n") +
      "\nKeep large structs and arrays in account data (bind them with const: a reference, not a copy), give a large local list or struct its own room with /** @heap */ (in an instruction), or move work that needs large locals of its own into a /** @noinline */ helper, which gets its own 4 KiB frame." +
      (rest ? `\n${rest}` : ""),
  );
}

function run(cmd: string, args: string[]) {
  try {
    execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    throw new Error(`${path.basename(cmd)} failed:\n${err.stderr?.toString() ?? ""}${err.stdout?.toString() ?? ""}`);
  }
}
