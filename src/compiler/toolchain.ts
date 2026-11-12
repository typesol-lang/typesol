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

/** Locate the Solana C SDK that ships with the Agave CLI's platform-tools. */
export function findToolchain(sbpf: Sbpf = "v0"): Toolchain {
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
    throw new Error(
      "Solana SBF SDK not found. Install the Agave CLI (https://docs.anza.xyz/cli/install) and run `cargo-build-sbf --version` once, or set TYPESOL_SBF_SDK to its platform-tools-sdk/sbf directory.",
    );
  const llvm = path.join(sdk, "dependencies/platform-tools/llvm");
  const clang = path.join(llvm, "bin", EXE("clang"));
  if (!existsSync(clang)) throw new Error(`platform-tools missing under ${sdk}/dependencies. Run \`cargo-build-sbf --force-tools-install\` once.`);
  // Newest clang resource directory (numeric order: "9" < "19").
  const clangInc = readdirSync(path.join(llvm, "lib/clang"))
    .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b))
    .at(-1)!;
  const target = sbpf === "v0" ? "sbpf" : `sbpf${sbpf}`;
  const rustlib = path.join(sdk, `dependencies/platform-tools/rust/lib/rustlib/${target}-solana-solana/lib`);
  const builtins = existsSync(rustlib) ? readdirSync(rustlib).find((f) => f.startsWith("libcompiler_builtins-") && f.endsWith(".rlib")) : undefined;
  if (!builtins)
    throw new Error(
      `these platform-tools have no SBPF ${sbpf} libraries (${rustlib}). Update them with \`cargo-build-sbf --force-tools-install\`, or build for another --sbpf.`,
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
    throw new Error(
      `the program calls ${missing.join(", ")}, which neither the runtime nor libc defines and the SBF loader cannot resolve ` +
        `(a compiler builtin missing from runtime/typesol_builtins.c is a TypeSOL bug: please report it with the program)`,
    );
  }
}

/** Syscalls the SBF loader resolves by name: `abort` and the `sol_*` family. */
export function isSyscall(name: string): boolean {
  return name === "abort" || name.startsWith("sol_");
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
export function untestedToolchainMessage(info: ToolchainInfo): string | undefined {
  if (info.tested) return undefined;
  const t = TESTED_TOOLCHAIN;
  return (
    `this build uses ${shortClang(info.clang)}${info.platformTools ? ` (platform-tools ${info.platformTools})` : ""}; ` +
    `TypeSOL is tested with ${shortClang(t.clang)} (platform-tools ${t.platformTools}, Agave ${t.agave}). ` +
    `Binaries from an untested toolchain are not covered by the project's tests. ` +
    `Install the tested one: ${INSTALL_TESTED_TOOLCHAIN[1]}`
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
  if (toolchainStrict())
    throw new Error(
      `${message.replace(/^this build uses/, "refusing to build with")} (an untested toolchain is an error with --toolchain-strict or TYPESOL_TOOLCHAIN=strict)`,
    );
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
