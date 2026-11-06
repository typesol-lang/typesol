// `typesol mcp`: a Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0), so an AI coding agent
// (Claude Code, Cursor, …) can check a program, read its IDL and search the TypeSOL docs as tools. No dependencies.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_RULES } from "../ai.js";
import { CompileError, COMPILER_VERSION, generate } from "../compiler/index.js";
import { buildIdl } from "../compiler/idl.js";

const DOCS = fileURLToPath(new URL("../../docs", import.meta.url));
const README = fileURLToPath(new URL("../../README.md", import.meta.url));
/** Any address: the IDL's `address` field, when the caller gives none. */
const PLACEHOLDER_ADDRESS = "11111111111111111111111111111111";

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  run(args: Record<string, unknown>): { text: string; isError?: boolean };
}

/** The program to work on: a file path, or source text (written to a temporary file, so imports of "typesol" work). */
function withProgram<T>(args: Record<string, unknown>, fn: (entry: string, files?: Map<string, string>) => T): T {
  if (typeof args.file === "string") {
    const file = path.resolve(args.file);
    if (!existsSync(file)) throw new Error(`no such file: ${file}`);
    return fn(file);
  }
  if (typeof args.source !== "string") throw new Error("give `file` (a path) or `source` (the program's text)");
  const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-mcp-"));
  const entry = path.join(dir, "program.ts");
  writeFileSync(entry, args.source);
  try {
    return fn(entry, new Map([[entry, args.source]]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The docs as sections (a heading and what follows it), for the search tool. */
function sections(): { source: string; heading: string; text: string }[] {
  const out: { source: string; heading: string; text: string }[] = [];
  const files = [
    README,
    ...(existsSync(DOCS)
      ? readdirSync(DOCS)
          .filter((f) => f.endsWith(".md"))
          .map((f) => path.join(DOCS, f))
      : []),
  ];
  for (const f of files) {
    const name = path.basename(f);
    let heading = name;
    let text: string[] = [];
    const flush = () => {
      if (text.join("").trim()) out.push({ source: name, heading, text: text.join("\n").trim() });
      text = [];
    };
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (/^#{1,3} /.test(line)) {
        flush();
        heading = line.replace(/^#+ /, "");
      } else text.push(line);
    }
    flush();
  }
  return out;
}

const TOOLS: Tool[] = [
  {
    name: "check",
    description:
      "Type-check a TypeSOL program and list what the compiler refuses, each with its file, line, column, message and, for the usual mistakes, a hint saying what to write instead. Give `file` (a path) or `source` (the program's text).",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "path to the program's entry .ts file" },
        source: { type: "string", description: "the program's source text" },
      },
    },
    run(args) {
      return withProgram(args, (entry, files) => {
        try {
          const { model } = generate(entry, { files });
          return { text: JSON.stringify({ ok: true, program: model.name, instructions: model.instructions.map((i) => i.name), diagnostics: [] }) };
        } catch (e) {
          if (!(e instanceof CompileError)) throw e;
          // Source given as text is reported as program.ts, not the temporary file it was checked in.
          const diagnostics = files ? e.diagnostics.map((d) => ({ ...d, file: path.basename(d.file) })) : e.diagnostics;
          return { text: JSON.stringify({ ok: false, diagnostics }) };
        }
      });
    },
  },
  {
    name: "idl",
    description: "The Anchor-compatible IDL a TypeSOL program compiles to (instructions, accounts, types, errors, events). Give `file` or `source`.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, source: { type: "string" }, address: { type: "string", description: "the program address to record" } },
    },
    run(args) {
      return withProgram(args, (entry, files) => {
        try {
          const address = typeof args.address === "string" ? args.address : PLACEHOLDER_ADDRESS;
          return { text: JSON.stringify(buildIdl(generate(entry, { files }).model, address), null, 2) };
        } catch (e) {
          if (!(e instanceof CompileError)) throw e;
          return { text: JSON.stringify({ ok: false, diagnostics: e.diagnostics }), isError: true };
        }
      });
    },
  },
  {
    name: "docs",
    description:
      "Search the TypeSOL documentation (the language reference, errors, testing, CLI, porting from Anchor, case studies). Returns the best-matching sections.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    run(args) {
      const words = String(args.query ?? "")
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 1);
      if (!words.length) throw new Error("give a `query`");
      const scored = sections()
        .map((s) => {
          const hay = `${s.heading}\n${s.text}`.toLowerCase();
          const score = words.reduce((n, w) => n + (hay.split(w).length - 1) + (s.heading.toLowerCase().includes(w) ? 5 : 0), 0);
          return { s, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(10, Number(args.limit ?? 4))));
      if (!scored.length) return { text: "No section matches; try other words, or the `rules` tool." };
      return { text: scored.map(({ s }) => `# ${s.heading} (${s.source})\n\n${s.text.slice(0, 4000)}`).join("\n\n---\n\n") };
    },
  },
  {
    name: "rules",
    description:
      "The rules a TypeSOL program follows that ordinary TypeScript habits break (bigint integers, imports, no throw/async/class, Mut<T> for changed accounts, …), and how to check and test.",
    inputSchema: { type: "object", properties: {} },
    run() {
      return { text: AGENT_RULES };
    },
  },
];

type Message = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: Record<string, unknown> };

/** One request's response (undefined for a notification). */
export function handle(msg: Message): object | undefined {
  const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return undefined; // notifications (notifications/initialized, …)
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "typesol", version: COMPILER_VERSION },
        instructions: "TypeSOL compiles a TypeScript subset to Solana programs. Call `rules` first, `check` after every edit, `docs` for the reference.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `unknown tool: ${String(msg.params?.name)}`);
      try {
        const out = tool.run((msg.params?.arguments as Record<string, unknown>) ?? {});
        return reply({ content: [{ type: "text", text: out.text }], isError: !!out.isError });
      } catch (e) {
        return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${String(msg.method)}`);
  }
}

/** Serve on stdin / stdout until stdin closes. Logs go to stderr: stdout carries only protocol messages. */
export function serve(): Promise<void> {
  return new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let out: object | undefined;
        try {
          out = handle(JSON.parse(line) as Message);
        } catch {
          out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
        }
        if (out) process.stdout.write(JSON.stringify(out) + "\n");
      }
    });
    process.stdin.on("end", () => resolve());
  });
}
