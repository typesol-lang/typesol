# Changelog

TypeSOL follows the organization's [versioning policy](https://github.com/typesol-lang/.github/blob/main/VERSIONING.md)
(compiler specifics in CONTRIBUTING.md): until 1.0, a minor version may change the language, the IDL layout or error
codes, and says so here.

## Unreleased

First-run fixes, found by following the README in fresh `node:24-bookworm` containers (linux/amd64 and linux/arm64).
No program builds to other bytes: the generated C, IDLs and binaries are those of 0.45.0 (the release manifest's check
of test/golden/binaries.json, and the 76 programs of the sources built by 0.45.0 and by this release, are the same).

- Fixed: on Node.js older than 22.12 the CLI ran or crashed without saying why (on 20, `npm install` failed inside
  npm or the tests with `Map.groupBy is not a function`; on 22.11, `init`, `check` and `build` ran although `doctor`
  said 22.12 was needed). The `typesol` command is now `dist/bin.js`, which checks the version before it loads
  anything else and exits 1 with one line naming the version needed, the one running and where to get one
  (test/cli/node-version.test.ts; checked in `node:20-bookworm` and `node:22.11-bookworm` containers).
- Hints, text only (test/language/diagnostics.test.ts):
  - an `async` instruction returning `Promise<void>` got "instructions cannot be async or generators" with no hint,
    though the README promised one; it now has one (helper functions too);
  - `console` and other globals a program does not have (`process`, `Buffer`, `setTimeout`, `setInterval`, `fetch`,
    `window`, `document`) led with TypeScript's "Cannot find name 'console'. Do you need to change your target
    library? …"; the message is now "'console' does not exist in a Solana program", with the hint under it (in the
    editor too, through `typesol/ts-plugin`);
  - `Date.now()` where an integer is expected now points to `now()`, the cluster's clock, and
    `Math.floor(Date.now() / 1000)` (which was "unsupported call: Math.floor") says to use `now()`;
    `Math.floor`, `trunc`, `ceil` and `round` on their own point to integer division;
  - calling a cast imported with `type` (`import { type u64 }`, as the templates import it, then `u64(x)`) got
    TypeScript's "'u64' cannot be used as a value because it was imported using 'import type'" alone; the hint says
    to import it without `type`. The templates keep `type`: the hint is where the error is;
  - the missing-import hint covered the functions and constants `typesol` exports (`u64`, `require`, …); it now
    covers its types and interfaces too (`import { type Signer } from "typesol"`, `Mut`, `SystemProgram`, …);
  - a `number` field in account data got the list of allowed field types alone; it now has a hint naming the integer
    types (and a `Date` field, one about Unix seconds and `now()`).

## 0.45.0 — 2026-11-12

- New: a program builds to the same bytes on macOS arm64, Linux arm64 and Linux x86_64 (the programs and SBPF versions
  measured are below). Up to 0.44.1 the 10 programs of the sources that call 128-bit or signed 64-bit division linked
  platform-tools' compiler-builtins Rust library and built to a different binary on each host: its functions have the
  same instructions in the three host packages, but each package splits them into differently numbered archive
  members, so the linker placed them in another order and the calls into them had other offsets. Programs now link
  none of it. `runtime/typesol_builtins.c` defines every builtin the tested clang calls for C integer code on SBF
  (`__multi3`, `__udivti3`, `__umodti3`, `__divti3`, `__modti3`, `__ashlti3`, `__lshrti3`, `__ashrti3`, `__divdi3`,
  `__moddi3`: the set it references for SBPF v0, v1 and v2 for every arithmetic, shift, overflow and bit operation on
  every integer width, which test/language/builtins.test.ts compiles; the bit operations, counts of zeros and ones,
  byte swaps, ffs and parity, are inline), compiled with each program by its clang and linked after it. Division is new
  C that takes the shortest route for the operands' sizes; multiplication and shifts are, per SBPF version, the
  instructions compiler-builtins has for them, in assembly, so programs that use only those keep their bytes on SBPF
  v0. The exception is `__multi3` on v1 and v2, which is C (cheaper there: 175 compute units a call against 177.5 on
  average). A link that would leave the loader an undefined symbol other than the syscalls the SDK's headers
  (`@SYSCALL`) and the runtime header declare, and `abort`, is now an error (`SYSCALLS` in src/compiler/toolchain.ts,
  checked against both headers by test/cli/toolchain.test.ts, which also checks that the link fails and leaves no
  `.so`). With another clang than the tested one, which may call a builtin the tested one never does (0.44.1 linked it
  from compiler-builtins), the error first says that the toolchain is not the tested one and names
  `TESTED_TOOLCHAIN`. `<name>.build.json` lists `<runtime>/typesol_builtins.c` among the sources, and release manifests
  record its sha256 (`toolchain.builtins`); compiler-builtins' LICENSE.txt ships as
  `runtime/LICENSE-compiler-builtins.txt`, and NOTICE and the file's header give its licence expression
  (test/cli/repository.test.ts).
  Programs whose binary changes. For SBPF v0, the 10 that call division (each now the same on the three hosts): the
  Phoenix, Marginfi, Raydium AMM, Raydium CLMM, Raydium CP-Swap, Jito priority-fee distribution and SPL Stake Pool
  ports, transfer-fee, token-fundraiser and token-swap; the other 66 programs build to 0.44.1's bytes on each of the
  three hosts, and the generated C and IDL of all 76 are unchanged. For SBPF v1 and v2, programs that call division
  change too, and on v1 so do programs that multiply 128-bit or checked 64-bit values (`__multi3`): of the 14 programs
  of test/golden/binaries.json built on macOS arm64, all 14 have other v1 bytes than with 0.44.1, and 9 other v2 bytes
  (the 10 above but token-fundraiser, whose signed 64-bit division is an instruction on v2; counter, vault, escrow,
  multisig and token-fundraiser keep their v2 bytes); their C and IDL are unchanged. Division by zero is unchanged:
  TypeSOL checks every divisor before dividing and fails with 5101 (test/verification/fuzz-arith.test.ts); the
  builtins are never called with zero, and if one were it would stop with the VM's division-by-zero error
  (compiler-builtins leaves that case undefined: some of its calls returned a value). Compute units: in the showcase
  suites, each of the 18,085 transactions sent to a program whose binary changes (the ports above and two test
  programs) was also run against 0.44.1's binary on the same state; none costs more and 2,659 cost less (in total:
  Marginfi −5.1%, Raydium AMM −7.9%, CLMM −5.0%, CP-Swap −2.3%, Jito priority-fee −1.0%, Stake Pool −0.2%, Phoenix
  −0.004%, token-swap −0.5%, transfer-fee −0.4%, token-fundraiser −0.1%). `test/language/builtins.test.ts` runs
  every builtin as SBF in LiteSVM for SBPF v0, v1 and v2, against a BigInt reference and against compiler-builtins on the edge cases (0, 1, maxima, the signed minimum,
  powers of two and their neighbours, values with one half zero, divisors above the dividend) and a seeded random set
  (with the default seed, on v0, 84,741 to 91,289 calls per multiplication or division function and 59,506 per shift;
  on v1 and v2, 41,506 to 73,289), and requires every call to cost no more compute units than compiler-builtins'.
- Measured: what builds the same bytes where. With this release's compiler and platform-tools v1.52 on macOS arm64
  (native), Linux arm64 and Linux x86_64 (in containers; x86_64 is the `--docker` image): for SBPF v0, all 76 programs
  of the sources give the same C, IDL and binary on the three hosts; for SBPF v1 and v2, the 14 programs of
  test/golden/binaries.json do (v1 and v2 were not measured over all 76). With 0.44.1 (the npm tarball) on the same
  three, for v0, 66 gave the same binary and the 10 above three different ones (token-fundraiser: the two Linux ones
  agreed), which is what 0.44.0 gave too. README, docs/stability.md, docs/security-model.md, docs/audit.md,
  docs/mainnet.md, docs/testing.md, docs/cli.md and docs/troubleshooting.md say so. A program built with 0.44.0 or
  0.44.1 on macOS or Linux arm64 that calls 128-bit or signed division cannot be verified with `--docker` (the
  container gives the Linux x86_64 bytes of those versions); a 0.44.x install on the same kind of host verifies it
  (docs/troubleshooting.md).
- New: `typesol build --docker` and `typesol verify --docker` build in a pinned container, so that a third party can
  rebuild a deployed program from its source in the same environment. The container is made locally from
  `docker/Dockerfile`, which ships in the package with `releases/` and `docker/deps/`: linux/amd64 on every machine,
  the Node 24 and busybox base images by digest, the Agave 3.1.10 and platform-tools v1.52 release files by sha256,
  the TypeSOL version from npm with its tarball checked against `releases/<version>.json` (integrity, shasum, every
  file) before it is installed, and that version's npm dependencies (TypeScript, the compiler's front end, and
  `@solana/kit` with its tree) installed with `npm ci --ignore-scripts` from its lock, `docker/deps/<version>.lock.json`
  (npm checks every package against the lock's integrity; the lock must be for exactly the dependencies the checked
  tarball's package.json declares, every package from the npm registry with a sha512 integrity), and then the checked
  tarball's files placed as `node_modules/@typesol/cli` with no second resolution. The lock of version N ships in
  package N (`node scripts/release-check.ts <version> --lock`, a step of the release; the check of the tag refuses a
  release without it and installs it with `npm ci`); for a version newer than the package the image takes the one in
  that version's own tarball. The locks of 0.43.0, 0.44.0 and 0.44.1 were resolved from the registry on 2026-11-12,
  after those releases, so their integrity values are what npm served that day. Builds run without network or
  capabilities, with the sources read-only, as the caller's uid and gid (root for a root caller, whose output
  directories the container could not write otherwise). `<name>.build.json` records the container (platform,
  Dockerfile sha256, base images, downloads, tarball hashes, the commit the release record names, where the record came
  from and the sha256 of its bytes, the dependency lock and its sha256, local image id). An image is labelled with
  everything its build checked (the tarball's integrity and shasum, the record's commit, a hash of its file list, the
  lock's sha256), and a cached image whose labels differ from the record and lock given now is an error that names
  them, not a build reported with values that were never checked. The TypeSOL version is `--typesol-version`, else
  (verify) the deployed build's manifest's, else the CLI's; a project that installs another typesol than the one
  running is an error. The release record is the package's; for a release newer than the package (a release's own
  record is committed after it is published, so the package of version N never holds `releases/N.json`) it is fetched
  from the repository's main branch over HTTPS
  (`raw.githubusercontent.com/typesol-lang/typesol/main/releases/<version>.json`; HTTP 404 between the npm publish
  and the record's commit), said on stderr and recorded, so that the npm tarball is checked against a second, independent source (as with `--release-record <file>`, which passes one by hand; a record
  the package ships came from npm too). Offline or for a version without a record it is an error naming that option.
  A record needs its version, commit, tarball hashes and files. Versions before 0.43.0 have no record and are refused.
  On a match, `verify --docker` prints what was verified (source and git commit, TypeSOL tarball, the commit its record
  names and the record's origin, the dependency lock, toolchain, container inputs) and the command that repeats it,
  with every option given that changes the result (`--address`, `--url`, `--config`, `--sbpf`, `--manifest`,
  `--release-record`). Without Docker, with its daemon stopped or when the image build fails, it is an error: never a
  local build instead. No image is published, and nothing is registered with an external verified-build registry
  (docs/mainnet.md; test/cli/docker.test.ts: the record lookup with an injected fetch, the image cache with a fake
  docker, the Dockerfile's tarball and lock checks on crafted inputs, the uid mapping, and with `TYPESOL_DOCKER_TESTS=1`
  real container builds; running as root was not tested).
- A `--docker` build is up to date for `typesol test` (`npm test`) on any host while the program's sources, SBPF
  version and address are the ones its `<name>.build.json` records and its `.so` is the one recorded: the test runs the
  container's binary instead of rebuilding it locally because the manifest says linux/x64 (another TypeSOL version's
  runtime files are not compared). When the sources changed, the test rebuilds locally and says on stderr that it
  replaced a container build. `typesol build` without `--docker` and `typesol deploy` build locally, as before
  (docs/mainnet.md; test/cli/toolchain.test.ts).
- `toolchainDifferences` (and so `verify`'s mismatch hint) counts the host as a difference between builds of 0.44.1
  or earlier (whose manifests do not list the runtime's builtins), and `verify` says it may be the cause if the program
  uses 128-bit or signed division; between builds that link the runtime's builtins the host is not a difference when
  both are among the hosts measured (`MEASURED_HOSTS`: darwin-arm64, linux-arm64, linux-x64), and `host (not
  measured)` otherwise (test/cli/toolchain.test.ts).
- CI: the programs of `test/golden/binaries.json` (for SBPF v0, counter, vault, escrow, multisig and the 10 that call
  division; for v1 and v2, counter, escrow, Phoenix and Marginfi) must build to the C, IDL and bytes the build
  container gave, on every runner of the test job with Node 24: Linux x86_64 on pushes and pull requests (the
  container's host package, installed separately) and macOS arm64 when the macOS workflow runs
  (`scripts/release-manifest.ts --check`, which now fails on another binary on any host, and on a reference that lists
  no program, has an entry that did not build, or was made from uncommitted changes; `--docker` regenerates the file
  and refuses a tree with uncommitted changes, `--programs` limits a manifest to a set and `<path>:v1` or `--sbpf`
  builds for another SBPF version; test/cli/release-manifest.test.ts).
- `typesol doctor` has an optional `docker` row.
- Docs: the release assets are named with their version, `typesol-<version>-manifest.json` and
  `typesol-<version>-binary-diff.txt` (SECURITY.md, CONTRIBUTING.md, docs/testing.md, docs/stability.md). The
  README's first page names the eight ports checked against mainnet binaries, with instruction and transaction
  counts, before the examples; the quick start gives its commands before the toolchain notes; Status says what the
  November 2026 reviews found and how fix releases and release records work; the licence line matches NOTICE.

## 0.44.1 — 2026-11-11

Fixes from a second internal review, of 0.44.0 (docs/audit.md). Of the 76 programs of the 0.44.0 sources, 74 compile
to the same binary as in 0.44.0 and 2 to a different one (mint-close-authority and allow-block-list-token, below); no
program of those sources is refused.

- Fixed: `mint.create(…, { transferFee })` with a `null` (or run-time None) config or withdraw authority made a mint
  with fee 0 and no withdraw authority. Token-2022 reads a None COption as one byte and the compiler sent 33, so the
  32 zero bytes were read as the next fields. A None authority is now one byte, for `transferFee`'s two and
  `closeAuthority` (where Token-2022 ignored the extra bytes, now exact too); `initializeTransferFeeConfig` and the
  other wrappers already encoded it right. Programs using `transferFee` or `closeAuthority` in `mint.create` /
  `createIfNeeded` compile differently (transfer-fee to the same binary, mint-close-authority to another)
  (test/integrations/token-init.test.ts, decoded by the Token-2022 decoder for each authority null, constant and
  run-time).
- Fixed: a reference into account data held across a resize made through another parameter that may be the same
  account was not refused: with `a: Dup<Mut<Bag>>` and `b: Mut<Bag>` (or a read-only `a: Account<Bag>`, or a struct
  loaded with `loadAccount` / `loadAccountMut`) one account in both slots, `const e = a.entries.get(1n); b.tags.pop();
  e.score = v` wrote another record, and a `for (const x of a.entries)` loop read shifted fields. The reference rule
  now treats parameters that may be one account (a Dup pair, a read-only and a writable account of one type, a loaded
  struct) as one name for push, pop, clear and a helper given the account: such a program is a compile error, as with
  one name. Programs that hold no reference across the resize compile as before; none of the examples and ports is
  refused (test/security/dup.test.ts).
- Fixed: twelve token wrappers (approve, approveChecked, mintToChecked, burnChecked, setAuthority,
  updateTransferHook, updateInterestRate, transferCheckedWithFee, setTransferFee, initializeTokenGroup,
  updateGroupMaxSize, updateGroupAuthority) and the Stake program's split, authorize and withdraw read
  their signer seeds before an earlier argument ran: `approve(src, d, owner, next(st), ["vault", st.count, bump])`
  signed for the count before `next(st)` changed it. The seeds are now lowered after the other arguments when an
  argument runs code; calls whose arguments run none compile as before (test/integrations/tokenops.test.ts).
- Fixed: arguments read after later ones ran. The amount of `transfer`, `transferChecked`, `mintTo`, `burn` and
  `systemProgram.transfer` was read at the CPI, after a seed list that runs code (`["vault", next(st), bump]`); account
  text passed to `initializeMetadata`, `removeMetadataKey` and Metaplex `updateMetadataAccountsV2` (and that
  call's `primarySaleHappened` / `isMutable`) changed when a later argument rewrote it. Each is now read first, only
  where a later argument runs code, so other calls compile as before (test/integrations/tokenops.test.ts).
- Fixed: `mint.create` with extensions adding up to exactly 355 bytes (a Multisig's length) always failed: Token-2022
  sizes such a mint 357 bytes and refuses any other size. The mint is now made 357 bytes; `createIfNeeded` accepts
  that size already, and cannot reach 355 with the extensions it checks (test/integrations/token-init.test.ts).
- Fixed: `updateExtraAccountMetas` limited growth to 10 KiB past the account's current length instead of its length
  when the instruction started, so after `resizeAccount(metas, metas.dataLen + 10240n)` it could write past the room
  the runtime leaves, into the next account's record. It now counts from the length at entry (3016), in an
  instruction and in a helper. Programs that call it compile differently (allow-block-list-token, to another binary)
  (test/integrations/hook.test.ts).
- Fixed: the runtime grew a heap Vec (`ts_hvec_reserve`) through its own struct type while the program reads it
  through the generated one, which the C aliasing rules let the optimizer treat as unrelated (no miscompile was
  observed). The runtime's type is `may_alias`; no build flag changed, and no program of the 0.44.0 sources (heap Vecs
  included) builds to another binary (test/language/borsh-vec.test.ts).
- Docs: docs/security-model.md and docs/language.md say what `pythPrice` and `switchboardValue` leave to the author
  (the price's sign and zero, the confidence, a publish time or result slot in the future, rounding toward zero when
  scaling) and that Switchboard staleness counts from `result.slot`; the review of 0.44.0 is recorded in
  docs/audit.md and docs/security-model.md.

## 0.44.0 — 2026-11-11

Fixes from an internal review of 0.43.0, and the means to check a release. A helper's Pubkey, Option, string or u256
argument was not a copy when the helper was not inlined, so a check on a value the helper had just overwritten could
pass; a named seed list read its seeds when the CPI ran; the stale-reference rule was skipped for account-group fields
and loaded accounts; the Borsh decoder's length checks could wrap. **Programs built with 0.43.0 or earlier should be
rebuilt and redeployed** (docs/security-model.md says how to tell whether a program was exposed). New: the npm tarball
is packed from a clean export of the tag and recorded in `releases/`, the tested toolchain is declared and another one
warns, and fix-only releases come as patches from here on (SECURITY.md). Of the 76 programs of the 0.43.0 sources, 35
compile to the same binary as in 0.43.0 and 41 to a different one.

- Fixed: a Pubkey, Option, string or u256 argument of a helper was not a copy. The SBF backend passes such a value as a
  pointer to the caller's object, so a helper that was not inlined and wrote that object (`rotate(v, v.admin, caller)`
  with `v.admin = v.pending` inside) then read its own write through the parameter: a check on the old value passed on
  the new one. Whether it happened depended on inlining. The value now arrives by pointer, to a copy taken at the call
  whenever the helper can write (it takes accounts, remaining accounts or `Inout` places) and the value is not out of
  its reach (a local, an instruction argument, an account's key, the program id)
  (test/language/helper-copies.test.ts, inlined and `@noinline`).
- Fixed: a seed list bound to a name (`const s = signer(["vault", st.count, bump])`), given to a helper, or written
  beside an argument with side effects read its seeds when the CPI ran, so after `st.count += 1n` the program signed
  for another PDA than the one the source names. The seeds are copied where the list is written
  (test/language/pda-signers.test.ts).
- Fixed: the rule that a reference into an account is not used after a helper that may move its data was skipped when
  the account reached the helper as an account-group field (`grow(g.pool, g.payer)`) or as one loaded with
  `loadAccountMut`; such a program compiled and wrote through the stale reference. Both are refused like a plain
  parameter (test/security/aliasing.test.ts).
- Fixed: the Borsh decoder's length checks subtracted before comparing, so for an `Option` of a struct that itself
  holds an Option (or a Vec of such structs) a short buffer wrapped the subtraction and the read went past the end
  (up to the struct's size, read only). The checks no longer subtract, and a nested struct's smallest size is checked
  after its tag and for each element; `ts_alloc`, string appends and the stake history reader are written the same
  way (test/language/borsh-nested.test.ts).
- Fixed: a local read before a closure or list callback that changes it kept the new value (`x += bump()`,
  `two(x, bump())`); it keeps the value it had when read, as the left-to-right order promises
  (test/language/closures.test.ts). A string that views text inside an `Inout` place is copied for the helper that
  takes the place (test/language/inout.test.ts).
- Fixed: `close()`. Closing an account into itself is a compile error (`CloseTo<…, "self">`, `close(a, a)`), and 2040
  at run time in a helper whose two accounts may be one; `Dup<…>` is refused on an account the body closes; using an
  account after `close()` in the same instruction (its writes were dropped) is a compile error, its `.key` aside
  (test/security/dup.test.ts, test/language/diagnostics.test.ts).
- Language: `min` / `max`, `switch` and list indexes take a `u256`; a `u256` shift amount or exponent is a compile
  error (it was a C build failure); `x <<= n` and `x >>= n` take an amount of its own integer type, as `<<` does;
  `Ata<Init<TokenAccount>, "@acct.field", …>.create` is a compile error naming the form instead of C that does not
  build (test/language/pow.test.ts, test/language/diagnostics.test.ts).
- Of the 76 programs of the 0.43.0 sources, 35 compile to the same binary as in 0.43.0 and 41 to a different one:
  those with a helper that takes a Pubkey, Option, string or u256 (the parameter is a pointer now). counter, vault and
  escrow are among the 35. Measured against 0.43.0, the changed example programs move by at most 22 compute units
  either way, and no compared transaction of a port costs more than the original's.
- Docs: docs/security-model.md says what creation over an existing account returns (the System Program's custom 0;
  3000 is `initAccount<T>`), and docs/runtime.md names the cases that abort (`PANIC_ON_OVERFLOW`, `PANIC_STYLE`, a
  RedBlackTree whose bytes are inconsistent).
- CLI: generated `.mcp.json` / `.cursor/mcp.json`, the agent rules, hints and docs run the project's own copy with
  `npx --no-install typesol …` (or `npx @typesol/cli …` outside a project): plain `npx typesol` outside an installed
  project asks the registry for a package of that name, which does not exist. docs/migrate-from-anchor.md installs
  before running `port`.
- typesol/testing: `testProgram` reuses an up-to-date build (same sources, runtime, TypeSOL, TypeScript and clang
  versions), and builds of one program from parallel test workers wait for each other
  (`<out>/<name>/.typesol-build.lock`, taken over when its process is gone or after 15 minutes) instead of writing
  over each other's files.
- CLI: `typesol cpi` and `typesol port` check the IDL as `typesol client` does (identifiers, base58 addresses, byte
  lists) and keep IDL text inside escaped comments. A pre-0.30 Anchor IDL gets "run `anchor idl convert`" in all
  three, and a null or non-object IDL or a missing `instructions` list is refused with a message.
- Client: a type that holds itself through a Vec or an Option (`enum Shape { Rec { kids: Vec<Shape> } }`) gets a lazy
  codec; building it overflowed the stack. `u256` / `i256` are supported (bigint, 32 bytes LE), and
  `Option<Option<T>>` is `Option<T> | null` so Some(None) round-trips; one level more is left out with a note.
- CLI: `clone`, `client --address`, `verify` and `idl publish` time out RPC requests (30 s, `TYPESOL_RPC_TIMEOUT`) and
  report the host and cause as `doctor` / `deploy` do. `deploy` refuses to run without `--url` or a configured
  `json_rpc_url`, and `deploy` / `idl publish` print the cluster and payer before sending. A `--config` that does not
  exist is a usage error in `deploy --dry-run` and `doctor` too.
- CLI: `check --json` prints JSON for every outcome (a missing file, bad `--files` input). Printed `cd` and deploy
  hints quote paths. `build file.ts --program-id <missing>` explains instead of failing with ENOENT.
- Docs: docs/cli.md lists `typesol mcp` and every file `init` writes. docs/mainnet.md's counter size and rent are
  measured (11,400 bytes, about 0.080 SOL at 0.43.0). Case studies link to showcase sources on GitHub. docs/client.md
  describes which PDA seeds are filled in. docs/audit.md's figures come from `scripts/audit-stats.ts` (checked by the
  tests), its unreviewed range runs to 0.43.0, and macOS CI is on demand.
- Tests: the Phoenix and Stake Pool diff helpers compare account bytes without copying them twice or building hex
  strings unless they differ (phoenix-upstream peak RSS 1.53 GB → 0.77 GB), and the per-order market copies left in
  phoenix-cancel and phoenix-upstream are hoisted.
- Licences: NOTICE records the third-party code the package ships (lib-sokoban's red-black tree in the runtime
  header, MIT; SPL's big_vec layout and the Stake interface's activation function, Apache-2.0) and the Phoenix and
  SPL Stake Pool ports, and ships in the package with the Apache-2.0 text. Every showcase/mainnet file names its
  source and licence.
- CI: a program binary whose sha256 differs from test/programs/SOURCES.md fails the fetch step (Token Metadata is
  fetched from mainnet, the build the record names; Bubblegum's record is the build devnet runs now). All fetch-only
  binaries are cached, keyed on SOURCES.md. `CI_REQUIRE_ALL` turns a suite skipped for a missing binary into a
  failure (test/binaries.ts).
- Docs: docs/testing.md lists the SPL Stake Pool and Phoenix random walks and the red-black tree's trace replay
  against lib-sokoban among the checks against an independent oracle.
- Releases: `scripts/release-check.ts <version>` packs the npm tarball from a clean `git archive` of the tag (frozen
  install, build, lint, the version and CHANGELOG section checked; `--tests` adds the suite) and writes
  `releases/<version>.json`: the commit, the tarball's shasum and integrity as the registry reports them, and each
  file's sha256. The maintainer publishes that tarball (`npm publish <file>.tgz`) instead of a folder with
  `--ignore-scripts`, and `--verify --registry` compares the registry with the record afterwards. `npm pack` is
  reproducible: two clean packs of v0.43.0 and the published 0.43.0 are the same bytes (shasum 10c2883b…), recorded
  in releases/0.43.0.json (CONTRIBUTING.md, docs/testing.md).
- Toolchain: the toolchain the release is tested with is declared in one place (`TESTED_TOOLCHAIN`, exported from
  `typesol/compiler`: Agave 3.1.10, platform-tools v1.52, its clang 20.1.7 version line). A build with another clang
  (`build`, `deploy`, `verify`, `typesol/testing`, a reused up-to-date build too) prints one warning per process naming
  both and saying its binaries are not covered by the tests; `--toolchain-strict` on `build` and `deploy`, or
  `TYPESOL_TOOLCHAIN=strict` anywhere, makes it an error. `typesol doctor` has a `toolchain` row (tested, or untested
  with both versions; an error under strict), and its install hint is Agave 3.1.10 instead of "stable". CI runs
  `doctor` under strict, so the tests run on the declared toolchain (test/cli/toolchain.test.ts).
- Build manifests: `<name>.build.json` records `platformTools` (from the SDK's `platform-tools-<version>.md` marker
  and its link into the cache, when they agree) and `host` (`os`, `arch`) beside `clang`. A manifest without `host`
  (from 0.43.0 or earlier) makes the up-to-date check rebuild once instead of reusing the build; a different
  platform-tools or host rebuilds too. `scripts/release-manifest.ts` takes the platform-tools version from the same
  place (its path pattern found none).
- CLI: `typesol verify` on a mismatch prints the rebuild's toolchain (clang, platform-tools, host, TypeSOL) and the
  deployed build's when a build manifest's binary hash is the deployed bytes' (`--manifest <file>`, `<name>.build.json`
  next to a given `.so`, or the local build's), and which of them differ. A program on chain records no toolchain, so
  without such a manifest it says the deployed side is unknown and names the local manifest as describing another
  binary.
- Docs: the README's quick start installs the tested Agave and platform-tools exactly; docs/mainnet.md has "the
  toolchain you deploy with" (keep the build manifest with the deployment; `verify` needs the same toolchain);
  docs/troubleshooting.md explains the warning and verify mismatches; docs/cli.md lists the new flags and rows.
- Docs: docs/audit.md and docs/security-model.md record the internal review of 0.43.0 (2026-11-11): the defects above,
  what it covered (compiler semantics probes, the runtime and generated C, the tooling) and what it did not (the
  Metaplex and token CPI wrappers' emitters, oracles, SBPF v1/v2 builds, Windows); programs built with 0.43.0 or
  earlier should be rebuilt, and docs/security-model.md says how to tell whether a program was exposed to the helper
  argument defect. SECURITY.md and CONTRIBUTING.md add the fix-release rule (from 0.44.0 on, a release that only
  fixes soundness or security defects is a patch of the latest minor, with no new language surface and the binary
  diff in its notes; older minors are not maintained). docs/stability.md lists what a release gives today: the
  checked tarball, the tested toolchain, the build record, fix releases.

## 0.43.0 — 2026-11-11

Phoenix v1 ported in full, Ellipsis Labs' on-chain limit order book and a native program, from the commit a
reproducible build proves is the mainnet binary, and checked against that binary on 3,575 transactions and a seeded
random walk over two order books. The compiler gained what it needed: views at run-time offsets (`loadRawAt`,
`rawArrayAt`), a built-in red-black tree in lib-sokoban 0.3's byte layout (`rbTreeAt`), `Inout<T>` helper parameters,
byte builders on `FixedVec<u8, N>`, return data and compute-unit logs in native entries, `closeRaw`, Rust 1.14's panic
lines (`panicsAt`), constant expressions, type aliases and file-local structs. Of the 74 programs of the 0.42.0 sources,
68 compile to the same binary as in 0.42.0; Marginfi, multisig, Raydium AMM v4, Raydium CLMM, SPL Stake Pool and
favorites compile to a different one (the "Faster" entries below).

- Examples: showcase/mainnet/phoenix, a port of Phoenix v1 (Ellipsis Labs' on-chain limit order book at PhoeNiXZ8…, a
  native program, all 28 instructions), from the commit a reproducible build proves is the mainnet binary (c16694d,
  relicensed under MIT with its sources unchanged), checked against that binary on 3,575 transactions in five files
  (the original's 50 test functions mapped: 11 covered, 37 added as differential cases, 2 not applicable) and a random
  walk over two order books with a balance oracle, with the same outcomes, log lines, event batches, return data and
  account bytes; 13–61% of the original's compute units (up to 86% at the heap limits, with hundreds of account
  entries or a forwarding program's CPI; a PostOnly order 6,452 against 20,577, a swap of 30 fills 26,344 against
  61,313, cancelling 512 orders 434,446 against 760,087), 256,360 bytes against 1,344,472. Phoenix's 32 KiB bump heap
  is counted (showcase/mainnet/phoenix/heap.ts): each allocation is charged where the Rust makes it, so a transaction
  that fills the heap (many account entries, a CPI's larger instruction data) aborts at the same allocation, after the
  same log lines and batches; phoenix-limits.test.ts (162 transactions) compares both sides of each boundary, through
  a forwarding caller program where a CPI is needed. What Phoenix formats only when it fails is not charged, the one
  documented difference. A multiple-order packet passed through a CPI is decoded whatever its length, divisions by a
  zero tick size or base lot size panic at Rust's locations, and the clock's timestamp wraps as `as u64`. Its events
  are appended by `pushBorsh` of their literals: in the port, whose batch is an `Inout` parameter, a Reduce event costs
  47 CU less than the six `pushLE` calls it replaced (one room check instead of six; the 19 against 16 below is a local
  buffer). docs/case-study-phoenix.md.
- Tests: the Phoenix files keep every compared transaction's compute units and fail unless the port uses fewer on
  every one that succeeds (2,390 of the 3,575) and each compares exactly its expected count; the upstream cases pin
  every refusal to the original's error and message and make the original tests' own assertions on chain. The random
  walk draws its choices and keys from fixed seeds (1, 2 and 3, 300 steps on each market: 1,801 transactions), so a
  seed reproduces it, and requires minimum counts of fills, evictions, expiries and fees decoded from the events. The
  lib-sokoban traces are 21,650 operations (seeds 1–3, five key shapes, capacities 1 to 4096, fill and drain cycles).
- Language: a top-level integer constant may be an expression over literals and constants declared before it (in its
  file or an imported one): `const EVENT_ROOM = 1280n - 34n`, `const ASKS_AT: u64 = BIDS_AT + 2n * BOOK`, with
  `+ - * / % ** & | ^ << >>`, unary `-` and `~`. It is folded when the program is compiled and inlined like a literal.
  A typed constant is computed in its type, as Rust computes `const X: u64 = …`: every step must fit (`1n - 2n + 5n`
  as a u64 is an error naming the step); division by zero, a negative exponent and a shift past the width are compile
  errors too. Only literals were accepted (test/language/port-syntax.test.ts).
- Language: a struct that is not exported (`interface Pair { … }`) is its file's own: helpers take, return and change
  it (`Inout<Pair>`), locals hold it, and the IDL leaves it out. It failed with "structs must be exported" and a
  misleading second error about the helper's return type. Used where the IDL describes it (account data, an
  instruction's arguments or result, an event, an exported struct's field, a data enum's variant), it is one error
  naming the use and the fix, `export interface Pair` (test/language/port-syntax.test.ts). A non-exported account group
  is refused as before, with its own message.
- Language: a read-only native view can be read where it is made: `loadRaw<Header>(market).inner.b`,
  `loadRawAt<Prefix>(market, 576n).tick` and `rbTreeAt<K, V>(…).length` / `.capacity` ("unsupported property access"
  and "bind … to a const first" before). A writable view (`loadRawMut`, `loadRawMutAt`) is still bound first, now
  with the reason: it claims its account once per instruction (test/language/port-syntax.test.ts).
- Language: a local list may hold 2 KiB of elements, its FixedVec length word aside: `const ids: FixedVec<u32, 512> =
  fixedVec([])` (2,052 bytes, Phoenix's collected order ids) was refused. A frame that then overflows is still reported
  by the frame check, which names the biggest locals; the refusal of a bigger list now gives the element bytes and, on
  a declaration, the `/** @heap */` remedy (test/language/port-syntax.test.ts).
- Language: comma-separated updates in a `for` loop, `for (let i = 0n, j = n; i < j; i++, j--)`, run in order after
  each pass (`continue` included), and so do comma-separated assignments in its initializer; they were refused ("this
  expression has no effect"). A comma anywhere else still is (test/language/port-syntax.test.ts).
- Faster: `buf.pushBorsh<DataEnum>({ kind: "Reduce", … })`, a data-enum literal of a fixed-size variant, builds only
  that variant: its fields evaluated in source order into locals, then one room check, the tag and a store of each
  field at its offset (a variant holding a struct or FixedArray: one temporary of exactly its bytes and one copy). It
  zeroed, filled and copied the whole enum (92 bytes for Phoenix's PhoenixMarketEvent), then wrote the tag and the
  variant behind a switch on it: Phoenix's 35-byte Reduce event 54 → 19 CU against 16 for the same bytes by `pushLE`
  (test/language/phx-costs.test.ts, which also checks every field kind's bytes). Changes the generated C of programs
  that push data-enum literals (Phoenix, test/fixtures/byte-builders.ts), whose tests pass unchanged.
- Faster: a read-only struct, FixedArray or data-enum argument of a helper that also takes accounts is copied at the
  call only when it may be account data (a field of a view or of a loaded account), which the helper's writes could
  change. A struct parameter of a helper that itself takes accounts, an instruction's struct argument and return data
  are now passed in place like the caller's other owned structs (locals, helper results): they arrived as copies and
  no account write reaches them. Phoenix's book helpers now take their MarketShape as a plain struct, where they took
  it as `Inout<T>` only to avoid the copy (test/language/phx-costs.test.ts: 97.6 → 43.3 CU per call of a helper
  passing it on, test/language/helper-copies.test.ts). Changes the generated C of SPL Stake Pool, Marginfi and Raydium
  CLMM (a copy fewer at such calls), whose tests pass unchanged.
- Faster: the owner check of native account views (`loadRaw` / `loadRawMut`, `loadRawAt`, `rawArrayAt`, `rbTreeAt` and
  their Mut forms) remembers the last account it found this program's, until a CPI or an owner write (`assignOwner`,
  `closeRaw`, `close`) forgets it: the same account passes again with a pointer compare instead of a 32-byte one.
  Phoenix's helpers each view the market again, often in loops that write it, where clang could not drop the
  repeated compare (test/language/phx-costs.test.ts: a view per pass of a writing loop 21 → 15 CU, two views 35 → 21,
  a helper call taking the market 54 → 43). A view after the account changed hands still fails with 3007
  (test/language/owner-cache.test.ts: after assignOwner, closeRaw and a self-CPI that assigns it). Only programs that
  make such views carry the cache (`TS_OWNER_CACHE`, a pointer in TsParams); their generated C changes (SPL Stake
  Pool, Raydium AMM v4, Phoenix and the test fixtures that use views), and their tests pass unchanged.
- Faster: a RedBlackTree walk (`for (const e of tree)`, `tree.reversed()`) checks each node's index against the
  capacity once, when it steps onto the node, instead of three times, and keeps its stack by pointer: 59 → 40 CU per
  node for a walk summing a field of a 400-order book (test/language/phx-costs.test.ts; 18 CU less per node read-only).
  The same panics at the same points on a damaged tree (an index past the capacity, a cycle filling the stack; both
  now tested). Changes the generated C of programs that walk a tree (Phoenix, test/fixtures/rbtree.ts and
  rbtree-api.ts).
- New: `tree.removeAt(index)` on a RedBlackTree removes the node at that index (from `addrOf`, or a node's `.index`
  from `min` / `max` / a walk) with exactly the writes `remove(node.key)` makes, without searching the tree a second
  time: Phoenix's cancel finds the order, checks whose it is, then removes it (691 → 547 CU in
  test/language/phx-costs.test.ts). It gives the removed value, or null for index 0 or a node in no tree (a freed one,
  which is left as it is); past the capacity it panics as `nodeAt` does. The lib-sokoban trace replay runs a second
  time with every `remove(key)` as `removeAt(addrOf(key))`, and the bytes after each operation are still the crate's
  (test/verification/rbtree-trace.test.ts).
- New: room beyond one 4 KiB stack frame. `/** @noinline */` on a helper keeps it a C function of its own, so its
  locals get their own frame instead of the instruction's it would be inlined into (3 to 5 CU per call);
  `/** @heap */` on an instruction's list or struct local keeps it on the heap (one allocation per declaration,
  reused by a loop; 17 to 19 CU). A native port's entry holding a 1,284-byte log buffer could not also build a second
  one, or the order ids after its recorder's last CPI (test/fixtures/frames.ts: 4,672 bytes inlined). The frame-size
  error now lists the biggest locals from clang's frame layout (names and the source line near each; unnamed slots
  with the locals of the helpers inlined there) and names both remedies (test/language/stack-limit.test.ts).
- Language: plain type aliases, `type Price = u64` (or `Pubkey`, a struct, `FixedVec<u8, 32>`, `Point | null`, another
  alias), replaced by the type they name wherever they are used, so layouts and the IDL are the type's own; exported
  or not, imported from other files (the aliased type keeps its own file's import names). Every `type X = …` was taken
  for a data enum, and a union of named types (`type Event = Fill | Place`) failed with "each variant is an object
  type"; it now says to list the variants as object types or alias one type. Generic aliases and `null` among a data
  enum's variants are refused with what to write instead (test/language/aliases.test.ts).
- New: `const [address, bump] = findProgramAddressWithBump(seeds, program)`, Rust's `let (address, bump) =
  Pubkey::find_program_address(…)`: the canonical address and its bump from one search, where `findProgramAddress`
  and `findProgramAddressBump` searched twice (453 to 2,118 CU saved in test/language/pda-derivation.test.ts,
  depending on how many bumps the search tries). `[, bump]` keeps only the bump; any other use is a compile error
  showing the form.
- Language: a read-only `FixedVec<T, N>` (or `Vec<T>`) helper parameter takes the caller's own lists, as the language
  reference said helpers do: a local FixedVec, a FixedVec field of a local struct or of account data, passed as a view
  of its elements by pointer (nothing copied; a list in account data is copied first when the helper also takes
  accounts, as a struct argument is). It was refused ("expected a Vec<u8> instruction argument"), so ports wrote the
  helper with `Inout<T>`. A list with room for more than N elements is refused with the parameter to declare, and a
  list given for an `Inout` parameter of the same call too (test/language/list-params.test.ts).
- Faster: a local `FixedVec` is set up in about constant compute units. `fixedVec([])` of 1280 bytes zeroed the list
  twice (1,436 CU in test/language/fixedvec-setup.test.ts, now 152 with the rest of the instruction); `fixedVec([15n])`
  also built and copied a temporary (3,216 → 155); a FixedVec field in a struct literal zeroed and copied a temporary,
  doubling the stack (2,571 → 153). The free slots are now zeroed once, by the memset syscall from 128 bytes
  (`ts_memzero_bulk`), and the elements are written in place; `list = fixedVec([…])` still builds in a temporary (its
  elements may read the old list) but zeroes and copies it with the syscalls. The free slots stay zero, since a list's
  whole layout is copied into account data and events. Changes the generated C of programs with local FixedVecs
  (Phoenix, SPL Stake Pool, Marginfi, coral multisig, favorites and seven test fixtures), whose tests pass unchanged.
- New: `const ERROR_LOG_PREFIX = null` / `const PROGRAM_ERROR_LOG_PREFIX = null`: failures return their error and log
  nothing, as a native program's do when its own checks already logged (Phoenix). `ERROR_LOG_PREFIX = null` covers
  `require(…, MyError.X)` and codes computed at run time, `PROGRAM_ERROR_LOG_PREFIX = null` built-in ProgramErrors
  (`require(…, ProgramError.X)`, `loadBorsh`, views) and `programAt` / `sysvarAt`. With `""` a failure still logged
  "Program log: " plus the message; now it costs 105 to 124 CU less (test/language/quiet-errors.test.ts). Only these
  two constants may be `null`. Programs that do not use it compile to the same C.
- Language: `Inout<T>` helper parameters, Rust's `&mut T`. `function addEvent(rec: Inout<Recorder>, e: Event): void`
  gets the caller's place itself (a pointer, never a copy) and may change it; the caller sees the writes after the
  call, as JS shares an object passed to a function. `T` is a fixed-size struct, `FixedArray<T, N>` or
  `FixedVec<T, N>` (`push` / `pop` / `clear` included); the argument is a writable place: a local struct or list, a
  `loadBorsh` local, a field of a `Mut<T>` account or of a `loadRawMut` view, a list element, another `Inout`
  parameter. Until now helpers could only change accounts (`Mut<T>`), so ports inlined their mutating helpers (an
  order book's matching engine and event recorder cannot sensibly be inlined). At each call no other argument may
  share storage with an Inout one (two elements of one list count as one place), an element of a Vec or BigVec is
  refused when the call may move it, and a reference into the place read after the call is refused; places that may
  be one account only at run time (two `Dup` accounts, two `loadRawMut` views under `NATIVE_ACCOUNT_WRITES`) are
  compared before the call (2040). Integers, Pubkeys, strings and Options are refused with a hint (JS copies values
  too: return the new one, or keep it in a struct). About the compute units of the same code written inline
  (test/language/inout.test.ts). Writing to a read-only helper parameter now says to declare it `Inout<T>`.
  docs/language.md (`Inout<T>` parameters), docs/stability.md (Experimental; the open edge of helpers taking a
  writable struct that is not an account is settled). Programs that do not use it compile to the same C.
- New: `loadRawAt<T>(acct, offset)` / `loadRawMutAt<T>(…)`, a native account's struct at a byte offset known at run
  time, and `rawArrayAt<T>(acct, offset, capacity)` / `rawArrayMutAt<T>(…)`, a run-time number of elements in place
  (`get`, `set`, `.length`, `for … of`, the list methods). Bounds checked once when made (ProgramError::AccountDataTooSmall,
  overflow included); owner, writability and claim as `loadRaw` / `loadRawMut`.
- New: `rbTreeAt<K, V>(acct, offset, capacity, compare?)` / `rbTreeMutAt`, lib-sokoban 0.3's `RedBlackTree<K, V, N>`
  over account bytes, byte for byte (Phoenix's order books and seats): `get`, `insert`, `remove`, `min`, `max`,
  `addrOf`, `nodeAt`, `initialize`, `length`, `capacity`, `for … of` and `reversed()`. A comparator function orders
  the keys (called as `compare(searched, node)`), or Rust's derived order. Replayed against the crate itself with
  identical bytes after every operation: the committed test's 21,650 recorded operations (seeds 1–3, capacities 1 to
  4096, strides 32, 64 and 144; test/verification/rbtree/regenerate.sh), and, with the previous trace generator, a
  one-off run of 1,020,000 (capacities 1 to 512). sokoban's panics are logged as solana-program up to 1.17 logs a
  panic, with sokoban's messages and locations. Faster than the crate built with cargo-build-sbf at 4,096 entries
  (get 215 CU against 384, insert 595 / 742, remove 355 / 618).
- Native entries set their own return data and log compute units: `setReturnData(bytes)` (Rust's `set_return_data`,
  from a list of u8: a local `FixedVec<u8, N>`, account data, the instruction data or a slice) in a `@fallback` entry,
  its helpers and void instructions, and `logComputeUnits()` (`sol_log_compute_units`, the runtime's "Program
  consumption: N units remaining"), which were only emitted under `--profile`. An instruction that returns a value
  refuses `setReturnData` (its return value is its return data). Checked against the lines the Phoenix v1 binary
  writes.
- Native account lifecycle on remaining accounts and `AccountInfo` parameters: `closeRaw(account, receiver)` (Phoenix's
  Tombstone: lamports to the receiver, owner to the System Program, length to 0, in that order and without zeroing the
  data, ending as Phoenix's own Tombstone ends), `assignOwner(account, owner)` (`AccountInfo::assign`), and
  `resizeAccount` on remaining accounts (the 10 KiB growth limit against the size the entrypoint records when the
  instruction starts, as solana_program 1.14 records it). Checked writable, passed once and owned by this program, or
  left to the runtime under `NATIVE_ACCOUNT_WRITES`.
- Byte builders on `FixedVec<u8, N>` (a local list or one in account data), for byte strings a native program builds by
  hand: `pushLE(x)` (an integer at its width), `pushKey(key)`, `pushBorsh(value)` (Borsh, with the codecs `invoke`,
  events and `storeBorsh` use; object literals take their type, `pushBorsh<Header>({ … })`), `setLE(offset, x)` and
  `truncate(n)`, each bounds-checked (5104) with the length moved only when everything fit. Phoenix's event recorder
  written with them sends the same batches, byte for byte, as the Phoenix binary.
- Rust panics as solana-program 1.14 to 1.17 leave them: `export const PANIC_STYLE = "solana-1.14"` makes `panic(message,
  location)` log `panicked at '<message>', <location>` and abort ("SBF program panicked"), and `PANIC_ON_OVERFLOW`'s
  panics abort too; `panicsAt(location, expression)` makes the expression's checked arithmetic panic with Rust's
  messages ("attempt to add with overflow", "attempt to divide by zero", …) at the original's location instead of
  failing with 5100 / 5101, in either style. Checked line for line against the Phoenix v1 binary's panics (its
  entrypoint's assertion, and its overflow and remainder checks in initialize.rs and quantities.rs).
- Fixed: a tree comparator returning an unsigned integer (`function cmp(a: u64, b: u64): u8`) was accepted and could
  never report "less", so every search went one way and the tree was silently out of order. It is a compile error
  naming the type; a comparator returns a signed integer (test/language/rbtree.test.ts).
- Fixed: two writable views of one account's bytes through `loadRawMutAt`, `rawArrayMutAt` or `rbTreeMutAt` passed as
  two `Inout` arguments under `NATIVE_ACCOUNT_WRITES` were not compared at run time (only `loadRawMut` views were), so
  overlapping places reached the helper. They are compared before the call as `loadRawMut` views are: 2040 when they
  overlap (test/language/inout.test.ts, test/fixtures/inout-views.ts).
- Fixed: an `Inout` argument was compared at run time only with other `Inout` arguments, so a read-only argument that
  is the same bytes (`h(a.s, b.s)` with two `Dup` accounts that are one, a place of a writable account beside a
  read-only account that is the same, two native views) changed under the helper as it wrote. Every argument passed
  in place is now compared with the `Inout` one when their roots may be one account (2040 when they overlap); calls
  whose arguments cannot alias, and arguments copied for the call, are not compared, so no existing program changed
  (test/language/inout.test.ts, test/fixtures/inout-share.ts).
- Fixed: a tree node bound any other way than directly (`const e = c ? t.min() : t.max()`, `const v = t.get(k)!`)
  escaped the rule that a reference into a tree is not used after an `insert`; it compiled and could read a reused
  node. It refers to the tree like the direct form (`"e" still refers to t`), and binding one with `let` is refused
  (test/language/rbtree.test.ts).
- Fixed: a typed constant kept the value folded without its type, so `const T: u8 = ~1n` failed with "-2 does not fit
  in u8" although `~` within a u8 is 254. The value is the one folded in its type, and an untyped constant using it
  gets that value; out-of-range results are still refused (test/language/port-syntax.test.ts).
- Fixed: a problem with an aliased type (`export type Buf = BigVec<u64>` used as an argument in another file) was
  reported at the alias's declaration, once, instead of where it is used. Each use now gets its own report at the use
  (test/language/aliases.test.ts).
- Fixed: a view made before `closeRaw` or `resizeAccount` of its account (`const v = t.get(1n)!`, a `rawArrayMutAt`)
  could still be used after it, its bounds checked against the old length, so writes landed past the new end and reads
  were stale. Using one after either, or after a helper that may close or resize an account it is given, is a compile
  error saying to take the view again (test/language/raw-views.test.ts).
- Fixed: the rule that a `for … of` over a tree may not change its structure was kept per variable, so another view
  of the same tree (`const t2 = rbTreeMutAt(…same account and offset…)`) could remove from it during the walk. It is
  kept per account: no tree view of an account that may be the walked one's may insert, remove or initialize in the
  loop, nor may a helper that takes accounts and makes an `rbTreeMutAt` view be called there
  (test/language/rbtree.test.ts).
- Language: a reference into a local `FixedVec` (`const e = xs.get(0n)`) read after the element is replaced
  (`xs.set(0n, { … })`, `pop`, `clear`) is refused as one into account data is (`"e" still refers to xs[]`); before, a
  local FixedVec's elements had no storage path and the read compiled, seeing the new value where JS keeps the old
  object (test/language/fixedvec.test.ts). Such messages also name a `@heap` list as the source does (they printed its C
  name).
- Diagnostics: a node size that is not a multiple of 8 with a scalar value (`rbTreeMutAt<u64, u32>`) says to make the
  value a struct with padding fields, not to add padding to `u32`; the stack-frame report after an overflowing build
  reads clang's remarks without the 1 MiB output limit, which cut them short on large programs
  (test/language/rbtree.test.ts).
- Programs that use none of the new features above compile to the same C as before; the "Faster" entries name the
  programs whose generated C they change.

## 0.42.0 — 2026-11-09

SPL Stake Pool ported in full, the native program behind most liquid staking tokens, from the tag a reproducible build
proves is the mainnet binary, and checked against that binary on 2,107 transactions and a fuzz over epochs. The
compiler gained what it needed: Borsh accounts without a discriminator, `BigVec<T>`, typed CPIs on remaining accounts
(`programAt`, `sysvarAt`, `named`), the Stake program's split, merge and minimum delegation, native account writes,
the EpochRewards sysvar, local lists and the instruction data as a list; `typesol/testing` gained epochs and staking.
Every program that uses none of the new features compiles to the same binary as in 0.41.0.

- Examples: showcase/mainnet/spl-stake-pool, a port of SPL Stake Pool (the native program at SPoo1Ku8…, all 27
  instructions), from the tag a reproducible build proves is the mainnet binary (program@v2.1.0), checked against that
  binary on 2,107 transactions (the original's own 221 integration tests mapped and run as differential cases, pools of
  up to 20,000 validators) and a random walk over epochs with the same outcomes, log lines and account bytes; 19–80% of
  the original's compute units (the stake CPIs are the same in both), 202,240 bytes against 338,912.
  docs/case-study-spl-stake-pool.md.
- BigVec loops cost less an entry. A loop over a BigVec (`for … of`, the list methods, a slice) becomes a C function
  of its own, given the variables it uses: inside a large function it shared SBF's registers with everything held
  across it, and clang spilled its pointer and totals every step. `retain` over structs walks the elements with one
  pointer. SPL Stake Pool's UpdateStakePoolBalance sum costs 16 CU an entry (was 31; the original 27) and its cleanup's
  retain 5 (was 11; the original 9), so both fit the default 200,000 units wherever the original does. The heap
  buffers such a loop takes on first use (an event's, an element copied for a helper) stay declared in the function
  it came from, so they are taken once however many times the loop runs; a loop that formats a Pubkey moves too.
  Programs without a BigVec compile to the same C.
- `panic(null, "src/lib.rs:105:19")` panics at a location without logging a message, for a native port whose panic
  handler writes none; `abort()` is Rust's abort on SBF (the allocator's out-of-memory error), the runtime's `abort`
  syscall: "SBF program panicked", no location.
- A ternary between accounts, `const source = ephemeral ? rest.get(5n) : reserve`: remaining accounts, locals and
  `RemainingAccount` helper parameters bound to one, and `AccountInfo` parameters; only the chosen side runs, and the
  result goes wherever a remaining account does (typed CPIs, `readData`, `loadRaw`, `loadBorsh`, helpers).
- Local lists on the stack: `const metas: FixedVec<Meta, 4> = fixedVec([{ pubkey, isSigner, isWritable }])`,
  `fixedVec([])`, `FixedArray<T, N>` locals, structs and `FixedString<N>` elements (also in `fixedArray<T, N>(fill)`),
  at most 2 KiB each (a compile error naming the size); `fixedArray(…)` written inline feeds a chain, a list method or
  `for … of`.
- New: `FixedVec.pushAll(items)`, a bulk append (a memcpy: about 0.01 CU a byte for 1000 bytes, against 11 for a loop
  of `push`), 5104 when it does not fit. Declared on `Vec` as well so a Vec still passes for a FixedVec; calling it on
  a Vec is a compile error.
- The instruction data is a list: `for … of`, the list methods, `data.slice(start, end?)` (a view; 5104 out of range,
  where JS would clamp) and `InstructionBytes` helper parameters.
- `invokeInstruction` in helpers (with their `RemainingAccounts` parameter), with metas and data from local lists, a
  `FixedArray`, the instruction data or a slice of it: a native port's instruction builder, metas naming accounts by
  key.
- `NATIVE_ACCOUNT_WRITES` (no change in behaviour, now tested and documented): a second `loadRawMut` of one account at
  the same position is allowed with the flag (2040 without), and `loadRaw` reads what `loadRawMut`, `storeBorsh` or a
  BigVec push wrote, with or without it.
- New: `named(account, address)`, a Stake CPI's sysvar or stake config argument as solana_program's stake builders
  and `invoke_signed` give it: the instruction names the address, the slot's account is the account info. The runtime
  looks the address up among the CPI's accounts only, so a slot holding another account fails with MissingAccount, as
  the original does, even when the sysvar is elsewhere in the transaction.
- New: `loadBorsh<T>(acct)` / `storeBorsh(acct, value)`, a native program's Borsh account (no discriminator; SPL Stake
  Pool's `StakePool`) read into a local struct and written back from byte 0, as Rust's `try_from_slice_unchecked` and
  `serialize` do: trailing bytes ignored, the bytes after a shrunk value left as they were, invalid bytes or a value
  that does not fit failing with `ProgramError.BorshIoError`. Without `NATIVE_ACCOUNT_WRITES` the account written must
  be writable (3006) and passed once (2040: not also another declared or remaining account), as the other writes
  check. A straight-line decoder and encoder per struct, no heap
  (a 611-byte `StakePool`: about 280 CU to read, 610 CU to read and write back). Programs that do not use them
  compile to the same C as before.
- New: `BigVec<T>`, SPL's `big_vec` for native ports (the stake pool's validator list): the last field of a `loadRaw`
  struct, sized by the account; `push`, `retain`, `slice` (`deserialize_mut_slice`), `get` / `set`, `for … of`, the list
  methods and `.capacity`, with big_vec's bytes and errors (AccountDataTooSmall). Every access is bounded by the
  account's room as well as the length (the capacity computed once at the load), so a length written again after the
  load (writeData, another view, storeBorsh) never reaches past the account. Other programs compile to the same C.
- `typesol/testing`: epochs and staking. `warpToEpoch` / `nextEpoch` move the Clock consistently (epoch, slot, leader
  schedule epoch, timestamps); `StakeCluster` keeps a cluster-like StakeHistory over one or more LiteSVMs, so warmup
  and cooldown are rate-limited as on a cluster (it refuses a history with a gap or an entry for an epoch that has not
  ended, when made and at each warp); `stakeActivation` ports the Stake program's activation math;
  `createVoteAccount`, `createStakeAccount`, `delegateStake`, `readStakeAccount`. Checked to the lamport against the
  Stake program in LiteSVM (docs/test-your-program.md#epochs-and-staking).
- New: `programAt<P>(account)`: a remaining account (or an `AccountInfo` parameter) checked to be that program (one key
  compare; ProgramError.IncorrectProgramId otherwise) with P's typed methods, for `StakeProgram`, `SystemProgram`,
  `TokenProgram`, `Token2022Program`, `TokenInterface`, `AssociatedTokenProgram` and `MemoProgram`; bind it, call it
  inline or pass it to a helper taking that program. `sysvarAt<StakeHistorySysvar>(account)` likewise.
- Typed CPIs (System, Token / Token-2022, ATA, Memo, Stake) take remaining accounts and `AccountInfo` parameters for
  any account, as native ports need; declared parameters keep their compile-time checks, remaining accounts are left to
  the runtime and the called program. `returnData` takes a remaining account as the program.
- Stake program: `split`, `merge`, `getMinimumDelegation()` (fails as solana_program's `get_minimum_delegation`),
  `initialize(…, lockup?)`, and the lockup custodian for `authorize` / `withdraw`. Existing calls compile to the same C.
- New (language surface: `epochRewards()` and the `EpochRewards` type in lib/typesol.d.ts): the EpochRewards sysvar
  through `sol_get_epoch_rewards_sysvar`, Rust's `EpochRewards::get()`, with no account: every field
  (`active`, `totalRewards`, `distributedRewards`, `totalPoints`, `numPartitions`, `parentBlockhash`,
  `distributionStartingBlockHeight`). Other programs compile to the same C.
- New: a struct, data-enum or `fixedArray<T, N>(fill)` literal as a helper argument (`applyFee({ denominator: 100n,
  numerator: 3n }, amount)`, nested literals, a ternary with a literal branch, helpers in other files), built as
  `const fee: Fee = { … }` would be; it failed with "expected a Fee". Other programs compile to the same C.
- Fixed: an `Option<Pubkey>` (or `Option<Hash>`) in a template string or `+` was refused ("only strings, integers,
  booleans and Pubkeys can be joined into text") even after `x !== null`; it joins as the base58, or `null` when
  empty, as JS prints it (as Options of integers and booleans already did). Other programs compile to the same C.
- New: `export const NATIVE_ACCOUNT_WRITES = true` (opt-in, for native ports): `loadRawMut`, `storeBorsh` and BigVec
  writes skip the up-front writability check (3006) and the one-claim-per-account refusal (2040) and take a plain
  `AccountInfo`; the runtime reports a changed read-only account (`ReadonlyDataModified`), and an account passed twice
  is two views of one buffer, as in a native program. Lamports, `loadAccountMut`, CPIs and `Mut<…>` checks unchanged;
  see docs/language.md#porting-a-native-program for the trade-off. Programs without it compile to the same C.

## 0.41.0 — 2026-11-07

TypeSOL for AI coding agents, and Raydium CP-Swap ported in full. `typesol init` writes the rules an agent needs
(AGENTS.md, CLAUDE.md, Cursor's rules) and an MCP server configuration; `typesol mcp` gives agents check, IDL and docs
search as tools; `llms.txt` / `llms-full.txt` put the docs in one file for models. Raydium CP-Swap now has all 21 of its
instructions, checked against today's mainnet binary with a fuzz test. Programs that do not log a narrowed Option
compile to the same C as in 0.40.0.

- AI agents (docs/ai.md): `typesol init` writes AGENTS.md, CLAUDE.md and Cursor's rules (what TypeSOL refuses that
  TypeScript habits produce, how to check and test) and the MCP server's configuration (.mcp.json, .cursor/mcp.json).
- New: `typesol mcp`, a Model Context Protocol server on stdio with the tools `check` (diagnostics with hints, from a
  file or source text), `idl`, `docs` (search) and `rules`. No new dependencies.
- New: `llms.txt` and `llms-full.txt` (the rules, the quick start and the reference in one file), built from the docs by
  `scripts/llms.ts`, shipped in the npm package; the tests fail when they are out of date.
- CLI: `typesol check --json` gives each error's hint as a `hint` field (it stays the message's last line too).
- Fixed: `log(x)` of an Option that TypeScript narrowed to its value (after `x === null` was ruled out) generated C that
  did not compile; it logs the value now, and a possibly-null Option is refused with what to do instead.
- Examples: showcase/mainnet/raydium-cp-swap ports all 21 of Raydium CP-Swap's instructions (was 10): `initialize_v2`,
  `initialize_with_permission`, `collect_creator_fee`, `collect_creator_fee_permissionless`, the permission, creator
  fee share and supported-mint accounts (create and close), and `collect_excess_lamports`. Checked against the binary
  on mainnet today (deployed 2026-10-31; test/programs/raydium_cp_swap.so updated): 136 transactions (was 70) with
  the same outcomes, account bytes and events, Raydium's five signing keys replaced by test keys in both so the admin
  instructions run too, and a fuzz test (random swaps, deposits, withdrawals and fee collections in an SPL Token
  and a Token-2022 pool); an exact-output swap for the whole vault now panics as the original does instead of failing
  with 5100. 42–85% fewer compute units; 214,944 bytes against 749,848. docs/case-study-raydium-cp-swap.md.
- Docs: docs/stability.md, what 1.0 will promise, what is stable already and what is still experimental, and what to
  settle first; the audit package's line counts and its list of unreviewed changes brought up to 0.40.0.

## 0.40.0 — 2026-11-06

Raydium AMM v4 ported in full, a native (non-Anchor) program, and checked against its mainnet binary down to its log
lines and panics. The compiler gained what a native program needs: accounts without a discriminator, the instruction
data read by offset, errors from code 0, built-in program errors, panics with a location, and the entrypoint's log
lines. Also: functions chosen at run time, `find(…)!.field` / `?.field` on struct lists, struct maps inside chains, and
hints under the errors newcomers meet first, in the CLI and the editor. Programs that use none of the new features
compile to the same C as in 0.39.0.

- Examples: showcase/mainnet/raydium-amm, a port of Raydium AMM v4 (the native program at 675kPX9M…, all of its
  instructions: Initialize2, deposits, withdrawals, the v1 and v2 swaps base in and base out, P&L, parameters, the
  config, excess lamports), checked against the mainnet binary (test/programs/raydium_amm_v4.so) on 484 transactions,
  fuzzed: the same outcomes, account bytes and log lines, ray_log records and the original's panics included; swaps
  take 41–44% of the original's compute units, deposits and withdrawals 35–37%. See docs/case-study-raydium-amm.md.
- New (native programs; docs/language.md "Porting a native program"): `loadRaw<T>` / `loadRawMut<T>` for accounts
  without a discriminator; `readU8/U16/U32/U64/U128/readPubkey(offset)` on `instructionData()`; error enums from code 0
  (returned as CUSTOM_ZERO); `require(c, ProgramError.X)` for Solana's built-in errors; `panic(message, location?)`;
  `PANIC_ON_OVERFLOW`, `ERROR_LOG_PREFIX` and `PROGRAM_ERROR_LOG_PREFIX` program constants; `createProgramAddress`;
  `logBase64(prefix, struct)`.
- Fixed: `isqrt` of a u256 (it generated C that did not compile).
- New: a function chosen at run time, `const g = k === 1n ? dbl : inc; g(x)` (the condition read once; only the chosen
  function runs), and a list of functions run in turn, `for (const f of [dbl, inc]) …` (unrolled; `continue` and `break`
  work).
- New: `xs.find(f)!.field` and `xs.find(f)?.field` on lists of structs (located with findIndex, read in place; `!` aborts
  with 5108 when nothing matched, `?.` gives an Option).
- New: `map` to structs inside a chain when the callback names the struct, `xs.map((o): Scored => ({ … })).filter(…)
  .reduce(…)`: one struct per element, nothing stored.
- Hints: comparing an integer with a number (`k === 1`) points at `1n`. `.length` on something that is not a list says
  what it is instead of asking for byteLength; the FixedVec argument/account refusal says why (two byte layouts, one IDL
  type).
- Docs: the README's quick start ends with a first change to make and a short "where next" list (it was one long
  paragraph); the showcase lists Marginfi v2 as complete and links every case study.
- Editor: the plugin (`typesol/ts-plugin`) adds the same hints under TypeScript's errors in a program's files, once the
  in-process compiler has loaded, so VS Code shows what to write instead too.
- CLI: `typesol init` names the other starters (`--template vault`, `--template escrow`) after the next steps.
- CLI: build errors show the path relative to the working directory and the source line with the problem marked.
  `--json` and the compiler API keep their fields (a hint is a line of the message).
- New: hints for the errors newcomers meet first, under TypeScript's message: a number where a u64 is (`1n`), `Math.max`
  (`min` / `max`), `console.log` (`log`), a missing `typesol` import, `async`, writing an account that is not `Mut<T>`,
  `xs[i]` (`.get` / `.set`). Refused syntax is named in TypeScript's words ("classes are not supported: …") instead of
  the compiler's internal node names, and `require` with a template string says what its error can be.
- Docs: Marginfi's case study lists part 5 as done (all 124 instructions); troubleshooting points to the hints.
- Releases: `scripts/release-manifest.ts` builds the program-examples ports of sources up to 0.38.0 (`test/ports/`; a
  0.38.0 tree listed only 18 programs). docs/testing.md and CONTRIBUTING describe the manifest and binary diff as attached
  by hand.

## 0.39.0 — 2026-11-06

Marginfi v2 ported in full: all 124 instructions, checked against the mainnet binary on 2,081 transactions with the
same outcomes, account bytes, events and IDL. The compiler gained what it needed: `Option` struct and `Vec`
arguments, `f64` fields, hashes as PDA seeds, account resizing and raw writes, `systemProgram.createPda`, and Anchor's
order and error codes for `init` and zero-copy accounts. The ports moved to `showcase/`. The repository now lives at
github.com/typesol-lang, and releases are published by hand (no workflow publishes).

Upgrading: the IDL writes `Vec<u8>` arguments and account fields as `bytes`, as Anchor does, so an Anchor client
passes a Buffer for them (the bytes on the wire are unchanged). Accounts created at the start of an instruction now
run before the other accounts' constraints, and zero-copy accounts are checked in `AccountLoader`'s order, so a
transaction that breaks several checks can fail with a different error code; programs with such creates or zero-copy
accounts compile differently (see "Changed" below).

- Project: no scheduled or publishing automation in the repository: npm releases are published by hand from a
  maintainer's machine (the release workflow is gone), the macOS suite runs on demand only, and Dependabot no longer
  opens weekly pull requests.
- Examples: Marginfi's rebalances across Kamino, Drift and JupLend banks, each leg priced at the venue's supply rate
  (klend's curve and reward emissions at the chain's measured slot pace, Drift's curve less its insurance factor,
  JupLend's liquidity-layer rate and Lending rewards), amounts through the venues' exchange rates, deposit room capped
  by the venue's own. Against the binary on mainnet: 2,081 transactions (with the fixes and tests below).
- Fixed (examples): a classic liquidation by Marginfi's risk admin flags both accounts as the original does, so their
  Exponent PT banks are priced through a vault emergency there too.
- New: `systemProgram.createPda(payer, account, space, owner, seeds)`, Anchor's `init` with `owner = …` on an
  `UncheckedAccount`: another program's account at this program's PDA, created (or, over an address someone funded
  first, topped up, allocated and assigned) before the instruction's constraints, the PDA recorded in the IDL.
- Examples: Marginfi's I80F48 magnitudes widen to u256 once (their sum stays in u128) and a float's bit length is
  found by halving, not bit by bit: a classic liquidation takes 7% fewer compute units (130,448 → 121,210 on the
  test's partial liquidation; 38% under the original's).
- Tests: a `TYPESOL_PROFILE=1` build's VM has no 1.4M compute limit and keeps every log line, so `typesol profile`
  sees a whole Marginfi liquidation (its markers took it past both before).
- Examples: more of Marginfi's venue paths against the binary: Kamino and Solend deposits and withdrawals of disabled,
  frozen and paused accounts, Kamino's receivership, deleverage, group outflow limit and deleverage day's limit branches
  and its bank's `has_one` accounts, and the risk admin deleveraging an Exponent PT through a vault emergency.
  (`*DepositFailed` / `*WithdrawFailed` guard against a venue that moves other amounts than asked; the venues' own
  programs never do, so they stay untested.)
- New: an optional account in `invoke`'s list, as it is (`readonly(x)` with `x: A | null`), is left out when it was not
  passed (Rust's `if let Some(..)` pushes).
- Fixed: a `constraint(acct, …)` that mentions another, optional account runs when that account is missing (it was
  skipped, so `x === null` checks never failed); only `acct` itself being optional and missing skips it. Declared
  constraints (`HasOne` and the like) still run only when the optional accounts they name were passed.
- Fixed (examples): Marginfi's `drift_withdraw` refuses a withdrawal from a Drift user with admin deposits when the
  reward accounts are missing (6321), as the original does, and passes any combination of the six optional reward
  accounts on to Drift (the port refused all but some).
- Fixed (examples): Marginfi's `solend_init_obligation` initializes an obligation address someone funded first (Anchor's
  `init` tops the rent up, allocates and assigns), and creates it before all its other checks, as the original does. The
  Solend fuzz holds every transaction to the original's error code; a withdrawal with a debt, where the original fails
  borrowing the bank (AccountBorrowFailed), must fail with the port's error 12.
- New: `epochStartTimestamp()`, when the current epoch began (the Clock's `epoch_start_timestamp`).
- Examples: Marginfi's pricing, every oracle setup: staked SOL (a single pool's stake per LST, before and after its
  on-ramp), mSOL (Marinade's rate) and LSTs (an SPL or Sanctum stake pool's), Scope entries, Exponent PTs (linear to
  par, capped by redemption, emergency mode honoured except where the original prices through it), and fixed venue
  prices, each also inside Kamino and JupLend banks where the original has that kind. Setting a fixed venue price
  checks the venue's account. Against the binary on mainnet: 1,936 transactions.
- Examples: Marginfi's Drift and JupLend banks (`lending_pool_add_bank_drift`, `drift_init_user`, `drift_deposit`,
  `drift_withdraw`, `drift_harvest_reward`, `drift_claim_bad_debt`, `lending_pool_add_bank_juplend`,
  `juplend_init_position`, `juplend_deposit`, `juplend_withdraw`) over Drift v2, Drift's bad-debt Merkle distributor
  and JupLend's lending, liquidity and rewards programs, and their pricing: the feed times the spot market's
  cumulative deposit interest or the Lending's token exchange price. All 124 of Marginfi's instructions are now ported
  (pricing fixed venue banks and venue rebalance legs still stop in the port).
  Against the binary on mainnet: 1,798 transactions, the same IDL for all 124. The venue tests now hold a refused
  transaction to the original's error code, not only to failing.
- New: `Owner<Account<T>, "…">` is another program's struct account (Anchor's `Account` / `AccountLoader` of a
  `declare_program!` type): loaded with that program as its owner (3007), `HasOne` and fields as for this program's.
- New: such a struct may have a discriminator of 1 to 8 bytes (`/** @discriminator 0x01 */`, as Anchor's
  `discriminator = &[1]`), its fields starting right after it.
- Fixed (examples): Marginfi's Solend, Kamino and Drift banks load the venues' accounts as the original's
  `AccountLoader`s do, before any constraint (a foreign account is 3007, not the bank's `has_one` error); setting a
  venue bank's oracle checks its reserve, spot market or Lending again; a Drift scaled balance past u64 is 4102 and a
  Drift deposit limit past I80F48 6004, as in the original. The venue tests now fuzz deposits, withdrawals, borrows,
  repayments and the venues' rates against the original (FUZZ_SEED, FUZZ_STEPS).
- New: an `Address<AccountInfo, "…">` parameter may be `invoke`'s program (Anchor's `address = ID` on an
  `UncheckedAccount`; the key alone is checked, 2012).
- Examples: Marginfi's Solend and Kamino banks (`lending_pool_add_bank_solend`, `solend_init_obligation`,
  `solend_deposit`, `solend_withdraw`, `lending_pool_add_bank_kamino`, `kamino_init_obligation`, `kamino_deposit`,
  `kamino_withdraw`, `propagate_kamino_market_emergency`, `kamino_harvest_reward`) over Solend's, klend's and kfarms'
  mainnet programs, and their pricing: the Pyth or Switchboard feed times the reserve's exchange rate in the risk
  engine, the price cache keeping the rate as its multiplier, the circuit breaker watching the multiplied price, a
  Kamino emergency taking the collateral's Initial value. Against the binary on mainnet: 1,601 transactions, the
  same IDL for all 114 ported instructions.
- New: `Ata<TokenAccount, "@acct.field", "mint">`, the associated token account of a Pubkey stored in a struct
  account; the IDL names the account, as Anchor's does for `acct.load()?.field`.
- Fixed: an instruction that reads the Clock (`now()`, `currentSlot()`, `currentEpoch()`) in a `constraint(…)` and
  again in its body failed to compile (the Clock cache was declared twice, or after the constraint that used it).
- Examples: Marginfi's staked SOL (`init_staked_settings`, `edit_staked_settings`, `propagate_staked_settings`,
  `disable_staked_oracles`, `enable_staked_oracle_onramp`, `lending_pool_add_bank_permissionless`,
  `lending_pool_backfill_staked_bank_validator_vote_account`) and `lending_pool_configure_bank_oracle_scope`. Against
  the binary on mainnet: 1,440 transactions, the same IDL for all 104 ported instructions.
- New: `writeData<T>(account, offset, value)`, a little-endian write into a `Mut<AccountInfo>` of this program
  (bounds-checked); `resizeAccount(account, newSize)`, Rust's `AccountInfo::resize` (the length only, new bytes
  zeroed, no rent moved, at most 10 KiB of growth).
- `Dup<…>` may name the twin of a close destination (a keeper settling its own record): duplicates share one record,
  so the rent reaches it either way. The closed account itself is still refused as a twin.
- Examples: Marginfi's rebalance execution (`marginfi_account_start_rebalance`, `end_rebalance`,
  `settle_rebalance_tip`, native banks), account resizing (`lending_pool_resize_group_account`,
  `lending_pool_resize_bank_account`, `resize_global_fee_state`) and the monitor archive
  (`monitor_archive_initialize`, `monitor_archive_upsert_batch`). Against the binary on mainnet: 1,396 transactions,
  the same IDL for all 96 ported instructions.
- Fixed: an event's fields go out in the order declared, as Anchor's Borsh sends them (a `Vec<T>` field went last,
  after the fixed-size fields as account data stores it), and the IDL lists them so.
- Examples: Marginfi's rebalance orders, kept: `marginfi_account_place_rebalance_order`, `update_rebalance_order`,
  `close_rebalance_order`, `top_up_rebalance_fee_pool`, `withdraw_rebalance_fee_pool`. Against the binary on mainnet:
  1,314 transactions, the same IDL for all 88 ported instructions.
- Examples: Marginfi's order execution, `marginfi_account_start_execute_order` and
  `marginfi_account_end_execute_order` (a sandwich: the executor withdraws and repays in between). Against the binary
  on mainnet: 1,265 transactions, the same IDL for all 83 ported instructions.
- New: `Option<Vec<T>>` event fields (given `null`, such an argument or a list), and a nested struct written as a
  literal in an event goes out as Borsh (its Options one byte when empty), as Anchor emits Marginfi's
  `SetKeeperCloseFlagsEvent`.
- New: a `Hash` is a PDA seed (its 32 bytes).
- Examples: Marginfi's orders, placed and closed: `marginfi_account_place_order`, `marginfi_account_close_order`,
  `marginfi_account_set_keeper_close_flags`, `marginfi_account_keeper_close_order`. Against the binary on mainnet:
  1,221 transactions, the same IDL for all 81 ported instructions.
- New: `Option<Vec<T>>` instruction arguments (or `Vec<T> | null`, or of a FixedVec; Anchor's `Option<Vec<u8>>`): a
  tag byte, then the Vec when Some; `x !== null` before reading it as a list or passing it to a helper that takes the
  list.
- IDL: `Vec<u8>` arguments and account fields are `bytes`, as Anchor writes them (were `{ vec: "u8" }`; the bytes on
  the wire are the same, but an Anchor client now wants a Buffer for them).
- Examples: Marginfi's bank metadata (`init_bank_metadata`, `write_bank_metadata`, `write_bank_metadata_pre_init`) and
  `lending_pool_clone_bank` (which panics in the mainnet build, as the original does). Against the binary on mainnet:
  1,170 transactions, the same IDL for all 77 ported instructions.
- Faster: a struct a function holds itself (a literal, or what a helper returned) passes to a helper that takes
  accounts in place instead of being copied first (only account data can change under a helper); a struct literal
  fills a new `const` directly instead of a temporary; `fixedArray<T, N>(fill)` may be a struct field's value in a
  literal. Programs with struct literals build to different binaries: here raydium-clmm and marginfi (a Marginfi
  withdrawal 2,700 compute units fewer, a health pulse of an empty account 3,400).
- New: `/** @bytes */` on a FixedArray of integers: the IDL shows each as its bytes (Marginfi's
  `HealthCache.prices: [[u8; 8]; 16]`, written as 16 u64s instead of 128 bytes).
- Repository: `pnpm test:core` no longer runs the showcase tests too (a path filter of `test` matched
  `showcase/test`); CI's compiler and showcase jobs now split the suite between them.
- Examples: Marginfi's bank administration, part three: `lending_pool_emissions_deposit` (refusing fee and hook
  mints, as the original does), `lending_pool_init_same_asset_emode_registry` and
  `lending_pool_set_bank_same_asset_emode_eligibility`. Against the binary on mainnet: 1,140 transactions, the same IDL
  for all 73 ported instructions.
- Examples: Marginfi's bank administration, part two: `lending_pool_configure_bank_gov`,
  `lending_pool_collect_bank_premium_fees`, `super_admin_deposit` and `super_admin_withdraw` (which panic in the
  mainnet build, as the original does). Against the binary on mainnet: 1,084 transactions, the same IDL for all 70
  ported instructions.
- Examples: Marginfi's bank administration, part one: `lending_pool_configure_bank_emode`, `lending_pool_clone_emode`,
  `lending_pool_configure_bank_premium`, `lending_pool_clear_circuit_breaker`, `lending_pool_backfill_bank_is_t22_flag`
  and `lending_pool_close_bank`. Against the binary on mainnet: 1,061 transactions, the same IDL for all 66 ported
  instructions. 45–96% fewer compute units.
- New: instruction arguments of type `Option<S>` (or `S | null`) for a fixed-size struct S, as Anchor's
  `Option<WrappedI80F48>`: Borsh (a tag byte, then S when Some), validated on entry like struct arguments (102),
  `{ option: { defined } }` in the IDL, read after `x !== null`. Helpers still take the struct itself.
- Examples: Marginfi's group and fee state administration: `config_group_fee`, `edit_global_fee_state`,
  `edit_fee_state_premium`, the panic pause (`panic_pause`, `panic_unpause`, `panic_unpause_permissionless`),
  `marginfi_group_set_governance_admin`, `marginfi_group_configure_gov`, `configure_bank_rate_limits`,
  `configure_group_rate_limits`, `update_group_rate_limiter` and `lending_pool_configure_group_premium`. Against the
  binary on mainnet: 1,024 transactions, the same IDL for all 60 ported instructions. 68–97% fewer compute units.
- Examples: Marginfi's account administration: `marginfi_account_set_freeze`,
  `marginfi_account_update_emissions_destination_account`, `sync_indexer_flags`, `transfer_to_new_account`,
  `transfer_to_new_account_pda` and `admin_close_account`. Against the binary on mainnet: 955 transactions, the same IDL
  for all 48 ported instructions. 38–86% fewer compute units.
- Examples: Marginfi's flash loans, the start of part 5 of the port: `lending_account_start_flashloan` (the end
  instruction found through the Instructions sysvar) and `lending_account_end_flashloan` (the deferred health check,
  premium rates and the breaker's gate). Against the binary on mainnet: 915 transactions, the same IDL for all 42
  ported instructions; the fuzzer runs flash loans too. 40–52% fewer compute units.
- Examples: Marginfi decodes its rates' u32 encodings in 64-bit arithmetic (no 128-bit division): accrual 45–73%
  fewer compute units than the original (was 39–73%), 1,000–4,000 fewer on liquidations and bank configuration. The
  receivership and deleverage tests now send the banks in the order the instructions between start and end leave
  them, so their successful cases succeed on every run; the costs in docs/case-study-marginfi.md are re-measured
  (receiverships 30–40% fewer, not 29–45%).
- Examples: Marginfi's deleverage, which completes part 4 of the port: `start_deleverage` and `end_deleverage` (the
  risk admin's receivership, any account, health may not fall), `configure_deleverage_withdrawal_limit`,
  `update_deleverage_withdrawals`, `lending_pool_force_tokenless_repay_complete` and `purge_deleverage_balance`.
  Against the binary on mainnet: 890 transactions, the same IDL for all 40 ported instructions; the fuzzer
  deleverages too.
- Examples: Marginfi's receivership liquidation (part 4 of the port): `start_liquidation` and `end_liquidation`, the
  account's health and its banks' prices locked at the start and its health at those prices at the end (the premium
  cap, a close-out under $5, the tag's growing premium, the record's entries, the flat SOL fee), the transaction's
  instructions checked as the original checks them. Against the binary on mainnet: 847 transactions, the same IDL for
  all 34 ported instructions; the fuzzer runs receiverships too. 29–45% fewer compute units on receivership
  transactions.
- Examples: Marginfi's classic liquidation (part 4 of the port): `lending_account_liquidate`, the liquidatee's
  collateral taken at a discount for its debt, the insurance fund's cut sent from the liability bank's vault, the
  liquidatee's tag after it, the liquidator's health over its own accounts and its premium seeded, a halted bank left
  to the admins, Token-2022. Against the binary on mainnet: 803 transactions, the same IDL for all 32 ported
  instructions; the fuzzer liquidates too. 34–39% fewer compute units on liquidations.
- Examples: Marginfi's liquidation records and bankruptcy, the start of part 4 of the port:
  `marginfi_account_init_liq_record`, `marginfi_account_tag_liq_record` (a liquidatable account tagged, the health
  cache from the Maintenance pass), `marginfi_account_close_liq_record` and `lending_pool_handle_bankruptcy` (the
  insurance vault first, Token-2022 fees included, the rest socialized, a bank killed when nothing is left). Against
  the binary on mainnet: 736 transactions, the same IDL for all 31 ported instructions; the fuzzer tags and settles
  bankruptcies too. 44–52% fewer compute units on bankruptcies, 45% on a tag.
- Examples: Marginfi's borrows and health pulses, which completes part 3 of the port: `lending_account_borrow`
  (origination fees, the premium check, rate limits after health) and `lending_account_pulse_health` (three passes
  keeping what each gets to, the indexer flags, the event with the cache). Against the binary on mainnet: 687
  transactions, the same IDL for all 27 ported instructions; the fuzzer borrows and pulses too, and its keys now come
  from its seed, so `FUZZ_SEED` reproduces a run exactly. 41–47% fewer compute units on borrows, 15–64% on pulses.

- New: helpers take the remaining accounts as a list. A `RemainingAccounts` parameter (`remainingAccounts()` at the
  call) gives the helper `.length` and `.get(i)` over the same accounts, to read, load or pass on to another helper,
  as a risk engine walks one [bank, oracle] group per position.
- Examples: Marginfi's withdrawals and risk engine (part 3, docs/case-study-marginfi.md): withdrawals of part or all
  of a deposit, with the account's Initial health over Pyth, Switchboard and fixed prices (oracle errors recorded or
  failing as the original's, e-mode and same-asset e-mode, the isolated tier, the deposit cap's discount), premium
  projection and rate snapshots, the circuit breaker's gate, the liquidation tag, rate limits, receivership,
  deleverage and Token-2022. Against the binary on mainnet: 177 new transactions (595 in all, an account with 16
  positions among them), the same IDL for all
  25 ported instructions, and the random runs withdraw through the risk engine; 33–84% fewer compute units on the
  withdrawals that succeed. The fuzzer found how the original records an undecodable oracle's error in the health
  cache (0, the variant's index, not 6000).
- Fixed (Marginfi example): the oracle port below had made I80F48 products cost more (an accrual 26,983 compute units
  instead of 25,296): with three functions multiplying 256-bit values, clang stopped inlining the multiplication.
  The checked and wrapping products now hand everything that cannot overflow to the plain one.

- New: helpers take remaining accounts. A `RemainingAccount` parameter (`remainingAccounts().get(i)` at the call)
  gives the helper the account's key, owner, lamports and data length, `readData` at any offset, and `loadAccount` /
  `loadAccountMut` of a struct; a read-only view sees what the instruction already wrote through the same account, and
  a `loadAccountMut` claims the account for the rest of the instruction (a second one fails with 2040).
- New: `require(condition, code)` with a `u32` code computed at run time fails with that code (a helper that returns
  its error as a value, as Rust's `?` passes one on: `require(r.err === 0n, r.err)`); a zero code fails with 5100.
- Examples: Marginfi's oracles (part 3 of the port, docs/case-study-marginfi.md): pointing a bank at a Pyth push or
  Switchboard pull feed, fixed prices, and the price cache pulse with the circuit breaker (tiers, escalation, the long
  window, breaking a bank). Against the binary on mainnet: 174 new transactions over Pyth and Switchboard accounts
  written byte for byte, the same IDL for all 24 ported instructions, and the random runs set oracles and pulse prices
  through the breaker; 47–84% fewer compute units on the ones that succeed.

- Repository: the ports moved out of `examples/` and `test/` into `showcase/`: `showcase/mainnet/` (Raydium CP-Swap
  and CLMM, Jito's MEV programs, Marginfi, coral-xyz/multisig), `showcase/program-examples/` (was `test/ports/`) and
  `showcase/test/` (their tests, fuzzers, helpers and fixtures). `examples/` keeps the small programs the templates
  come from. CI runs the compiler's tests (`pnpm test:core`) and the showcase (`pnpm test:showcase`) as separate jobs.
  The release manifest and the codegen snapshot read both layouts, so older tags still build.

- Faster: `u256` multiplication (and so I80F48 products, `mulDiv`) multiplies only the 32-bit limbs that are not
  zero: two 88-bit values take 9 products instead of 64. A Marginfi I80F48 product went from about 700 to about 380
  compute units, and an interest accrual from 30,292 to 25,296 (against the original's 41,642); across Marginfi's
  successful transactions the port now uses 36–97% fewer compute units than the original (24–97% before). Programs that use
  `u256` or `mulDiv` build to different binaries: here examples/raydium-clmm and marginfi.
- New: a narrowed `Option` of a struct or fixed array (`args.inner !== null` before it) passes straight to a helper
  that takes the struct or array.

- Examples: Marginfi's repayments and fees, which completes part 2 of the port (docs/case-study-marginfi.md):
  repayments in part (the premium settled first) and in full (rounded up, the balance closed), tokenless repayments by
  the risk admin, collecting a bank's fees, and the admin and permissionless withdrawals from its fee and insurance
  vaults. Against the binary on mainnet: 244 transactions (63 new) with the same outcome, account bytes and events, the
  same IDL for all 21 ported instructions, and the random runs repay and move fees too; 24–97% fewer compute units on
  the ones that succeed.
- Changed: a token account or mint parameter that is an empty system account (never created) fails with
  AccountNotInitialized (3012), as Anchor's `Account` / `InterfaceAccount` checks it, before the owner check (3007).

- Examples: Marginfi's accounts and deposits (part 2 of the port, docs/case-study-marginfi.md): opening accounts as
  keypairs and PDAs, deposits (SPL Token, and Token-2022 with the transfer fee added), closing balances and accounts.
  Against the binary on mainnet: the same outcome, account bytes and events on 181 transactions now (66 new), the same
  IDL for all 16 ported instructions, and the random runs cover them; 27–97% fewer compute units on the ones that
  succeed.
- Faster: Pubkeys and hashes are ordered eight bytes at a time (`a.compare(b)`, the Merkle proof check). A Marginfi
  balance close, which sorts the account's balances, went from 6,610 to 1,865 compute units. Programs that compare
  keys or hashes build to different binaries: here examples/raydium-cp-swap, raydium-clmm, jito-mev's two
  distribution programs and marginfi.
- New: an Option argument with a default as a seed, `tag ?? 7n`, is recorded in the IDL as Anchor records
  `tag.unwrap_or(7)`, and `typesol client` and `typesol/testing` derive such PDAs. Fix: `typesol client` refused an IDL
  with such a seed (Marginfi's on-chain one).

- Examples: Marginfi's group and bank administration (part 2 of the port, docs/case-study-marginfi.md): eleven
  instructions, from the fee state and groups to adding banks (SPL Token and Token-2022, with or without a seed),
  configuring them (operational states, curves, liquidation fees, the circuit breaker, e-mode checks, frozen banks)
  and accruing interest with the group's, insurance and program fees. Checked against the binary on mainnet
  (test/programs/marginfi_v2.so): the same outcome, account bytes and events on 115 transactions, and on random runs
  (`test/verification/fuzz-marginfi.test.ts`); 27–97% fewer compute units on the ones that succeed.
- Changed: the creates an instruction's body starts with now run before the other accounts' constraints, as Anchor
  creates `init` accounts first. A transaction that breaks both fails with Anchor's code (Marginfi's fuzzer found one:
  adding a bank at a taken address, signed by someone else). Programs that start with a create and have other
  constraints compile differently: here examples/raydium-cp-swap, raydium-clmm, jito-mev's two distribution programs
  and eleven ports under test/ports/tokens; their tests against the mainnet binaries pass as before.
- Changed: accounts of a zero-copy type (`@serialization bytemuck`) are checked as Anchor's `AccountLoader` checks
  them: the owner first (3007, also for an account never created, where `Account<T>` gives 3012), then a
  discriminator to read (3001, new) and match (3002), then the size (3003). No other program here has such an account,
  so only examples/marginfi compiles differently from this.
- New: `Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">` checks the sysvar's address as
  Anchor's `address = …` constraint does (2012, in constraint order) instead of 3008; another address there is a
  compile error.

- Repository: a NOTICE for the third-party material the tests use (Apache-2.0 program binaries in test/programs, with
  the licence text, and the Marginfi and Raydium fixtures); a test that every committed binary is the one SOURCES.md
  records (sha256); `scripts/fetch-programs.sh` reports fetched binaries whose hash differs.
- New: `f64`, a 64-bit float held as its IEEE bits, for event and account fields (`f64FromBits`, `f64Bits`; the IDL
  says `f64`). No float arithmetic.
- New: `Option<FixedArray<T, N>>` fields (Anchor's `Option<[u16; 3]>`), readable after narrowing with `.get(i)` or
  copied whole into a `FixedArray` field.
- New: structs holding Options at any depth (Anchor's `BankConfigOpt`, an `Option<InterestRateConfigOpt>` inside it)
  are Borsh where they travel: in instruction arguments, and in `@layout borsh` events and accounts that hold them.
  Their C layout stays fixed; the IDL describes them as Anchor's. Programs without such structs compile as before.
- `typesol port`: f64 fields, Borsh events for headers holding Options, data-enum `repr`; Marginfi's whole on-chain
  IDL ports with every type and instruction argument as on chain, apart from seven instructions whose arguments are
  an Option of a struct, an array, bytes or a Vec (not supported yet).
- Fix: a `Vec<FixedArray<T, N>>` argument (Anchor's `Vec<[u8; 32]>` proof) no longer fails in code generation.
- The repr(C) offset check applies to bytemuck zero-copy types and what they hold, not to repr(C) structs that only
  travel as Borsh.

- Releases: each GitHub Release gets a manifest (`scripts/release-manifest.ts`): compiler and toolchain versions, the
  sha256 of every example's and port's binary, IDL and C, the reference binaries and the test corpus. It also gets the
  previous release's sources built by both packages, with their diff, so "the same binaries" can be checked and
  redone by anyone (docs/testing.md). 0.37.0 → 0.38.0, checked by hand: all 67 programs of the 0.37.0 sources build to
  the same binary and IDL.
- Examples: examples/marginfi begins a port of Marginfi v2 (mrgnlabs/marginfi-v2 @ c5d440f6, Apache-2.0; on mainnet
  as MFv2hWf3… with the same 124 instructions, version 0.1.12 in its on-chain IDL). This first part has no
  instructions yet: its 255 errors (from the on-chain IDL), its I80F48 fixed-point arithmetic and its 12 zero-copy
  accounts with the 32 types they hold. The arithmetic gives the bits the `fixed` crate (1.28.0) gives, checked
  against vectors that crate wrote (test/fixtures/marginfi/i80f48-oracle) and on random values. The accounts read
  mainnet's group, a bank and the fee state as Anchor decodes them, and the IDL describes all 44 types as the
  on-chain IDL does.
- New: `/** @code 6200 */` on an error enum member gives it that code, the members after it continuing from there
  (Anchor's `Variant = 200`). `require("…")` errors come after the highest code. `typesol port` keeps an IDL's codes
  this way.
- New: `/** @repr c */` (`packed`, `align N`; `@repr rust` on enums) and `/** @serialization bytemuck */` put an Anchor
  zero-copy type's repr and serialization in the IDL. An unpacked `@repr c` struct must have its fields where C puts
  them; a field that C would pad is a compile error.
- New: `/** @bytes */` on an integer field shows it in the IDL as `[u8; N]` (an `i128` for Marginfi's
  `WrappedI80F48 { value: [u8; 16] }`); `/** @idlName _pad0 */` names a field in the IDL where the source cannot (a
  leading underscore); a `key_` or `lamports_` field is `key` / `lamports` in the IDL. `typesol port` writes these
  tags from the IDL, so a ported zero-copy account's IDL is the original's.
- New: a `loadAccountMut` view declared in a loop body ends with its iteration, so a later iteration may load the
  same account again. `loadAccountMut<Dup<T>>` there also lets a remaining account be passed more than once, one view
  at a time (without `Dup<…>` a repeat is still refused, 2040). Raydium CLMM's `swap_router_base_in` uses it: routes
  back through a pool now run as on mainnet (two more transactions in its differential test). Only programs with
  `loadAccountMut` in a loop compile differently (here examples/airdrop.ts and examples/raydium-clmm).

- Tests: random transactions against the mainnet binaries. `test/verification/fuzz-jito.test.ts` drives Jito's three
  MEV programs and their ports through random tips, receiver and builder changes, epochs, roots, Merkle claims and
  closes (with injected faults); Raydium CLMM's differential test adds a random run of swaps, positions and liquidity
  changes. Every step must match the original (outcome, account bytes, events, log lines), with a new seed on every
  run, CI's included (`FUZZ_SEED` reproduces one).

## 0.38.0 — 2026-11-01

Raydium CLMM ported in full, and Jito's three MEV programs ported, each checked against its mainnet binary. The
compiler gained what the Jito programs needed: stored bumps in nested struct fields, Anchor's names for arguments
that share an account's name, and error members without messages. Programs that use none of these compile to the
same binaries as in 0.37.0.

- Examples: examples/raydium-clmm now ports all 37 of Raydium CLMM's instructions. Added: the customizable pools,
  the v1 and v2 positions with Metaplex NFTs, `close_position`, `swap` and the multi-hop `swap_router_base_in`, the
  five limit order instructions, the reward instructions, and the admin instructions (configs, operators, dynamic fee
  configs, support mints, pool status, `collect_excess_lamports`). The differential test runs the admin instructions
  too, with Raydium's admin key swapped for a test key in both programs: 300 transactions, the same outcomes, account
  bytes and events, 33–84% fewer compute units.
- Examples: examples/jito-mev, ports of Jito's three MEV programs (tip payment, tip distribution, priority fee
  distribution; all 24 instructions), checked against the mainnet binaries (test/programs/jito_*.so) on 150
  transactions: the same outcomes, account bytes, events and log lines, with 58–79% fewer compute units (up to 95% on refused calls). The tip
  payment port follows the binary on mainnet, which is the program of Jito's #143 (no `claim_tips`). See
  docs/case-study-jito-mev.md.
- New: a `Seeds<…>` bump stored in a struct field of another account, `"@config.bumps.vault"` (Anchor's
  `bump = config.bumps.vault`).
- New: an error enum member with an empty message, `X = ""`, has no `msg` in the IDL (an Anchor variant without
  `#[msg]`).
- IDL: an instruction argument named like one of its accounts plus a trailing underscore (`authority_` next to an
  `authority` account) keeps the account's name in the IDL, as Anchor names such an argument.
- Typings: `Hash.compare(other)`, the byte order of two hashes (-1, 0 or 1), which the compiler already supported.

## 0.37.0 — 2026-10-31

Raydium CLMM ported and checked against the mainnet binary, with what it needed: `u256`, big-endian seeds,
accounts loaded in the body and seed lists picked at run time. Programs that use none of these compile to the same
binaries as in 0.36.0.

- Examples: examples/raydium-clmm, a port of Raydium CLMM's pools, positions and swaps: `create_amm_config`,
  `create_pool`, `open_position_with_token22_nft`, `increase_liquidity_v2`, `decrease_liquidity_v2`, `swap_v2`,
  `collect_protocol_fee` and `collect_fund_fee`, with its math in u256 and u128 and its account layouts byte for byte.
  Swaps work on any pool the original runs (dynamic fees, limit orders filled at a tick, fee modes, rewards, the
  tick array bitmap extension, Token-2022 transfer fees). Checked against the mainnet binary
  (test/programs/raydium_clmm.so) on 166 transactions, including a pool cloned from mainnet: the same outcomes,
  account bytes and events, with 43–83% fewer compute units. See docs/case-study-raydium-clmm.md.
- New: big-endian integer seeds, Rust's `to_be_bytes()`: `"@start:be"` in `Seeds<…>` and `bigEndian(start)` in a seed
  list. The IDL records the argument, as Anchor's does.
- New: `loadAccount<T>` / `loadAccountMut<T>` take an `AccountInfo` parameter too (Anchor's `AccountLoader::try_from` on
  an `UncheckedAccount`, for accounts an instruction may create first); a second `loadAccountMut` of one parameter is
  refused (2040), two `Dup<…>` parameters that are one account may each be loaded. A loaded struct is also its account
  (`.key`, `.lamports`) and passes to helpers taking `Account<T>` / `Mut<T>`.
- New: one of two seed lists picked at run time, `const s = cond ? signer([…]) : signer([…])`.
- New: `mintTo` and `freezeAccount` take a `Mut<AccountInfo>` token account the instruction created (an associated
  token account made with `ata.create`).
- New: `u256`, a 256-bit unsigned integer for computation (locals, helpers; never stored, sent or returned), with the
  checked operators, comparisons, casts to and from it, and `mulDiv` / `mulDivCeil` through a 512-bit product. The
  runtime works on 32-bit limbs with 64-bit products and divides with Knuth's algorithm D; a fuzzer checks every
  operator against BigInt.

## 0.36.0 — 2026-10-30

Verifiable randomness from Switchboard, Anchor's check order for instructions with account groups, and the
StakeHistory sysvar. Programs without account groups compile to the same binaries as in 0.35.0.

- New: `StakeHistorySysvar`, the StakeHistory sysvar read as an account: `count`, `latestEpoch`, `has(epoch)`,
  `effective(epoch)`, `activating(epoch)`, `deactivating(epoch)`.
- Changed: an instruction with an account group checks in Anchor's order: the arguments first, then the accounts in
  order with each group's constraints right after its accounts, then the other constraints. A transaction failing
  several checks gets Anchor's code. Instructions without groups are unchanged (decoding the arguments first would make
  every binary larger).
- New: `SwitchboardRandomness`, Switchboard On-Demand's verifiable randomness (commit and reveal): `seedSlot`,
  `revealSlot`, `value()` and `valueU64()`, which fail (5111) unless revealed in this slot, as `get_value` does.

## 0.35.0 — 2026-10-30

Token Metadata's Burn and the EpochSchedule and LastRestartSlot sysvars. Existing programs compile to the same binaries
as in 0.34.0.

- New: Token Metadata `burnV1` (Burn), for an NFT (with its master edition) or fungible asset held by a wallet or this
  program's PDA.
- New: the EpochSchedule and LastRestartSlot sysvars: `slotsPerEpoch()`, `epochWarmup()`, `firstNormalEpoch()`,
  `firstNormalSlot()`, `lastRestartSlot()`.
## 0.34.0 — 2026-10-30

More of anchor-spl and Anchor's tooling: Memo and Stake CPIs, Token Metadata updates, Token-2022 token groups, the
SlotHashes sysvar, `@fallback`, account groups inside account groups, and `typesol clone` for tests against cluster
accounts. Existing programs compile to the same binaries as in 0.33.0.

- New: account groups inside account groups (Anchor's nested composite accounts): `d.p.vault`, nested in the IDL,
  flattened by the client and `typesol/testing` (`dPVault` / `d_p_vault`).
- New: Token Metadata `updateMetadataAccountsV2` (Anchor's `update_metadata_accounts_v2`): the whole DataV2 or null,
  a new update authority, primary sale and mutability, signed by the update authority (a PDA with seeds).
- New: `StakeProgram`: `initialize`, `authorize`, `delegate`, `deactivate`, `withdraw`, with the sysvars passed in as
  anchor-spl does, signed by wallets or this program's PDAs.
- New: `typesol clone [<address>…]` (Anchor's `[test.validator.clone]`): cluster accounts and programs copied to
  `tests/accounts/` (`"clone"` and `"accounts"` in `typesol.json`), which `testProgram` loads into its LiteSVM;
  `loadClonedAccounts(svm, dir)` for a LiteSVM of your own.
- New: `/** @fallback */` (Anchor's `fallback`): an instruction without parameters run when no other matches the data,
  short data included, instead of 101; it reads `const data = instructionData()` and `remainingAccounts()`.
- New: `MemoProgram`: `memoProgram.memo(text, [signers], signerSeeds?)`, SPL Memo v2 signed by wallets or this
  program's PDAs.
- New: `SlotHashesSysvar`, the SlotHashes sysvar read as an account: `count`, `latestSlot`, `latestHash`.
- New: the Token Group interface on Token-2022: `initializeTokenGroup`, `initializeGroupMember`, `updateGroupMaxSize`,
  `updateGroupAuthority`.

## 0.33.0 — 2026-10-30

The rest of what large Anchor programs lean on: account groups (composite accounts), your errors on declarative
constraints, and structs as CPI return data. Existing programs compile to the same binaries as in 0.32.0.

- New: account groups, Anchor's composite accounts. An interface whose fields are accounts is one parameter
  (`p: PoolAccounts`): the body uses `p.pool.reserve` and `p.vault`, constraints inside name the group's own fields,
  the IDL nests the group as Anchor's does, and the client and `typesol/testing` flatten it (`pPool`).
- New: your errors on declarative constraints, as Anchor's `has_one = owner @ ErrorCode.NotOwner`:
  `HasOne<A, "owner", ErrorCode.NotOwner>`, `Address<A, "…", E.X>`, `Owner<A, "…", E.X>`, `Signed<A, E.X>` and
  `Mut<T, E.X>` (the constraints Anchor names errors for; `constraint(…)` already took one). Nest `HasOne` for an error
  per field.
- New: structs as CPI return data: `const quote = returnData<Quote>(amm)` after the call. A fixed layout of integers,
  booleans, Pubkeys, unit enums and arrays is read as its bytes; a `@layout borsh` struct (Options, strings, Vecs) is
  Borsh-decoded; anything else fails with 5106.

## 0.32.0 — 2026-10-30

Anchor parity and usability: Raydium CP-Swap's pool creation and what creating accounts by hand needs, several PDAs
signing one CPI, PDA-signed SOL transfers, the checked token instructions, faster u128 arithmetic and Clock reads,
clearer errors, and tooling for fresh clones, multi-program projects and token tests.

- New: `systemProgram.allocate(account, space, seeds?)` / `assign(account, owner, seeds?)`, `programId()`,
  `findProgramAddressBump(seeds, program)`, `initAccount<T>(account)` (Anchor's `load_init` on an account the body
  created: 3007 / 3006 / 3003 / 3000), `Pubkey.compare(other)` (Rust's byte order), and `ata.create(payer,
  tokenProgram)` / `createIfNeeded(payer, tokenProgram)` to pick among several token programs.
- Changed: an `Init` create on an address already in use now fails as Anchor's `init` does, with the System Program's
  AccountAlreadyInUse (custom 0) instead of TypeSOL's 3000; a payer that is the account being created fails with 4101
  (TryingToInitPayerAsProgramAccount). Programs creating accounts use 9–13 fewer compute units; binaries move by ±1%.
- Faster: u128 multiplication, division and remainder take the native 64-bit instructions when the values fit in 64
  bits (most amounts and rates) instead of the 128-bit library routines; results are unchanged (the arithmetic fuzzer
  now samples such values a third of the time).
- Faster: an instruction reads the Clock sysvar once, on its first `now()` / `currentSlot()` / `currentEpoch()`, and
  reuses it (the Clock does not change within a transaction). With both, Raydium CP-Swap's swap drops from 7,478 to
  5,734 compute units.
- Changed: examples/raydium-cp-swap ports `initialize` too (10 of 24 instructions; 70 transactions against mainnet).
- New: several PDAs can sign one CPI: `invoke` / `invokeInstruction` take a list of seed lists (`[["vault", key, b1],
  ["fees", b2]]`, at most 16). A seed list can be named once and reused: `const vault = signer([...])`.
- New: `systemProgram.transfer(from, to, lamports, signerSeeds)` pays out of a system-owned PDA of the program (a SOL
  vault).
- New: `tokenProgram.mintToChecked`, `burnChecked` and `approveChecked`, which take the decimals from the mint.
- Better errors: `throw`, `try`/`catch`, optional and default parameters, `...rest` parameters and optional fields now
  say what to write instead; "unsupported call" names the callee and, for common JavaScript calls (`console.log`,
  `Math.min`, `BigInt`, …), the TypeSOL form.
- Tooling: a project without its program keypair (a fresh clone, CI) builds and tests at the address `typesol.json`
  records; only `deploy` needs the keypair. New projects run `typesol build` before `npm test` and `npm run
  typecheck`, which import the client it writes.
- Tooling: `typesol new <program>` adds a program and its test to a project; `typesol check` with no argument checks
  every program of the project (or those named).
- Testing: `t.mint`, `t.tokenAccount` and `t.tokenBalance` write and read SPL Token / Token-2022 accounts in the VM,
  `t.warp` moves the Clock, `t.errorName(code)` names an error, and a failed `t.ok` names the error. The escrow
  template uses them (and no longer needs `@solana-program/token`).
- Docs: the docs in the npm package link to tests and examples on GitHub.

## 0.31.0 — 2026-10-30

A second real program checked against its mainnet binary: Raydium CP-Swap's trading core, and the Token-2022 reads an
AMM needs. Programs that do not use the new reads compile to the same binaries as in 0.30.0.

- New: Token-2022 fee and extension reads: `transferFeeInverse(mint, amountReceived)` (spl-token-2022's
  `calculate_inverse_epoch_fee`: what to send so the recipient gets that much), `transferFeeBasisPoints(mint)` and
  `transferFeeMaximum(mint)` (this epoch's), and `extensionsWithin(account, [types…])` (accept only mints whose
  extensions you handle).
- New: examples/raydium-cp-swap, Raydium CP-Swap's trading core (swaps both ways, deposit, withdraw, fee collection,
  config and status admin; 9 of its 24 instructions), checked against the program deployed on mainnet on 59
  transactions (creator fees, the price oracle's wrap and Token-2022 transfer fees included): same outcomes, account
  bytes and events, 51–79% fewer compute units. docs/case-study-raydium-cp-swap.md.

## 0.30.0 — 2026-10-30

Editor errors that follow you through a program, faster. The compiler's output is the same as 0.29.0 for every
program.

- Changed: `typesol/ts-plugin` shows the compiler's refusals in every file of a program (a helper or state file the
  entry imports, not only the entry), for the unsaved text of every open file, underlining the whole construct.
- Changed: the plugin runs the compiler inside the editor's TypeScript server once it has loaded (a check takes
  milliseconds instead of starting a process), and `typesol init` writes `.vscode/settings.json` so VS Code offers the
  workspace's TypeScript, which loads the plugin.
- New: `typesol check --files` reads `{ "files": { "<path>": "<text>" } }` from stdin (unsaved buffers of any file);
  `--json` diagnostics carry a `length`. The compiler's `generate(entry, { files })` takes the same overrides.

## 0.29.0 — 2026-10-30

The remaining Anchor gaps: declarative constraints in Anchor's order, Anchor's unbounded `Vec` in Borsh accounts, and
more than 32 accounts per instruction. Programs that use none of them compile to the same binaries as in 0.28.0.

- New: `export const MAX_ACCOUNTS = 128n` (33–255) lets a program's instructions take more than 32 accounts, as Anchor
  programs can. Above 32 the CPI scratch lists live on the heap, grown as needed.

- New: `constraint(account, condition, error?)`, Anchor's `constraint = condition @ error`: statements at the start of
  an instruction that run with that account's checks (after its `has_one`), so a transaction breaking several checks
  gets Anchor's code. The default error is ConstraintRaw (2003).
- New: `Vec<T>` in a `@layout borsh` struct is Anchor's Vec: any field position, held on the heap while the instruction
  runs (growing as Rust's does), bounded only by the account when it is written back (3004). Such a struct can be an
  account or a whole argument (not return data or an event); `Init` of one takes its space. `typesol port` now writes
  `Vec<T>` for Anchor's Vec fields instead of a `FixedVec` to size by hand.
- Changed: `push(value, payer)`'s payer is optional in the types (the compiler still requires it for a Vec that grows
  the account), so a `Vec` assigns to a `FixedVec` without the earlier type workaround.
- Changed: examples/multisig.ts uses both; it now matches the mainnet program on 52 transactions, including one that
  breaks two checks at once and an account holding 40 owners.
- Internal: `cpi.ts` split into `cpi-core`, `create`, `token`, `metaplex` and `cpi`; aliasing rules in `alias.ts`;
  `scripts/codegen-snapshot.ts`; the IR decision in docs/architecture.md.

## 0.28.0 — 2026-10-29

A port of coral-xyz/multisig, checked against the program deployed on mainnet, and the features it needed. The
benchmark programs compile to the same numbers as in 0.27.0.

- New: `invokeInstruction(programId, metas, data, infos, signerSeeds?)`, a CPI decided at run time (Rust's
  `invoke_signed` of an `Instruction` built from data): metas are structs with `pubkey`, `isSigner`, `isWritable`, the
  data a list of u8, and every account in `infos` (the remaining accounts or a slice) goes to the runtime.
- New: `Signed<A>`, Anchor's `signer` constraint on an account that is not a `Signer` (2002); the IDL marks it a signer.
- New: `Zeroed<T>` of a `@layout borsh` struct (Anchor's `#[account(zero)]` on a Borsh account): it starts empty and is
  written as Borsh when the instruction returns.
- New: a Seeds bump stored in another struct account, `Seeds<A, ["@multisig"], "@multisig.nonce">` (Anchor's
  `bump = multisig.nonce`).
- New: `list = vecArgument` copies a `Vec` argument (or another list of the same elements) into a `FixedVec` (5104 when
  it does not fit).
- Changed: a `Zeroed<T>` account whose discriminator is already set fails with 2013 (ConstraintZero), checked before its
  owner, as under Anchor; it was 3000 after the owner check.
- Changed: `key`, `lamports`, `dataLen`, `isSigner`, `isWritable` and `pdaBump` are refused as field names only in
  structs held in an account (where they would shadow `acct.key` and the others), no longer in every struct.
- Docs: `docs/case-study-multisig.md`; the mainnet binary is in `test/programs/coral_multisig.so`.

## 0.27.0 — 2026-10-29

Anchor 1.0 parity: instruction introspection, `Dup<…>` and account migration. Existing programs compile to the same
binaries as in 0.26.0.

- New: instruction introspection. `InstructionsSysvar` has `length`, `currentIndex()` and `get(i)`, a
  `TransactionInstruction` with `programId`, its accounts (key, signer, writable), its data
  (`readU8/U16/U32/U64/readPubkey`) and `is(program, "name")` (an instruction by its Anchor discriminator); every read
  is bounds-checked (5104). `stackHeight()` is 1 at the top level, more under a CPI.
- New: `Dup<…>`, Anchor's `dup`: a writable parameter that may be the same account as another, for accounts read and
  written in place (not created, closed, a close destination or `@layout borsh`, which are refused at compile time).
- New: `Migrate<From, To>`, Anchor 1.0's `Migration`: an existing account rewritten from one struct to another with
  `acct.migrate(payer, value)`, the old data readable through `acct.from` until then (the new value is built before
  the bytes are rewritten), the new through `acct.to` after; resized with the payer topping up rent. For now:
  fixed-layout structs without growable Vecs, no constraints on the account, and it cannot be passed to a helper.
- New: `/** @discriminator … */` on an account struct (a sha256 preimage such as `account:Counter`, or 0x and 8
  bytes), Anchor's `#[account(discriminator = …)]`: keeps an old type's on-chain discriminator under a new name.

## 0.26.0 — 2026-10-29

A first-run experience pass, the security model and audit package, and more fuzzing. The compiler's output is the
same as 0.25.0 for every program.

- New: `typesol doctor` checks Node.js, the platform-tools, the Solana CLI, its keypair, the RPC and the keypair's
  balance there, and the project, and prints the command that fixes each problem (exit 1 when building is impossible).
- `typesol init` prints the files it creates relative to where it runs, warns with the install commands when the
  platform-tools are missing, and lists the next steps.
- `typesol deploy` checks, before sending anything, that the RPC answers (else: start `solana-test-validator`, or
  `--url devnet`) and that the payer can pay the rent (else: how much, and the `solana airdrop` command on devnet or a
  local validator). RPC URLs in these messages show only the host.
- Docs: [security model](docs/security-model.md) (the guarantees a compiled program can rely on, trust boundaries,
  what is left to the author) and [audit package](docs/audit.md) (scope, priorities, earlier reviews, evidence);
  README: deploying on devnet and on a local validator.
- Tests: `test/verification/fuzz-layout.test.ts`, model-based fuzzing of an account with two growable Vecs and of
  `loadAccountMut` aliasing through remaining accounts (also in `pnpm fuzz`).
- Repository: tests grouped by subject under `test/`, the Anchor twins in `test/anchor-twins` (`pnpm build:twins`),
  the generators and chain tooling in `src/tools/` (the package's import paths are unchanged); Dependabot for npm and
  GitHub Actions.

## 0.25.0 — 2026-10-29

Security review (October 2026) fixes, and error codes aligned with Anchor. Some refused transactions now report a
different error code (below): a minor version.

- Fixed: `loadAccountMut` on the same remaining account twice (`rest.get(i)`, `rest.get(j)` with `i == j`) gave two
  writable views of one account; a program reading both before writing both could be made to create value. The second
  load is now refused with 2040.
- Fixed: a Vec element written with a right side that resizes the Vec (`book.bids.get(i).qty += settle(book)` where the
  helper pops, a closure, or a `push` / `pop` / `clear` in the expression) wrote through the element's old position,
  into the bytes of the next Vec. Such an assignment is now a compile error ("store its result in a local first"),
  as it already was for a plain `=` with a helper.
- Fixed: `Ata<Init<…>>` / `Ata<InitIfNeeded<…>>` creation and `Ata<AccountInfo, …>` with two token program parameters
  used the first one; they now need exactly one (use `TokenInterface`).
- New: `TokenOf<…, …, …, "tokenProgram">` / `MintOf<…, …, …, "tokenProgram">`, Anchor's `token::token_program` /
  `mint::token_program` (2021 / 2022). The escrow port uses it.
- New: `pythPrice(update, feedId, maxAge, exponent)` refuses a feed whose exponent is not the one given;
  `switchboardValue(…, minSamples)` refuses a result resting on fewer oracle samples.
- Changed: each account's constraints are checked in Anchor's order (seeds, associated token account, has_one, owner,
  executable, address, token::, mint::), so a transaction breaking several fails with Anchor's code: e.g. a stranger's
  call on a `Seeds<HasOne<…>>` account now fails with 2006 (ConstraintSeeds) instead of 2001, and an `Ata<…>` of
  another wallet with 2015 instead of 2009. A `Mut<…>` account passed read-only fails with 2000 (ConstraintMut), as
  Anchor's `#[account(mut)]`, instead of 3006. docs/errors.md lists the order and the differences left.
- Docs: unchecked raw Pyth fields, `requirePda` with a bump from the arguments, Merkle leaves, and what
  `createIfNeeded` leaves unchecked on an existing account.
- Docs: [Case study: porting Anchor's escrow](docs/case-study-escrow.md), one Anchor program ported end to end, with the
  differences, the checks run against the original and the cost.
- Releases: the release workflow checks that CHANGELOG.md has the version, and after publishing installs the package
  from npm, scaffolds a project from each template and runs its typecheck, build and test.

## 0.24.1 — 2026-10-28

Smaller programs and fewer compute units, with the same results; no change to the language, IDLs or error codes. Also
new contributor docs (repository layout, a guide to the C runtime). Not externally audited (see SECURITY.md).

### Performance
- Smaller programs, same results: the rent calculation no longer links soft-float (an exact integer equivalent,
  checked against IEEE doubles), and every failure logs through one shared call. The benchmarked programs are 11.6%
  smaller in total (counter 13.1 → 11.0 KB, escrow 23.9 → 21.3 KB). A failing instruction costs 2 more compute units;
  successful ones are unchanged.
- An identical signer-seed list in the same scope reuses the array declared for the first CPI (escrow `take_offer`
  7058 → 7044, `refund_offer` 4287 → 4271).

## 0.24.0 — 2026-10-28

Functions as values, closures for any helper, stored `map` to structs and text, Metaplex Core external plugins, and
the fixes and identical-result compute-unit savings from a full code review: expanded helpers see only their own
scope, generated clients read only their program's events, and IDLs from the chain are read with limits. Not externally
audited (see SECURITY.md).

### Added
- Functions as values: `const h = g`, and functions that return functions (`function adder(n: u64): (x: u64) => u64
  { return (x) => x + n; }`), which make a closure where they are called (`const add5 = adder(5n)`, `adder(5n)(x)`).
- Closures given to helpers with type parameters or accounts: the helper is expanded where it is called, its type
  parameters bound from the call and its accounts the caller's.
- A stored `map` to structs or text: `const ps: FixedVec<Pair, 8> = xs.map((o) => ({ qty: o.qty, doubled: o.qty * 2n }))`,
  `const names: FixedVec<FixedString<8>, 4> = xs.map(…)`.
- A struct argument holding a FixedVec, when the struct is only an argument: read as Anchor sends it (the FixedVec a
  Borsh Vec), as a `@layout borsh` struct is.
- Metaplex Core external plugin adapters: `addExternalPlugin`, `removeExternalPlugin`, `writeExternalPluginData` and
  their Collection forms, for AppData, Oracle and LifecycleHook (and the Linked forms), checked against the Core program
  (Core itself answers lifecycle hooks with NotAvailable for now).

### Changed
- Fewer compute units, same results: the PDA bump search builds its seed list once, a growing account reads the rent
  sysvar once, integers become text two digits at a time, a lone `${n}` template is not copied again, and
  `list = fixedVec([])` clears the list in place. For example escrow `make` 3638 → 3605, `take_offer` 7117 → 7058,
  `transfer_tokens` 8467 → 8367 CU.
- `eventsOf` takes the transaction with its account keys (`transaction.message.accountKeys`, as getTransaction returns
  it); without them it reads log events only. `errorCode` / `isError` also read the RPC's JSON error
  (`{ InstructionError: [0, { Custom: 6000 }] }`).
- `svmConnection`: `accountNotifications` yields after each later transaction that names the account (no snapshot of
  it as it is), `logsNotifications` honors `{ mentions }` and includes failed transactions (with `err`), simulation
  errors are in the RPC's JSON shape, and `getTransaction` returns the account keys and each inner instruction's
  program index.
- Compiler messages about accounts with a growable Vec say "has a growable Vec" instead of "ends in a Vec", and the
  field-type list no longer says `Vec<T> (last)`, since a Vec can be any field (0.23.0).

### Fixed
- A helper expanded where it is called (given a closure), and a function a helper made, read a module constant as
  the instruction argument of the same name; they now see only their parameters and the module.
- A struct parameter of a closure or expanded helper could be used after a push, pop or clear moved the Vec it points
  into (a stale pointer); that is refused like any other reference across the move.
- A closure parameter named like an account read the account; it is refused.
- A helper from another file, expanded here or typed from an arrow passed to it, resolved its types with this file's
  imports (an aliased or unimported type failed to compile, or an annotation was dropped); its own file's imports are
  used, and `applyT<u64>((v) => …)` takes the type given at the call.
- A struct with a FixedVec held in a data enum variant was read as Borsh when also an argument; that conflict is refused.
- Generated clients read only this program's events: `parseEvents` follows the invoke stack and reads a `Program data:`
  line only while the program is the innermost one running, and `eventsOf` reads only `emitCpi` inner instructions that
  call the program. Another program can no longer forge them.
- `watchEvents` skips failed transactions.
- `typesol client` refuses malformed generic arguments, array lengths that are not whole numbers and `repr` alignments
  that are not powers of two, and caps generic instantiation (256 types, 16 levels): a ClientIdlError instead of a crash
  or a hang. Sizing deeply nested structs no longer takes exponential time.
- Accounts named like `Object.prototype` properties (`constructor`, `toString`, …) are read as given, not inherited.
- `resolve.<ix>` derives a has_one source that is a PDA (a `config` PDA) before reading it, and names the account to
  pass when a source is missing.
- Notes and errors escape control characters from the IDL.
- Reading an IDL from the chain caps inflation at 16 MiB, checks Anchor's IdlAccount discriminator, and refuses a
  Program Metadata IDL that links to a URL or another account instead of following it.
- `typesol/testing`'s `returned()` decodes string, bytes, f32 and f64 return values, and throws for types it cannot
  decode instead of misreading them.

## 0.23.0 — 2026-10-28

Language limits lifted: `map` and `filter`, any number of growable Vecs per account, closures and arrow functions as
helper arguments, FixedVec arguments and list fields in events. Existing programs compile to the same bytes. Not
externally audited (see SECURITY.md).

### Added
- `map` and `filter` on Vecs, FixedArrays, FixedVecs and Vec arguments. A chain used right away
  (`xs.filter(f).map(g).reduce(h, 0n)`, `.length`, `for … of`, any list method) is one loop that builds no list;
  callbacks after a filter get the index among the elements it let through, as in JS. Stored (`const ys = xs.map(f)`),
  it is a FixedVec on the stack as big as the list it starts from, or as annotated (`const ys: FixedVec<u64, 16> = …`,
  needed for a `Vec`); a list one element too small aborts with 5104.
- Arrow functions written as helper arguments (`applyTwice((x) => x * 3n, v)`), typed from the helper's parameter when
  left unannotated. Given a closure (one that reads the caller's variables), the helper is expanded where it is called,
  so the closure runs where it can.
- Any number of growable `Vec<T>` fields in an account, declared anywhere. They are stored after the fixed-size fields,
  in the order declared (every other field keeps a fixed offset; the IDL lists the stored order), and a push, pop or
  clear moves the Vecs after it. An account with one Vec is laid out as before.
- `FixedVec<T, N>` arguments (a Borsh Vec of at most N elements; more fail with 102), and `FixedVec` and `Vec` fields
  in events.

## 0.22.0 — 2026-10-28

Generated clients fill in the accounts Anchor's client still asked you to pass (signers from a default signer, PDAs
seeded from string, byte and argument fields, PDAs under a program given as an argument, a helper for PDAs seeded from
their own fields), read Anchor zero-copy accounts and generic types, and run in tests over LiteSVM. Programs and their
bytes are unchanged. Not externally audited (see SECURITY.md).

### Added
- Generated clients fill in the accounts Anchor's client still asks for:
  - `resolve.<instruction>(rpc, accounts, args?, { signer })` fills signer accounts that were left out with a default
    signer (the wallet), as Anchor's client uses the provider's wallet.
  - PDAs seeded from another account's string, byte and `FixedString` fields are derived by `resolve`, as scalar fields
    already were.
  - A PDA seeded from its own fields gets a `pdas.<name>({ field values })` helper (its address is needed to read it).
  - A PDA whose program is a `Pubkey` argument is derived by the instruction builder.
- Clients generated from Anchor IDLs read and write zero-copy (`bytemuck`, `AccountLoader`) accounts at their
  `#[repr(C)]` offsets on SBF (padding, `packed` and `align` included), checked byte for byte against an Anchor
  program, and turn generic types into one concrete type per use (`Pair<u64, 2>` → `PairU64N2`).
- PDAs seeded from fields of a struct argument (`seeds = [params.id]`) are derived by the instruction builder.
- `typesol/testing`: `svmConnection(svm)` (and `t.connection`), a kit RPC and subscriptions pair answered by LiteSVM,
  so a generated client sends, fetches, simulates, resolves and watches in tests as it does against a cluster.

## 0.21.0 — 2026-10-28

Clients from a program's address alone, and the last pieces Anchor's client resolves for you: `has_one` accounts,
PDAs seeded from another account's fields, and `emitCpi` events as they happen. Programs and their bytes are
unchanged. Not externally audited (see SECURITY.md).

### Added
- `typesol client --address <program id> --url <rpc>`: a client from the IDL on chain, the canonical Program Metadata
  IDL (`typesol idl publish`, Codama) or else Anchor's IDL account (`anchor idl init`).
- Generated clients: `resolve.<instruction>(rpc, accounts)` fills in `has_one` accounts that do not sign from the
  account that names them, as Anchor's client resolves `relations`, and PDAs seeded from another account's fields
  (`seeds = [b"vault", book.owner]`: the account is read, then the PDA derived).
- `watchEvents(rpcSubscriptions, { abortSignal, rpc })`: with an RPC, `emitCpi` events arrive live too (the transaction
  is fetched when the program invoked itself).

## 0.20.0 — 2026-10-28

The generated TypeScript clients catch up with Anchor's: remaining accounts, listing and watching accounts, sending
and simulating, views, `emitCpi` events and every Anchor error by name. Programs and their bytes are unchanged. Not
externally audited (see SECURITY.md).

### Added
- Generated clients: remaining accounts on every instruction builder; `accounts.<Name>.fetchMultiple`, `fetchAll`
  (getProgramAccounts by discriminator, with `{ offset, bytes }` filters) and `watch` (account subscription);
  `sendInstructions` (send and confirm), `simulate`, and `views.<instruction>` (a return value by simulation, Anchor's
  `.view()`); `parseCpiEvents` / `eventsOf` for `emitCpi` events, and `watchEvents` (log subscription). Every Anchor
  framework error has its name in `errors`, so `isError` knows the codes `AnchorError` and the constraints raise.

## 0.19.0 — 2026-10-28

Anchor's error codes where TypeSOL raised its own: `TokenOf` / `MintOf` constraints that name the parameters as
`token::mint = …` does, every Anchor `ErrorCode` for `require`, and `init_if_needed` mints with extensions checked as
Anchor checks them. Strings and logs cost up to a third fewer compute units. 30 of the 46 official examples are now
full ports. Existing programs keep their layouts and error codes. Not externally audited (see SECURITY.md).

### Added
- `TokenOf<TokenAccount, "mintParam", "authorityParam">` and `MintOf<Mint, "authorityParam", "freezeParam">`: Anchor's
  `token::mint = …` / `mint::authority = …` naming the parameters (2014 / 2015 / 2016 / 2017).
- `AnchorError`: Anchor's own error codes for `require(condition, AnchorError.X)` (`RequireKeysEqViolated`,
  `AccountDidNotDeserialize`, the extension constraints …), as `require!` / `err!` with `ErrorCode` raise them.
- Extensions on `InitIfNeeded<Mint>`: an existing mint is checked as Anchor's `extensions::…` constraints check it
  (2024–2039).
- Bubblegum `mintToCollection` (MintToCollectionV1 on V1 trees, Token Metadata collections).

### Changed
- Strings are built with less work and heap: a template literal is joined in one allocation (it was copied piece by
  piece), text known at compile time (literals, string and Pubkey constants) is folded in, `s += …` and `a + b` grow
  the newest heap string in place, and base58 of a Pubkey is about 20% cheaper. Results are the same; official
  examples that log addresses use 11–36% fewer compute units (set_favorites 10,244 → 6,601, transfer_tokens
  9,760 → 8,467, create_system_account 4,664 → 4,075, go_to_park 435 → 372); binaries of programs that build
  strings grow by up to 2.4 KB.

## 0.18.0 — 2026-10-28

The remaining Anchor differences, closed: Anchor's argument structs (Strings, Vecs, Options and enums in Borsh),
keypair `init` with `space`, `init` of mints with Token-2022 extensions and of token accounts, `Vec<String>`
arguments, `SystemAccount`, string return values, and the Token-2022 and Token Metadata instructions programs call.
Closures, list callbacks and more everyday TypeScript; the rest of Bubblegum and Core. 26 of the 46 official
examples are now full ports. Existing programs keep their layouts and error codes (2018 and 3011 are new, raised only
by the new `Init<Mint>` and `SystemAccount` checks). Not externally audited (see SECURITY.md).

### Added
Anchor accounts and arguments:
- `@layout borsh` structs as whole instruction arguments, return values and events, in Anchor's Borsh bytes (a
  FixedString is a String, a FixedVec a Vec, an Option one byte when empty). Arguments are checked as Borsh
  deserialization does, UTF-8 included (102 otherwise). `return vault` returns a whole struct account.
- `@layout borsh` structs used as arguments, return values or events may hold `string` fields and data enums (with or
  without strings), as Anchor argument structs do; Borsh accounts may hold data enums without strings.
- `acct.create(payer, null)` on `Init<T>`: Anchor's `init` of a keypair account (it must sign; 3010 otherwise), and an
  optional third argument for Anchor's `space = …` on `create` / `createIfNeeded`.
- Mint extensions on `Init<Mint>`: `mint.create(payer, seeds | null, decimals, authority, freeze, { … })` with
  transferFee, closeAuthority, defaultAccountState, nonTransferable, interestBearing, permanentDelegate, transferHook,
  metadataPointer, groupPointer and groupMemberPointer (Anchor's `extensions::…`).
- `Init<Mint>` / `InitIfNeeded<Mint>` with `mint.create(payer, seeds | null, decimals, mintAuthority, freezeAuthority)`
  and `Init<TokenAccount>` / `InitIfNeeded<TokenAccount>` (without `Ata<…>`) with `vault.create(payer, seeds | null,
  mint, authority)`: Anchor's `init` with `mint::` / `token::` constraints, at a PDA of this program or (with `null`) a
  new keypair account that signs, under SPL Token or Token-2022 (token accounts sized with GetAccountDataSize). The
  `createIfNeeded` forms check an existing account like Anchor's `init_if_needed` (2014 / 2015 / 2016 / 2017 and the
  new 2018 ConstraintMintDecimals). The IDL marks keypair-created accounts as signers.
- `SystemAccount` / `Mut<SystemAccount>`: Anchor's `SystemAccount`, refused with 3011 (AccountNotSystemOwned) when
  another program owns it.
- `Vec<string>` instruction arguments (Anchor's `Vec<String>`): `.get(i)`, `.length`, `for … of`, list callbacks,
  helper parameters, storing into `FixedVec<FixedString<N>, M>`, and re-encoding through `invoke`; each string is
  checked as UTF-8 on entry (102).
- Helpers and instructions can return `string` (an instruction's is Borsh String return data).
- `acct.key` of an `Init<…>` account before it is created (the address is known; Anchor seeds use it that way).
- `mint.create(…, tokenProgram)` / `vault.create(…, tokenProgram)`: an explicit token program, for instructions that
  take more than one.

Language:
- Closures: a local function that reads or writes the enclosing function's variables is expanded where it is called,
  with the names it was declared with (a block at the call that declares the same name does not change it), struct
  parameters by reference and `return` leaving the closure. Recursion and storing / returning closures are refused.
- List callbacks on Vec, FixedArray, FixedVec and Vec arguments: `forEach`, `some`, `every`, `find`, `findIndex`,
  `reduce`, `includes`, `indexOf`, expanded into loops with the arrow written at the call.
- Helpers can take function parameters (`f: (x: u64) => u64`): compiled once per named function passed.
- `do … while` loops (`continue` goes to the test).
- `x **= n` (the target must not call a function: it is read and written).
- `switch` on 128-bit integers (the case is picked with comparisons, then switched on as usual, fallthrough included).
- `?.` on optional accounts (`acct?.field`) and on `Option<struct>` fields (`x.home?.field`): an Option, empty when the
  account was left out or the option is empty; use it with `??`.
- `acct!` on optional accounts (fails with 5115 when it was left out), Pubkeys / Hashes in template strings (base58),
  and data-enum arguments whose variants carry fixed-size structs or arrays.
- Type parameters standing for fixed-size structs (`pick<Point>(…)`, or taken from struct arguments), and `cond ? a : b`
  for struct values (places, literals or calls).
- Growable `Vec<T>` `push` / `pop` / `clear` inside helpers that take the account as `Mut<T>` (with its payer and
  SystemProgram, as in instructions).
- `mulDiv` / `mulDivCeil` on u128 through a 256-bit product (all three u128; literals take that type).

CPI:
- Token-2022 extension instructions: `updateDefaultAccountState`, `updateTransferHook`, `enableRequiredMemoTransfers` /
  `disableRequiredMemoTransfers`, `updateInterestRate`, `transferCheckedWithFee`, `harvestWithheldTokensToMint`,
  `withdrawWithheldTokensFromMint`, `setTransferFee`; the Token Metadata interface: `updateMetadataField`,
  `removeMetadataKey`, `updateMetadataAuthority`, `emitMetadata`; `closeAccount` of a mint; `mintTo` /
  `initializeMetadata` on a mint created earlier in the instruction; `isTransferring(tokenAccount)` and
  `transferHookAuthority(mint)`.
- Metaplex Core plugin values: MasterEdition, VerifiedCreators, Autograph, FreezeExecute, PermanentFreezeExecute, and
  royalty rule sets (`ruleSet: { programAllowList | programDenyList }`).
- Bubblegum: `delegateV2`, `freezeV2`, `thawV2`, `setNonTransferableV2`, `updateMetadataV2`, `verifyCreatorV2`,
  `unverifyCreatorV2`, `setCollectionV2`, and the V1 `transfer`, `burn`, `delegate`. Checked on the real programs with
  every leaf recomputed: verify → delegate → freeze (a frozen leaf is refused) → thaw → rename, unverify, moving a leaf
  into a collection, soulbinding a collection's leaf, and a V1 transfer signed by a PDA owner, delegate and burn.

### Fixed
- Bubblegum leaf fields that may be null at run time (`assetDataHash: Hash | null`, `flags`) are sent as Borsh Options;
  a null aborted the instruction before.

## 0.17.0 — 2026-10-28

Anchor's account bytes on request (`@layout borsh`, so a TypeSOL program can take over an Anchor program's accounts
without a migration), lists with a fixed capacity anywhere in account data (`FixedVec`), arrow functions and generic
helpers, Metaplex collection verification, Core plugins and Bubblegum V2, and a faster UTF-8 check. Existing programs
keep their layouts and error codes (3004 is new, raised only by `@layout borsh` accounts). Not externally audited (see
SECURITY.md).

### Added
- `/** @layout borsh */` on an account struct stores it with Anchor's bytes (Borsh String / Vec / Option for
  `FixedString` / `FixedVec` / `Option`), so a TypeSOL program can take over an Anchor program's accounts without a
  migration; its IDL lists Anchor's own types. An instruction unpacks the account into the fixed layout when it starts
  and packs it back when it returns (3003 for bytes that are not a valid value, 3004 when the account is too small).
  Checked byte for byte against an Anchor twin, including switching programs in the middle of a sequence.
  `typesol port` marks Anchor account structs that need it.
- `FixedVec<T, N>`: a list with room for N elements (u32 length + N slots, like `FixedString<N>`) as any account field,
  several per struct and in nested structs, with `get` / `set` / `push` / `pop` / `clear` / `.length` / `for … of`;
  `push` on a full one fails with 5104, `fixedVec([…])` writes a whole one. The IDL describes each as a
  `FixedVec<N>_<T>` struct `{ len, items }`; the generated client reads and writes them as arrays. The
  basics/favorites port uses one.
- Bubblegum V2: `createTreeV2`, `mintV2` (optionally into a Metaplex Core collection), `transferV2` and `burnV2`, which
  take the leaf (root, data and creator hashes, nonce, index) and pass its Merkle proof on from the remaining accounts;
  the Core `BubblegumV2` collection plugin. Checked against Bubblegum, mpl-account-compression, mpl-noop and Core
  (`pnpm fetch:programs` now fetches the mpl-account-compression pair too).
- Metaplex Core plugins: a literal plugin list in `createAsset` / `createCollection` (Royalties, freeze / burn / transfer /
  update delegates and their permanent forms, Attributes, Edition, AddBlocker, ImmutableMetadata, each with an optional
  authority), and `addPlugin`, `updatePlugin`, `removePlugin` with their collection forms, checked against the real Core
  program (a frozen asset cannot move until it is thawed).
- Arrow functions: `const f = (x: u64): u64 => …` (and `const f = function (…) {…}`) at the top level or inside a
  function is a helper. Local ones capture nothing (a closure over the enclosing function's variables is refused with
  the name it reads); functions are called, not passed around.
- Generic helpers: `function max<T extends bigint>(a: T, b: T): T` compiles once per set of types it is called with,
  inferred from the arguments or written out (`max<u128>(x, 1n)`); type parameters stand for integers, booleans,
  Pubkeys or enums.
- `x as T` (and `satisfies`): names a type the value already has, never a conversion; mainly `return (a + b) as T`
  in a generic helper.
- Metaplex collections: `createV3`'s `isCollection: true` (CollectionDetails::V1), `createMasterEditionV3(…, maxSupply | null)`,
  `verifyCollection(…)` (Verify with CollectionV1) and `masterEditionAddress(mint)`. The tokens/nft-operations port now
  uses them instead of hand-encoded `invoke`s, checked against the real Token Metadata program.

### Changed
- IDLs no longer list `FixedString*` / `FixedOption_*` / `FixedVec*` helper types that nothing in them refers to
  (for example an `Option` used only as an instruction argument, which is Borsh there).
- UTF-8 checks of strings run eight ASCII bytes at a time: every official-example instruction with a string argument
  gets cheaper (create_token_mint 40,919 → 39,828 CU, set_favorites 4,282 → 4,195).

## 0.16.0 — 2026-10-28

Everyday TypeScript that Anchor developers reach for (`for … of`, `??`, destructuring, `**`, structs returned from
helpers and instructions, strings in enum variants), tools to move an Anchor program over (`typesol port`, a migration
guide) and to work on it (`typesol/testing`, an editor plugin, `verify` against the cluster), Token-2022 extension
setup and Metaplex creators. No IDL or error-code changes for existing programs. Not externally audited (see
SECURITY.md).

### Added
- Metaplex `createV3(…, isMutable, { creators, collection }, signerSeeds?)`: 1–5 creators (shares checked to add up to 100
  when literal) and an unverified collection mint, checked against the real Token Metadata program.
- Data-enum variants can hold a `string` (`type Cmd = { kind: "Say"; text: string } | …`), as Anchor enums with `String`
  payloads: Borsh in instruction arguments and events, a value in code (a copy when built from account text), refused
  in account data. The IDL describes them as Borsh enums only.
- `typesol port <idl.json>`: a TypeSOL program skeleton from an Anchor IDL (structs, enums, errors, one function per
  instruction with its accounts and arguments). Discriminators, account names and error codes are kept, so existing
  clients keep working where layouts match; notes list where Anchor's Borsh layout differs. Round-trips every example
  (example → IDL → port → IDL) with the same instructions, accounts, layouts and error codes.
- Token-2022 extension initializers on `Token2022Program` / `TokenInterface` (refused on `TokenProgram`): transfer fee,
  mint close authority, non-transferable, permanent delegate, default account state, metadata / group / group-member
  pointers, transfer hook, interest-bearing, immutable owner. Byte layouts checked against the official
  @solana-program/token-2022 decoder on real mints.
- `typesol/ts-plugin`: a TypeScript language-service plugin that shows the compiler's own errors in the editor, for
  the unsaved text, once TypeScript has none. `typesol init` projects enable it in `programs/tsconfig.json` (the
  editor must use the workspace's TypeScript). `typesol check` gains `--json` and `--stdin`.
- `typesol/testing`: `testProgram(name, import.meta.url)` builds a project program into LiteSVM, with `wallet()`, `pda(…)`,
  `ix(name, args, accounts)` (accounts by name, flags, fixed addresses and PDAs from the IDL, plain argument values),
  `send`, `ok`, `errorCode`, `account` (decoded to bigints and address strings), `returned` and `balance`. The
  `typesol init` templates' tests use it (the counter test went from 70 lines to 20). See docs/test-your-program.md.
- `a ** b` on integers, every multiplication checked (5100 on overflow or a negative exponent, where JS throws). A
  literal exponent unrolls at compile time; otherwise a square-and-multiply loop runs.
- Object destructuring: `const { owner, pos: p } = acct` (`let` for scalars) from a name or a field path, read like
  `acct.owner` (scalars copied, nested structs referenced). Rest elements, defaults and nested patterns are refused.
- Instructions can return a fixed-size struct as return data (a literal, a stored struct or a helper's result), at
  most 1024 bytes. It goes out in its fixed layout, which the IDL describes under `returns`, so Anchor clients and the
  generated TypeScript client decode it.
- Helpers can return a fixed-size struct: `return { x, y }`, a stored struct or another helper's result. The caller
  gets its own copy to bind (`const p: Point = at(1n, 2n)`), store (`acct.home = at(…)`, `arr.set(i, at(…))`) or read
  (`at(…).x`). Structs with a Vec or variable-length strings cannot be returned.
- `a ?? b` on Options of integers, booleans and Pubkeys (b is evaluated only when a is empty; the result is an
  Option when b can be null), and `x!` on an Option (its value; an empty one aborts with 5108).
- `for (const x of list)` over a `Vec` (account field or argument) or a `FixedArray`: each `x` is what `list.get(i)`
  gives (a value, or a reference into account data for structs, with the same aliasing checks), the length is read
  again before every step as in JS, and `break` / `continue` work. Remaining accounts are still iterated by index.
- `typesol verify <program>` without a `.so` reads the deployed program from the cluster (`--address`, or the address
  in `typesol.json`; `--url`, cluster monikers or the Solana CLI config) under loader v2, v3 or v4, prints its upgrade
  authority or that it is immutable and its last deploy slot, and compares the IDL published on chain with the built
  one. A published IDL that differs is a mismatch (exit 3). No `solana program dump` step needed.
- `typesol idl publish --url` accepts the Solana CLI's cluster monikers (`mainnet-beta`, `devnet`, …).

### Fixed
- `createV3` evaluates its arguments in source order (a creator share computed by a helper that changes account text
  no longer changes the name or fee read before it).
- A function whose stack frame exceeds SBPF v0's 4 KiB used to build and then corrupt memory at runtime (the toolchain
  only printed a note). The build now fails, naming the instruction or helper and its frame size (v1/v2 frames grow
  dynamically and are not limited).

### Docs
- docs/migrate-from-anchor.md: Anchor constructs, account data, code and tooling mapped to TypeSOL, with the `typesol port`
  workflow and which account layouts differ.

## 0.15.0 — 2026-10-27

Project templates for `typesol init`, a mainnet deployment guide, and clearer `typesol idl publish` failures. No
language, IDL or error-code changes. Not externally audited (see SECURITY.md).

### Added
- `typesol init --template counter|vault|escrow`: start from a PDA counter (the default, as before), a SOL vault or an
  SPL token escrow. Each template is the matching `examples/` program with a LiteSVM test of its main flow and of a
  refused call; the escrow project also gets `@solana-program/token`.

### Fixed
- `typesol idl publish` names the reason a write failed (the transaction's error and its last log lines) instead of
  "The provided transaction plan failed to execute".

### Docs
- docs/mainnet.md: from `typesol init` to a verified program on mainnet-beta (wallet, cost, deploy, IDL, `verify`,
  freezing and closing).
- README: the official escrow on mainnet-beta in all four versions, with each transaction's compute units linked to
  Solscan; the TypeSOL program's IDL is published on chain.

## 0.14.0 — 2026-10-27

PDAs are derived without the PDA syscalls, so instructions that create, check or search for PDAs use up to a few
thousand fewer compute units. No language, IDL or error-code changes. Not externally audited (see SECURITY.md).

### Performance
- PDAs are derived with the `sol_sha256` and `sol_curve_validate_point` syscalls instead of
  `sol_try_find_program_address` / `sol_create_program_address` (1,500 CU per bump tried): the
  same addresses, bumps and limits (16 seeds to check, 15 to search, 32 bytes each). `init` with seeds, `Seeds<…>`,
  `create`, `signer` and `findProgramAddress` all use it. Benchmarks: counter.initialize 3,030 → 1,872 CU,
  escrow.make 5,974 → 3,638; in the official examples escrow take_offer 14,519 → 7,117 and close_user 1,728 → 586.
  Binaries grow 0.4–1.2 KB. New tests compare it with @solana/kit's derivation over random seeds, canonical bumps
  below 255 and on-curve bumps. Needs the curve25519 syscalls (active on mainnet-beta since epoch 637).

## 0.13.0 — 2026-10-27

Every program in solana-developers/program-examples now ports to TypeSOL: PDA seeds from account fields, remaining
accounts passed on in CPIs, transfer hooks with extra accounts, `findProgramAddress` and marker accounts. Not externally
audited (see SECURITY.md).

### Added
- Transfer hooks with extra accounts: `initExtraAccountMetas(payer, account, mint, systemProgram, extraAccounts)` writes
  an ExtraAccountMetaList (fixed addresses, PDAs of this program or of another program's account index, with literal,
  account-key, account-data and instruction-data seeds), byte for byte what spl-tlv-account-resolution writes; Token-2022
  checks the extra accounts against it on every transfer. `updateExtraAccountMetas(...)` rewrites and resizes a list.
- Remaining accounts in a CPI: spread them into `invoke`'s account list with the flags they were passed with
  (`...remainingAccounts()`, Rust's `extend_from_slice`) or all with one role (`...readonly(rest)`,
  `...writable(rest)`), and take part of them with `rest.slice(a, b)`. A CPI lists at most 32 accounts (5113); a slice
  out of range fails with 5104.
- `findProgramAddress(seeds, program)`: the canonical PDA of another program at runtime.
- PDA seeds from account fields: `Seeds<…, ["@pool.amm", "@mintA", "authority"]>` takes a Pubkey, integer or unit
  enum field of a struct account parameter, including the account's own (`Seeds<Mut<Offer>, ["offer", "@maker",
  "@offer.id"], "bump">`), like Anchor's `seeds = [pool.amm.as_ref(), …]`. Recorded in the IDL as account paths
  (`pool.amm`).
- Structs with no fields, for marker accounts that are only a discriminator (Anchor `#[account] pub struct
  NftAuthority {}`).

### Fixed
- An associated token account created in the instruction (`Ata<Init|InitIfNeeded<TokenAccount>>`) refuses optional
  TokenProgram / AssociatedTokenProgram / SystemProgram parameters at compile time (they used to fail at runtime with an
  access violation when left out), and refuses `Owner<…>` / `Executable<…>` (which could never hold).
- Unit enum values work as seeds in `create`, `signer([...])`, `findProgramAddress` and the other seed lists, one byte
  each, as they already did in `Seeds<…>`.
- `rest.slice(a, b)` is typed as something to spread into a CPI only (`RemainingSlice`), with a clear message elsewhere.

### Tooling
- Ports: the five transfer-hook examples with extra accounts (account-data-as-seed, allow-block-list-token, counter,
  transfer-cost, transfer-switch) are ported; their tests transfer through Token-2022, which checks the extra accounts.
  All 46 program-examples are ported now: 9 PORTED, 37 PARTIAL, 0 BLOCKED. The blocked-construct probes
  (test/ports-blocked.test.ts) are gone with the last blocker.
- Ports: compression/cnft-burn, cnft-vault, cutils and token-2022/transfer-fee, blocked until now, are ported (PARTIAL;
  test/ports/README.md). The compression ports run against Bubblegum, SPL Account Compression and Token Metadata, with
  the leaf hashes, roots and proofs computed in the tests.
- Ports: the eight remaining program-examples that had not been attempted are ported: basics/repository-layout and
  token-2022 cpi-guard, group, immutable-owner, interest-bearing, memo-transfer, metadata and nft-meta-data-pointer
  (all PARTIAL; test/ports/README.md lists the differences). Every one of the 46 programs is now ported or blocked
  by a named construct.
- Ports: token-swap is now PORTED (its `amm`, `pool`, authority and liquidity-mint PDAs are all checked
  declaratively, with no bump arguments); escrow and token-fundraiser check their PDAs declaratively instead of with
  `requirePda` in the body.

## 0.12.1 — 2026-10-27

No change to the compiler, the runtime or the generated code.

### Tooling
- Releases are published to npm through trusted publishing: the release workflow authenticates with GitHub's OIDC
  token, and no npm token is stored in the repository.

## 0.12.0 — 2026-10-27

Associated token accounts created in the instruction, PDA bumps without arguments, and the first npm release, as
`@typesol/cli`. Not externally audited (see SECURITY.md).

### Added
- `Ata<Init<TokenAccount>, "owner", "mint">` / `Ata<InitIfNeeded<TokenAccount>, "owner", "mint">` (Anchor `init` /
  `init_if_needed` with `associated_token::mint` and `associated_token::authority`): `acct.create(payer)` /
  `acct.createIfNeeded(payer)` create the associated token account in the instruction, after which it is a typed
  `TokenAccount` for the token CPIs. `createIfNeeded` skips the ATA program CPI when the account exists (checking its
  address, mint and owner instead) and returns whether it created it. SPL Token and Token-2022.
- `acct.pdaBump` on `Seeds<…>` accounts (Anchor `ctx.bumps`): the stored bump field when the constraint names one,
  otherwise the canonical bump the check found. Programs no longer need a bump argument to sign as a PDA they check.

### Changed
- Published on npm as **`@typesol/cli`** (npm refuses the unscoped name `typesol` as too similar to other packages).
  Programs still import from `"typesol"`: `typesol init` adds the package under that name
  (`"typesol": "npm:@typesol/cli@^…"`), and existing projects can do the same with
  `npm install -D typesol@npm:@typesol/cli`. The command stays `typesol`.

### Tooling
- Ports: escrow, token-2022/basics, token-fundraiser and pda-rent-payer are now PORTED (same interface as upstream);
  transfer-tokens, pda-mint-authority, nft-operations, token-swap, merkle-tree-token-claimer and
  external-delegate-token-master drop their hand-encoded token CPIs or bump arguments (test/ports/README.md).

## 0.11.0 — 2026-10-27

Pinocchio-level code generation, a typed TypeScript client, and the release process the organization uses from now
on. Not externally audited (see SECURITY.md).

### Breaking
- `invoke` takes at most 32 accounts; a longer list is a compile error.
- The project is spelled **TypeSOL** in docs, CLI help and runtime messages (`TypeSOL: arithmetic overflow (file.ts:12)`).
  Tools that match log text on the old spelling need updating. The npm package and command stay `typesol`.
- Generated code changed throughout (see Performance), so programs rebuilt with 0.11 have new binary hashes:
  `typesol verify` compares a deployment with a build by the same version.

### Added
- A typed TypeScript client per program: `typesol build` writes `<name>.client.ts` (on `@solana/kit` only) with
  instruction builders that fill in fixed addresses and PDAs, account decoders and fetchers, PDA helpers, error names,
  event parsing and return-data decoders. The file uses no TypeScript-only syntax, so it also runs under Node's type
  stripping. `typesol client <idl.json>` writes one from an Anchor IDL (0.30+), after validating it: an IDL whose names,
  bytes or codes could not be embedded safely is refused. See docs/client.md.

- Tests: 30 Anchor programs from solana-developers/program-examples rewritten in TypeSOL, with their original flows
  and failure paths, plus probes for the constructs that still block 9 programs (test/ports/README.md).

### Changed
- The CLI banner spells TypeSOL, in TypeScript blue and the Solana gradient on terminals with color (`NO_COLOR`
  turns it off).
- The README shows a benchmark chart and table generated from the benchmark results (`scripts/readme-bench.ts`).

### Performance
Same checks, error codes and account state; fewer compute units and smaller binaries. counter.increment 926 → 110 CU,
vault.withdraw 1,394 → 315, vault.shut 1,190 → 161, vault.deposit 2,436 → 1,314; counter / vault binaries
29.9 / 33.6 KB → 12.8 / 16.1 KB. The benchmarks now include an SPL Token escrow; TypeSOL is below Pinocchio on all
nine benchmarked instructions (see the README numbers).
- Accounts are read in place. Generated code works on `TsAccount`, the loader's serialized account record, so the
  entry point stores one pointer per account instead of filling a `SolAccountInfo` (about 14 CU per account), and
  lengths a CPI changes no longer need refreshing afterwards. CPIs build `SolAccountInfo` records only for the
  accounts they list (`ts_invoke`).
- Duplicate writable accounts (2040) are found by comparing account records, one instruction per pair: the loader
  passes repeats as duplicates of one record.
- PDA signer seeds that read account fields (`["offer", offer.maker, offer.seed, offer.bump]`) point at the account
  data instead of copying it, when no seed contains a call or a write.
- The entry point's account and CPI arrays live inside `TsParams`, so setting it up stores nothing.
- Pubkey, discriminator and other byte comparisons, copies and zeroing work 8 bytes at a time (`ts_key_eq`,
  `ts_mem_eq`, `ts_memcpy`, `ts_memzero`) instead of the SDK's byte loops.
- Instruction dispatch compares an 8-byte discriminator as one u64.
- The rent-exempt minimum uses integer math when the exemption threshold is a whole number (every cluster) and the
  product stays below 2^53, where it is bit-identical to the floating-point formula; other thresholds still take it.
- Checked u64 `+`, `-` and `*` compile to one compare; `*` skips the 128-bit multiply when both factors fit in 32 bits.
- Programs link with `--gc-sections` and `--strip-all` (clang `-ffunction-sections -fdata-sections`): unused
  compiler-builtins code and the symbol tables are dropped. Build manifests' binary hashes change accordingly.

### Security
- Development dependencies: `jayson` 5 and `toml` 5.0.1 (pnpm overrides) for advisories in packages that
  `@anchor-lang/core` pulls into the test toolchain; nothing in the published package changed.

### Tooling
- Releases follow the organization's versioning policy (typesol/.github VERSIONING.md). Tags and GitHub Releases never
  publish: publishing to npm is a separate workflow started by hand, which builds and tests the tag without caches.

## 0.10.0 — 2026-10-23

First release candidate. Not externally audited (see SECURITY.md).

### Breaking
- `verifySecp256k1(hash, …)`: `hash` must be `keccak256(...)` or the new `ethMessageHash(message)` written inline.
- `switchboardValue(feed, expectedFeed, maxStaleSlots, decimals)`: new `expectedFeed` argument.
- Pubkey, struct and data-enum helper arguments are copies (code that relied on seeing later writes through them changes).
- `log(integer)` prints decimal instead of `sol_log_64` hex words.
- IDL `relations` now follow Anchor (on the account a `has_one` names, listing its holders): IDL bytes change.
- `typesol verify` exits 3 on a mismatch (2 is now "usage error"); unknown CLI options are errors.
- `typesol.json` program entries become `{ "path", "address" }` objects on first build (plain paths still accepted).
- Node.js 22.12+ is required.

### Security fixes (internal audit)
- Event, `emitCpi`, `invoke` and Metaplex data buffers check bounds on every write after a variable-size field
  (previously a long string followed by fixed fields could write past the stack buffer).
- `realloc` never moves lamports out of the account: growth is paid by the payer (rent difference), shrinking
  refunds nothing, and it takes only `Mut<Struct>` accounts of this program.
- Optional program accounts are checked before their methods run; `loadForeign` validates bools, enums and text
  (3003); cached account lengths are refreshed after every CPI.
- A discriminator that collides with the `emitCpi` event tag is a compile error.
- Constraints may no longer depend on optional accounts (they could be skipped by leaving the account out).
- `verifySecp256k1` requires the hash to be computed in the program (`keccak256(...)` or `ethMessageHash(...)`).
- Token-2022 extension readers refuse multisig and non-mint accounts; `Ata<>` also checks the owner and mint fields;
  `switchboardValue` takes the expected feed; `rentExempt` overflow aborts.

### Correctness fixes
- `Vec.push`/`set` evaluate their value before the Vec changes; object literals and event fields evaluate in source
  order; builtin and helper arguments are read left to right; seeds are copied as they are evaluated.
- Pubkey, struct and data-enum helper arguments are values; a helper that may replace a struct while a reference
  into it is still used is a compile error.
- IDL `relations` follow Anchor's direction; nested event structs with Options are refused; reserved IDL type names,
  duplicate error names, duplicate data-enum cases, bad seed literals and bare `null` in CPI data are diagnostics.
- String arguments must be valid UTF-8 (102); empty Options in struct arguments must be zeroed.
- C string literals use octal escapes (non-ASCII text followed by hex-digit letters was mis-encoded).
- `log(integer)` prints decimal.
- A local may not shadow an instruction or helper parameter (lookups resolved to the account).
- `a.equals(f())`, `place = f()` (the target is chosen first), `requirePda`, `pythPrice`, `verifyEd25519` and
  `merkleVerify` evaluate left to right; assigning a helper result into a Vec element the helper may change is an error.
- u128/i128 constant seeds are 16 bytes in the IDL (as in the program).
- Struct helper arguments in loops reuse one buffer per call site instead of taking heap on every pass.
- Generated CPI bindings accept enum arguments; helper parameter names reserve `__` and `$`; file names with quotes,
  self-comparisons and 256-variant enums compile.

### Tooling
- Strict per-command options (`typesol <command> --help`), exit code 2 for usage errors, 3 for `verify` mismatches.
- Project builds honour `--sbpf`/`--profile`; program addresses are recorded in `typesol.json` and checked against
  the keypair; a program's `.ts` builds as that program.
- Clearer errors (missing toolchain, `solana` not on PATH, invalid `typesol.json`, missing files).
- Toolchain discovery next to `cargo-build-sbf` on PATH; `.d.ts` for every subpath export; one version number.
- The code generator is split into layered modules under `src/compiler/emit/` (generated C is byte-identical).

### Earlier (0.1 – 0.9, development)
Compiler, runtime and CLI built up to: accounts and Anchor-style constraints, PDAs, CPIs (System, SPL Token,
Token-2022, ATA, Metaplex Token Metadata / Core / Bubblegum, generic `invoke`, typed helpers from IDLs), events
and `emitCpi`, data enums, Options, Vecs, 128-bit integers, oracles (Pyth, Switchboard), signature checks,
optional accounts, realloc, transfer hooks, Anchor-compatible IDLs and error codes, on-chain IDL publishing,
profiling, SBPF v0–v2, reproducible builds.
