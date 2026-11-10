// showcase/mainnet/phoenix against Phoenix v1 as deployed on mainnet (test/programs/phoenix_v1.so). The harness
// (phoenix-helpers.ts) runs both in their own LiteSVM under the same program id and Clock; every transaction must have
// the same outcome, log lines, inner instructions (the event batches included), return data and bytes in every
// account it names. The outcomes are also checked, so that each error path is really reached.
//
// Part 1: the entry's checks for all 28 tags, InitializeMarket, ClaimAuthority, NameSuccessor, ChangeMarketStatus,
// RequestSeat, RequestSeatAuthorized, ChangeSeatStatus, DepositFunds, WithdrawFunds, CollectFees and
// ChangeFeeRecipient, on two market sizes (512 orders / 128 seats and 4096 / 8321). States the Part 1 instructions
// cannot reach by themselves (fees that only trades accrue, a full traders tree, resting orders) are written into
// the market's bytes in both VMs.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Diff,
  E,
  LOG_AUTHORITY,
  type Market,
  OFF,
  PANICKED,
  PROGRAM,
  SYSTEM,
  TOKEN,
  TREE,
  type Trader,
  U64_MAX,
  accounts,
  asksAt,
  builtin,
  cancelOrderParams,
  cancelUpToParams,
  custom,
  cuTable,
  initParams,
  ix,
  key,
  marketSize,
  mintBytes,
  multipleOrderPacket,
  orderPacket,
  readonly,
  replace,
  s,
  seatAddress,
  tokenAccountBytes,
  tradersAt,
  truncate,
  u8,
  u64,
  unsigned,
  withData,
} from "./phoenix-helpers.js";

/** A Borsh decoding failure (ProgramError::BorshIoError). */
const BORSH = builtin("BorshIoError");

/** Every Diff of the file, for the CU table. */
const diffs: Diff[] = [];
async function diff(): Promise<Diff> {
  const d = await Diff.create();
  diffs.push(d);
  return d;
}

afterAll(() => {
  console.log(cuTable(diffs, "Phoenix v1: compute units, original vs TypeSOL"));
});

/** Every instruction of the program, built for market `m` and trader `t` (the signer the entry checks is index 3). */
function everyTag(m: Market, t: Trader): [string, Instruction][] {
  const post = orderPacket({ kind: "PostOnly", side: 0, priceInTicks: 100n, numBaseLots: 1n });
  const cancel = cancelOrderParams(0, 100n, 1n);
  return [
    ["Swap", ix.swap(m, t, orderPacket({ kind: "ImmediateOrCancel", side: 0, priceInTicks: 100n, numBaseLots: 1n }))],
    ["SwapWithFreeFunds", ix.swapWithFreeFunds(m, t, orderPacket({ kind: "ImmediateOrCancel", side: 1, numBaseLots: 1n }))],
    ["PlaceLimitOrder", ix.placeLimitOrder(m, t, post)],
    ["PlaceLimitOrderWithFreeFunds", ix.placeLimitOrderWithFreeFunds(m, t, orderPacket({ kind: "Limit", side: 1, priceInTicks: 5n, numBaseLots: 2n }))],
    ["ReduceOrder", ix.reduceOrder(m, t, cancel, 1n)],
    ["ReduceOrderWithFreeFunds", ix.reduceOrderWithFreeFunds(m, t, cancel, 1n)],
    ["CancelAllOrders", ix.cancelAllOrders(m, t)],
    ["CancelAllOrdersWithFreeFunds", ix.cancelAllOrdersWithFreeFunds(m, t)],
    ["CancelUpTo", ix.cancelUpTo(m, t, cancelUpToParams(0))],
    ["CancelUpToWithFreeFunds", ix.cancelUpToWithFreeFunds(m, t, cancelUpToParams(1, 5n, 2, 3))],
    ["CancelMultipleOrdersById", ix.cancelMultipleOrdersById(m, t, [cancel])],
    ["CancelMultipleOrdersByIdWithFreeFunds", ix.cancelMultipleOrdersByIdWithFreeFunds(m, t, [cancel, cancel])],
    ["WithdrawFunds", ix.withdrawFunds(m, t)],
    ["DepositFunds", ix.depositFunds(m, t, 1n, 1n)],
    ["RequestSeat", ix.requestSeat(m, t)],
    ["PlaceMultiplePostOnlyOrders", ix.placeMultiplePostOnlyOrders(m, t, multipleOrderPacket([{ priceInTicks: 90n, sizeInBaseLots: 1n }], []))],
    [
      "PlaceMultiplePostOnlyOrdersWithFreeFunds",
      ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, t, multipleOrderPacket([], [{ priceInTicks: 900n, sizeInBaseLots: 1n }])),
    ],
    ["InitializeMarket", ix.initializeMarket(m, initParams({}, m.authority.address), t.key)],
    ["ClaimAuthority", ix.claimAuthority(m, t.key)],
    ["NameSuccessor", ix.nameSuccessor(m, t.key.address, t.key)],
    ["ChangeMarketStatus", ix.changeMarketStatus(m, 1, undefined, t.key)],
    ["ChangeSeatStatus", ix.changeSeatStatus(m, t.seat, 1, t.key)],
    ["RequestSeatAuthorized", ix.requestSeatAuthorized(m, m.authority, t.key.address, t.seat, t.key)],
    ["EvictSeat", ix.evictSeat(m, t, t.key)],
    ["ForceCancelOrders", ix.forceCancelOrders(m, t, cancelUpToParams(0), t.key)],
    ["CollectFees", ix.collectFees(m, t.key, t.quote)],
    ["ChangeFeeRecipient", ix.changeFeeRecipient(m, t.key.address, undefined, t.key)],
  ];
}

describe("the entry", () => {
  let d: Diff;
  let m: Market;
  let t: Trader;
  let fresh: Market;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    m = await d.market({ label: "entry: InitializeMarket" });
    t = await d.trader(m, 5n, 5n);
    fresh = await d.newMarket();
    payer = await d.funded();
  });

  it("refuses data that is not a PhoenixInstruction, logging nothing", async () => {
    const at = [{ address: PROGRAM, role: AccountRole.READONLY }] as Instruction["accounts"];
    for (const [label, data] of [
      ["no data", Buffer.alloc(0)],
      ["tag 18", u8(18)],
      ["tag 99", u8(99)],
      ["tag 110", u8(110)],
      ["tag 255", u8(255)],
    ] as const) {
      await d.fails(`entry: ${label}`, payer, [{ programAddress: PROGRAM, accounts: at, data: new Uint8Array(data) }], builtin("InvalidInstructionData"));
    }
  });

  it("Log: only the log authority, signing through Phoenix's CPI", async () => {
    await d.fails("Log: no accounts", payer, [accounts(ix.log({ address: LOG_AUTHORITY }), (l) => l.splice(0))], builtin("NotEnoughAccountKeys"));
    await d.fails("Log: the log authority, not signing", payer, [ix.log({ address: LOG_AUTHORITY })], builtin("MissingRequiredSignature"));
    await d.fails("Log: another signer", payer, [ix.log(s(t.key), Buffer.alloc(92))], builtin("InvalidArgument"));
  });

  it("panics with fewer than four accounts (split_at), for every tag", async () => {
    for (const [name, i] of everyTag(m, t)) {
      await d.fails(`${name}: 3 accounts`, payer, [truncate(i, 3)], PANICKED);
      if (name === "Swap") await d.fails(`${name}: no accounts`, payer, [truncate(i, 0)], PANICKED);
    }
  });

  it("checks the program, the log authority, the market and the signer, for every tag", async () => {
    const other = await d.newMarket();
    const notOwned = (await generateKeyPairSigner()).address;
    d.write(notOwned, SYSTEM, d.data(m.market));
    const short = (await generateKeyPairSigner()).address;
    d.write(short, PROGRAM, Buffer.alloc(575));
    const badDiscriminant = (await generateKeyPairSigner()).address;
    const bytes = d.data(m.market);
    bytes[0]! ^= 1;
    d.write(badDiscriminant, PROGRAM, bytes);
    for (const [name, i] of everyTag(m, t)) {
      await d.fails(`${name}: not the program`, payer, [replace(i, 0, SYSTEM)], builtin("IncorrectProgramId"));
      await d.fails(`${name}: not the log authority`, payer, [replace(i, 1, PROGRAM)], builtin("InvalidInstructionData"));
      if (name === "InitializeMarket") continue;
      await d.fails(`${name}: market not owned by Phoenix`, payer, [replace(i, 2, notOwned)], builtin("IllegalOwner"));
      await d.fails(`${name}: market of 575 bytes`, payer, [replace(i, 2, short)], PANICKED);
      await d.fails(`${name}: market discriminant`, payer, [replace(i, 2, badDiscriminant)], builtin("InvalidAccountData"));
      await d.fails(`${name}: not signed`, payer, [unsigned(i, 3)], builtin("MissingRequiredSignature"));
      // An uninitialized market (zeroed) fails on its discriminant too.
      if (name === "Swap") await d.fails(`${name}: uninitialized market`, payer, [replace(i, 2, other.market)], builtin("InvalidAccountData"));
    }
    const init = ix.initializeMarket(fresh, initParams({}, fresh.authority.address));
    await d.fails("InitializeMarket: market not owned by Phoenix", payer, [replace(init, 2, notOwned)], builtin("IllegalOwner"));
    await d.fails("InitializeMarket: market of 575 bytes", payer, [replace(init, 2, short)], PANICKED);
    await d.fails("InitializeMarket: market already initialized", payer, [replace(init, 2, m.market)], builtin("InvalidAccountData"));
    const statusSet = (await generateKeyPairSigner()).address;
    const zeroed = Buffer.alloc(marketSize(512, 128));
    zeroed.writeBigUInt64LE(2n, OFF.status);
    d.write(statusSet, PROGRAM, zeroed);
    await d.fails("InitializeMarket: market status set", payer, [replace(init, 2, statusSet)], builtin("InvalidAccountData"));
    await d.fails("InitializeMarket: not signed", payer, [unsigned(init, 3)], builtin("MissingRequiredSignature"));
  });
});

describe("InitializeMarket", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  let f: Market;
  const init = (m: Market, p: Parameters<typeof initParams>[0] = {}) =>
    ix.initializeMarket(m, initParams({ bids: m.bids, seats: m.seats, ...p }, m.authority.address));
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded();
    f = await d.newMarket();
  });

  it("initializes every accepted size", async () => {
    for (const [bids, seats] of [
      [512, 128],
      [512, 1025],
      [512, 1153],
      [1024, 128],
      [1024, 2049],
      [1024, 2177],
      [2048, 128],
      [2048, 4097],
      [2048, 4225],
      [4096, 128],
      [4096, 8193],
      [4096, 8321],
    ] as const) {
      const m = await d.newMarket({ bids, seats });
      await d.ok(`InitializeMarket ${bids}/${seats}`, m.authority, [init(m)]);
    }
  });

  it("initializes with other parameters", async () => {
    const collector = (await generateKeyPairSigner()).address;
    const cases: [string, Parameters<Diff["newMarket"]>[0], Parameters<typeof initParams>[0]][] = [
      ["raw base units 10, fee 10000, another fee collector", {}, { rawBaseUnitsPerBaseUnit: 10, takerFeeBps: 10000, feeCollector: collector }],
      [
        "0 decimals, lots of 1",
        { baseDecimals: 0, quoteDecimals: 0 },
        { quoteLotsPerQuoteUnit: 1n, baseLotsPerBaseUnit: 1n, tickSizeInQuoteLotsPerBaseUnit: 1n },
      ],
      [
        "19 decimals",
        { baseDecimals: 19, quoteDecimals: 19 },
        { quoteLotsPerQuoteUnit: 10n ** 19n, baseLotsPerBaseUnit: 10n ** 18n, tickSizeInQuoteLotsPerBaseUnit: 10n ** 18n },
      ],
      ["tick of 5 base lots, fee 7", {}, { tickSizeInQuoteLotsPerBaseUnit: 5000n, takerFeeBps: 7 }],
      ["account larger than the market", { size: marketSize(512, 128) + 100 }, {}],
    ];
    for (const [label, o, p] of cases) {
      const m = await d.newMarket(o);
      await d.ok(`InitializeMarket: ${label}`, m.authority, [init(m, p)]);
    }
  });

  it("leaves the bytes it does not own as they were (garbage in the header's padding and the FIFOMarket)", async () => {
    const m = await d.newMarket();
    d.patch(m.market, (b) => {
      for (let i = 16; i < 576; i++) b[i] = (i * 7 + 3) & 0xff; // the header after discriminant and status
      for (let i = 576; i < OFF.orderSequenceNumber; i++) b[i] = (i * 13) & 0xff; // padding, base lots, tick
      for (let i = OFF.takerFeeBps; i < OFF.bids; i++) b[i] = (i * 5) & 0xff; // fee, collected, unclaimed
      for (let i = OFF.bids + TREE.nodes; i < OFF.bids + TREE.nodes + 200; i++) b[i] = 0xab; // book nodes
    });
    await d.ok("InitializeMarket: garbage around the trees", m.authority, [init(m)]);
  });

  it("creates vaults someone funded first (Transfer, Allocate, Assign)", async () => {
    const partly = await d.newMarket();
    d.write(partly.baseVault, SYSTEM, Buffer.alloc(0), 1000n);
    d.write(partly.quoteVault, SYSTEM, Buffer.alloc(0), 1n);
    await d.ok("InitializeMarket: vaults partly funded", partly.authority, [init(partly)]);
    const fully = await d.newMarket();
    d.write(fully.baseVault, SYSTEM, Buffer.alloc(0), 10n * 1_000_000_000n);
    await d.ok("InitializeMarket: base vault over-funded", fully.authority, [init(fully)]);
  });

  it("takes its accounts in order (NotEnoughAccountKeys)", async () => {
    for (let n = 4; n < 10; n++) await d.fails(`InitializeMarket: ${n} accounts`, payer, [truncate(init(f), n)], builtin("NotEnoughAccountKeys"));
  });

  it("checks the mints", async () => {
    const at = async (bytes: Buffer, owner: Address = TOKEN) => {
      const k = (await generateKeyPairSigner()).address;
      d.write(k, owner, bytes);
      return k;
    };
    const cases: [string, Address, string][] = [
      ["mint owned by the System Program", await at(mintBytes({ decimals: 6 }), SYSTEM), "IllegalOwner"],
      ["mint of 83 bytes", await at(Buffer.concat([mintBytes({ decimals: 6 }), u8(0)])), "InvalidAccountData"],
      ["mint authority tag 2", await at(mintBytes({ decimals: 6, authorityTag: 2 })), "InvalidAccountData"],
      ["mint is_initialized 2", await at(mintBytes({ decimals: 6, initialized: 2 })), "InvalidAccountData"],
      ["mint freeze authority tag 2", await at(mintBytes({ decimals: 6, freezeTag: 2 })), "InvalidAccountData"],
      ["mint not initialized", await at(mintBytes({ decimals: 6, initialized: 0 })), "UninitializedAccount"],
    ];
    for (const [label, bad, err] of cases) {
      await d.fails(`InitializeMarket: base ${label}`, payer, [replace(init(f), 4, bad)], builtin(err));
      await d.fails(`InitializeMarket: quote ${label}`, payer, [replace(init(f), 5, bad)], builtin(err));
    }
  });

  it("checks the vaults are empty and the programs", async () => {
    const withBytes = (await generateKeyPairSigner()).address;
    d.write(withBytes, SYSTEM, Buffer.alloc(1));
    const tokenOwned = (await generateKeyPairSigner()).address;
    d.write(tokenOwned, TOKEN, Buffer.alloc(0), 1_000_000n);
    for (const [at, name] of [
      [6, "base"],
      [7, "quote"],
    ] as const) {
      await d.fails(`InitializeMarket: ${name} vault with data`, payer, [replace(init(f), at, withBytes)], builtin("InvalidAccountData"));
      await d.fails(`InitializeMarket: ${name} vault owned by SPL Token`, payer, [replace(init(f), at, tokenOwned)], builtin("IllegalOwner"));
    }
    await d.fails("InitializeMarket: not the System Program", payer, [replace(init(f), 8, TOKEN)], builtin("IncorrectProgramId"));
    await d.fails("InitializeMarket: not SPL Token", payer, [replace(init(f), 9, SYSTEM)], builtin("IncorrectProgramId"));
  });

  it("decodes InitializeParams exactly (BorshIoError)", async () => {
    const good = initParams({}, f.authority.address);
    const tagged = (p: Buffer) => Buffer.concat([u8(100), p]);
    for (const [label, data] of [
      ["no option tag", tagged(good.subarray(0, 82))],
      ["option tag 2", tagged(Buffer.concat([good.subarray(0, 82), u8(2)]))],
      ["Some without its u32", tagged(Buffer.concat([good.subarray(0, 82), u8(1), u8(1)]))],
      ["a byte after None", tagged(Buffer.concat([good, u8(0)]))],
      ["a byte after Some", tagged(Buffer.concat([good.subarray(0, 82), u8(1), u64(1n).subarray(0, 4), u8(0)]))],
      ["no params", u8(100)],
    ] as const) {
      await d.fails(`InitializeMarket: ${label}`, payer, [withData(init(f), data)], BORSH);
    }
  });

  it("checks the fee and the lot and tick sizes", async () => {
    const cases: [string, Parameters<typeof initParams>[0], string][] = [
      ["fee 10001", { takerFeeBps: 10001 }, builtin("InvalidInstructionData")],
      ["base lots 3 per unit", { baseLotsPerBaseUnit: 3n, tickSizeInQuoteLotsPerBaseUnit: 3n }, custom(E.InvalidLotSize!)],
      ["quote lots 7 per unit", { quoteLotsPerQuoteUnit: 7n }, custom(E.InvalidLotSize!)],
      ["base lots 0 (remainder by zero)", { baseLotsPerBaseUnit: 0n }, PANICKED],
      ["quote lots 0 (remainder by zero)", { quoteLotsPerQuoteUnit: 0n }, PANICKED],
      ["tick in atoms overflows", { quoteLotsPerQuoteUnit: 1n, tickSizeInQuoteLotsPerBaseUnit: 1n << 60n }, PANICKED],
      ["tick not a multiple of the base lots", { tickSizeInQuoteLotsPerBaseUnit: 1500n }, builtin("InvalidInstructionData")],
    ];
    for (const [label, p, err] of cases) await d.fails(`InitializeMarket: ${label}`, payer, [init(f, p)], err);
  });

  it("panics on mints with too many decimals (10u64.pow)", async () => {
    for (const decimals of [20, 21, 32, 40, 64, 255]) {
      const big = await d.mint(decimals);
      await d.fails(`InitializeMarket: base mint of ${decimals} decimals`, payer, [replace(init(f), 4, big)], PANICKED);
      await d.fails(`InitializeMarket: quote mint of ${decimals} decimals`, payer, [replace(init(f), 5, big)], PANICKED);
    }
    const nineteen = await d.mint(19);
    await d.fails(
      "InitializeMarket: 19 decimals × 10 raw units",
      payer,
      [replace(init(f, { rawBaseUnitsPerBaseUnit: 10, baseLotsPerBaseUnit: 1n }), 4, nineteen)],
      PANICKED,
    );
  });

  it("requires the vaults at their PDAs", async () => {
    const stray = (await generateKeyPairSigner()).address;
    await d.fails("InitializeMarket: base vault not the PDA", payer, [replace(init(f), 6, stray)], custom(E.InvalidMarketSigner!));
    // The base vault is created before the quote vault is checked; the failure undoes it.
    await d.fails("InitializeMarket: quote vault not the PDA", payer, [replace(init(f), 7, stray)], custom(E.InvalidMarketSigner!), [f.baseVault]);
  });

  it("refuses other market sizes, after creating the vaults", async () => {
    for (const [bids, asks, seats] of [
      [512, 512, 129],
      [512, 1024, 128],
      [1024, 512, 128],
      [0, 0, 0],
      [8192, 8192, 128],
      [256, 256, 128],
    ] as const) {
      await d.fails(`InitializeMarket: size ${bids}/${asks}/${seats}`, payer, [init(f, { bids, asks, seats })], custom(E.InvalidMarketParameters!), [
        f.baseVault,
        f.quoteVault,
      ]);
    }
  });

  it("panics when the account is smaller than the market, after creating the vaults", async () => {
    const short = await d.newMarket({ size: marketSize(512, 128) - 1 });
    await d.fails("InitializeMarket: one byte short", payer, [init(short)], PANICKED);
    await d.fails("InitializeMarket: 4096/8321 in a 512/128 account", payer, [init(f, { bids: 4096, seats: 8321 })], PANICKED);
  });

  it("refuses a market whose FIFOMarket is not blank", async () => {
    const started = await d.newMarket();
    d.patch(started.market, (b) => b.writeBigUInt64LE(1n, OFF.orderSequenceNumber));
    await d.fails("InitializeMarket: order sequence number 1", payer, [init(started)], custom(E.MarketAlreadyInitialized!));
    for (const [label, at] of [
      ["bids", OFF.bids],
      ["asks", asksAt(512)],
      ["traders", tradersAt(512)],
    ] as const) {
      for (const [field, off] of [
        ["size", TREE.size],
        ["bump index", TREE.bumpIndex],
        ["free list head", TREE.freeListHead],
      ] as const) {
        const m = await d.newMarket();
        d.patch(m.market, (b) => (b[at + off] = 1));
        await d.fails(`InitializeMarket: ${label} allocator ${field} set`, payer, [init(m)], PANICKED);
      }
    }
  });

  it("needs the creator to pay (writable, funded)", async () => {
    await d.fails("InitializeMarket: creator read-only", payer, [readonly(init(f), 3)], builtin("PrivilegeEscalation"));
    await d.fails("InitializeMarket: market read-only", payer, [readonly(init(f), 2)], builtin("ReadonlyDataModified"));
    const poor = await generateKeyPairSigner();
    for (const vm of d.vms) vm.airdrop(poor.address, 1_000_000n as never);
    await d.fails("InitializeMarket: creator cannot pay rent", payer, [ix.initializeMarket(f, initParams({}, poor.address), poor)], custom(1));
  });
});

/** MarketStatus as ChangeMarketStatus takes it. */
const STATUS = { Uninitialized: 0, Active: 1, PostOnly: 2, Paused: 3, Closed: 4, Tombstoned: 5 } as const;
const STATUS_NAMES = Object.keys(STATUS) as (keyof typeof STATUS)[];
/** MarketStatus::valid_state_transition. */
const VALID: Record<number, number[]> = { 0: [2], 1: [2, 3, 1], 2: [1, 3, 4, 2], 3: [1, 2, 4, 3], 4: [5, 3, 4, 2] };

for (const [bids, seats] of [
  [512, 128],
  [4096, 8321],
] as const) {
  describe(`authority and market status (${bids}/${seats})`, () => {
    let d: Diff;
    let payer: KeyPairSigner;
    let m: Market;
    const tag = `${bids}/${seats}`;
    const setStatus = (market: Market, status: number) => d.patch(market.market, (b) => b.writeBigUInt64LE(BigInt(status), OFF.status));
    beforeAll(async () => {
      d = await diff();
      payer = await d.funded();
      m = await d.market({ bids, seats, label: `InitializeMarket ${tag}` });
    });

    it("names and claims the authority", async () => {
      const next = await d.funded();
      const stranger = await d.funded();
      await d.fails(`NameSuccessor ${tag}: not the authority`, payer, [ix.nameSuccessor(m, next.address, stranger)], custom(E.InvalidMarketAuthority!));
      await d.fails(
        `NameSuccessor ${tag}: 31 bytes`,
        payer,
        [withData(ix.nameSuccessor(m, next.address), Buffer.concat([u8(102), key(next.address).subarray(0, 31)]))],
        BORSH,
      );
      await d.fails(
        `NameSuccessor ${tag}: 33 bytes`,
        payer,
        [withData(ix.nameSuccessor(m, next.address), Buffer.concat([u8(102), key(next.address), u8(0)]))],
        BORSH,
      );
      // The creator is its own successor until it names one.
      await d.ok(`ClaimAuthority ${tag}: the creator, its own successor`, payer, [ix.claimAuthority(m, m.authority)]);
      await d.fails(`ClaimAuthority ${tag}: not the successor`, payer, [ix.claimAuthority(m, next)], custom(E.InvalidMarketAuthority!));
      await d.ok(`NameSuccessor ${tag}`, payer, [ix.nameSuccessor(m, next.address)]);
      await d.fails(`ClaimAuthority ${tag}: another signer`, payer, [ix.claimAuthority(m, stranger)], custom(E.InvalidMarketAuthority!));
      // Once named, only the successor claims.
      await d.ok(`ClaimAuthority ${tag}`, payer, [ix.claimAuthority(m, next)]);
      await d.fails(`NameSuccessor ${tag}: the old authority`, payer, [ix.nameSuccessor(m, stranger.address)], custom(E.InvalidMarketAuthority!));
      // Hand it back so the rest of the tests use the creator.
      await d.ok(`NameSuccessor ${tag}: back`, payer, [ix.nameSuccessor(m, m.authority.address, next)]);
      await d.ok(`ClaimAuthority ${tag}: back`, payer, [ix.claimAuthority(m, m.authority)]);
      // The successor may claim again (it stays the successor).
      await d.ok(`ClaimAuthority ${tag}: again`, payer, [ix.claimAuthority(m, m.authority)]);
    });

    it("changes the status along the valid transitions only", async () => {
      for (const from of [STATUS.Uninitialized, STATUS.Active, STATUS.PostOnly, STATUS.Paused, STATUS.Closed]) {
        for (const to of [0, 1, 2, 3, 4]) {
          setStatus(m, from);
          const ok = VALID[from]!.includes(to);
          await d.fails(
            `ChangeMarketStatus ${tag}: ${STATUS_NAMES[from]} → ${STATUS_NAMES[to]}`,
            payer,
            [ix.changeMarketStatus(m, to)],
            ok ? "ok" : custom(E.InvalidStateTransition!),
          );
        }
        if (from !== STATUS.Closed) {
          setStatus(m, from);
          await d.fails(
            `ChangeMarketStatus ${tag}: ${STATUS_NAMES[from]} → Tombstoned`,
            payer,
            [ix.changeMarketStatus(m, STATUS.Tombstoned)],
            custom(E.InvalidStateTransition!),
          );
        }
      }
      setStatus(m, STATUS.PostOnly);
    });

    it("ignores accounts past the ones it reads (40 here)", async () => {
      const extra = (await generateKeyPairSigner()).address;
      const many = accounts(ix.changeMarketStatus(m, STATUS.PostOnly, extra), (l) => {
        while (l.length < 40) l.push({ address: extra, role: AccountRole.READONLY });
      });
      await d.ok(`ChangeMarketStatus ${tag}: 40 accounts`, payer, [many]);
    });

    it("checks the authority and the status byte", async () => {
      const stranger = await d.funded();
      await d.fails(
        `ChangeMarketStatus ${tag}: not the authority`,
        payer,
        [ix.changeMarketStatus(m, 1, undefined, stranger)],
        custom(E.InvalidMarketAuthority!),
      );
      for (const [label, data] of [
        ["status 6", Buffer.from([103, 6])],
        ["no status", Buffer.from([103])],
        ["a byte after the status", Buffer.from([103, 1, 0])],
      ] as const) {
        await d.fails(`ChangeMarketStatus ${tag}: ${label}`, payer, [withData(ix.changeMarketStatus(m, 1), data)], BORSH);
      }
    });

    it("tombstones only an empty market", async () => {
      const closed = await d.market({ bids, seats, label: `InitializeMarket ${tag} (to tombstone)` });
      await d.ok(`ChangeMarketStatus ${tag}: PostOnly → Closed`, payer, [ix.changeMarketStatus(closed, STATUS.Closed)]);
      const save = d.data(closed.market);
      const restore = () => d.patch(closed.market, (b) => save.copy(b));
      d.patch(closed.market, (b) => {
        b.writeBigUInt64LE(3n, OFF.bids + TREE.size);
        b.writeBigUInt64LE(2n, asksAt(bids) + TREE.size);
      });
      await d.fails(
        `ChangeMarketStatus ${tag}: tombstone with 3 bids and 2 asks`,
        payer,
        [ix.changeMarketStatus(closed, STATUS.Tombstoned)],
        builtin("InvalidAccountData"),
      );
      restore();
      d.patch(closed.market, (b) => b.writeBigUInt64LE(1n, asksAt(bids) + TREE.size));
      await d.fails(
        `ChangeMarketStatus ${tag}: tombstone with 1 ask`,
        payer,
        [ix.changeMarketStatus(closed, STATUS.Tombstoned)],
        builtin("InvalidAccountData"),
      );
      restore();
      d.patch(closed.market, (b) => b.writeBigUInt64LE(5n, OFF.unclaimedFees));
      await d.fails(
        `ChangeMarketStatus ${tag}: tombstone with uncollected fees`,
        payer,
        [ix.changeMarketStatus(closed, STATUS.Tombstoned)],
        builtin("InvalidAccountData"),
      );
      restore();
      d.patch(closed.market, (b) => b.writeBigUInt64LE(0n, OFF.orderSequenceNumber));
      await d.fails(
        `ChangeMarketStatus ${tag}: tombstone an uninitialized FIFOMarket`,
        payer,
        [ix.changeMarketStatus(closed, STATUS.Tombstoned)],
        custom(E.MarketUninitialized!),
      );
      restore();
      // A registered trader (a seat approved while the market took orders).
      d.patch(closed.market, (b) => b.writeBigUInt64LE(2n, OFF.status));
      const t = await d.seated(closed, 0n, 0n, `${tag} tombstone trader`);
      await d.ok(`ChangeMarketStatus ${tag}: PostOnly → Closed again`, payer, [ix.changeMarketStatus(closed, STATUS.Closed)]);
      await d.fails(
        `ChangeMarketStatus ${tag}: tombstone with a trader`,
        payer,
        [ix.changeMarketStatus(closed, STATUS.Tombstoned)],
        builtin("InvalidAccountData"),
      );
      // The trader's state removed again (the tree as it was before the approval).
      restore();
      const receiver = (await generateKeyPairSigner()).address;
      await d.fails(
        `ChangeMarketStatus ${tag}: tombstone into the market itself`,
        payer,
        [ix.changeMarketStatus(closed, STATUS.Tombstoned, closed.market)],
        builtin("UnbalancedInstruction"),
      );
      await d.fails(
        `ChangeMarketStatus ${tag}: tombstone, market read-only`,
        payer,
        [readonly(ix.changeMarketStatus(closed, STATUS.Tombstoned, receiver), 2)],
        builtin("ReadonlyLamportChange"),
      );
      await d.fails(
        `ChangeMarketStatus ${tag}: Closed → Paused, market read-only`,
        payer,
        [readonly(ix.changeMarketStatus(closed, STATUS.Paused), 2)],
        builtin("ReadonlyDataModified"),
      );
      await d.ok(`ChangeMarketStatus ${tag}: tombstone, lamports to a receiver`, payer, [ix.changeMarketStatus(closed, STATUS.Tombstoned, receiver)]);
      expect(d.original.getAccount(closed.market).exists).toBe(false);
      // A market that is gone is no market.
      await d.fails(`ChangeMarketStatus ${tag}: the tombstoned market`, payer, [ix.changeMarketStatus(closed, STATUS.Closed)], builtin("IllegalOwner"));
      await d.fails(`DepositFunds ${tag}: the tombstoned market`, payer, [ix.depositFunds(closed, t, 1n, 1n)], builtin("IllegalOwner"));

      const other = await d.market({ bids, seats, label: `InitializeMarket ${tag} (tombstone to the authority)` });
      await d.ok(`ChangeMarketStatus ${tag}: PostOnly → Closed (2)`, payer, [ix.changeMarketStatus(other, STATUS.Closed)]);
      await d.ok(`ChangeMarketStatus ${tag}: tombstone, lamports to the authority`, payer, [ix.changeMarketStatus(other, STATUS.Tombstoned)]);
    });
  });
}

/** SeatApprovalStatus. */
const SEAT = { NotApproved: 0, Approved: 1, Retired: 2 } as const;
const SEAT_NAMES = Object.keys(SEAT) as (keyof typeof SEAT)[];
/** The approval status in a seat's bytes. */
const SEAT_STATUS_AT = 72;

for (const [bids, seats] of [
  [512, 128],
  [4096, 8321],
] as const) {
  describe(`seats (${bids}/${seats})`, () => {
    let d: Diff;
    let payer: KeyPairSigner;
    let m: Market;
    const tag = `${bids}/${seats}`;
    beforeAll(async () => {
      d = await diff();
      payer = await d.funded();
      m = await d.market({ bids, seats, label: `InitializeMarket ${tag}` });
    });

    it("RequestSeat: creates the trader's seat while the market takes orders", async () => {
      const t = await d.trader(m);
      await d.fails(`RequestSeat ${tag}: 4 accounts`, payer, [truncate(ix.requestSeat(m, t), 4)], builtin("NotEnoughAccountKeys"));
      await d.fails(`RequestSeat ${tag}: 5 accounts`, payer, [truncate(ix.requestSeat(m, t), 5)], builtin("NotEnoughAccountKeys"));
      await d.fails(`RequestSeat ${tag}: not the System Program`, payer, [replace(ix.requestSeat(m, t), 5, TOKEN)], builtin("IncorrectProgramId"));
      const stray = (await generateKeyPairSigner()).address;
      await d.fails(`RequestSeat ${tag}: not the seat PDA`, payer, [replace(ix.requestSeat(m, t), 4, stray)], builtin("InvalidAccountData"));
      const tokenOwned = (await generateKeyPairSigner()).address;
      d.write(tokenOwned, TOKEN, Buffer.alloc(0), 1_000_000n);
      await d.fails(`RequestSeat ${tag}: seat owned by SPL Token`, payer, [replace(ix.requestSeat(m, t), 4, tokenOwned)], builtin("IllegalOwner"));
      await d.fails(`RequestSeat ${tag}: trader read-only`, payer, [readonly(ix.requestSeat(m, t), 3)], builtin("PrivilegeEscalation"));
      for (const status of [STATUS.Paused, STATUS.Closed]) {
        d.patch(m.market, (b) => b.writeBigUInt64LE(BigInt(status), OFF.status));
        await d.fails(`RequestSeat ${tag}: market ${STATUS_NAMES[status]}`, payer, [ix.requestSeat(m, t)], builtin("InvalidAccountData"));
      }
      d.patch(m.market, (b) => b.writeBigUInt64LE(BigInt(STATUS.Active), OFF.status));
      await d.ok(`RequestSeat ${tag}: market Active`, payer, [ix.requestSeat(m, t)]);
      await d.fails(`RequestSeat ${tag}: the seat exists`, payer, [ix.requestSeat(m, t)], builtin("InvalidAccountData"));
      d.patch(m.market, (b) => b.writeBigUInt64LE(BigInt(STATUS.PostOnly), OFF.status));
      // Seats someone funded first.
      const partly = await d.trader(m);
      d.write(partly.seat, SYSTEM, Buffer.alloc(0), 5000n);
      await d.ok(`RequestSeat ${tag}: seat partly funded`, payer, [ix.requestSeat(m, partly)]);
      const fully = await d.trader(m);
      d.write(fully.seat, SYSTEM, Buffer.alloc(0), 1_000_000_000n);
      await d.ok(`RequestSeat ${tag}: seat over-funded`, payer, [ix.requestSeat(m, fully)]);
    });

    it("RequestSeatAuthorized: the authority requests one for a trader", async () => {
      const t = await d.trader(m);
      const funder = await d.funded();
      const req = (o: { payer?: KeyPairSigner; seat?: Address; authority?: KeyPairSigner } = {}) =>
        ix.requestSeatAuthorized(m, o.payer ?? funder, t.key.address, o.seat ?? t.seat, o.authority ?? m.authority);
      await d.fails(`RequestSeatAuthorized ${tag}: not the authority`, payer, [req({ authority: funder })], custom(E.InvalidMarketAuthority!));
      for (let n = 4; n < 8; n++) await d.fails(`RequestSeatAuthorized ${tag}: ${n} accounts`, payer, [truncate(req(), n)], builtin("NotEnoughAccountKeys"));
      await d.fails(`RequestSeatAuthorized ${tag}: payer read-only`, payer, [readonly(req(), 4)], builtin("InvalidInstructionData"));
      await d.fails(`RequestSeatAuthorized ${tag}: payer not signing`, payer, [unsigned(req(), 4)], builtin("MissingRequiredSignature"));
      await d.fails(`RequestSeatAuthorized ${tag}: not the System Program`, payer, [replace(req(), 7, TOKEN)], builtin("IncorrectProgramId"));
      const other = await seatAddress(m.market, funder.address);
      await d.fails(`RequestSeatAuthorized ${tag}: another trader's seat PDA`, payer, [req({ seat: other })], builtin("InvalidAccountData"));
      // Whatever the market's status.
      d.patch(m.market, (b) => b.writeBigUInt64LE(BigInt(STATUS.Paused), OFF.status));
      await d.ok(`RequestSeatAuthorized ${tag}`, payer, [req()]);
      d.patch(m.market, (b) => b.writeBigUInt64LE(BigInt(STATUS.PostOnly), OFF.status));
      await d.fails(`RequestSeatAuthorized ${tag}: the seat exists`, payer, [req()], builtin("InvalidAccountData"));
      // The authority paying for its own seat.
      const own = await seatAddress(m.market, m.authority.address);
      await d.ok(`RequestSeatAuthorized ${tag}: the authority's own seat`, payer, [ix.requestSeatAuthorized(m, m.authority, m.authority.address, own)]);
    });

    it("ChangeSeatStatus: every transition", async () => {
      const t = await d.trader(m);
      await d.ok(`RequestSeat ${tag}: for transitions`, payer, [ix.requestSeat(m, t)]);
      for (const from of [SEAT.NotApproved, SEAT.Approved, SEAT.Retired]) {
        for (const to of [SEAT.NotApproved, SEAT.Approved, SEAT.Retired]) {
          d.patch(t.seat, (b) => b.writeBigUInt64LE(BigInt(from), SEAT_STATUS_AT));
          const valid = from === to || (from === 0 && to !== 0) || (from === 1 && to !== 1);
          await d.fails(
            `ChangeSeatStatus ${tag}: ${SEAT_NAMES[from]} → ${SEAT_NAMES[to]}`,
            payer,
            [ix.changeSeatStatus(m, t.seat, to)],
            valid ? "ok" : builtin("InvalidInstructionData"),
          );
        }
      }
      // Approving again once registered: the trader is found, nothing inserted.
      d.patch(t.seat, (b) => b.writeBigUInt64LE(0n, SEAT_STATUS_AT));
      await d.ok(`ChangeSeatStatus ${tag}: approve a registered trader again`, payer, [ix.changeSeatStatus(m, t.seat, SEAT.Approved)]);
    });

    it("ChangeSeatStatus: checks the authority, the seat and the status byte", async () => {
      const t = await d.trader(m);
      await d.ok(`RequestSeat ${tag}: for checks`, payer, [ix.requestSeat(m, t)]);
      const stranger = await d.funded();
      await d.fails(`ChangeSeatStatus ${tag}: not the authority`, payer, [ix.changeSeatStatus(m, t.seat, 1, stranger)], custom(E.InvalidMarketAuthority!));
      await d.fails(`ChangeSeatStatus ${tag}: no seat`, payer, [truncate(ix.changeSeatStatus(m, t.seat, 1), 4)], builtin("NotEnoughAccountKeys"));
      const empty = (await generateKeyPairSigner()).address;
      await d.fails(`ChangeSeatStatus ${tag}: seat with no data`, payer, [replace(ix.changeSeatStatus(m, t.seat, 1), 4, empty)], PANICKED);
      const seatBytes = d.data(t.seat);
      const copy = async (owner: Address, edit?: (b: Buffer) => void) => {
        const k = (await generateKeyPairSigner()).address;
        const b = Buffer.from(seatBytes);
        edit?.(b);
        d.write(k, owner, b);
        return k;
      };
      const elsewhere = await d.market({ bids, seats, label: `InitializeMarket ${tag} (another)` });
      await d.fails(`ChangeSeatStatus ${tag}: another market's seat`, payer, [ix.changeSeatStatus(elsewhere, t.seat, 1)], builtin("InvalidAccountData"));
      await d.fails(
        `ChangeSeatStatus ${tag}: seat bytes not owned by Phoenix`,
        payer,
        [replace(ix.changeSeatStatus(m, t.seat, 1), 4, await copy(SYSTEM))],
        builtin("IllegalOwner"),
      );
      await d.fails(
        `ChangeSeatStatus ${tag}: seat bytes elsewhere`,
        payer,
        [replace(ix.changeSeatStatus(m, t.seat, 1), 4, await copy(PROGRAM))],
        builtin("InvalidInstructionData"),
      );
      d.patch(t.seat, (b) => (b[0]! ^= 1));
      await d.fails(`ChangeSeatStatus ${tag}: seat discriminant`, payer, [ix.changeSeatStatus(m, t.seat, 1)], builtin("InvalidAccountData"));
      d.patch(t.seat, (b) => (b[0]! ^= 1));
      for (const [label, data] of [
        ["status 3", Buffer.from([104, 3])],
        ["no status", Buffer.from([104])],
        ["a byte after the status", Buffer.from([104, 1, 1])],
      ] as const) {
        await d.fails(`ChangeSeatStatus ${tag}: ${label}`, payer, [withData(ix.changeSeatStatus(m, t.seat, 1), data)], BORSH);
      }
    });

    it("ChangeSeatStatus: fails to register a trader when the traders tree is full", async () => {
      const first = await d.seated(m, 0n, 0n, `${tag} first trader`);
      void first;
      const next = await d.trader(m);
      await d.ok(`RequestSeat ${tag}: next trader`, payer, [ix.requestSeat(m, next)]);
      const save = d.data(m.market);
      d.patch(m.market, (b) => b.writeBigUInt64LE(BigInt(seats), tradersAt(bids) + TREE.size));
      await d.fails(`ChangeSeatStatus ${tag}: traders tree full`, payer, [ix.changeSeatStatus(m, next.seat, SEAT.Approved)], builtin("InvalidArgument"));
      d.patch(m.market, (b) => save.copy(b));
    });

    it("ChangeSeatStatus: registers a trader into a freed node (its old key and state overwritten)", async () => {
      const fm = await d.market({ bids, seats, label: `InitializeMarket ${tag} (freed node)` });
      const a = await d.seated(fm, 0n, 0n, `${tag} trader A`);
      const b = await d.seated(fm, 0n, 0n, `${tag} trader B`);
      const c = await d.trader(fm);
      await d.ok(`RequestSeat ${tag}: trader C`, payer, [ix.requestSeat(fm, c)]);
      // As sokoban leaves the tree when B (node 2, a red leaf under the root A) is removed: A's link to it cleared,
      // node 2 on the free list (its first register the next free node, the bump index 3), its key and state kept.
      const tree = tradersAt(bids);
      const node = (i: number) => tree + TREE.nodes + (i - 1) * 144;
      const left = Buffer.compare(key(b.key.address), key(a.key.address)) < 0;
      d.patch(fm.market, (x) => {
        expect(x.readUInt32LE(tree + TREE.root)).toBe(1);
        x.writeUInt32LE(0, node(1) + (left ? 0 : 4));
        for (let r = 0; r < 4; r++) x.writeUInt32LE(r === 0 ? 3 : 0, node(2) + 4 * r);
        x.writeBigUInt64LE(1n, tree + TREE.size);
        x.writeUInt32LE(2, tree + TREE.freeListHead);
        x.writeBigUInt64LE(77n, node(2) + 48 + TS.baseFree); // the freed node's old state, left behind
      });
      await d.ok(`ChangeSeatStatus ${tag}: C takes the freed node`, payer, [ix.changeSeatStatus(fm, c.seat, SEAT.Approved)]);
      expect(
        d
          .data(fm.market)
          .subarray(node(2) + 16, node(2) + 48)
          .equals(key(c.key.address)),
      ).toBe(true);
    });

    it("panics on a seat or market status no Phoenix instruction writes", async () => {
      const t = await d.seated(m, 1000n * 1_000_000n, 1000n, `${tag} bad status`);
      d.patch(t.seat, (b) => b.writeBigUInt64LE(3n, SEAT_STATUS_AT));
      await d.fails(`DepositFunds ${tag}: seat approval status 3`, payer, [ix.depositFunds(m, t, 1n, 1n)], PANICKED);
      await d.fails(`ChangeSeatStatus ${tag}: seat approval status 3`, payer, [ix.changeSeatStatus(m, t.seat, SEAT.Retired)], PANICKED);
      d.patch(t.seat, (b) => b.writeBigUInt64LE(1n, SEAT_STATUS_AT));
      const save = d.data(m.market);
      d.patch(m.market, (b) => b.writeBigUInt64LE(6n, OFF.status));
      await d.fails(`DepositFunds ${tag}: market status 6`, payer, [ix.depositFunds(m, t, 1n, 1n)], PANICKED);
      await d.fails(`WithdrawFunds ${tag}: market status 6`, payer, [ix.withdrawFunds(m, t)], PANICKED);
      await d.fails(`ChangeMarketStatus ${tag}: market status 6`, payer, [ix.changeMarketStatus(m, STATUS.Active)], PANICKED);
      await d.fails(`RequestSeat ${tag}: market status 6`, payer, [ix.requestSeat(m, await d.trader(m))], PANICKED);
      d.patch(m.market, (b) => save.copy(b));
      // A seat PDA that holds less than a seat.
      const u = await d.trader(m, 0n, 0n);
      d.write(u.seat, PROGRAM, Buffer.alloc(10));
      await d.fails(`DepositFunds ${tag}: seat of 10 bytes`, payer, [ix.depositFunds(m, u, 1n, 1n)], PANICKED);
      await d.fails(`ChangeSeatStatus ${tag}: seat of 10 bytes`, payer, [ix.changeSeatStatus(m, u.seat, SEAT.Approved)], PANICKED);
    });

    it("panics when the market's sequence number would overflow, after the instruction", async () => {
      const save = d.data(m.market);
      d.patch(m.market, (b) => b.writeBigUInt64LE(U64_MAX, OFF.sequenceNumber));
      await d.fails(`ChangeMarketStatus ${tag}: sequence number u64::MAX`, payer, [ix.changeMarketStatus(m, STATUS.Active)], PANICKED);
      d.patch(m.market, (b) => b.writeBigUInt64LE(U64_MAX - 1n, OFF.sequenceNumber));
      await d.ok(`ChangeMarketStatus ${tag}: sequence number u64::MAX - 1`, payer, [ix.changeMarketStatus(m, STATUS.PostOnly)]);
      d.patch(m.market, (b) => save.copy(b));
    });
  });
}

/** Where a registered trader's TraderState starts in the market (its node's key found among the trader nodes). */
function traderStateAt(d: Diff, m: Market, trader: Address): number {
  const b = d.data(m.market);
  const k = key(trader);
  const nodes = tradersAt(m.bids) + TREE.nodes;
  for (let i = 0; i < m.seats; i++) {
    const at = nodes + i * 144;
    if (b.subarray(at + 16, at + 48).equals(k)) return at + 48;
  }
  throw new Error("trader not registered");
}
/** TraderState fields, from its start. */
const TS = { quoteLocked: 0, quoteFree: 8, baseLocked: 16, baseFree: 24 } as const;

for (const [bids, seats] of [
  [512, 128],
  [4096, 8321],
] as const) {
  describe(`deposits and withdrawals (${bids}/${seats})`, () => {
    let d: Diff;
    let payer: KeyPairSigner;
    let m: Market;
    /** A market whose quote lot is 1000 atoms (1000 quote lots per unit, 6 decimals). */
    let coarse: Market;
    const tag = `${bids}/${seats}`;
    const BASE = 1_000_000n; // base atoms per base lot (9 decimals, 1000 lots per unit)
    beforeAll(async () => {
      d = await diff();
      payer = await d.funded();
      m = await d.market({ bids, seats, label: `InitializeMarket ${tag}` });
      coarse = await d.market({
        bids,
        seats,
        params: { quoteLotsPerQuoteUnit: 1000n, tickSizeInQuoteLotsPerBaseUnit: 1000n },
        label: `InitializeMarket ${tag} (coarse)`,
      });
    });

    it("deposits and withdraws free funds", async () => {
      const t = await d.seated(m, 100n * BASE, 10_000_000n, `${tag} depositor`);
      await d.ok(`DepositFunds ${tag}: quote and base`, payer, [ix.depositFunds(m, t, 3_000_000n, 40n)]);
      await d.ok(`DepositFunds ${tag}: quote only`, payer, [ix.depositFunds(m, t, 1n, 0n)]);
      await d.ok(`DepositFunds ${tag}: base only`, payer, [ix.depositFunds(m, t, 0n, 2n)]);
      await d.ok(`DepositFunds ${tag}: nothing`, payer, [ix.depositFunds(m, t, 0n, 0n)]);
      await d.ok(`WithdrawFunds ${tag}: some quote, all base`, payer, [ix.withdrawFunds(m, t, 1000n, null)]);
      await d.ok(`WithdrawFunds ${tag}: more than free (clamped)`, payer, [ix.withdrawFunds(m, t, 10n ** 12n, 10n ** 12n)]);
      await d.ok(`WithdrawFunds ${tag}: nothing free`, payer, [ix.withdrawFunds(m, t)]);
      await d.ok(`DepositFunds ${tag}: again`, payer, [ix.depositFunds(m, t, 5n, 5n)]);
      await d.ok(`WithdrawFunds ${tag}: zero of each`, payer, [ix.withdrawFunds(m, t, 0n, 0n)]);
      await d.ok(`WithdrawFunds ${tag}: base only`, payer, [ix.withdrawFunds(m, t, 0n, null)]);
      await d.ok(`WithdrawFunds ${tag}: all`, payer, [ix.withdrawFunds(m, t)]);
      // Withdrawals work in every status but Uninitialized and Tombstoned; deposits only while orders are taken.
      await d.ok(`DepositFunds ${tag}: before pausing`, payer, [ix.depositFunds(m, t, 7n, 7n)]);
      for (const status of [STATUS.Paused, STATUS.Closed]) {
        d.patch(m.market, (b) => b.writeBigUInt64LE(BigInt(status), OFF.status));
        await d.fails(`DepositFunds ${tag}: market ${STATUS_NAMES[status]}`, payer, [ix.depositFunds(m, t, 1n, 1n)], builtin("InvalidAccountData"));
        await d.ok(`WithdrawFunds ${tag}: market ${STATUS_NAMES[status]}`, payer, [ix.withdrawFunds(m, t, 1n, 1n)]);
      }
      for (const status of [STATUS.Uninitialized, STATUS.Tombstoned]) {
        d.patch(m.market, (b) => b.writeBigUInt64LE(BigInt(status), OFF.status));
        await d.fails(`WithdrawFunds ${tag}: market ${STATUS_NAMES[status]}`, payer, [ix.withdrawFunds(m, t)], builtin("InvalidAccountData"));
      }
      d.patch(m.market, (b) => b.writeBigUInt64LE(BigInt(STATUS.Active), OFF.status));
      await d.ok(`DepositFunds ${tag}: market Active`, payer, [ix.depositFunds(m, t, 1n, 1n)]);
      d.patch(m.market, (b) => b.writeBigUInt64LE(BigInt(STATUS.PostOnly), OFF.status));
    });

    it("registers an approved trader on its first deposit, or fails when the tree is full", async () => {
      const before = d.data(m.market);
      const t = await d.seated(m, 10n * BASE, 1000n, `${tag} unregistered`);
      // The approval registered the trader; put the traders tree back as it was, the seat staying approved.
      d.patch(m.market, (b) => before.copy(b));
      const full = Buffer.from(before);
      full.writeBigUInt64LE(BigInt(seats), tradersAt(bids) + TREE.size);
      if (full.readUInt32LE(tradersAt(bids) + TREE.root) !== 0) {
        d.patch(m.market, (b) => full.copy(b));
        await d.fails(`DepositFunds ${tag}: traders tree full`, payer, [ix.depositFunds(m, t, 1n, 1n)], custom(E.TraderNotFound!));
        d.patch(m.market, (b) => before.copy(b));
      }
      await d.ok(`DepositFunds ${tag}: registers the trader`, payer, [ix.depositFunds(m, t, 1n, 1n)]);
      await d.fails(`WithdrawFunds ${tag}: a trader with no state`, payer, [ix.withdrawFunds(m, await d.trader(m))], custom(E.WithdrawFundsError!));
    });

    it("checks the seat", async () => {
      const t = await d.seated(m, BASE, 1000n, `${tag} seat checks`);
      const u = await d.trader(m, BASE, 1000n);
      await d.ok(`RequestSeat ${tag}: unapproved`, payer, [ix.requestSeat(m, u)]);
      const dep = (x: Trader) => ix.depositFunds(m, x, 1n, 1n);
      await d.fails(`DepositFunds ${tag}: no seat`, payer, [truncate(dep(t), 4)], builtin("NotEnoughAccountKeys"));
      await d.fails(`DepositFunds ${tag}: seat not approved`, payer, [dep(u)], custom(E.InvalidSeatStatus!));
      d.patch(u.seat, (b) => b.writeBigUInt64LE(2n, SEAT_STATUS_AT));
      await d.fails(`DepositFunds ${tag}: seat retired`, payer, [dep(u)], custom(E.InvalidSeatStatus!));
      await d.fails(`DepositFunds ${tag}: another trader's seat`, payer, [replace(dep(t), 4, u.seat)], builtin("InvalidInstructionData"));
      const copied = (await generateKeyPairSigner()).address;
      d.write(copied, SYSTEM, d.data(t.seat));
      await d.fails(`DepositFunds ${tag}: seat not owned by Phoenix`, payer, [replace(dep(t), 4, copied)], builtin("IllegalOwner"));
      const save = d.data(t.seat);
      for (const [label, edit] of [
        ["seat discriminant", (b: Buffer) => (b[1]! ^= 1)],
        ["seat's trader", (b: Buffer) => (b[40]! ^= 1)],
        ["seat's market", (b: Buffer) => (b[8]! ^= 1)],
      ] as const) {
        d.patch(t.seat, edit);
        await d.fails(`DepositFunds ${tag}: ${label}`, payer, [dep(t)], builtin("InvalidAccountData"));
        d.patch(t.seat, (b) => save.copy(b));
      }
    });

    it("checks the token accounts, the vaults and the program", async () => {
      const t = await d.seated(m, BASE, 1000n, `${tag} vault checks`);
      const other = await d.trader(m, BASE, 1000n);
      const dep = ix.depositFunds(m, t, 1n, 1n);
      const wd = ix.withdrawFunds(m, t);
      for (let n = 5; n < 10; n++) await d.fails(`DepositFunds ${tag}: ${n} accounts`, payer, [truncate(dep, n)], builtin("NotEnoughAccountKeys"));
      for (let n = 4; n < 9; n++) await d.fails(`WithdrawFunds ${tag}: ${n} accounts`, payer, [truncate(wd, n)], builtin("NotEnoughAccountKeys"));
      const long = (await generateKeyPairSigner()).address;
      d.write(long, TOKEN, Buffer.concat([tokenAccountBytes({ mint: m.baseMint, owner: t.key.address }), u8(0)]));
      const systemOwned = (await generateKeyPairSigner()).address;
      d.write(systemOwned, SYSTEM, tokenAccountBytes({ mint: m.baseMint, owner: t.key.address }));
      const strayVault = await d.tokenAccount(m.baseMint, m.baseVault);
      // [label, account index in DepositFunds (WithdrawFunds: one less), replacement, error]
      const cases: [string, number, Address, string][] = [
        ["base account of the quote mint", 5, t.quote, "InvalidAccountData"],
        ["base account of another trader", 5, other.base, "IllegalOwner"],
        ["base account of 166 bytes", 5, long, "InvalidAccountData"],
        ["base account owned by the System Program", 5, systemOwned, "IllegalOwner"],
        ["quote account of the base mint", 6, t.base, "InvalidAccountData"],
        ["quote account of another trader", 6, other.quote, "IllegalOwner"],
        ["base vault elsewhere", 7, strayVault, "InvalidInstructionData"],
        ["quote vault elsewhere", 8, m.baseVault, "InvalidInstructionData"],
        ["not SPL Token", 9, SYSTEM, "IncorrectProgramId"],
      ];
      for (const [label, at, bad, err] of cases) {
        await d.fails(`DepositFunds ${tag}: ${label}`, payer, [replace(dep, at, bad)], builtin(err));
        await d.fails(`WithdrawFunds ${tag}: ${label}`, payer, [replace(wd, at - 1, bad)], builtin(err));
      }
      // A vault whose own bytes are wrong: its owner field.
      const save = d.data(m.quoteVault);
      d.patch(m.quoteVault, (b) => (b[33]! ^= 1));
      await d.fails(`DepositFunds ${tag}: quote vault's owner field`, payer, [dep], builtin("IllegalOwner"));
      d.patch(m.quoteVault, (b) => save.copy(b));
    });

    it("decodes the parameters exactly", async () => {
      const t = await d.seated(m, BASE, 1000n, `${tag} decoding`);
      const dep = ix.depositFunds(m, t, 1n, 1n);
      const wd = ix.withdrawFunds(m, t);
      await d.fails(`DepositFunds ${tag}: 15 bytes of params`, payer, [withData(dep, Buffer.concat([u8(13), Buffer.alloc(15)]))], BORSH);
      await d.fails(`DepositFunds ${tag}: 17 bytes of params`, payer, [withData(dep, Buffer.concat([u8(13), Buffer.alloc(17)]))], BORSH);
      for (const [label, params] of [
        ["no params", Buffer.alloc(0)],
        ["quote tag 2", Buffer.from([2, 0])],
        ["base tag 2", Buffer.from([0, 2])],
        ["quote Some, short", Buffer.from([1, 1, 2, 3])],
        ["base missing", Buffer.from([0])],
        ["a byte after", Buffer.from([0, 0, 0])],
        ["base Some, short", Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(7)])],
      ] as const) {
        await d.fails(`WithdrawFunds ${tag}: ${label}`, payer, [withData(wd, Buffer.concat([u8(12), params]))], BORSH);
      }
    });

    it("fails where the tokens are not there", async () => {
      const t = await d.seated(m, BASE, 1000n, `${tag} poor`);
      await d.fails(`DepositFunds ${tag}: more quote than held`, payer, [ix.depositFunds(m, t, 1001n, 0n)], custom(1));
      await d.fails(`DepositFunds ${tag}: more base than held`, payer, [ix.depositFunds(m, t, 0n, 2n)], custom(1));
      await d.ok(`DepositFunds ${tag}: what is held`, payer, [ix.depositFunds(m, t, 1000n, 1n)]);
      // Free lots the vault does not hold (written into the trader's state).
      const at = traderStateAt(d, m, t.key.address);
      d.patch(m.market, (b) => b.writeBigUInt64LE(10n ** 15n, at + TS.quoteFree));
      await d.fails(`WithdrawFunds ${tag}: more than the vault holds`, payer, [ix.withdrawFunds(m, t)], custom(1));
    });

    it("panics on overflows as quantities.rs's operators do", async () => {
      const t = await d.seated(coarse, 10n ** 18n, 10n ** 18n, `${tag} overflow`);
      await d.ok(`DepositFunds ${tag}: coarse lots`, payer, [ix.depositFunds(coarse, t, 2n, 1n)]);
      // DepositFunds: QuoteLots + QuoteLots, BaseLots + BaseLots, then lots × lot size.
      await d.fails(`DepositFunds ${tag}: quote lots overflow (u64::MAX)`, payer, [ix.depositFunds(coarse, t, U64_MAX, 0n)], PANICKED);
      await d.fails(`DepositFunds ${tag}: base lots overflow (u64::MAX)`, payer, [ix.depositFunds(coarse, t, 0n, U64_MAX)], PANICKED);
      await d.fails(`DepositFunds ${tag}: base lots overflow first`, payer, [ix.depositFunds(coarse, t, U64_MAX, U64_MAX)], PANICKED);
      await d.fails(`DepositFunds ${tag}: quote atoms overflow`, payer, [ix.depositFunds(coarse, t, 1n << 60n, 0n)], PANICKED);
      await d.fails(`DepositFunds ${tag}: base atoms overflow`, payer, [ix.depositFunds(coarse, t, 0n, 1n << 50n)], PANICKED);
      // WithdrawFunds: lots × lot size.
      const at = traderStateAt(d, coarse, t.key.address);
      const save = d.data(coarse.market);
      d.patch(coarse.market, (b) => b.writeBigUInt64LE(1n << 60n, at + TS.quoteFree));
      await d.fails(`WithdrawFunds ${tag}: quote atoms overflow`, payer, [ix.withdrawFunds(coarse, t)], PANICKED);
      d.patch(coarse.market, (b) => save.copy(b));
      d.patch(coarse.market, (b) => b.writeBigUInt64LE(1n << 50n, at + TS.baseFree));
      await d.fails(`WithdrawFunds ${tag}: base atoms overflow`, payer, [ix.withdrawFunds(coarse, t, 0n, null)], PANICKED);
      d.patch(coarse.market, (b) => save.copy(b));
      await d.ok(`WithdrawFunds ${tag}: coarse lots`, payer, [ix.withdrawFunds(coarse, t)]);
    });
  });
}

describe("fees", () => {
  let d: Diff;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await diff();
    payer = await d.funded();
  });

  /** A market whose fees go to `collector`, the collector's quote account, and `fees` quote lots accrued (the vault holding them). */
  async function withFees(o: { bids?: number; seats?: number; quoteDecimals?: number; quoteLotsPerQuoteUnit?: bigint; label: string }) {
    const collector = await d.funded();
    const m = await d.market({
      bids: o.bids,
      seats: o.seats,
      quoteDecimals: o.quoteDecimals,
      params: { feeCollector: collector.address, quoteLotsPerQuoteUnit: o.quoteLotsPerQuoteUnit, tickSizeInQuoteLotsPerBaseUnit: 1000n },
      label: `InitializeMarket (${o.label})`,
    });
    const account = await d.tokenAccount(m.quoteMint, collector.address);
    const accrue = (lots: bigint, vaultAtoms: bigint) => {
      d.patch(m.market, (b) => b.writeBigUInt64LE(lots, OFF.unclaimedFees));
      d.patch(m.quoteVault, (b) => b.writeBigUInt64LE(vaultAtoms, 64));
    };
    return { m, collector, account, accrue };
  }

  it("collects fees (anyone may) and formats the amount", async () => {
    for (const [bids, seats] of [
      [512, 128],
      [4096, 8321],
    ] as const) {
      const { m, account, accrue } = await withFees({ bids, seats, label: `fees ${bids}/${seats}` });
      const sweeper = await d.funded();
      await d.ok(`CollectFees ${bids}/${seats}: nothing accrued`, payer, [ix.collectFees(m, sweeper, account)]);
      for (const lots of [1_234_567n, 1_500_000n, 5n, 1_000_000n, 10n, 999_999_999_999n]) {
        accrue(lots, lots);
        await d.ok(`CollectFees ${bids}/${seats}: ${lots} quote lots`, payer, [ix.collectFees(m, sweeper, account)]);
      }
    }
    for (const [decimals, lotsPerUnit] of [
      [0, 1n],
      [9, 1_000_000_000n],
      [19, 10n ** 19n],
      [2, 100n],
    ] as const) {
      const { m, account, accrue } = await withFees({ quoteDecimals: decimals, quoteLotsPerQuoteUnit: lotsPerUnit, label: `fees, ${decimals} decimals` });
      for (const lots of [0n, 7n, 120n, 10n ** 18n + 3n]) {
        accrue(lots, lots);
        await d.ok(`CollectFees: ${decimals} decimals, ${lots} lots`, payer, [ix.collectFees(m, payer, account)]);
      }
    }
    // Quote lots of 1000 atoms: the amount is in atoms.
    const coarse = await withFees({ quoteLotsPerQuoteUnit: 1000n, label: "fees, coarse lots" });
    coarse.accrue(1234n, 1_234_000n);
    await d.ok("CollectFees: coarse lots", payer, [ix.collectFees(coarse.m, payer, coarse.account)]);
  });

  it("checks its accounts", async () => {
    const { m, collector, account, accrue } = await withFees({ label: "fee checks" });
    accrue(10n, 10n);
    const c = ix.collectFees(m, payer, account);
    for (let n = 4; n < 7; n++) await d.fails(`CollectFees: ${n} accounts`, payer, [truncate(c, n)], builtin("NotEnoughAccountKeys"));
    const notCollectors = await d.tokenAccount(m.quoteMint, payer.address);
    await d.fails("CollectFees: not the fee recipient's account", payer, [replace(c, 4, notCollectors)], builtin("IllegalOwner"));
    const baseAccount = await d.tokenAccount(m.baseMint, collector.address);
    await d.fails("CollectFees: an account of the base mint", payer, [replace(c, 4, baseAccount)], builtin("InvalidAccountData"));
    await d.fails("CollectFees: not the quote vault", payer, [replace(c, 5, m.baseVault)], builtin("InvalidInstructionData"));
    await d.fails("CollectFees: not SPL Token", payer, [replace(c, 6, SYSTEM)], builtin("IncorrectProgramId"));
    accrue(10n, 9n);
    await d.fails("CollectFees: the vault short of the fees", payer, [c], custom(1));
  });

  it("panics on overflows", async () => {
    const { m, account, accrue } = await withFees({ quoteLotsPerQuoteUnit: 1000n, label: "fee overflows" });
    accrue(1n, 1000n);
    d.patch(m.market, (b) => b.writeBigUInt64LE(U64_MAX, OFF.collectedFees));
    await d.fails("CollectFees: collected fees overflow", payer, [ix.collectFees(m, payer, account)], PANICKED);
    d.patch(m.market, (b) => b.writeBigUInt64LE(0n, OFF.collectedFees));
    accrue(1n << 60n, 0n);
    await d.fails("CollectFees: atoms overflow", payer, [ix.collectFees(m, payer, account)], PANICKED);
  });

  it("changes the fee recipient, with the current one signing while fees are uncollected", async () => {
    const { m, collector, accrue } = await withFees({ label: "fee recipient" });
    const next = (await generateKeyPairSigner()).address;
    const stranger = await d.funded();
    await d.fails("ChangeFeeRecipient: not the authority", payer, [ix.changeFeeRecipient(m, next, undefined, stranger)], custom(E.InvalidMarketAuthority!));
    await d.fails("ChangeFeeRecipient: no new recipient", payer, [truncate(ix.changeFeeRecipient(m, next), 4)], builtin("NotEnoughAccountKeys"));
    accrue(3n, 3n);
    await d.fails("ChangeFeeRecipient: fees, no current recipient", payer, [ix.changeFeeRecipient(m, next)], builtin("MissingRequiredSignature"));
    const notSigning = accounts(ix.changeFeeRecipient(m, next), (l) => l.push({ address: collector.address, role: AccountRole.READONLY }));
    await d.fails("ChangeFeeRecipient: fees, current recipient not signing", payer, [notSigning], builtin("MissingRequiredSignature"));
    await d.fails("ChangeFeeRecipient: fees, another signer", payer, [ix.changeFeeRecipient(m, next, stranger)], builtin("MissingRequiredSignature"));
    await d.ok("ChangeFeeRecipient: fees, current recipient signing", payer, [ix.changeFeeRecipient(m, next, collector)]);
    accrue(0n, 0n);
    // Without fees the current recipient is not needed; one that is passed wrongly is logged and ignored.
    await d.ok("ChangeFeeRecipient: no fees", payer, [ix.changeFeeRecipient(m, collector.address)]);
    await d.ok("ChangeFeeRecipient: no fees, current recipient not signing", payer, [notSigning]);
    await d.ok("ChangeFeeRecipient: no fees, another signer", payer, [ix.changeFeeRecipient(m, next, stranger)]);
  });
});
