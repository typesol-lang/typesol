// The Node.js version check of the `typesol` command: on an older Node the CLI says what it needs, in one line, before
// anything that could fail without saying why is loaded.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIN_NODE, nodeVersionProblem } from "../../src/node-version.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("the Node.js version, checked before anything else loads", () => {
  it("names the version needed and the one running, in one line", () => {
    expect(nodeVersionProblem("20.19.5")).toBe(
      "error: TypeSOL needs Node.js 22.12 or later, and this is Node.js 20.19.5. Install a newer one from https://nodejs.org (or `nvm install 22` with nvm), then run the command again.",
    );
    expect(nodeVersionProblem("22.11.0")).toMatch(/needs Node\.js 22\.12 or later, and this is Node\.js 22\.11\.0\./);
    for (const ok of ["22.12.0", "22.18.1", "23.0.0", "24.22.3", "25.9.0", "22.12.0-nightly20251101abcdef", "23.0.0-pre"])
      expect(nodeVersionProblem(ok), ok).toBeUndefined();
    for (const old of ["22.11.9-rc.1", "22.11.0", "20.20.2", "18.20.8", "18.x", "22.x", "0.0.0"])
      expect(nodeVersionProblem(old), old).toMatch(new RegExp(`^error: TypeSOL needs Node\\.js 22\\.12 or later, and this is Node\\.js ${old.replace(/\./g, "\\.")}\\.`));
    expect(MIN_NODE.join(".")).toBe(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).engines.node.replace(/^>=/, ""));
  });

  it("the typesol command is the checking entry point, which then runs the CLI", async () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.bin).toEqual({ typesol: "dist/bin.js" });
    // The entry imports nothing but the check before it passes: an older Node gets the line above, not a crash.
    expect(readFileSync(path.join(ROOT, "src/bin.ts"), "utf8").match(/^import .*$/gm)).toEqual(['import { nodeVersionProblem } from "./node-version.js";']);
    expect(readFileSync(path.join(ROOT, "src/node-version.ts"), "utf8")).not.toMatch(/^import /m);
    const r = await new Promise<{ status: number; stdout: string }>((resolve) =>
      execFile("node", [path.join(ROOT, "dist/bin.js"), "--version"], (err, stdout) => resolve({ status: err ? 1 : 0, stdout })),
    );
    expect(r).toEqual({ status: 0, stdout: `${pkg.version}\n` });
  });

  it("refuses an older Node: bin.js run with process.versions.node set to one exits 1, the line on stderr, before the CLI loads", async () => {
    // bin.ts calls the check with process.versions.node, before it imports the CLI.
    const bin = readFileSync(path.join(ROOT, "src/bin.ts"), "utf8");
    expect(bin).toContain("nodeVersionProblem(process.versions.node)");
    expect(bin.indexOf("nodeVersionProblem(process.versions.node)")).toBeLessThan(bin.indexOf('await import("./cli.js")'));
    for (const [version, refused] of [
      ["20.20.2", true],
      ["22.11.9-rc.1", true],
      ["18.20.8", true],
      ["22.12.0", false],
    ] as const) {
      // The version this process reports, replaced before bin.js runs (the test's doing, not an option of the CLI).
      const fake = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"${version}"})`;
      const r = await new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
        execFile("node", ["--import", fake, path.join(ROOT, "dist/bin.js"), "--version"], (err, stdout, stderr) =>
          resolve({ status: err ? Number((err as { code?: number }).code) : 0, stdout, stderr }),
        ),
      );
      if (refused) expect(r, version).toEqual({ status: 1, stdout: "", stderr: `${nodeVersionProblem(version)}\n` });
      else expect(r.status, version).toBe(0);
    }
  });
});
