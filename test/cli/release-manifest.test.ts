// scripts/release-manifest.ts --check, the cross-host check CI runs: a reference of counter made here, then changed
// to stand for each outcome (the same bytes, STALE C or IDL, DIFFERS, a pre-0.45.0 host difference), and the
// references it refuses (nothing to compare, an entry that did not build, made from uncommitted changes).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts/release-manifest.ts");
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-manifest-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const manifest = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });

type Reference = {
  toolchain: { host?: string; builtins?: string };
  sources: { dirty?: boolean };
  programs: Record<string, { so: string; idl: string; c: string; bytes: number } | { error: string }>;
};
let reference: Reference;
const check = (change: (r: Reference) => void) => {
  const r = JSON.parse(JSON.stringify(reference)) as Reference;
  change(r);
  const file = path.join(dir, "ref.json");
  writeFileSync(file, JSON.stringify(r));
  return manifest("--check", file);
};

beforeAll(() => {
  const out = path.join(dir, "made.json");
  const r = manifest("--programs", "examples/counter.ts,examples/counter.ts:v2", "--out", out);
  expect(r.status, r.stderr).toBe(0);
  reference = JSON.parse(readFileSync(out, "utf8")) as Reference;
  // This checkout may have uncommitted changes while the tests run: the outcomes below are not about that.
  delete reference.sources.dirty;
}, 120_000);

describe("release-manifest --check", () => {
  it("lists a program built for another SBPF version as <path>:<version>", () => {
    expect(Object.keys(reference.programs)).toEqual(["examples/counter.ts", "examples/counter.ts:v2"]);
    const [v0, v2] = Object.values(reference.programs) as { so: string }[];
    expect(v0!.so).not.toBe(v2!.so);
  });

  it("passes on the same bytes, and fails on other C or IDL (STALE) or another binary (DIFFERS)", () => {
    const same = check(() => {});
    expect(same.status).toBe(0);
    expect(same.stdout).toMatch(/ {2}same {6}examples\/counter\.ts \(\d+ bytes\)\n {2}same {6}examples\/counter\.ts:v2 /);
    expect(same.stdout).toContain("no difference: every program builds to the reference's bytes");
    const stale = check((r) => ((r.programs["examples/counter.ts:v2"] as { c: string }).c = "0".repeat(64)));
    expect(stale.status).toBe(1);
    expect(stale.stdout).toMatch(/STALE {5}examples\/counter\.ts:v2: the C differ from the reference/);
    const differs = check((r) => ((r.programs["examples/counter.ts"] as { so: string }).so = "0".repeat(64)));
    expect(differs.status).toBe(1);
    expect(differs.stdout).toMatch(/DIFFERS {3}examples\/counter\.ts: the same C and IDL build to another binary here/);
    // A reference from another host that links the runtime's builtins (0.45.0 on) binds on whichever host runs the check.
    const elsewhere = check((r) => {
      r.toolchain.host = "freebsd-riscv64";
      (r.programs["examples/counter.ts"] as { so: string }).so = "0".repeat(64);
    });
    expect(elsewhere.status).toBe(1);
    expect(elsewhere.stdout).toContain("DIFFERS");
  });

  it("only notes another binary on another host for a reference from before 0.45.0", () => {
    const old = check((r) => {
      r.toolchain.host = "freebsd-riscv64";
      delete r.toolchain.builtins;
      (r.programs["examples/counter.ts"] as { so: string }).so = "0".repeat(64);
    });
    expect(old.status).toBe(0);
    expect(old.stdout).toMatch(/ {2}host {6}examples\/counter\.ts: another binary on \S+ with the same C and IDL/);
    expect(old.stdout).toContain("no difference, apart from 1 binary(ies) on a host other than the reference's (freebsd-riscv64)");
  });

  it("refuses a reference that compares nothing, has an entry that did not build, or was made from uncommitted changes", () => {
    const empty = check((r) => (r.programs = {}));
    expect(empty.status).toBe(1);
    expect(empty.stdout).toContain("the reference lists no program, so it checks nothing");
    const broken = check((r) => (r.programs["examples/lib.ts"] = { error: "not a program" }));
    expect(broken.status).toBe(1);
    expect(broken.stdout).toContain("1 entry(ies) did not build when the reference was made (examples/lib.ts): regenerate it");
    const dirty = check((r) => (r.sources.dirty = true));
    expect(dirty.status).toBe(1);
    expect(dirty.stdout).toContain("made from a tree with uncommitted changes (sources.dirty)");
  });
});

describe("release-manifest: the test corpus and the reference inventory of a release", () => {
  // A small source tree: one program, a test under test/ and one under showcase/test/, and one listed reference.
  const tree = path.join(dir, "tree");
  const write = (rel: string, text: string | Buffer) => {
    mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    writeFileSync(path.join(tree, rel), text);
  };
  type Release = { references: Record<string, string>; referencesMissing?: string[]; corpus: { roots: string[]; files: number; sha256: string } };
  const release = (...extra: string[]) => {
    const out = path.join(dir, "release.json");
    rmSync(out, { force: true });
    const r = manifest("--sources", tree, "--out", out, ...extra);
    return { r, m: r.status === 0 ? (JSON.parse(readFileSync(out, "utf8")) as Release) : undefined };
  };

  it("hashes test/ and showcase/test/, and refuses a tree that lacks a reference SOURCES.md lists", () => {
    mkdirSync(path.join(tree, "examples"), { recursive: true });
    copyFileSync(path.join(ROOT, "examples/counter.ts"), path.join(tree, "examples/counter.ts"));
    write("test/a.test.ts", "// a\n");
    write("showcase/test/b.test.ts", "// b\n");
    write("test/programs/SOURCES.md", "| File |\n| --- |\n| `x.so` | x |\n");
    write("test/programs/x.so", Buffer.from([1, 2, 3]));
    const first = release();
    expect(first.r.status, first.r.stderr).toBe(0);
    expect(first.m!.corpus).toMatchObject({ roots: ["test", "showcase/test"], files: 3 });
    expect(Object.keys(first.m!.references)).toEqual(["test/programs/x.so"]);
    // An assertion changed in a showcase test changes the corpus hash.
    write("showcase/test/b.test.ts", "// b, changed\n");
    const second = release();
    expect(second.m!.corpus.files).toBe(3);
    expect(second.m!.corpus.sha256).not.toBe(first.m!.corpus.sha256);
    // A listed reference missing: refused, or recorded as missing when asked.
    rmSync(path.join(tree, "test/programs/x.so"));
    const refused = release();
    expect(refused.r.status).toBe(1);
    expect(refused.r.stderr).toContain("test/programs/SOURCES.md lists binaries this tree lacks: test/programs/x.so");
    const allowed = release("--allow-missing-references");
    expect(allowed.r.status, allowed.r.stderr).toBe(0);
    expect(allowed.m!.referencesMissing).toEqual(["test/programs/x.so"]);
  }, 180_000);
});
