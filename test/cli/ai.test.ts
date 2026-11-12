// For AI coding agents: the files `typesol init` writes, llms.txt, `check --json` hints, and the MCP server.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "dist/cli.js");

/** Requests to `typesol mcp`, one per line; its responses, by id. */
function mcp(requests: object[]): Map<unknown, { result?: Record<string, unknown>; error?: { code: number } }> {
  const r = spawnSync("node", [CLI, "mcp"], { input: requests.map((q) => JSON.stringify(q)).join("\n") + "\n", encoding: "utf8" });
  expect(r.status).toBe(0);
  const out = new Map();
  for (const line of r.stdout.split("\n").filter(Boolean)) {
    const m = JSON.parse(line);
    out.set(m.id, m);
  }
  return out;
}
const call = (id: number, name: string, args: object) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const text = (m: { result?: Record<string, unknown> }) => (m.result!.content as { text: string }[])[0]!.text;

const BAD = `import { type Mut, type u64 } from "typesol";\nexport interface C { n: u64 }\nexport function bump(c: Mut<C>): void { c.n += 1; }\n`;
const GOOD = BAD.replace("c.n += 1;", "c.n += 1n;");

describe("for AI coding agents", () => {
  it("init writes the agent rules and the MCP server configuration", () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-ai-")));
    expect(spawnSync("node", [CLI, "init", ".", "--name", "app"], { cwd: dir }).status).toBe(0);
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toMatch(/Integers are bigint[\s\S]*npx --no-install typesol check/);
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(readFileSync(path.join(dir, ".cursor/rules/typesol.mdc"), "utf8")).toMatch(/^---\ndescription: TypeSOL[\s\S]*alwaysApply: true/);
    for (const f of [".mcp.json", ".cursor/mcp.json"])
      expect(JSON.parse(readFileSync(path.join(dir, f), "utf8"))).toEqual({
        mcpServers: { typesol: { command: "npx", args: ["--no-install", "typesol", "mcp"] } },
      });
  });

  it("init lists the agent files it writes, and --no-agent-files leaves them out", () => {
    const agentFiles = ["AGENTS.md", "CLAUDE.md", ".cursor/rules/typesol.mdc", ".mcp.json", ".cursor/mcp.json"];
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-ai-")));
    const withFiles = spawnSync("node", [CLI, "init", "a", "--name", "app"], { cwd: dir, encoding: "utf8" });
    expect(withFiles.status).toBe(0);
    expect(withFiles.stdout).toContain(`  (${agentFiles.join(", ")}: rules and the TypeSOL MCP server for AI coding agents; --no-agent-files leaves them out)`);
    const without = spawnSync("node", [CLI, "init", "b", "--name", "app", "--no-agent-files"], { cwd: dir, encoding: "utf8" });
    expect(without.status).toBe(0);
    for (const f of agentFiles) expect(existsSync(path.join(dir, "b", f)), f).toBe(false);
    expect(existsSync(path.join(dir, "b", ".cursor"))).toBe(false);
    expect(without.stdout).not.toMatch(/AGENTS\.md|CLAUDE\.md|mcp\.json/);
    // The rest of the project is the same: the program, its test, the configs and the editor settings.
    for (const f of ["typesol.json", "programs/app.ts", "tests/app.test.ts", "package.json", "tsconfig.json", ".vscode/settings.json", ".gitignore"])
      expect(readFileSync(path.join(dir, "b", f), "utf8"), f).toBe(readFileSync(path.join(dir, "a", f), "utf8"));
  });

  it("never tells anyone to run `npx typesol <command>`", () => {
    // "typesol" is not the npm package's name (@typesol/cli): where a project's own copy is missing, `npx typesol`
    // would fetch and run whatever package is published under that name.
    const files = [
      "README.md",
      "llms.txt",
      "scripts/llms.ts",
      "src/ai.ts",
      "src/cli.ts",
      "src/templates.ts",
      "src/workspace.ts",
      ".github/workflows/ci.yml",
      ...readdirSync(path.join(ROOT, "docs")).map((f) => `docs/${f}`),
    ];
    for (const f of files) expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/npx typesol (?:[a-z]|--)/);
  });

  it("the shipped docs link only to files that ship; GitHub URLs for the rest", () => {
    // docs/ is read from node_modules and on typesol.com, where showcase/, test/ and examples/ do not exist.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    const shipped = pkg.files.filter((f) => !f.startsWith("!"));
    const bad: string[] = [];
    for (const f of readdirSync(path.join(ROOT, "docs")).filter((x) => x.endsWith(".md")))
      for (const [, target] of readFileSync(path.join(ROOT, "docs", f), "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target!) || target!.startsWith("#")) continue;
        const rel = path.posix.normalize(path.posix.join("docs", target!.split("#")[0]!));
        if (!shipped.includes(rel.split("/")[0]!) || !existsSync(path.join(ROOT, rel))) bad.push(`docs/${f}: ${target}`);
      }
    expect(bad).toEqual([]);
  });

  it("docs/cli.md describes every command", () => {
    const usage = spawnSync("node", [CLI, "--help"], { encoding: "utf8" }).stdout;
    const commands = [...usage.matchAll(/^ {2}typesol (\w[\w-]*)/gm)].map((m) => m[1]!);
    expect(commands).toContain("mcp");
    const doc = readFileSync(path.join(ROOT, "docs/cli.md"), "utf8");
    for (const c of commands) expect(doc, c).toContain(`| \`typesol ${c}`);
  });

  it("ships llms.txt and llms-full.txt, up to date with the docs", () => {
    expect(spawnSync("node", [path.join(ROOT, "scripts/llms.ts"), "--check"], { encoding: "utf8" }).status).toBe(0);
    expect(readFileSync(path.join(ROOT, "llms.txt"), "utf8")).toMatch(/^# TypeSOL\n\n> Write Solana programs in TypeScript/);
    expect(readFileSync(path.join(ROOT, "llms-full.txt"), "utf8")).toMatch(/## Writing TypeSOL[\s\S]*<!-- docs\/language.md -->/);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toEqual(expect.arrayContaining(["llms.txt", "llms-full.txt"]));
  });

  it("check --json gives each fixable error its hint as a field", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-ai-check-"));
    const file = path.join(dir, "p.ts");
    writeFileSync(file, BAD);
    const r = spawnSync("node", [CLI, "check", file, "--json"], { encoding: "utf8" });
    const out = JSON.parse(r.stdout) as { ok: boolean; diagnostics: { line: number; hint?: string }[] };
    expect(out.ok).toBe(false);
    expect(out.diagnostics[0]).toMatchObject({ line: 3, hint: expect.stringMatching(/write 1n/) });
  });

  it("serves check, idl, docs and rules over MCP", () => {
    const res = mcp([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      call(3, "check", { source: BAD }),
      call(4, "check", { source: GOOD }),
      call(5, "idl", { source: GOOD }),
      call(6, "docs", { query: "FixedVec push" }),
      call(7, "rules", {}),
      call(8, "nope", {}),
      { jsonrpc: "2.0", id: 9, method: "resources/list" },
      call(10, "check", {}),
    ]);
    expect(res.get(1)!.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "typesol" } });
    expect(((res.get(2)!.result!.tools as { name: string }[]) ?? []).map((t) => t.name)).toEqual(["check", "idl", "docs", "rules"]);
    expect(JSON.parse(text(res.get(3)!))).toMatchObject({ ok: false, diagnostics: [{ file: "program.ts", line: 3, hint: expect.stringMatching(/1n/) }] });
    expect(JSON.parse(text(res.get(4)!))).toMatchObject({ ok: true, instructions: ["bump"] });
    expect(JSON.parse(text(res.get(5)!))).toMatchObject({ instructions: [{ name: "bump" }] });
    expect(text(res.get(6)!)).toMatch(/FixedVec/);
    expect(text(res.get(7)!)).toMatch(/Integers are bigint/);
    expect(res.get(8)!.error?.code).toBe(-32602);
    expect(res.get(9)!.error?.code).toBe(-32601);
    expect(res.get(10)!.result).toMatchObject({ isError: true });
    expect(existsSync(CLI)).toBe(true);
  });
});
