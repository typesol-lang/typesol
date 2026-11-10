// The built-in RedBlackTree against lib-sokoban 0.3 itself: traces recorded by running the real crate's
// RedBlackTree<K, V, N> (test/verification/rbtree/oracle, a small Rust program) are replayed one operation per
// transaction on test/fixtures/rbtree.ts in LiteSVM, and after every operation the tree's bytes (root, allocator,
// every node: registers, keys and values, freed nodes included) must hash as the crate's did, and the operation must
// return what the crate's returned. Capacities 1, 2, 3, 7, 64 and 512; u64 keys (stride 32), Phoenix's FIFOOrderId
// with its side-dependent comparator (bids and asks, stride 64) and Pubkey keys with Phoenix's TraderState (stride
// 144). The committed set is test/verification/rbtree/traces.jsonl.gz (7,320 operations; rebuilt by
// test/verification/rbtree/regenerate.sh); RBTREE_TRACES=<file.jsonl[.gz]> replays another, such as the
// million-operation runs the oracle makes (see the script).
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
type Op = [string, ...(string | number | string[])[]];
interface Trace {
  shape: "u64" | "bid" | "ask" | "mixed" | "trader";
  cap: number;
  seed: number;
  ops: Op[];
  res: (number | string | null | [number, number])[];
  hash: string[];
}

const M64 = (1n << 64n) - 1n;
/** The oracle's splitmix64. */
function splitmix64(x: bigint): bigint {
  let z = (x + 0x9e3779b97f4a7c15n) & M64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return z ^ (z >> 31n);
}
const words = (seed: bigint, n: number) => Array.from({ length: n }, (_, j) => splitmix64((seed + BigInt(j)) & M64));
const u64le = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
/** The oracle's Pubkey key for `kseed`: 16 bytes shared by a third of the keys, then 16 of its own. */
function pubkeyOf(kseed: bigint): Buffer {
  return Buffer.concat([...words(1000n + (kseed % 3n), 2).map(u64le), ...words((kseed * 2n) & M64, 2).map(u64le)]);
}

const STRIDE = { u64: 32, bid: 64, ask: 64, mixed: 64, trader: 144 } as const;
const SHAPE = { u64: 0, bid: 1, ask: 1, mixed: 1, trader: 2 } as const;
const ARGS = { u64: 16, bid: 48, ask: 48, mixed: 48, trader: 128 } as const;
const OFFSET = 40; // the result block (24 bytes) and 16 bytes of pattern before the tree
const TAIL = 24; // pattern after it

function keyBytes(shape: Trace["shape"], k: string | string[]): Buffer {
  if (shape === "u64") return u64le(BigInt(k as string));
  if (shape === "trader") return pubkeyOf(BigInt(k as string));
  const [price, seq] = k as string[];
  return Buffer.concat([u64le(BigInt(price!)), u64le(BigInt(seq!))]);
}
function valueBytes(shape: Trace["shape"], vseed: number): Buffer {
  const n = shape === "u64" ? 1 : shape === "trader" ? 12 : 4;
  return Buffer.concat(words(BigInt(vseed), n).map(u64le));
}
function opData(t: Trace, op: Op): Buffer {
  const code = { init: 0, i: 1, r: 2, g: 3, mn: 4, mx: 5, f: 6, b: 7, a: 8 }[op[0]]!;
  const head = Buffer.concat([Buffer.from([code, SHAPE[t.shape]]), u64le(BigInt(OFFSET)), u64le(BigInt(t.cap))]);
  let args: Buffer = Buffer.alloc(0);
  if (op[0] === "i") args = Buffer.concat([keyBytes(t.shape, op[1] as string), valueBytes(t.shape, op[2] as number)]);
  else if (op[0] === "r" || op[0] === "g" || op[0] === "a") args = keyBytes(t.shape, op[1] as string);
  else if (op[0] === "f" || op[0] === "b") args = u64le(BigInt(op[1] as number));
  const padded = Buffer.alloc(18 + ARGS[t.shape]);
  Buffer.concat([head, args]).copy(padded);
  return padded;
}

const file = process.env.RBTREE_TRACES ?? fileURLToPath(new URL("./rbtree/traces.jsonl.gz", import.meta.url));
const raw = readFileSync(file);
const traces: Trace[] = (file.endsWith(".gz") ? gunzipSync(raw) : raw)
  .toString("utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Trace);

describe("RedBlackTree against lib-sokoban 0.3 (recorded traces)", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/rbtree.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 1000n);
  }, 120_000);

  const bytes = (a: Address) => {
    const acct = d.svm.getAccount(a);
    if (!acct.exists) throw new Error("account gone");
    return Buffer.from(acct.data);
  };
  const run = async (a: Address, data: Buffer) => {
    const r: Result = await send(d.svm, payer, [
      { programAddress: d.programId, accounts: [{ address: a, role: AccountRole.WRITABLE }], data: new Uint8Array(data) } as Instruction,
    ]);
    if (r instanceof FailedTransactionMetadata) throw new Error(`failed: ${String(r.err())}\n${r.meta().logs().join("\n")}`);
    return r;
  };

  it(`replays ${traces.length} traces, ${traces.reduce((n, t) => n + t.ops.length, 0)} operations, byte for byte`, async () => {
    let checked = 0;
    for (const t of traces) {
      const a = (await generateKeyPairSigner()).address;
      const size = 32 + t.cap * STRIDE[t.shape];
      const data = Buffer.alloc(OFFSET + size + TAIL);
      for (let i = 24; i < OFFSET; i++) data[i] = (i * 7 + 3) & 0xff;
      for (let i = OFFSET + size; i < data.length; i++) data[i] = (i * 5 + 1) & 0xff;
      const pattern = Buffer.concat([data.subarray(24, OFFSET), data.subarray(OFFSET + size)]);
      d.svm.setAccount({ address: a, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data } as never);
      await run(a, opData(t, ["init"]));
      for (let s = 0; s < t.ops.length; s++) {
        const op = t.ops[s]!;
        await run(a, opData(t, op));
        const now = bytes(a);
        const where = `${t.shape} cap ${t.cap} seed ${t.seed} step ${s} ${JSON.stringify(op)}`;
        const hash = createHash("sha256")
          .update(now.subarray(OFFSET, OFFSET + size))
          .digest("hex")
          .slice(0, 16);
        expect(hash, `bytes after ${where}`).toBe(t.hash[s]);
        const out = [0, 8, 16].map((o) => now.readBigUInt64LE(o));
        const want = t.res[s];
        if (op[0] === "i") expect([out[0], out[1]], where).toEqual((want as number) < 0 ? [0n, 0n] : [1n, BigInt(want as number)]);
        else if (op[0] === "r" || op[0] === "g") expect([out[0], out[1]], where).toEqual(want === null ? [0n, 0n] : [1n, BigInt(want as string)]);
        else if (op[0] === "mn" || op[0] === "mx") expect(out[0], where).toBe(BigInt(want as number));
        else if (op[0] === "f" || op[0] === "b") expect([out[0], out[1]], where).toEqual((want as [number, number]).map(BigInt));
        expect(Buffer.concat([now.subarray(24, OFFSET), now.subarray(OFFSET + size)]).equals(pattern), `no write outside the tree: ${where}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(traces.reduce((n, t) => n + t.ops.length, 0));
  }, 1_800_000);
});
