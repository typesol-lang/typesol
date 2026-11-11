# Contributing

Read [docs/architecture.md](docs/architecture.md) first: it maps the compiler and explains how to add a built-in,
a constraint or an error code.

## Setup

- Node.js 22.18+ for development (the scripts run `.ts` files directly; the published CLI itself needs 22.12+) and
  pnpm (`corepack enable`).
- The Agave CLI with platform-tools: install from https://docs.anza.xyz/cli/install, then run
  `cargo-build-sbf --version` once (it downloads platform-tools).
- `pnpm install && pnpm build && pnpm test`.
- Optional: `pnpm fetch:programs` (Metaplex programs for the Token Metadata / Core / Bubblegum tests),
  `pnpm build:twins` (Anchor twins for the differential tests; needs Rust + Anchor 1.0.2).

## Before a pull request

- `pnpm typecheck` and `pnpm test` pass; new behaviour has a test (a fixture under `test/fixtures/` run in LiteSVM,
  or a diagnostic case in `test/language/diagnostics.test.ts`).
- Changes to generated C: review `UPDATE_GOLDEN=1 pnpm test test/language/diagnostics.test.ts` output before committing it.
- Changes touching funds-related checks: add a negative test (the attack fails, with the expected error code).
- A language change that lets a PARTIAL port of program-examples get closer to the original: update the port
  and its row in [showcase/program-examples/README.md](showcase/program-examples/README.md).
- `pnpm smoke` against a local validator (`scripts/localnet.sh`) for changes to CPIs, deploy or IDL tooling.
- Changes to generated code or the runtime: measure them with [typesol-lang/benchmarks](https://github.com/typesol-lang/benchmarks)
  pointed at your checkout (`TYPESOL_REPO=<checkout> node run.ts` and `node official.ts`, after `pnpm build`), before
  and after, and put the difference in the pull request. When numbers move, refresh the README chart and table in the
  same change: `node scripts/readme-bench.ts <benchmarks>/results.json`.

## Versioning

TypeSOL follows the organization's [versioning and release policy](https://github.com/typesol-lang/.github/blob/main/VERSIONING.md).
For the compiler, before 1.0:
- a **minor** release (0.x → 0.y) may change the language surface (`lib/typesol.d.ts`), the account/IDL layout of
  generated programs, or error codes — always listed under "Breaking" in CHANGELOG.md;
- a **patch** release only fixes bugs without changing layouts or the meaning of valid programs.
The TypeScript dependency is pinned exactly: it decides what type-checks, so it only changes in minor releases.
Builds record the TypeSOL, TypeScript and clang versions in `<name>.build.json`.

Every change adds its entry under `## Unreleased` in CHANGELOG.md.

## Releasing

The organization's [release steps](https://github.com/typesol-lang/.github/blob/main/VERSIONING.md#releasing), for the
compiler:

1. Merge `develop` into `main` through a pull request with green CI.
2. On `main`: set `version` in `package.json`, rename `## Unreleased` in CHANGELOG.md to `## <version> — <YYYY-MM-DD>`
   (start a new empty `## Unreleased` above it), commit as `Release v<version>`.
3. Tag it: `git tag -a v<version> -m "TypeSOL <version>"`, push the tag, and create the GitHub Release from the tag
   with that CHANGELOG section as notes.
4. Publishing to npm (as `@typesol/cli`) is separate and manual, from a maintainer's machine with npm 2FA. Tags and
   GitHub Releases never publish on their own, and no workflow publishes.
   1. Run `pnpm test` on the tag (a clean clone of it; clean clones lack the fetch-only reference binaries, so run
      `bash scripts/fetch-programs.sh` first, or the showcase tests that need them fail).
   2. `node scripts/release-check.ts <version>`: it exports the tag with `git archive` into a temporary directory
      (never your working tree), runs `pnpm install --frozen-lockfile`, `pnpm build` and `pnpm lint` there, checks
      that `package.json` has the tag's version and that CHANGELOG.md has its `## <version> — <date>` section, packs
      the tarball and writes `releases/<version>.json` (the tag's commit, the tarball's size, sha1 shasum and sha512
      integrity, every file's sha256, and the Node, pnpm and npm versions used). It prints the tarball's path.
      `--tests` runs the suite there as well.
   3. Publish that tarball, not a folder: `npm publish <path printed above>.tgz --access public`. A tarball is
      published as it is (npm runs no scripts for it), so the bytes on the registry are the ones the check produced.
   4. `node scripts/release-check.ts <version> --verify --registry` compares the registry's `dist.shasum` and
      `dist.integrity` with the record and exits 1 on a difference. Commit `releases/<version>.json` to `main`
      ("Release record for v<version>"): it is the published package's description, kept with the sources.
   5. Build the release manifest (`node scripts/release-manifest.ts --out typesol-<version>-manifest.json`) and the
      binary diff against the previous release ([docs/testing.md](docs/testing.md#reproducing-a-release)), and attach
      both to the GitHub Release by hand.

## Code style

Match the surrounding code; comments explain why, not what. Product messages and docs are in English.
