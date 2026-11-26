# The build environment of the reference binaries for the Percolator v16 port (showcase/mainnet/percolator-v16):
# Rust 1.89 with Agave 3.1.10's cargo-build-sbf and platform-tools v1.52 (rustc 1.89.0-dev), the toolchain the author's
# own notes name for his SBF builds. build.sh builds this image and runs every Rust build in it; nothing is installed
# on the host.
#
# Every input is pinned: the base images by their linux/amd64 manifest digests, the Agave release and platform-tools by
# sha256 (BuildKit refuses a download whose checksum differs). They are the same two release files docker/Dockerfile
# pins for TypeSOL's own build image. linux/amd64 only (emulated on arm64 hosts).
FROM busybox:1.37.0-glibc@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4 AS dl
ADD --checksum=sha256:a7205ff29bcf0f7199740225ecae2b85a28ea9668892d5ec21bd9749882984a1 \
    https://github.com/anza-xyz/agave/releases/download/v3.1.10/solana-release-x86_64-unknown-linux-gnu.tar.bz2 /dl/agave.tar.bz2
ADD --checksum=sha256:8b3861e93daf085ec12b65c4fac374d9bec4587a3de16871da6b08ab0c1d907e \
    https://github.com/anza-xyz/platform-tools/releases/download/v1.52/platform-tools-linux-x86_64.tar.bz2 /dl/platform-tools.tar.bz2
RUN mkdir -p /out/agave /out/pt && tar -xjf /dl/agave.tar.bz2 -C /out/agave \
      solana-release/bin/cargo-build-sbf solana-release/bin/platform-tools-sdk \
    && tar -xjf /dl/platform-tools.tar.bz2 -C /out/pt && rm -rf /dl

# rust:1.89-slim-bookworm, linux/amd64.
FROM rust:1.89-slim-bookworm@sha256:294917190b5a3fed18d3303213943f40ec9b644b3cd6e5cdc8cd029334a770b3
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates pkg-config libssl-dev libudev-dev bzip2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dl /out/agave/solana-release /opt/agave
# cargo-build-sbf --tools-version v1.52 looks for platform-tools in the container's own ~/.cache/solana.
COPY --from=dl /out/pt /root/.cache/solana/v1.52/platform-tools
RUN test "$(uname -m)" = x86_64 \
    && ln -s /root/.cache/solana/v1.52/platform-tools /opt/agave/bin/platform-tools-sdk/sbf/dependencies/platform-tools 2>/dev/null || true
ENV PATH=/opt/agave/bin:$PATH CARGO_NET_GIT_FETCH_WITH_CLI=true
RUN cargo-build-sbf --version
WORKDIR /work
