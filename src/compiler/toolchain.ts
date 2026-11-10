import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  compilerBuiltins: string;
}

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

export function buildSharedObject(cFile: string, outSo: string, sbpf: Sbpf = "v0", tc = findToolchain(sbpf)): void {
  const obj = outSo.replace(/\.so$/, ".o");
  const cflags = [
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
    });
    rmSync(obj, { force: true });
    throw stackError(message, frameLayouts(res.stderr ?? ""), readFileSync(cFile, "utf8"));
  }
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
    // Drop unreachable code (e.g. the parts of compiler-builtins' soft-float objects nothing calls) and the symbol
    // tables, which the loader never reads: smaller programs cost less rent and upload time.
    "--gc-sections",
    "--strip-all",
    "-lc",
    "-o",
    outSo,
    obj,
    tc.compilerBuiltins,
  ]);
  rmSync(obj, { force: true }); // the object file is only an intermediate
}

/** The clang version string, for build manifests. */
export function toolchainVersion(tc = findToolchain()): string {
  return execFileSync(tc.clang, ["--version"], { encoding: "utf8" }).split("\n")[0].trim();
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
    execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer };
    throw new Error(`${path.basename(cmd)} failed:\n${err.stderr?.toString() ?? ""}${err.stdout?.toString() ?? ""}`);
  }
}
