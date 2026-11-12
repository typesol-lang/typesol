// `build --docker` and `verify --docker`: programs built inside the pinned image of docker/Dockerfile, so that anyone
// can rebuild a deployed program from its source in the same environment and compare the bytes. The image is built on
// the user's machine from the Dockerfile's pinned inputs (base images by digest, release files by sha256, the TypeSOL
// tarball by its release record); no image is pulled except the pinned base images, and none is pushed anywhere.
//
// One platform, linux/amd64, so that the whole environment is one recipe. From 0.45.0 on a program builds to the same
// bytes on macOS arm64, Linux arm64 and Linux x86_64 as well (measured over 76 programs for SBPF v0 and 14 for v1 and
// v2, docs/stability.md); TypeSOL 0.44.1 and earlier linked platform-tools' compiler-builtins, whose layout differed by
// host package, so for those versions the container's platform decides the bytes of programs with 128-bit or signed
// division.
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
/**
 * The dependency locks the package ships (docker/deps/<version>.lock.json): for each TypeSOL version, the npm lockfile
 * of its runtime dependencies, which the image installs with `npm ci` (every package checked against its integrity).
 * The lock of version N ships in package N (it does not contain N's own tarball); a version newer than the package
 * carries its own, checked with the rest of its tarball against the release record.
 */
export const DEPS_DIR = path.join(PACKAGE_ROOT, "docker/deps");
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

/** Where a release record came from: this package, a file given with --release-record, or the repository's main branch. */
export interface RecordSource {
  kind: "package" | "file" | "repository";
  /** `releases/<version>.json` (in the package), the file as given, or the URL it was fetched from. */
  location: string;
  /** sha256 of the record's bytes, as read or served (what `sha256sum` of the file gives). */
  sha256: string;
}

/** A release record, its bytes (what the image build checks the tarball against), and where it came from. */
export interface FoundRecord {
  record: ReleaseRecord;
  bytes: Buffer;
  source: RecordSource;
}

/**
 * Where a release's record is fetched from when this package does not ship it: the repository's main branch, where it
 * is committed after the release is published (the package of version N cannot contain releases/N.json).
 */
export const RELEASES_URL = "https://raw.githubusercontent.com/typesol-lang/typesol/main/releases";

/** The fetch a record lookup uses (tests pass their own: no network). */
export type FetchText = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

function parseRecord(text: string, version: string, where: string): ReleaseRecord {
  let r: ReleaseRecord;
  try {
    r = JSON.parse(text) as ReleaseRecord;
  } catch (e) {
    throw new DockerError(`${where}: not valid JSON (${(e as Error).message})`);
  }
  if (
    r?.version !== version ||
    typeof r.commit !== "string" ||
    !r.commit ||
    typeof r.tarball?.shasum !== "string" ||
    typeof r.tarball.integrity !== "string" ||
    !Array.isArray(r.files)
  )
    throw new DockerError(
      `${where} is not the release record of TypeSOL ${version} (version, commit, tarball.shasum, tarball.integrity and files are required)`,
    );
  return r;
}

/** Whether `version` comes before 0.43.0, the first release with a record. */
function beforeRecords(version: string): boolean {
  const [major, minor] = version.split(".").map(Number) as [number, number];
  return major === 0 && minor < 43;
}

/**
 * The release record of `version`: `file` (`--release-record`, e.g. releases/<version>.json from the repository), or
 * the one this package ships. A version without one is refused: its tarball could not be checked. (findReleaseRecord
 * also fetches a newer release's record from the repository.)
 */
export function releaseRecord(version: string, file?: string, dir = RELEASES_DIR): FoundRecord {
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
  const bytes = readFileSync(at);
  const text = bytes.toString("utf8");
  const record = parseRecord(text, version, at);
  return {
    record,
    bytes,
    source: file ? { kind: "file", location: file, sha256: sha256(bytes) } : { kind: "package", location: `releases/${version}.json`, sha256: sha256(bytes) },
  };
}

/**
 * The release record of `version` for a container build: `file` when given, else the package's, else (a release newer
 * than this package, whose record was committed after the package was published) releases/<version>.json fetched from
 * the repository's main branch over HTTPS. The check then rests on two independent sources agreeing: the tarball npm
 * serves and the record the repository holds. Offline, or when the repository has no record for the version, it is an
 * error that names --release-record. Where the record came from goes to `log` and into the build's manifest.
 */
export async function findReleaseRecord(
  version: string,
  opts: { file?: string; dir?: string; fetch?: FetchText; log?: (s: string) => void; timeoutMs?: number } = {},
): Promise<FoundRecord> {
  const dir = opts.dir ?? RELEASES_DIR;
  if (!VERSION.test(version)) throw new DockerError(`"${version}" is not a TypeSOL version (e.g. 0.44.0)`);
  if (opts.file || existsSync(path.join(dir, `${version}.json`)) || beforeRecords(version)) return releaseRecord(version, opts.file, dir);
  const url = `${RELEASES_URL}/${version}.json`;
  const fetchText = opts.fetch ?? (globalThis.fetch as unknown as FetchText);
  const instead =
    `pass the record with --release-record <file> (releases/${version}.json from the repository), ` +
    `or build a version this package records (${recordedVersions(dir).join(", ") || "none"}) with --typesol-version`;
  let bytes: Buffer;
  try {
    const res = await fetchText(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
    if (res.status === 404)
      throw new DockerError(
        `no release record for TypeSOL ${version}: this package does not ship one, and the repository's main branch has none (${url}: HTTP 404). ` +
          `Is ${version} a released version? Otherwise ${instead}.`,
      );
    if (!res.ok) throw new DockerError(`could not fetch the release record of TypeSOL ${version} from ${url} (HTTP ${res.status}): ${instead}.`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof DockerError) throw e;
    throw new DockerError(
      `could not fetch the release record of TypeSOL ${version} from ${url} (${(e as Error).message}; offline?). This package does not ship it: ${instead}.`,
    );
  }
  const text = bytes.toString("utf8");
  const record = parseRecord(text, version, url);
  const digest = sha256(bytes);
  (opts.log ?? ((s: string) => console.error(s)))(`  record    releases/${version}.json from ${url} (sha256 ${digest}): this package was published before it`);
  return { record, bytes, source: { kind: "repository", location: url, sha256: digest } };
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
 * The dependency lock of `version`'s image: this package's docker/deps/<version>.lock.json, else the one in that
 * version's own tarball, whose sha256 the release record lists (the image takes it from the checked tarball). Neither:
 * a DockerError, as the image would have to resolve the dependencies unpinned.
 */
export function dependencyLock(record: ReleaseRecord, dir = DEPS_DIR): { bytes?: Buffer; lock: NonNullable<ContainerIdentity["deps"]> } {
  const rel = `docker/deps/${record.version}.lock.json`;
  const at = path.join(dir, `${record.version}.lock.json`);
  if (existsSync(at)) {
    const bytes = readFileSync(at);
    return { bytes, lock: { path: rel, sha256: sha256(bytes), source: "package" } };
  }
  const inTarball = record.files.find((f) => f.path === rel);
  if (inTarball) return { lock: { path: rel, sha256: inTarball.sha256, source: "tarball" } };
  throw new DockerError(
    `no dependency lock for TypeSOL ${record.version}: neither this package (${rel}) nor that version's tarball has one, ` +
      `so its npm dependencies could not be installed pinned. Use a later @typesol/cli, or a version this package locks (${lockedVersions(dir).join(", ") || "none"}).`,
  );
}

/** The versions whose dependency locks ship with this package. */
export function lockedVersions(dir = DEPS_DIR): string[] {
  try {
    return readdirSync(dir).flatMap((f) => /^(\d+\.\d+\.\d+(?:-[\w.]+)?)\.lock\.json$/.exec(f)?.[1] ?? []);
  } catch {
    return [];
  }
}

/** sha256 of a record's file list (path and sha256 of each, in order): one label for "every file as recorded". */
export function filesDigest(record: ReleaseRecord): string {
  return sha256(record.files.map((f) => `${f.path}\0${f.sha256}\n`).join(""));
}

/**
 * The labels an image is built with: everything the image build checked. A cached image is used only when all of
 * them are this record's and this lock's.
 */
export function imageLabels(dockerfileSha: string, record: ReleaseRecord, lockSha: string): Record<string, string> {
  return {
    "org.typesol.dockerfile.sha256": dockerfileSha,
    "org.typesol.release.integrity": record.tarball.integrity,
    "org.typesol.release.shasum": record.tarball.shasum,
    "org.typesol.release.commit": record.commit,
    "org.typesol.release.files": filesDigest(record),
    "org.typesol.deps.sha256": lockSha,
  };
}

/**
 * The image for `version`, built first when this machine has none (`typesol-build:<version>-<Dockerfile sha256>`).
 * Progress goes to stderr. Building needs the network (base images, release files, npm); running it does not.
 */
export function ensureImage(version: string, found?: FoundRecord, log: (s: string) => void = (s) => console.error(s)): BuildImage {
  needDocker();
  const { record, bytes, source } = found ?? releaseRecord(version);
  if (record.version !== version) throw new DockerError(`the release record is of TypeSOL ${record.version}, not ${version}`);
  const deps = dependencyLock(record);
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const dockerfileSha = sha256(dockerfile);
  const tag = `${IMAGE}:${version}-${dockerfileSha.slice(0, 12)}`;
  const labels = imageLabels(dockerfileSha, record, deps.lock.sha256);
  let id = imageId(tag, labels);
  if (!id) {
    const shown = path.relative(process.cwd(), DOCKERFILE);
    log(`  image     building ${tag} (${DOCKER_PLATFORM}) from ${shown.startsWith("..") ? DOCKERFILE : shown}`);
    log(`            once per TypeSOL version: about 750 MB of downloads, then the toolchain is checked and unpacked (minutes)`);
    const ctx = mkdtempSync(path.join(os.tmpdir(), "typesol-image-"));
    try {
      copyFileSync(DOCKERFILE, path.join(ctx, "Dockerfile"));
      writeFileSync(path.join(ctx, "release.json"), bytes);
      // Empty when the lock is the one in the version's own tarball: the image takes it from there, once checked.
      writeFileSync(path.join(ctx, "deps.lock.json"), deps.bytes ?? "");
      const r = spawnSync(
        "docker",
        [
          "build",
          "--platform",
          DOCKER_PLATFORM,
          "--build-arg",
          `TYPESOL_VERSION=${version}`,
          ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
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
    id = imageId(tag, labels);
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
      typesol: { version, shasum: record.tarball.shasum, integrity: record.tarball.integrity, commit: record.commit, record: source },
      deps: deps.lock,
    },
  };
}

/**
 * The local image id of `tag` when it is there, for this platform, with these labels; undefined when there is none.
 * An image of the tag built from another record or lock (a label differs) is an error, not a silent rebuild: two
 * records of one version disagree, and one of them is wrong.
 */
function imageId(tag: string, labels: Record<string, string>): string | undefined {
  const r = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}} {{.Os}}/{{.Architecture}} {{json .Config.Labels}}", tag], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const [id, platform, ...rest] = r.stdout.trim().split(" ");
  if (platform !== DOCKER_PLATFORM) return undefined;
  let found: Record<string, string> = {};
  try {
    found = (JSON.parse(rest.join(" ")) as Record<string, string> | null) ?? {};
  } catch {
    /* no labels */
  }
  const differ = Object.entries(labels).filter(([k, v]) => found[k] !== v);
  if (!differ.length) return id;
  throw new DockerError(
    `the local image ${tag} was not built from this release record and dependency lock (${differ
      .map(([k, v]) => `${k}: the image has ${found[k] ?? "none"}, this record ${v}`)
      .join("; ")}). If this record is the right one, remove the image (docker image rm ${tag}) and run again: it is then built from this record.`,
  );
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
 * writable, no network, a read-only root file system, no capabilities, the caller's uid and gid (containerUser). The files are
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

/**
 * The user the container runs as: the caller's uid:gid, so that it can write the output directories the caller made
 * and the outputs are the caller's. That is root (0:0) for a root caller, still without capabilities, with
 * no-new-privileges and a read-only root file system. Where there is no uid (Windows), the image's `node` user.
 */
export function containerUser(ids: { uid?: number; gid?: number } = { uid: process.getuid?.(), gid: process.getgid?.() }): string {
  return ids.uid !== undefined && ids.gid !== undefined ? `${ids.uid}:${ids.gid}` : "1000:1000";
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

/** The `typesol verify` command that repeats a container verify: the arguments and every option that changes the result. */
export function repeatCommand(args: string[], v: Record<string, unknown>, version: string): string {
  const opt = (name: string) => (typeof v[name] === "string" ? [`--${name}`, shellQuote(v[name] as string)] : []);
  return [
    "typesol verify",
    ...args.map(shellQuote),
    ...opt("address"),
    ...opt("url"),
    ...opt("config"),
    ...opt("sbpf"),
    ...opt("manifest"),
    "--docker",
    "--typesol-version",
    version,
    ...opt("release-record"),
  ].join(" ");
}

/** Quote a command-line word for a POSIX shell when it needs it. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
