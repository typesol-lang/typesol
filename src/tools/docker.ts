// `build --docker` and `verify --docker`: programs built inside the pinned image of docker/Dockerfile, so that anyone
// can rebuild a deployed program from its source in the same environment and compare the bytes. The image is built on
// the user's machine from the Dockerfile's pinned inputs (base images by digest, release files by sha256, the TypeSOL
// tarball by its release record); no image is pulled except the pinned base images, and none is pushed anywhere.
//
// One platform, linux/amd64: the C and the IDL are the same on every host, and so is clang's object code, but each
// platform-tools host package ships its own build of compiler-builtins, so a program that links its 128-bit or signed
// division builds to different bytes on macOS, Linux arm64 and Linux x86_64 (docs/stability.md has the measurement).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildManifest, ContainerIdentity, Sbpf } from "../compiler/index.js";

export const DOCKER_PLATFORM = "linux/amd64";
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DOCKERFILE = path.join(PACKAGE_ROOT, "docker/Dockerfile");
/** The release records the package ships (releases/<version>.json): the TypeSOL versions an image can install. */
export const RELEASES_DIR = path.join(PACKAGE_ROOT, "releases");
const IMAGE = "typesol-build";
const VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** Docker is missing or failed: the message says what to do. Never answered by building locally instead. */
export class DockerError extends Error {}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const firstLine = (s: string | undefined) => (s ?? "").trim().split("\n")[0] ?? "";

export type DockerStatus = { ok: true; version: string; platform: string } | { ok: false; reason: string; fix: string };

/** Whether `docker` is there and its daemon answers. */
export function dockerStatus(): DockerStatus {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"], { encoding: "utf8", timeout: 20_000 });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    return { ok: false, reason: "docker is not installed (not on PATH)", fix: "install Docker: https://docs.docker.com/get-started/get-docker/" };
  const out = r.stdout?.trim() ?? "";
  if (r.error || r.status !== 0 || !/^\S+ \S+\/\S+$/.test(out))
    return {
      ok: false,
      reason: `the Docker daemon is not running or not reachable${r.error ? ` (${r.error.message})` : firstLine(r.stderr) ? ` (${firstLine(r.stderr)})` : ""}`,
      fix: "start Docker Desktop, or the docker service (sudo systemctl start docker)",
    };
  const [version, platform] = out.split(" ") as [string, string];
  return { ok: true, version, platform };
}

/** Throws a DockerError with the fix when Docker cannot run builds. */
export function needDocker(): void {
  const s = dockerStatus();
  if (!s.ok) throw new DockerError(`--docker needs Docker: ${s.reason}. ${s.fix}. Nothing was built.`);
}

/** The pinned inputs a Dockerfile names: its base images (FROM …@sha256:…) and its checksummed downloads (ADD --checksum). */
export function dockerfileInputs(text: string): { base: string[]; downloads: { url: string; sha256: string }[] } {
  const base = [...new Set([...text.matchAll(/^FROM\s+(\S+@sha256:[0-9a-f]{64})/gm)].map((m) => m[1]!))];
  const downloads = [...text.matchAll(/^ADD\s+--checksum=sha256:([0-9a-f]{64})\s+(?:\\\n\s*)?(https:\/\/\S+)/gm)].map((m) => ({ url: m[2]!, sha256: m[1]! }));
  return { base, downloads };
}

/** What `--docker` needs of a release record: the tarball's hashes and every file's sha256. */
export interface ReleaseRecord {
  version: string;
  commit: string;
  tarball: { shasum: string; integrity: string };
  files: { path: string; sha256: string }[];
}

/** The versions whose records ship with this package, oldest first. */
export function recordedVersions(dir = RELEASES_DIR): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const parts = (v: string) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  return names
    .flatMap((f) => /^(\d+\.\d+\.\d+(?:-[\w.]+)?)\.json$/.exec(f)?.[1] ?? [])
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? -1) < (y[i] ?? -1) ? -1 : 1;
      return 0;
    });
}

/**
 * The release record of `version`: `file` (`--release-record`, e.g. releases/<version>.json from the repository), or
 * the one this package ships. A version without one is refused: its tarball could not be checked.
 */
export function releaseRecord(version: string, file?: string, dir = RELEASES_DIR): { record: ReleaseRecord; path: string } {
  const at = file ?? path.join(dir, `${version}.json`);
  if (!existsSync(at)) {
    const known = recordedVersions(dir);
    throw new DockerError(
      file
        ? `--release-record ${file} does not exist`
        : `no release record for TypeSOL ${version}: --docker installs only versions whose npm tarball is recorded in releases/<version>.json, ` +
            `so that the image's compiler is checked against it. This package has the records of ${known.join(", ") || "no version"}. ` +
            `A release's record is committed after it is published (releases/${version}.json on the repository's main branch, from 0.43.0 on): ` +
            `pass it with --release-record <file>, use a later @typesol/cli, which ships it, or pick a recorded version with --typesol-version. ` +
            `Versions before 0.43.0 have no record and cannot be built in the container.`,
    );
  }
  let r: ReleaseRecord;
  try {
    r = JSON.parse(readFileSync(at, "utf8")) as ReleaseRecord;
  } catch (e) {
    throw new DockerError(`${at}: not valid JSON (${(e as Error).message})`);
  }
  if (r?.version !== version || typeof r.tarball?.shasum !== "string" || typeof r.tarball.integrity !== "string" || !Array.isArray(r.files))
    throw new DockerError(`${at} is not the release record of TypeSOL ${version} (version, tarball.shasum, tarball.integrity and files are required)`);
  return { record: r, path: at };
}

/**
 * The TypeSOL version a container build uses: `--typesol-version`, else the version of the deployed build's manifest
 * (verify), else this CLI's. A project that installs another typesol than the CLI that runs is an error rather than a
 * guess: the project's own (`npx --no-install typesol`) is the one its builds were made with.
 */
export function chooseTypesolVersion(opts: { given?: string; deployed?: { version: string; from: string }; projectRoot?: string; cliVersion: string }): {
  version: string;
  why: string;
} {
  if (opts.given !== undefined) {
    if (!VERSION.test(opts.given)) throw new DockerError(`--typesol-version "${opts.given}" is not a version (e.g. 0.44.0)`);
    return { version: opts.given, why: "--typesol-version" };
  }
  if (opts.deployed) return { version: opts.deployed.version, why: `the deployed build's manifest, ${opts.deployed.from}` };
  const installed = opts.projectRoot ? path.join(opts.projectRoot, "node_modules/typesol/package.json") : undefined;
  if (installed && existsSync(installed)) {
    let version: unknown;
    try {
      version = (JSON.parse(readFileSync(installed, "utf8")) as { version?: unknown }).version;
    } catch {
      /* unreadable: the CLI's own version below */
    }
    if (typeof version === "string" && version !== opts.cliVersion)
      throw new DockerError(
        `this project installs typesol ${version} (node_modules/typesol), but this is typesol ${opts.cliVersion}: ` +
          `run the project's own (npx --no-install typesol …), or name the version to build with, --typesol-version ${version}`,
      );
  }
  return { version: opts.cliVersion, why: "this typesol" };
}

/** The image a container build runs in, and what to record about it. */
export interface BuildImage {
  tag: string;
  identity: ContainerIdentity;
}

/**
 * The image for `version`, built first when this machine has none (`typesol-build:<version>-<Dockerfile sha256>`).
 * Progress goes to stderr. Building needs the network (base images, release files, npm); running it does not.
 */
export function ensureImage(version: string, recordFile?: string, log: (s: string) => void = (s) => console.error(s)): BuildImage {
  needDocker();
  const { record, path: recordPath } = releaseRecord(version, recordFile);
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const dockerfileSha = sha256(dockerfile);
  const tag = `${IMAGE}:${version}-${dockerfileSha.slice(0, 12)}`;
  let id = imageId(tag, record);
  if (!id) {
    const shown = path.relative(process.cwd(), DOCKERFILE);
    log(`  image     building ${tag} (${DOCKER_PLATFORM}) from ${shown.startsWith("..") ? DOCKERFILE : shown}`);
    log(`            once per TypeSOL version: about 750 MB of downloads, then the toolchain is checked and unpacked (minutes)`);
    const ctx = mkdtempSync(path.join(os.tmpdir(), "typesol-image-"));
    try {
      copyFileSync(DOCKERFILE, path.join(ctx, "Dockerfile"));
      copyFileSync(recordPath, path.join(ctx, "release.json"));
      const r = spawnSync(
        "docker",
        [
          "build",
          "--platform",
          DOCKER_PLATFORM,
          "--build-arg",
          `TYPESOL_VERSION=${version}`,
          "--label",
          `org.typesol.dockerfile.sha256=${dockerfileSha}`,
          "--label",
          `org.typesol.release.integrity=${record.tarball.integrity}`,
          "-t",
          tag,
          ctx,
        ],
        // docker's progress on stderr: stdout stays the command's own report.
        { stdio: ["ignore", 2, 2] },
      );
      if (r.error || r.status !== 0)
        throw new DockerError(
          `docker build of ${tag} failed (${r.error?.message ?? `exit ${r.status}`}; its output is above). Nothing was built: --docker never falls back to the local toolchain.`,
        );
    } finally {
      rmSync(ctx, { recursive: true, force: true });
    }
    id = imageId(tag, record);
    if (!id) throw new DockerError(`docker build reported success, but ${tag} is not there`);
  }
  const { base, downloads } = dockerfileInputs(dockerfile);
  return {
    tag,
    identity: {
      platform: DOCKER_PLATFORM,
      dockerfile: dockerfileSha,
      image: id,
      base,
      downloads,
      typesol: { version, shasum: record.tarball.shasum, integrity: record.tarball.integrity, commit: record.commit },
    },
  };
}

/** The local image id of `tag` when it is there, for this platform and built from this record; else undefined. */
function imageId(tag: string, record: ReleaseRecord): string | undefined {
  const r = spawnSync(
    "docker",
    ["image", "inspect", "--format", '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.typesol.release.integrity"}}', tag],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return undefined;
  const [id, platform, integrity] = r.stdout.trim().split(" ");
  return platform === DOCKER_PLATFORM && integrity === record.tarball.integrity ? id : undefined;
}

/** One program to build in the container. Paths are the host's. */
export interface ContainerJob {
  entry: string;
  outDir: string;
  address: string;
  sbpf: Sbpf;
  profile?: boolean;
}

export interface ContainerResult {
  name: string;
  soPath: string;
  manifestPath: string;
  manifest: BuildManifest;
}

/**
 * Build `jobs` in the image: `root` mounted read-only (the only sources the container sees), each output directory
 * writable, no network, a read-only root file system, no capabilities, the caller's uid (never root). The files are
 * the ones `build` writes; each manifest gets the container's identity.
 */
export function containerBuild(image: BuildImage, root: string, jobs: ContainerJob[]): ContainerResult[] {
  const src = path.resolve(root);
  const mounts = ["--mount", `type=bind,src=${src},dst=/src,readonly`];
  const inside = jobs.map((j, i) => {
    const rel = path.relative(src, path.resolve(j.entry));
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new DockerError(`${j.entry} is outside ${src}, the directory the container sees`);
    mkdirSync(j.outDir, { recursive: true });
    mounts.push("--mount", `type=bind,src=${path.resolve(j.outDir)},dst=/out/${i}`);
    return { entry: path.posix.join("/src", ...rel.split(path.sep)), out: `/out/${i}`, address: j.address, sbpf: j.sbpf, profile: !!j.profile };
  });
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--platform",
      DOCKER_PLATFORM,
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      containerUser(),
      ...limits(),
      ...mounts,
      image.tag,
      "node",
      "/opt/typesol/container-build.mjs",
      JSON.stringify(inside),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
  );
  const line = r.stdout?.split("\n").find((l) => l.startsWith("TYPESOL_RESULT "));
  if (r.error || r.status !== 0 || !line)
    throw new DockerError(
      `the container build failed (${r.error?.message ?? `exit ${r.status}`}; the compiler's output is above). ` +
        `The container sees only ${src} (read-only at /src): an import from outside it is not there.`,
    );
  const built = JSON.parse(line.slice("TYPESOL_RESULT ".length)) as { name: string }[];
  return built.map((b, i) => {
    const job = jobs[i]!;
    const manifestPath = path.join(job.outDir, `${b.name}.build.json`);
    const manifest = { ...(JSON.parse(readFileSync(manifestPath, "utf8")) as BuildManifest), container: image.identity };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { name: b.name, soPath: path.join(job.outDir, `${b.name}.so`), manifestPath, manifest };
  });
}

/** The caller's uid:gid, so that the outputs are the caller's; never root (the image's `node` user instead). */
export function containerUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid !== undefined && uid !== 0 && gid !== undefined ? `${uid}:${gid}` : "1000:1000";
}

/** TYPESOL_DOCKER_CPUS / TYPESOL_DOCKER_MEMORY: limits for the build container on a shared machine. */
export function limits(): string[] {
  const out: string[] = [];
  const cpus = process.env.TYPESOL_DOCKER_CPUS;
  const memory = process.env.TYPESOL_DOCKER_MEMORY;
  if (cpus) {
    if (!/^\d+(\.\d+)?$/.test(cpus)) throw new DockerError(`TYPESOL_DOCKER_CPUS=${cpus}: expected a number of CPUs (e.g. 2)`);
    out.push("--cpus", cpus);
  }
  if (memory) {
    if (!/^\d+[kmg]?$/i.test(memory)) throw new DockerError(`TYPESOL_DOCKER_MEMORY=${memory}: expected a size such as 4g`);
    out.push("--memory", memory);
  }
  return out;
}

/** The git commit of a source directory and whether its files differ from it, when it is in a checkout. */
export function sourceRevision(dir: string): { commit: string; clean: boolean } | undefined {
  const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return undefined;
  const status = spawnSync("git", ["-C", dir, "status", "--porcelain", "--", "."], { encoding: "utf8" });
  return { commit: head.stdout.trim(), clean: status.status === 0 && status.stdout.trim() === "" };
}
