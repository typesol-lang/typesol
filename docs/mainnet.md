# Deploy to mainnet

From an empty directory to a program on Solana mainnet-beta: create, test, deploy, publish the IDL, then check that
the deployed binary is the one your source builds. The program here is the counter that `typesol init` creates
(11,400 bytes, 11.1 KiB, built with TypeSOL 0.45.0 and platform-tools clang 20.1.7 for SBPF v0; other versions differ
slightly); any TypeSOL project works the same way.

**Before you deploy anything that holds value.** TypeSOL has had internal security reviews by its maintainers, not an
independent audit ([status](security-model.md#status)). Do not put significant value behind a program built with it
until an external audit of the compiler and runtime is published, and audit your own program as you would any Solana
program.

You need Node.js 22.12 or later and the Agave CLI with platform-tools (see the README's Quick start).

**The toolchain you deploy with.** The binary is what the platform-tools' clang makes of the generated C, so the
toolchain is part of what you trust. Deploy with the one TypeSOL is tested with (Agave 3.1.10, platform-tools v1.52;
`typesol doctor` says whether yours is, and `typesol deploy --toolchain-strict` refuses another). The host does not
matter from 0.45.0 on: with the same TypeSOL and toolchain a program builds to the same bytes on macOS arm64, Linux
arm64 and Linux x86_64 (measured over 76 programs for SBPF v0 and 14 for v1 and v2; up to 0.44.1 a program with
128-bit or signed division did not, [stability.md](stability.md#what-builds-the-same-bytes-where)). For a program others should be able to verify, build
it with `--docker` (step 2) all the same: a pinned linux/amd64 container that anyone can rebuild, so the whole
environment is one recipe. Keep
`target/my_app/my_app.build.json` with each deployment, next to the commit you deployed: it records the TypeSOL,
TypeScript, clang and platform-tools versions, the host, the container when there was one, and the deployed bytes'
sha256. Step 6's `verify` matches only when it rebuilds with the same TypeSOL version and toolchain (and, for a program
with 128-bit or signed division built with 0.44.1 or earlier, the same kind of host), and on a mismatch `--manifest`
with that file shows what differs.

## 1. Create and test

```sh
npx @typesol/cli init my-app
cd my-app
npm install
npm test
```

`npm test` runs `tests/my_app.test.ts` in LiteSVM: it compiles the program and calls it, with no validator or SOL.
Write your program in `programs/my_app.ts` and keep the tests passing before you spend anything.

## 2. Build

```sh
npx --no-install typesol build
```

This writes `target/my_app/`: the program (`my_app.so`), its Anchor IDL (`my_app.json`), a TypeScript client
(`my_app.client.ts`) and the generated C. The first build also creates `target/deploy/my_app-keypair.json`, the
program's address, and records the address in `typesol.json`.

**Back up `target/deploy/my_app-keypair.json` now.** It is not committed (`.gitignore`), and without it you cannot
redeploy to that address.

### A build others can verify

```sh
npx --no-install typesol build --docker
```

The same files, built inside a container instead of with your platform-tools. The container is made on your machine
from `docker/Dockerfile`, which ships in the package; every input is pinned: the Node and busybox base images by their
linux/amd64 digests, the Agave 3.1.10 and platform-tools v1.52 release files by sha256, the TypeSOL package (the
version your project uses) by its release record, `releases/<version>.json`: the npm tarball's sha512 integrity and
sha1 shasum and every file's sha256, checked before it is installed, and its npm dependencies (TypeScript, the
compiler's front end, among them) by that version's lock, `docker/deps/<version>.lock.json`, which `npm ci` installs
checking every package's integrity, with no install scripts. The lock of a version ships in the package of that
version (and in later ones); the locks of 0.43.0, 0.44.0 and 0.44.1, released before locks existed, were resolved
from the npm registry on 2026-11-12, so their integrity values are what the registry served then, not what an image
built at their release installed. The first `--docker` build of a TypeSOL version
builds the image (about 750 MB of downloads, a few minutes; Docker must be running, `typesol doctor` shows it); later
ones take seconds. The build runs with no network, the project mounted read-only, the output directory writable,
with no capabilities, as your uid and gid (root for a root caller). `my_app.build.json` then records the container:
the platform, the Dockerfile's sha256, the pinned base images and downloads, the TypeSOL tarball's hashes, the commit
its release record names, where the record came from (with the record's sha256), the dependency lock and its sha256,
and the local image id.

Deploy that `my_app.so` with the Solana CLI, `solana program deploy target/my_app/my_app.so --program-id
target/deploy/my_app-keypair.json --use-rpc` (with your `--url`). What replaces the container build: `typesol deploy`
(`--dry-run` included) and `typesol build` without `--docker`, which build again with your local platform-tools and
overwrite it; and `npm test` once the program's sources, SBPF version or address changed, which rebuilds it locally
and says so (`note: … held a --docker build that is out of date`). What does not: `npm test` while the sources are
the ones `my_app.build.json` records and the `.so` is the one it records, on any host: the tests then run the
container's binary. After a local build, `typesol build --docker` again before deploying. Commit the source, keep
`my_app.build.json`, and publish the commit and that file with the program id.

The TypeSOL inside the container is the version this `typesol` is, the one your project installs (`npx --no-install
typesol`); a global `typesol` of another version than the project's `node_modules/typesol` refuses rather than
guess. `--typesol-version <v>` picks another. Only versions with a release record can be installed (0.43.0 and later).
A package carries the records of the releases before it, because a release's record is written after it is
published; for a release the package does not record (the newest one, or a later one asked for), `--docker` fetches
`releases/<version>.json` from the repository's main branch
(`https://raw.githubusercontent.com/typesol-lang/typesol/main/releases/<version>.json`, unauthenticated HTTPS), prints
where it came from and its sha256, and records both in `my_app.build.json` (`container.typesol.record`). The check is
then two independent sources agreeing: the tarball npm serves must be the one the repository's record describes, so a
tampered package would have to be matched by a tampered repository. That holds for a fetched record and for a
`--release-record` file; for a version whose record ships in the running package, the record came from npm too (in
an earlier package), so the check is then against what npm served before. Offline, or when the repository has no
record for that version, it is an error that names `--release-record <file>`, which passes the record yourself (from
a checkout, `releases/<version>.json`). Between `npm publish` and the commit of the release's record the repository
answers HTTP 404: `--release-record` is the way then.

## 3. A wallet with SOL

```sh
solana-keygen new -o ~/.config/solana/deployer.json
solana config set --url mainnet-beta --keypair ~/.config/solana/deployer.json
solana address
```

Send SOL to that address. Most of what a deploy costs is rent for the program's bytes, which you get back if you
ever close the program:

```sh
solana rent $(wc -c < target/my_app/my_app.so)
```

For the counter that is about 0.080 SOL (rent is (128 + size) × 6,960 lamports at the current rate: 80,234,880
lamports for 11,400 bytes; the program data account holds 45 bytes more). During the deploy the program is first
written to a buffer account that holds the same amount again; it is returned when the deploy finishes. Fund about
twice the rent plus 0.01 SOL for fees: 0.17 SOL for the counter.

The public mainnet RPC is rate-limited; for deploys, set `--url` (or `solana config set --url`) to your RPC
provider's endpoint.

## 4. Deploy

```sh
npx --no-install typesol deploy --dry-run   # builds and prints the solana command it will run
npx --no-install typesol deploy
```

It runs `solana program deploy` at the address in `target/deploy/my_app-keypair.json`, with your wallet as payer and
upgrade authority, and prints the program id. Deploying again upgrades the program in place.

If a deploy stops part-way, the buffer stays behind with its SOL. The error prints the buffer's address; recover it
with `solana program close <buffer address>`, or list yours with `solana program show --buffers`.

## 5. Publish the IDL

```sh
npx --no-install typesol idl publish
```

It writes the IDL to the Program Metadata program, signed by the upgrade authority, where Anchor clients and
explorers look for it. It costs a few thousandths of a SOL of rent.

## 6. Verify

```sh
npx --no-install typesol verify my_app
```

`verify` rebuilds the program from `programs/my_app.ts`, reads the deployed one at the address in `typesol.json` from
the cluster in your Solana CLI config, and compares the bytes. `match` means anyone with your source and the same
TypeSOL version and toolchain gets exactly the program on chain (from 0.45.0 on, on any of the hosts measured: macOS arm64, Linux arm64 with the platform-tools `linux-aarch64` package as in [troubleshooting.md](troubleshooting.md#linux-arm64-the-agave-installer-fails-with-a-404), Linux x86_64; with 0.44.1 or earlier, a
program with 128-bit or signed division also needs the same kind of host). It also prints the upgrade authority and checks the IDL you published in step 5.

A match says only that the deployed bytes are what this source and this compiler build. It does not say that the
program, or the compiler, is correct, and it does not hold after the next upgrade: whoever holds the upgrade authority
it prints can replace the program at any time.

### Verifying someone else's program

With the source at the deployed commit, the program id and, ideally, the deployer's `<name>.build.json`:

```sh
git clone <repository> && cd <repository> && git checkout <commit>
npx --no-install typesol verify my_app --address <program id> --url mainnet-beta --docker --manifest my_app.build.json
```

`--docker` rebuilds in the same container recipe, built on your machine from the Dockerfile and checked inputs. The
TypeSOL version is the deployed build's (from the manifest whose binary hash is the deployed bytes'), or
`--typesol-version <v>`; months later, the current `@typesol/cli` installs the old version in the container, checked
against its release record. On a match it prints what was verified: the program, the source directory and its git
commit (and whether it has uncommitted changes), the TypeSOL version and tarball, the commit its record names and
where the record came from, the dependency lock and its sha256, the clang and platform-tools, the container's
Dockerfile sha256, base images and downloads, and the command that repeats it (with every option given that changes
the result: `--address`, `--url`, `--config`, `--sbpf`, `--manifest`, `--release-record`). A program built with
0.44.x on macOS or Linux arm64 that calls 128-bit or signed division does not match a `--docker` rebuild (those
versions' binaries depended on the host package; [troubleshooting](troubleshooting.md)). On a mismatch it shows the
toolchain of each side that is known, as without `--docker`. Exit codes: 0 match, 3 mismatch.

What this is not: the container is built locally from pinned inputs, not pulled from a published image, so the first
verification downloads the inputs and builds it. Its local image id can differ between machines; the Dockerfile's
sha256 and the pinned inputs are what to compare. The result is not registered with an external verified-build
registry: the evidence is the command and its output, which anyone can rerun.

## 7. Call it

`target/my_app/my_app.client.ts` builds the program's instructions on `@solana/kit`; see [client.md](client.md).

## Later

- **Upgrade it.** `typesol deploy` again replaces the code at the same address; the accounts keep their bytes. If an
  account struct changed, existing accounts do not match it: a field added fails with 3003, and a field removed from
  the middle or moved reads other fields' bytes without an error. Migrate the accounts ([migrating an
  account](language-accounts.md#migrating-an-account)).
- **Freeze it.** `solana program set-upgrade-authority <program id> --final` makes the program immutable. It cannot
  be undone.
- **Close it.** `solana program close <program id> --bypass-warning` returns the rent to the authority. The program
  id can never be used again.

A worked example: the official escrow, deployed to mainnet in TypeSOL, Pinocchio, native Rust and Anchor, with every
transaction linked, is in the README's [On mainnet](../README.md#on-mainnet) section.
