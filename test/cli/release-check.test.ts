// scripts/release-check.ts without the network or a build: the version and CHANGELOG checks, reading a packed
// tarball, the record's shape, and the comparison --verify makes (against the committed record of 0.43.0).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { changelogDate, compareFiles, describeTarball, parseRecord, readTar, verifyProblems, versionProblem } from "../../scripts/release-check.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts/release-check.ts");
// What the registry reports for @typesol/cli@0.43.0 (`npm view @typesol/cli@0.43.0 dist`).
const SHASUM_0_43_0 = "10c2883bf3a01fcb16a86c1dbbbb696e1e962b2c";

/** A ustar archive of the given files, written the way npm pack lays them out (under package/). */
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    const full = `package/${name}`;
    // Names past 100 bytes go in the prefix field, as npm's tar does for deep paths.
    const cut = full.length > 100 ? full.lastIndexOf("/", 155) : -1;
    h.write(cut > 0 ? full.slice(cut + 1) : full, 0);
    if (cut > 0) h.write(full.slice(0, cut), 345);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write("00000000000\0", 136);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    h.fill(" ", 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

describe("release check", () => {
  it("checks package.json's version against the tag", () => {
    expect(versionProblem('{"version":"0.44.0"}', "0.44.0")).toBeUndefined();
    expect(versionProblem('{"version":"0.43.0"}', "0.44.0")).toBe('package.json has version "0.43.0", the tag is v0.44.0');
    expect(versionProblem("{", "0.44.0")).toMatch(/not valid JSON/);
  });

  it("finds the version's CHANGELOG section and its date", () => {
    const log = "# Changelog\n\n## Unreleased\n\n## 0.44.0 — 2026-11-20\n\n- x\n\n## 0.4.0 — 2026-01-01\n";
    expect(changelogDate(log, "0.44.0")).toBe("2026-11-20");
    expect(changelogDate(log, "0.4.0")).toBe("2026-01-01");
    // "0.4.0" must not match inside "0.44.0", and a section without a date is not a release.
    expect(() => changelogDate("## 0.44.0 — 2026-11-20\n", "0.4.0")).toThrow(/no "## 0.4.0 — <YYYY-MM-DD>" section/);
    expect(() => changelogDate("## 0.45.0\n", "0.45.0")).toThrow(/section/);
    expect(changelogDate(readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8"), "0.43.0")).toBe("2026-11-11");
  });

  it("reads a packed tarball: the registry's two hashes and each file's sha256", () => {
    const deep = `dist/${"a".repeat(60)}/${"b".repeat(60)}/x.js`;
    const raw = tar({ "package.json": '{"version":"1.0.0"}', [deep]: "export {};\n", "README.md": "# r\n" });
    expect(readTar(raw).map((f) => f.path)).toEqual(["package/package.json", `package/${deep}`, "package/README.md"]);
    const tgz = gzipSync(raw);
    const { tarball, files } = describeTarball(tgz, "x-1.0.0.tgz");
    expect(tarball.size).toBe(tgz.length);
    expect(tarball.shasum).toMatch(/^[0-9a-f]{40}$/);
    expect(tarball.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(files.map((f) => f.path)).toEqual(["README.md", deep, "package.json"]); // sorted, prefix removed
    expect(files[2]).toEqual({ path: "package.json", size: 19, sha256: createHash("sha256").update('{"version":"1.0.0"}').digest("hex") });
    // The same archive compressed differently: other registry hashes, the same tar hash and files.
    const other = describeTarball(gzipSync(raw, { level: 1 }), "x-1.0.0.tgz");
    expect(other.tarball.shasum).not.toBe(tarball.shasum);
    expect(other.tarball.tarSha256).toBe(tarball.tarSha256);
    expect(compareFiles(files, other.files)).toEqual({ same: 3, differ: [], onlyHere: [], onlyPublished: [] });
  });

  it("compares a record with the registry's values and file lists", () => {
    const record = { version: "1.0.0", tarball: { name: "t", size: 1, shasum: "aa", integrity: "sha512-x", tarSha256: "t" } };
    expect(verifyProblems(record, { shasum: "aa", integrity: "sha512-x" })).toEqual([]);
    expect(verifyProblems(record, { shasum: "aa" })).toEqual([]);
    expect(verifyProblems(record, { shasum: "bb", integrity: "sha512-y" })).toEqual([
      "shasum: published bb, recorded aa",
      "integrity: published sha512-y, recorded sha512-x",
    ]);
    expect(verifyProblems(record, {})).toEqual([expect.stringMatching(/nothing to compare/)]);
    const f = (p: string, h: string) => ({ path: p, size: 1, sha256: h });
    expect(compareFiles([f("a", "1"), f("b", "2"), f("c", "3")], [f("a", "1"), f("b", "9"), f("d", "4")])).toEqual({
      same: 1,
      differ: ["b"],
      onlyHere: ["c"],
      onlyPublished: ["d"],
    });
    expect(() => parseRecord('{"version":"1.0.0"}', "1.0.0")).toThrow(/not a release record/);
    expect(() => parseRecord(JSON.stringify({ ...record, files: [] }), "2.0.0")).toThrow(/not a release record for 2.0.0/);
  });

  it("the committed record of 0.43.0 has the release's shape and matches the registry's shasum", () => {
    const record = parseRecord(readFileSync(path.join(ROOT, "releases/0.43.0.json"), "utf8"), "0.43.0");
    expect(record).toMatchObject({ version: "0.43.0", tag: "v0.43.0", released: "2026-11-11", tests: false, tarball: { name: "typesol-cli-0.43.0.tgz" } });
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(record.tools).sort()).toEqual(["node", "npm", "pnpm"]);
    expect(record.files.length).toBe(127);
    for (const file of record.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.files.map((f) => f.path)).toEqual(expect.arrayContaining(["package.json", "dist/cli.js", "runtime/typesol_rt.h", "SECURITY.md"]));
    expect(record.published?.sameTarball).toBe(true);

    const ok = spawnSync("node", [SCRIPT, "0.43.0", "--verify", "--shasum", SHASUM_0_43_0], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`match     @typesol/cli@0.43.0  ${SHASUM_0_43_0}`);
    const bad = spawnSync("node", [SCRIPT, "0.43.0", "--verify", "--shasum", "0".repeat(40)], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain(`shasum: published ${"0".repeat(40)}, recorded ${SHASUM_0_43_0}`);
    const none = spawnSync("node", [SCRIPT, "9.9.9", "--verify", "--shasum", SHASUM_0_43_0], { encoding: "utf8" });
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/releases\/9\.9\.9\.json does not exist/);
    expect(spawnSync("node", [SCRIPT], { encoding: "utf8" }).stderr).toMatch(/usage: node scripts\/release-check\.ts <version>/);
  });
});
