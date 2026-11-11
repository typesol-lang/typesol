// What the repository says about itself stays true: the figures docs/audit.md and docs/architecture.md quote
// (scripts/audit-stats.ts), the licence notices the npm package ships, and the licence line of every ported file.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditDocs } from "../../scripts/audit-stats.ts";
import { present } from "../binaries.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

describe("repository records", () => {
  it("docs/audit.md and docs/architecture.md quote the code's current line counts", () => {
    const r = spawnSync("node", [path.join(ROOT, "scripts/audit-stats.ts"), "--check"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    // Every component row that names files has a count, and the counts are the files' line counts.
    const docs = auditDocs();
    expect(docs["docs/audit.md"]).toBe(read("docs/audit.md"));
    const runtime = read("runtime/typesol_rt.h").split("\n").length - 1;
    expect(read("docs/audit.md")).toContain(`| \`runtime/typesol_rt.h\` | ${runtime.toLocaleString("en-US")} |`);
    for (const row of read("docs/audit.md").match(/^\| [12] \|.*$/gm) ?? []) expect(row.split(" | ")[3], row).toMatch(/^[\d,]+$/);
    expect(read("docs/audit.md")).not.toMatch(/macOS daily/);
  });

  it("the npm package ships the licence notices, and NOTICE names the ported code it holds", () => {
    const pkg = JSON.parse(read("package.json")) as { files: string[] };
    expect(pkg.files).toEqual(expect.arrayContaining(["LICENSE", "NOTICE", "test/programs/LICENSE-Apache-2.0.txt"]));
    const notice = read("NOTICE");
    for (const s of ["lib-sokoban 0.3.0", "Copyright (c) 2022 Jarry Xiao", "big_vec.rs", "stake_activating_and_deactivating_v2", "showcase/mainnet/"])
      expect(notice).toContain(s);
    expect(notice).not.toMatch(/None of it is part of the published|Examples under examples\//);
    expect(read("runtime/typesol_rt.h")).toMatch(/Ported from lib-sokoban 0\.3\.0[\s\S]*Jarry Xiao/);
  });

  it("every file of a mainnet port says what it ports and under which licence, at the top", () => {
    const files = (dir: string): string[] =>
      readdirSync(path.join(ROOT, dir)).flatMap((n) => (statSync(path.join(ROOT, dir, n)).isDirectory() ? files(`${dir}/${n}`) : [`${dir}/${n}`]));
    const missing = files("showcase/mainnet")
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => !/licensed\s+(?:\/\/\s*)?under|Apache-2\.0|MIT License/.test(read(f).split("\n").slice(0, 3).join("\n")));
    expect(missing).toEqual([]);
  });

  it("present(): a missing binary skips a suite, and fails it where CI_REQUIRE_ALL names its group", () => {
    const program = path.join(ROOT, "test/programs/no_such_program.so");
    const twin = path.join(ROOT, "test/anchor-twins/target/deploy/anchor_no_such.so");
    const saved = process.env.CI_REQUIRE_ALL;
    try {
      delete process.env.CI_REQUIRE_ALL;
      expect(present(program)).toBe(false);
      expect(present(path.join(ROOT, "test/programs/spl_noop.so"))).toBe(true);
      process.env.CI_REQUIRE_ALL = "programs";
      expect(() => present(program)).toThrow(/CI_REQUIRE_ALL=programs: missing .*no_such_program\.so/);
      expect(present(twin)).toBe(false);
      process.env.CI_REQUIRE_ALL = "twins";
      expect(present(program)).toBe(false);
      expect(() => present(twin)).toThrow(/anchor_no_such\.so/);
      process.env.CI_REQUIRE_ALL = "1";
      expect(() => present(program)).toThrow();
    } finally {
      if (saved === undefined) delete process.env.CI_REQUIRE_ALL;
      else process.env.CI_REQUIRE_ALL = saved;
    }
    // Every skip on a missing binary under test/ and showcase/test goes through present(), except in test/language,
    // which this check leaves alone (borsh-layout.test.ts tests for its Anchor twin itself).
    const files = (dir: string): string[] =>
      readdirSync(path.join(ROOT, dir)).flatMap((n) => (statSync(path.join(ROOT, dir, n)).isDirectory() ? files(`${dir}/${n}`) : [`${dir}/${n}`]));
    const direct = [...files("test"), ...files("showcase/test")]
      .filter((f) => f.endsWith(".ts") && !/^test\/(language|security)\//.test(f) && !f.startsWith("test/anchor-twins"))
      .filter((f) => /skipIf\(!existsSync|\.every\(\(f\) => existsSync/.test(read(f)));
    expect(direct).toEqual([]);
  });
});
