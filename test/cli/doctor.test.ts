// The first minutes: `typesol doctor`, what `init` says when the platform-tools are missing, and the checks `deploy`
// runs before sending anything (an RPC that does not answer, a payer that cannot pay), against a fake RPC.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOrCreateKeypair } from "../../src/keys.js";
import { AGAVE_PATH, INSTALL_TESTED_TOOLCHAIN, installCommands, LINUX_ARM64_INSTALL, linuxArm64, TESTED_TOOLCHAIN } from "../../src/compiler/toolchain.js";
import { doctorSummary, installSteps, isSignerUri, solanaCliFix } from "../../src/tools/doctor.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "dist/cli.js");
const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-doctor-")));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Runs the CLI without blocking this process (the fake RPC below answers from it). */
const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    execFile("node", [CLI, ...args], { cwd, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ status: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
/** A user with no Solana toolchain and no Solana CLI config: an empty HOME, and only Node on PATH. */
const fresh = () => {
  const home = tmp();
  return { HOME: home, PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), TYPESOL_SBF_SDK: "" };
};

/** A `solana` that records its arguments (one call per line) and succeeds; `path` is a PATH with it and Node only. */
const fakeSolana = () => {
  const bin = tmp();
  const log = path.join(bin, "calls.txt");
  writeFileSync(path.join(bin, "solana"), `#!/bin/sh\necho "$*" >> '${log}'\n`);
  chmodSync(path.join(bin, "solana"), 0o755);
  return {
    path: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
};

/** A JSON-RPC server that answers like a cluster where `balance` lamports sit in every account. */
let rpc: Server;
let rpcUrl = "";
let balance = 0;
beforeAll(async () => {
  rpc = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, id } = JSON.parse(body) as { method: string; id: number };
      const result =
        method === "getVersion"
          ? { "solana-core": "3.1.10" }
          : method === "getBalance"
            ? { value: balance }
            : method === "getAccountInfo"
              ? { value: null }
              : method === "getMinimumBalanceForRentExemption"
                ? 100_000_000
                : null;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
});
afterAll(() => rpc.close());

describe("first minutes: doctor, init, deploy preflight", () => {
  it("doctor and init point a user without the platform-tools at the install commands", async () => {
    const env = fresh();
    const dir = tmp();
    const init = await run(["init", "app", "--name", "counter"], dir, env);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("created app/programs/counter.ts");
    // The three commands of the README's toolchain block, in its order: the installer, the PATH line it only writes to
    // ~/.profile, and the one command that installs the platform-tools by themselves.
    const install = installCommands("agave");
    if (process.platform === "linux" && process.arch === "arm64") expect(install).toEqual([...LINUX_ARM64_INSTALL]);
    else {
      expect(init.stdout).toContain("! The Agave CLI is not installed; npm test compiles with the platform-tools. Install once:");
      expect(init.stdout).toContain(
        [
          `      ${INSTALL_TESTED_TOOLCHAIN[0]}`,
          `      ${AGAVE_PATH}   # the installer adds this to ~/.profile, for new shells; this one needs it now`,
          `      cargo-build-sbf --install-only --force-tools-install --tools-version ${TESTED_TOOLCHAIN.platformTools}   # once: downloads the platform-tools`,
        ].join("\n"),
      );
    }
    expect(init.stdout).not.toMatch(/cargo-build-sbf --version|cargo-build-sbf --force-tools-install(?! --)/);
    expect(init.stdout).toMatch(/next:\n {4}cd app\n {4}npm install\n {4}npm test/);

    const doctor = await run(["doctor"], path.join(dir, "app"), env);
    expect(doctor.status).toBe(1); // building is impossible without the platform-tools
    expect(doctor.stdout).toMatch(/ERR {2}platform-tools +the Agave CLI is not installed \(/);
    expect(doctor.stdout).toMatch(/! {3}keypair .*\n.*solana-keygen new/);
    expect(doctor.stdout).toMatch(/ok {3}project +typesol\.json: counter/);
    expect(doctor.stdout).toMatch(/\n\n {2}Not ready to build or test: fix the ERR rows \(platform-tools\) first\.\n$/);
  });

  it("the Agave CLI without its platform-tools: init, doctor and the build name the one command that installs them", async () => {
    const env = fresh();
    // What the Agave installer leaves before the platform-tools are installed: the SDK's C files, no clang.
    const sdk = path.join(env.HOME, ".local/share/solana/install/active_release/bin/platform-tools-sdk/sbf");
    mkdirSync(path.join(sdk, "c"), { recursive: true });
    writeFileSync(path.join(sdk, "c/sbf.mk"), "");
    const dir = tmp();
    const init = await run(["init", "app", "--name", "counter"], dir, env);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("! The Agave CLI is installed, but not its platform-tools; npm test compiles with the platform-tools. Install once:");
    expect(init.stdout).toContain(`      ${installSteps("platform-tools").join("\n      ")}\n`);
    const doctor = await run(["doctor"], path.join(dir, "app"), env);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain(`the Agave CLI is installed, but not its platform-tools (nothing under ${sdk}/dependencies)`);
    const build = await run(["build"], path.join(dir, "app"), env);
    expect(build.status).toBe(1);
    expect(build.stderr).toContain(`error: the Agave CLI is installed, but not its platform-tools (nothing under ${sdk}/dependencies). Install them once: `);
    if (!linuxArm64()) expect(build.stderr).toContain(`Install them once: ${INSTALL_TESTED_TOOLCHAIN[1]}.`);
  });

  it("install commands per host: the README's on macOS and Linux x86_64, the linux-aarch64 package on Linux arm64", () => {
    const mac = { platform: "darwin", arch: "arm64" };
    const x64 = { platform: "linux", arch: "x64" };
    const arm = { platform: "linux", arch: "arm64" };
    expect(installCommands("agave", mac)).toEqual([INSTALL_TESTED_TOOLCHAIN[0], AGAVE_PATH, INSTALL_TESTED_TOOLCHAIN[1]]);
    expect(installCommands("agave", x64)).toEqual(installCommands("agave", mac));
    expect(installCommands("platform-tools", x64)).toEqual([INSTALL_TESTED_TOOLCHAIN[1]]);
    expect(installCommands("agave", arm)).toEqual([...LINUX_ARM64_INSTALL]);
    expect(installCommands("platform-tools", arm)).toEqual([...LINUX_ARM64_INSTALL]);
    expect(LINUX_ARM64_INSTALL.join("\n")).toContain(
      `/platform-tools/releases/download/${TESTED_TOOLCHAIN.platformTools}/platform-tools-linux-aarch64.tar.bz2`,
    );
    expect(LINUX_ARM64_INSTALL.join("\n")).toContain(`/agave/releases/download/v${TESTED_TOOLCHAIN.agave}/solana-release-x86_64-unknown-linux-gnu.tar.bz2`);
    expect(installSteps("agave", arm).at(-1)).toMatch(
      /^export TYPESOL_SBF_SDK=\$HOME\/\.local\/share\/typesol-sdk\/sbf {3}# add this line to ~\/\.profile too/,
    );
    expect(solanaCliFix(arm)).toMatch(/^no Agave CLI is published for Linux arm64: deploy from macOS or Linux x86_64/);
    expect(solanaCliFix(x64)).toBe(INSTALL_TESTED_TOOLCHAIN[0]);
    // The README and the troubleshooting page print the same commands (as written, so they can be pasted).
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    const quick = /## Quick start[\s\S]*?```sh\n([\s\S]*?)```/.exec(readme)![1]!;
    expect(quick.split("\n").filter((l) => l && !l.startsWith("#"))).toEqual(installCommands("agave", x64));
    const requirements = /## Requirements[\s\S]*?```sh\n([\s\S]*?)```/.exec(readme)![1]!;
    expect(
      requirements
        .split("\n")
        .map((l) => l.trim().replace(/ {3}#.*$/, ""))
        .filter(Boolean),
    ).toEqual([...LINUX_ARM64_INSTALL]);
    const troubleshooting = readFileSync(path.join(ROOT, "docs/troubleshooting.md"), "utf8");
    for (const c of installCommands("agave", x64)) expect(troubleshooting).toContain(c);
    const arm64Docs = /## Linux arm64[\s\S]*?```sh\n([\s\S]*?)```/.exec(troubleshooting)![1]!;
    expect(
      arm64Docs
        .split("\n")
        .map((l) => l.trim().replace(/ {3}#.*$/, ""))
        .filter(Boolean),
    ).toEqual([...LINUX_ARM64_INSTALL]);
  });

  it("doctor ends with what is ready and what the warnings are about", () => {
    const row = (what: string, ok: boolean, optional = false) => ({ what, ok, optional, detail: "" });
    const base = [row("Node.js", true), row("platform-tools", true), row("toolchain", true)];
    expect(doctorSummary([...base, row("Solana CLI", true), row("keypair", true), row("RPC", true)])).toBe("Ready to build, test and deploy.");
    expect(doctorSummary([...base, row("docker", false, true), row("keypair", false, true), row("RPC", false, true)])).toBe(
      "Ready to build and test. The ! rows: deploying still needs: keypair, RPC; Docker is only for --docker builds.",
    );
    expect(doctorSummary([row("Node.js", false), row("platform-tools", false)])).toBe(
      "Not ready to build or test: fix the ERR rows (Node.js, platform-tools) first.",
    );
  });

  it("doctor on this machine: everything building needs is there (exit 0), and the RPC's balance is read", async () => {
    const dir = tmp();
    const home = tmp();
    mkdirSync(path.join(home, ".config/solana"), { recursive: true });
    // A throwaway keypair (64 bytes) as the CLI's default payer.
    writeFileSync(path.join(home, ".config/solana/id.json"), JSON.stringify(Array.from({ length: 64 }, (_, i) => i + 1)));
    balance = 0;
    const doctor = await run(["doctor", "--url", rpcUrl], dir, { HOME: home });
    expect(doctor.stdout).toMatch(/ok {3}RPC +127\.0\.0\.1:\d+ \(solana-core 3\.1\.10\)/);
    expect(doctor.stdout).toMatch(/! {3}balance +0 SOL on 127\.0\.0\.1:\d+\n.*solana airdrop 2 --url localhost/);
  });

  it("deploy stops before any transaction when the RPC does not answer, or the payer cannot pay", async () => {
    const dir = tmp();
    expect((await run(["init", ".", "--name", "counter"], dir)).status).toBe(0);
    const payer = path.join(dir, "payer.json");
    writeFileSync(payer, JSON.stringify(Array.from({ length: 64 }, (_, i) => 64 - i)));

    // A port nothing listens on: open one, note it, close it.
    const closed = await new Promise<number>((r) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => r(port));
      });
    });
    const down = await run(["deploy", "--url", `http://127.0.0.1:${closed}`, "--keypair", payer], dir);
    expect(down.status).toBe(1);
    expect(down.stderr).toMatch(/cannot reach 127\.0\.0\.1:\d+ \(ECONNREFUSED\)\. Start a local validator .*solana-test-validator/);

    balance = 1_000;
    const poor = await run(["deploy", "--url", rpcUrl, "--keypair", payer], dir);
    expect(poor.status).toBe(1);
    // A first deploy: twice the rent (100_000_000 from the fake RPC) plus fees.
    expect(poor.stderr).toMatch(/the payer \w+ has 1000 lamports on 127\.0\.0\.1:\d+; deploying needs about 0\.21 SOL .*solana airdrop 2 \w+ --url localhost/);
  });

  it("deploy refuses to pick a cluster itself, says which cluster and payer before sending; --config must exist", async () => {
    const dir = tmp();
    expect((await run(["init", ".", "--name", "counter"], dir)).status).toBe(0);
    const payer = path.join(dir, "payer.json");
    writeFileSync(payer, JSON.stringify(Array.from({ length: 64 }, (_, i) => 64 - i)));
    // No --url and no Solana CLI config: `solana program deploy` would go to its default (mainnet-beta).
    const none = await run(["deploy", "--keypair", payer], dir, { HOME: tmp() });
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/no cluster: pass --url/);
    expect(existsSync(path.join(dir, "target"))).toBe(false); // refused before building
    for (const args of [
      ["deploy", "--dry-run", "--config", "nope.yml"],
      ["doctor", "--config", "nope.yml"],
    ]) {
      const r = await run(args, dir);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toMatch(/nope\.yml does not exist/);
    }
    // The preflight passes; the cluster and payer are printed before `solana` runs (a fake one here, which records its
    // arguments).
    balance = 10_000_000_000;
    const solana = fakeSolana();
    const go = await run(["deploy", "--url", rpcUrl, "--keypair", payer], dir, { PATH: solana.path });
    expect(go.status, go.stderr).toBe(0);
    expect(go.stdout).toMatch(/cluster 127\.0\.0\.1:\d+, payer [1-9A-HJ-NP-Za-km-z]{32,44}\n/);
    expect(solana.calls().at(-1)).toContain(`--keypair ${payer}`);

    // No payer keypair: deploy stops before building, the RPC and `solana`, with the command that creates one.
    const keyless = await run(["deploy", "--url", "devnet"], dir, { HOME: tmp(), PATH: fakeSolana().path });
    expect(keyless.status).toBe(1);
    expect(keyless.stderr).toBe(
      "error: no payer keypair at ~/.config/solana/id.json: create one with `solana-keygen new` (or pass --keypair <file>), then fund it with `solana airdrop 2 --url devnet`. Nothing was sent.\n",
    );
    expect(keyless.stdout).not.toContain("deploying");
  });

  it("deploy's payer: a signer URI goes to the Solana CLI as given, a file must exist, and `solana` must be on PATH first", async () => {
    const dir = tmp();
    expect((await run(["init", ".", "--name", "counter"], dir)).status).toBe(0);
    const target = path.join(dir, "target");
    for (const uri of ["usb://ledger?key=0", "prompt://", "stdin://", "ASK", "-", "file:///x/id.json"]) expect(isSignerUri(uri), uri).toBe(true);
    for (const file of ["id.json", "./id.json", "/home/u/.config/solana/id.json", "~/.config/solana/id.json", "C:\\keys\\id.json"])
      expect(isSignerUri(file), file).toBe(false);

    // `solana` missing: that is said first, even with a missing payer, and nothing is built.
    const noCli = await run(["deploy", "--url", rpcUrl, "--keypair", path.join(dir, "missing.json")], dir, {
      PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
    });
    expect(noCli.status).toBe(1);
    expect(noCli.stderr).toMatch(/^error: `solana` was not found on PATH/);
    expect(existsSync(target)).toBe(false);

    // A missing --keypair file: the message names it, and says nothing about the default keypair or an airdrop.
    const missing = await run(["deploy", "--url", "devnet", "--keypair", "./missing.json"], dir, { PATH: fakeSolana().path });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("error: no keypair file at ./missing.json (given with --keypair): check the path. Nothing was sent.\n");
    expect(existsSync(target)).toBe(false);

    // keypair_path of a --config file, missing: named, with the config it comes from.
    const config = path.join(dir, "config.yml");
    const configKey = path.join(dir, "config-payer.json");
    writeFileSync(config, `json_rpc_url: "${rpcUrl}"\nkeypair_path: ${configKey}\n`);
    const noConfigKey = await run(["deploy", "--config", config], dir, { PATH: fakeSolana().path });
    expect(noConfigKey.status).toBe(1);
    expect(noConfigKey.stderr).toBe(
      `error: no payer keypair at ${configKey} (keypair_path in ${config}): create it with \`solana-keygen new --outfile ${configKey}\`, or pass --keypair <file>; fund it with \`solana airdrop 2 --keypair ${configKey} --url localhost\`. Nothing was sent.\n`,
    );
    expect(existsSync(target)).toBe(false);

    // keypair_path of a --config file, present: the preflight reads it, and `solana` gets the config.
    writeFileSync(configKey, JSON.stringify(Array.from({ length: 64 }, (_, i) => 64 - i)));
    balance = 10_000_000_000;
    const viaConfig = fakeSolana();
    const fromConfig = await run(["deploy", "--config", config], dir, { PATH: viaConfig.path });
    expect(fromConfig.status, fromConfig.stderr).toBe(0);
    expect(fromConfig.stdout).toMatch(/cluster 127\.0\.0\.1:\d+, payer [1-9A-HJ-NP-Za-km-z]{32,44}\n/);
    expect(viaConfig.calls().at(-1)).toMatch(new RegExp(`^-C ${config} program deploy `));

    // A signer URI: not a file, no balance to read here; it goes to `solana program deploy` as given.
    balance = 0; // a file payer would be refused for this; a Ledger's balance is the Solana CLI's to check
    const ledger = fakeSolana();
    const usb = await run(["deploy", "--url", rpcUrl, "--keypair", "usb://ledger?key=0"], dir, { PATH: ledger.path });
    expect(usb.status, usb.stderr).toBe(0);
    expect(usb.stdout).toContain("payer usb://ledger?key=0 (a signer the Solana CLI resolves)");
    expect(ledger.calls().at(-1)).toMatch(/ --keypair usb:\/\/ledger\?key=0$/);
    // keypair_path: ASK in a config file, as `solana-keygen` documents for a prompted keypair.
    writeFileSync(config, `json_rpc_url: "${rpcUrl}"\nkeypair_path: ASK\n`);
    const ask = await run(["deploy", "--config", config], dir, { PATH: fakeSolana().path });
    expect(ask.status, ask.stderr).toBe(0);
    expect(ask.stdout).toContain("payer ASK (a signer the Solana CLI resolves)");
  });
});

describe("kit-based commands: RPC failures name the host and the cause, and time out", () => {
  const PROGRAM = "11111111111111111111111111111112";
  let closedUrl = "";
  let hanging: Server;
  let hangingUrl = "";
  beforeAll(async () => {
    const port = await new Promise<number>((r) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => r(p));
      });
    });
    // A path that stands for an API key: it must not be printed.
    closedUrl = `http://127.0.0.1:${port}/secret-api-key`;
    hanging = createServer(() => {}); // accepts, never answers
    await new Promise<void>((r) => hanging.listen(0, "127.0.0.1", r));
    hangingUrl = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}/secret-api-key`;
  });
  afterAll(() => hanging.closeAllConnections?.() ?? hanging.close());

  it("clone, client --address, verify and idl publish", async () => {
    const dir = tmp();
    expect((await run(["init", ".", "--name", "counter"], dir)).status).toBe(0);
    const payer = path.join(dir, "payer.json");
    loadOrCreateKeypair(payer); // a fresh throwaway key: idl publish checks it is a real keypair before any request
    const commands = [
      ["clone", PROGRAM, "--url", closedUrl, "--out", "accounts"],
      ["client", "--address", PROGRAM, "--url", closedUrl],
      ["verify", "programs/counter.ts", "--address", PROGRAM, "--url", closedUrl],
      ["idl", "publish", "--url", closedUrl, "--keypair", payer],
    ];
    for (const args of commands) {
      const r = await run(args, dir);
      expect(r.status, args[0]).toBe(1);
      expect(r.stderr, args[0]).toMatch(/cannot reach 127\.0\.0\.1:\d+ \(ECONNREFUSED\): check --url/);
      expect(r.stderr + r.stdout, args[0]).not.toContain("secret-api-key");
    }
    const publish = await run(commands[3]!, dir);
    expect(publish.stdout).toMatch(/cluster 127\.0\.0\.1:\d+, payer [1-9A-HJ-NP-Za-km-z]{32,44}/);
    const slow = await run(["clone", PROGRAM, "--url", hangingUrl, "--out", "accounts"], dir, { TYPESOL_RPC_TIMEOUT: "1" });
    expect(slow.status).toBe(1);
    expect(slow.stderr).toMatch(/cannot reach 127\.0\.0\.1:\d+ \(no answer in 1 s\)/);
  }, 60_000);
});
