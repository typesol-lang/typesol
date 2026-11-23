// External oracle accounts for the Percolator v16 tests (Percolator v16 at commit 7b110913, engine 5e3af07,
// aeyakovenko/percolator-prog, Apache-2.0): Pyth PriceUpdateV2, Switchboard On-Demand pull feeds and Chainlink OCR2
// transmissions, built field by field from the bytes the original reads (`mod oracle_v16`, src/v16_program.rs) and the
// dependency it parses with (pythnet-sdk 2.3.1's PriceFeedMessage, from the reference's Cargo.lock). The author's own
// tests build the same three (`make_pyth_data`, `make_switchboard_data`, `make_chainlink_data` in tests/v16_cu.rs);
// these add every field those leave fixed (length, discriminator, verification level, submission index, sample sizes,
// version, round id, live length) so that each can be set to its boundaries. The accounts are synthetic: no mainnet
// snapshot is used.
//
// Also here: the asset oracle profile's bytes (AssetOracleProfileV16, through the layout table) and a seeded generator
// of external-read vectors shared by the vector test (percolator-v16-external.test.ts, which compares the port's
// readers with the original's compiled for the host: scripts/percolator-v16-reference/oracle-vectors.ts) and the
// ConfigureHybridOracle fuzz.
import { type Address, address, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { createHash } from "node:crypto";
import { Rng } from "./fuzz-rng.ts";
import { offsetOf, sizeOf } from "./percolator-v16-layout.ts";

export const PYTH_RECEIVER = address("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const SWITCHBOARD_MAINNET = address("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
export const SWITCHBOARD_DEVNET = address("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
export const CHAINLINK_STORE = address("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
export const MAX_PRICE = 1_000_000_000_000n;
const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);
const I128_MAX = (1n << 127n) - 1n;
const U64_MAX = (1n << 64n) - 1n;

const enc = getAddressEncoder();
const dec = getAddressDecoder();
export const keyBytes = (a: Address) => Buffer.from(enc.encode(a));
export const addressOf = (b: Uint8Array) => dec.decode(b);

function put(b: Buffer, at: number, size: number, v: bigint): void {
  const u = BigInt.asUintN(size * 8, v);
  for (let i = 0; i < size; i++) b[at + i] = Number((u >> BigInt(8 * i)) & 0xffn);
}

// ---- Pyth PriceUpdateV2 ------------------------------------------------------------------------------------------------

export interface Pyth {
  feedId: Uint8Array;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: bigint;
  /** 134 by default (PRICE_UPDATE_V2_MIN_LEN; the receiver's accounts are exactly that long). */
  len?: number;
  /** The verification level's Borsh tag at byte 40 (1 = Full by default; 0 = Partial). */
  level?: number;
  /** A wrong Anchor discriminator. */
  badDiscriminator?: boolean;
}

/**
 * The account: the Anchor discriminator, write_authority (32 bytes, zero), verification_level (Full: one tag byte),
 * then pythnet-sdk's PriceFeedMessage in Borsh (feed_id, price, conf, exponent, publish_time, prev_publish_time,
 * ema_price, ema_conf: 84 bytes at 41), then posted_slot (8 bytes at 125, zero), 133 bytes; the receiver allocates 134.
 */
export function pythData(p: Pyth): Buffer {
  const b = Buffer.alloc(p.len ?? 134);
  const head = Buffer.from([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]);
  if (p.badDiscriminator) head[7] ^= 1;
  const full = Buffer.alloc(Math.max(b.length, 134));
  head.copy(full, 0);
  full[40] = p.level ?? 1;
  Buffer.from(p.feedId).copy(full, 41);
  put(full, 73, 8, p.price);
  put(full, 81, 8, p.conf);
  put(full, 89, 4, BigInt(p.expo));
  put(full, 93, 8, p.publishTime);
  put(full, 101, 8, p.publishTime - 1n);
  put(full, 109, 8, p.price);
  put(full, 117, 8, p.conf);
  full.copy(b, 0, 0, b.length);
  return b;
}

// ---- Switchboard On-Demand ---------------------------------------------------------------------------------------------

export interface Switchboard {
  /** The current result's value, scaled by 10^18. */
  value: bigint;
  stdDev: bigint;
  /** The selected submission's timestamp (the price's age). */
  publishTime: bigint;
  /** PullFeed.last_update_timestamp (the account write; not the price's age). */
  lastUpdate?: bigint;
  numSamples?: number;
  minSampleSize?: number;
  submissionIdx?: number;
  resultSlot?: bigint;
  feedHash?: Uint8Array;
  /** 3,208 by default (SWITCHBOARD_PULL_FEED_MIN_LEN; the program's PullFeedAccountData is larger on mainnet). */
  len?: number;
  badDiscriminator?: boolean;
}

/**
 * PullFeedAccountData at the offsets the original reads: the discriminator; the 32 submissions (64 bytes each from 8;
 * each one's landed_at timestamp at 2,952 + 8 · i in the original's reading); feed_hash at 2,120; min_sample_size at
 * 2,215; last_update_timestamp at 2,216; the CurrentResult's value (i128) at 2,264, std_dev at 2,280, num_samples at
 * 2,360, submission_idx at 2,361, slot at 2,368.
 */
export function switchboardData(s: Switchboard): Buffer {
  const len = s.len ?? 3208;
  const b = Buffer.alloc(Math.max(len, 3208));
  Buffer.from([196, 27, 108, 196, 10, 215, 219, 40]).copy(b, 0);
  if (s.badDiscriminator) b[0] ^= 1;
  Buffer.from(s.feedHash ?? new Uint8Array(32).fill(0xab)).copy(b, 2120);
  b[2215] = s.minSampleSize ?? 1;
  put(b, 2216, 8, s.lastUpdate ?? s.publishTime);
  put(b, 2264, 16, s.value);
  put(b, 2280, 16, s.stdDev);
  b[2360] = s.numSamples ?? 3;
  const idx = s.submissionIdx ?? 0;
  b[2361] = idx;
  put(b, 2368, 8, s.resultSlot ?? 1n);
  // Every submission's timestamp: the selected one is the publish time, the others older.
  for (let i = 0; i < 32; i++) put(b, 2952 + 8 * i, 8, i === idx ? s.publishTime : s.publishTime - 1000n - BigInt(i));
  return b.subarray(0, len);
}

// ---- Chainlink OCR2 ----------------------------------------------------------------------------------------------------

export interface Chainlink {
  answer: bigint;
  decimals: number;
  /** The transmission's timestamp (u32). */
  timestamp: bigint;
  version?: number;
  latestRoundId?: number;
  liveLength?: number;
  slot?: bigint;
  /** 248 by default (CHAINLINK_FEED_MIN_LEN: the 8-byte discriminator, the 192-byte header and one transmission). */
  len?: number;
  badDiscriminator?: boolean;
}

/** The Transmissions account: discriminator, header (version at 8, decimals at 138, latest_round_id at 143, live_length at 148), the transmission at 200 (slot, timestamp u32 at 208, answer i128 at 216). */
export function chainlinkData(c: Chainlink): Buffer {
  const len = c.len ?? 248;
  const b = Buffer.alloc(Math.max(len, 248));
  Buffer.from([96, 179, 69, 66, 128, 129, 73, 117]).copy(b, 0);
  if (c.badDiscriminator) b[3] ^= 1;
  b[8] = c.version ?? 2;
  b[138] = c.decimals;
  put(b, 143, 4, BigInt(c.latestRoundId ?? 7));
  put(b, 148, 4, BigInt(c.liveLength ?? 1));
  put(b, 200, 8, c.slot ?? 1n);
  put(b, 208, 4, c.timestamp);
  put(b, 216, 16, c.answer);
  return b.subarray(0, len);
}

// ---- One leg ---------------------------------------------------------------------------------------------------------------

/** An oracle account: its key, owner and bytes, and the feed the profile names for it. */
export interface OracleAccount {
  key: Address;
  owner: Address;
  data: Buffer;
  /** What the leg's `oracle_leg_feeds` entry is (Pyth: the feed id; Switchboard and Chainlink: the account's key). */
  feed: Uint8Array;
  kind: "pyth" | "switchboard" | "chainlink";
  /** A description of the leg (for messages). */
  what: string;
  /** The e6 price the leg reads as, when it is a valid leg. */
  e6?: bigint;
}

export const randomKey = (rng: Rng): Address => addressOf(rng.bytes(32));

/** A leg whose price is `e6` (1..=10^12) at `publishTime`, read from `kind`. */
export function legAt(rng: Rng, kind: OracleAccount["kind"], e6: bigint, publishTime: bigint, o: { devnet?: boolean } = {}): OracleAccount {
  const key = randomKey(rng);
  if (kind === "pyth") {
    const feedId = rng.bytes(32);
    // price · 10^expo = e6 · 10^-6, with expo -8: price = e6 · 100.
    return {
      key,
      owner: PYTH_RECEIVER,
      data: pythData({ feedId, price: e6 * 100n, conf: 1n, expo: -8, publishTime }),
      feed: feedId,
      kind,
      what: `pyth ${e6}`,
      e6,
    };
  }
  if (kind === "switchboard")
    return {
      key,
      owner: o.devnet ? SWITCHBOARD_DEVNET : SWITCHBOARD_MAINNET,
      data: switchboardData({ value: e6 * 1_000_000_000_000n, stdDev: 1n, publishTime }),
      feed: keyBytes(key),
      kind,
      what: `switchboard ${e6}`,
      e6,
    };
  return {
    key,
    owner: CHAINLINK_STORE,
    data: chainlinkData({ answer: e6 * 100n, decimals: 8, timestamp: publishTime }),
    feed: keyBytes(key),
    kind,
    what: `chainlink ${e6}`,
    e6,
  };
}

/** A boundary value of a u64 (or of the given width), or an ordinary one. */
function edge(rng: Rng, bits = 64): bigint {
  const max = (1n << BigInt(bits)) - 1n;
  return rng.pick([0n, 1n, 2n, max, max - 1n, max >> 1n, (max >> 1n) + 1n, rng.next() & max]);
}

/**
 * A random leg at `publishTime` around `nowTs`, valid or with one field at or past a boundary: what the reader checks
 * (length, discriminator, verification level, feed, price sign and range, exponent, confidence at the exact boundary,
 * the age at the staleness limit, the Switchboard sample counts, index, slot and timestamps, the Chainlink version,
 * round, live length, slot, timestamp, decimals). `maxStaleness` and `confBps` are the profile's.
 */
export function randomLeg(rng: Rng, nowTs: bigint, publishTime: bigint, maxStaleness: bigint, confBps: bigint, mutate: boolean): OracleAccount {
  const kind = rng.pick(["pyth", "switchboard", "chainlink"] as const);
  const key = randomKey(rng);
  const pickTime = () =>
    rng.pick([publishTime, nowTs, nowTs + 1n, nowTs - maxStaleness, nowTs - maxStaleness - 1n, nowTs - maxStaleness + 1n, 0n, -1n, 1n, I64_MIN, I64_MAX]);
  const m = mutate ? rng.int(12) : -1;
  if (kind === "pyth") {
    const expo = m === 0 ? rng.pick([-19, -18, 18, 19, 7, 12, -12, 0, -2147483648, 2147483647]) : rng.pick([-8, -6, -5, -10, -12, -2, 0]);
    // An e6 price, then the mantissa for the exponent (whole when the exponent is at most -6).
    const e6 = 1n + (rng.next() % MAX_PRICE);
    const ex = Math.max(-30, Math.min(30, expo));
    let price = ex <= -6 ? e6 * 10n ** BigInt(-6 - ex) : e6 / 10n ** BigInt(ex + 6) || 1n;
    if (price > I64_MAX) price = I64_MAX;
    if (m === 1) price = rng.pick([0n, -1n, I64_MIN, I64_MAX, 1n, 999_999n]);
    let conf = rng.pick([0n, 1n, price / 100n]);
    if (m === 2 && confBps > 0n) {
      // At the exact boundary conf · 10,000 = price · bps, and one past it.
      const boundary = (price * confBps) / 10000n;
      conf = rng.pick([boundary, boundary + 1n, U64_MAX, edge(rng)]);
    }
    const t = m === 3 ? pickTime() : publishTime;
    const feedId = rng.bytes(32);
    const len = m === 4 ? rng.pick([0, 1, 133, 134, 135, 200]) : 134;
    const level = m === 5 ? rng.pick([0, 2, 255]) : 1;
    const badDiscriminator = m === 6;
    const data = pythData({ feedId, price, conf: BigInt.asUintN(64, conf), expo, publishTime: t, len, level, badDiscriminator });
    const feed = m === 7 ? rng.bytes(32) : feedId;
    return {
      key,
      owner: m === 8 ? rng.pick([CHAINLINK_STORE, randomKey(rng)]) : PYTH_RECEIVER,
      data,
      feed,
      kind,
      what: `pyth m${m} price ${price} expo ${expo} conf ${conf} t ${t}`,
    };
  }
  if (kind === "switchboard") {
    const e6 = 1n + (rng.next() % MAX_PRICE);
    let value = e6 * 1_000_000_000_000n + (rng.next() % 1_000_000_000_000n);
    if (m === 0)
      value = rng.pick([
        0n,
        -1n,
        1n,
        999_999_999_999n,
        1_000_000_000_000n,
        I128_MAX,
        -I128_MAX - 1n,
        (MAX_PRICE + 1n) * 1_000_000_000_000n,
        MAX_PRICE * 1_000_000_000_000n + 999_999_999_999n,
      ]);
    let stdDev = rng.pick([0n, 1n, value / 1000n]);
    if (m === 1) {
      const boundary = confBps > 0n && value > 0n ? (value * confBps) / 10000n : 0n;
      stdDev = rng.pick([-1n, boundary, boundary + 1n, I128_MAX, -I128_MAX - 1n]);
    }
    const t = m === 2 ? pickTime() : publishTime;
    const minSampleSize = m === 3 ? rng.pick([0, 1, 3, 4, 255]) : 1;
    const numSamples = m === 3 ? rng.pick([0, 1, 2, 3, 255]) : 3;
    const submissionIdx = m === 4 ? rng.pick([0, 1, 31, 32, 33, 255]) : rng.int(32);
    const resultSlot = m === 5 ? rng.pick([0n, 1n, U64_MAX]) : 1n + (rng.next() % 1_000_000n);
    const lastUpdate = m === 6 ? rng.pick([0n, -1n, 1n, I64_MIN, I64_MAX, nowTs]) : t;
    const feedHash = m === 7 ? new Uint8Array(32) : rng.bytes(32);
    const len = m === 8 ? rng.pick([0, 3207, 3208, 3209, 3800]) : 3208;
    const data = switchboardData({
      value,
      stdDev,
      publishTime: t,
      lastUpdate,
      numSamples,
      minSampleSize,
      submissionIdx,
      resultSlot,
      feedHash,
      len,
      badDiscriminator: m === 9,
    });
    const feed = m === 10 ? rng.bytes(32) : keyBytes(key);
    const owner = m === 11 ? rng.pick([PYTH_RECEIVER, SWITCHBOARD_DEVNET, randomKey(rng)]) : rng.chance(20) ? SWITCHBOARD_DEVNET : SWITCHBOARD_MAINNET;
    return { key, owner, data, feed, kind, what: `switchboard m${m} value ${value} std ${stdDev} t ${t} idx ${submissionIdx}` };
  }
  const decimals = m === 0 ? rng.pick([0, 1, 5, 6, 7, 18, 19, 255]) : rng.pick([8, 6, 9, 18, 2]);
  const e6 = 1n + (rng.next() % MAX_PRICE);
  let answer = decimals >= 6 ? e6 * 10n ** BigInt(decimals - 6) : e6 / 10n ** BigInt(6 - decimals) || 1n;
  if (m === 1) answer = rng.pick([0n, -1n, 1n, I128_MAX, -I128_MAX - 1n, I128_MAX / 1_000_000n + 1n, I128_MAX / 1_000_000n]);
  const tCandidate = m === 2 ? pickTime() : publishTime;
  const timestamp = BigInt.asUintN(32, tCandidate);
  const version = m === 3 ? rng.pick([0, 1, 255]) : 2;
  const latestRoundId = m === 4 ? rng.pick([0, 1, 0xffffffff]) : 1 + rng.int(1000);
  const liveLength = m === 5 ? rng.pick([0, 1, 2, 0xffffffff]) : 1;
  const slot = m === 6 ? rng.pick([0n, 1n, U64_MAX]) : 1n + (rng.next() % 1_000_000n);
  const len = m === 7 ? rng.pick([0, 247, 248, 249, 500]) : 248;
  const data = chainlinkData({ answer, decimals, timestamp, version, latestRoundId, liveLength, slot, len, badDiscriminator: m === 8 });
  const feed = m === 9 ? rng.bytes(32) : keyBytes(key);
  const owner = m === 10 ? rng.pick([PYTH_RECEIVER, SWITCHBOARD_MAINNET, randomKey(rng)]) : CHAINLINK_STORE;
  return { key, owner, data, feed, kind, what: `chainlink m${m} answer ${answer} dec ${decimals} t ${timestamp}` };
}

// ---- The asset oracle profile ----------------------------------------------------------------------------------------------

export interface ProfileFields {
  mode: number;
  count: number;
  flags: number;
  invert: number;
  unitScale: bigint;
  confBps: bigint;
  maxStaleness: bigint;
  softStale: bigint;
  lastGoodSlot: bigint;
  feeds: Uint8Array[];
  prices: bigint[];
  times: bigint[];
}

const PROFILE = "AssetOracleProfile";
const at = (f: string) => offsetOf(PROFILE, f);

/** AssetOracleProfileV16's 424 bytes with these fields (every other field zero). */
export function profileBytes(f: ProfileFields): Buffer {
  const b = Buffer.alloc(sizeOf(PROFILE));
  b[at("oracle_mode")] = f.mode;
  b[at("oracle_leg_count")] = f.count;
  b[at("oracle_leg_flags")] = f.flags;
  b[at("invert")] = f.invert;
  put(b, at("unit_scale"), 4, f.unitScale);
  put(b, at("conf_filter_bps"), 2, f.confBps);
  put(b, at("max_staleness_secs"), 8, f.maxStaleness);
  put(b, at("hybrid_soft_stale_slots"), 8, f.softStale);
  put(b, at("last_good_oracle_slot"), 8, f.lastGoodSlot);
  for (let i = 0; i < 3; i++) {
    Buffer.from(f.feeds[i] ?? new Uint8Array(32)).copy(b, at("oracle_leg_feeds") + 32 * i);
    put(b, at("oracle_leg_prices_e6") + 8 * i, 8, f.prices[i] ?? 0n);
    put(b, at("oracle_leg_publish_times") + 8 * i, 8, f.times[i] ?? 0n);
  }
  return b;
}

/** The three stored leg prices and publish times of a profile's bytes. */
export function storedLegs(b: Uint8Array): bigint[] {
  const buf = Buffer.from(b);
  const out: bigint[] = [];
  for (let i = 0; i < 3; i++) out.push(buf.readBigUInt64LE(at("oracle_leg_prices_e6") + 8 * i));
  for (let i = 0; i < 3; i++) out.push(buf.readBigInt64LE(at("oracle_leg_publish_times") + 8 * i));
  return out;
}

// ---- Vectors of read_external_price_e6_profile -----------------------------------------------------------------------------

export interface Vector {
  nowTs: bigint;
  nowSlot: bigint;
  profile: Buffer;
  accounts: OracleAccount[];
}

/**
 * `n` vectors from `seed`: a profile (mostly hybrid; sometimes Manual, EWMA or a bad leg configuration; 1 to 3 legs,
 * the divide flags, invert, unit scales at their edges, confidence filters, staleness limits, soft-stale windows),
 * stored leg observations (none, the same, older or newer than the new ones, at the same time with another price) and
 * the leg accounts (from `randomLeg`, at a common publish time or not, sometimes fewer than the legs, sometimes one
 * account twice).
 */
export function vectors(seed: bigint, n: number): Vector[] {
  const rng = new Rng(seed);
  const out: Vector[] = [];
  for (let v = 0; v < n; v++) {
    const nowTs = rng.chance(85) ? 1_770_000_000n : rng.pick([1n, 0n, -5n, I64_MAX, 86_400n]);
    const nowSlot = rng.pick([300_000_000n, 0n, 1n, U64_MAX]);
    const count = rng.chance(5) ? rng.pick([0, 4, 255]) : 1 + rng.int(3);
    const validFlags = count === 1 ? [0] : count === 2 ? [0, 1] : [0, 1, 2, 3];
    const flags = rng.chance(8) ? rng.pick([1, 2, 3, 4, 0x80, 0xff]) : rng.pick(validFlags);
    const invert = rng.chance(3) ? rng.pick([2, 255]) : rng.int(2);
    const unitScale = rng.chance(70) ? rng.pick([0n, 1n]) : rng.pick([2n, 1000n, 1_000_000n, 0xffff_ffffn]);
    const confBps = rng.pick([0n, 0n, 1n, 50n, 10_000n, 10_001n, 0xffffn]);
    const maxStaleness = rng.pick([60n, 60n, 1n, 3600n, U64_MAX, 1n << 63n]);
    const mode = rng.chance(90) ? 1 : rng.pick([0, 2, 3]);
    const publishTime = rng.pick([nowTs, nowTs - 1n, nowTs - 30n, nowTs - 30n, nowTs - maxStaleness, 1n]);
    const legs: OracleAccount[] = [];
    for (let i = 0; i < Math.max(1, Math.min(count, 3)); i++) {
      const mutate = rng.chance(22);
      const t = rng.chance(8) ? publishTime + BigInt(rng.pick([-1, 1, 2])) : publishTime;
      const e6 = rng.chance(85) ? 100_000n + (rng.next() % 3_000_000n) : 1n + (rng.next() % MAX_PRICE);
      legs.push(
        rng.chance(60) && !mutate
          ? legAt(rng, rng.pick(["pyth", "switchboard", "chainlink"] as const), e6, t, { devnet: rng.chance(10) })
          : randomLeg(rng, nowTs, t, maxStaleness, confBps, mutate),
      );
    }
    // The feeds: the legs' (sometimes zero, repeated, or another).
    const feeds = legs.map((l) => l.feed);
    if (rng.chance(3) && feeds.length >= 2) feeds[1] = feeds[0]!;
    if (rng.chance(3)) feeds[rng.int(feeds.length)] = new Uint8Array(32);
    if (rng.chance(3) && count < 3) feeds.push(rng.bytes(32));
    const prices: bigint[] = [];
    const times: bigint[] = [];
    if (rng.chance(50))
      for (let i = 0; i < 3; i++) {
        times.push(rng.pick([0n, publishTime, publishTime - 1n, publishTime + 1n, I64_MIN, I64_MAX]));
        prices.push(rng.pick([0n, 1n, MAX_PRICE, rng.next() % 3_000_000n, legs[i]?.e6 ?? 7n, legs[i]?.e6 ?? 7n]));
      }
    const profile = profileBytes({
      mode,
      count,
      flags,
      invert,
      unitScale,
      confBps,
      maxStaleness,
      softStale: rng.pick([0n, 1n, 100n, U64_MAX]),
      lastGoodSlot: rng.pick([0n, 300_000_000n - 100n, 300_000_000n - 101n, 300_000_000n, U64_MAX]),
      feeds,
      prices,
      times,
    });
    let accounts = legs;
    if (rng.chance(4)) accounts = accounts.slice(0, accounts.length - 1);
    if (rng.chance(3) && accounts.length >= 2) accounts = [accounts[0]!, accounts[0]!, ...accounts.slice(2)];
    out.push({ nowTs, nowSlot, profile, accounts });
  }
  return out;
}

/** The binary the Rust side reads: the count, then per vector the account count, now_ts, now_slot, the profile, each account's key, owner, length and data. */
export function vectorInput(vs: Vector[]): Buffer {
  const parts: Buffer[] = [];
  const n = Buffer.alloc(4);
  n.writeUInt32LE(vs.length);
  parts.push(n);
  for (const v of vs) {
    const h = Buffer.alloc(17);
    h[0] = v.accounts.length;
    h.writeBigInt64LE(v.nowTs, 1);
    h.writeBigUInt64LE(v.nowSlot, 9);
    parts.push(h, v.profile);
    for (const a of v.accounts) {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(a.data.length);
      parts.push(keyBytes(a.key), keyBytes(a.owner), len, a.data);
    }
  }
  return Buffer.concat(parts);
}

/** The sha256 of the vectors' input (the fixture records it, so a changed generator is noticed). */
export const vectorDigest = (vs: Vector[]) => createHash("sha256").update(vectorInput(vs)).digest("hex");
