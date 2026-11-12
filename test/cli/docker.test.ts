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
import {
  chooseTypesolVersion,
  containerUser,
  dependencyLock,
  DOCKER_PLATFORM,
  dockerfileInputs,
  dockerStatus,
  ensureImage,
  findReleaseRecord,
  type FetchText,
  imageLabels,
  lockedVersions,
  recordedVersions,
  RELEASES_URL,
  releaseRecord,
  repeatCommand,
} from "../../src/tools/docker.ts";
import { lockProblems } from "../../scripts/release-check.ts";

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
    // Every download is checksummed, and nothing is fetched unpinned: no system package manager or curl, and npm only
    // as `npm pack` (the tarball, checked against the release record) and `npm ci` (from the lock, which checks every
    // package's integrity); never `npm install`, `npm i`, `npx` or another package manager.
    expect(DOCKERFILE.match(/^ADD\s/gm)?.length).toBe(downloads.length);
    const commands = DOCKERFILE.split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(commands).not.toMatch(/apt-get|apk add|curl |wget /);
    expect(commands).not.toMatch(/\bnpx\b|\byarn\b|\bpnpm\b|\bcorepack\b/);
    expect([...new Set([...commands.matchAll(/(?:^RUN\s+|&&\s*)npm\s+([a-z-]+)/gm)].map((m) => m[1]))].sort()).toEqual(["ci", "pack"]);
    expect(commands).toMatch(/install-deps\.mjs [^\n]*\n\s*&& cd \/opt\/typesol \\\n\s*&& npm ci --omit=peer --omit=optional --ignore-scripts /);
    expect(commands).toMatch(/^COPY release\.json deps\.lock\.json \/opt\/typesol\/ctx\/$/m);
    expect(DOCKERFILE).toContain(`platform-tools-${TESTED_TOOLCHAIN.platformTools}.md`);
    expect(DOCKER_PLATFORM).toBe("linux/amd64");
    expect(DOCKERFILE).toMatch(/^USER node$/m);
  });

  it("ships with the package, with the release records the tarball is checked against", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toEqual(expect.arrayContaining(["docker", "releases"]));
    expect(recordedVersions()).toEqual(expect.arrayContaining(["0.43.0", "0.44.0"]));
    // Every recorded version has its dependency lock, installable as the image installs it.
    expect(lockedVersions().sort()).toEqual(expect.arrayContaining(recordedVersions()));
    for (const v of recordedVersions()) {
      const text = readFileSync(path.join(ROOT, `docker/deps/${v}.lock.json`), "utf8");
      const deps = (JSON.parse(text) as { packages: Record<string, { dependencies?: Record<string, string> }> }).packages[""]!.dependencies!;
      expect(deps.typescript, v).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lockProblems(text, deps), v).toEqual([]);
    }
    const own = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
    if (lockedVersions().includes(own.version))
      expect(lockProblems(readFileSync(path.join(ROOT, `docker/deps/${own.version}.lock.json`), "utf8"), own.dependencies)).toEqual([]);
    // A record needs its commit, as every field the image is labelled with.
    const noCommit = path.join(tmp(), "nocommit.json");
    const { commit: _c, ...rest } = JSON.parse(readFileSync(path.join(ROOT, "releases/0.44.0.json"), "utf8"));
    writeFileSync(noCommit, JSON.stringify(rest));
    expect(() => releaseRecord("0.44.0", noCommit)).toThrow(/version, commit, tarball\.shasum, tarball\.integrity and files are required/);
    expect(releaseRecord("0.44.0").record.tarball.shasum).toBe("76ad162bd7d31e80ba8ada0a5a712df5420b6bde");
    expect(() => releaseRecord("0.42.0")).toThrow(/no release record for TypeSOL 0\.42\.0[\s\S]*--release-record <file>[\s\S]*before 0\.43\.0 have no record/);
    const wrong = path.join(tmp(), "r.json");
    copyFileSync(path.join(ROOT, "releases/0.43.0.json"), wrong);
    expect(() => releaseRecord("0.44.0", wrong)).toThrow(/is not the release record of TypeSOL 0\.44\.0/);
    expect(releaseRecord("0.43.0", wrong).source).toMatchObject({ kind: "file", location: wrong });
  });

  it("finds a newer release's record on the repository's main branch, with where it came from; offline or absent names --release-record", async () => {
    // The fetch is the test's: no network. A release newer than this package: its record is committed after publishing.
    const shipped = readFileSync(path.join(ROOT, "releases/0.44.1.json"), "utf8");
    const newer = shipped.replaceAll('"version": "0.44.1"', '"version": "9.9.9"');
    const asked: string[] = [];
    const serve =
      (status: number, body: string | Buffer = ""): FetchText =>
      async (url) => {
        asked.push(url);
        const bytes = Buffer.from(body);
        return { ok: status === 200, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer };
      };
    const logged: string[] = [];
    const found = await findReleaseRecord("9.9.9", { fetch: serve(200, newer), log: (s) => logged.push(s) });
    expect(asked).toEqual([`${RELEASES_URL}/9.9.9.json`]);
    expect(RELEASES_URL).toBe("https://raw.githubusercontent.com/typesol-lang/typesol/main/releases");
    expect(found.record.version).toBe("9.9.9");
    expect(found.bytes.toString("utf8")).toBe(newer);
    expect(found.source).toEqual({ kind: "repository", location: `${RELEASES_URL}/9.9.9.json`, sha256: createHash("sha256").update(newer).digest("hex") });
    expect(logged.join("\n")).toContain(`releases/9.9.9.json from ${RELEASES_URL}/9.9.9.json (sha256 ${found.source.sha256})`);
    // The sha256 is of the bytes served (what sha256sum gives), also when they are not valid UTF-8.
    const marked = Buffer.from(newer.replace('"version": "9.9.9"', '"note": "@@", "version": "9.9.9"'));
    const at = marked.indexOf("@@");
    const odd = Buffer.concat([marked.subarray(0, at), Buffer.from([0xff]), marked.subarray(at + 2)]);
    const raw = await findReleaseRecord("9.9.9", { fetch: serve(200, odd), log: () => {} });
    expect(raw.source.sha256).toBe(createHash("sha256").update(odd).digest("hex"));
    expect(raw.source.sha256).not.toBe(createHash("sha256").update(odd.toString("utf8")).digest("hex"));

    // The package's own record, or the file given, is used as it is: nothing fetched.
    asked.length = 0;
    const own = await findReleaseRecord("0.44.1", { fetch: serve(500) });
    expect(own.source).toEqual({ kind: "package", location: "releases/0.44.1.json", sha256: createHash("sha256").update(shipped).digest("hex") });
    const file = path.join(tmp(), "9.9.9.json");
    writeFileSync(file, newer);
    expect((await findReleaseRecord("9.9.9", { file, fetch: serve(500) })).source).toMatchObject({ kind: "file", location: file });
    await expect(findReleaseRecord("0.42.0", { fetch: serve(200, newer) })).rejects.toThrow(/before 0\.43\.0 have no record/);
    await expect(findReleaseRecord("../../x", { fetch: serve(200, newer) })).rejects.toThrow(/not a TypeSOL version/);
    expect(asked).toEqual([]);

    // Absent, offline, a server error, another version's record: errors that name --release-record or say what is wrong.
    await expect(findReleaseRecord("9.9.9", { fetch: serve(404) })).rejects.toThrow(
      /main branch has none \(.*9\.9\.9\.json: HTTP 404\)[\s\S]*--release-record <file>/,
    );
    const offline: FetchText = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(findReleaseRecord("9.9.9", { fetch: offline })).rejects.toThrow(
      /could not fetch the release record of TypeSOL 9\.9\.9 .*\(fetch failed; offline\?\)[\s\S]*--release-record <file>/,
    );
    await expect(findReleaseRecord("9.9.9", { fetch: serve(503) })).rejects.toThrow(/HTTP 503\): pass the record with --release-record <file>/);
    await expect(findReleaseRecord("9.9.9", { fetch: serve(200, shipped) })).rejects.toThrow(/is not the release record of TypeSOL 9\.9\.9/);
    await expect(findReleaseRecord("9.9.9", { fetch: serve(200, "<html>") })).rejects.toThrow(/not valid JSON/);
  });

  it("records the release record's origin and the dependency lock; a cached image must carry every checked value", () => {
    const shipped = readFileSync(path.join(ROOT, "releases/0.44.1.json"));
    const { record } = releaseRecord("0.44.1");
    const lock = dependencyLock(record).lock;
    expect(lock).toEqual({
      path: "docker/deps/0.44.1.lock.json",
      sha256: sha256(path.join(ROOT, "docker/deps/0.44.1.lock.json")),
      source: "package",
    });
    const labels = imageLabels(createHash("sha256").update(DOCKERFILE).digest("hex"), record, lock.sha256);
    // A docker that has the image already (version, inspect): ensureImage builds nothing and reports the identity.
    const cached = (l: Record<string, string>) =>
      fakeDocker(`case "$1" in version) echo "29.0.0 linux/amd64";; image) echo 'sha256:feed linux/amd64 ${JSON.stringify(l)}';; *) exit 9;; esac`);
    const saved = process.env.PATH;
    try {
      process.env.PATH = `${cached(labels)}${path.delimiter}${saved}`;
      const source = { kind: "repository" as const, location: `${RELEASES_URL}/0.44.1.json`, sha256: "ab".repeat(32) };
      const image = ensureImage("0.44.1", { record, bytes: shipped, source }, () => {});
      expect(image.identity.image).toBe("sha256:feed");
      expect(image.identity.typesol).toMatchObject({ version: "0.44.1", commit: record.commit, record: source });
      expect(image.identity.deps).toEqual(lock);
      expect(ensureImage("0.44.1", undefined, () => {}).identity.typesol.record).toMatchObject({ kind: "package", location: "releases/0.44.1.json" });
      // The same tag built from a record with the same integrity but another shasum, commit or file list, or another
      // lock: refused, with what differs, instead of reporting this record's values for it.
      for (const key of ["org.typesol.release.shasum", "org.typesol.release.commit", "org.typesol.release.files", "org.typesol.deps.sha256"]) {
        process.env.PATH = `${cached({ ...labels, [key]: "other" })}${path.delimiter}${saved}`;
        expect(() => ensureImage("0.44.1", undefined, () => {}), key).toThrow(
          new RegExp(`was not built from this release record and dependency lock \\(${key.replaceAll(".", "\\.")}: the image has other, .*docker image rm`),
        );
      }
      // A version newer than this package: the lock is the one its tarball holds, by the record's sha256 of it.
      const newer = { ...record, version: "9.9.9", files: [...record.files, { path: "docker/deps/9.9.9.lock.json", sha256: "c".repeat(64) }] };
      expect(dependencyLock(newer).lock).toEqual({ path: "docker/deps/9.9.9.lock.json", sha256: "c".repeat(64), source: "tarball" });
      expect(() => dependencyLock({ ...record, version: "9.9.9" })).toThrow(/no dependency lock for TypeSOL 9\.9\.9/);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("checks the TypeSOL tarball and the dependency lock as the image build does (its scripts, without Docker)", () => {
    const script = (name: string) => {
      const m = new RegExp(`COPY <<'EOF' /opt/typesol/${name.replace(".", "\\.")}\\n([\\s\\S]*?)\\nEOF\\n`).exec(DOCKERFILE);
      const file = path.join(tmp(), name);
      writeFileSync(file, m![1]!);
      return file;
    };
    const check = script("check-tarball.mjs");
    const install = script("install-deps.mjs");
    const node = (file: string, args: string[]) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8" });
    // A package of two files, packed as npm does (package/…), and its record.
    const work = tmp();
    mkdirSync(path.join(work, "package/dist"), { recursive: true });
    const lockText = readFileSync(path.join(ROOT, "docker/deps/0.44.1.lock.json"), "utf8");
    const deps = (JSON.parse(lockText) as { packages: Record<string, { dependencies: Record<string, string> }> }).packages[""]!.dependencies;
    writeFileSync(path.join(work, "package/package.json"), JSON.stringify({ name: "@typesol/cli", version: "1.0.0", dependencies: deps }));
    writeFileSync(path.join(work, "package/dist/cli.js"), "console.log(1)\n");
    const tgz = path.join(work, "p.tgz");
    expect(spawnSync("tar", ["-czf", tgz, "-C", work, "package"]).status).toBe(0);
    const data = readFileSync(tgz);
    const files = ["dist/cli.js", "package.json"].map((f) => ({ path: f, sha256: sha256(path.join(work, "package", f)) }));
    const rec = {
      version: "1.0.0",
      commit: "a".repeat(40),
      tarball: { integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`, shasum: createHash("sha1").update(data).digest("hex") },
      files,
    };
    const recFile = path.join(work, "release.json");
    const unpacked = path.join(work, "package");
    const checkWith = (r: object, t = tgz) => {
      writeFileSync(recFile, JSON.stringify(r));
      return node(check, [recFile, t, unpacked, "1.0.0"]);
    };
    const ok = checkWith(rec);
    expect(ok.stderr).toBe("");
    expect(ok.stdout).toContain("2 files as recorded");
    const tampered = path.join(work, "t.tgz");
    writeFileSync(tampered, Buffer.concat([data, Buffer.from([0])]));
    expect(checkWith(rec, tampered).stderr).toMatch(/typesol tarball check: integrity sha512-.*, the record has/);
    expect(checkWith({ ...rec, tarball: { ...rec.tarball, shasum: "0".repeat(40) } }).stderr).toMatch(/shasum [0-9a-f]{40}, the record has 0{40}/);
    expect(checkWith({ ...rec, files: [{ ...files[0]!, sha256: "0".repeat(64) }, files[1]] }).stderr).toMatch(
      /dist\/cli\.js: sha256 [0-9a-f]{64}, the record has 0{64}/,
    );
    writeFileSync(path.join(unpacked, "extra.js"), "x");
    expect(checkWith(rec).stderr).toMatch(/the tarball has 3 files, the record 2/);
    expect(checkWith(rec).status).toBe(1);
    rmSync(path.join(unpacked, "extra.js"));

    // The lock: from the build context or the tarball (the same bytes when both), for the dependencies the package
    // declares, every package from the registry with an integrity.
    const out = tmp();
    const ctx = path.join(work, "deps.lock.json");
    const installWith = (context: string, inTarball?: string) => {
      writeFileSync(ctx, context);
      rmSync(path.join(unpacked, "docker"), { recursive: true, force: true });
      if (inTarball !== undefined) {
        mkdirSync(path.join(unpacked, "docker/deps"), { recursive: true });
        writeFileSync(path.join(unpacked, "docker/deps/1.0.0.lock.json"), inTarball);
      }
      return node(install, [ctx, unpacked, "1.0.0", out]);
    };
    const good = installWith(lockText);
    expect(good.stderr).toBe("");
    expect(good.stdout).toMatch(/docker\/deps\/1\.0\.0\.lock\.json \(the package's\), \d+ packages, each with its integrity/);
    expect(readFileSync(path.join(out, "package-lock.json"), "utf8")).toBe(lockText);
    expect(JSON.parse(readFileSync(path.join(out, "package.json"), "utf8"))).toMatchObject({ name: "typesol-build-deps", dependencies: deps });
    expect(installWith("", lockText).stdout).toContain("(the tarball's)");
    expect(installWith("").stderr).toMatch(/no docker\/deps\/1\.0\.0\.lock\.json, in the build context or in the tarball/);
    expect(installWith(lockText, lockText.replace("6.0.3", "6.0.4")).stderr).toMatch(/the package's .* and the tarball's differ/);
    const lock = JSON.parse(lockText) as { packages: Record<string, Record<string, unknown>> };
    const edit = (f: (l: typeof lock) => void) => {
      const copy = JSON.parse(lockText) as typeof lock;
      f(copy);
      return JSON.stringify(copy);
    };
    expect(installWith(edit((l) => (l.packages[""]!.dependencies = { typescript: "6.0.3" }))).stderr).toMatch(/the lock is for .*, the package declares/);
    expect(installWith(edit((l) => delete l.packages["node_modules/typescript"]!.integrity)).stderr).toMatch(
      /node_modules\/typescript has no sha512 integrity/,
    );
    expect(installWith(edit((l) => (l.packages["node_modules/typescript"]!.resolved = "https://example.com/t.tgz"))).stderr).toMatch(/not the npm registry/);
    expect(
      lockProblems(
        edit((l) => delete l.packages["node_modules/typescript"]!.integrity),
        deps,
      ),
    ).toEqual(["node_modules/typescript has no sha512 integrity"]);
  });

  it("runs the container as the caller's uid and gid, root included; repeats a verify with every option that changes it", () => {
    expect(containerUser({ uid: 501, gid: 20 })).toBe("501:20");
    expect(containerUser({ uid: 0, gid: 0 })).toBe("0:0"); // a root caller's output directories are root's: the container must write them
    expect(containerUser({})).toBe("1000:1000"); // no uid (Windows): the image's node user
    expect(containerUser()).toBe(process.getuid ? `${process.getuid()}:${process.getgid!()}` : "1000:1000");
    expect(repeatCommand(["counter.ts"], { docker: true }, "0.44.1")).toBe("typesol verify counter.ts --docker --typesol-version 0.44.1");
    expect(
      repeatCommand(
        ["app"],
        {
          address: "Prog111",
          url: "https://rpc.example/x?a=1",
          config: "my config.yml",
          sbpf: "v1",
          manifest: "app.build.json",
          "release-record": "r.json",
          docker: true,
        },
        "0.45.0",
      ),
    ).toBe(
      "typesol verify app --address Prog111 --url 'https://rpc.example/x?a=1' --config 'my config.yml' --sbpf v1 --manifest app.build.json --docker --typesol-version 0.45.0 --release-record r.json",
    );
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
    // A recorded version: the record is the package's, nothing is fetched.
    const broken = run(["build", "counter.ts", "--docker", "--typesol-version", recordedVersions().at(-1)!], dir, { PATH: failing });
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
      container: {
        platform: "linux/amd64",
        typesol: { version, shasum: releaseRecord(version).record.tarball.shasum },
        deps: { path: `docker/deps/${version}.lock.json`, sha256: sha256(path.join(ROOT, `docker/deps/${version}.lock.json`)), source: "package" },
      },
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
    expect(ok.stdout).toContain(
      `    deps       docker/deps/${version}.lock.json sha256 ${sha256(path.join(ROOT, `docker/deps/${version}.lock.json`))} (this package's), installed with npm ci`,
    );
    expect(ok.stdout).toContain(`(the record names commit ${releaseRecord(version).record.commit})`);
    expect(ok.stdout).toContain(`    repeat     typesol verify counter.ts deployed.so --docker --typesol-version ${version}`);
    const named = run(["verify", "counter.ts", "deployed.so", "--docker", "--manifest", "deployed.build.json"], dir);
    expect(named.stdout).toContain(`    repeat     typesol verify counter.ts deployed.so --manifest deployed.build.json --docker --typesol-version ${version}`);

    const so = readFileSync(path.join(dir, "deployed.so"));
    so[0x200] ^= 0xff;
    writeFileSync(path.join(dir, "changed.so"), so);
    const bad = run(["verify", "counter.ts", "changed.so", "--docker", "--typesol-version", version], dir);
    expect(bad.status).toBe(3);
    expect(bad.stdout).toMatch(/MISMATCH {2}changed\.so is not what counter\.ts builds to/);
    expect(bad.stdout).toMatch(/rebuilt {3}clang 20\.1\.7-rust-dev .*, linux-x64, TypeSOL .*, in the build container \(Dockerfile [0-9a-f]{12}…\)/);
  });
});
