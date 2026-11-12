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
    for (const ok of ["22.12.0", "22.18.1", "23.0.0", "24.22.3", "25.9.0"]) expect(nodeVersionProblem(ok), ok).toBeUndefined();
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
});
