# The pinned build environment of `typesol build --docker` and `typesol verify --docker` (docs/mainnet.md).
#
# Every input is pinned: the base images by digest, the Agave and platform-tools release files by sha256 (BuildKit
# refuses a download whose checksum differs), and the TypeSOL package by its release record (releases/<version>.json,
# copied into the build context as release.json): the npm tarball's sha512 integrity and sha1 shasum, and every file's
# sha256. Anyone can build the same environment from this file:
#
#   mkdir ctx && cp Dockerfile ctx/ && cp releases/0.44.0.json ctx/release.json
#   docker build --platform linux/amd64 --build-arg TYPESOL_VERSION=0.44.0 -t typesol-build:0.44.0 ctx
#
# The image is not published anywhere: it is built locally from these inputs. Its image id can differ between machines
# (BuildKit and Docker versions, layer dates), so a build records this file's sha256 and the pinned inputs, which do
# not. Docker Engine 23 or later (BuildKit, with ADD --checksum and heredocs) builds it.
#
# The toolchain is the one TypeSOL is tested with (TESTED_TOOLCHAIN in src/compiler/toolchain.ts): Agave 3.1.10,
# platform-tools v1.52. Only the C SDK (headers and linker script, text) is taken from the Agave release; the compiler
# runs clang and ld.lld from platform-tools directly, so cargo-build-sbf and the Solana CLI are not installed.
#
# One architecture, linux/amd64, on every machine (emulated on arm64 hosts). The C and the IDL are the same on every
# host, and so is clang's object code, but each platform-tools host package ships its own build of the SBF
# compiler-builtins library: a program that links its 128-bit or signed division (u128 math, most DeFi ports) gets
# different bytes from the macOS, Linux arm64 and Linux x86_64 packages (docs/stability.md has the measurement).
# Every base image below is therefore pinned by its linux/amd64 manifest digest, not by a multi-platform index.

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
console.log(`typesol tarball check: @typesol/cli@${version} ${shasum}, ${files.size} files as recorded (commit ${r.commit})`);
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

ARG TYPESOL_VERSION
COPY release.json /opt/typesol/release.json
# npm resolves the package's dependencies at image build time (the tarball has no lockfile). TypeScript, the only one
# that decides what compiles, is pinned exactly by the package; the resolved tree is kept in package-lock.json.
RUN test -n "$TYPESOL_VERSION" || { echo "--build-arg TYPESOL_VERSION=<version> is required" >&2; exit 1; } \
    && mkdir -p /tmp/typesol/unpacked && cd /tmp/typesol \
    && npm pack "@typesol/cli@${TYPESOL_VERSION}" --pack-destination /tmp/typesol --silent \
    && tar -xzf "typesol-cli-${TYPESOL_VERSION}.tgz" -C unpacked --strip-components=1 \
    && node /opt/typesol/check-tarball.mjs /opt/typesol/release.json "typesol-cli-${TYPESOL_VERSION}.tgz" unpacked "$TYPESOL_VERSION" \
    && cd /opt/typesol \
    && npm install --prefix /opt/typesol --omit=peer --omit=optional --ignore-scripts --no-audit --no-fund --silent \
        "/tmp/typesol/typesol-cli-${TYPESOL_VERSION}.tgz" \
    && ln -s /opt/typesol/node_modules/.bin/typesol /usr/local/bin/typesol \
    && rm -rf /tmp/typesol /root/.npm \
    && typesol --version

LABEL org.opencontainers.image.title="typesol-build" \
      org.opencontainers.image.description="TypeSOL ${TYPESOL_VERSION} with Agave 3.1.10 platform-tools v1.52, built from pinned inputs" \
      org.opencontainers.image.source="https://github.com/typesol-lang/typesol" \
      org.typesol.version="${TYPESOL_VERSION}"

# A build runs as a non-root user (the CLI passes the caller's uid, or this one), without network, on a read-only
# root file system; HOME points at the writable /tmp.
USER node
ENV HOME=/tmp
WORKDIR /src
