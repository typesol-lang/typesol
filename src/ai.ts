// What an AI coding agent needs to write TypeSOL: the rules `typesol init` puts in AGENTS.md (and CLAUDE.md, Cursor's
// rules), the MCP server configurations it writes, and the llms.txt files built from the docs (scripts/llms.ts).

/** The rules every TypeSOL program follows that a model trained on ordinary TypeScript gets wrong first. */
export const AGENT_RULES = `## Writing TypeSOL

TypeSOL compiles a subset of TypeScript to a Solana program (native SBF) with an Anchor-compatible IDL. Programs live
in \`programs/\`, tests in \`tests/\`; \`typesol.json\` lists the programs.

- Exported functions are instructions; their parameters are the accounts (\`Signer\`, \`Account<T>\`, \`Mut<T>\`,
  \`Init<T>\`, token accounts, programs) and then the arguments. Account data types are exported interfaces.
- Integers are bigint: \`u8\` … \`u128\`, \`i8\` … \`i128\` (write \`1n\`, never \`1\`; take \`u64\`, never \`number\`).
  Arithmetic is checked: an overflow fails the instruction. There is no floating point.
- Import everything from \`"typesol"\`: types, and functions such as \`require\`, \`log\`, \`min\`, \`max\`,
  \`fixedArray\`, \`emit\`, \`invoke\`.
- Fail with \`require(condition, MyError.Name)\` (an exported string enum of messages) or \`require(condition, "message")\`.
  There is no \`throw\`, \`try\`, \`async\`, \`class\`, \`console\` or \`Math\`.
- An account the instruction changes is \`Mut<T>\`; one it creates is \`Init<T>\` (\`acct.create(payer, seeds)\`).
- Lists: \`FixedArray<T, N>\`, \`FixedVec<T, N>\`, \`Vec<T>\`; read with \`.get(i)\` and write with \`.set(i, v)\`
  (\`i\` a bigint), not \`xs[i]\`. \`map\`, \`filter\`, \`find\`, \`some\`, \`reduce\` work on them.
- Strings are \`FixedString<N>\` in account data; \`Option<T>\` (\`T | null\`) for optional values.

## Checking your work

- \`npx --no-install typesol check\` (or \`--json\`) type-checks every program and lists what TypeSOL refuses, each error with a
  \`hint\` that says what to write instead. Fix those first; they are faster than a build.
- \`npm test\` builds the programs and runs \`tests/\` in LiteSVM (an in-process Solana runtime). \`npx --no-install typesol build\`
  writes \`target/<name>/\`: the \`.so\`, the IDL and a typed client.
- The MCP server (\`npx --no-install typesol mcp\`, configured in \`.mcp.json\` and \`.cursor/mcp.json\`) gives the same check,
  the IDL and the docs as tools.
- The language reference: \`node_modules/typesol/docs/language.md\` (after \`npm install\`), or https://typesol.com/llms-full.txt.
`;

/** AGENTS.md for a new project (Codex, Cursor, Zed, and other agents that read it). */
export function agentsMd(name: string): string {
  return `# ${name}\n\nA Solana program written in TypeSOL (https://typesol.com).\n\n${AGENT_RULES}`;
}

/** Claude Code reads CLAUDE.md, which imports AGENTS.md so the rules are kept in one place. */
export const CLAUDE_MD = "@AGENTS.md\n";

/** Cursor's project rules, always applied to the program and test files. */
export function cursorRule(): string {
  return `---\ndescription: TypeSOL, a TypeScript subset compiled to Solana programs\nglobs: programs/**/*.ts, tests/**/*.ts\nalwaysApply: true\n---\n\n${AGENT_RULES}`;
}

/** The MCP server configuration Claude Code (.mcp.json) and Cursor (.cursor/mcp.json) read. */
export const MCP_JSON = JSON.stringify({ mcpServers: { typesol: { command: "npx", args: ["--no-install", "typesol", "mcp"] } } }, null, 2) + "\n";
