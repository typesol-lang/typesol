#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { createHash } from "node:crypto";
import {
  build,
  CompileError,
  COMPILER_VERSION,
  describeToolchain,
  elfLength,
  generate,
  SBPF_VERSIONS,
  toolchainDifferences,
  verifyBinary,
  type BuildManifest,
  type BuildResult,
  type Diagnostic,
  type Sbpf,
} from "./compiler/index.js";
import { setToolchainStrict, shortClang } from "./compiler/toolchain.js";
import { generateCpi, type Idl } from "./tools/cpigen.js";
import { generatePort, type PortIdl } from "./tools/portgen.js";
import { generateClient, writeClient, type ClientIdl } from "./tools/clientgen.js";
import { buildIdl } from "./compiler/idl.js";
import { base58, decodeAddress, loadOrCreateKeypair, readKeypair } from "./keys.js";
import { formatProfile, profileLogs } from "./tools/profile.js";
import { TEMPLATE_NAMES, type TemplateName } from "./templates.js";
import {
  addProgram,
  buildWorkspace,
  CONFIG,
  deployArgs,
  findWorkspace,
  programAddress,
  programForEntry,
  programPaths,
  scaffold,
  withBuildLock,
  type Workspace,
} from "./workspace.js";
import { chooseTypesolVersion, containerBuild, ensureImage, findReleaseRecord, needDocker, sourceRevision, type BuildImage } from "./tools/docker.js";
import {
  cliRpc,
  clusterUrl,
  deployPreflight,
  doctorChecks,
  formatChecks,
  INSTALL_AGAVE,
  rpcHost,
  solanaConfig as readSolanaConfig,
  toolchainCheck,
} from "./tools/doctor.js";

const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));

/** A usage problem: printed with the command's help, exit code 2. */
class UsageError extends Error {}

/** Where "SOL" starts in the banner art: "Type" is drawn in TypeScript blue, "SOL" in the Solana gradient. */
const BANNER_SOL_COLUMN = 36;

function banner(): string {
  const unicode = /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "UTF-8");
  let art = readFileSync(path.join(ASSETS, unicode ? "logo-blocks.txt" : "logo-ascii.txt"), "utf8");
  if (!process.env.NO_COLOR && process.env.TERM !== "dumb") {
    const width = Math.max(...art.split("\n").map((l) => l.length));
    const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
    const sol = (x: number) => {
      const t = Math.min(1, Math.max(0, (x - BANNER_SOL_COLUMN) / Math.max(1, width - BANNER_SOL_COLUMN)));
      return rgb(Math.round(0x99 + (0x14 - 0x99) * t), Math.round(0x45 + (0xf1 - 0x45) * t), Math.round(0xff + (0x95 - 0xff) * t));
    };
    art = art
      .split("\n")
      .map(
        (line) =>
          [...line].map((ch, x) => (ch === " " ? ch : (x < BANNER_SOL_COLUMN ? rgb(0x31, 0x78, 0xc6) : sol(x)) + ch)).join("") + (line ? "\x1b[0m" : ""),
      )
      .join("\n");
  }
  return `\n${art}\n  TypeScript in, SBF out.  v${COMPILER_VERSION}\n`;
}

const SBPF = `--sbpf v0|v1|v2      SBPF version (default v0, or "sbpf" in ${CONFIG}); v1/v2 need clusters that enabled them`;
const TOOLCHAIN_STRICT =
  "--toolchain-strict   refuse to build with platform-tools other than the tested ones (default: one warning); also TYPESOL_TOOLCHAIN=strict";
const DOCKER_HELP = [
  "--docker             build in the pinned container (docker/Dockerfile: linux/amd64, Agave 3.1.10 platform-tools v1.52,",
  "                     the TypeSOL tarball checked against releases/<version>.json); the image is built locally the first time",
  "--typesol-version <v>  the TypeSOL version inside the container (default: this one; for verify, the deployed build's manifest's)",
  "--release-record <file>  the releases/<v>.json to check that version's tarball against (default: this package's, else the repository's)",
].join("\n  ");
const DOCKER_OPTIONS = { docker: { type: "boolean" }, "typesol-version": { type: "string" }, "release-record": { type: "string" } } as const;

interface Command {
  usage: string;
  help: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  run(values: Record<string, string | boolean | undefined>, positionals: string[]): Promise<number> | number;
}

const COMMANDS: Record<string, Command> = {
  new: {
    usage: "typesol new <program> [--template counter|vault|escrow]",
    help: [
      "Add a program to this project: programs/<program>.ts, tests/<program>.test.ts and its entry in typesol.json.",
      "Refuses to overwrite files. <program> must be snake_case. Templates as for `typesol init`.",
    ].join("\n  "),
    options: { template: { type: "string" } },
    run(v, args) {
      const name = one(args, "<program>");
      if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new UsageError(`"${name}" must be snake_case (a-z, 0-9, _; starting with a letter)`);
      const template = (v.template as string | undefined) ?? "counter";
      if (!(TEMPLATE_NAMES as readonly string[]).includes(template))
        throw new UsageError(`--template "${template}" is not one of ${TEMPLATE_NAMES.join(", ")}`);
      const ws = needWorkspace("new");
      const { files, missing } = addProgram(ws, name, template as TemplateName);
      for (const f of files) log(`  ${f === CONFIG ? "updated" : "created"} ${path.relative(process.cwd(), path.join(ws.root, f)) || f}`);
      if (missing.length) log(`\n  The ${template} test also needs: npm install -D ${missing.join(" ")}`);
      return 0;
    },
  },
  init: {
    usage: "typesol init [<dir>] [--name <program>] [--template counter|vault|escrow]",
    help: [
      "Create a project: typesol.json, programs/<name>.ts, tests/<name>.test.ts (LiteSVM), package.json, tsconfig.json, .gitignore, .vscode/settings.json (editor errors), AGENTS.md / CLAUDE.md / .cursor/rules (the rules for AI coding agents) and .mcp.json / .cursor/mcp.json (the TypeSOL MCP server).",
      "Refuses to overwrite files. <name> must be snake_case (default: derived from <dir>).",
      "--template counter   a PDA counter per user (default)",
      "--template vault     a SOL vault at a PDA: deposit, withdraw above rent, close",
      "--template escrow    an SPL token escrow: make, take, refund, with the offer PDA signing for its vault",
    ].join("\n  "),
    options: { name: { type: "string" }, template: { type: "string" } },
    run(v, args) {
      if (args.length > 1) throw new UsageError("init takes at most one directory");
      if (v.name !== undefined && !/^[a-z][a-z0-9_]*$/.test(v.name as string))
        throw new UsageError(`--name "${v.name}" must be snake_case (a-z, 0-9, _; starting with a letter)`);
      const template = (v.template as string | undefined) ?? "counter";
      if (!(TEMPLATE_NAMES as readonly string[]).includes(template))
        throw new UsageError(`--template "${template}" is not one of ${TEMPLATE_NAMES.join(", ")}`);
      const root = path.resolve(args[0] ?? ".");
      const derived = path
        .basename(root)
        .replace(/[^a-z0-9]+/gi, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
      const name = (v.name as string | undefined) ?? (/^[a-z]/.test(derived) ? derived : `p_${derived || "program"}`);
      const rel = path.relative(process.cwd(), root) || ".";
      for (const f of scaffold(root, name, template as TemplateName)) log(`  created ${path.join(rel, f)}`);
      const tools = toolchainCheck();
      if (!tools.ok)
        log(
          `\n  ! The Solana platform-tools are not installed yet; npm test compiles with them. Install once:\n` +
            (tools.fix ?? []).map((f) => `      ${f}`).join("\n"),
        );
      log(
        `\n  next:\n` +
          (rel === "." ? "" : `    cd ${shellQuote(rel)}\n`) +
          `    npm install\n` +
          `    npm test             # builds ${name} and runs its test in LiteSVM, a Solana runtime in-process\n` +
          `    npx --no-install typesol doctor   # checks the toolchain, keypair and RPC before a deploy` +
          (template === "counter" ? `\n\n  other starters: typesol init <dir> --template vault (SOL at a PDA) or --template escrow (SPL token escrow)` : ""),
      );
      return 0;
    },
  },
  build: {
    usage:
      "typesol build [<program>…] [--sbpf v0|v1|v2] [--profile] [--toolchain-strict] [--docker [--typesol-version <v>] [--release-record <file>]]\n  typesol build <program.ts> [--out <dir>] [--program-id <keypair.json>] [--sbpf …] [--profile] [--toolchain-strict] [--docker …]",
    help: [
      `In a project (${CONFIG}): build every program, or the ones named, into <out>/<name>/ (.so, IDL .json, .client.ts, .c, .build.json).`,
      "Outside a project, or with a .ts file: build that file (its keypair is created next to the output if needed).",
      SBPF,
      "--profile            log a marker and the remaining compute units before every statement (for `typesol profile`; not for release)",
      TOOLCHAIN_STRICT,
      DOCKER_HELP,
      "--quiet              no banner",
    ].join("\n  "),
    options: {
      sbpf: { type: "string" },
      profile: { type: "boolean" },
      out: { type: "string" },
      "program-id": { type: "string" },
      quiet: { type: "boolean" },
      "toolchain-strict": { type: "boolean" },
      ...DOCKER_OPTIONS,
    },
    async run(v, args) {
      if (v["toolchain-strict"]) setToolchainStrict();
      const sbpf = sbpfOf(v);
      const profile = !!v.profile;
      const ws = findWorkspace(process.cwd());
      const file = args.length === 1 && args[0].endsWith(".ts") ? args[0] : undefined;
      // A .ts that is one of the project's programs builds as that program (same keypair, output and settings).
      const inProject = ws && (file ? programForEntry(ws, file) : undefined);
      dockerOptions(v);
      if (ws && (!file || inProject)) {
        if (v.out || v["program-id"])
          throw new UsageError(`--out and --program-id do not apply to programs of ${CONFIG} (use "out" there; keypairs live in <out>/deploy/)`);
        if (!v.quiet && process.stdout.isTTY) log(banner());
        if (v.docker) {
          const image = await buildImage(v, ws.root);
          const progs = (inProject ? [inProject] : names(ws, args)).map((name) => programPaths(ws, name));
          // The same locks as a local build: another process building one of these programs would write the same files.
          const { jobs, built } = withBuildLocks(
            progs.map((p) => p.outDir),
            () => {
              const jobs = progs.map((paths) => ({ paths, ...programAddress(ws, paths.name) }));
              const built = containerBuild(
                image,
                ws.root,
                jobs.map((j) => ({ entry: j.paths.entry, outDir: j.paths.outDir, address: j.address, sbpf: sbpf ?? ws.sbpf, profile })),
              );
              return { jobs, built };
            },
          );
          built.forEach((r, i) => {
            const j = jobs[i]!;
            log(
              `  ${j.paths.name.padEnd(12)} ${j.address}${j.created ? " (new keypair)" : j.keyless ? " (no keypair here: deploying needs it)" : ""}  ${path.relative(process.cwd(), r.soPath)}`,
            );
          });
          log(containerLine(image));
          return 0;
        }
        for (const b of buildWorkspace(ws, inProject ? [inProject] : names(ws, args), { sbpf, profile }))
          log(
            `  ${b.paths.name.padEnd(12)} ${b.address}${b.created ? " (new keypair)" : b.keyless ? " (no keypair here: deploying needs it)" : ""}  ${path.relative(process.cwd(), b.result.soPath)}`,
          );
        return 0;
      }
      if (!file)
        throw new UsageError(
          args.length
            ? `"${args.join(" ")}" is not a .ts file, and there is no ${CONFIG} here`
            : `nothing to build: give a .ts file, or run inside a project (${CONFIG})`,
        );
      mustExist(file);
      if (!v.quiet && process.stdout.isTTY) log(banner());
      const outDir = (v.out as string | undefined) ?? path.join(path.dirname(file), "target");
      // The program is named after its entry file. With --docker the container's TypeSOL compiles it, not this one.
      const name = v.docker ? path.basename(file).replace(/\.ts$/, "") : generate(file).model.name;
      const given = v["program-id"] as string | undefined;
      // A keypair given by name must be there: creating one in its place would give the program a new address.
      if (given !== undefined && !existsSync(given))
        throw new UsageError(`--program-id ${given} does not exist (leave --program-id out to create a keypair next to the output)`);
      const keyFile = given ?? path.join(outDir, `${name}-keypair.json`);
      const image = v.docker ? await buildImage(v, ws?.root) : undefined;
      mkdirSync(path.dirname(keyFile), { recursive: true });
      const { address, created } = loadOrCreateKeypair(keyFile);
      let res: Pick<BuildResult, "soPath" | "idlPath" | "manifestPath">;
      if (image) {
        // The container sees the entry's directory: the program and the files it imports from there.
        const [r] = containerBuild(image, path.dirname(path.resolve(file)), [{ entry: file, outDir, address, sbpf: sbpf ?? "v0", profile }]);
        res = { soPath: r!.soPath, idlPath: path.join(outDir, `${name}.json`), manifestPath: r!.manifestPath };
      } else {
        const local = build(file, outDir, address, { sbpf: sbpf ?? "v0", profile });
        writeClient(local.idl, path.join(outDir, `${name}.client.ts`));
        res = local;
      }
      log(`  program   ${name}`);
      log(`  address   ${address}${created ? "  (new keypair: keep it, it is the program's address)" : ""}`);
      log(`  binary    ${res.soPath}`);
      log(`  idl       ${res.idlPath}`);
      log(`  client    ${path.join(outDir, `${name}.client.ts`)}`);
      log(`  manifest  ${res.manifestPath}`);
      log(`\n  deploy:   solana program deploy ${shellQuote(res.soPath)} --program-id ${shellQuote(keyFile)}`);
      if (image) log(containerLine(image));
      return 0;
    },
  },
  check: {
    usage: "typesol check [<program.ts> | <program>…] [--json] [--stdin | --files]",
    help: [
      "Typecheck and validate the TypeSOL subset without building. In a project, no argument checks every program.",
      "--json    print { ok, diagnostics: [{ file, line, column, message }] } (exit 1 when there are diagnostics)",
      "--stdin   read <program.ts>'s text from stdin instead of the file (an editor's unsaved buffer); its imports are read from disk",
      '--files   read { "files": { "<absolute path>": "<text>", … } } from stdin: those files\' texts instead of the disk (unsaved buffers)',
    ].join("\n  "),
    options: { json: { type: "boolean" }, stdin: { type: "boolean" }, files: { type: "boolean" } },
    run(v, args) {
      if (!v.json) return check(v, args);
      // --json is read by programs (the editor plugin, agents): every outcome is one JSON object, never a usage text.
      try {
        return check(v, args);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (e instanceof CompileError) log(JSON.stringify({ ok: false, diagnostics: e.diagnostics }));
        else log(JSON.stringify({ ok: false, diagnostics: [], error: message }));
        return e instanceof UsageError ? 2 : 1;
      }
    },
  },
  "emit-c": {
    usage: "typesol emit-c <program.ts> [--out <file.c>] [--profile]",
    help: "Print or write the generated C.",
    options: { out: { type: "string" }, profile: { type: "boolean" } },
    run(v, args) {
      const { c } = generate(mustExist(one(args, "<program.ts>")), { profile: !!v.profile });
      if (v.out) writeFileSync(v.out as string, c);
      else process.stdout.write(c);
      return 0;
    },
  },
  mcp: {
    usage: "typesol mcp",
    help: [
      "Serve the Model Context Protocol on stdio for AI coding agents: tools to check a program (errors with hints), read",
      "its IDL, search the docs, and read the rules a TypeSOL program follows. `typesol init` writes .mcp.json (Claude",
      "Code) and .cursor/mcp.json (Cursor) that start it as `npx --no-install typesol mcp`.",
    ].join("\n  "),
    options: {},
    async run() {
      const { serve } = await import("./tools/mcp.js");
      await serve();
      return 0;
    },
  },
  doctor: {
    usage: "typesol doctor [--url <rpc>] [--config <solana cli config>]",
    help: [
      "Check what building, testing and deploying need: Node.js, the platform-tools, the Solana CLI, its keypair, the RPC",
      "(and the keypair's balance there) and the project. Each problem comes with the command that fixes it. Exit code 1",
      "when building is impossible (Node.js or the platform-tools); a missing deploy piece is a warning.",
    ].join("\n  "),
    options: { url: { type: "string" }, config: { type: "string" } },
    async run(v) {
      if (v.config !== undefined) solanaConfig(v.config as string); // a --config that does not exist is a usage error, as elsewhere
      const checks = await doctorChecks({ cwd: process.cwd(), url: v.url as string | undefined, config: v.config as string | undefined });
      log(formatChecks(checks));
      return checks.some((c) => !c.ok && !c.optional) ? 1 : 0;
    },
  },
  deploy: {
    usage:
      "typesol deploy [<program>…] [--url <rpc>] [--keypair <payer.json>] [--config <solana cli config>] [--sbpf v0|v1|v2] [--dry-run] [--toolchain-strict]",
    help: [
      `In a project: build, then \`solana program deploy\` each program at its <out>/deploy/<name>-keypair.json address.`,
      "Deploying again upgrades it (the payer must be the upgrade authority). --dry-run builds and prints the commands.",
      "Needs the Agave CLI (`solana`) on PATH.",
      TOOLCHAIN_STRICT,
    ].join("\n  "),
    options: {
      url: { type: "string" },
      keypair: { type: "string" },
      config: { type: "string" },
      "dry-run": { type: "boolean" },
      sbpf: { type: "string" },
      "toolchain-strict": { type: "boolean" },
    },
    async run(v, args) {
      if (v["toolchain-strict"]) setToolchainStrict();
      const ws = needWorkspace("deploy");
      const cfg = solanaConfig(v.config as string | undefined);
      const url = (v.url as string | undefined) ?? cfg.url;
      // Without either, `solana program deploy` would pick its own default cluster (mainnet-beta): never silently.
      if (!url && !v["dry-run"])
        throw new Error(
          "no cluster: pass --url (devnet, mainnet-beta, localhost or an RPC URL), or set json_rpc_url in the Solana CLI config (`solana config set --url devnet`)",
        );
      const built = buildWorkspace(ws, names(ws, args), { sbpf: sbpfOf(v), needKeypair: true });
      if (url && !v["dry-run"]) {
        // Before any transaction: the RPC answers and the payer can afford it, with what to do if not.
        const payer = (v.keypair as string | undefined) ?? cfg.keypair ?? path.join(os.homedir(), ".config/solana/id.json");
        await deployPreflight({
          url: clusterUrl(url),
          payer,
          programs: built.map((b) => ({ soPath: b.result.soPath, address: b.address, name: b.paths.name })),
        });
        log(`  cluster ${rpcHost(clusterUrl(url))}, payer ${payerAddress(payer)}`);
      }
      for (const b of built) {
        const cliArgs = deployArgs(b.result.soPath, b.paths.keypair, { url: v.url as string, payer: v.keypair as string, config: v.config as string });
        if (v["dry-run"]) {
          log(`solana ${cliArgs.map(shellQuote).join(" ")}`);
          continue;
        }
        log(`  deploying ${b.paths.name} (${b.address})…`);
        try {
          execFileSync("solana", cliArgs, { stdio: "inherit" });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`\`solana\` was not found on PATH. Install the Agave CLI: ${INSTALL_AGAVE}`);
          throw new Error(`solana program deploy failed for ${b.paths.name} (see its output above)`);
        }
      }
      return 0;
    },
  },
  idl: {
    usage: "typesol idl publish [<program>…] [--url <rpc>] [--keypair <authority.json>] [--config <solana cli config>] [--non-canonical]",
    help: [
      `In a project: compile (no binary is rebuilt), then write each program's IDL to the Program Metadata program (seed "idl"), where Anchor`,
      "and explorers read it. The canonical IDL must be signed by the program's upgrade authority; --non-canonical",
      "writes one tied to the signer instead. Without --url/--keypair the Solana CLI config is used.",
    ].join("\n  "),
    options: { url: { type: "string" }, keypair: { type: "string" }, config: { type: "string" }, "non-canonical": { type: "boolean" } },
    async run(v, [sub, ...args]) {
      if (sub !== "publish") throw new UsageError(`unknown idl command "${sub ?? ""}" (expected "publish")`);
      const ws = needWorkspace("idl publish");
      const { url, keypair } = solanaConfig(v.config as string | undefined);
      const rpcUrl = (v.url as string | undefined) ?? url;
      const keyFile = (v.keypair as string | undefined) ?? keypair;
      if (!rpcUrl) throw new Error("no RPC: pass --url, or set json_rpc_url in the Solana CLI config");
      if (!keyFile || !existsSync(keyFile))
        throw new Error(`no signer keypair${keyFile ? ` at ${keyFile}` : ""}: pass --keypair, or set keypair_path in the Solana CLI config`);
      // Loaded only here: the other commands do not need an RPC client.
      const kit = await import("@solana/kit");
      const { publishIdl, rpcChain } = await import("./tools/idlpublish.js");
      const signer = await kit.createKeyPairSignerFromBytes(readKeypair(keyFile));
      const chain = rpcChain(await cliRpc(clusterUrl(rpcUrl)));
      log(`  cluster ${rpcHost(clusterUrl(rpcUrl))}, payer ${signer.address}`);
      for (const name of names(ws, args)) {
        // The IDL only needs the compiled model and the program address: the deployed binary is left alone.
        const { address } = programAddress(ws, name);
        const idl = buildIdl(generate(programPaths(ws, name).entry).model, address);
        const at = await publishIdl(chain, { program: kit.address(address), idl, payer: signer, canonical: !v["non-canonical"] });
        log(`  ${name.padEnd(12)} IDL at ${at}${v["non-canonical"] ? " (non-canonical)" : ""}`);
      }
      return 0;
    },
  },
  clone: {
    usage: "typesol clone [<address>…] [--url <rpc>] [--config <solana cli config>] [--out <dir>]",
    help: [
      "Copy accounts and programs from a cluster for the tests (Anchor's [test.validator.clone]): each account to",
      '<address>.json, each program to <address>.so (its ELF), in the project\'s tests/accounts ("accounts" in typesol.json)',
      'or --out. Without addresses, the project\'s "clone" list. testProgram loads that directory into its LiteSVM.',
      "The RPC is --url, a cluster moniker, or the Solana CLI config.",
    ].join("\n  "),
    options: { url: { type: "string" }, config: { type: "string" }, out: { type: "string" } },
    async run(v, args) {
      const ws = findWorkspace(process.cwd());
      const addresses = args.length ? args : (ws?.clone ?? []);
      if (!addresses.length) throw new UsageError(`name the accounts to clone, or list them in ${CONFIG} as "clone": ["…"]`);
      for (const a of addresses) if (!decodeAddress(a)) throw new UsageError(`"${a}" is not a base58 Solana address`);
      const dir = path.resolve((v.out as string | undefined) ?? ws?.accounts ?? "accounts");
      const rpcUrl = (v.url as string | undefined) ?? solanaConfig(v.config as string | undefined).url;
      if (!rpcUrl) throw new Error("no RPC: pass --url, or set json_rpc_url in the Solana CLI config");
      const { cloneAccounts } = await import("./tools/clone.js");
      const lines = await cloneAccounts((await cliRpc(clusterUrl(rpcUrl))) as never, [...new Set(addresses)], dir);
      for (const l of lines) log(`  ${l}`);
      log(`  ${lines.length} written to ${path.relative(process.cwd(), dir) || "."}`);
      return 0;
    },
  },
  cpi: {
    usage: "typesol cpi <idl.json> [--out <file.ts>] [--prefix <name>] [--address <base58>]",
    help: "Generate TypeSOL helpers that call another program's instructions, from its Anchor IDL (0.30+/1.x or TypeSOL).",
    options: { out: { type: "string" }, prefix: { type: "string" }, address: { type: "string" } },
    run(v, args) {
      const file = one(args, "<idl.json>");
      if (v.address && !decodeAddress(v.address as string)) throw new UsageError(`--address "${v.address}" is not a base58 Solana address`);
      if (v.prefix && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.prefix as string)) throw new UsageError("--prefix must be an identifier");
      const res = generateCpi(readJson(file) as Idl, { prefix: v.prefix as string, address: v.address as string });
      if (v.out) {
        writeFileSync(v.out as string, res.source);
        log(`  wrote ${v.out}: ${res.generated.length} helper(s)`);
      } else process.stdout.write(res.source);
      for (const s of res.skipped) console.error(`  skipped ${s.instruction}: ${s.reason}`);
      return 0;
    },
  },
  port: {
    usage: "typesol port <idl.json> [--out <file.ts>]",
    help: [
      "A TypeSOL program skeleton from an Anchor IDL (0.30+/1.x): account structs, enums, errors, events and one function per",
      "instruction with its accounts and arguments (bodies to fill in). Discriminators, account names and error order are kept,",
      "so existing clients keep working where the layouts match; the notes (stderr) list where they do not.",
    ].join("\n  "),
    options: { out: { type: "string" } },
    run(v, args) {
      const file = one(args, "<idl.json>");
      const res = generatePort(readJson(file) as PortIdl);
      if (v.out) {
        if (existsSync(v.out as string)) throw new UsageError(`${v.out} exists; refusing to overwrite it`);
        writeFileSync(v.out as string, res.source);
        log(`  wrote ${v.out}`);
      } else process.stdout.write(res.source);
      for (const n of res.notes) console.error(`  note: ${n}`);
      return 0;
    },
  },
  client: {
    usage:
      "typesol client <idl.json> [--out <file.ts>] [--address <base58>]\n  typesol client --address <program id> [--url <rpc>] [--config <solana cli config>] [--out <file.ts>]",
    help: [
      "Generate a typed TypeScript client (on @solana/kit) from an Anchor IDL (0.30+/1.x or TypeSOL). The IDL is validated first;",
      "what the client leaves out is printed as notes. `typesol build` already writes <name>.client.ts for TypeSOL programs.",
      "Without an IDL file, the IDL is read from the chain for the program at --address: the canonical Program Metadata IDL",
      "(`typesol idl publish`, Codama), else Anchor's IDL account (`anchor idl init`).",
    ].join("\n  "),
    options: { out: { type: "string" }, address: { type: "string" }, url: { type: "string" }, config: { type: "string" } },
    async run(v, args) {
      if (v.address && !decodeAddress(v.address as string)) throw new UsageError(`--address "${v.address}" is not a base58 Solana address`);
      let idl: unknown;
      if (args.length === 0) {
        if (!v.address) throw new UsageError("pass an IDL file, or --address to read the program's IDL from the chain");
        const rpcUrl = (v.url as string | undefined) ?? solanaConfig(v.config as string | undefined).url;
        if (!rpcUrl) throw new Error("no RPC: pass --url, or set json_rpc_url in the Solana CLI config");
        // Loaded only here: the other commands do not need an RPC client.
        const kit = await import("@solana/kit");
        const { fetchProgramIdl } = await import("./tools/idlpublish.js");
        const found = await fetchProgramIdl(await cliRpc(clusterUrl(rpcUrl)), kit.address(v.address as string));
        console.error(`  IDL from ${found.source === "anchor" ? "Anchor's IDL account" : "the Program Metadata program"}`);
        idl = found.idl;
      } else {
        if (v.url) throw new UsageError("--url reads the IDL from the chain: leave out the IDL file");
        idl = readJson(one(args, "<idl.json>"));
      }
      const res = generateClient(idl as ClientIdl, { address: v.address as string | undefined });
      if (v.out) {
        writeFileSync(v.out as string, res.source);
        log(`  wrote ${v.out}`);
      } else process.stdout.write(res.source);
      for (const n of res.notes) console.error(`  note: ${n}`);
      return 0;
    },
  },
  verify: {
    usage:
      "typesol verify <program.ts | program> [<deployed.so>] [--address <program id>] [--url <rpc>] [--config <solana cli config>] [--sbpf v0|v1|v2] [--manifest <name.build.json>] [--docker [--typesol-version <v>] [--release-record <file>]]",
    help: [
      "Rebuild and compare with what is deployed. Exit 0 on a match, 3 on a mismatch.",
      "With a .so (e.g. from `solana program dump`): compare with that file.",
      "Without one: read the program from the cluster (--url, else the Solana CLI config) at --address, or at the address",
      "typesol.json records for a project program. Also prints the upgrade authority and compares the IDL published",
      "on chain (`typesol idl publish`) with the one the source builds; a published IDL that differs is a mismatch.",
      "The SBPF version is read from the deployed binary unless --sbpf is given. Reproducible builds need the same",
      "TypeSOL version and platform-tools as the original (see its <name>.build.json).",
      "On a mismatch, the toolchain of each side that is known: the rebuild's, and the deployed binary's from a build",
      "manifest whose binary hash is the deployed one's (--manifest, <deployed>.build.json next to a given .so, or the",
      "local build's). A program on chain carries no record of what built it: keep the .build.json with the deployment.",
      "--manifest <file>   the <name>.build.json of the build that was deployed",
      "With --docker the rebuild runs in the pinned container, with the TypeSOL version of the deployed build's manifest",
      "(when one is known) unless --typesol-version is given; on a match it prints what was verified, for anyone to repeat.",
      DOCKER_HELP,
    ].join("\n  "),
    options: {
      sbpf: { type: "string" },
      address: { type: "string" },
      url: { type: "string" },
      config: { type: "string" },
      manifest: { type: "string" },
      ...DOCKER_OPTIONS,
    },
    async run(v, args) {
      dockerOptions(v);
      if (args.length < 1 || args.length > 2) throw new UsageError("verify takes the program and, optionally, the deployed .so");
      const [target, deployedPath] = args;
      if (deployedPath && (v.address || v.url)) throw new UsageError("give either a deployed .so or --address/--url, not both");
      if (v.address && !decodeAddress(v.address as string)) throw new UsageError(`--address "${v.address}" is not a base58 Solana address`);
      if (v.manifest !== undefined && !existsSync(v.manifest as string)) throw new UsageError(`${v.manifest} does not exist`);
      const ws = findWorkspace(process.cwd());
      const name = ws && (ws.programs[target] ? target : programForEntry(ws, target));
      const entry = ws && name ? programPaths(ws, name).entry : target;
      if (!existsSync(entry)) throw new UsageError(`${entry} does not exist`);

      let deployed: Buffer;
      let onChain:
        { address: string; info: import("./tools/onchain.js").Deployed; rpc: import("@solana/kit").Rpc<import("@solana/kit").SolanaRpcApi> } | undefined;
      if (deployedPath) {
        if (!existsSync(deployedPath)) throw new UsageError(`${deployedPath} does not exist`);
        deployed = readFileSync(deployedPath);
      } else {
        const address = (v.address as string | undefined) ?? (ws && name ? ws.programs[name].address : undefined);
        if (!address) throw new UsageError("no program address: pass --address, a deployed .so, or name a project program that has been built");
        const rpcUrl = (v.url as string | undefined) ?? solanaConfig(v.config as string | undefined).url;
        if (!rpcUrl) throw new Error("no RPC: pass --url, or set json_rpc_url in the Solana CLI config");
        // Loaded only here: the other commands do not need an RPC client.
        const { fetchDeployed } = await import("./tools/onchain.js");
        const rpc = await cliRpc(clusterUrl(rpcUrl));
        const info = await fetchDeployed(rpc, address);
        onChain = { address, info, rpc };
        deployed = info.elf;
      }
      // ELF e_flags (offset 0x30) hold the SBPF version: 0 for v0, 1 for v1, 2 for v2.
      const flags = deployed.length > 0x34 && deployed.readUInt32BE(0) === 0x7f454c46 ? deployed.readUInt32LE(0x30) : 0;
      const sbpf = sbpfOf(v) ?? SBPF_VERSIONS[flags] ?? "v0";
      const programName = path.basename(entry).replace(/\.ts$/, "");
      // The rebuild's own output directory is temporary; the local build's manifest sits in the usual place.
      const local = ws && name ? programPaths(ws, name).outDir : path.join(path.dirname(entry), "target");
      const candidates = [
        v.manifest as string | undefined,
        deployedPath ? deployedPath.replace(/\.so$/, "") + ".build.json" : undefined,
        path.join(local, `${programName}.build.json`),
      ].filter((f): f is string => !!f);
      const known = buildManifests(deployed, candidates);
      const address = onChain?.address ?? "11111111111111111111111111111111";
      const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-verify-"));
      let rebuilt: BuildManifest, idl: object, same: boolean;
      let image: BuildImage | undefined;
      let root: string | undefined;
      try {
        if (v.docker) {
          image = await buildImage(v, ws?.root, known.deployed ? { version: known.deployed.manifest.compiler, from: relPath(known.deployed.file) } : undefined);
          root = ws && name ? ws.root : path.dirname(path.resolve(entry));
          const [r] = containerBuild(image, root, [{ entry, outDir: dir, address, sbpf }]);
          rebuilt = r!.manifest;
          idl = JSON.parse(readFileSync(path.join(dir, `${r!.name}.json`), "utf8")) as object;
          same = verifyBinary(deployed, readFileSync(r!.soPath));
        } else {
          const res = build(entry, dir, address, { sbpf });
          rebuilt = res.manifest;
          idl = res.idl;
          same = verifyBinary(deployed, readFileSync(res.soPath));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const what =
        deployedPath ??
        `${onChain!.address} (${onChain!.info.dataAccount === onChain!.address ? "" : `data ${onChain!.info.dataAccount}, `}loader ${onChain!.info.loader})`;
      log(same ? `  match     ${rebuilt.binary} (sbpf ${sbpf})` : `  MISMATCH  ${what} is not what ${entry} builds to (${rebuilt.binary}, sbpf ${sbpf})`);
      if (same && image && root) for (const line of verifiedLines({ what, entry, root, rebuilt, image, args, v })) log(line);
      if (!same) for (const line of toolchainHint(rebuilt, known, !!v.manifest)) log(line);
      if (!onChain) return same ? 0 : 3;

      const { info } = onChain;
      log(`  authority ${info.authority ?? "none: the program is immutable"}${info.slot !== undefined ? `; last deployed in slot ${info.slot}` : ""}`);
      const { fetchIdl, metadataAddress } = await import("./tools/idlpublish.js");
      const { canonicalJson } = await import("./tools/onchain.js");
      // No canonical metadata account means nothing was published; one that cannot be read is an error, not "none".
      const at = await metadataAddress(onChain.address as never, null);
      const exists = (await onChain.rpc.getAccountInfo(at, { encoding: "base64" }).send()).value !== null;
      if (!exists) {
        log("  idl       none published on chain (typesol idl publish)");
        return same ? 0 : 3;
      }
      let published: object;
      try {
        published = await fetchIdl(onChain.rpc, onChain.address as never);
      } catch (e) {
        log(`  IDL ERROR  the IDL at ${at} could not be read: ${(e as Error).message}`);
        return 3;
      }
      const idlSame = canonicalJson(published) === canonicalJson(idl);
      log(
        idlSame
          ? "  idl       match: the published IDL is the one the source builds"
          : "  IDL MISMATCH  the published IDL differs from the one the source builds",
      );
      return same && idlSame ? 0 : 3;
    },
  },
  profile: {
    usage: "typesol profile <logs.txt | -> [--program <id>]",
    help: "Compute units per TypeScript line, from the logs of a transaction run against a --profile build (one log line per line).",
    options: { program: { type: "string" } },
    run(v, args) {
      const file = one(args, "<logs.txt>");
      if (file !== "-" && !existsSync(file)) throw new UsageError(`${file} does not exist`);
      const logs = readFileSync(file === "-" ? 0 : file, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const rows = profileLogs(logs, v.program as string | undefined);
      if (!rows.length) {
        console.error("no profile markers found: run a transaction against a `typesol build --profile` binary and pass its logs");
        return 1;
      }
      log(formatProfile(rows));
      return 0;
    },
  },
};

const USAGE = `Usage:\n${Object.values(COMMANDS)
  .map((c) => `  ${c.usage}`)
  .join("\n")}\n  typesol --version\n\nRun \`typesol <command> --help\` for details.`;

function log(s: string) {
  console.log(s);
}

/**
 * Diagnostics for a terminal: the path relative to the working directory, the source line with the problem marked, and
 * the rest of the message (a hint, TypeScript's details) under it. `--json` and CompileError.message keep the plain form.
 */
function showDiagnostics(diagnostics: Diagnostic[], sources?: Map<string, string>): string {
  const cache = new Map<string, string[] | undefined>();
  const linesOf = (file: string) => {
    if (!cache.has(file)) {
      let text = sources?.get(file);
      if (text === undefined && existsSync(file)) text = readFileSync(file, "utf8");
      cache.set(file, text?.split(/\r?\n/));
    }
    return cache.get(file);
  };
  return diagnostics
    .map((d) => {
      const rel = path.relative(process.cwd(), d.file);
      const shown = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : d.file;
      const [first, ...rest] = d.message.split("\n");
      const out = [`${shown}:${d.line}:${d.column} - error: ${first}`];
      const src = linesOf(d.file)?.[d.line - 1];
      if (src !== undefined) {
        const gutter = String(d.line);
        const width = Math.max(1, Math.min(d.length ?? 1, src.length - (d.column - 1)));
        out.push(`  ${gutter} | ${src}`, `  ${" ".repeat(gutter.length)} | ${" ".repeat(Math.max(0, d.column - 1))}${"^".repeat(width)}`);
      }
      for (const r of rest) out.push(`  ${r}`);
      return out.join("\n");
    })
    .join("\n\n");
}

/** `typesol check`: diagnostics as text, or (--json) as JSON; CompileErrors from a single file are thrown. */
function check(v: Record<string, string | boolean | undefined>, args: string[]): number {
  // In a project: the named programs, or all of them.
  const ws = !v.stdin && !v.files && !args.some((a) => a.endsWith(".ts")) ? findWorkspace(process.cwd()) : undefined;
  if (ws) {
    const diagnostics: Diagnostic[] = [];
    for (const name of names(ws, args)) {
      try {
        const { model } = generate(programPaths(ws, name).entry);
        if (!v.json)
          log(`ok  ${name}: ${model.instructions.length} instruction(s), ${model.accountStructs.size} account type(s), ${model.events.size} event(s)`);
      } catch (e) {
        if (!(e instanceof CompileError)) throw e;
        diagnostics.push(...e.diagnostics);
        if (!v.json) console.error(`${name}:\n${showDiagnostics(e.diagnostics)}`);
      }
    }
    if (v.json) log(JSON.stringify({ ok: !diagnostics.length, diagnostics }));
    return diagnostics.length ? 1 : 0;
  }
  const file = path.resolve(one(args, "<program.ts>"));
  let files: Map<string, string> | undefined;
  if (v.stdin) files = new Map([[file, readFileSync(0, "utf8")]]);
  else if (v.files) {
    let given: unknown;
    try {
      given = (JSON.parse(readFileSync(0, "utf8")) as { files?: unknown } | null)?.files ?? {};
    } catch (e) {
      throw new UsageError(`--files: stdin is not JSON (${(e as Error).message})`);
    }
    if (typeof given !== "object" || given === null || Object.values(given).some((t) => typeof t !== "string"))
      throw new UsageError('--files: expected { "files": { "<absolute path>": "<text>", … } } on stdin');
    files = new Map(Object.entries(given as Record<string, string>).map(([p, t]) => [path.resolve(p), t]));
  }
  if (!files?.has(file)) mustExist(file);
  const { model } = generate(file, { files });
  if (v.json) log(JSON.stringify({ ok: true, diagnostics: [] }));
  else log(`ok  ${model.name}: ${model.instructions.length} instruction(s), ${model.accountStructs.size} account type(s), ${model.events.size} event(s)`);
  return 0;
}

function mustExist(file: string): string {
  if (!existsSync(file)) throw new UsageError(`${file} does not exist`);
  return file;
}

/**
 * The build manifests among `candidates` (files that may not exist): the one whose binary hash is the deployed bytes'
 * (it describes the deployed build), and the others, which describe other binaries (an older local build).
 */
function buildManifests(
  deployed: Buffer,
  candidates: string[],
): { deployed?: { file: string; manifest: BuildManifest }; unrelated: { file: string; manifest: BuildManifest }[] } {
  const deployedHash = createHash("sha256")
    .update(deployed.subarray(0, elfLength(deployed)))
    .digest("hex");
  const unrelated: { file: string; manifest: BuildManifest }[] = [];
  for (const file of [...new Set(candidates.map((c) => path.resolve(c)))]) {
    if (!existsSync(file)) continue;
    let manifest: BuildManifest;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8")) as BuildManifest;
    } catch {
      continue;
    }
    if (typeof manifest?.clang !== "string" || typeof manifest.binary !== "string") continue;
    if (manifest.binary === deployedHash) return { deployed: { file, manifest }, unrelated };
    unrelated.push({ file, manifest });
  }
  return { unrelated };
}

/** A path as the user would type it here: relative below the working directory, absolute elsewhere. */
const relPath = (f: string) => {
  const rel = path.relative(process.cwd(), f);
  return !rel ? f : rel.startsWith("..") || path.isAbsolute(rel) ? path.resolve(f) : rel;
};

/**
 * After a verify mismatch: the toolchain of the rebuild and, when a build manifest describes the deployed bytes (its
 * binary hash is theirs), of the deployed build, and what differs. A manifest that describes other bytes (an older
 * local build) is only mentioned: its toolchain says nothing about the deployed binary.
 */
function toolchainHint(rebuilt: BuildManifest, known: ReturnType<typeof buildManifests>, explicit: boolean): string[] {
  const lines = [`  rebuilt   ${describeToolchain(rebuilt)}`];
  const other = known.deployed;
  if (other) {
    lines.push(`  deployed  ${describeToolchain(other.manifest)} (${relPath(other.file)}, whose binary hash is the deployed one's)`);
    const diff = toolchainDifferences(rebuilt, other.manifest);
    const why = diff.includes("clang")
      ? "another clang can compile the same C to other bytes; "
      : diff.includes("host")
        ? "before 0.45.0 a program with 128-bit or signed division linked platform-tools' compiler-builtins, laid out differently by each host package; "
        : "";
    const fix =
      diff.length === 1 && diff[0] === "host"
        ? other.manifest.container
          ? "rebuild with --docker, as the deployed build was"
          : `rebuild on a ${other.manifest.host!.os}-${other.manifest.host!.arch} host, or deploy a --docker build so that anyone can rebuild it`
        : `rebuild with the deployed side's ${diff.join(" and ")} to compare like with like`;
    lines.push(
      diff.length
        ? `  differs   ${diff.join(", ")}: ${why}${fix}`
        : "  same toolchain and compiler versions on both sides: the sources (or an import, or the runtime header) differ",
    );
    return lines;
  }
  lines.push(
    "  deployed  toolchain unknown: a deployed program records nothing about what built it" +
      (explicit ? "" : "; pass --manifest <name>.build.json, kept from the build that was deployed"),
  );
  for (const u of known.unrelated) {
    const diff = toolchainDifferences(rebuilt, u.manifest);
    lines.push(
      `  note      ${relPath(u.file)} describes another binary (${u.manifest.binary.slice(0, 12)}…, ${describeToolchain(u.manifest)})` +
        (diff.length ? `; it differs from the rebuild in ${diff.join(", ")}` : ""),
    );
  }
  return lines;
}

/** After a container verify matched: what was verified, in terms a third party can repeat. */
function verifiedLines(o: {
  what: string;
  entry: string;
  root: string;
  rebuilt: BuildManifest;
  image: BuildImage;
  args: string[];
  v: Record<string, unknown>;
}): string[] {
  const id = o.image.identity;
  const rev = sourceRevision(o.root);
  const repeat = [
    "typesol verify",
    ...o.args.map(shellQuote),
    ...(o.v.address ? ["--address", o.v.address as string] : []),
    ...(o.v.url ? ["--url", shellQuote(o.v.url as string)] : []),
    ...(o.v.sbpf ? ["--sbpf", o.v.sbpf as string] : []),
    "--docker",
    "--typesol-version",
    id.typesol.version,
  ].join(" ");
  return [
    `  verified  ${o.what} is what ${relPath(path.resolve(o.entry))} builds to in the pinned build container:`,
    `    source     ${o.root}${rev ? ` (git ${rev.commit}${rev.clean ? "" : ", with uncommitted changes"})` : " (not a git checkout)"}`,
    `    TypeSOL    ${id.typesol.version}, npm tarball shasum ${id.typesol.shasum} (commit ${id.typesol.commit}), as releases/${id.typesol.version}.json records it`,
    `    record     ${recordLine(id.typesol.record) ?? `releases/${id.typesol.version}.json`}`,
    `    toolchain  ${shortClang(o.rebuilt.clang)}, platform-tools ${o.rebuilt.platformTools ?? "unknown"}, TypeScript ${o.rebuilt.typescript}`,
    `    container  ${id.platform}, Dockerfile sha256 ${id.dockerfile}, local image ${id.image}`,
    ...id.base.map((b) => `    base       ${b}`),
    ...id.downloads.map((d) => `    download   ${d.url.split("/").pop()} sha256 ${d.sha256}`),
    `    repeat     ${repeat}`,
  ];
}

/** Where a container build's release record came from, in one line. */
function recordLine(r: BuildImage["identity"]["typesol"]["record"]): string | undefined {
  if (!r) return undefined;
  const where =
    r.kind === "package"
      ? `${r.location} in this package`
      : r.kind === "file"
        ? `${r.location} (--release-record)`
        : `${r.location} (the repository's main branch)`;
  return `${where}, sha256 ${r.sha256}`;
}

/** --typesol-version and --release-record only mean something with --docker. */
function dockerOptions(v: Record<string, unknown>): void {
  for (const o of ["typesol-version", "release-record"])
    if (v[o] !== undefined && !v.docker) throw new UsageError(`--${o} applies to container builds: add --docker`);
}

/**
 * The build image for --docker, built first if needed, with the TypeSOL version chosen for it (said on stderr). The
 * version's release record is this package's, the --release-record file, or (a release newer than this package) the
 * repository's.
 */
async function buildImage(v: Record<string, unknown>, projectRoot: string | undefined, deployed?: { version: string; from: string }): Promise<BuildImage> {
  const { version, why } = chooseTypesolVersion({ given: v["typesol-version"] as string | undefined, deployed, projectRoot, cliVersion: COMPILER_VERSION });
  needDocker(); // before any download: without Docker there is nothing to check a record for
  const found = await findReleaseRecord(version, { file: v["release-record"] as string | undefined });
  const image = ensureImage(version, found);
  console.error(`  container ${image.tag}: TypeSOL ${version} (${why}), ${image.identity.platform}`);
  return image;
}

/** The container build's environment in one line, for the build's report. */
function containerLine(image: BuildImage): string {
  const id = image.identity;
  return `  built in  ${id.platform} container ${image.tag} (Dockerfile sha256 ${id.dockerfile.slice(0, 16)}…, TypeSOL ${id.typesol.version} tarball ${id.typesol.shasum}); recorded in each .build.json`;
}

/** Hold the build lock of every directory while `fn` runs (one container builds them all). */
function withBuildLocks<T>(dirs: string[], fn: () => T): T {
  const [first, ...rest] = [...new Set(dirs)].sort();
  return first === undefined ? fn() : withBuildLock(first, () => withBuildLocks(rest, fn));
}

/** Quote a command-line word for a POSIX shell when it needs it. */
function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function one(args: string[], what: string): string {
  if (args.length !== 1) throw new UsageError(`expected exactly one ${what}`);
  return args[0];
}

function sbpfOf(v: Record<string, unknown>): Sbpf | undefined {
  const s = v.sbpf as string | undefined;
  if (s !== undefined && !SBPF_VERSIONS.includes(s as Sbpf)) throw new UsageError(`--sbpf must be one of ${SBPF_VERSIONS.join(", ")}`);
  return s as Sbpf | undefined;
}

function names(ws: Workspace, args: string[]): string[] {
  for (const a of args) if (!ws.programs[a]) throw new UsageError(`no program "${a}" in ${ws.file} (have: ${Object.keys(ws.programs).join(", ")})`);
  return args.length ? args : Object.keys(ws.programs);
}

function needWorkspace(cmd: string): Workspace {
  const ws = findWorkspace(process.cwd());
  if (!ws) throw new Error(`${cmd} works in a project (${CONFIG}); create one with \`typesol init\``);
  return ws;
}

function readJson(file: string): unknown {
  if (!existsSync(file)) throw new UsageError(`${file} does not exist`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`);
  }
}

/** The address of a payer keypair file, for the line printed before a deploy (or why there is none). */
function payerAddress(file: string): string {
  if (!existsSync(file)) return `none at ${file} (the Solana CLI will refuse)`;
  try {
    return base58(readKeypair(file).subarray(32));
  } catch (e) {
    return `unreadable ${file} (${(e as Error).message})`;
  }
}

/** json_rpc_url / keypair_path from a Solana CLI config (the given file, or the CLI's default one). */
function solanaConfig(file?: string): { url?: string; keypair?: string } {
  const cfg = readSolanaConfig(file);
  if (file && !cfg.exists) throw new UsageError(`${file} does not exist`);
  return { url: cfg.url, keypair: cfg.keypair };
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version" || cmd === "-v" || cmd === "-V") {
    log(COMPILER_VERSION);
    return 0;
  }
  if (cmd === "help" && rest[0] && COMMANDS[rest[0]]) {
    log(`Usage: ${COMMANDS[rest[0]].usage}\n\n  ${COMMANDS[rest[0]].help}`);
    return 0;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    if (process.stdout.isTTY) log(banner());
    log(USAGE);
    return cmd ? 0 : 2;
  }
  const command = COMMANDS[cmd];
  if (!command) {
    console.error(`unknown command "${cmd}"\n\n${USAGE}`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    log(`Usage: ${command.usage}\n\n  ${command.help}`);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: command.options, allowPositionals: true, strict: true });
    return await command.run(values as Record<string, string | boolean | undefined>, positionals);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (e instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
      console.error(`${(e as Error).message}\n\nUsage: ${command.usage}\n\n  ${command.help}`);
      return 2;
    }
    throw e;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (e instanceof CompileError) {
    console.error(showDiagnostics(e.diagnostics));
    console.error(`\n${e.diagnostics.length} error(s)`);
  } else console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
