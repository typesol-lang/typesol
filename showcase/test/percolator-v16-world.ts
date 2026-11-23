// The world the account sweeps, the random walk and the mutation fuzzer of the Percolator v16 port share
// (percolator-v16-accounts.test.ts, percolator-v16-walk.test.ts, percolator-v16-mutate.test.ts): one market built
// through `Diff` against the reference (Percolator v16 at commit 7b110913, engine 5e3af07; test/programs/percolator_v16.so,
// the Rust build of those commits, not a deployed program), with two configured assets in a capacity of three, two
// owners with portfolios (one funded), the ledgers, spare mints and token accounts; a valid transaction of each of the
// ported instructions in the world's current state; the accounts a mutation can put in their place; a snapshot of
// every account the world made, restored in both VMs, so that each mutation starts from the same state. Four external
// oracle accounts (Pyth, Switchboard on its mainnet and devnet owners, Chainlink) carry prices that a keeper refreshes
// with the Clock's unix time (`refreshOracles`), for ConfigureHybridOracle.
//
// Every keypair comes from the seed, and every account the world makes is at a keypair's address, so any of them can
// sign: the market, a portfolio, a token account, a mint.
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  AccountRole,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressDecoder,
  getAddressEncoder,
} from "@solana/kit";
import { pda } from "../../test/harness.js";
import { Rng } from "./fuzz-rng.js";
import {
  ATA_PROGRAM,
  Diff,
  FUZZ_SEED,
  MATCHERS,
  RUN_SEED,
  type Market,
  PROGRAM,
  TOKEN,
  TOKEN_2022,
  type InitMarketArgs,
  defaultInitArgs,
  instruction,
  ix,
  marketAt,
  portfolioAt,
  r,
  s,
} from "./percolator-v16-helpers.js";
import { MARKET } from "./percolator-v16-layout.js";
import { mintBytes, tokenAccountBytes } from "./percolator-helpers.js";
import {
  CHAINLINK_STORE,
  PYTH_RECEIVER,
  SWITCHBOARD_DEVNET,
  SWITCHBOARD_MAINNET,
  chainlinkData,
  keyBytes,
  pythData,
  switchboardData,
} from "./percolator-v16-oracles.js";

/** One of the world's external oracle accounts: its kind, its price (e6) and, for Pyth, its feed id. */
export interface WorldOracle {
  key: Address;
  kind: "pyth" | "switchboard" | "chainlink";
  owner: Address;
  e6: bigint;
  feedId: Uint8Array;
}

export const ZERO = "11111111111111111111111111111111" as Address;
export const SEED = FUZZ_SEED;

/** The ported tags and their names. */
export const NAMES: Record<number, string> = {
  0: "InitMarket",
  1: "InitPortfolio",
  3: "Deposit",
  4: "Withdraw",
  8: "ClosePortfolio",
  48: "SyncMaintenanceFee",
  32: "UpdateAuthority",
  37: "UpdateLiquidationFeePolicy",
  38: "ConfigurePermissionlessResolve",
  49: "UpdateMaintenanceFeePolicy",
  51: "UpdateBackingFeePolicy",
  53: "SyncBackingDomainLedger",
  54: "SyncInsuranceLedger",
  55: "UpdateTradeFeePolicy",
  58: "UpdateFeeRedirectPolicy",
  59: "UpdateMarketInitFeePolicy",
  60: "UpdateBaseUnitMints",
  65: "UpdateAssetAuthority",
  34: "ConfigureHybridOracle",
  35: "ConfigureEwmaMark",
  36: "PushEwmaMark",
  62: "ConfigureAuthMark",
  63: "PushAuthMark",
  68: "SetMatcherConfig",
  40: "UpdateAssetLifecycle",
  69: "RestartAssetOracle",
  70: "CanonicalizeSpentBackingHistory",
};
export const TAGS = Object.keys(NAMES).map(Number);

/** The control sequences of slot `i` (AssetControlSequencesV16), as offsets in the market. */
const controls = (i: number) => MARKET.slots + i * MARKET.slotLen + MARKET.controlSequences;
const LANE = {
  oracleObservation: 0,
  backingFee: 8,
  authorityEpoch: 16,
  tradeFee: 24,
  liquidationFee: 32,
  maintenanceFee: 40,
  feeRedirect: 48,
  marketInitFee: 56,
  permissionlessResolve: 64,
};

/** What a world's main market is made of (the defaults: the shared world's). */
export interface WorldOptions {
  /** InitMarket's arguments over the world's. */
  market?: Partial<InitMarketArgs>;
  /** The market's slot capacity (3). */
  capacity?: number;
  /** How many owners with portfolios (2). */
  portfolios?: number;
  /** How much each portfolio receives at the start (1,000 for the first, nothing for the others). */
  deposit?: bigint;
  /** Each configured asset's AuthMark at the start (1,000,000). */
  mark?: bigint;
}

export class World {
  readonly signers = new Map<Address, KeyPairSigner>();
  /** Every account the world made (restored by `restore`). */
  readonly accounts: Address[] = [];
  d!: Diff;
  m!: Market;
  /** A second, uninitialized market (InitMarket's target). */
  fresh!: Market;
  /** A third market, initialized and never funded (UpdateBaseUnitMints succeeds only on an empty market). */
  empty!: Market;
  owners: KeyPairSigner[] = [];
  portfolios: Address[] = [];
  sources: Address[] = [];
  ledgers = { insurance: ZERO, backing: ZERO };
  mints: Address[] = [];
  /** The matcher context of each owner's portfolio (owned by the auth matcher, 64 bytes). */
  contexts: Address[] = [];
  /** An uninitialized, zeroed portfolio account (InitPortfolio's target). */
  blank!: Address;
  stranger!: KeyPairSigner;
  oracles: WorldOracle[] = [];
  /** The leg kinds of the last ConfigureHybridOracle `base` made (for the walk's tally). */
  lastLegs = "";
  private snapshot = new Map<Address, { data: Uint8Array; lamports: bigint; owner: Address; executable: boolean } | null>();
  readonly keyRng: Rng;

  readonly options: WorldOptions = {};

  constructor(seed: bigint) {
    // The keys from the run's seed (PERCOLATOR_V16_SEED) and the world's: replayed by both.
    this.keyRng = new Rng((seed * 7919n + 17n) ^ (RUN_SEED * 0x2545_f491n));
  }

  async key(): Promise<KeyPairSigner> {
    const k = await createKeyPairSignerFromPrivateKeyBytes(this.keyRng.bytes(32));
    this.signers.set(k.address, k);
    this.accounts.push(k.address);
    return k;
  }

  static async build(seed: bigint = SEED, options: WorldOptions = {}): Promise<World> {
    const w = new World(seed);
    Object.assign(w.options, options);
    w.d = await Diff.create({ keys: () => w.key() });
    w.fresh = await w.d.newMarket({ capacity: 2 });
    w.empty = await w.d.market({ capacity: 1, label: "world empty market" });
    w.stranger = await w.d.funded();
    await w.mainMarket();
    for (let i = 0; i < 2; i++) {
      const c = (await w.key()).address;
      w.d.write(c, MATCHERS.auth.id, new Uint8Array(64));
      w.contexts.push(c);
    }
    w.blank = (await w.d.newPortfolio()).portfolio;
    w.ledgers.insurance = await w.d.address();
    w.d.write(w.ledgers.insurance, PROGRAM, new Uint8Array(176));
    w.ledgers.backing = await w.d.address();
    w.d.write(w.ledgers.backing, PROGRAM, new Uint8Array(240));
    for (const decimals of [6, 6, 9]) w.mints.push(await w.d.mint(decimals));
    // The empty market's vaults of the two spare mints, empty (its original mint's vault is made with it).
    for (const mint of w.mints.slice(0, 2)) {
      const [v] = await pda(ATA_PROGRAM, [w.empty.vaultPda, TOKEN, mint]);
      w.d.write(v, TOKEN, tokenAccountBytes({ mint, owner: w.empty.vaultPda, amount: 0n }));
      w.accounts.push(v);
    }
    // A Token-2022 mint and token account (the original accepts SPL Token only).
    const m22 = await w.d.address();
    w.d.write(m22, TOKEN_2022, mintBytes({ decimals: 6 }));
    w.mints.push(m22);
    const t22 = await w.d.address();
    w.d.write(t22, TOKEN_2022, tokenAccountBytes({ mint: w.m.mint, owner: w.owners[0]!.address, amount: 1_000_000n }));
    w.sources.push(t22);
    for (const [kind, owner] of [
      ["pyth", PYTH_RECEIVER],
      ["switchboard", SWITCHBOARD_MAINNET],
      ["switchboard", SWITCHBOARD_DEVNET],
      ["chainlink", CHAINLINK_STORE],
    ] as const)
      w.oracles.push({ key: (await w.key()).address, kind, owner, e6: 1_000_000n, feedId: w.keyRng.bytes(32) });
    w.refreshOracles();
    w.take();
    return w;
  }

  /**
   * The main market: two configured assets in a capacity of three, both on AuthMark (as the author's test world sets
   * them up, tests/support/v16_svm.rs initialize_world), a force-close delay (UpdateAssetLifecycle's shutdown needs
   * one) under a long stale window, two owners with portfolios (the first funded). A walk starts a fresh one when the
   * current one can no longer make progress (`stuck`).
   */
  async mainMarket(): Promise<void> {
    const o = this.options;
    this.m = await this.d.market({
      capacity: o.capacity ?? 3,
      args: { maxPortfolioAssets: 2, maxTradingFeeBps: 500n, maintenanceFeePerSlot: 1n, ...o.market },
      label: "world InitMarket",
    });
    const fresh = this.owners.length === 0;
    const count = o.portfolios ?? 2;
    for (let i = 0; i < count; i++) {
      const { owner, portfolio } = await this.d.newPortfolio();
      await this.d.ok(`world InitPortfolio ${i}`, owner, [ix.initPortfolio(this.m, owner, portfolio)]);
      const source = await this.d.tokenAccount(this.m.mint, owner.address, o.deposit !== undefined ? o.deposit * 4n : 1_000_000_000n);
      if (fresh) {
        this.owners.push(owner);
        this.portfolios.push(portfolio);
        this.sources.push(source);
      } else {
        this.owners[i] = owner;
        this.portfolios[i] = portfolio;
        this.sources[i] = source;
      }
    }
    for (let i = 0; i < (o.deposit !== undefined ? count : 1); i++)
      await this.d.ok(`world Deposit ${i}`, this.owners[i]!, [
        ix.deposit(this.m, this.owners[i]!, this.portfolios[i]!, this.sources[i]!, this.d.portfolioId(this.portfolios[i]!), 0n, o.deposit ?? 1_000n),
      ]);
    const assets = o.market?.maxPortfolioAssets ?? 2;
    for (let asset = 0; asset < assets; asset++)
      await this.d.ok(`world ConfigureAuthMark ${asset}`, this.m.admin, [
        ix.configureAuthMark(this.m, this.m.admin, { asset, marketId: BigInt(asset + 1), mark: o.mark ?? 1_000_000n, sequence: 1n, epoch: 0n }),
      ]);
    await this.d.ok("world ConfigurePermissionlessResolve", this.m.admin, [
      ix.permissionlessResolve(this.m, this.m.admin, this.u64At(marketAt.group("next_market_id")), 6_000_000n, 10n, 1n, 0n),
    ]);
    if (!fresh) {
      // New ledgers: the old ones are bound to the old market.
      this.ledgers.insurance = (await this.key()).address;
      this.d.write(this.ledgers.insurance, PROGRAM, new Uint8Array(176));
      this.ledgers.backing = (await this.key()).address;
      this.d.write(this.ledgers.backing, PROGRAM, new Uint8Array(240));
    }
  }

  /**
   * The keeper of the external prices: each oracle account rewritten in both VMs, published at the Clock's unix time
   * (its price moved by up to ±2% when `rng` is given).
   */
  refreshOracles(rng?: Rng): void {
    const t = this.d.unixTimestamp;
    for (const o of this.oracles) {
      if (rng) {
        o.e6 = (o.e6 * BigInt(9_800 + rng.int(401))) / 10_000n;
        if (o.e6 < 1_000n) o.e6 = 1_000n;
      }
      const data =
        o.kind === "pyth"
          ? pythData({ feedId: o.feedId, price: o.e6 * 100n, conf: o.e6 / 1_000n, expo: -8, publishTime: t })
          : o.kind === "switchboard"
            ? switchboardData({ value: o.e6 * 1_000_000_000_000n, stdDev: o.e6, publishTime: t })
            : chainlinkData({ answer: o.e6 * 100n, decimals: 8, timestamp: t });
      this.d.write(o.key, o.owner, data);
    }
  }

  /** A valid ConfigureHybridOracle for `asset`: one to three distinct oracle accounts of the world, its flags and fields. */
  hybrid(asset: number, rng: Rng): { payer: KeyPairSigner; ix: Instruction } {
    const auth = this.oracleAuthority(asset);
    const count = 1 + rng.int(3);
    const legs = [...this.oracles].sort(() => rng.int(3) - 1).slice(0, count);
    this.lastLegs = count === 1 ? legs[0]!.kind : `composite of ${count}`;
    const flags = count === 1 ? 0 : rng.int(count === 2 ? 2 : 4);
    return {
      payer: auth,
      ix: ix.configureHybridOracle(
        this.m,
        auth,
        {
          asset,
          marketId: this.marketId(asset),
          count,
          flags,
          maxStaleness: rng.pick([60n, 60n, 5n, 3600n]),
          softStale: rng.pick([10n, 100n, 1_000n]),
          halflife: BigInt(1 + rng.int(1000)),
          minFee: rng.chance(70) ? 0n : BigInt(rng.int(1000)),
          invert: rng.chance(20) ? 1 : 0,
          unitScale: rng.chance(80) ? 0n : rng.pick([1n, 2n, 10n]),
          confBps: rng.pick([0n, 0n, 50n, 10_000n]),
          feeds: legs.map((l) => (l.kind === "pyth" ? l.feedId : keyBytes(l.key))),
          sequence: this.seq(asset, "oracleObservation") + 1n,
          epoch: this.epoch(asset),
        },
        legs.map((l) => l.key),
      ),
    };
  }

  /**
   * Whether the main market can no longer make progress: not Live, or a control sequence or authority epoch of either
   * asset driven to near u64::MAX by a mutated argument (no later value can be newer).
   */
  stuck(): boolean {
    const b = this.d.data(this.m.market);
    if (b[marketAt.group("mode")] !== 0) return true;
    for (const asset of [0, 1]) for (let lane = 0; lane < 88; lane += 8) if (b.readBigUInt64LE(controls(asset) + lane) > 1n << 62n) return true;
    return false;
  }

  /** Every world account as it is now, from the reference. */
  take(): void {
    this.snapshot.clear();
    for (const a of [...this.accounts]) {
      const acct = this.d.reference.getAccount(a);
      this.snapshot.set(
        a,
        acct.exists ? { data: new Uint8Array(acct.data), lamports: BigInt(acct.lamports), owner: acct.programAddress, executable: acct.executable } : null,
      );
    }
  }

  /**
   * The snapshot back in both VMs: each account as recorded, and one recorded as missing removed (a transaction since
   * may have created it). Accounts added to the world after `take` are not in the snapshot and are left as they are.
   */
  restore(): void {
    for (const [a, v] of this.snapshot) {
      if (v) this.d.write(a, v.owner, v.data, v.lamports, v.executable);
      else for (const vm of this.d.vms) this.d.restore(vm, new Map([[a, null]]));
    }
  }

  /** A u64 of the market in the reference. */
  u64At(at: number): bigint {
    return this.d.data(this.m.market).readBigUInt64LE(at);
  }

  seq(asset: number, lane: keyof typeof LANE): bigint {
    return this.u64At(controls(asset) + LANE[lane]);
  }

  epoch(asset: number): bigint {
    return this.seq(asset, "authorityEpoch");
  }

  marketAuthority(): KeyPairSigner {
    return this.authorityOf(this.m);
  }

  /** Asset `i`'s market id in the reference. */
  marketId(asset: number): bigint {
    return this.u64At(marketAt.engine(asset, "asset.market_id"));
  }

  /** The signer holding asset `i`'s oracle authority (the market's admin when no world key does). */
  oracleAuthority(asset: number): KeyPairSigner {
    return this.roleAuthority(asset, "oracle_authority");
  }

  /** The signer holding one of asset `i`'s profile keys (the market's admin when no world key does). */
  roleAuthority(asset: number, role: string): KeyPairSigner {
    const at = marketAt.profile(asset, role);
    const k = this.d.data(this.m.market).subarray(at, at + 32);
    for (const s of this.signers.values()) if (Buffer.from(addressBytes(s.address)).equals(k)) return s;
    return this.m.admin;
  }

  authorityOf(mk: Market): KeyPairSigner {
    const k = this.d.data(mk.market).subarray(MARKET.wrapper, MARKET.wrapper + 32);
    for (const s of this.signers.values()) if (Buffer.from(addressBytes(s.address)).equals(k)) return s;
    return this.m.admin;
  }

  /** A valid transaction of `tag` in the current state (it may still be refused by the state: a walk's business). */
  async base(tag: number, rng: Rng): Promise<{ payer: KeyPairSigner; ix: Instruction }> {
    const m = this.m;
    const a = this.marketAuthority();
    const pick = rng.int(2);
    const owner = this.owners[pick]!;
    const portfolio = this.portfolios[pick]!;
    switch (tag) {
      case 0:
        return { payer: this.fresh.admin, ix: ix.initMarket(this.fresh, defaultInitArgs({ maxPortfolioAssets: 1 + rng.int(2) })) };
      case 1: {
        // An owner whose portfolio was closed (or never initialized) takes its address again (a fresh zeroed account
        // there); otherwise the blank portfolio.
        for (let k = 0; k < 2; k++) {
          const [o, p] = [this.owners[k]!, this.portfolios[k]!];
          const acct = this.d.reference.getAccount(p);
          const initialized = acct.exists && acct.data.length >= 16 && Buffer.from(acct.data).readBigUInt64LE(0) === 0x5045524356313600n;
          if (initialized) continue;
          if (!acct.exists || acct.data.length !== 9563) this.d.write(p, PROGRAM, new Uint8Array(9563), this.d.reference.minimumBalanceForRentExemption(9563n));
          return { payer: o, ix: ix.initPortfolio(m, o, p) };
        }
        return { payer: owner, ix: ix.initPortfolio(m, owner, this.blank) };
      }
      case 3: {
        // Mostly into the first portfolio, so that the second stays empty (closable) more often.
        const k = rng.chance(90) ? 0 : 1;
        const [o, p] = [this.owners[k]!, this.portfolios[k]!];
        const d = this.d.reference.getAccount(p).exists ? this.d : null;
        const id = d ? this.d.portfolioId(p) : 1n;
        const sequence = d ? this.d.portfolioSequence(p) : 0n;
        return { payer: o, ix: ix.deposit(m, o, p, this.sources[k]!, id, sequence, BigInt(rng.int(3) === 0 ? 0 : 1 + rng.int(10_000))) };
      }
      case 4: {
        // Mostly from the first portfolio: nothing, one atom, all of its capital, part of it, or more than it holds.
        const k = rng.chance(80) ? 0 : 1;
        const [o, p] = [this.owners[k]!, this.portfolios[k]!];
        const exists = this.d.reference.getAccount(p).exists && this.d.data(p).length >= 9555;
        const capital = exists ? this.d.data(p).readBigUInt64LE(portfolioAt("capital")) : 0n;
        const r = rng.int(10);
        const amount =
          r === 0 ? 0n : r === 1 ? 1n : r < 4 ? capital : r < 9 ? BigInt(rng.int(Number(capital > 1_000_000n ? 1_000_000n : capital) + 1)) : capital + 1n;
        return {
          payer: o,
          ix: ix.withdraw(m, o, p, this.sources[k]!, exists ? this.d.portfolioId(p) : 1n, exists ? this.d.portfolioSequence(p) : 0n, amount),
        };
      }
      case 48: {
        // Anyone sends it: no cranker, the portfolio as its own cranker, or the other portfolio taking the share.
        const r = rng.int(3);
        const other = this.portfolios[1 - pick]!;
        return { payer: this.stranger, ix: ix.syncMaintenanceFee(m, portfolio, BigInt(rng.int(3)), r === 0 ? undefined : r === 1 ? portfolio : other) };
      }
      case 8: {
        // Mostly the second portfolio (the one deposits rarely fund).
        const k = rng.chance(85) ? 1 : 0;
        const p = this.portfolios[k]!;
        const exists = this.d.reference.getAccount(p).exists && this.d.data(p).length >= 9555;
        // The portfolio's recorded owner (a mutated InitPortfolio may have given it another world key).
        let o = this.owners[k]!;
        if (exists) {
          const at = portfolioAt("owner");
          const ownerKey = this.d.data(p).subarray(at, at + 32);
          for (const signer of this.signers.values()) if (Buffer.from(addressBytes(signer.address)).equals(ownerKey)) o = signer;
        }
        return {
          payer: o,
          ix: ix.closePortfolio(m, o, p, exists ? this.d.portfolioId(p) : 0n, exists ? this.d.portfolioSequence(p) : 0n, 0n),
        };
      }
      case 32: {
        const next = rng.chance(50) ? this.m.admin : this.stranger;
        return { payer: a, ix: ix.updateAuthority(m, a, s(next), this.epoch(0), next.address) };
      }
      case 37:
      case 49:
      case 58:
      case 59: {
        const lane = tag === 37 ? "liquidationFee" : tag === 49 ? "maintenanceFee" : tag === 58 ? "feeRedirect" : "marketInitFee";
        const value = tag === 59 ? BigInt(rng.int(1_000_000)) : BigInt(rng.int(10_001));
        return { payer: a, ix: ix.marketPolicy(m, a, tag, value, this.seq(0, lane) + 1n + BigInt(rng.int(3)), this.epoch(0)) };
      }
      case 38:
        return {
          payer: a,
          ix: ix.permissionlessResolve(
            m,
            a,
            this.u64At(marketAt.group("next_market_id")),
            BigInt(rng.chance(20) ? 1 + rng.int(10_000) : 3_000_000 + rng.int(3_480_001)),
            1n + BigInt(rng.int(1000)),
            this.seq(0, "permissionlessResolve") + 1n,
            this.epoch(0),
          ),
        };
      case 51: {
        const domain = rng.int(4);
        const asset = domain >> 1;
        const fee = rng.int(3) === 0 ? 0 : rng.int(501);
        const ins = this.roleAuthority(asset, "insurance_authority");
        return {
          payer: ins,
          ix: ix.backingFeePolicy(m, ins, domain, this.marketId(asset), fee, fee === 0 ? 0 : rng.int(10_001), maxSeq(this, asset) + 1n, this.epoch(asset)),
        };
      }
      case 53: {
        const b = this.roleAuthority(0, "backing_bucket_authority");
        return { payer: b, ix: ix.syncBackingLedger(m, b, this.ledgers.backing, 0) };
      }
      case 54: {
        const i = this.roleAuthority(0, "insurance_authority");
        return { payer: i, ix: ix.syncInsuranceLedger(m, i, this.ledgers.insurance) };
      }
      case 55:
        const ins = this.roleAuthority(0, "insurance_authority");
        return { payer: ins, ix: ix.tradeFeePolicy(m, ins, BigInt(rng.int(501)), this.seq(0, "tradeFee") + 1n, this.epoch(0)) };
      case 60: {
        // On the empty market half the time (a market holding deposits refuses: EngineLockActive).
        if (rng.chance(50)) {
          const e = this.empty;
          const ea = this.authorityOf(e);
          const cur = this.d.data(e.market).subarray(MARKET.wrapper + 32, MARKET.wrapper + 64);
          const [p, q] = Buffer.from(addressBytes(this.mints[0]!)).equals(cur) ? [this.mints[1]!, this.mints[0]!] : [this.mints[0]!, this.mints[1]!];
          const old = (await pda(ATA_PROGRAM, [e.vaultPda, TOKEN, addressFrom(cur)]))[0];
          const sec = this.d.data(e.market).subarray(MARKET.wrapper + 64, MARKET.wrapper + 96);
          const olds = [old];
          if (!sec.every((b) => b === 0) && !Buffer.from(addressBytes(q)).equals(sec))
            olds.push((await pda(ATA_PROGRAM, [e.vaultPda, TOKEN, addressFrom(sec)]))[0]);
          return { payer: ea, ix: ix.baseUnitMints(e, ea, p, q, this.d.data(e.market).readBigUInt64LE(controls(0) + LANE.authorityEpoch), olds) };
        }
        const cfg = this.d.data(m.market);
        const primary = cfg.subarray(MARKET.wrapper + 32, MARKET.wrapper + 64);
        const [p, q] = rng.chance(50) ? [this.m.mint, this.mints[0]!] : [this.mints[0]!, this.mints[1]!];
        const olds: Address[] = [];
        const [vaultPda] = [m.vaultPda];
        if (!Buffer.from(addressBytes(p)).equals(primary)) olds.push((await pda(ATA_PROGRAM, [vaultPda, TOKEN, addressFrom(primary)]))[0]);
        return { payer: a, ix: ix.baseUnitMints(m, a, p, q, this.epoch(0), olds) };
      }
      case 34:
        return this.hybrid(rng.int(2), rng);
      case 35:
      case 62: {
        const asset = rng.int(2);
        const auth = this.oracleAuthority(asset);
        const mark = BigInt(1 + rng.int(rng.chance(80) ? 2_000_000 : 1_000_000_000_000));
        const sequence = this.seq(asset, "oracleObservation") + 1n;
        if (tag === 62)
          return { payer: auth, ix: ix.configureAuthMark(m, auth, { asset, marketId: this.marketId(asset), mark, sequence, epoch: this.epoch(asset) }) };
        const halflife = BigInt(rng.chance(10) ? 0 : 1 + rng.int(1000));
        const minFee = BigInt(rng.chance(70) ? 0 : rng.int(1000));
        return {
          payer: auth,
          ix: ix.configureEwmaMark(m, auth, { asset, marketId: this.marketId(asset), mark, halflife, minFee, sequence, epoch: this.epoch(asset) }),
        };
      }
      case 36:
      case 63: {
        const asset = rng.int(2);
        const auth = this.oracleAuthority(asset);
        // The push of the asset's own mode most of the time.
        const mode = this.d.data(m.market)[marketAt.profile(asset, "oracle_mode")]!;
        const own = mode === 2 ? 36 : 63;
        const t = rng.chance(85) ? own : tag;
        const mark = BigInt(1 + rng.int(rng.chance(80) ? 2_000_000 : 1_000_000_000_000));
        return {
          payer: auth,
          ix: ix.pushMark(t as 36 | 63, m, auth, {
            asset,
            marketId: this.marketId(asset),
            mark,
            sequence: this.seq(asset, "oracleObservation") + 1n,
            epoch: this.epoch(asset),
          }),
        };
      }
      case 68: {
        const exists = this.d.reference.getAccount(portfolio).exists && this.d.data(portfolio).length >= 9555;
        const control = exists && this.d.data(portfolio).length >= 9539 ? this.d.data(portfolio).readBigUInt64LE(9531) : 0n;
        const enabled = rng.chance(75) ? 1 : 0;
        const context = this.contexts[pick]!;
        const [delegate] = await pda(PROGRAM, ["matcher", m.market, portfolio, owner.address, MATCHERS.auth.id, context]);
        return {
          payer: owner,
          ix: ix.setMatcherConfig(
            m,
            owner,
            portfolio,
            {
              id: exists ? this.d.portfolioId(portfolio) : 1n,
              sequence: exists ? this.d.portfolioSequence(portfolio) : 0n,
              epoch: (control >> 1n) & 0x1_ffff_ffff_ffffn,
              frontier: this.u64At(marketAt.group("next_market_id")),
              enabled,
              cap: enabled ? rng.int(10_001) : 0,
              expiry: enabled ? this.d.slot + 1n + BigInt(rng.int(1_000_000)) : 0n,
            },
            enabled || rng.chance(50) ? { program: MATCHERS.auth.id, context, delegate } : undefined,
          ),
        };
      }
      case 40: {
        // By asset 1's lifecycle: drain, shut down, retire or append asset 2 while Active; retire or shut down while
        // DrainOnly; reactivate when Retired; retire when in Recovery (RestartAssetOracle restarts it too).
        const life = this.d.data(m.market)[marketAt.engine(1, "asset.lifecycle")]!;
        const configured = Number(this.d.data(m.market).readUInt32LE(marketAt.group("config.max_market_slots")));
        const next = this.u64At(marketAt.group("next_market_id"));
        const r = rng.int(100);
        let action = 0;
        let asset = 1;
        if (life === 2) action = r < 20 ? 1 : r < 70 ? 3 : r < 85 ? 2 : 0;
        else if (life === 3) action = r < 30 ? 2 : 3;
        else if (life === 4) action = 0;
        else action = r < 15 ? 2 : 3;
        if (life === 2 && action === 0) asset = configured;
        const activation = action === 0;
        return {
          payer: a,
          ix: ix.assetLifecycle(m, a, {
            action,
            asset,
            marketId: activation ? next : this.marketId(asset),
            epoch: this.epoch(0),
            nowSlot: action === 1 ? 0n : 1n,
            price: activation ? BigInt(1 + rng.int(2_000_000)) : 0n,
          }),
        };
      }
      case 69: {
        const admin = this.roleAuthority(1, "asset_admin");
        return {
          payer: admin,
          ix: ix.restartAssetOracle(m, admin, {
            asset: 1,
            marketId: this.marketId(1),
            price: BigInt(1 + rng.int(2_000_000)),
            sequence: this.seq(1, "oracleObservation") + 1n,
            epoch: this.epoch(1),
          }),
        };
      }
      case 70: {
        const b = this.roleAuthority(1, "backing_bucket_authority");
        return { payer: b, ix: ix.canonicalizeSpentBacking(m, b, 1, this.marketId(1), this.epoch(1)) };
      }
      default: {
        // 65: one role of one asset, by the market authority (asset 0's admin) or the stranger.
        const asset = rng.int(2);
        const kind = rng.int(5);
        const next = rng.chance(50) ? this.stranger : a;
        return { payer: a, ix: ix.updateAssetAuthority(m, a, s(next), asset, this.marketId(asset), this.epoch(asset), kind, next.address) };
      }
    }
  }

  /**
   * The walk's keeper: once half the market's permissionless-resolve stale window has passed since its last good oracle
   * slot, asset 0's mark is pushed (or AuthMark configured on a Manual asset 0), which refreshes the market's liveness
   * (the push mirrors asset 0 into the wrapper config). Returns the outcome, or null when nothing was due.
   */
  async keepLive(rng: Rng, label: string): Promise<string | null> {
    const b = this.d.data(this.m.market);
    const stale = b.readBigUInt64LE(marketAt.wrapper("permissionless_resolve_stale_slots"));
    const last = b.readBigUInt64LE(marketAt.wrapper("last_good_oracle_slot"));
    if (stale === 0n || this.d.slot < last || this.d.slot - last < stale / 2n) return null;
    const mode = b[marketAt.profile(0, "oracle_mode")]!;
    const auth = this.oracleAuthority(0);
    const a = {
      asset: 0,
      marketId: this.marketId(0),
      mark: BigInt(500_000 + rng.int(1_000_000)),
      sequence: this.seq(0, "oracleObservation") + 1n,
      epoch: this.epoch(0),
    };
    if (mode === 1) {
      // A hybrid asset 0: its legs read again at fresh prices (the configuration refreshes the liveness).
      this.refreshOracles();
      const h = this.hybrid(0, rng);
      return this.d.send(`${label} keeper (hybrid)`, h.payer, [h.ix]);
    }
    const tx = mode === 3 ? ix.pushMark(63, this.m, auth, a) : mode === 2 ? ix.pushMark(36, this.m, auth, a) : ix.configureAuthMark(this.m, auth, a);
    return this.d.send(`${label} keeper`, auth, [tx]);
  }

  /**
   * What a walk keeps up after a success: a fresh market after InitMarket, a new blank portfolio after InitPortfolio,
   * and, once the second portfolio holds capital (no ported instruction withdraws it, so it could never close again),
   * a new address for it, which InitPortfolio then takes.
   */
  async afterSuccess(tag: number, i: Instruction): Promise<void> {
    if (tag === 0 && i.accounts?.[1]?.address === this.fresh.market) this.fresh = await this.d.newMarket({ capacity: 2 });
    if (tag === 1 && i.accounts?.[2]?.address === this.blank) this.blank = (await this.d.newPortfolio()).portfolio;
    const second = this.portfolios[1]!;
    if (tag === 3 && i.accounts?.[2]?.address === second && this.d.data(second).readBigUInt64LE(portfolioAt("capital")) !== 0n)
      this.portfolios[1] = (await this.key()).address;
  }

  /** Accounts a mutation can put in a position: every world account and the programs. */
  pool(): Address[] {
    return [...this.accounts, TOKEN, TOKEN_2022, PROGRAM, ATA_PROGRAM, ZERO];
  }
}

function maxSeq(w: World, asset: number): bigint {
  const b = w.seq(asset, "backingFee");
  const e = w.epoch(asset);
  return b > e ? b : e;
}

const addressBytes = (a: Address) => getAddressEncoder().encode(a);
const addressFrom = (b: Uint8Array) => getAddressDecoder().decode(b);

/** An instruction's accounts with one entry replaced (its role and, where the account can sign, its signer). */
export function withAccount(w: World, i: Instruction, at: number, address: Address, role: AccountRole): Instruction {
  const accounts = [...(i.accounts ?? [])] as { address: Address; role: AccountRole; signer?: KeyPairSigner }[];
  const signing = role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER;
  const signer = w.signers.get(address);
  if (signing && !signer) role = role === AccountRole.WRITABLE_SIGNER ? AccountRole.WRITABLE : AccountRole.READONLY;
  accounts[at] = { address, role, ...(signing && signer ? { signer } : {}) };
  return { ...i, accounts: accounts as Instruction["accounts"] };
}

export { instruction, r, s };
