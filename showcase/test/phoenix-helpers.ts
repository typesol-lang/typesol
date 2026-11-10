// The differential harness for showcase/mainnet/phoenix against Phoenix v1 as deployed on mainnet
// (test/programs/phoenix_v1.so, Ellipsis-Labs/phoenix-v1 c16694d). The original and the port run in two LiteSVMs
// under the same program id and the same Clock. Every account is made the same way in both VMs (the same keypairs,
// the same bytes), so addresses and bytes agree; `both()` then sends one transaction to each and requires:
//
// - the same outcome;
// - the same log lines, all but the compute-unit lines ("consumed N of M compute units"); the compute units Phoenix
//   logs itself ("Program consumption: N units remaining") are compared by count and position, not N;
// - the same inner instructions, in order: each one's stack height, program, accounts and data bytes (the event
//   recorder's Log self-CPIs among them, so the event batches are compared byte for byte);
// - the same return data;
// - the same lamports, owner and data in every account the transaction names, the fee payer and any others asked for.
//
// Nothing else may differ. Phoenix's entrypoint returns errors without logging them, and so does the port
// (ERROR_LOG_PREFIX and PROGRAM_ERROR_LOG_PREFIX are null), so a failure's lines are compared like any others.
//
// The instruction builders follow program/instruction_builders (the account lists of its create_*_instruction
// functions) and the Borsh layouts of the processors' parameter types, for all 28 tags.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { Clock, FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from "litesvm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { deployFile, pda, send } from "../../test/harness.js";

export const PROGRAM = address("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY");
export const ORIGINAL = fileURLToPath(new URL("../../test/programs/phoenix_v1.so", import.meta.url));
export const PORT = fileURLToPath(new URL("../mainnet/phoenix/phoenix.ts", import.meta.url));
export const LOG_AUTHORITY = address("7aDTsspkQNGKmrexAN7FLx9oxU3iPczSSvHNggyuqYkR");
export const SYSTEM = address("11111111111111111111111111111111");
export const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const SOL = 1_000_000_000n;
/** The Clock both VMs run with (the event header carries its slot and timestamp). */
export const SLOT = 250_000_000n;
export const UNIX_TIMESTAMP = 1_760_000_000n;

export const HEADER_SIZE = 576;
/** size_of::<FIFOMarket<_, N, N, S>>(). */
export const fifoSize = (bids: number, seats: number) => 400 + 128 * bids + 144 * seats;
export const marketSize = (bids: number, seats: number) => HEADER_SIZE + fifoSize(bids, seats);
/** Offsets in the market account. */
export const OFF = {
  status: 8,
  bidsSize: 16,
  asksSize: 24,
  numSeats: 32,
  baseLotSize: 112,
  quoteLotSize: 192,
  authority: 208,
  feeRecipient: 240,
  sequenceNumber: 272,
  successor: 280,
  baseLotsPerBaseUnit: 832,
  orderSequenceNumber: 848,
  takerFeeBps: 856,
  collectedFees: 864,
  unclaimedFees: 872,
  bids: 880,
} as const;
/** The offsets of a sokoban tree's fields, from the tree's start. */
export const TREE = { root: 0, size: 16, bumpIndex: 24, freeListHead: 28, nodes: 32 } as const;
export const asksAt = (bids: number) => OFF.bids + 32 + 64 * bids;
export const tradersAt = (bids: number) => OFF.bids + 2 * (32 + 64 * bids);

/** PhoenixError codes by name. */
export const E = Object.fromEntries(
  [
    "InvalidMarketParameters",
    "InvalidMarketAuthority",
    "FailedToLoadMarketFromAccount",
    "MarketAlreadyInitialized",
    "MarketUninitialized",
    "InvalidStateTransition",
    "InvalidMarketSigner",
    "InvalidLotSize",
    "InvalidTickSize",
    "InvalidMint",
    "InvalidBaseVault",
    "InvalidQuoteVault",
    "InvalidBaseAccount",
    "InvalidQuoteAccount",
    "TooManyEvents",
    "NewOrderError",
    "ReduceOrderError",
    "CancelMultipleOrdersError",
    "WithdrawFundsError",
    "RemoveEmptyOrdersError",
    "TraderNotFound",
    "InvalidSeatStatus",
    "EvictionError",
  ].map((n, i) => [n, i]),
) as Record<string, number>;

export type Result = TransactionMetadata | FailedTransactionMetadata;
export type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };

// ---- Bytes ---------------------------------------------------------------------------------------------------------

const enc = getAddressEncoder();
export const key = (a: string) => Buffer.from(enc.encode(address(a)));
export const u8 = (n: number | bigint) => Buffer.from([Number(n)]);
export const u16 = (n: number | bigint) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(Number(n));
  return b;
};
export const u32 = (n: number | bigint) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n));
  return b;
};
export const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(n)));
  return b;
};
export const u128 = (n: bigint) => Buffer.concat([u64(n & 0xffffffffffffffffn), u64(n >> 64n)]);
export const bool = (v: boolean) => u8(v ? 1 : 0);
/** A Borsh Option. */
export const opt = (v: Buffer | null) => (v === null ? u8(0) : Buffer.concat([u8(1), v]));
export const U64_MAX = 0xffffffffffffffffn;

/** A mint's 82 bytes (SPL Token). */
export function mintBytes(o: {
  decimals: number;
  authority?: Address;
  supply?: bigint;
  initialized?: number;
  authorityTag?: number;
  freezeTag?: number;
}): Buffer {
  const b = Buffer.alloc(82);
  b.writeUInt32LE(o.authorityTag ?? (o.authority ? 1 : 0), 0);
  if (o.authority) key(o.authority).copy(b, 4);
  b.writeBigUInt64LE(o.supply ?? 0n, 36);
  b[44] = o.decimals;
  b[45] = o.initialized ?? 1;
  b.writeUInt32LE(o.freezeTag ?? 0, 46);
  return b;
}

/** A token account's 165 bytes (SPL Token), initialized. */
export function tokenAccountBytes(o: { mint: Address; owner: Address; amount?: bigint }): Buffer {
  const b = Buffer.alloc(165);
  key(o.mint).copy(b, 0);
  key(o.owner).copy(b, 32);
  b.writeBigUInt64LE(o.amount ?? 0n, 64);
  b[108] = 1;
  return b;
}

// ---- Outcomes and logs -----------------------------------------------------------------------------------------------

export const outcome = (r: Result) => (r instanceof FailedTransactionMetadata ? `error: ${String(r.err())}` : "ok");
export const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
/** A custom program error of the first instruction (PhoenixError code). */
export const custom = (code: number) => `error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: ${code} } }`;
/** A built-in error of the first instruction (its name as LiteSVM prints it). */
export const builtin = (name: string) => `error: TransactionErrorInstructionError { index: 0, error: ${name} }`;
/** A Rust panic (solana-program 1.14's handler ends in abort: "SBF program panicked"). */
export const PANICKED = builtin("ProgramFailedToComplete");

/** The log lines compared: compute-unit lines dropped, the N of Phoenix's own CU lines masked. */
export function lines(r: Result): string[] {
  return meta(r)
    .logs()
    .filter((l) => !/ consumed \d+ of \d+ compute units$/.test(l))
    .map((l) => l.replace(/^Program consumption: \d+ units remaining$/, "Program consumption: <N> units remaining"));
}

/**
 * Each inner instruction: the index of the top-level instruction it ran under, stack height, program index, account
 * indexes, data (hex). The outer index is part of it so that the same CPIs made under another top-level instruction
 * do not compare equal.
 */
export function inner(r: Result): string[] {
  return meta(r)
    .innerInstructions()
    .flatMap((list, outer) =>
      list.map((i) => {
        const c = i.instruction();
        return `${outer}: ${i.stackHeight()} ${c.programIdIndex()} [${[...c.accounts()].join(",")}] ${Buffer.from(c.data()).toString("hex")}`;
      }),
    );
}

const returnData = (r: Result) => {
  const d = meta(r).returnData();
  return `${Buffer.from(d.programId()).toString("hex")} ${Buffer.from(d.data()).toString("hex")}`;
};

// ---- Instructions (instruction_builders) -------------------------------------------------------------------------------

export function instruction(data: Buffer, accounts: Meta[]): Instruction {
  return {
    programAddress: PROGRAM,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(data),
  };
}
export const w = (a: Address): Meta => ({ address: a, writable: true });
export const r = (a: Address): Meta => ({ address: a });
export const s = (k: KeyPairSigner): Meta => ({ address: k.address, signer: k });
export const ws = (k: KeyPairSigner): Meta => ({ address: k.address, signer: k, writable: true });

/** The market, as the tests keep it. */
export interface Market {
  market: Address;
  authority: KeyPairSigner;
  baseMint: Address;
  quoteMint: Address;
  baseVault: Address;
  quoteVault: Address;
  bids: number;
  seats: number;
}

/** A trader: its keypair, seat address and its base and quote token accounts. */
export interface Trader {
  key: KeyPairSigner;
  seat: Address;
  base: Address;
  quote: Address;
}

export const seatAddress = async (market: Address, trader: Address) => (await pda(PROGRAM, ["seat", market, trader]))[0];
export const vaultAddress = async (market: Address, mint: Address) => (await pda(PROGRAM, ["vault", market, mint]))[0];

/** The entry's four accounts: program, log authority, market (writable), signer. */
const head = (market: Address, signer: KeyPairSigner, signerWritable = false): Meta[] => [
  r(PROGRAM),
  r(LOG_AUTHORITY),
  w(market),
  signerWritable ? ws(signer) : s(signer),
];
/** The vault context: base and quote token accounts, the two vaults, SPL Token. */
const vaults = (m: Market, base: Address, quote: Address): Meta[] => [w(base), w(quote), w(m.baseVault), w(m.quoteVault), r(TOKEN)];

/** InitializeParams. */
export interface InitParams {
  bids?: number;
  asks?: number;
  seats?: number;
  quoteLotsPerQuoteUnit?: bigint;
  tickSizeInQuoteLotsPerBaseUnit?: bigint;
  baseLotsPerBaseUnit?: bigint;
  takerFeeBps?: number;
  feeCollector?: Address;
  rawBaseUnitsPerBaseUnit?: number | null;
}
export function initParams(p: InitParams, fallbackCollector: Address): Buffer {
  const raw = p.rawBaseUnitsPerBaseUnit ?? null;
  return Buffer.concat([
    u64(p.bids ?? 512),
    u64(p.asks ?? p.bids ?? 512),
    u64(p.seats ?? 128),
    u64(p.quoteLotsPerQuoteUnit ?? 1_000_000n),
    u64(p.tickSizeInQuoteLotsPerBaseUnit ?? 1000n),
    u64(p.baseLotsPerBaseUnit ?? 1000n),
    u16(p.takerFeeBps ?? 0),
    key(p.feeCollector ?? fallbackCollector),
    opt(raw === null ? null : u32(raw)),
  ]);
}

/** OrderPacket (Borsh), for the order instructions. */
export type OrderPacket =
  | {
      kind: "PostOnly";
      side: 0 | 1;
      priceInTicks: bigint;
      numBaseLots: bigint;
      clientOrderId?: bigint;
      rejectPostOnly?: boolean;
      useOnlyDepositedFunds?: boolean;
      lastValidSlot?: bigint | null;
      lastValidUnixTimestampInSeconds?: bigint | null;
      failSilentlyOnInsufficientFunds?: boolean;
    }
  | {
      kind: "Limit";
      side: 0 | 1;
      priceInTicks: bigint;
      numBaseLots: bigint;
      selfTradeBehavior?: 0 | 1 | 2;
      matchLimit?: bigint | null;
      clientOrderId?: bigint;
      useOnlyDepositedFunds?: boolean;
      lastValidSlot?: bigint | null;
      lastValidUnixTimestampInSeconds?: bigint | null;
      failSilentlyOnInsufficientFunds?: boolean;
    }
  | {
      kind: "ImmediateOrCancel";
      side: 0 | 1;
      priceInTicks?: bigint | null;
      numBaseLots?: bigint;
      numQuoteLots?: bigint;
      minBaseLotsToFill?: bigint;
      minQuoteLotsToFill?: bigint;
      selfTradeBehavior?: 0 | 1 | 2;
      matchLimit?: bigint | null;
      clientOrderId?: bigint;
      useOnlyDepositedFunds?: boolean;
      lastValidSlot?: bigint | null;
      lastValidUnixTimestampInSeconds?: bigint | null;
    };
const optU64 = (v: bigint | null | undefined) => opt(v === null || v === undefined ? null : u64(v));
export function orderPacket(p: OrderPacket): Buffer {
  switch (p.kind) {
    case "PostOnly":
      return Buffer.concat([
        u8(0),
        u8(p.side),
        u64(p.priceInTicks),
        u64(p.numBaseLots),
        u128(p.clientOrderId ?? 0n),
        bool(p.rejectPostOnly ?? true),
        bool(p.useOnlyDepositedFunds ?? false),
        optU64(p.lastValidSlot),
        optU64(p.lastValidUnixTimestampInSeconds),
        bool(p.failSilentlyOnInsufficientFunds ?? false),
      ]);
    case "Limit":
      return Buffer.concat([
        u8(1),
        u8(p.side),
        u64(p.priceInTicks),
        u64(p.numBaseLots),
        u8(p.selfTradeBehavior ?? 0),
        optU64(p.matchLimit),
        u128(p.clientOrderId ?? 0n),
        bool(p.useOnlyDepositedFunds ?? false),
        optU64(p.lastValidSlot),
        optU64(p.lastValidUnixTimestampInSeconds),
        bool(p.failSilentlyOnInsufficientFunds ?? false),
      ]);
    case "ImmediateOrCancel":
      return Buffer.concat([
        u8(2),
        u8(p.side),
        optU64(p.priceInTicks),
        u64(p.numBaseLots ?? 0n),
        u64(p.numQuoteLots ?? 0n),
        u64(p.minBaseLotsToFill ?? 0n),
        u64(p.minQuoteLotsToFill ?? 0n),
        u8(p.selfTradeBehavior ?? 0),
        optU64(p.matchLimit),
        u128(p.clientOrderId ?? 0n),
        bool(p.useOnlyDepositedFunds ?? false),
        optU64(p.lastValidSlot),
        optU64(p.lastValidUnixTimestampInSeconds),
      ]);
  }
}

/** CondensedOrder of a MultipleOrderPacket. */
export interface CondensedOrder {
  priceInTicks: bigint;
  sizeInBaseLots: bigint;
  lastValidSlot?: bigint | null;
  lastValidUnixTimestampInSeconds?: bigint | null;
}
const condensed = (o: CondensedOrder) =>
  Buffer.concat([u64(o.priceInTicks), u64(o.sizeInBaseLots), optU64(o.lastValidSlot), optU64(o.lastValidUnixTimestampInSeconds)]);
/** MultipleOrderPacket { bids, asks, client_order_id: Option<u128>, failed_multiple_limit_order_behavior }. */
export function multipleOrderPacket(bids: CondensedOrder[], asks: CondensedOrder[], clientOrderId: bigint | null = null, behavior = 0): Buffer {
  return Buffer.concat([
    u32(bids.length),
    ...bids.map(condensed),
    u32(asks.length),
    ...asks.map(condensed),
    opt(clientOrderId === null ? null : u128(clientOrderId)),
    u8(behavior),
  ]);
}
/** CancelOrderParams { side, price_in_ticks, order_sequence_number }. */
export const cancelOrderParams = (side: 0 | 1, priceInTicks: bigint, orderSequenceNumber: bigint) =>
  Buffer.concat([u8(side), u64(priceInTicks), u64(orderSequenceNumber)]);
/** CancelUpToParams { side, tick_limit, num_orders_to_search, num_orders_to_cancel }. */
export const cancelUpToParams = (side: 0 | 1, tickLimit: bigint | null = null, search: number | null = null, cancel: number | null = null) =>
  Buffer.concat([u8(side), optU64(tickLimit), opt(search === null ? null : u32(search)), opt(cancel === null ? null : u32(cancel))]);

/** Each tag's data and accounts. */
export const ix = {
  /** Tag 0. */
  swap: (m: Market, t: Trader, packet: Buffer) => instruction(Buffer.concat([u8(0), packet]), [...head(m.market, t.key), ...vaults(m, t.base, t.quote)]),
  /** Tag 1. */
  swapWithFreeFunds: (m: Market, t: Trader, packet: Buffer) => instruction(Buffer.concat([u8(1), packet]), [...head(m.market, t.key), r(t.seat)]),
  /** Tag 2. */
  placeLimitOrder: (m: Market, t: Trader, packet: Buffer) =>
    instruction(Buffer.concat([u8(2), packet]), [...head(m.market, t.key), r(t.seat), ...vaults(m, t.base, t.quote)]),
  /** Tag 3. */
  placeLimitOrderWithFreeFunds: (m: Market, t: Trader, packet: Buffer) => instruction(Buffer.concat([u8(3), packet]), [...head(m.market, t.key), r(t.seat)]),
  /** Tag 4: ReduceOrderParams { base_params: CancelOrderParams, size }. */
  reduceOrder: (m: Market, t: Trader, params: Buffer, size: bigint) =>
    instruction(Buffer.concat([u8(4), params, u64(size)]), [...head(m.market, t.key), ...vaults(m, t.base, t.quote)]),
  /** Tag 5 (the trader writable, as the IDL lists it). */
  reduceOrderWithFreeFunds: (m: Market, t: Trader, params: Buffer, size: bigint) =>
    instruction(Buffer.concat([u8(5), params, u64(size)]), head(m.market, t.key, true)),
  /** Tag 6. */
  cancelAllOrders: (m: Market, t: Trader) => instruction(u8(6), [...head(m.market, t.key), ...vaults(m, t.base, t.quote)]),
  /** Tag 7. */
  cancelAllOrdersWithFreeFunds: (m: Market, t: Trader) => instruction(u8(7), head(m.market, t.key)),
  /** Tag 8. */
  cancelUpTo: (m: Market, t: Trader, params: Buffer) => instruction(Buffer.concat([u8(8), params]), [...head(m.market, t.key), ...vaults(m, t.base, t.quote)]),
  /** Tag 9. */
  cancelUpToWithFreeFunds: (m: Market, t: Trader, params: Buffer) => instruction(Buffer.concat([u8(9), params]), head(m.market, t.key)),
  /** Tag 10: CancelMultipleOrdersByIdParams { orders: Vec<CancelOrderParams> }. */
  cancelMultipleOrdersById: (m: Market, t: Trader, orders: Buffer[]) =>
    instruction(Buffer.concat([u8(10), u32(orders.length), ...orders]), [...head(m.market, t.key), ...vaults(m, t.base, t.quote)]),
  /** Tag 11. */
  cancelMultipleOrdersByIdWithFreeFunds: (m: Market, t: Trader, orders: Buffer[]) =>
    instruction(Buffer.concat([u8(11), u32(orders.length), ...orders]), head(m.market, t.key)),
  /** Tag 12: WithdrawParams { quote_lots_to_withdraw: Option<u64>, base_lots_to_withdraw: Option<u64> }. */
  withdrawFunds: (m: Market, t: Trader, quoteLots: bigint | null = null, baseLots: bigint | null = null) =>
    instruction(Buffer.concat([u8(12), optU64(quoteLots), optU64(baseLots)]), [...head(m.market, t.key), ...vaults(m, t.base, t.quote)]),
  /** Tag 13: DepositParams { quote_lots_to_deposit, base_lots_to_deposit }. */
  depositFunds: (m: Market, t: Trader, quoteLots: bigint, baseLots: bigint) =>
    instruction(Buffer.concat([u8(13), u64(quoteLots), u64(baseLots)]), [...head(m.market, t.key), r(t.seat), ...vaults(m, t.base, t.quote)]),
  /** Tag 14: the trader pays (writable signer). */
  requestSeat: (m: Market, t: Trader) => instruction(u8(14), [...head(m.market, t.key, true), w(t.seat), r(SYSTEM)]),
  /** Tag 15: only through Phoenix's own CPI; sent directly it must fail. */
  log: (authority: Meta, data: Buffer = Buffer.alloc(0)) => instruction(Buffer.concat([u8(15), data]), [authority]),
  /** Tag 16. */
  placeMultiplePostOnlyOrders: (m: Market, t: Trader, packet: Buffer) =>
    instruction(Buffer.concat([u8(16), packet]), [...head(m.market, t.key), r(t.seat), ...vaults(m, t.base, t.quote)]),
  /** Tag 17. */
  placeMultiplePostOnlyOrdersWithFreeFunds: (m: Market, t: Trader, packet: Buffer) =>
    instruction(Buffer.concat([u8(17), packet]), [...head(m.market, t.key), r(t.seat)]),
  /** Tag 100: the creator pays for the vaults (writable signer). */
  initializeMarket: (m: Market, params: Buffer, creator: KeyPairSigner = m.authority) =>
    instruction(Buffer.concat([u8(100), params]), [
      ...head(m.market, creator, true),
      r(m.baseMint),
      r(m.quoteMint),
      w(m.baseVault),
      w(m.quoteVault),
      r(SYSTEM),
      r(TOKEN),
    ]),
  /** Tag 101. */
  claimAuthority: (m: Market, successor: KeyPairSigner) => instruction(u8(101), head(m.market, successor)),
  /** Tag 102. */
  nameSuccessor: (m: Market, successor: Address, authority: KeyPairSigner = m.authority) =>
    instruction(Buffer.concat([u8(102), key(successor)]), head(m.market, authority)),
  /** Tag 103: the authority writable (it receives a tombstoned market's lamports by default); an optional receiver. */
  changeMarketStatus: (m: Market, status: number, receiver?: Address, authority: KeyPairSigner = m.authority) =>
    instruction(Buffer.concat([u8(103), u8(status)]), [...head(m.market, authority, true), ...(receiver ? [w(receiver)] : [])]),
  /** Tag 104. */
  changeSeatStatus: (m: Market, seat: Address, status: number, authority: KeyPairSigner = m.authority) =>
    instruction(Buffer.concat([u8(104), u8(status)]), [...head(m.market, authority), w(seat)]),
  /** Tag 105. */
  requestSeatAuthorized: (m: Market, payer: KeyPairSigner, trader: Address, seat: Address, authority: KeyPairSigner = m.authority) =>
    instruction(u8(105), [...head(m.market, authority), ws(payer), r(trader), w(seat), r(SYSTEM)]),
  /** Tag 106. */
  evictSeat: (m: Market, t: Trader, authority: KeyPairSigner = m.authority) =>
    instruction(u8(106), [...head(m.market, authority), r(t.key.address), r(t.seat), ...vaults(m, t.base, t.quote)]),
  /** Tag 107: CancelUpToParams. */
  forceCancelOrders: (m: Market, t: Trader, params: Buffer, authority: KeyPairSigner = m.authority) =>
    instruction(Buffer.concat([u8(107), params]), [...head(m.market, authority), r(t.key.address), r(t.seat), ...vaults(m, t.base, t.quote)]),
  /** Tag 108: anyone sweeps, to the fee recipient's quote account. */
  collectFees: (m: Market, sweeper: KeyPairSigner, recipientQuote: Address) =>
    instruction(u8(108), [...head(m.market, sweeper), w(recipientQuote), w(m.quoteVault), r(TOKEN)]),
  /** Tag 109: with the current recipient signing, when given. */
  changeFeeRecipient: (m: Market, newRecipient: Address, current?: KeyPairSigner, authority: KeyPairSigner = m.authority) =>
    instruction(u8(109), [...head(m.market, authority), r(newRecipient), ...(current ? [s(current)] : [])]),
};

/** The instruction with its account list changed (dropped, replaced, flags changed). */
export function accounts(i: Instruction, edit: (list: { address: Address; role: AccountRole; signer?: KeyPairSigner }[]) => void): Instruction {
  const list = [...(i.accounts ?? [])].map((a) => ({ ...a })) as { address: Address; role: AccountRole; signer?: KeyPairSigner }[];
  edit(list);
  return { ...i, accounts: list as Instruction["accounts"] };
}
/** The first `n` accounts only. */
export const truncate = (i: Instruction, n: number) => accounts(i, (l) => l.splice(n));
/** Account `at` replaced by `address`, read-only or writable as it was, never a signer. */
export const replace = (i: Instruction, at: number, address: Address) =>
  accounts(i, (l) => {
    l[at] = {
      address,
      role:
        l[at]!.role === AccountRole.READONLY_SIGNER ? AccountRole.READONLY : l[at]!.role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : l[at]!.role,
    };
  });
/** Account `at` passed read-only (and still signing, if it signed). */
export const readonly = (i: Instruction, at: number) =>
  accounts(i, (l) => {
    l[at]!.role =
      l[at]!.role === AccountRole.WRITABLE_SIGNER ? AccountRole.READONLY_SIGNER : l[at]!.role === AccountRole.WRITABLE ? AccountRole.READONLY : l[at]!.role;
  });
/** Account `at` passed without its signature. */
export const unsigned = (i: Instruction, at: number) =>
  accounts(i, (l) => {
    l[at] = { address: l[at]!.address, role: l[at]!.role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : AccountRole.READONLY };
  });
/** The instruction with other data. */
export const withData = (i: Instruction, data: Buffer): Instruction => ({ ...i, data: new Uint8Array(data) });

// ---- The two VMs -------------------------------------------------------------------------------------------------------

/** One compared transaction's compute units, and whether it succeeded (in both: the outcomes are compared). */
export interface CuRow {
  label: string;
  original: bigint;
  port: bigint;
  ok: boolean;
}

/**
 * The original and the port side by side, the accounts made in both, and the comparison. Labels name compared
 * transactions; `rows` keeps every compared transaction's compute units (original, port) in order, labels repeated
 * as often as they were sent, and `cu` the last of each label.
 */
export class Diff {
  readonly cu: Record<string, [bigint, bigint]> = {};
  readonly rows: CuRow[] = [];
  compared = 0;
  /** The original's log lines of the last compared transaction (for messages). */
  lastLogs = "";
  /** The original's result of the last compared transaction (the port's is the same, compared). */
  last: Result | undefined;
  private constructor(
    readonly original: LiteSVM,
    readonly port: LiteSVM,
    private readonly newKey: () => Promise<KeyPairSigner>,
  ) {}

  /**
   * Both VMs. Every keypair the Diff makes (payers, mints, token accounts, markets) comes from `keys`: fresh ones by
   * default, or a seeded source, so that a run's addresses (and with them the traders tree's order and every PDA)
   * are reproduced by its seed.
   */
  static async create(keys: () => Promise<KeyPairSigner> = generateKeyPairSigner): Promise<Diff> {
    const port = (await deployFile(PORT, { programId: PROGRAM })).svm;
    const original = new LiteSVM();
    original.addProgram(PROGRAM, new Uint8Array(readFileSync(ORIGINAL)));
    // No log limit: the runtime truncates a transaction's log at 10,000 bytes, and where it cuts depends on the
    // "consumed N of M compute units" lines, whose N differ by design (a transaction of 12 orders reaches it).
    for (const vm of [original, port]) {
      vm.setClock(new Clock(SLOT, UNIX_TIMESTAMP - 1000n, 580n, 581n, UNIX_TIMESTAMP));
      vm.withLogBytesLimit();
    }
    return new Diff(original, port, keys);
  }

  get vms(): readonly [LiteSVM, LiteSVM] {
    return [this.original, this.port];
  }

  /** A keypair with `sol` SOL in both VMs. */
  async funded(sol = 100n): Promise<KeyPairSigner> {
    const k = await this.newKey();
    for (const vm of this.vms) vm.airdrop(k.address, lamports(sol * SOL));
    return k;
  }

  /** Write the same account into both VMs (rent-exempt for its size unless `lamports` is given). */
  write(at: Address, owner: Address, data: Buffer, lamportsHeld?: bigint): void {
    for (const vm of this.vms)
      vm.setAccount({
        address: at,
        data: new Uint8Array(data),
        executable: false,
        lamports: lamports(lamportsHeld ?? vm.minimumBalanceForRentExemption(BigInt(data.length))),
        programAddress: owner,
        space: BigInt(data.length),
      });
  }

  /** An account's data in the original. */
  data(a: Address): Buffer {
    const acct = this.original.getAccount(a);
    if (!acct.exists) throw new Error(`${a} does not exist`);
    return Buffer.from(acct.data);
  }

  /** Change an account's bytes in both VMs (its lamports and owner kept unless given). */
  patch(a: Address, edit: (data: Buffer) => void, opts: { lamports?: bigint; owner?: Address } = {}): void {
    const acct = this.original.getAccount(a);
    if (!acct.exists) throw new Error(`${a} does not exist`);
    const data = Buffer.from(acct.data);
    edit(data);
    this.write(a, opts.owner ?? acct.programAddress, data, opts.lamports ?? BigInt(acct.lamports));
  }

  /** An account's lamports, owner and data, as compared. */
  bytes(vm: LiteSVM, a: Address): string {
    const acct = vm.getAccount(a);
    return acct.exists ? `${acct.lamports} ${acct.programAddress} ${Buffer.from(acct.data).toString("hex")}` : "missing";
  }

  /**
   * Send to both: the same outcome, log lines, inner instructions, return data and account bytes (see the file's
   * notes). Returns the outcome.
   */
  async both(label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[] = []): Promise<string> {
    const [a, b] = [await send(this.original, payer, ixs), await send(this.port, payer, ixs)];
    this.compared++;
    const logs = (res: Result) => meta(res).logs().join("\n");
    const why = `${label}\noriginal:\n${logs(a)}\nTypeSOL:\n${logs(b)}`;
    expect(outcome(b), why).toBe(outcome(a));
    const want = lines(a);
    const got = lines(b);
    expect(got, `${label}: logs\n${why}`).toEqual(want);
    expect(inner(b), `${label}: inner instructions\n${why}`).toEqual(inner(a));
    expect(returnData(b), `${label}: return data`).toBe(returnData(a));
    const named = new Set<Address>([payer.address, ...watch]);
    for (const i of ixs) for (const m of i.accounts ?? []) named.add(m.address);
    for (const at of named) {
      const acct = this.original.getAccount(at);
      if (acct.exists && acct.executable) continue;
      expect(this.bytes(this.port, at), `${label}: ${at}`).toBe(this.bytes(this.original, at));
    }
    this.cu[label] = [meta(a).computeUnitsConsumed(), meta(b).computeUnitsConsumed()];
    this.rows.push({ label, original: meta(a).computeUnitsConsumed(), port: meta(b).computeUnitsConsumed(), ok: outcome(a) === "ok" });
    this.lastLogs = logs(a);
    this.last = a;
    return outcome(a);
  }

  /** both(), which must succeed. */
  async ok(label: string, payer: KeyPairSigner, ixs: Instruction[], watch: Address[] = []): Promise<void> {
    const got = await this.both(label, payer, ixs, watch);
    expect(got, `${label}\n${this.lastLogs}`).toBe("ok");
  }

  /** both(), which must fail with `expected`. */
  async fails(label: string, payer: KeyPairSigner, ixs: Instruction[], expected: string, watch: Address[] = []): Promise<void> {
    const got = await this.both(label, payer, ixs, watch);
    expect(got, `${label}\n${this.lastLogs}`).toBe(expected);
  }

  /** A mint in both VMs. */
  async mint(decimals: number, authority?: Address): Promise<Address> {
    const k = (await this.newKey()).address;
    this.write(k, TOKEN, mintBytes({ decimals, authority }));
    return k;
  }

  /** A token account in both VMs. */
  async tokenAccount(mint: Address, owner: Address, amount = 0n): Promise<Address> {
    const k = (await this.newKey()).address;
    this.write(k, TOKEN, tokenAccountBytes({ mint, owner, amount }));
    return k;
  }

  /** A token account's amount in the original (both are compared anyway). */
  amount(a: Address): bigint {
    return this.data(a).readBigUInt64LE(64);
  }

  /**
   * A market account (zeroed, owned by Phoenix, `size` bytes: the full size for its parameters by default), two mints
   * and the vault addresses; not initialized yet.
   */
  async newMarket(
    o: { bids?: number; seats?: number; baseDecimals?: number; quoteDecimals?: number; size?: number; authority?: KeyPairSigner } = {},
  ): Promise<Market> {
    const bids = o.bids ?? 512;
    const seats = o.seats ?? 128;
    const authority = o.authority ?? (await this.funded(1000n));
    const baseMint = await this.mint(o.baseDecimals ?? 9);
    const quoteMint = await this.mint(o.quoteDecimals ?? 6);
    const market = (await this.newKey()).address;
    this.write(market, PROGRAM, Buffer.alloc(o.size ?? marketSize(bids, seats)));
    return {
      market,
      authority,
      baseMint,
      quoteMint,
      baseVault: await vaultAddress(market, baseMint),
      quoteVault: await vaultAddress(market, quoteMint),
      bids,
      seats,
    };
  }

  /** A new market, initialized through both() (PostOnly), optionally Active. */
  async market(o: Parameters<Diff["newMarket"]>[0] & { params?: InitParams; active?: boolean; label?: string } = {}): Promise<Market> {
    const m = await this.newMarket(o);
    const params = initParams({ bids: m.bids, seats: m.seats, ...o.params }, m.authority.address);
    await this.ok(o.label ?? `InitializeMarket ${m.bids}/${m.seats}`, m.authority, [ix.initializeMarket(m, params)]);
    if (o.active) await this.ok(`${o.label ?? "market"}: ChangeMarketStatus Active`, m.authority, [ix.changeMarketStatus(m, 1)]);
    return m;
  }

  /** A trader with SOL and base / quote token accounts holding these amounts (no seat requested yet). */
  async trader(m: Market, base = 0n, quote = 0n): Promise<Trader> {
    const k = await this.funded(10n);
    return {
      key: k,
      seat: await seatAddress(m.market, k.address),
      base: await this.tokenAccount(m.baseMint, k.address, base),
      quote: await this.tokenAccount(m.quoteMint, k.address, quote),
    };
  }

  /** A trader with an approved seat (RequestSeat, ChangeSeatStatus Approved through both()). */
  async seated(m: Market, base = 0n, quote = 0n, label = "trader"): Promise<Trader> {
    const t = await this.trader(m, base, quote);
    await this.ok(`${label}: RequestSeat`, t.key, [ix.requestSeat(m, t)]);
    await this.ok(`${label}: ChangeSeatStatus Approved`, m.authority, [ix.changeSeatStatus(m, t.seat, 1)]);
    return t;
  }
}

// ---- Reading the market ------------------------------------------------------------------------------------------------

/** Both VMs' Clock moved to `slot` and `unixTimestamp`. */
export function setClock(d: Diff, slot: bigint, unixTimestamp: bigint): void {
  for (const vm of d.vms) vm.setClock(new Clock(slot, unixTimestamp - 1000n, 580n, 581n, unixTimestamp));
}

/** SetComputeUnitLimit (Compute Budget). */
export const computeUnits = (units: number): Instruction => ({
  programAddress: address("ComputeBudget111111111111111111111111111111"),
  accounts: [],
  data: new Uint8Array([2, ...u32(units)]),
});

/** A sokoban tree's node indexes in order (the in-order walk over the node registers from the root). */
function walk(data: Buffer, at: number, stride: number): number[] {
  const node = (i: number) => at + TREE.nodes + (i - 1) * stride;
  const out: number[] = [];
  const stack: number[] = [];
  let cur = data.readUInt32LE(at + TREE.root);
  while (stack.length > 0 || cur !== 0) {
    if (cur !== 0) {
      stack.push(cur);
      cur = data.readUInt32LE(node(cur));
      continue;
    }
    const i = stack.pop()!;
    out.push(i);
    cur = data.readUInt32LE(node(i) + 4);
  }
  return out;
}

/** A resting order as the book holds it (its node index, key and value). */
export interface RestingOrder {
  index: number;
  price: bigint;
  /** The stored sequence number (a bid's inverted). */
  seq: bigint;
  trader: bigint;
  lots: bigint;
  lastValidSlot: bigint;
  lastValidUnixTimestamp: bigint;
}

/** A book's orders, best first, from the market's bytes. */
export function restingOrders(data: Buffer, m: Market, side: 0 | 1): RestingOrder[] {
  const at = side === 0 ? OFF.bids : asksAt(m.bids);
  return walk(data, at, 64).map((index) => {
    const n = at + TREE.nodes + (index - 1) * 64;
    return {
      index,
      price: data.readBigUInt64LE(n + 16),
      seq: data.readBigUInt64LE(n + 24),
      trader: data.readBigUInt64LE(n + 32),
      lots: data.readBigUInt64LE(n + 40),
      lastValidSlot: data.readBigUInt64LE(n + 48),
      lastValidUnixTimestamp: data.readBigUInt64LE(n + 56),
    };
  });
}

/** A registered trader: its node index in the traders tree, key and TraderState. */
export interface TraderEntry {
  index: number;
  key: Buffer;
  quoteLocked: bigint;
  quoteFree: bigint;
  baseLocked: bigint;
  baseFree: bigint;
}

/** The traders tree's entries (only the nodes the tree links: a freed node keeps its old key and state). */
export function registeredTraders(data: Buffer, m: Market): TraderEntry[] {
  const at = tradersAt(m.bids);
  return walk(data, at, 144).map((index) => {
    const n = at + TREE.nodes + (index - 1) * 144;
    return {
      index,
      key: data.subarray(n + 16, n + 48),
      quoteLocked: data.readBigUInt64LE(n + 48),
      quoteFree: data.readBigUInt64LE(n + 56),
      baseLocked: data.readBigUInt64LE(n + 64),
      baseFree: data.readBigUInt64LE(n + 72),
    };
  });
}

/** A trader's entry in the traders tree, if registered. */
export const traderEntry = (data: Buffer, m: Market, trader: Address): TraderEntry | undefined =>
  registeredTraders(data, m).find((t) => t.key.equals(key(trader)));

/** The CU table: every compared transaction, the original's and the port's compute units. */
export function cuTable(diffs: Diff[], title: string): string {
  const rows = diffs.flatMap((d) => d.rows);
  const width = Math.max(...rows.map((r) => r.label.length), 10);
  const out = [`${title}`, `${"transaction".padEnd(width)}  original      port   saving`];
  for (const { label, original: a, port: b, ok } of rows) {
    const pct = a === 0n ? "" : `${((Number(a - b) * 100) / Number(a)).toFixed(1)}%`;
    out.push(`${label.padEnd(width)}  ${String(a).padStart(8)}  ${String(b).padStart(8)}  ${pct.padStart(7)}${ok ? "" : "  (failed)"}`);
  }
  const ok = rows.filter((r) => r.ok);
  const cheaper = ok.filter((r) => r.port < r.original).length;
  out.push(`${rows.length} transactions compared, every log line identical; the port cheaper on ${cheaper} of the ${ok.length} that succeeded`);
  return out.join("\n");
}

/**
 * The checks every Phoenix file ends with: exactly `expected` transactions compared (so a case that silently stops
 * sending fails), and on every one that succeeded the port used fewer compute units than the original. Failed
 * transactions are left out: where each side stops is compared through the logs, and a panic's CU are not a cost.
 */
export function checkCompute(diffs: Diff[], expected: number): void {
  const rows = diffs.flatMap((d) => d.rows);
  expect(
    diffs.reduce((n, d) => n + d.compared, 0),
    "transactions compared",
  ).toBe(rows.length);
  const dearer = rows.filter((r) => r.ok && r.port >= r.original).map((r) => `${r.label}: original ${r.original}, port ${r.port}`);
  expect(dearer, "successful transactions where the port did not use fewer compute units").toEqual([]);
  expect(rows.length, "transactions compared").toBe(expected);
}
