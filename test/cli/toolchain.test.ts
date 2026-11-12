// The tested toolchain: the warning (once a process) and strict mode for another clang, doctor's row, what a build
// manifest records, the up-to-date check with manifests from before those fields, and verify's toolchain hint.
// Another clang is simulated without a second install: a copy of the SDK's layout made of links to the real one,
// whose clang is a script that reports another version and otherwise runs the real clang (the same bytes come out).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkToolchain,
  findToolchain,
  platformToolsVersion,
  setToolchainStrict,
  shortClang,
  TESTED_TOOLCHAIN,
  toolchainInfo,
  untestedToolchainMessage,
} from "../../src/compiler/toolchain.ts";
import { describeToolchain, elfLength, toolchainDifferences } from "../../src/compiler/index.ts";
import { buildForTest, findWorkspace } from "../../src/workspace.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "dist/cli.js");
const FAKE_CLANG = "clang version 99.1.0 (https://github.com/example/llvm-project.git 0123456789abcdef0123456789abcdef01234567)";
const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-toolchain-")));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** An SDK directory laid out like platform-tools `version`, whose clang reports FAKE_CLANG. */
function fakeSdk(version = "v9.99"): string {
  const real = findToolchain();
  const sdk = tmp();
  const realTools = path.join(real.sdk, "dependencies/platform-tools");
  const tools = path.join(sdk, "dependencies/platform-tools");
  mkdirSync(path.join(tools, "llvm/bin"), { recursive: true });
  symlinkSync(path.join(real.sdk, "c"), path.join(sdk, "c"));
  writeFileSync(path.join(sdk, `dependencies/platform-tools-${version}.md`), "");
  symlinkSync(path.join(realTools, "rust"), path.join(tools, "rust"));
  for (const e of readdirSync(path.join(realTools, "llvm"))) if (e !== "bin") symlinkSync(path.join(realTools, "llvm", e), path.join(tools, "llvm", e));
  for (const e of readdirSync(path.join(realTools, "llvm/bin")))
    if (e !== "clang") symlinkSync(path.join(realTools, "llvm/bin", e), path.join(tools, "llvm/bin", e));
  const clang = path.join(tools, "llvm/bin/clang");
  writeFileSync(clang, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${FAKE_CLANG}'; exit 0; fi\nexec '${real.clang}' "$@"\n`);
  chmodSync(clang, 0o755);
  return sdk;
}

const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
  spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, TYPESOL_TOOLCHAIN: "", ...env } });
const counter = () => {
  const dir = tmp();
  copyFileSync(path.join(ROOT, "examples/counter.ts"), path.join(dir, "counter.ts"));
  return dir;
};
const realIsTested = (() => {
  try {
    return toolchainInfo().tested;
  } catch {
    return false;
  }
})();

describe("the tested toolchain", () => {
  it("is declared once, and an untested one gets one warning a process", () => {
    expect(TESTED_TOOLCHAIN).toEqual({ agave: "3.1.10", platformTools: "v1.52", clang: expect.stringMatching(/^clang version 20\.1\.7-rust-dev /) });
    expect(shortClang(TESTED_TOOLCHAIN.clang)).toBe("clang 20.1.7-rust-dev (anza-xyz/llvm-project 78496716)");
    expect(untestedToolchainMessage({ clang: TESTED_TOOLCHAIN.clang, platformTools: "v1.52", tested: true })).toBeUndefined();
    const other = { clang: FAKE_CLANG, platformTools: "v9.99", tested: false };
    expect(untestedToolchainMessage(other)).toBe(
      "this build uses clang 99.1.0 (example/llvm-project 01234567) (platform-tools v9.99); TypeSOL is tested with clang 20.1.7-rust-dev " +
        "(anza-xyz/llvm-project 78496716) (platform-tools v1.52, Agave 3.1.10). Binaries from an untested toolchain are not covered by the " +
        "project's tests. Install the tested one: cargo-build-sbf --install-only --force-tools-install --tools-version v1.52",
    );
    const said: string[] = [];
    checkToolchain(other, (m) => said.push(m));
    checkToolchain(other, (m) => said.push(m));
    expect(said).toHaveLength(1);
  });

  it("is required in strict mode: --toolchain-strict (setToolchainStrict) or TYPESOL_TOOLCHAIN=strict", () => {
    const other = { clang: FAKE_CLANG, tested: false };
    const before = process.env.TYPESOL_TOOLCHAIN;
    try {
      process.env.TYPESOL_TOOLCHAIN = "strict";
      expect(() => checkToolchain(other)).toThrow(/^refusing to build with clang 99\.1\.0 .* error with --toolchain-strict or TYPESOL_TOOLCHAIN=strict\)$/);
      expect(checkToolchain({ clang: TESTED_TOOLCHAIN.clang, tested: true }).tested).toBe(true);
      process.env.TYPESOL_TOOLCHAIN = "loose";
      expect(() => checkToolchain(other)).toThrow('TYPESOL_TOOLCHAIN=loose: expected "strict" or "warn"');
      process.env.TYPESOL_TOOLCHAIN = "warn";
      setToolchainStrict();
      expect(() => checkToolchain(other)).toThrow(/^refusing to build/);
    } finally {
      setToolchainStrict(false);
      if (before === undefined) delete process.env.TYPESOL_TOOLCHAIN;
      else process.env.TYPESOL_TOOLCHAIN = before;
    }
  });

  it("reads the platform-tools version from the SDK's marker file and link, and only when they agree", () => {
    const sdk = (markers: string[], link?: string) => {
      const d = tmp();
      mkdirSync(path.join(d, "dependencies"));
      for (const m of markers) writeFileSync(path.join(d, `dependencies/platform-tools-${m}.md`), "");
      if (link) {
        mkdirSync(path.join(d, link), { recursive: true });
        symlinkSync(path.join(d, link), path.join(d, "dependencies/platform-tools"));
      }
      return { sdk: d };
    };
    expect(platformToolsVersion(sdk(["v1.52"]))).toBe("v1.52");
    expect(platformToolsVersion(sdk(["v1.52"], "cache/v1.52/platform-tools"))).toBe("v1.52");
    expect(platformToolsVersion(sdk([], "cache/v1.57/platform-tools"))).toBe("v1.57");
    expect(platformToolsVersion(sdk(["v1.52"], "cache/v1.57/platform-tools"))).toBeUndefined(); // they disagree
    expect(platformToolsVersion(sdk(["v1.51", "v1.52"]))).toBeUndefined(); // two markers, no link to choose
    expect(platformToolsVersion(sdk([]))).toBeUndefined();
    expect(platformToolsVersion({ sdk: path.join(tmp(), "none") })).toBeUndefined();
  });

  it("build warns once with another clang, refuses it in strict mode, and records the toolchain in <name>.build.json", () => {
    const sdk = fakeSdk();
    const env = { TYPESOL_SBF_SDK: sdk };
    const dir = tmp();
    expect(run(["init", ".", "--name", "one"], dir).status).toBe(0);
    expect(run(["new", "two"], dir).status).toBe(0);
    const built = run(["build"], dir, env);
    expect(built.status).toBe(0);
    // Two programs, one warning.
    expect(built.stderr.match(/warning: /g)).toHaveLength(1);
    expect(built.stderr).toContain("warning: this build uses clang 99.1.0 (example/llvm-project 01234567) (platform-tools v9.99); TypeSOL is tested with");
    expect(built.stderr).toContain("not covered by the project's tests");
    const manifest = JSON.parse(readFileSync(path.join(dir, "target/one/one.build.json"), "utf8"));
    expect(manifest).toMatchObject({ clang: FAKE_CLANG, platformTools: "v9.99", host: { os: process.platform, arch: process.arch } });

    for (const strict of [run(["build", "--toolchain-strict"], dir, env), run(["build"], dir, { ...env, TYPESOL_TOOLCHAIN: "strict" })]) {
      expect(strict.status).toBe(1);
      expect(strict.stderr).toMatch(/^error: refusing to build with clang 99\.1\.0 .*TYPESOL_TOOLCHAIN=strict\)$/m);
    }
    const file = counter();
    const single = run(["build", "counter.ts", "--toolchain-strict"], file, env);
    expect(single.status).toBe(1);
    expect(single.stderr).toMatch(/refusing to build/);
  });

  it.skipIf(!realIsTested)("the tested toolchain builds without a warning, also in strict mode", () => {
    const dir = counter();
    const r = run(["build", "counter.ts", "--toolchain-strict", "--quiet"], dir);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/warning/);
    const manifest = JSON.parse(readFileSync(path.join(dir, "target/counter.build.json"), "utf8"));
    expect(manifest).toMatchObject({ clang: TESTED_TOOLCHAIN.clang, platformTools: TESTED_TOOLCHAIN.platformTools });
  });

  it("doctor has a toolchain row: tested, or untested with both versions (an error in strict mode)", () => {
    const home = tmp(); // no Solana CLI config or keypair: doctor asks no RPC
    const untested = run(["doctor"], home, { HOME: home, TYPESOL_SBF_SDK: fakeSdk() });
    expect(untested.status).toBe(0);
    expect(untested.stdout).toMatch(
      / ! {3}toolchain +untested: clang 99\.1\.0 \(example\/llvm-project 01234567\), platform-tools v9\.99; TypeSOL is tested with clang 20\.1\.7-rust-dev \(anza-xyz\/llvm-project 78496716\), platform-tools v1\.52 \(Agave 3\.1\.10\)/,
    );
    expect(untested.stdout).toMatch(/cargo-build-sbf --install-only --force-tools-install --tools-version v1\.52 {3}# the tested platform-tools/);
    const strict = run(["doctor"], home, { HOME: home, TYPESOL_SBF_SDK: fakeSdk(), TYPESOL_TOOLCHAIN: "strict" });
    expect(strict.status).toBe(1);
    expect(strict.stdout).toMatch(/ERR {2}toolchain +untested: .*\(TYPESOL_TOOLCHAIN=strict refuses it\)/);
    if (realIsTested)
      expect(run(["doctor"], home, { HOME: home }).stdout).toMatch(/ok {3}toolchain +tested: clang 20\.1\.7-rust-dev .*, platform-tools v1\.52/);
  });

  it("a build manifest from before the toolchain fields is rebuilt, not reused or misread", () => {
    const dir = tmp();
    expect(run(["init", ".", "--name", "keep"], dir).status).toBe(0);
    const ws = findWorkspace(dir)!;
    expect(buildForTest(ws, "keep").rebuilt).toBe(true);
    expect(buildForTest(ws, "keep").rebuilt).toBe(false);
    const file = path.join(dir, "target/keep/keep.build.json");
    const { host: _host, platformTools: _pt, ...old } = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(old));
    expect(buildForTest(ws, "keep").rebuilt).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).host).toEqual({ os: process.platform, arch: process.arch });
    expect(buildForTest(ws, "keep").rebuilt).toBe(false);
  });

  it("describes and compares two builds' toolchains, and finds an ELF's length under the padding", () => {
    const a = { clang: TESTED_TOOLCHAIN.clang, platformTools: "v1.52", host: { os: "linux", arch: "x64" }, compiler: "0.44.0", typescript: "6.0.3" };
    expect(describeToolchain(a)).toBe(
      "clang 20.1.7-rust-dev (anza-xyz/llvm-project 78496716), platform-tools v1.52, linux-x64, TypeSOL 0.44.0, the tested toolchain",
    );
    expect(describeToolchain({ clang: FAKE_CLANG, compiler: "0.43.0" })).toBe(
      "clang 99.1.0 (example/llvm-project 01234567), platform-tools unknown, host unknown, TypeSOL 0.43.0",
    );
    // Before 0.45.0 programs linked each platform-tools host package's own compiler-builtins: the host is a difference
    // then; builds that link the runtime's builtins (listed in their sources) give the same bytes on every host.
    expect(toolchainDifferences(a, { ...a, host: { os: "darwin", arch: "arm64" } })).toEqual(["host"]);
    const now = { ...a, sources: { "<runtime>/typesol_rt.h": "x", "<runtime>/typesol_builtins.c": "y" } };
    expect(toolchainDifferences(now, { ...now, host: { os: "darwin", arch: "arm64" } })).toEqual([]);
    expect(toolchainDifferences(now, { ...a, host: { os: "darwin", arch: "arm64" } })).toEqual(["host"]);
    expect(toolchainDifferences(a, { ...a, host: undefined })).toEqual([]);
    expect(toolchainDifferences(a, { ...a, clang: FAKE_CLANG, platformTools: "v1.57", compiler: "0.43.0" })).toEqual([
      "TypeSOL version",
      "clang",
      "platform-tools",
    ]);
    expect(toolchainDifferences(a, { ...a, platformTools: undefined })).toEqual([]); // unknown on one side: not a difference
    const elf = readFileSync(
      path.join(
        ROOT,
        "test/programs",
        readdirSync(path.join(ROOT, "test/programs")).find((f) => f.endsWith(".so"))!,
      ),
    );
    expect(elfLength(Buffer.concat([elf, Buffer.alloc(4096)]))).toBe(elfLength(elf));
    expect(elfLength(Buffer.from("not an elf"))).toBe(10);
  });

  it("verify names each side's toolchain on a mismatch, from a manifest whose binary hash is the deployed one's", () => {
    const dir = counter();
    expect(run(["build", "counter.ts", "--quiet"], dir).status).toBe(0);
    // A deployed binary that is not what the source builds to, with the manifest of the build that made it.
    const so = readFileSync(path.join(dir, "target/counter.so"));
    so[0x200] ^= 0xff;
    const deployed = Buffer.concat([so, Buffer.alloc(2048)]); // program accounts are zero-padded
    writeFileSync(path.join(dir, "deployed.so"), deployed);
    const local = JSON.parse(readFileSync(path.join(dir, "target/counter.build.json"), "utf8"));
    const theirs = {
      ...local,
      clang: FAKE_CLANG,
      platformTools: "v9.99",
      host: { os: "linux", arch: "x64" },
      binary: createHash("sha256").update(so).digest("hex"),
    };
    writeFileSync(path.join(dir, "deployed.build.json"), JSON.stringify(theirs));

    const next = run(["verify", "counter.ts", "deployed.so"], dir);
    expect(next.status).toBe(3);
    expect(next.stdout).toMatch(/MISMATCH {2}deployed\.so is not what counter\.ts builds to/);
    expect(next.stdout).toMatch(/\n {2}rebuilt {3}clang .*, TypeSOL \d+\.\d+\.\d+/);
    expect(next.stdout).toContain(
      "  deployed  clang 99.1.0 (example/llvm-project 01234567), platform-tools v9.99, linux-x64, TypeSOL " +
        `${local.compiler} (deployed.build.json, whose binary hash is the deployed one's)`,
    );
    expect(next.stdout).toMatch(/ {2}differs {3}clang(, platform-tools)?(, host)?: another clang can compile the same C to other bytes/);

    // The same manifest given by name, from elsewhere.
    mkdirSync(path.join(dir, "records"));
    writeFileSync(path.join(dir, "records/counter.build.json"), JSON.stringify(theirs));
    rmSync(path.join(dir, "deployed.build.json"));
    expect(run(["verify", "counter.ts", "deployed.so", "--manifest", "records/counter.build.json"], dir).stdout).toContain(
      "(records/counter.build.json, whose binary hash is the deployed one's)",
    );

    // No manifest of the deployed bytes: unknown, and the local build's manifest is named as describing another binary.
    const unknown = run(["verify", "counter.ts", "deployed.so"], dir);
    expect(unknown.status).toBe(3);
    expect(unknown.stdout).toContain(
      "  deployed  toolchain unknown: a deployed program records nothing about what built it; pass --manifest <name>.build.json",
    );
    expect(unknown.stdout).toMatch(new RegExp(`note {6}target/counter\\.build\\.json describes another binary \\(${local.binary.slice(0, 12)}…`));
    expect(run(["verify", "counter.ts", "deployed.so", "--manifest", "nosuch.json"], dir).status).toBe(2);
  });
});
