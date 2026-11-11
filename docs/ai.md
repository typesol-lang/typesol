# Writing TypeSOL with an AI agent

TypeSOL is TypeScript, which AI coding agents write well, but a subset of it: a model's ordinary habits (`1` for an
integer, `console.log`, `throw`, `xs[i]`) are refused. Four things close that gap.

## The rules in the project

`typesol init` writes the rules an agent needs into the project:

| File | Read by |
| --- | --- |
| `AGENTS.md` | Codex, Cursor, Zed, Aider and other agents that read AGENTS.md |
| `CLAUDE.md` (`@AGENTS.md`) | Claude Code |
| `.cursor/rules/typesol.mdc` | Cursor (always applied to `programs/` and `tests/`) |

They say what ordinary TypeScript habits break (bigint integers, imports from `"typesol"`, no `throw` / `async` /
`class`, `Mut<T>` for an account that changes, `.get(i)` / `.set(i, v)` on lists) and how to check and test. Keep your
own project notes below them in AGENTS.md.

## llms.txt

[typesol.com/llms.txt](https://typesol.com/llms.txt) is the index of the docs for models
([llmstxt.org](https://llmstxt.org)); [llms-full.txt](https://typesol.com/llms-full.txt) is the rules, the quick start
and the reference (language, errors, tests, CLI, client, porting from Anchor, troubleshooting, mainnet, security model)
in one file, to paste into a chat or give to a model as context. Both also ship in the npm package
(`node_modules/typesol/llms-full.txt` in a project `typesol init` created, which installs `@typesol/cli` under the
name `typesol`; `node_modules/@typesol/cli/llms-full.txt` where it is installed under its own name).

## Errors an agent can fix by itself

`typesol check --json` prints `{ "ok": false, "diagnostics": [...] }`; each diagnostic has `file`, `line`, `column`,
`length`, `message` and, for the usual mistakes, `hint`: what to write instead ("integers (u64, u32, i64 …) are bigint
in TypeSOL: write 1n, not 1, and take u64, not number"). An agent can loop on check → edit → check without building.

## The MCP server

`typesol mcp` serves the [Model Context Protocol](https://modelcontextprotocol.io) on stdio. `typesol init` writes
`.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor) that start it with `npx --no-install typesol mcp`: the
project's own copy, after `npm install`. `--no-install` matters: `typesol` is not the npm package's name, and without
it npx would fetch whatever package is published as `typesol` when the project's copy is missing. Other clients take
the same command, run in the project directory:

```json
{ "mcpServers": { "typesol": { "command": "npx", "args": ["--no-install", "typesol", "mcp"] } } }
```

Outside a project, start it from the published package by its full name: `npx -y @typesol/cli mcp`.

| Tool | What it does |
| --- | --- |
| `check` | type-checks a program (`file`, or `source` text) and returns the diagnostics with their hints |
| `idl` | the Anchor-compatible IDL the program compiles to |
| `docs` | searches the docs and returns the best-matching sections |
| `rules` | the rules above |

Building and testing stay in the shell (`npm test`, `npx --no-install typesol build`): they need the platform-tools and write
files, which an agent should do in the open.
