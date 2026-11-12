// llms.txt and llms-full.txt (https://llmstxt.org): what an AI model needs to write TypeSOL, built from the docs.
//   node scripts/llms.ts          write them
//   node scripts/llms.ts --check  fail when they are out of date (the tests run this)
// llms.txt is the index (links to typesol.com/docs); llms-full.txt is the rules and the reference in one text file.
// Both ship in the npm package and are served at typesol.com/llms.txt and /llms-full.txt.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_RULES } from "../src/ai.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://typesol.com/docs";

/** The docs an agent reads, in order: [file, slug on typesol.com, what it holds]. */
const DOCS: [string, string, string][] = [
  ["docs/language.md", "language", "the language guide: an overview, its pages and where each construct is described"],
  ["docs/language-basics.md", "language-basics", "what a program is: instructions, account data, helpers, constants, files"],
  ["docs/language-types.md", "language-types", "integers, strings, enums, structs, options and lists, with their bytes and limits"],
  ["docs/language-statements.md", "language-statements", "which TypeScript is TypeSOL, functions and closures, and what is refused"],
  ["docs/language-accounts.md", "language-accounts", "account parameters, the checks they emit, constraints and account layouts"],
  ["docs/language-pdas.md", "language-pdas", "seeds, bumps, signing as a PDA, PDAs in the IDL"],
  ["docs/language-errors-events.md", "language-errors-events", "require, error codes, logs, events and return values"],
  ["docs/language-cpi.md", "language-cpi", "calling other programs: System, tokens, Metaplex, Stake, invoke, transfer hooks"],
  ["docs/language-chain.md", "language-chain", "sysvars, hashes, signatures, introspection, oracles and randomness"],
  ["docs/language-native.md", "language-native", "advanced: porting native programs (raw views, Borsh accounts, panics)"],
  ["docs/language-builtins.md", "language-builtins", "every name typesol exports, one line each"],
  ["docs/glossary.md", "glossary", "the Solana and TypeSOL terms the guide uses, one paragraph each"],
  ["docs/errors.md", "errors", "the error codes a program fails with"],
  ["docs/test-your-program.md", "test-your-program", "tests with typesol/testing in LiteSVM"],
  ["docs/cli.md", "cli", "the typesol commands"],
  ["docs/client.md", "client", "the typed client every build writes"],
  ["docs/migrate-from-anchor.md", "migrate-from-anchor", "each Anchor construct and its TypeSOL form"],
  ["docs/troubleshooting.md", "troubleshooting", "common problems"],
  ["docs/mainnet.md", "mainnet", "deploying, verifying and publishing the IDL"],
  ["docs/security-model.md", "security-model", "what a compiled program checks for you and what is left to you"],
  ["docs/ai.md", "ai", "the agent rules, check --json hints and the MCP server"],
  ["docs/stability.md", "stability", "what is stable, what is experimental, the road to 1.0"],
];

function quickStart(): string {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
  const start = readme.indexOf("## Quick start");
  const end = readme.indexOf("\n## ", start + 5);
  return readme.slice(start, end).trim();
}

export function llms(): { index: string; full: string } {
  const index = [
    "# TypeSOL",
    "",
    "> Write Solana programs in TypeScript. TypeSOL compiles a TypeScript subset to native SBF (no interpreter, no",
    "> generated Rust) and writes an Anchor-compatible IDL and a typed client for every program. npm: @typesol/cli.",
    "",
    'Integers are bigint (1n, u64), everything is imported from "typesol", and there is no throw, async, class or float.',
    `The rules and the whole reference in one file: https://typesol.com/llms-full.txt`,
    "",
    "## Docs",
    "",
    ...DOCS.map(([, slug, what]) => `- [${slug}](${SITE}/${slug}/): ${what}`),
    "",
    "## Tools",
    "",
    "- `npx @typesol/cli init my-app`: a project with a program, a LiteSVM test, AGENTS.md / CLAUDE.md and the MCP server configured",
    "- `npx --no-install typesol check --json`: errors with hints; `npx --no-install typesol mcp`: check, IDL and docs as MCP tools",
    "",
    "## Optional",
    "",
    `- [Case studies](${SITE}/case-study-marginfi/): mainnet programs (Marginfi v2, Phoenix v1, SPL Stake Pool, Raydium AMM v4, CLMM, CP-Swap, Jito) ported and checked against their binaries`,
    "",
  ].join("\n");
  const full = [
    "# TypeSOL: the rules and the reference",
    "",
    AGENT_RULES.trim(),
    "",
    quickStart(),
    "",
    ...DOCS.flatMap(([file]) => [`<!-- ${file} -->`, "", readFileSync(path.join(ROOT, file), "utf8").trim(), ""]),
  ].join("\n");
  return { index, full };
}

const { index, full } = llms();
const targets: [string, string][] = [
  ["llms.txt", index],
  ["llms-full.txt", full],
];
if (process.argv.includes("--check")) {
  const stale = targets.filter(([f, text]) => {
    try {
      return readFileSync(path.join(ROOT, f), "utf8") !== text;
    } catch {
      return true;
    }
  });
  if (stale.length) {
    console.error(`out of date: ${stale.map(([f]) => f).join(", ")}; run node scripts/llms.ts`);
    process.exit(1);
  }
} else for (const [f, text] of targets) writeFileSync(path.join(ROOT, f), text);
