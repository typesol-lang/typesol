// The world the mutation fuzzers of showcase/mainnet/percolator share (percolator-mutate-*.test.ts): markets in eight
// states built through `Diff.both` against Percolator v12.20 as deployed on mainnet (test/programs/percolator_v12.so),
// a valid transaction of each of the 27 instructions in each state, the accounts a mutation can put in their place, a
// snapshot of every account the world made (restored after each mutated transaction, in both VMs, so that every
// mutation starts from the same state), the comparison made soft (every divergence recorded, the test failing at its
// end with the list) and the tally of outcomes.
//
// Every keypair comes from the seed (a run is reproduced by it), and every account the world makes is at a keypair's
// address, so any of them can sign: the slab, a token account, the vault.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { appendFileSync } from "node:fs";
import { expect } from "vitest";
import { send } from "../../test/harness.js";
import { Rng } from "./fuzz-rng.js";
import {
  CHAINLINK,
  C,
  CLOCK,
  Diff,
  E,
  type InitMarketArgs,
  type Lp,
  MATCHER,
  MATCHER_CTX_LEN,
  type Market,
  PROGRAM,
  PYTH_RECEIVER,
  RENT,
  ROGUE,
  SLAB_LEN,
  SOL,
  SYSTEM,
  TOKEN,
  type Result,
  type User,
  computeUnits,
  defaultInitArgs,
  ix,
  key,
  lpPda,
  meta,
  outcome,
  passiveMatcher,
  pythBytes,
  tokenAccountBytes,
  writeU128,
} from "./percolator-helpers.js";

export const SLOT_HASHES = address("SysvarS1otHashes111111111111111111111111111");
export const INSTRUCTIONS = address("Sysvar1nstructions1111111111111111111111111");
export const EPOCH_SCHEDULE = address("SysvarEpochSchedu1e111111111111111111111111");
export const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");

/** The size knob of every mutation fuzzer: PERCOLATOR_MUTATE_SCALE=<n> runs n times the default (1). */
export const SCALE = Number(process.env.PERCOLATOR_MUTATE_SCALE ?? 1);
export const SEED = BigInt(process.env.PERCOLATOR_MUTATE_SEED ?? 1);

export type OracleKind = "pyth" | "chainlink" | "inverted" | "hyperp";

/** A market in one state, with the accounts the base transactions name. */
export type Shape = "empty" | "funded" | "positions" | "reset" | "resolved" | "resolved-empty" | "resolved-bare" | "stale";

export interface State {
  name: string;
  kind: OracleKind;
  m: Market;
  args: InitMarketArgs;
  price: bigint;
  alice: User;
  bob: User;
  lpOwner: User;
  dust: User;
  lp: Lp;
  idx: { alice: number; bob: number; lp: number; dust: number };
  adminAta: Address;
  /** An uninitialized slab with its own vault, mint and oracle, for InitMarket. */
  spare: Market;
  spareArgs: InitMarketArgs;
  newAuthority: KeyPairSigner;
}

/** One instruction's valid transaction in a state. */
export interface Base {
  tag: number;
  name: string;
  /** The fee payer is the world's payer unless the base names another. */
  ixs: Instruction[];
  /** The Percolator instruction's index in `ixs`. */
  at: number;
}

export const NAMES: Record<number, string> = {
  0: "InitMarket",
  1: "InitUser",
  2: "InitLP",
  3: "DepositCollateral",
  4: "WithdrawCollateral",
  5: "KeeperCrank",
  6: "TradeNoCpi",
  7: "LiquidateAtOracle",
  8: "CloseAccount",
  9: "TopUpInsurance",
  10: "TradeCpi",
  13: "CloseSlab",
  14: "UpdateConfig",
  17: "PushHyperpMark",
  18: "SetOraclePriceCap",
  19: "ResolveMarket",
  20: "WithdrawInsurance",
  21: "AdminForceCloseAccount",
  23: "WithdrawInsuranceLimited",
  25: "ReclaimEmptyAccount",
  26: "SettleAccount",
  27: "DepositFeeCredits",
  28: "ConvertReleasedPnl",
  29: "ResolvePermissionless",
  30: "ForceCloseResolved",
  31: "CatchupAccrue",
  32: "UpdateAuthority",
};
export const TAGS = Object.keys(NAMES).map(Number);

/** The base transaction of each instruction in a state (each one valid where the state allows it). */
export function bases(s: State): Base[] {
  const { m, alice, bob, lpOwner, lp, idx } = s;
  const one = (tag: number, i: Instruction, cu = false): Base => ({ tag, name: NAMES[tag]!, ixs: cu ? [computeUnits(1_400_000), i] : [i], at: cu ? 1 : 0 });
  return [
    one(0, ix.initMarket(s.spare, s.spareArgs), true),
    one(1, ix.initUser(m, alice, SOL)),
    one(2, ix.initLp(m, lpOwner, MATCHER, lp.ctx, SOL)),
    one(3, ix.deposit(m, alice, idx.alice, SOL)),
    one(4, ix.withdraw(m, alice, idx.alice, 1000n)),
    one(
      5,
      ix.crank(m, alice.key, idx.alice, [
        [idx.bob, 0xff],
        [idx.alice, 0],
      ]),
      true,
    ),
    one(6, ix.tradeNoCpi(m, alice.key, bob.key, idx.bob, idx.alice, 1_000_000n)),
    one(7, ix.liquidate(m, alice.key, idx.bob)),
    one(8, ix.closeAccount(m, alice, idx.alice)),
    one(9, ix.topUpInsurance(m, alice, SOL)),
    one(10, ix.tradeCpi(m, alice.key, lpOwner.key.address, lp, idx.alice, 1_000_000n)),
    one(13, ix.closeSlab(m, s.adminAta)),
    one(14, ix.updateConfig(m, m.admin, { horizon: 500n, kBps: 100n, maxPremiumBps: 500n, maxE9PerSlot: 1000n, tvlCapMult: 0 })),
    one(17, ix.pushHyperpMark(m, m.admin, s.price + 1000n, 0n)),
    one(18, ix.setOraclePriceCap(m, m.admin, 5_000n)),
    one(19, ix.resolveMarket(m, m.admin)),
    one(20, ix.withdrawInsurance(m, m.admin, s.adminAta)),
    one(21, ix.adminForceCloseAccount(m, m.admin, idx.bob, bob.ata)),
    one(23, ix.withdrawInsuranceLimited(m, m.admin, s.adminAta, 1000n)),
    one(25, ix.reclaimEmptyAccount(m, idx.dust)),
    one(26, ix.settleAccount(m, idx.alice)),
    one(27, ix.depositFeeCredits(m, s.dust, idx.dust, 10n)),
    one(28, ix.convertReleasedPnl(m, alice, idx.alice, 1000n)),
    one(29, ix.resolvePermissionless(m)),
    one(30, ix.forceCloseResolved(m, idx.bob, bob.ata)),
    one(31, ix.catchupAccrue(m)),
    one(32, ix.updateAuthority(m, m.admin, 0, s.newAuthority.address, s.newAuthority)),
  ];
}

// ---- Outcomes ----------------------------------------------------------------------------------------------------------

export interface Count {
  tried: number;
  bothFail: number;
  bothOk: number;
  diverged: number;
  pinned: number;
  unsendable: number;
}
const zero = (): Count => ({ tried: 0, bothFail: 0, bothOk: 0, diverged: 0, pinned: 0, unsendable: 0 });

export class Tally {
  readonly by = new Map<string, Count>();
  readonly divergences: string[] = [];
  /** Transactions the original could not finish within the limit set and the port could (the compute-unit tests). */
  readonly exceptions: string[] = [];
  /** The first error text of each distinct divergence (by the label's mutation kind and instruction). */
  add(category: string, name: string, what: keyof Count): void {
    const k = `${category} | ${name}`;
    const c = this.by.get(k) ?? zero();
    c[what]++;
    this.by.set(k, c);
  }
  table(): Record<string, Count> {
    return Object.fromEntries([...this.by.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
  totals(): Record<string, Count> {
    const out: Record<string, Count> = {};
    for (const [k, c] of this.by) {
      const cat = k.split(" | ")[0]!;
      const t = (out[cat] ??= zero());
      for (const f of Object.keys(c) as (keyof Count)[]) t[f] += c[f];
    }
    return out;
  }
  print(title: string): void {
    if (process.env.PERCOLATOR_MUTATE_VERBOSE) console.table(this.table());
    console.log(`${title}: totals by category`);
    console.table(this.totals());
  }
}

/**
 * A difference the README documents and a test pins (the only one this classifier accepts): a free-list index past the
 * 4,096 slots, where the original panics with Rust's bounds-check message and the port fails TypeSOL's bounds check
 * (5104). Both must fail and leave every account as it was (the caller compares the bytes).
 */
export function pinnedFreelist(a: Result, b: Result): boolean {
  return (
    outcome(a).includes("ProgramFailedToComplete") &&
    meta(a)
      .logs()
      .some((l) => /index out of bounds: the len is 4096 but the index is \d+/.test(l)) &&
    outcome(b).includes("InstructionErrorCustom { code: 5104 }") &&
    meta(b)
      .logs()
      .some((l) => l.includes("TypeSOL: array index out of bounds"))
  );
}

// ---- The world ---------------------------------------------------------------------------------------------------------

interface Snap {
  lamports: bigint;
  owner: Address;
  data: Uint8Array;
  executable: boolean;
}

export class World {
  readonly states: State[] = [];
  readonly snap = new Map<Address, Snap>();
  payer!: KeyPairSigner;
  /** Accounts a replacement can name, beyond the state's own (filled by `build`). */
  extra: { label: string; address: Address }[] = [];
  slot = 0n;
  unixTimestamp = 0n;
  private constructor(
    readonly d: Diff,
    readonly rng: Rng,
    /** Every keypair the world made, by address. */
    readonly signers: Map<Address, KeyPairSigner>,
    /** A fresh keypair (from the seed) with no account. */
    readonly key: () => Promise<KeyPairSigner>,
  ) {}

  static async create(seed: bigint): Promise<World> {
    const keys = new Rng(seed ^ 0x6b657973n);
    const signers = new Map<Address, KeyPairSigner>();
    const gen = async () => {
      const k = await createKeyPairSignerFromPrivateKeyBytes(keys.bytes(32));
      signers.set(k.address, k);
      return k;
    };
    return new World(await Diff.create(gen), new Rng(seed), signers, gen);
  }

  /** Publish the state's price at the Clock's timestamp (Pyth at expo -6, Chainlink with 8 decimals). */
  quote(kind: OracleKind, oracle: Address, feedId: Buffer, price: bigint, when = this.d.unixTimestamp): void {
    if (kind === "hyperp") return;
    if (kind === "chainlink") {
      const b = Buffer.alloc(232);
      b[138] = 8;
      b.writeBigUInt64LE(when, 208);
      writeU128(b, 216, price * 100n);
      this.d.write(oracle, CHAINLINK, b);
    } else this.d.write(oracle, PYTH_RECEIVER, pythBytes({ feedId, price, expo: -6, publishTime: when }));
  }

  private edit(kind: OracleKind, a: InitMarketArgs): void {
    a.maintenanceFeePerSlot = 1n;
    a.hMin = 1n;
    a.hMax = 50n;
    a.tradingFeeBps = 10n;
    a.tail!.insuranceWithdrawMaxBps = 1000;
    a.tail!.insuranceWithdrawCooldownSlots = 1n;
    if (kind === "inverted") a.invert = 1;
    if (kind === "hyperp") {
      a.feedId = Buffer.alloc(32);
      a.initialMarkPriceE6 = 1_000_000n;
      a.tail!.markMinFee = 10n;
    }
  }

  /** An uninitialized market of a kind (its oracle written), and InitMarket's arguments for it. */
  private async spare(kind: OracleKind, price: bigint): Promise<[Market, InitMarketArgs]> {
    const slab = await this.key();
    const m = await this.d.newMarket({ price, slab });
    const args = defaultInitArgs(m.admin.address, m.mint);
    this.edit(kind, args);
    if (kind === "chainlink") {
      args.feedId = key(m.oracle);
      m.feedId = args.feedId;
    }
    this.quote(kind, m.oracle, m.feedId, price);
    return [m, args];
  }

  private async user(m: Market, deposit: bigint, label: string): Promise<[User, number]> {
    const u = await this.d.user(m, 1_000_000n * SOL);
    const idx = this.d.freeHead(m);
    if (deposit >= 0n) await this.d.ok(`${label}: InitUser`, u.key, [ix.initUser(m, u, deposit)]);
    return [u, idx];
  }

  /** One state: a market of `kind`, initialized, then `shape` (accounts, positions, resolution). */
  async state(name: string, kind: OracleKind, shape: Shape): Promise<State> {
    const d = this.d;
    const price = kind === "inverted" ? 2_000_000n : kind === "hyperp" ? 1_000_000n : 100_000_000n;
    const [m, args] = await this.spare(kind, price);
    await d.ok(`${name}: InitMarket`, m.admin, [computeUnits(1_400_000), ix.initMarket(m, args)]);
    const [spare, spareArgs] = await this.spare(kind, price);
    const adminAta = await d.tokenAccount(m.mint, m.admin.address);
    const newAuthority = await d.funded(1n);
    const s: State = {
      name,
      kind,
      m,
      args,
      price,
      spare,
      spareArgs,
      adminAta,
      newAuthority,
      alice: undefined!,
      bob: undefined!,
      lpOwner: undefined!,
      dust: undefined!,
      lp: undefined!,
      idx: { alice: 0, bob: 1, lp: 2, dust: 3 },
    };
    if (shape === "empty" || shape === "resolved-empty" || shape === "resolved-bare") {
      s.alice = await d.user(m, 1_000_000n * SOL);
      s.bob = await d.user(m, 1_000_000n * SOL);
      s.lpOwner = await d.user(m, 1_000_000n * SOL);
      s.dust = await d.user(m, 1_000_000n * SOL);
      const ctx = await this.key();
      d.write(ctx.address, MATCHER, Buffer.alloc(MATCHER_CTX_LEN));
      s.lp = { idx: 2, matcher: MATCHER, ctx: ctx.address, pda: await lpPda(m, 2) };
      // No accounts, insurance only (WithdrawInsurance's state) or nothing at all (CloseSlab's).
      if (shape === "resolved-empty") await d.ok(`${name}: TopUpInsurance`, s.alice.key, [ix.topUpInsurance(m, s.alice, 3n * SOL)]);
      if (shape !== "empty") await d.ok(`${name}: ResolveMarket`, m.admin, [ix.resolveMarket(m, m.admin)]);
      return this.done(s);
    }
    if (shape === "reset") {
      // percolator-accounts.test.ts "losses past capital": a long bankrupt past insurance, the loss socialised over the
      // shorts, the last long liquidated: the short side resets (reset-pending, alice's and the LP's shorts stale).
      [s.alice, s.idx.alice] = await this.user(m, 2n * SOL, name);
      [s.bob, s.idx.bob] = await this.user(m, 2n * SOL, name);
      const ins = await d.user(m);
      await d.ok(`${name}: TopUpInsurance`, ins.key, [ix.topUpInsurance(m, ins, SOL)]);
      const [plain, plainIdx] = await this.user(m, 200n * SOL, name);
      const [x, xIdx] = await this.user(m, 10n * SOL, name);
      await d.ok(`${name}: TradeNoCpi x long`, x.key, [ix.tradeNoCpi(m, x.key, plain.key, plainIdx, xIdx, 900_000_000n)]);
      d.setClock(d.slot + 2n);
      this.quote(kind, m.oracle, m.feedId, 70_000_000n);
      await d.ok(`${name}: TradeNoCpi bob long`, s.bob.key, [ix.tradeNoCpi(m, s.bob.key, s.alice.key, s.idx.alice, s.idx.bob, 200_000_000n)]);
      await d.ok(`${name}: LiquidateAtOracle x`, s.bob.key, [ix.liquidate(m, s.bob.key, xIdx)]);
      d.setClock(d.slot + 2n);
      this.quote(kind, m.oracle, m.feedId, 63_000_000n);
      await d.ok(`${name}: LiquidateAtOracle bob`, s.bob.key, [ix.liquidate(m, s.bob.key, s.idx.bob)]);
      s.price = 63_000_000n;
      s.dust = x;
      s.idx.dust = xIdx;
      [s.lpOwner] = await this.user(m, -1n, name);
      s.lp = await d.lp(m, s.lpOwner, 100n * SOL, passiveMatcher(), `${name}: LP`);
      s.idx.lp = s.lp.idx;
      if (d.data(m.slab)[E.sideModeShort] !== 2) throw new Error(`${name}: the short side is not reset-pending`);
      return this.done(s);
    }
    [s.alice, s.idx.alice] = await this.user(m, 50n * SOL, name);
    [s.bob, s.idx.bob] = await this.user(m, 50n * SOL, name);
    s.lpOwner = await d.user(m, 1_000_000n * SOL);
    s.lp = await d.lp(m, s.lpOwner, 100n * SOL, passiveMatcher(), `${name}: LP`);
    s.idx.lp = s.lp.idx;
    // One unit of capital: the maintenance fee (1 per slot) drains it before the snapshot (ReclaimEmptyAccount).
    [s.dust, s.idx.dust] = await this.user(m, 1n, name);
    const ins = await d.user(m);
    await d.ok(`${name}: TopUpInsurance`, ins.key, [ix.topUpInsurance(m, ins, 10n * SOL)]);
    if (shape === "positions" || shape === "resolved") {
      if (kind === "hyperp") {
        await d.ok(`${name}: TradeCpi alice`, s.alice.key, [ix.tradeCpi(m, s.alice.key, s.lpOwner.key.address, s.lp, s.idx.alice, 20_000_000n)]);
        await d.ok(`${name}: TradeCpi bob`, s.bob.key, [ix.tradeCpi(m, s.bob.key, s.lpOwner.key.address, s.lp, s.idx.bob, -10_000_000n)]);
      } else {
        await d.ok(`${name}: TradeNoCpi`, s.alice.key, [ix.tradeNoCpi(m, s.alice.key, s.bob.key, s.idx.bob, s.idx.alice, 20_000_000n)]);
        await d.ok(`${name}: TradeCpi`, s.alice.key, [ix.tradeCpi(m, s.alice.key, s.lpOwner.key.address, s.lp, s.idx.alice, 5_000_000n)]);
      }
      d.setClock(d.slot + 3n);
      s.price = (s.price * 103n) / 100n;
      this.quote(kind, m.oracle, m.feedId, s.price);
      // Alice's profit admitted to warm-up now, released by the snapshot (ConvertReleasedPnl).
      await d.ok(`${name}: SettleAccount alice`, s.alice.key, [ix.settleAccount(m, s.idx.alice)]);
    }
    if (shape === "stale")
      // No oracle reading for 6,000 slots (past permissionless_resolve_stale_slots, 5,000): the market's matured
      // staleness, as waiting would leave it (the shared Clock does not wait).
      d.patch(m.slab, (b) => b.writeBigUInt64LE(d.slot - 6000n, C.lastGoodOracleSlot));
    if (shape === "resolved") await d.ok(`${name}: ResolveMarket`, m.admin, [ix.resolveMarket(m, m.admin)]);
    return this.done(s);
  }

  private done(s: State): State {
    this.states.push(s);
    return s;
  }

  /** The states, then a common Clock with every oracle fresh at it, then the snapshot. */
  async build(only?: string[]): Promise<void> {
    const d = this.d;
    this.payer = await d.funded(100_000n);
    const all: [string, OracleKind, Parameters<World["state"]>[2]][] = [
      ["empty", "pyth", "empty"],
      ["funded", "pyth", "funded"],
      ["positions", "pyth", "positions"],
      ["reset-pending", "pyth", "reset"],
      ["resolved", "pyth", "resolved"],
      ["resolved-empty", "pyth", "resolved-empty"],
      ["resolved-bare", "pyth", "resolved-bare"],
      ["stale", "pyth", "stale"],
      ["hyperp", "hyperp", "positions"],
      ["chainlink", "chainlink", "positions"],
      ["inverted", "inverted", "positions"],
    ];
    for (const [name, kind, shape] of all) if (!only || only.includes(name)) await this.state(name, kind, shape);
    // Past the force-close delay (100 slots) of the resolved markets; the one-unit accounts drained by the fee.
    d.setClock(d.slot + 150n);
    this.slot = d.slot;
    this.unixTimestamp = d.unixTimestamp;
    for (const s of this.states) {
      this.quote(s.kind, s.m.oracle, s.m.feedId, s.price);
      this.quote(s.kind, s.spare.oracle, s.spare.feedId, s.price);
    }
    // Accounts a replacement can name beyond the states' own.
    const s0 = this.states[0]!;
    const otherMint = await d.mint();
    const misc = await this.key();
    d.write(misc.address, TOKEN, tokenAccountBytes({ mint: otherMint, owner: s0.alice.key.address, amount: SOL }));
    const funded = await d.funded(5n);
    const short = await this.key();
    d.write(short.address, PROGRAM, Buffer.alloc(SLAB_LEN - 1));
    const long = await this.key();
    d.write(long.address, PROGRAM, Buffer.alloc(SLAB_LEN + 1));
    const zeroed = await this.key();
    d.write(zeroed.address, PROGRAM, Buffer.alloc(SLAB_LEN));
    const tiny = await this.key();
    d.write(tiny.address, PROGRAM, Buffer.alloc(8));
    const chainlink = await this.key();
    const cl = Buffer.alloc(232);
    cl[138] = 8;
    cl.writeBigUInt64LE(this.unixTimestamp, 208);
    writeU128(cl, 216, 10_000_000_000n);
    d.write(chainlink.address, CHAINLINK, cl);
    const otherFeed = await d.pyth({ feedId: Buffer.alloc(32, 7), price: 100_000_000n, expo: -6, publishTime: this.unixTimestamp });
    this.extra = [
      { label: "a token account of another mint", address: misc.address },
      { label: "the other mint", address: otherMint },
      { label: "a funded system account", address: funded.address },
      { label: "a program-owned account one byte short", address: short.address },
      { label: "a program-owned account one byte long", address: long.address },
      { label: "a zeroed slab", address: zeroed.address },
      { label: "an 8-byte program account", address: tiny.address },
      { label: "a Chainlink account", address: chainlink.address },
      { label: "a Pyth account of another feed", address: otherFeed },
      { label: "the clock", address: CLOCK },
      { label: "rent", address: RENT },
      { label: "slot hashes", address: SLOT_HASHES },
      { label: "the instructions sysvar", address: INSTRUCTIONS },
      { label: "epoch schedule", address: EPOCH_SCHEDULE },
      { label: "the token program", address: TOKEN },
      { label: "the system program", address: SYSTEM },
      { label: "the program", address: PROGRAM },
      { label: "the matcher", address: MATCHER },
      { label: "the rogue matcher", address: ROGUE },
      { label: "compute budget", address: COMPUTE_BUDGET },
      { label: "the payer", address: this.payer.address },
    ];
    this.snapshot();
  }

  /** Every non-executable account the world made, as it is now (both VMs agree: every step was compared). */
  snapshot(): void {
    this.snap.clear();
    for (const a of this.signers.keys()) {
      const acct = this.d.original.getAccount(a);
      if (!acct.exists || acct.executable) continue;
      this.snap.set(a, { lamports: BigInt(acct.lamports), owner: acct.programAddress, data: new Uint8Array(acct.data), executable: false });
    }
  }

  /** Put the named accounts back as the snapshot has them, in both VMs, and the Clock where the world set it. */
  restore(addresses: Iterable<Address>): void {
    for (const a of addresses) {
      const s = this.snap.get(a);
      if (!s) continue;
      for (const vm of this.d.vms)
        vm.setAccount({ address: a, data: s.data, executable: false, lamports: s.lamports as never, programAddress: s.owner, space: BigInt(s.data.length) });
    }
    if (this.d.slot !== this.slot || this.d.unixTimestamp !== this.unixTimestamp) this.d.setClock(this.slot, this.unixTimestamp);
  }

  /** Every account of a state a replacement can name, with a label, and the world's other accounts. */
  pool(s: State): { label: string; address: Address }[] {
    const other = this.states.find((o) => o !== s) ?? s;
    return [
      { label: "the slab", address: s.m.slab },
      { label: "another market's slab", address: other.m.slab },
      { label: "the spare (uninitialized) slab", address: s.spare.slab },
      { label: "the vault", address: s.m.vault },
      { label: "another market's vault", address: other.m.vault },
      { label: "the vault authority", address: s.m.vaultPda },
      { label: "alice's token account", address: s.alice.ata },
      { label: "bob's token account", address: s.bob.ata },
      { label: "the LP owner's token account", address: s.lpOwner.ata },
      { label: "the admin's token account", address: s.adminAta },
      { label: "a token account of another market's mint", address: other.alice.ata },
      { label: "alice", address: s.alice.key.address },
      { label: "bob", address: s.bob.key.address },
      { label: "the LP owner", address: s.lpOwner.key.address },
      { label: "the admin", address: s.m.admin.address },
      { label: "the new authority", address: s.newAuthority.address },
      { label: "the mint", address: s.m.mint },
      { label: "the oracle", address: s.m.oracle },
      { label: "another market's oracle", address: other.m.oracle },
      { label: "the matcher context", address: s.lp.ctx },
      { label: "the LP PDA", address: s.lp.pda },
      ...this.extra,
    ];
  }
}

// ---- Sending and comparing ---------------------------------------------------------------------------------------------

/** The roles with and without the signer and writable bits. */
export const isSigner = (r: AccountRole) => r === AccountRole.READONLY_SIGNER || r === AccountRole.WRITABLE_SIGNER;
export const isWritable = (r: AccountRole) => r === AccountRole.WRITABLE || r === AccountRole.WRITABLE_SIGNER;
export const role = (signer: boolean, writable: boolean) =>
  signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : writable ? AccountRole.WRITABLE : AccountRole.READONLY;

export type AccountEntry = { address: Address; role: AccountRole; signer?: KeyPairSigner };

/** The account entries with each signer's keypair attached (from the world's keys), or null when one cannot sign. */
export function withSigners(w: World, list: AccountEntry[]): AccountEntry[] | null {
  const out: AccountEntry[] = [];
  for (const e of list) {
    if (isSigner(e.role)) {
      const k = e.address === w.payer.address ? w.payer : w.signers.get(e.address);
      if (!k) return null;
      out.push({ address: e.address, role: e.role, signer: k });
    } else out.push({ address: e.address, role: e.role });
  }
  return out;
}

/**
 * Send `ixs` to both VMs with the world's payer, compare as `both()` does, and count the outcome under `category` and
 * `name`; a divergence is recorded with its label (the test fails at its end with every one). Every account the
 * transaction names is put back as the snapshot has it afterwards. Returns the original's outcome, or null when the
 * transaction could not be built or sent (counted as unsendable).
 */
export async function trial(
  w: World,
  t: Tally,
  category: string,
  name: string,
  label: string,
  ixs: Instruction[],
  o: {
    payer?: KeyPairSigner;
    restore?: boolean;
    pinned?: (a: Result, b: Result) => boolean;
    /**
     * A compute-unit limit was set low: where either side runs out, the two only have to agree that the transaction
     * failed and on every account's bytes (each side stops at a different point, so the logs and inner
     * instructions up to there may differ). The one exception, counted as pinned: the original runs out and the port,
     * which needs fewer units, finishes.
     */
    budget?: boolean;
  } = {},
): Promise<string | null> {
  const d = w.d;
  const payer = o.payer ?? w.payer;
  const named = new Set<Address>([payer.address]);
  for (const i of ixs) for (const m of i.accounts ?? []) named.add(m.address);
  t.add(category, name, "tried");
  let a: Result;
  let b: Result;
  try {
    a = await send(d.original, payer, ixs);
    b = await send(d.port, payer, ixs);
  } catch {
    t.add(category, name, "unsendable");
    if (o.restore !== false) w.restore(named);
    return null;
  }
  let res: string | null = outcome(a);
  try {
    const out = (r: Result) => (failed(r) ? String((r as FailedTransactionMetadata).err()) : "ok");
    const exhausted = (r: Result) =>
      out(r).includes("ComputationalBudgetExceeded") ||
      meta(r)
        .logs()
        .some((l) => l.includes("exceeded CUs meter"));
    if (o.budget && (exhausted(a) || exhausted(b))) {
      if (exhausted(a) && !failed(b)) {
        t.exceptions.push(`${label}: the original ran out (${meta(a).computeUnitsConsumed()} units), the port finished in ${meta(b).computeUnitsConsumed()}`);
        t.add(category, name, "pinned");
      } else {
        expect(
          failed(b) && failed(a),
          `${label}: one side ran out of compute units and the other succeeded\noriginal: ${outcome(a)}\nport: ${outcome(b)}`,
        ).toBe(true);
        for (const at of named) if (at !== CLOCK && at !== RENT && !executableAt(d, at)) d.expectSame(at, `${label}: ${at}`);
        t.add(category, name, "bothFail");
      }
    } else if (o.pinned?.(a, b) || pinnedFreelist(a, b)) {
      // A pinned difference: the outcome and logs differ by design; the accounts must not.
      for (const at of named) if (at !== CLOCK && at !== RENT && !executableAt(d, at)) d.expectSame(at, `${label}: ${at}`);
      t.add(category, name, "pinned");
    } else {
      d.compare(label, payer, ixs, a, b);
      t.add(category, name, res === "ok" ? "bothOk" : "bothFail");
    }
  } catch (e) {
    t.add(category, name, "diverged");
    const msg = String((e as Error).message ?? e)
      .split("\n")
      .slice(0, 60)
      .join("\n");
    t.divergences.push(`${category} | ${label}\n  original: ${outcome(a)}\n  port:     ${outcome(b)}\n${msg}`);
    // PERCOLATOR_MUTATE_DUMP=<file>: one line per divergence (for minimising), appended.
    if (process.env.PERCOLATOR_MUTATE_DUMP) {
      const why = (r: Result) =>
        meta(r)
          .logs()
          .find((l) => l.includes("panicked") || l.includes("failed")) ?? "";
      appendFileSync(process.env.PERCOLATOR_MUTATE_DUMP, `${category} | ${label} | ${outcome(a)} | ${outcome(b)} | ${why(a)} | ${why(b)}\n`);
    }
    res = `diverged: ${outcome(a)} / ${outcome(b)}`;
  }
  if (o.restore !== false) w.restore(named);
  return res;
}

/** A transaction's instructions with the Percolator one replaced. */
export function swapIx(base: Base, i: Instruction): Instruction[] {
  return base.ixs.map((x, k) => (k === base.at ? i : x));
}

/** Whether the account exists and is executable (a program: not compared). */
function executableAt(d: Diff, at: Address): boolean {
  const a = d.original.getAccount(at);
  return a.exists && a.executable;
}

/** True when the result failed. */
export const failed = (r: Result) => r instanceof FailedTransactionMetadata;
