// What the Percolator v16 port's tests of a market leaving Live share (percolator-v16-recovery.test.ts,
// percolator-v16-crank-walk.test.ts): legs opened and prices moved, a declared Recovery, the owners' forfeits and the
// Recovery crank, the two resolutions (ResolveMarket, ResolveStalePermissionless), the close-out of every portfolio on a
// Resolved market, and the conservation check run in both VMs. Every transaction goes through `Diff`, compared with
// the reference (Percolator v16 at commit 7b110913, engine 5e3af07; test/programs/percolator_v16.so, the Rust build of
// those commits, not a deployed program).
import { type Address, AccountRole, type Instruction, type KeyPairSigner } from "@solana/kit";
import { type Rng } from "./fuzz-rng.js";
import { PROGRAM, ix } from "./percolator-v16-helpers.js";
import { type World, withAccount } from "./percolator-v16-world.js";
import { crankOf, effectivePrice, legAssets, marketAt, portfolioAt, position, pushMark, tradeOf, u128At } from "./percolator-v16-crank-world.js";

/** Legs on all three assets between the four portfolios, prices moved over some slots with cranks between. */
export async function openAndMove(w: World, rng: Rng, label: string, slots = 12): Promise<void> {
  for (let n = 0; n < 14; n++) {
    const i = n % 4;
    const j = (i + 1 + rng.int(3)) % 4;
    const big = rng.chance(35);
    const size = (big ? BigInt(20 + rng.int(60)) * 1_000_000_000n : BigInt(1 + rng.int(5_000)) * 1_000_000n) * (rng.chance(50) ? 1n : -1n);
    const t = tradeOf(w, i, j, n % 3, size);
    await w.d.send(`${label} open ${n}`, t.payer, [t.ix]);
  }
  for (let s = 0; s < slots && w.d.data(w.m.market)[marketAt.group("mode")] === 0; s++) {
    w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
    w.refreshOracles(rng);
    // Half the slots move the marks against portfolio 0's positions, which is then left uncranked (its loss runs past
    // its capital: a bankrupt portfolio for the forfeits).
    const steer = s % 2 === 0;
    for (const a of [0, 1]) {
      const q = position(w, w.portfolios[0]!, a);
      const factor = steer && q !== 0n ? (q > 0n ? 9_400n : 10_600n) : BigInt(9_300 + rng.int(1_401));
      await pushMark(w, a, (effectivePrice(w, a) * factor) / 10_000n, `${label} push ${s}`);
    }
    for (let k = 0; k < 4; k++) {
      if (rng.chance(30) || (k === 0 && steer)) continue;
      const c = crankOf(w, k, legAssets(w, w.portfolios[k]!));
      await w.d.send(`${label} crank ${s} ${k}`, c.payer, [c.ix]);
    }
  }
}

/** The market put into Recovery in both VMs (the mode and a recorded reason), as a declaration leaves it. */
export function declareRecovery(w: World, reason = 5): void {
  w.d.patch(w.m.market, (b) => {
    b[marketAt.group("mode")] = 2;
    b[marketAt.group("recovery_reason") + 0] = 1;
    b[marketAt.group("recovery_reason") + 1] = reason;
  });
}

/** A u128 of the market's group header in one VM. */
function headerU128(b: Uint8Array, field: string): bigint {
  const at = marketAt.group(field);
  const v = Buffer.from(b);
  return v.readBigUInt64LE(at) | (v.readBigUInt64LE(at + 8) << 64n);
}

/**
 * The conservation the original's own tests assert (tests/invariants/cu/inv_024_attributed_quote_value_conservation.rs:
 * the vault's token balance equals the market's accounted vault on its one collateral rail, and the accounted vault
 * covers the senior claims), with the senior claims as `validate_header_aggregate_totals` defines them (capital,
 * insurance, the providers' earnings, the fresh backing in atoms). Checked in each VM on its own accounts. Returns the
 * violations ("reference: …" / "port: …").
 */
export function conservation(w: World): string[] {
  const out: string[] = [];
  for (const [name, vm] of [
    ["reference", w.d.reference],
    ["port", w.d.port],
  ] as const) {
    const m = vm.getAccount(w.m.market);
    const v = vm.getAccount(w.m.vault);
    if (!m.exists || !v.exists) continue;
    const vault = headerU128(m.data, "vault");
    const balance = Buffer.from(v.data).readBigUInt64LE(64);
    const senior = headerU128(m.data, "c_tot") + headerU128(m.data, "insurance") + headerU128(m.data, "backing_provider_earnings_total");
    const fresh = headerU128(m.data, "source_fresh_backing_total_num") / 1_000_000_000_000n;
    if (balance !== vault) out.push(`${name}: vault token balance ${balance} != accounted vault ${vault}`);
    if (senior + fresh > vault) out.push(`${name}: senior claims ${senior} + fresh backing ${fresh} > vault ${vault}`);
  }
  return out;
}

export const key = (got: string) => got.replace(/.*code: (\d+).*/, "custom $1").replace(/.*error: (\w+) }.*/, "$1");

/** The owners' forfeits and the cranks of a market in Recovery until a crank resolves it. Returns the round. */
export async function recoveryRounds(w: World, rng: Rng, outcomes: Map<string, number>): Promise<number> {
  for (let round = 0; round < 40; round++) {
    w.d.setClock(w.d.slot + BigInt(rng.chance(80) ? 1 : 1 + rng.int(30)), w.d.unixTimestamp + 1n);
    for (let kk = 0; kk < 4; kk++) {
      const p = w.portfolios[kk]!;
      const before = legAssets(w, p).length;
      // The owner forfeits a leg first, most of the time while legs remain (budgets small and large).
      if (before > 0 && rng.chance(round < 10 ? 95 : 60)) {
        const legs = legAssets(w, p);
        const asset = rng.chance(90) ? legs[rng.int(legs.length)]! : rng.int(4);
        const budget = rng.pick([1n, 1_000n, 1_000_000n, 1_000_000_000_000n, (1n << 128n) - 1n]);
        const got = await w.d.send(`forfeit round ${round} portfolio ${kk} asset ${asset} budget ${budget}`, w.owners[kk]!, [
          ix.forfeitRecoveryLeg(w.m, w.owners[kk]!, p, w.d.portfolioId(p), w.d.positionEpoch(p), asset, budget),
        ]);
        bump(outcomes, `ForfeitRecoveryLeg ${key(got)}`);
        continue;
      }
      if (round < 10 && rng.chance(85)) continue;
      // Hints are ignored in Recovery: none, the legs', or nonsense.
      const hints = rng.chance(60) ? [] : rng.chance(50) ? legAssets(w, p) : [rng.int(3)];
      const c = crankOf(w, kk, hints);
      const got = await w.d.send(`recovery round ${round} portfolio ${kk} legs ${before}`, c.payer, [c.ix]);
      const resolved = w.d.data(w.m.market)[marketAt.group("mode")] === 1;
      bump(outcomes, `Recovery crank ${key(got)}${resolved ? " (resolved)" : ""}`);
      if (resolved) return round;
    }
  }
  return -1;
}

export function bump(m: Map<string, number>, k: string, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

/**
 * The Resolved market: every portfolio closed out by its owner (the crank with or without a hint, or CloseResolved),
 * the payouts going to its token account; the conservation checked after each success. Returns what was paid.
 */
export async function closeOut(w: World, rng: Rng, outcomes: Map<string, number>, broken: string[]): Promise<bigint> {
  const closed = new Set<number>();
  let paid = 0n;
  for (let round = 0; round < 60 && closed.size < 4; round++) {
    w.d.setClock(w.d.slot + BigInt(rng.chance(70) ? 1 : 1 + rng.int(50)), w.d.unixTimestamp + 1n);
    for (let kk = 0; kk < 4; kk++) {
      if (closed.has(kk)) continue;
      const p = w.portfolios[kk]!;
      const owner = w.owners[kk]!;
      const dest = w.sources[kk]!;
      const before = w.d.data(dest).readBigUInt64LE(64);
      const tx = rng.chance(50) ? ix.resolvedCrank(w.m, owner, p, dest, rng.chance(30) ? rng.int(3) : undefined) : ix.closeResolved(w.m, owner, p, dest);
      const got = await w.d.send(`resolved round ${round} portfolio ${kk}`, owner, [tx]);
      bump(outcomes, `${tx.data![0] === 30 ? "CloseResolved" : "Resolved crank"} ${key(got)}`);
      if (got === "ok") broken.push(...conservation(w));
      const after = w.d.data(dest).readBigUInt64LE(64);
      if (after > before) {
        paid += after - before;
        bump(outcomes, "payouts");
        const b = w.d.data(p);
        if (b[portfolioAt("resolved_payout_receipt") + 64] === 1) bump(outcomes, "payouts with a receipt");
      }
      const b = w.d.data(p);
      if (
        b.readBigUInt64LE(portfolioAt("capital")) === 0n &&
        legAssets(w, p).length === 0 &&
        b[portfolioAt("resolved_payout_receipt") + 64] !== 1 &&
        got !== "ok"
      )
        closed.add(kk);
    }
  }
  return paid;
}

/** ResolveMarket by the market authority, with cranks of every portfolio between refusals (a pending accrual). */
export async function adminResolve(w: World, rng: Rng, outcomes: Map<string, number>): Promise<boolean> {
  for (let n = 0; n < 12; n++) {
    const a = w.marketAuthority();
    const got = await w.d.send(`ResolveMarket ${n}`, a, [ix.resolveMarket(w.m, a, w.u64At(marketAt.group("next_market_id")), w.epoch(0))]);
    bump(outcomes, `ResolveMarket ${key(got)}`);
    if (got === "ok") return true;
    w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
    w.refreshOracles(rng);
    for (let kk = 0; kk < 4; kk++) {
      const c = crankOf(w, kk, legAssets(w, w.portfolios[kk]!));
      bump(outcomes, `crank before resolution ${key(await w.d.send(`crank before ResolveMarket ${n} ${kk}`, c.payer, [c.ix]))}`);
    }
  }
  return false;
}

/**
 * ResolveStalePermissionless: the stale window shortened to `stale` slots by the market authority, the Clock moved past
 * it, then the resolution, with cranks between refusals (a matured resolution's terminal accrual).
 */
export async function staleResolve(w: World, rng: Rng, outcomes: Map<string, number>): Promise<boolean> {
  const a = w.marketAuthority();
  const stale = BigInt(20 + rng.int(40));
  await w.d.ok("ConfigurePermissionlessResolve (short window)", a, [
    ix.permissionlessResolve(w.m, a, w.u64At(marketAt.group("next_market_id")), stale, 10n, w.seq(0, "permissionlessResolve") + 1n, w.epoch(0)),
  ]);
  const last = w.d.data(w.m.market).readBigUInt64LE(marketAt.wrapper("last_good_oracle_slot"));
  w.d.setClock(last + stale + BigInt(rng.int(5)), w.d.unixTimestamp + stale);
  for (let n = 0; n < 12; n++) {
    const got = await w.d.send(`ResolveStalePermissionless ${n}`, w.stranger, [ix.resolveStalePermissionless(w.m)]);
    bump(outcomes, `ResolveStalePermissionless ${key(got)}`);
    if (got === "ok") return true;
    for (let kk = 0; kk < 4; kk++) {
      const legs = legAssets(w, w.portfolios[kk]!);
      // A matured resolution takes hints without oracle accounts.
      const c = {
        payer: w.stranger,
        ix: ix.crank(
          w.m,
          w.stranger,
          w.portfolios[kk]!,
          0n,
          legs.map((asset) => ({ asset, accounts: 0 })),
        ),
      };
      bump(outcomes, `matured crank ${key(await w.d.send(`matured crank ${n} ${kk}`, c.payer, [c.ix]))}`);
    }
    w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
  }
  return false;
}

const isSigner = (r: AccountRole) => r === AccountRole.READONLY_SIGNER || r === AccountRole.WRITABLE_SIGNER;
const isWritable = (r: AccountRole) => r === AccountRole.WRITABLE || r === AccountRole.WRITABLE_SIGNER;
const roleOf = (signer: boolean, writable: boolean) =>
  signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : writable ? AccountRole.WRITABLE : AccountRole.READONLY;
const BOUNDARY = [0n, 1n, 2n, 0xffn, 0xffffn, 0xffff_ffffn, 1n << 63n, (1n << 64n) - 1n, (1n << 127n) - 1n, (1n << 128n) - 1n];

/**
 * Every account position of `base` (each ordered pair repeated, each signer and writable flag dropped, each position
 * replaced by each account of the world, the list cut to each length and one longer) and its data (each field-sized
 * window of the body set to boundary values), each compared whole from the world's snapshot.
 */
export async function sweep(w: World, rng: Rng, name: string, payer: KeyPairSigner, base: Instruction, tally: { sent: number; ok: number }): Promise<void> {
  w.take();
  const accounts = base.accounts ?? [];
  const n = accounts.length;
  const variants: [string, Instruction][] = [[`${name} as built`, base]];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j) {
        const ai = accounts[i]!;
        const aj = accounts[j]!;
        if (ai.address === PROGRAM && isWritable(aj.role)) continue;
        variants.push([
          `position ${i} again at ${j}`,
          withAccount(w, base, j, ai.address, roleOf(isSigner(aj.role) || isSigner(ai.role), isWritable(aj.role))),
        ]);
      }
  for (let j = 0; j < n; j++) {
    const aj = accounts[j]!;
    if (isSigner(aj.role)) variants.push([`position ${j} not signing`, withAccount(w, base, j, aj.address, roleOf(false, isWritable(aj.role)))]);
    if (isWritable(aj.role)) variants.push([`position ${j} read-only`, withAccount(w, base, j, aj.address, roleOf(isSigner(aj.role), false))]);
    for (const other of w.pool())
      if (other !== aj.address && !(other === PROGRAM && isWritable(aj.role)))
        variants.push([`position ${j} = ${other.slice(0, 6)}`, withAccount(w, base, j, other, aj.role)]);
  }
  for (let k = 0; k < n; k++) variants.push([`${k} accounts`, { ...base, accounts: accounts.slice(0, k) }]);
  variants.push([`one more account`, { ...base, accounts: [...accounts, { address: w.m.market, role: AccountRole.WRITABLE }] }]);
  const data = Buffer.from(base.data ?? new Uint8Array());
  for (let at = 1; at < data.length; at++)
    for (const size of [1, 2, 8, 16])
      if (at + size <= data.length && rng.chance(40)) {
        const v = BOUNDARY[rng.int(BOUNDARY.length)]!;
        const d = Buffer.from(data);
        for (let b = 0; b < size; b++) d[at + b] = Number((v >> BigInt(8 * b)) & 0xffn);
        variants.push([`data at ${at} (${size} bytes) = ${v}`, { ...base, data: new Uint8Array(d) }]);
      }
  for (const [label, v] of variants) {
    const got = await w.d.send(`${name}: ${label}`, payer, [v]);
    tally.sent++;
    if (got === "ok") tally.ok++;
    w.restore();
  }
}

const BIG = 1_000_000_000_000_000n;

/** A market field of asset `asset`'s engine slot (u128 or u64 by `size`). */
export function engineField(w: World, asset: number, field: string, size = 16): bigint {
  const b = w.d.data(w.m.market);
  const at = marketAt.engine(asset, field);
  return size === 16 ? u128At(b, at) : size === 8 ? b.readBigUInt64LE(at) : BigInt(b[at]!);
}

/**
 * The insurance and backing instructions' traffic on a world (percolator-v16-reserves.test.ts and the walks): each
 * role's signer, a funded source token account and a destination of each beneficiary, a backing ledger per domain and
 * an insurance ledger per insurance authority (zeroed accounts of the program, created by the first instruction that
 * names them), and valid-looking transactions of each instruction with arguments drawn around the state's values.
 */
export class Reserves {
  sources = new Map<Address, Address>();
  dests = new Map<Address, Address>();
  backingLedgers: Address[] = [];
  insuranceLedgers = new Map<Address, Address>();
  lastName = "";
  private constructor(readonly w: World) {}

  static async create(w: World): Promise<Reserves> {
    const r = new Reserves(w);
    await r.accounts();
    return r;
  }

  /** The token accounts of every role signer of the configured assets, and the ledgers. */
  async accounts(): Promise<void> {
    const w = this.w;
    // The vault in the snapshots (a PDA's token account, not one of the world's keys): a sweep restores its balance.
    if (!w.accounts.includes(w.m.vault)) w.accounts.push(w.m.vault);
    const signers = new Set<KeyPairSigner>([w.marketAuthority()]);
    for (const asset of [0, 1, 2])
      for (const role of ["insurance_authority", "insurance_operator", "backing_bucket_authority"]) signers.add(w.roleAuthority(asset, role));
    for (const s of signers) {
      if (this.sources.has(s.address)) continue;
      this.sources.set(s.address, await w.d.tokenAccount(w.m.mint, s.address, BIG));
      this.dests.set(s.address, await w.d.tokenAccount(w.m.mint, s.address, 0n));
      w.accounts.push(this.sources.get(s.address)!, this.dests.get(s.address)!);
      const l = await w.d.address();
      w.d.write(l, PROGRAM, new Uint8Array(176));
      w.accounts.push(l);
      this.insuranceLedgers.set(s.address, l);
    }
    for (let d = 0; d < 6; d++) {
      const l = await w.d.address();
      w.d.write(l, PROGRAM, new Uint8Array(240));
      w.accounts.push(l);
      this.backingLedgers.push(l);
    }
  }

  /** Backing fee policies on some domains (only while their buckets are empty: UpdateBackingFeePolicy's rule). */
  async policies(rng: Rng): Promise<void> {
    const w = this.w;
    for (let domain = 0; domain < 6; domain++) {
      if (rng.chance(30)) continue;
      const asset = domain >> 1;
      const ins = w.roleAuthority(asset, "insurance_authority");
      const fee = 1 + rng.int(rng.chance(50) ? 20 : 300);
      const b = w.seq(asset, "backingFee");
      const e = w.epoch(asset);
      await w.d.send(`backing fee policy ${domain}`, ins, [
        ix.backingFeePolicy(w.m, ins, domain, w.marketId(asset), fee, rng.int(10_001), (b > e ? b : e) + 1n, e),
      ]);
    }
  }

  /** Insurance on every asset and fresh backing on every domain, so the later steps have reserves to work on. */
  async fund(rng: Rng, o: { insurance?: bigint; expiry?: bigint; domains?: number[] } = {}): Promise<void> {
    const ins = o.insurance ?? 50_000_000_000n;
    if (ins !== 0n) {
      for (let asset = 0; asset < 3; asset++) await this.w.d.send(`fund insurance ${asset}`, ...this.insurance(rng, asset * 2, ins, true));
      await this.w.d.send("fund insurance base", ...this.insurance(rng, undefined, ins, true));
    }
    for (const domain of o.domains ?? [0, 1, 2, 3, 4, 5])
      await this.w.d.send(`fund backing ${domain}`, ...this.backing(rng, domain, 30_000_000_000n, true, o.expiry));
  }

  private policy(domain: number): [number, number] {
    const asset = domain >> 1;
    const side = domain % 2 === 0 ? "long" : "short";
    const b = this.w.d.data(this.w.m.market);
    return [
      b.readUInt16LE(marketAt.profile(asset, `backing_trade_fee_bps_${side}`)),
      b.readUInt16LE(marketAt.profile(asset, `backing_trade_fee_insurance_share_bps_${side}`)),
    ];
  }

  private bucketExpiry(domain: number): bigint | undefined {
    const side = domain % 2 === 0 ? "backing_long" : "backing_short";
    const asset = domain >> 1;
    if (asset > 2) return undefined;
    const status = engineField(this.w, asset, `${side}.status`, 1);
    const expiry = engineField(this.w, asset, `${side}.expiry_slot`, 8);
    return status === 1n ? expiry : undefined;
  }

  /** A TopUpInsurance (no domain) or TopUpInsuranceDomain of `amount` (drawn when not given). */
  insurance(rng: Rng, domain: number | undefined, amount?: bigint, valid = false): [KeyPairSigner, Instruction[]] {
    const w = this.w;
    const asset = domain === undefined ? 0 : Math.min(domain >> 1, 3);
    const signer = valid || rng.chance(90) ? w.roleAuthority(Math.min(asset, 2), "insurance_authority") : w.stranger;
    const intent = w.u64At(marketAt.slot(Math.min(asset, 3)) + 424 + 72) + (valid || rng.chance(92) ? 1n + BigInt(rng.int(3)) : 0n);
    const a = amount ?? rng.pick([0n, 1n, 2n, 3n, 999n, 1_000_000n, BigInt(rng.int(1_000_000_000)), 50_000_000_000n, 1n << 64n]);
    const ledger = valid || rng.chance(70) ? this.insuranceLedgers.get(signer.address) : undefined;
    return [
      signer,
      [
        ix.topUpInsurance(
          w.m,
          signer,
          this.sources.get(signer.address) ?? w.sources[0]!,
          { domain, marketId: w.marketId(Math.min(asset, 2)) + (valid || rng.chance(95) ? 0n : 1n), intent, epoch: w.epoch(Math.min(asset, 2)), amount: a },
          ledger,
        ),
      ],
    ];
  }

  /** A TopUpBackingBucket on `domain` of `amount` (drawn when not given), at the bucket's expiry or a new one. */
  backing(rng: Rng, domain: number, amount?: bigint, valid = false, expiryOverride?: bigint): [KeyPairSigner, Instruction[]] {
    const w = this.w;
    const asset = Math.min(domain >> 1, 2);
    const signer = valid || rng.chance(92) ? w.roleAuthority(asset, "backing_bucket_authority") : w.stranger;
    const intent = w.u64At(marketAt.slot(asset) + 424 + 80) + (valid || rng.chance(92) ? 1n + BigInt(rng.int(3)) : 0n);
    const [fee, share] = this.policy(Math.min(domain, 5));
    const current = this.bucketExpiry(domain);
    const now = w.d.slot > w.u64At(marketAt.group("current_slot")) ? w.d.slot : w.u64At(marketAt.group("current_slot"));
    const expiry =
      current !== undefined && (valid || rng.chance(85))
        ? current
        : expiryOverride !== undefined
          ? expiryOverride
          : rng.pick([now + BigInt(10 + rng.int(3_000)), now + 50_000n, now, now - 1n, (1n << 64n) - 1n]);
    const a = amount ?? rng.pick([0n, 1n, 1_000n, 1_000_000n, BigInt(rng.int(1_000_000_000)), 20_000_000_000n, 1n << 64n]);
    return [
      signer,
      [
        ix.topUpBacking(
          w.m,
          signer,
          this.sources.get(signer.address) ?? w.sources[0]!,
          {
            domain,
            marketId: w.marketId(asset),
            intent,
            epoch: w.epoch(asset),
            fee: valid || rng.chance(95) ? fee : fee + 1,
            share: valid || rng.chance(97) ? share : 1,
            amount: a,
            expiry,
          },
          valid || rng.chance(70) ? this.backingLedgers[Math.min(domain, 5)] : undefined,
        ),
      ],
    ];
  }

  /** A WithdrawBackingBucket of part of the domain's fresh unliened backing (or more). */
  withdrawBacking(rng: Rng, domain: number, valid = false): [KeyPairSigner, Instruction[]] {
    const w = this.w;
    const asset = Math.min(domain >> 1, 2);
    const side = domain % 2 === 0 ? "backing_long" : "backing_short";
    const fresh = engineField(w, asset, `${side}.fresh_unliened_backing_num`) / 1_000_000_000_000n;
    const beneficiary = w.roleAuthority(asset, "backing_bucket_authority");
    const signer = valid || rng.chance(85) ? beneficiary : rng.chance(50) ? w.marketAuthority() : w.stranger;
    const amount = valid ? fresh / 4n + 1n : rng.pick([1n, fresh / 2n || 1n, fresh || 1n, fresh + 1n, (1n << 64n) - 1n, 0n]);
    const epochAsset = signer === beneficiary ? asset : 0;
    return [
      signer,
      [
        ix.withdrawReserve(
          50,
          w.m,
          valid || rng.chance(95) ? signer : signer.address,
          this.dests.get(beneficiary.address)!,
          { index: domain, marketId: w.marketId(asset), epoch: w.epoch(epochAsset), amount },
          valid || rng.chance(70) ? this.backingLedgers[Math.min(domain, 5)] : undefined,
        ),
      ],
    ];
  }

  /** A WithdrawBackingBucketEarnings of part of the bucket's earnings (or more). */
  withdrawEarnings(rng: Rng, domain: number, valid = false): [KeyPairSigner, Instruction[]] {
    const w = this.w;
    const asset = Math.min(domain >> 1, 2);
    const side = domain % 2 === 0 ? "backing_long" : "backing_short";
    const earned = engineField(w, asset, `${side}.utilization_fee_earnings`);
    const beneficiary = w.roleAuthority(asset, "backing_bucket_authority");
    const signer = valid || rng.chance(90) ? beneficiary : w.stranger;
    const amount = valid ? earned / 2n + 1n : rng.pick([1n, earned / 2n || 1n, earned || 1n, earned + 1n, 0n]);
    return [
      signer,
      [
        ix.withdrawEarnings(w.m, signer, this.backingLedgers[Math.min(domain, 5)]!, this.dests.get(beneficiary.address)!, {
          index: domain,
          marketId: w.marketId(asset),
          epoch: w.epoch(signer === beneficiary ? asset : 0),
          amount,
        }),
      ],
    ];
  }

  /** A WithdrawInsuranceAsset of part of the asset's withdrawable insurance (or more). */
  withdrawInsurance(rng: Rng, asset: number, valid = false): [KeyPairSigner, Instruction[]] {
    const w = this.w;
    const a = Math.min(asset, 2);
    const budget = engineField(w, a, "insurance_domain_budget_long") + engineField(w, a, "insurance_domain_budget_short");
    const spent = engineField(w, a, "insurance_domain_spent_long") + engineField(w, a, "insurance_domain_spent_short");
    const left = budget > spent ? budget - spent : 0n;
    const resolved = w.d.data(w.m.market)[marketAt.group("mode")] === 1;
    const beneficiary = w.roleAuthority(a, resolved ? "insurance_authority" : "insurance_operator");
    const signer = valid || rng.chance(85) ? beneficiary : rng.chance(50) ? w.marketAuthority() : w.stranger;
    const amount = valid ? left / 3n + 1n : rng.pick([1n, left / 2n || 1n, left || 1n, left + 1n, (1n << 64n) - 1n, 0n]);
    const ledgerOwner = w.roleAuthority(a, "insurance_authority");
    return [
      signer,
      [
        ix.withdrawReserve(
          57,
          w.m,
          resolved && rng.chance(50) ? signer.address : signer,
          this.dests.get(beneficiary.address)!,
          { index: asset, marketId: w.marketId(a), epoch: w.epoch(signer === beneficiary || resolved ? a : 0), amount },
          valid || rng.chance(60) ? this.insuranceLedgers.get(ledgerOwner.address) : undefined,
        ),
      ],
    ];
  }

  /** One of the six instructions (or a backing-ledger sync) with drawn arguments: its tag, signer and instruction. */
  next(rng: Rng): { tag: number; payer: KeyPairSigner; ix: Instruction } {
    const k = rng.int(100);
    const domain = rng.chance(95) ? rng.int(6) : 6 + rng.int(3);
    let t: [KeyPairSigner, Instruction[]];
    let tag = 0;
    if (k < 15) [tag, this.lastName, t] = [9, "TopUpInsurance", this.insurance(rng, undefined)];
    else if (k < 28) [tag, this.lastName, t] = [56, "TopUpInsuranceDomain", this.insurance(rng, domain)];
    else if (k < 52) [tag, this.lastName, t] = [24, "TopUpBackingBucket", this.backing(rng, domain)];
    else if (k < 70) [tag, this.lastName, t] = [50, "WithdrawBackingBucket", this.withdrawBacking(rng, domain)];
    else if (k < 80) [tag, this.lastName, t] = [52, "WithdrawBackingBucketEarnings", this.withdrawEarnings(rng, domain)];
    else if (k < 95) [tag, this.lastName, t] = [57, "WithdrawInsuranceAsset", this.withdrawInsurance(rng, rng.chance(95) ? rng.int(3) : 3)];
    else {
      const a = this.w.roleAuthority(Math.min(domain >> 1, 2), "backing_bucket_authority");
      [tag, this.lastName, t] = [53, "SyncBackingDomainLedger", [a, [ix.syncBackingLedger(this.w.m, a, this.backingLedgers[Math.min(domain, 5)]!, domain)]]];
    }
    return { tag, payer: t[0], ix: t[1][0]! };
  }

  /** `next`, sent and compared. */
  async random(rng: Rng, n: number): Promise<string> {
    const t = this.next(rng);
    return this.w.d.send(`${this.lastName} ${n}`, t.payer, [t.ix]);
  }

  /** Trades between the portfolios, a pushed mark and cranks: what puts liens on backing and earns its fees. */
  async traffic(rng: Rng, n: number): Promise<void> {
    const w = this.w;
    const i = rng.int(4);
    const j = (i + 1 + rng.int(3)) % 4;
    const size = BigInt(1 + rng.int(rng.chance(30) ? 50_000 : 2_000)) * 1_000_000n * (rng.chance(50) ? 1n : -1n);
    const t = tradeOf(w, i, j, rng.int(3), size);
    await w.d.send(`traffic trade ${n}`, t.payer, [t.ix]);
    const a = rng.int(2);
    await pushMark(w, a, (effectivePrice(w, a) * BigInt(9_500 + rng.int(1_001))) / 10_000n, `traffic push ${n}`);
    for (let k = 0; k < 4; k++)
      if (rng.chance(50)) {
        const c = crankOf(w, k, legAssets(w, w.portfolios[k]!));
        await w.d.send(`traffic crank ${n} ${k}`, c.payer, [c.ix]);
      }
  }

  /**
   * The exact drains of a market whose portfolios are gone: each domain's earnings in full and each asset's insurance
   * budget left (budget less spent), by their beneficiaries. Returns what succeeded.
   */
  async drain(label: string, outcomes: Map<string, number>): Promise<number> {
    const w = this.w;
    let ok = 0;
    for (let domain = 0; domain < 6; domain++) {
      const asset = domain >> 1;
      const side = domain % 2 === 0 ? "backing_long" : "backing_short";
      const earned = engineField(w, asset, `${side}.utilization_fee_earnings`);
      if (earned === 0n) continue;
      const b = w.roleAuthority(asset, "backing_bucket_authority");
      const got = await w.d.send(`${label} earnings ${domain}`, b, [
        ix.withdrawEarnings(w.m, b, this.backingLedgers[domain]!, this.dests.get(b.address)!, {
          index: domain,
          marketId: w.marketId(asset),
          epoch: w.epoch(asset),
          amount: earned,
        }),
      ]);
      bump(outcomes, `WithdrawBackingBucketEarnings (drain) ${key(got)}`);
      if (got === "ok") ok++;
    }
    for (let asset = 0; asset < 3; asset++) {
      const left = (d: string) => {
        const budget = engineField(w, asset, `insurance_domain_budget_${d}`);
        const spent = engineField(w, asset, `insurance_domain_spent_${d}`);
        return budget > spent ? budget - spent : 0n;
      };
      const amount = left("long") + left("short");
      if (amount === 0n) continue;
      const ins = w.roleAuthority(asset, "insurance_authority");
      const got = await w.d.send(`${label} insurance ${asset}`, w.stranger, [
        ix.withdrawReserve(57, w.m, ins.address, this.dests.get(ins.address)!, { index: asset, marketId: w.marketId(asset), epoch: w.epoch(asset), amount }),
      ]);
      bump(outcomes, `WithdrawInsuranceAsset (drain) ${key(got)}`);
      if (got === "ok") ok++;
    }
    return ok;
  }

  /** A valid transaction of each instruction in the current state, for the sweeps (they may still be refused). */
  successes(): { name: string; payer: KeyPairSigner; ix: Instruction }[] {
    const rng = { int: () => 0, chance: () => true, pick: <T>(xs: T[]) => xs[0]! } as unknown as Rng;
    const out: { name: string; payer: KeyPairSigner; ix: Instruction }[] = [];
    const add = (name: string, t: [KeyPairSigner, Instruction[]]) => out.push({ name, payer: t[0], ix: t[1][0]! });
    add("TopUpInsurance", this.insurance(rng, undefined, 1_000_000n, true));
    add("TopUpInsuranceDomain", this.insurance(rng, 3, 1_000_001n, true));
    add("TopUpBackingBucket", this.backing(rng, 2, 1_000_000n, true));
    add("WithdrawBackingBucket", this.withdrawBacking(rng, 2, true));
    add("WithdrawBackingBucketEarnings", this.withdrawEarnings(rng, 0, true));
    add("WithdrawInsuranceAsset", this.withdrawInsurance(rng, 1, true));
    return out;
  }
}

/** ClaimResolvedPayoutTopup by each portfolio's owner key (it needs no signature), to its token account. */
export async function claims(w: World, rng: Rng, outcomes: Map<string, number>, broken: string[], label: string): Promise<void> {
  for (let k = 0; k < w.portfolios.length; k++) {
    const p = w.portfolios[k]!;
    if (!w.d.reference.getAccount(p).exists || w.d.data(p).length < 9555) continue;
    const owner = rng.chance(70) ? w.owners[k]! : w.owners[k]!.address;
    const before = w.d.amount(w.sources[k]!);
    const got = await w.d.send(`${label} claim ${k}`, w.stranger, [ix.claimPayoutTopup(w.m, owner, p, rng.chance(90) ? w.sources[k]! : undefined)]);
    bump(outcomes, `ClaimResolvedPayoutTopup ${key(got)}`);
    if (w.d.amount(w.sources[k]!) > before) bump(outcomes, "ClaimResolvedPayoutTopup paid");
    if (got === "ok") broken.push(...conservation(w));
  }
}

/**
 * The end of a Resolved market: the reserves' resolved withdrawals and the claims between, every portfolio closed by
 * the market authority (ClosePortfolio), then CloseSlab until the market is a tombstone (its scan steps, expiries and
 * recredits on the way), the Clock moving between. Returns whether the market was closed.
 */
export async function windDown(w: World, rng: Rng, r: Reserves, outcomes: Map<string, number>, broken: string[]): Promise<boolean> {
  const a = w.marketAuthority();
  const dest = await w.d.tokenAccount(w.m.mint, a.address, 0n);
  w.accounts.push(dest);
  // The vault is closed by the last CloseSlab: kept in the snapshots (a PDA's account, not one of the world's keys).
  if (!w.accounts.includes(w.m.vault)) w.accounts.push(w.m.vault);
  for (let round = 0; round < 6; round++) {
    await claims(w, rng, outcomes, broken, `wind-down ${round}`);
    for (let n = 0; n < 3; n++) {
      const got = await r.random(rng, 1000 + round * 10 + n);
      bump(outcomes, `${r.lastName} (Resolved) ${key(got)}`);
      if (got === "ok") broken.push(...conservation(w));
    }
    w.d.setClock(w.d.slot + BigInt(1 + rng.int(40)), w.d.unixTimestamp + 1n);
  }
  for (let k = 0; k < w.portfolios.length; k++) {
    const p = w.portfolios[k]!;
    if (!w.d.reference.getAccount(p).exists || w.d.data(p).length < 9555) continue;
    const got = await w.d.send(`wind-down ClosePortfolio ${k}`, a, [
      ix.closePortfolio(w.m, a, p, w.d.portfolioId(p), w.d.portfolioSequence(p), w.d.positionEpoch(p)),
    ]);
    bump(outcomes, `ClosePortfolio (Resolved) ${key(got)}`);
  }
  let refused = 0;
  for (let n = 0; n < 60; n++) {
    const m = w.d.reference.getAccount(w.m.market);
    if (m.exists && m.data.length === 16) return true;
    if (rng.chance(30)) {
      const got = await r.random(rng, 2000 + n);
      bump(outcomes, `${r.lastName} (closing) ${key(got)}`);
    }
    if (n >= 4 || rng.chance(40)) await r.drain(`wind-down ${n}`, outcomes);
    const got = await w.d.send(`CloseSlab ${n}`, a, [ix.closeSlab(w.m, a, dest, w.epoch(0), [w.m.mint])]);
    bump(outcomes, `CloseSlab ${key(got)}${got === "ok" && w.d.data(w.m.market).length === 16 ? " (closed)" : ""}`);
    if (got === "ok" && w.d.data(w.m.market).length > 16) broken.push(...conservation(w));
    refused = got === "ok" ? 0 : refused + 1;
    // A live Fresh bucket parks the scan until its (effective) expiry: past it after a few refusals.
    w.d.setClock(w.d.slot + (refused >= 3 ? 20_000n : BigInt(rng.chance(60) ? 1 : 1 + rng.int(500))), w.d.unixTimestamp + 1n);
  }
  const m = w.d.reference.getAccount(w.m.market);
  return m.exists && m.data.length === 16;
}
