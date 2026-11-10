// The Phoenix v1 binary (test/programs/phoenix_v1.so, as deployed on mainnet) in LiteSVM, with just enough of a client
// to reach the code paths the native-program features copy: InitializeMarket (its overflow and remainder panics, the
// event recorder's self-CPI) and CancelAllOrdersWithFreeFunds (its compute-unit log lines). The tests compare what a
// TypeSOL program logs with what this binary logs.
import { type Address, AccountRole, type Instruction, type KeyPairSigner, address, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM, fundedSigner, pda, send } from "./harness.js";
import { addrBytes, allocate, createMint } from "./ports-helpers.js";

export const PHOENIX = address("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY");
export const PHOENIX_SO = fileURLToPath(new URL("programs/phoenix_v1.so", import.meta.url));

export type Result = TransactionMetadata | FailedTransactionMetadata;
export const logsOf = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
export const errOf = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");

/** A market of 512 bids, 512 asks and 128 seats: the 576-byte header and the FIFOMarket (400 + 128·512 + 144·128). */
export const MARKET_512_SIZE = 576 + 400 + 128 * 512 + 144 * 128;

export interface PhoenixMarket {
  svm: LiteSVM;
  payer: KeyPairSigner;
  market: Address;
  baseMint: Address;
  quoteMint: Address;
  logAuthority: Address;
}

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const u16 = (v: number) => new Uint8Array([v & 0xff, v >> 8]);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

export interface InitParams {
  quoteLotsPerQuoteUnit?: bigint;
  tickSizeInQuoteLotsPerBaseUnit?: bigint;
  baseLotsPerBaseUnit?: bigint;
  takerFeeBps?: number;
  rawBaseUnitsPerBaseUnit?: number | null;
}

/** Phoenix's InitializeParams after the tag (100): MarketSizeParams 512/512/128, lot sizes, fee, fee collector, Option<u32>. */
export function initData(p: InitParams, feeCollector: Address): Uint8Array {
  const raw = p.rawBaseUnitsPerBaseUnit ?? null;
  return cat(
    new Uint8Array([100]),
    u64(512n),
    u64(512n),
    u64(128n),
    u64(p.quoteLotsPerQuoteUnit ?? 1_000_000n),
    u64(p.tickSizeInQuoteLotsPerBaseUnit ?? 1000n),
    u64(p.baseLotsPerBaseUnit ?? 1000n),
    u16(p.takerFeeBps ?? 0),
    addrBytes(feeCollector),
    raw === null ? new Uint8Array([0]) : cat(new Uint8Array([1]), new Uint8Array(new Uint32Array([raw]).buffer)),
  );
}

const meta = (a: Address, role: AccountRole, signer?: KeyPairSigner) => ({ address: a, role, ...(signer ? { signer } : {}) });

/** A fresh VM with Phoenix at its mainnet address, two mints and an allocated (zeroed, Phoenix-owned) market account. */
export async function phoenixMarket(o: { baseDecimals?: number; quoteDecimals?: number } = {}): Promise<PhoenixMarket> {
  const svm = new LiteSVM();
  svm.addProgramFromFile(PHOENIX, PHOENIX_SO);
  const payer = await fundedSigner(svm, 100n);
  const baseMint = await createMint(svm, payer, { decimals: o.baseDecimals ?? 9 });
  const quoteMint = await createMint(svm, payer, { decimals: o.quoteDecimals ?? 6 });
  const market = await generateKeyPairSigner();
  const r = await send(svm, payer, [allocate(svm, payer, market, MARKET_512_SIZE, PHOENIX)]);
  if (r instanceof FailedTransactionMetadata) throw new Error(`allocating the market failed: ${String(r.err())}`);
  const [logAuthority] = await pda(PHOENIX, ["log"]);
  return { svm, payer, market: market.address, baseMint, quoteMint, logAuthority };
}

/** InitializeMarket (tag 100) with these parameters, the payer as the market creator and fee collector. */
export async function initializeMarket(m: PhoenixMarket, p: InitParams = {}): Promise<Result> {
  const [baseVault] = await pda(PHOENIX, ["vault", m.market, m.baseMint]);
  const [quoteVault] = await pda(PHOENIX, ["vault", m.market, m.quoteMint]);
  const ix: Instruction = {
    programAddress: PHOENIX,
    accounts: [
      meta(PHOENIX, AccountRole.READONLY),
      meta(m.logAuthority, AccountRole.READONLY),
      meta(m.market, AccountRole.WRITABLE),
      meta(m.payer.address, AccountRole.WRITABLE_SIGNER, m.payer),
      meta(m.baseMint, AccountRole.READONLY),
      meta(m.quoteMint, AccountRole.READONLY),
      meta(baseVault, AccountRole.WRITABLE),
      meta(quoteVault, AccountRole.WRITABLE),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
      meta(TOKEN_PROGRAM, AccountRole.READONLY),
    ] as Instruction["accounts"],
    data: initData(p, m.payer.address),
  };
  return send(m.svm, m.payer, [ix]);
}

/** CancelAllOrdersWithFreeFunds (tag 7): the program, log authority, market and the signing trader. */
export function cancelAllWithFreeFunds(m: PhoenixMarket): Promise<Result> {
  const ix: Instruction = {
    programAddress: PHOENIX,
    accounts: [
      meta(PHOENIX, AccountRole.READONLY),
      meta(m.logAuthority, AccountRole.READONLY),
      meta(m.market, AccountRole.WRITABLE),
      meta(m.payer.address, AccountRole.READONLY_SIGNER, m.payer),
    ] as Instruction["accounts"],
    data: new Uint8Array([7]),
  };
  return send(m.svm, m.payer, [ix]);
}

/** Any instruction with too few accounts for the entrypoint's `accounts.split_at(4)`. */
export function tooFewAccounts(m: PhoenixMarket, tag: number): Promise<Result> {
  const ix: Instruction = {
    programAddress: PHOENIX,
    accounts: [meta(PHOENIX, AccountRole.READONLY)] as Instruction["accounts"],
    data: new Uint8Array([tag]),
  };
  return send(m.svm, m.payer, [ix]);
}
