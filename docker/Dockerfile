# The pinned build environment of `typesol build --docker` and `typesol verify --docker` (docs/mainnet.md).
#
# Every input is pinned: the base images by digest, the Agave and platform-tools release files by sha256 (BuildKit
# refuses a download whose checksum differs), the TypeSOL package by its release record (releases/<version>.json,
# copied into the build context as release.json): the npm tarball's sha512 integrity and sha1 shasum, and every file's
# sha256; and its npm dependencies by their lock (docker/deps/<version>.lock.json, copied as deps.lock.json, or an empty
# deps.lock.json to take the one in the version's own tarball), which `npm ci` installs with every package's integrity
# checked. Anyone can build the same environment from this file (from the package's or the repository's root):
#
#   mkdir ctx && cp docker/Dockerfile ctx/ && cp releases/0.44.1.json ctx/release.json && cp docker/deps/0.44.1.lock.json ctx/deps.lock.json
#   docker build --platform linux/amd64 --build-arg TYPESOL_VERSION=0.44.1 -t typesol-build:0.44.1 ctx
#
# The image is not published anywhere: it is built locally from these inputs. Its image id can differ between machines
# (BuildKit and Docker versions, layer dates), so a build records this file's sha256 and the pinned inputs, which do
# not. Docker Engine 23 or later (BuildKit, with ADD --checksum and heredocs) builds it.
#
# The toolchain is the one TypeSOL is tested with (TESTED_TOOLCHAIN in src/compiler/toolchain.ts): Agave 3.1.10,
# platform-tools v1.52. Only the C SDK (headers and linker script, text) is taken from the Agave release; the compiler
# runs clang and ld.lld from platform-tools directly, so cargo-build-sbf and the Solana CLI are not installed.
#
# One architecture, linux/amd64, on every machine (emulated on arm64 hosts), so that the environment is one recipe.
# From TypeSOL 0.45.0 on the programs measured build to the same bytes on macOS arm64, Linux arm64 and Linux x86_64
# too (76 for SBPF v0, 14 for v1 and v2; CI checks a set of them on every change); 0.44.1 and earlier linked the
# platform-tools compiler-builtins library, which each host package lays out differently, so a program with 128-bit
# or signed division got other bytes from each (docs/stability.md has both measurements). Every base image below is
# pinned by its linux/amd64 manifest digest, not by a multi-platform index.

# Unpacking: busybox's tar reads .tar.bz2, which the slim Node image cannot without installing bzip2.
FROM busybox:1.37.0-glibc@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4 AS sdk
ADD --checksum=sha256:a7205ff29bcf0f7199740225ecae2b85a28ea9668892d5ec21bd9749882984a1 \
    https://github.com/anza-xyz/agave/releases/download/v3.1.10/solana-release-x86_64-unknown-linux-gnu.tar.bz2 /dl/agave.tar.bz2
RUN mkdir /out && tar -xjf /dl/agave.tar.bz2 -C /out solana-release/bin/platform-tools-sdk/sbf/c && rm /dl/agave.tar.bz2

FROM busybox:1.37.0-glibc@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4 AS platform-tools
ADD --checksum=sha256:8b3861e93daf085ec12b65c4fac374d9bec4587a3de16871da6b08ab0c1d907e \
    https://github.com/anza-xyz/platform-tools/releases/download/v1.52/platform-tools-linux-x86_64.tar.bz2 /dl/platform-tools.tar.bz2
RUN mkdir -p /out/platform-tools && tar -xjf /dl/platform-tools.tar.bz2 -C /out/platform-tools && rm /dl/platform-tools.tar.bz2

# Node 24 (a supported line, engines >=22.12) on Debian bookworm.
FROM node:24.22.2-bookworm-slim@sha256:c0a93797ee78814ae6d32fcca2561fdbbe423149c3f5389aad32d86e9fd85bd4

# The layout cargo-build-sbf makes (platform-tools-sdk/sbf, its dependencies/platform-tools link into the versioned
# cache and the empty platform-tools-v1.52.md marker), so the compiler finds the SDK and reports the version.
COPY --from=sdk /out/solana-release/bin/platform-tools-sdk/sbf/c /opt/solana/platform-tools-sdk/sbf/c
COPY --from=platform-tools /out/platform-tools /opt/solana/v1.52/platform-tools
RUN test "$(uname -m)" = x86_64 || { echo "this image is linux/amd64 only (docker build --platform linux/amd64)" >&2; exit 1; } \
    && mkdir -p /opt/solana/platform-tools-sdk/sbf/dependencies \
    && ln -s /opt/solana/v1.52/platform-tools /opt/solana/platform-tools-sdk/sbf/dependencies/platform-tools \
    && touch /opt/solana/platform-tools-sdk/sbf/dependencies/platform-tools-v1.52.md \
    && /opt/solana/v1.52/platform-tools/llvm/bin/clang --version | head -1
ENV TYPESOL_SBF_SDK=/opt/solana/platform-tools-sdk/sbf

# The tarball check: the tarball npm serves for TYPESOL_VERSION must be the one release.json records, byte for byte
# (sha512 integrity and sha1 shasum), and each file in it must have the recorded sha256.
COPY <<'EOF' /opt/typesol/check-tarball.mjs
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
const [record, tgz, unpacked, version] = process.argv.slice(2);
const r = JSON.parse(readFileSync(record, "utf8"));
const fail = (m) => {
  console.error(`typesol tarball check: ${m}`);
  process.exit(1);
};
if (r.version !== version) fail(`release.json is the record of ${r.version}, not ${version}`);
const data = readFileSync(tgz);
const integrity = `sha512-${createHash("sha512").update(data).digest("base64")}`;
const shasum = createHash("sha1").update(data).digest("hex");
if (integrity !== r.tarball.integrity) fail(`integrity ${integrity}, the record has ${r.tarball.integrity}`);
if (shasum !== r.tarball.shasum) fail(`shasum ${shasum}, the record has ${r.tarball.shasum}`);
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
const files = new Map(walk(unpacked).map((f) => [path.relative(unpacked, f), createHash("sha256").update(readFileSync(f)).digest("hex")]));
for (const f of r.files) if (files.get(f.path) !== f.sha256) fail(`${f.path}: sha256 ${files.get(f.path) ?? "missing"}, the record has ${f.sha256}`);
if (files.size !== r.files.length) fail(`the tarball has ${files.size} files, the record ${r.files.length}`);
console.log(`typesol tarball check: @typesol/cli@${version} ${shasum}, ${files.size} files as recorded (the record names commit ${r.commit})`);
EOF

# The script a container build runs: the given programs built with this image's TypeSOL, through its public API
# (typesol/compiler and typesol/client, there since before 0.43.0), so one recipe serves every recorded version.
COPY <<'EOF' /opt/typesol/container-build.mjs
const root = "/opt/typesol/node_modules/@typesol/cli";
const { build } = await import(`${root}/dist/compiler/index.js`);
const { writeClient } = await import(`${root}/dist/tools/clientgen.js`);
const path = await import("node:path");
const results = [];
for (const j of JSON.parse(process.argv[2])) {
  try {
    const res = build(j.entry, j.out, j.address, { sbpf: j.sbpf, profile: j.profile });
    writeClient(res.idl, path.join(j.out, `${res.model.name}.client.ts`));
    results.push({ name: res.model.name, so: res.soPath, manifest: res.manifestPath });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
console.log(`TYPESOL_RESULT ${JSON.stringify(results)}`);
EOF

# The dependency install: the npm lockfile of the TypeSOL version's runtime dependencies (docker/deps/<version>.lock.json),
# from the build context when the running package ships it, else from the version's own tarball, checked above. When
# both are there they must be the same bytes. The lock must describe exactly the dependencies the tarball's
# package.json declares, and every package in it must come from the npm registry with an integrity value, which
# `npm ci` then checks each download against: nothing is resolved at build time.
COPY <<'EOF' /opt/typesol/install-deps.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [given, unpacked, version, out] = process.argv.slice(2);
const fail = (m) => {
  console.error(`typesol dependency lock: ${m}`);
  process.exit(1);
};
const rel = `docker/deps/${version}.lock.json`;
const fromContext = existsSync(given) && readFileSync(given).length ? readFileSync(given) : undefined;
const fromTarball = existsSync(`${unpacked}/${rel}`) ? readFileSync(`${unpacked}/${rel}`) : undefined;
if (fromContext && fromTarball && !fromContext.equals(fromTarball)) fail(`the package's ${rel} and the tarball's differ`);
const bytes = fromContext ?? fromTarball;
if (!bytes) fail(`no ${rel}, in the build context or in the tarball`);
const lock = JSON.parse(bytes.toString("utf8"));
if (lock.lockfileVersion !== 3) fail(`lockfileVersion ${lock.lockfileVersion}, expected 3`);
const root = lock.packages?.[""];
const declared = JSON.parse(readFileSync(`${unpacked}/package.json`, "utf8")).dependencies ?? {};
const canonical = (o) => JSON.stringify(Object.keys(o ?? {}).sort().map((k) => [k, o[k]]));
if (canonical(root?.dependencies) !== canonical(declared)) fail(`the lock is for ${canonical(root?.dependencies)}, the package declares ${canonical(declared)}`);
const entries = Object.entries(lock.packages).filter(([p]) => p !== "");
for (const [p, e] of entries) {
  if (e.link) fail(`${p} is a link`);
  if (!/^https:\/\/registry\.npmjs\.org\//.test(e.resolved ?? "")) fail(`${p} resolves to ${e.resolved ?? "nothing"}, not the npm registry`);
  if (!/^sha512-/.test(e.integrity ?? "")) fail(`${p} has no sha512 integrity`);
}
writeFileSync(`${out}/package-lock.json`, bytes);
writeFileSync(`${out}/package.json`, JSON.stringify({ name: root.name, version: root.version, private: true, dependencies: root.dependencies }, null, 2) + "\n");
console.log(`typesol dependency lock: ${rel} (${fromContext ? "the package's" : "the tarball's"}), ${entries.length} packages, each with its integrity`);
EOF

ARG TYPESOL_VERSION
COPY release.json deps.lock.json /opt/typesol/ctx/
# The TypeSOL tarball, checked against the release record, then its dependencies with `npm ci` from the lock (npm checks
# every package's integrity; no install scripts run), then the checked files moved to node_modules/@typesol/cli
# without a second resolution.
RUN test -n "$TYPESOL_VERSION" || { echo "--build-arg TYPESOL_VERSION=<version> is required" >&2; exit 1; } \
    && mkdir -p /tmp/typesol/unpacked && cd /tmp/typesol \
    && npm pack "@typesol/cli@${TYPESOL_VERSION}" --pack-destination /tmp/typesol --silent \
    && tar -xzf "typesol-cli-${TYPESOL_VERSION}.tgz" -C unpacked --strip-components=1 \
    && node /opt/typesol/check-tarball.mjs /opt/typesol/ctx/release.json "typesol-cli-${TYPESOL_VERSION}.tgz" unpacked "$TYPESOL_VERSION" \
    && node /opt/typesol/install-deps.mjs /opt/typesol/ctx/deps.lock.json unpacked "$TYPESOL_VERSION" /opt/typesol \
    && cd /opt/typesol \
    && npm ci --omit=peer --omit=optional --ignore-scripts --no-audit --no-fund --silent \
    && mkdir -p /opt/typesol/node_modules/@typesol \
    && mv /tmp/typesol/unpacked /opt/typesol/node_modules/@typesol/cli \
    && chmod 755 /opt/typesol/node_modules/@typesol/cli/dist/cli.js \
    && ln -s /opt/typesol/node_modules/@typesol/cli/dist/cli.js /usr/local/bin/typesol \
    && rm -rf /tmp/typesol /root/.npm \
    && typesol --version

LABEL org.opencontainers.image.title="typesol-build" \
      org.opencontainers.image.description="TypeSOL ${TYPESOL_VERSION} with Agave 3.1.10 platform-tools v1.52, built from pinned inputs" \
      org.opencontainers.image.source="https://github.com/typesol-lang/typesol" \
      org.typesol.version="${TYPESOL_VERSION}"

# A build runs as the caller's uid and gid (passed by the CLI; this user where there is none), without network or
# capabilities, on a read-only root file system; HOME points at the writable /tmp.
USER node
ENV HOME=/tmp
WORKDIR /src
