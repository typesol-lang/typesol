// `build --docker` and `verify --docker`. Without Docker: the Dockerfile pins every input, the package ships it and
// the release records, the TypeSOL version is chosen as documented, and a missing Docker, a stopped daemon or a failed
// image build is an error that builds nothing (never a local build instead), shown with fake `docker` commands.
// With Docker (TYPESOL_DOCKER_TESTS=1, kept out of the normal suite and CI: the first image build downloads about
// 750 MB and takes minutes): counter built in the container and locally gives the same bytes, and `verify --docker`
// matches a .so and rejects a changed one.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPILER_VERSION, TESTED_TOOLCHAIN } from "../../src/compiler/index.ts";
import { dockerCheck } from "../../src/tools/doctor.ts";
import { chooseTypesolVersion, DOCKER_PLATFORM, dockerfileInputs, dockerStatus, ensureImage, recordedVersions, releaseRecord } from "../../src/tools/docker.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "dist/cli.js");
const DOCKERFILE = readFileSync(path.join(ROOT, "docker/Dockerfile"), "utf8");
const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "typesol-docker-")));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const sha256 = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const counter = () => {
  const dir = tmp();
  copyFileSync(path.join(ROOT, "examples/counter.ts"), path.join(dir, "counter.ts"));
  return dir;
};

/** A directory holding only a `docker` script with this body: PATH set to it stands for a machine with that docker. */
function fakeDocker(body: string): string {
  const dir = tmp();
  writeFileSync(path.join(dir, "docker"), `#!/bin/sh\n${body}\n`);
  chmodSync(path.join(dir, "docker"), 0o755);
  return dir;
}

describe("the build container's recipe", () => {
  it("pins every input: base images by linux/amd64 digest, release files by sha256, the tested toolchain", () => {
    const froms = [...DOCKERFILE.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);
    const stages = new Set([...DOCKERFILE.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((m) => m[1]!));
    for (const f of froms) expect(stages.has(f) || /@sha256:[0-9a-f]{64}$/.test(f), f).toBe(true);
    const { base, downloads } = dockerfileInputs(DOCKERFILE);
    expect(base).toEqual([expect.stringMatching(/^busybox:[\d.]+-glibc@sha256:/), expect.stringMatching(/^node:24\.\d+\.\d+-bookworm-slim@sha256:/)]);
    expect(downloads.map((d) => d.url)).toEqual([
      `https://github.com/anza-xyz/agave/releases/download/v${TESTED_TOOLCHAIN.agave}/solana-release-x86_64-unknown-linux-gnu.tar.bz2`,
      `https://github.com/anza-xyz/platform-tools/releases/download/${TESTED_TOOLCHAIN.platformTools}/platform-tools-linux-x86_64.tar.bz2`,
    ]);
    // Every download is checksummed, and nothing is fetched unpinned (no package manager, no curl).
    expect(DOCKERFILE.match(/^ADD\s/gm)?.length).toBe(downloads.length);
    expect(DOCKERFILE).not.toMatch(/apt-get|apk add|curl |wget /);
    expect(DOCKERFILE).toContain(`platform-tools-${TESTED_TOOLCHAIN.platformTools}.md`);
    expect(DOCKER_PLATFORM).toBe("linux/amd64");
    expect(DOCKERFILE).toMatch(/^USER node$/m);
  });

  it("ships with the package, with the release records the tarball is checked against", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toEqual(expect.arrayContaining(["docker", "releases"]));
    expect(recordedVersions()).toEqual(expect.arrayContaining(["0.43.0", "0.44.0"]));
    expect(releaseRecord("0.44.0").record.tarball.shasum).toBe("76ad162bd7d31e80ba8ada0a5a712df5420b6bde");
    expect(() => releaseRecord("0.42.0")).toThrow(/no release record for TypeSOL 0\.42\.0[\s\S]*--release-record <file>[\s\S]*before 0\.43\.0 have no record/);
    const wrong = path.join(tmp(), "r.json");
    copyFileSync(path.join(ROOT, "releases/0.43.0.json"), wrong);
    expect(() => releaseRecord("0.44.0", wrong)).toThrow(/is not the release record of TypeSOL 0\.44\.0/);
    expect(releaseRecord("0.43.0", wrong).path).toBe(wrong);
  });

  it("chooses the TypeSOL version: --typesol-version, the deployed build's, this one; a project that installs another is an error", () => {
    expect(chooseTypesolVersion({ given: "0.43.0", cliVersion: "0.44.0" })).toEqual({ version: "0.43.0", why: "--typesol-version" });
    expect(() => chooseTypesolVersion({ given: "latest", cliVersion: "0.44.0" })).toThrow(/not a version/);
    expect(chooseTypesolVersion({ deployed: { version: "0.43.0", from: "x.build.json" }, cliVersion: "0.44.0" }).version).toBe("0.43.0");
    const project = tmp();
    expect(chooseTypesolVersion({ projectRoot: project, cliVersion: "0.44.0" })).toEqual({ version: "0.44.0", why: "this typesol" });
    mkdirSync(path.join(project, "node_modules/typesol"), { recursive: true });
    writeFileSync(path.join(project, "node_modules/typesol/package.json"), '{"version":"0.43.0"}');
    expect(() => chooseTypesolVersion({ projectRoot: project, cliVersion: "0.44.0" })).toThrow(
      /installs typesol 0\.43\.0 \(node_modules\/typesol\), but this is typesol 0\.44\.0.*--typesol-version 0\.43\.0/,
    );
    expect(chooseTypesolVersion({ projectRoot: project, given: "0.44.0", cliVersion: "0.44.0" }).version).toBe("0.44.0");
  });
});

describe("--docker without a working Docker", () => {
  it("is an error that builds nothing: docker missing, its daemon stopped, the image build failing", () => {
    const missing = run(["build", "counter.ts", "--docker"], counter(), { PATH: tmp() });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/--docker needs Docker: docker is not installed \(not on PATH\)\. install Docker: .*Nothing was built\./);

    const stopped = fakeDocker('echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1');
    const dir = counter();
    const down = run(["build", "counter.ts", "--docker"], dir, { PATH: stopped });
    expect(down.status).toBe(1);
    expect(down.stderr).toMatch(/the Docker daemon is not running or not reachable \(Cannot connect to the Docker daemon/);
    expect(existsSync(path.join(dir, "target"))).toBe(false); // no local build in its place, not even a keypair

    const failing = fakeDocker('case "$1" in version) echo "29.0.0 linux/amd64";; image) exit 1;; build) echo "pull failed" >&2; exit 17;; esac');
    const broken = run(["build", "counter.ts", "--docker"], dir, { PATH: failing });
    expect(broken.status).toBe(1);
    expect(broken.stderr).toMatch(/building typesol-build:\d+\.\d+\.\d+-[0-9a-f]{12} \(linux\/amd64\)/);
    expect(broken.stderr).toMatch(/docker build of typesol-build:.* failed \(exit 17; .*never falls back to the local toolchain/);
    expect(existsSync(path.join(dir, "target/counter.so"))).toBe(false);

    const verify = run(["verify", "counter.ts", "nothing.so", "--docker"], dir, { PATH: tmp() });
    expect(verify.status).toBe(2); // the .so is checked first
    writeFileSync(path.join(dir, "deployed.so"), "x");
    expect(run(["verify", "counter.ts", "deployed.so", "--docker"], dir, { PATH: tmp() }).stderr).toMatch(/--docker needs Docker/);
  });

  it("--typesol-version and --release-record need --docker; doctor has an optional docker row", () => {
    const dir = counter();
    const r = run(["build", "counter.ts", "--typesol-version", "0.44.0"], dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--typesol-version applies to container builds: add --docker/);
    expect(dockerCheck({ ok: false, reason: "docker is not installed (not on PATH)", fix: "install Docker" })).toMatchObject({
      ok: false,
      optional: true,
      what: "docker",
      detail: "docker is not installed (not on PATH); needed only for --docker builds",
    });
    expect(dockerCheck({ ok: true, version: "29.0.0", platform: "linux/arm64" }).detail).toBe(
      "29.0.0 (linux/arm64): --docker builds run in linux/amd64, emulated here",
    );
  });
});

// Opt-in: the image build needs the network the first time, and an emulated linux/amd64 on arm64 machines.
const wanted = process.env.TYPESOL_DOCKER_TESTS === "1";
const docker = wanted ? dockerStatus() : undefined;
const reason = !wanted ? "set TYPESOL_DOCKER_TESTS=1 to run" : docker && !docker.ok ? `Docker is unavailable: ${docker.reason}` : "";
// The container holds a released TypeSOL; the local side compares only when this checkout is that release.
const version = recordedVersions().includes(COMPILER_VERSION) ? COMPILER_VERSION : recordedVersions().at(-1)!;

describe.skipIf(!!reason)(`with Docker${reason ? ` (skipped: ${reason})` : ""}`, () => {
  beforeAll(() => {
    ensureImage(version); // built once (minutes), reused after
  }, 3_600_000);

  it("builds counter in the container to the bytes a local build gives, and records the container", () => {
    const dir = counter();
    const r = run(["build", "counter.ts", "--docker", "--typesol-version", version, "--out", "docker", "--quiet"], dir);
    expect(r.stderr).not.toMatch(/error/i);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/built in {2}linux\/amd64 container typesol-build:/);
    const manifest = JSON.parse(readFileSync(path.join(dir, "docker/counter.build.json"), "utf8"));
    expect(manifest).toMatchObject({
      compiler: version,
      clang: TESTED_TOOLCHAIN.clang,
      platformTools: TESTED_TOOLCHAIN.platformTools,
      host: { os: "linux", arch: "x64" },
      container: { platform: "linux/amd64", typesol: { version, shasum: releaseRecord(version).record.tarball.shasum } },
    });
    expect(manifest.container.dockerfile).toBe(createHash("sha256").update(DOCKERFILE).digest("hex"));
    expect(manifest.binary).toBe(sha256(path.join(dir, "docker/counter.so")));
    for (const f of ["counter.c", "counter.json", "counter.client.ts"]) expect(existsSync(path.join(dir, "docker", f)), f).toBe(true);
    if (version !== COMPILER_VERSION) return;
    // Counter links nothing host-specific (docs/stability.md): the local toolchain gives the same bytes, C and IDL.
    expect(run(["build", "counter.ts", "--out", "local", "--program-id", "docker/counter-keypair.json", "--quiet"], dir).status).toBe(0);
    for (const f of ["counter.so", "counter.c", "counter.json"]) expect(sha256(path.join(dir, "local", f)), f).toBe(sha256(path.join(dir, "docker", f)));
  });

  it("verify --docker matches a .so, says what was verified, and rejects a changed one", () => {
    const dir = counter();
    expect(run(["build", "counter.ts", "--docker", "--typesol-version", version, "--quiet"], dir).status).toBe(0);
    copyFileSync(path.join(dir, "target/counter.so"), path.join(dir, "deployed.so"));
    copyFileSync(path.join(dir, "target/counter.build.json"), path.join(dir, "deployed.build.json"));
    const ok = run(["verify", "counter.ts", "deployed.so", "--docker"], dir);
    expect(ok.status).toBe(0);
    // The version comes from the deployed build's manifest.
    expect(ok.stderr).toContain(`TypeSOL ${version} (the deployed build's manifest, deployed.build.json)`);
    expect(ok.stdout).toMatch(
      / {2}match {5}[0-9a-f]{64} \(sbpf v0\)\n {2}verified {2}deployed\.so is what counter\.ts builds to in the pinned build container:/,
    );
    expect(ok.stdout).toMatch(/ {4}container {2}linux\/amd64, Dockerfile sha256 [0-9a-f]{64}, local image sha256:/);
    expect(ok.stdout).toContain(`    repeat     typesol verify counter.ts deployed.so --docker --typesol-version ${version}`);

    const so = readFileSync(path.join(dir, "deployed.so"));
    so[0x200] ^= 0xff;
    writeFileSync(path.join(dir, "changed.so"), so);
    const bad = run(["verify", "counter.ts", "changed.so", "--docker", "--typesol-version", version], dir);
    expect(bad.status).toBe(3);
    expect(bad.stdout).toMatch(/MISMATCH {2}changed\.so is not what counter\.ts builds to/);
    expect(bad.stdout).toMatch(/rebuilt {3}clang 20\.1\.7-rust-dev .*, linux-x64, TypeSOL .*, in the build container \(Dockerfile [0-9a-f]{12}…\)/);
  });
});
