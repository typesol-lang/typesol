// `typesol doctor` and the checks `init` and `deploy` run before they need something: Node, the platform-tools the
// compiler builds with, the Solana CLI, its keypair and RPC, the project, and (with an RPC) whether it answers and the
// payer can afford a deploy. Each problem comes with the command that fixes it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Rpc, SolanaRpcApi } from "@solana/kit";
import {
  findToolchain,
  INSTALL_TESTED_TOOLCHAIN,
  installLines,
  linuxArm64,
  shortClang,
  TESTED_TOOLCHAIN,
  ToolchainMissing,
  toolchainInfo,
  toolchainStrict,
} from "../compiler/toolchain.js";
import { base58, readKeypair } from "../keys.js";
import { DOCKER_PLATFORM, dockerStatus, type DockerStatus } from "./docker.js";
import { findWorkspace } from "../workspace.js";
import { MIN_NODE } from "../node-version.js";

/** The Agave CLI release TypeSOL is tested with (its platform-tools are the tested ones). */
export const INSTALL_AGAVE = INSTALL_TESTED_TOOLCHAIN[0];

export interface Check {
  ok: boolean;
  /** A missing optional piece (the Solana CLI is only needed to deploy). */
  optional?: boolean;
  what: string;
  detail: string;
  fix?: string[];
}

/** The platform-tools the compiler needs: found, or what to run. */
export function toolchainCheck(): Check {
  try {
    const tc = findToolchain();
    let version = "";
    try {
      version = execFileSync(tc.clang, ["--version"], { encoding: "utf8" })
        .split("\n")[0]!
        .replace(/\s*\(.*$/, "");
    } catch {
      /* the path is enough */
    }
    return { ok: true, what: "platform-tools", detail: version || tc.sdk };
  } catch (e) {
    if (!(e instanceof ToolchainMissing)) return { ok: false, what: "platform-tools", detail: (e as Error).message };
    return { ok: false, what: "platform-tools", detail: e.summary, fix: installSteps(e.kind === "agave" ? "agave" : "platform-tools") };
  }
}

/** The install commands for this host, each with its note on the line above when what it does is not obvious. */
export function installSteps(from: "agave" | "platform-tools", host: { platform: string; arch: string } = process): string[] {
  return installLines(from, host);
}

/** The Solana CLI (deploying only): the Agave installer, or on Linux arm64, where there is none, what to do instead. */
export function solanaCliFix(host: { platform: string; arch: string } = process): string {
  return linuxArm64(host)
    ? "no Agave CLI is published for Linux arm64: deploy from macOS or Linux x86_64, or build it from source (https://docs.anza.xyz/cli/install)"
    : INSTALL_AGAVE;
}

/**
 * Whether the active platform-tools are the ones TypeSOL is tested with. An untested one is a warning, or an error
 * under TYPESOL_TOOLCHAIN=strict (as it is for a build then). Undefined when there are no platform-tools at all.
 */
export function testedToolchainCheck(): Check | undefined {
  let info;
  try {
    info = toolchainInfo();
  } catch {
    return undefined; // the platform-tools row says what is missing
  }
  const tested = `${shortClang(TESTED_TOOLCHAIN.clang)}, platform-tools ${TESTED_TOOLCHAIN.platformTools}`;
  if (info.tested) return { ok: true, what: "toolchain", detail: `tested: ${shortClang(info.clang)}, platform-tools ${info.platformTools ?? "unknown"}` };
  let strict = true;
  try {
    strict = toolchainStrict();
  } catch {
    /* a bad TYPESOL_TOOLCHAIN value fails the build itself; here it counts as strict */
  }
  return {
    ok: false,
    optional: !strict,
    what: "toolchain",
    detail: `untested: ${shortClang(info.clang)}, platform-tools ${info.platformTools ?? "unknown"}; TypeSOL is tested with ${tested} (Agave ${TESTED_TOOLCHAIN.agave}): binaries from another toolchain are not covered by its tests${strict ? " (TYPESOL_TOOLCHAIN=strict refuses it)" : ""}`,
    fix: ["# The tested platform-tools:", INSTALL_TESTED_TOOLCHAIN[1]],
  };
}

/** Docker for `build --docker` / `verify --docker`: optional, a row either way. */
export function dockerCheck(status: DockerStatus = dockerStatus()): Check {
  if (!status.ok) return { ok: false, optional: true, what: "docker", detail: `${status.reason}; needed only for --docker builds`, fix: [status.fix] };
  return {
    ok: true,
    what: "docker",
    detail: `${status.version} (${status.platform}): --docker builds run in ${DOCKER_PLATFORM}${status.platform === DOCKER_PLATFORM ? "" : ", emulated here"}`,
  };
}

/** json_rpc_url / keypair_path from a Solana CLI config (the given file, or the CLI's default one). */
export function solanaConfig(file?: string): { url?: string; keypair?: string; file: string; exists: boolean } {
  const configPath = file ?? path.join(os.homedir(), ".config/solana/cli/config.yml");
  if (!existsSync(configPath)) return { file: configPath, exists: false };
  const text = readFileSync(configPath, "utf8");
  const get = (k: string) => new RegExp(`^${k}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, "m").exec(text)?.[1];
  const expand = (p?: string) => (p?.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
  return { url: get("json_rpc_url"), keypair: expand(get("keypair_path")), file: configPath, exists: true };
}

/** The Solana CLI's cluster monikers, as `solana --url` accepts them; anything else is used as given. */
export function clusterUrl(url: string): string {
  const monikers: Record<string, string> = {
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
    m: "https://api.mainnet-beta.solana.com",
    devnet: "https://api.devnet.solana.com",
    d: "https://api.devnet.solana.com",
    testnet: "https://api.testnet.solana.com",
    t: "https://api.testnet.solana.com",
    localhost: "http://127.0.0.1:8899",
    l: "http://127.0.0.1:8899",
  };
  return monikers[url] ?? url;
}

/** Only the host: an RPC URL can carry an API key in its path or query, and these messages may be shared. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the RPC";
  }
}

/** The cluster an RPC belongs to, for the airdrop hint (mainnet has none). */
function clusterOf(url: string): "devnet" | "testnet" | "localhost" | undefined {
  const host = rpcHost(url);
  if (/devnet/.test(host)) return "devnet";
  if (/testnet/.test(host)) return "testnet";
  if (/^(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|$)/.test(host)) return "localhost";
  return undefined;
}

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result as T;
}

/** fetch's "fetch failed" says little: the cause's code (ECONNREFUSED, ENOTFOUND, a timeout) says more. */
export const errText = (e: unknown, timeoutSeconds = 10) => {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  return err.cause?.code ?? err.cause?.message ?? (err.name === "TimeoutError" ? `no answer in ${timeoutSeconds} s` : err.message);
};

/** How long one RPC request of the kit-based commands may take: TYPESOL_RPC_TIMEOUT seconds, default 30. */
export function rpcTimeoutSeconds(): number {
  const s = Number(process.env.TYPESOL_RPC_TIMEOUT);
  return Number.isFinite(s) && s > 0 ? s : 30;
}

/**
 * A kit RPC client for `clone`, `client --address`, `verify` and `idl publish`: each request gives up after
 * rpcTimeoutSeconds(), and a request that fails on the way names only the host and the cause, as `doctor` and
 * `deploy` do (the URL can carry an API key).
 */
export async function cliRpc(url: string): Promise<Rpc<SolanaRpcApi>> {
  const kit = await import("@solana/kit");
  const host = rpcHost(url);
  const seconds = rpcTimeoutSeconds();
  const base = kit.createDefaultRpcTransport({ url });
  const transport = (async (config: Parameters<typeof base>[0]) => {
    const timeout = AbortSignal.timeout(seconds * 1000);
    try {
      return await base({ ...config, signal: config.signal ? AbortSignal.any([config.signal, timeout]) : timeout });
    } catch (e) {
      throw new Error(`cannot reach ${host} (${errText(e, seconds)}): check --url, or json_rpc_url in the Solana CLI config`, { cause: e });
    }
  }) as typeof base;
  return kit.createSolanaRpcFromTransport(transport);
}

const sol = (lamports: number) =>
  lamports === 0 ? "0 SOL" : lamports < 100_000 ? `${lamports} lamports` : `${(lamports / 1e9).toFixed(lamports < 1e7 ? 4 : 2)} SOL`;
/** A cost, rounded up so the advice is enough. */
const solUp = (lamports: number) => `${(Math.ceil(lamports / 1e7) / 100).toFixed(2)} SOL`;

/**
 * Whether a `--keypair` / `keypair_path` value is a signer the Solana CLI resolves itself rather than a file: `ASK`,
 * `-` (stdin) or a `usb:`, `prompt:` or `stdin:` URI (`usb://ledger?key=0`, `prompt://`, `stdin://`; the scheme in any
 * case, as the Solana CLI reads it). Anything else is a file: `file:` through keypairFile.
 */
export function isSignerUri(source: string): boolean {
  return source === "ASK" || source === "-" || /^(?:usb|prompt|stdin):/i.test(source);
}

/** The file a `--keypair` / `keypair_path` value names: the path of a `file:` URI (`file:id.json`, `file:///abs/id.json`), as the Solana CLI reads it, else the value. */
export function keypairFile(source: string): string {
  const m = /^file:(?:\/\/[^/?#]*)?([^?#]*)/i.exec(source);
  return m ? m[1]! : source;
}

/** Where a deploy's payer comes from, for the message when its file is missing. */
export type PayerSource = { from: "flag" } | { from: "config"; config: string } | { from: "default" };

/**
 * A deploy's payer keypair file must exist: without it `solana program deploy` refuses only after the build, mid-way.
 * A signer URI (a Ledger, a prompt, stdin) is the Solana CLI's to resolve, so it is passed through unchecked.
 */
export function requirePayer(url: string, payer: string, source: PayerSource = { from: "default" }): void {
  if (isSignerUri(payer)) return;
  const file = keypairFile(payer);
  if (!file.trim()) {
    if (source.from === "config")
      throw new Error(
        `keypair_path in ${source.config.replace(os.homedir(), "~")} is empty: set it to the payer's keypair file, or pass --keypair <file>. Nothing was sent.`,
      );
    throw new Error("--keypair is empty: give the path of the payer's keypair file. Nothing was sent.");
  }
  if (existsSync(file)) return;
  const shown = file.replace(os.homedir(), "~");
  if (source.from === "flag") throw new Error(`no keypair file at ${shown} (given with --keypair): check the path. Nothing was sent.`);
  const cluster = clusterOf(url);
  if (source.from === "config")
    throw new Error(
      `no payer keypair at ${shown} (keypair_path in ${source.config.replace(os.homedir(), "~")}): create it with \`solana-keygen new --outfile ${shown}\`, or pass --keypair <file>` +
        (cluster ? `; fund it with \`solana airdrop 2 --keypair ${shown} --url ${cluster}\`` : "") +
        ". Nothing was sent.",
    );
  throw new Error(
    `no payer keypair at ${shown}: create one with \`solana-keygen new\` (or pass --keypair <file>)` +
      (cluster ? `, then fund it with \`solana airdrop 2 --url ${cluster}\`` : "") +
      ". Nothing was sent.",
  );
}

/** `deploy` runs `solana program deploy`: without the Solana CLI on PATH it stops before building. */
export function requireSolanaCli(): void {
  try {
    execFileSync("solana", ["--version"], { stdio: "ignore" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return; // there, if unwell: its own run says why
    throw new Error(solanaNotFound());
  }
}

/** The error for a missing `solana`, with how to get it on this host. */
export function solanaNotFound(host: { platform: string; arch: string } = process): string {
  return `\`solana\` was not found on PATH${linuxArm64(host) ? `: ${solanaCliFix(host)}` : `. Install the Agave CLI: ${solanaCliFix(host)}`}`;
}

/**
 * Before `solana program deploy`: the RPC answers, and the payer holds enough for the program's rent (a first deploy
 * holds about twice the binary's rent while the buffer exists; an upgrade, the buffer's). Throws with what to do.
 */
export async function deployPreflight(opts: { url: string; payer?: string; programs: { soPath: string; address: string; name: string }[] }): Promise<void> {
  const host = rpcHost(opts.url);
  try {
    await rpc(opts.url, "getVersion");
  } catch (e) {
    const local = clusterOf(opts.url) === "localhost";
    throw new Error(
      `cannot reach ${host} (${errText(e)}). ` +
        (local
          ? "Start a local validator in another terminal: `solana-test-validator`, or deploy to devnet with --url devnet."
          : "Check --url (or json_rpc_url in the Solana CLI config); for a test deploy use --url devnet or a local `solana-test-validator`."),
    );
  }
  // A signer URI (a Ledger, a prompt) has no address to read here: the Solana CLI resolves it and reports a shortfall.
  if (!opts.payer || isSignerUri(opts.payer) || !existsSync(keypairFile(opts.payer))) return;
  const payer = base58(readKeypair(keypairFile(opts.payer)).subarray(32));
  let need = 0;
  for (const p of opts.programs) {
    const size = statSync(p.soPath).size;
    const exists = (await rpc<{ value: unknown }>(opts.url, "getAccountInfo", [p.address, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])).value;
    const rent = await rpc<number>(opts.url, "getMinimumBalanceForRentExemption", [size + 45]);
    need += exists ? rent : 2 * rent;
  }
  need += 5_000_000; // fees for the buffer writes
  const balance = (await rpc<{ value: number }>(opts.url, "getBalance", [payer])).value;
  if (balance >= need) return;
  const cluster = clusterOf(opts.url);
  const airdrop = cluster ? ` Get test SOL: \`solana airdrop ${Math.max(2, Math.ceil((need - balance) / 1e9))} ${payer} --url ${cluster}\`.` : "";
  throw new Error(
    `the payer ${payer} has ${sol(balance)} on ${host}; deploying needs about ${solUp(need)} (rent, mostly returned when a buffer closes).${airdrop}`,
  );
}

/** Everything `typesol doctor` checks, in order. */
export async function doctorChecks(opts: { cwd: string; url?: string; config?: string }): Promise<Check[]> {
  const checks: Check[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push({
    ok: nodeOk,
    what: "Node.js",
    detail: process.versions.node,
    fix: nodeOk ? undefined : [`install Node.js ${MIN_NODE.join(".")} or later (https://nodejs.org)`],
  });
  checks.push(toolchainCheck());
  const tested = testedToolchainCheck();
  if (tested) checks.push(tested);
  let solanaVersion: string | undefined;
  try {
    solanaVersion = execFileSync("solana", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(" (")[0]!
      .trim();
  } catch {
    /* not installed */
  }
  checks.push(
    solanaVersion
      ? { ok: true, what: "Solana CLI", detail: solanaVersion }
      : { ok: false, optional: true, what: "Solana CLI", detail: "not on PATH (needed to deploy, not to build or test)", fix: [solanaCliFix()] },
  );
  checks.push(dockerCheck());
  const cfg = solanaConfig(opts.config);
  const keypair = cfg.keypair ?? path.join(os.homedir(), ".config/solana/id.json");
  if (existsSync(keypair)) {
    let address = "";
    try {
      address = base58(readKeypair(keypair).subarray(32));
    } catch (e) {
      checks.push({ ok: false, optional: true, what: "keypair", detail: (e as Error).message });
    }
    if (address) checks.push({ ok: true, what: "keypair", detail: `${address} (${keypair.replace(os.homedir(), "~")})` });
  } else
    checks.push({
      ok: false,
      optional: true,
      what: "keypair",
      detail: `none at ${keypair.replace(os.homedir(), "~")} (the deploy payer)`,
      fix: ["solana-keygen new"],
    });
  const url = opts.url ? clusterUrl(opts.url) : cfg.url;
  if (!url) checks.push({ ok: false, optional: true, what: "RPC", detail: "none set (deploy takes --url)", fix: ["solana config set --url devnet"] });
  else {
    const cluster = clusterOf(url);
    try {
      const v = await rpc<{ "solana-core": string }>(url, "getVersion");
      checks.push({ ok: true, what: "RPC", detail: `${rpcHost(url)} (solana-core ${v["solana-core"]})` });
      if (existsSync(keypair)) {
        const balance = (await rpc<{ value: number }>(url, "getBalance", [base58(readKeypair(keypair).subarray(32))])).value;
        checks.push(
          balance > 0
            ? { ok: true, what: "balance", detail: sol(balance) }
            : {
                ok: false,
                optional: true,
                what: "balance",
                detail: `0 SOL on ${rpcHost(url)}`,
                fix: [
                  cluster && cluster !== "localhost"
                    ? `solana airdrop 2 --url ${cluster}`
                    : cluster
                      ? "solana airdrop 2 --url localhost"
                      : "fund the keypair above",
                ],
              },
        );
      }
    } catch (e) {
      checks.push({
        ok: false,
        optional: true,
        what: "RPC",
        detail: `${rpcHost(url)} does not answer (${errText(e)})`,
        fix:
          cluster === "localhost" ? ["# In another terminal:", "solana-test-validator"] : ["pass --url devnet, or fix json_rpc_url in the Solana CLI config"],
      });
    }
  }
  const ws = findWorkspace(opts.cwd);
  checks.push(
    ws
      ? { ok: true, what: "project", detail: `${path.relative(opts.cwd, ws.file) || ws.file}: ${Object.keys(ws.programs).join(", ")}` }
      : { ok: true, optional: true, what: "project", detail: "none here (typesol init <dir> creates one)" },
  );
  return checks;
}

/** The last line of `doctor`: what is ready, and what the warnings are about. */
export function doctorSummary(checks: Check[]): string {
  const list = (cs: Check[]) => cs.map((c) => c.what).join(", ");
  const failed = checks.filter((c) => !c.ok && !c.optional);
  if (failed.length) return `Not ready to build or test: fix the ERR rows (${list(failed)}) first.`;
  const warned = checks.filter((c) => !c.ok);
  const deploy = warned.filter((c) => ["Solana CLI", "keypair", "RPC", "balance"].includes(c.what));
  const notes: string[] = [];
  if (deploy.length) notes.push(`deploying still needs: ${list(deploy)}`);
  if (warned.some((c) => c.what === "docker")) notes.push("Docker is only for --docker builds");
  if (warned.some((c) => c.what === "toolchain")) notes.push("the toolchain is not the tested one (builds work; their binaries are not covered by the tests)");
  if (!notes.length) return "Ready to build, test and deploy.";
  return `Ready to build and test. The ! rows: ${notes.join("; ")}.`;
}

export function formatChecks(checks: Check[]): string {
  const mark = (c: Check) => (c.ok ? "ok " : c.optional ? " ! " : "ERR");
  const width = Math.max(...checks.map((c) => c.what.length));
  return checks
    .map((c) => `  ${mark(c)}  ${c.what.padEnd(width)}  ${c.detail}${(c.fix ?? []).map((f) => `\n${" ".repeat(width + 9)}${f}`).join("")}`)
    .join("\n");
}
