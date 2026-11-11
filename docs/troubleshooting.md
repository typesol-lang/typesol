# Troubleshooting

**"Solana SBF SDK not found"** — install the Agave CLI (https://docs.anza.xyz/cli/install) and run
`cargo-build-sbf --version` once. TypeSOL looks in `~/.local/share/solana/install/active_release/bin/platform-tools-sdk/sbf`
and next to `cargo-build-sbf` on PATH; set `TYPESOL_SBF_SDK` to a `platform-tools-sdk/sbf` directory otherwise.

**"platform-tools missing" / "no SBPF v2 libraries"** — `cargo-build-sbf --force-tools-install`.

**Windows** — not tested; use WSL2 with the Linux Agave CLI.

**Node errors such as `ERR_UNKNOWN_FILE_EXTENSION` or `ERR_REQUIRE_ESM`** — use Node.js 22.12 or newer.

**"`solana` was not found on PATH"** (deploy) — install the Agave CLI, or use `typesol deploy --dry-run` and run the
printed commands yourself.

**"… is missing, but typesol.json records …"** — the program keypair under `target/deploy/` was deleted or replaced.
Restore it from your backup. Without it you cannot upgrade the deployed program; removing `"address"` from
`typesol.json` gives the program a new address.

**A build error you don't recognize** — the compiler adds a `hint:` line under TypeScript's message where TypeScript's
own advice points the wrong way for a program. The usual ones: integers are `bigint` (`1n`, `u64` parameters, not
`number`); `require`, `log`, `min`, `max` and `fixedArray` are imported from `"typesol"`; arrays are read with `.get(i)`
and written with `.set(i, v)`; an account you change is a `Mut<T>` parameter; there is no `async`, `try`, `throw` or
`class`. The full list of what the subset covers is in [language.md](language.md).

**A transaction fails with a custom error** — see [errors.md](errors.md). Failures raised by the
compiler's checks log their TypeScript location, e.g. `TypeSOL: arithmetic overflow (vault.ts:42)`.

**Heap errors (5110) building strings** — strings are allocated on a 32 KiB heap and never freed. Build less text,
or declare `const HEAP_SIZE_KIB = 64n` and add a ComputeBudget `requestHeapFrame` instruction to the transaction.

**`typesol idl publish` fails on a local validator with "invalid instruction data"** — the System Program of
`solana-test-validator` (Agave 3.1 included) rejects a System instruction that the current Program Metadata program
uses. Publishing works on mainnet-beta. The error shows the failing transaction's last log lines.

**"instruction X (with the helpers inlined into it) needs N bytes of stack; SBPF v0 gives each function 4096"** — under
SBPF v0 (the default) every function gets a fixed 4 KiB stack frame, and going past it corrupts memory, so the build
refuses it. SBPF v1 and v2 (`--sbpf v1` / `v2`) grow frames dynamically, so this limit does not apply there. Large structs and arrays copied into typed
locals (`const q: Big = acct.big`) are the usual cause: bind them without a type (`const q = acct.big`, a reference
into the account data). The message lists the biggest locals (clang's frame layout: a local's name and the source
line near it; the locals of an inlined helper show as unnamed, with the helpers' locals that may be them). Helpers are
often inlined into their instruction, so their locals count toward its frame: mark one `/** @noinline */` to give it a
4 KiB frame of its own (a few compute units per call), or declare a large local list or struct of an instruction
`/** @heap */` to keep it on the heap (about 18 CU for the allocation).

