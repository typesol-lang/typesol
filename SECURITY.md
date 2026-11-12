# Security

TypeSOL generates programs that hold funds. Treat it accordingly.

## Status

- The compiler, runtime and tooling have been through internal security reviews by the maintainers. The latest, of
  0.43.0 on 2026-11-11, found defects in the compiler (one of them can break an authorization check in a helper) and
  in the tooling; they are fixed in 0.44.0. **Rebuild and redeploy programs built with 0.43.0 or
  earlier once it is out**; [docs/security-model.md](docs/security-model.md#review-of-0430-2026-11-11) says how to tell
  whether a program was exposed, and [docs/audit.md](docs/audit.md#earlier-reviews) what that review did and did not
  cover. Every release is covered by execution tests, differential tests against Anchor, and randomized tests.
  **TypeSOL has not been audited by an independent firm.** Do not put significant value behind programs built with it
  until an external audit of the compiler and runtime is published, and audit your own programs as you would any
  Solana program.
- The tests cover binaries built with the toolchain a release declares as tested (Agave 3.1.10, platform-tools v1.52
  for this one). `typesol build` warns about another one, `--toolchain-strict` refuses it, and each build records its
  toolchain in `<name>.build.json`: keep that file with every deployment.
- From 0.43.0 on, `releases/<version>.json` records the published npm tarball (its shasum, integrity and every file's
  sha256), packed from a clean export of the release tag; `node scripts/release-check.ts <version> --verify --registry`
  compares it with the registry.
- Only the latest 0.x release receives security fixes, as fix releases (below).

## Fix releases

From 0.44.0 on, a release that only fixes soundness or security defects is published as a patch of the latest minor
release (0.44.0 → 0.44.1), so a team can take the fix without taking new features:

- it adds no language surface (nothing new in `lib/typesol.d.ts`, no construct accepted that was refused) and changes
  no account layout, IDL or error code beyond what the fix itself needs;
- a program it refuses or builds to another binary is one the defect touches, and the CHANGELOG says which;
- its release notes carry the binary diff against the previous release (the previous release's sources built by both
  packages, `typesol-<version>-binary-diff.txt`; see [docs/testing.md](docs/testing.md#reproducing-a-release)), so a team can see whether
  their program's binary changes.

Fixes go to the latest minor only; older minors are not maintained. A fix that needs a language or layout change
comes in the next minor. 0.44.0 itself is a minor release: besides the fixes from the 0.43.0 review it has behaviour
changes (new compile errors, `deploy` refusing to run without a cluster).
- What a compiled program can rely on is specified in [docs/security-model.md](docs/security-model.md); the package
  for an external audit is [docs/audit.md](docs/audit.md).

## Reporting a vulnerability

Please report privately, not in a public issue: use the **"Report a vulnerability"** button on
https://github.com/typesol-lang/typesol/security (GitHub private vulnerability reporting). Include a minimal TypeSOL program and the steps that show the problem.
We aim to acknowledge reports within 3 days and to ship a fix or mitigation for confirmed issues as fast as
their severity requires, with credit unless you prefer otherwise.

## What counts

Anything where a program compiled by TypeSOL behaves differently from its source and the documented semantics
in a way an attacker can use: missing or bypassable account checks, memory safety in the runtime, wrong
arithmetic, IDL/encoding mismatches, unsafe defaults in the CLI. Bugs in programs written with TypeSOL are the
responsibility of their authors, unless the language made the safe version impossible or misleading.
