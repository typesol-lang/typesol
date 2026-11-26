// What the entrypoint of Percolator v16 at commit 7b110913 (engine 5e3af07; aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0) does at its limits, recorded by experiment so that the port can match it: how
// many accounts it takes, what its heap does when a transaction's frame is smaller than its allocator assumes, how it
// fails a RefCell borrow on a repeated account, and what it logs on a panic. The reference (test/programs/
// percolator_v16.so, the Rust build of those commits, not a deployed program) is driven where it can be; where no
// instruction reachable so far fails that way, a probe built with the same entrypoint, shim and toolchain stands in
// (test/programs/percolator_v16_probe.so, scripts/percolator-v16-reference/probe/). TESTING.md sums up the rules.
import { type Address, AccountRole, type KeyPairSigner, getAddressEncoder, getBase58Encoder, lamports, signBytes } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM, type TransactionMetadata } from "litesvm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { present } from "../../test/binaries.js";
import { send as sendTx } from "../../test/harness.js";
import { Diff, HAVE_REFERENCE, PROGRAM, builtin, custom, defaultInitArgs, instruction, ix, u8, u32, u64 } from "./percolator-v16-helpers.js";

const PROBE_FILE = fileURLToPath(new URL("../../test/programs/percolator_v16_probe.so", import.meta.url));
const HAVE_PROBE = present(PROBE_FILE);
const PROBE = "Probe11111111111111111111111111111111111111" as Address;

type Result = TransactionMetadata | FailedTransactionMetadata;
const errOf = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
/** The log lines but the Compute Budget program's and the compute-unit lines, the program written <program>. */
const logsOf = (r: Result, program: Address) =>
  (r instanceof FailedTransactionMetadata ? r.meta() : r)
    .logs()
    .filter((l) => !l.includes("ComputeBudget111") && !/ consumed \d+ of \d+ compute units$/.test(l))
    .map((l) => l.replaceAll(program, "<program>"));

/** A compact-u16. */
const compact = (n: number) => {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (!n) return [...out, b];
    out.push(b | 0x80);
  }
};

/**
 * One instruction naming `refs` accounts (repeats of `keys`, read-only) as a legacy message encoded by hand: @solana/kit
 * refuses to compile an instruction of more than 255 accounts, which is what the runtime is asked about here.
 */
async function rawSend(vm: LiteSVM, payer: KeyPairSigner, program: Address, keys: Address[], refs: number, data: number[]): Promise<Result> {
  const enc = getAddressEncoder();
  const all = [payer.address, ...keys, program];
  const msg = [1, 0, keys.length + 1, ...compact(all.length)];
  for (const k of all) msg.push(...enc.encode(k));
  msg.push(...getBase58Encoder().encode(vm.latestBlockhash()));
  msg.push(...compact(1), all.length - 1, ...compact(refs));
  for (let i = 0; i < refs; i++) msg.push(1 + (i % keys.length));
  msg.push(...compact(data.length), ...data);
  const messageBytes = new Uint8Array(msg);
  const signature = await signBytes(payer.keyPair.privateKey, messageBytes);
  const r = vm.sendTransaction({ messageBytes, signatures: { [payer.address]: signature } } as never);
  vm.expireBlockhash();
  return r;
}

describe.skipIf(!HAVE_REFERENCE)("Percolator v16 reference: accounts, heap and repeated accounts", () => {
  it("takes up to 255 accounts, all of them; the runtime refuses 256 before the program runs", async () => {
    const d = await Diff.create({ port: "reference" });
    const m = await d.market();
    const keys = await Promise.all(Array.from({ length: 20 }, () => d.address()));
    for (const k of keys) d.reference.airdrop(k, lamports(1_000_000n));
    // InitPortfolio's three accounts and a tail of 252 (20 distinct, repeated): the tail is ignored, the instruction
    // succeeds. 39 accounts likewise.
    for (const extra of [36, 252]) {
      const { owner, portfolio } = await d.newPortfolio();
      const base = ix.initPortfolio(m, owner, portfolio);
      const tail = Array.from({ length: extra }, (_, i) => ({ address: keys[i % keys.length]!, role: AccountRole.READONLY }));
      const r = await sendTx(d.reference, owner, d.transaction([{ ...base, accounts: [...base.accounts!, ...tail] }]));
      expect(errOf(r), `InitPortfolio + ${extra}`).toBe("ok");
    }
    // 255 accounts reach the program (it decodes and refuses the tag); 256 and more never do: MaxAccountsExceeded,
    // from the runtime, with no compute units spent. The port gets the same refusal from the runtime.
    const payer = await d.funded();
    const at255 = await rawSend(d.reference, payer, PROGRAM, keys, 255, [2]);
    expect(errOf(at255)).toBe(builtin("InvalidInstructionData", 0).replace(/^error: /, ""));
    for (const refs of [256, 300]) {
      const r = await rawSend(d.reference, payer, PROGRAM, keys, refs, [2]);
      expect(errOf(r)).toBe("TransactionErrorInstructionError { index: 0, error: MaxAccountsExceeded }");
      expect(logsOf(r, PROGRAM)).toEqual(["Program <program> invoke [1]", "Program <program> failed: Max accounts exceeded"]);
      expect(r instanceof FailedTransactionMetadata && r.meta().computeUnitsConsumed()).toBe(0n);
    }
  });

  it("the heap: its account list fits the runtime's default 32 KiB frame at any count a transaction allows", async () => {
    // 255 accounts, 61 of them distinct (with the payer and the program a transaction locks at most 64), no heap
    // request: the shim's three Vecs and two Rc boxes per distinct account (about 21 KiB) fit, and the tag is refused
    // as usual. Heap exhaustion can only come from what a handler allocates on top (see TESTING.md).
    const d = await Diff.create({ port: "reference" });
    const payer = await d.funded();
    const keys = await Promise.all(Array.from({ length: 61 }, () => d.address()));
    const r = await rawSend(d.reference, payer, PROGRAM, keys, 255, [2]);
    expect(errOf(r)).toBe("TransactionErrorInstructionError { index: 0, error: InvalidInstructionData }");
    expect(logsOf(r, PROGRAM)).toEqual(["Program <program> invoke [1]", "Program <program> failed: invalid instruction data"]);
  });

  it("repeated accounts at InitMarket and InitPortfolio are refused by the handlers' checks before any borrow", async () => {
    // Where the original would hold one RefCell borrow while taking another on the same account, an earlier check
    // refuses first at these two instructions: no AccountBorrowFailed is reachable yet.
    const d = await Diff.create({ port: "reference" });
    const m = await d.market();
    const { owner, portfolio } = await d.newPortfolio();
    const base = ix.initPortfolio(m, owner, portfolio);
    const [o, market, p] = base.accounts!;
    const send = (label: string, payer: KeyPairSigner, accounts: typeof base.accounts) =>
      sendTx(d.reference, payer, d.transaction([{ ...base, accounts }])).then((r) => [label, errOf(r)]);
    expect(await send("portfolio = market", owner, [o!, market!, market!])).toEqual(["portfolio = market", custom(2, 2).replace(/^error: /, "")]);
    expect(await send("market = portfolio", owner, [o!, p!, p!])).toEqual(["market = portfolio", custom(3, 2).replace(/^error: /, "")]);
    const n = await d.newMarket();
    const init = ix.initMarket(n, defaultInitArgs());
    const [admin, nm] = init.accounts!;
    const r = await sendTx(d.reference, n.admin, d.transaction([{ ...init, accounts: [admin!, nm!, nm!] }]));
    // The market given as its own mint: InvalidMint.
    expect(errOf(r)).toBe(custom(10, 2).replace(/^error: /, ""));
  });
});

describe.skipIf(!HAVE_PROBE)("pinocchio 0.11.1's entrypoint and the v16 account shim (the probe)", () => {
  let vm: LiteSVM;
  let d: Diff;
  let payer: KeyPairSigner;
  let acct: Address;
  beforeAll(async () => {
    d = await Diff.create({ port: "reference" });
    vm = d.reference;
    vm.addProgram(PROBE, new Uint8Array(readFileSync(PROBE_FILE)));
    payer = await d.funded();
    acct = await d.address();
    vm.setAccount({ address: acct, data: new Uint8Array(8), executable: false, lamports: lamports(1_000_000n), programAddress: PROBE, space: 8n });
  });
  /** One probe operation behind the preamble (`heap` as in the harness: 256 KiB by default, null for none). */
  const run = (data: Uint8Array | Buffer, accounts: Address[] = [], heap: number | null = 256 * 1024) =>
    sendTx(
      vm,
      payer,
      d.transaction([{ programAddress: PROBE, accounts: accounts.map((address) => ({ address, role: AccountRole.WRITABLE })), data: new Uint8Array(data) }], {
        heap,
      }),
    );
  const index = (heap: number | null) => (heap === null ? 1 : 2);
  const panicked = (file: string, heap: number | null = 256 * 1024) => ({
    err: `TransactionErrorInstructionError { index: ${index(heap)}, error: ProgramFailedToComplete }`,
    logs: ["Program <program> invoke [1]", `Program log: ${file}`, "Program log: ** PANICKED **", "Program <program> failed: SBF program panicked"],
  });
  const outcome = (r: Result) => ({ err: errOf(r), logs: logsOf(r, PROBE) });

  it("a panic logs the file of its location, ** PANICKED **, then aborts: ProgramFailedToComplete", async () => {
    // panic!, an index out of bounds and Vec::with_capacity's capacity check, all reported at the probe's src/lib.rs.
    expect(outcome(await run(u8(0)))).toEqual(panicked("src/lib.rs"));
    expect(outcome(await run(Buffer.from([1, 9])))).toEqual(panicked("src/lib.rs"));
    expect(outcome(await run(Buffer.concat([u8(2), u64(1n << 62n)])))).toEqual(panicked("src/lib.rs"));
  });

  it("a RefCell conflict on a repeated account: try_borrow_* is AccountBorrowFailed, borrow / borrow_mut a panic", async () => {
    // try_borrow_mut_data twice on one account (the account passed twice): the shim maps the legacy error one to one.
    const r = await run(u8(4), [acct, acct]);
    expect(outcome(r)).toEqual({
      err: "TransactionErrorInstructionError { index: 2, error: AccountBorrowFailed }",
      logs: ["Program <program> invoke [1]", "Program <program> failed: instruction tries to borrow reference for an account which is already borrowed"],
    });
    // Two distinct accounts: no conflict.
    expect(errOf(await run(u8(4), [acct, payer.address]))).toBe("ok");
    // RefCell::borrow_mut in the program's own code: a panic in that file; AccountInfo::lamports() (a borrow inside
    // solana-program): a panic in solana-program's src/account_info.rs.
    expect(outcome(await run(u8(5), [acct, acct]))).toEqual(panicked("src/lib.rs"));
    expect(outcome(await run(u8(6), [acct, acct]))).toEqual(panicked("src/account_info.rs"));
  });

  it("the heap: the allocator assumes 256 KiB; past the real frame is an access violation, past 256 KiB out of memory", async () => {
    const alloc = (bytes: number) => Buffer.concat([u8(3), u32(bytes)]);
    // The first allocation starts at the heap's start + 8 (the allocator keeps its position in the first word).
    const first = await run(alloc(16 * 1024), [], null);
    expect(errOf(first)).toBe("ok");
    expect(Buffer.from((first as TransactionMetadata).returnData().data()).readBigUInt64LE(0)).toBe(0x3_0000_0008n);
    // 40 KiB on the default 32 KiB frame: the allocation succeeds, the first write past the frame faults.
    expect(outcome(await run(alloc(40 * 1024), [], null))).toEqual({
      err: "TransactionErrorInstructionError { index: 1, error: ProgramFailedToComplete }",
      logs: ["Program <program> invoke [1]", "Program <program> failed: Access violation writing 1 bytes at address 0x30000a007 (in unallocated region)"],
    });
    expect(errOf(await run(alloc(40 * 1024), [], 64 * 1024))).toBe("ok");
    expect(errOf(await run(alloc(200 * 1024)))).toBe("ok");
    // More than 256 KiB: the allocator refuses, whatever the frame; std's handler logs and aborts.
    for (const heap of [256 * 1024, null])
      expect(outcome(await run(alloc(300 * 1024), [], heap))).toEqual({
        err: `TransactionErrorInstructionError { index: ${index(heap)}, error: ProgramFailedToComplete }`,
        logs: ["Program <program> invoke [1]", "Program log: Error: memory allocation failed, out of memory", "Program <program> failed: SBF program panicked"],
      });
  });

  it("the entrypoint hands the program every account up to 255, repeats included", async () => {
    const keys = await Promise.all(Array.from({ length: 20 }, () => d.address()));
    const r = await rawSend(vm, payer, PROBE, keys, 255, [7]);
    expect(errOf(r)).toBe("ok");
    const out = Buffer.from((r as TransactionMetadata).returnData().data());
    expect(out.readUInt16LE(0)).toBe(255);
    const enc = getAddressEncoder();
    for (let i = 0; i < 255; i++) expect(out[2 + i], `account ${i}`).toBe(enc.encode(keys[i % 20]!)[0]);
  });
});
