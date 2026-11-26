// The authority, policy and ledger instructions of the Percolator v16 port (showcase/mainnet/percolator-v16) against
// the reference: Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so is the Rust build of those commits, not a
// deployed program. Every transaction is compared whole (percolator-v16-helpers.ts `Diff`); the port must use fewer
// compute units on each success. Each instruction: its success paths, then each refusal of its own checks in order.
import { type Address, type Instruction, type KeyPairSigner, AccountRole } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { Diff, HAVE_PORT, HAVE_REFERENCE, type Market, PROGRAM, err, errB, ix, r, s } from "./percolator-v16-helpers.js";
import { mintBytes, tokenAccountBytes, TOKEN } from "./percolator-helpers.js";
import { pda } from "../../test/harness.js";
import { ATA_PROGRAM } from "./percolator-v16-helpers.js";

/** PercolatorError codes. */
const E = {
  ExpectedSigner: 6,
  ExpectedWritable: 7,
  Unauthorized: 8,
  InvalidInstruction: 9,
  InvalidMint: 10,
  InvalidAccountLen: 5,
  EngineStale: 19,
  EngineLockActive: 21,
  OracleStale: 27,
  AssetGenerationMismatch: 30,
} as const;

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: authority, policy and ledger instructions", () => {
  let d: Diff;
  let m: Market;
  beforeAll(async () => {
    d = await Diff.create();
    m = await d.market({ capacity: 3, args: { maxPortfolioAssets: 2, maxTradingFeeBps: 500n } });
  });

  it("the market-authority policies (37, 49, 58, 59): success, the sequence, the epoch, every check", async () => {
    const a = m.admin;
    for (const tag of [37, 49, 58] as const) {
      await d.ok(`policy ${tag} 500`, a, [ix.marketPolicy(m, a, tag, 500n, 1n, 0n)]);
      await d.ok(`policy ${tag} 10000`, a, [ix.marketPolicy(m, a, tag, 10_000n, 7n, 0n)]);
      await d.fails(`policy ${tag} stale sequence`, a, [ix.marketPolicy(m, a, tag, 1n, 7n, 0n)], err(E.EngineStale));
      await d.fails(`policy ${tag} above 10000`, a, [ix.marketPolicy(m, a, tag, 10_001n, 8n, 0n)], err(E.InvalidInstruction));
      await d.fails(`policy ${tag} wrong epoch`, a, [ix.marketPolicy(m, a, tag, 1n, 8n, 1n)], err(E.EngineStale));
    }
    await d.ok("policy 59 u64::MAX", a, [ix.marketPolicy(m, a, 59, 0xffff_ffff_ffff_ffffn, 1n, 0n)]);
    await d.fails("policy 59 above u64", a, [ix.marketPolicy(m, a, 59, 1n << 64n, 2n, 0n)], err(E.InvalidInstruction));
    const stranger = await d.funded();
    await d.fails("policy by another signer", stranger, [ix.marketPolicy(m, stranger, 37, 1n, 9n, 0n)], err(E.Unauthorized));
    const unsigned = replaced(ix.marketPolicy(m, a, 37, 1n, 9n, 0n), 0, a.address);
    await d.fails("policy unsigned", stranger, [unsigned], err(E.ExpectedSigner));
    const readonly = replaced(ix.marketPolicy(m, a, 37, 1n, 9n, 0n), 1, m.market);
    await d.fails("policy, market read-only", a, [readonly], err(E.ExpectedWritable));
    const other = await d.newMarket();
    await d.fails("policy on an uninitialized market", a, [ix.marketPolicy(other, a, 37, 1n, 9n, 0n)], errB("InstructionErrorCustom { code: 3 }"));
  });

  it("UpdateTradeFeePolicy (55)", async () => {
    const a = m.admin;
    await d.ok("trade fee 100", a, [ix.tradeFeePolicy(m, a, 100n, 1n, 0n)]);
    await d.ok("trade fee 500 (the market's maximum)", a, [ix.tradeFeePolicy(m, a, 500n, 2n, 0n)]);
    await d.fails("trade fee above the maximum", a, [ix.tradeFeePolicy(m, a, 501n, 3n, 0n)], err(E.InvalidInstruction));
    await d.fails("trade fee stale sequence", a, [ix.tradeFeePolicy(m, a, 1n, 2n, 0n)], err(E.EngineStale));
    await d.fails("trade fee wrong epoch", a, [ix.tradeFeePolicy(m, a, 1n, 3n, 5n)], err(E.EngineStale));
    const stranger = await d.funded();
    await d.fails("trade fee by another signer", stranger, [ix.tradeFeePolicy(m, stranger, 1n, 3n, 0n)], err(E.Unauthorized));
  });

  it("UpdateBackingFeePolicy (51): both sides of both assets, the policy count, every check", async () => {
    const a = m.admin;
    await d.ok("backing fee asset 0 long 100/50", a, [ix.backingFeePolicy(m, a, 0, 1n, 100, 50, 1n, 0n)]);
    await d.ok("backing fee asset 0 short 200/0", a, [ix.backingFeePolicy(m, a, 1, 1n, 200, 0, 2n, 0n)]);
    await d.ok("backing fee asset 1 long 300/10000", a, [ix.backingFeePolicy(m, a, 2, 2n, 300, 10_000, 1n, 0n)]);
    await d.ok("backing fee asset 1 short 500/0", a, [ix.backingFeePolicy(m, a, 3, 2n, 500, 0, 2n, 0n)]);
    await d.ok("backing fee asset 0 long back to 0", a, [ix.backingFeePolicy(m, a, 0, 1n, 0, 0, 3n, 0n)]);
    await d.ok("backing fee asset 1 short back to 0", a, [ix.backingFeePolicy(m, a, 3, 2n, 0, 0, 3n, 0n)]);
    await d.ok("backing fee unchanged", a, [ix.backingFeePolicy(m, a, 2, 2n, 300, 10_000, 4n, 0n)]);
    await d.fails("backing fee above the maximum trading fee", a, [ix.backingFeePolicy(m, a, 0, 1n, 501, 0, 5n, 0n)], err(E.InvalidInstruction));
    await d.fails("backing fee share without a fee", a, [ix.backingFeePolicy(m, a, 0, 1n, 0, 1, 5n, 0n)], err(E.InvalidInstruction));
    await d.fails("backing fee share above 10000", a, [ix.backingFeePolicy(m, a, 0, 1n, 1, 10_001, 5n, 0n)], err(E.InvalidInstruction));
    await d.fails("backing fee wrong generation", a, [ix.backingFeePolicy(m, a, 0, 2n, 1, 0, 5n, 0n)], err(E.AssetGenerationMismatch));
    await d.fails("backing fee unconfigured asset", a, [ix.backingFeePolicy(m, a, 4, 3n, 1, 0, 5n, 0n)], err(E.InvalidInstruction));
    await d.fails("backing fee stale sequence", a, [ix.backingFeePolicy(m, a, 0, 1n, 1, 0, 3n, 0n)], err(E.EngineStale));
    await d.fails("backing fee wrong epoch", a, [ix.backingFeePolicy(m, a, 0, 1n, 1, 0, 9n, 4n)], err(E.EngineStale));
    const stranger = await d.funded();
    await d.fails("backing fee by another signer", stranger, [ix.backingFeePolicy(m, stranger, 0, 1n, 1, 0, 9n, 0n)], err(E.Unauthorized));
  });

  it("UpdateAssetAuthority (65) and UpdateAuthority (32)", async () => {
    const a = m.admin;
    const insurer = await d.funded();
    await d.ok("asset 1 insurance authority", a, [ix.updateAssetAuthority(m, a, s(insurer), 1, 2n, 0n, 1, insurer.address)]);
    await d.fails("asset 1 kind 5", a, [ix.updateAssetAuthority(m, a, s(insurer), 1, 2n, 1n, 5, insurer.address)], err(E.InvalidInstruction));
    await d.fails("asset 1 zero oracle", a, [ix.updateAssetAuthority(m, a, r(insurer.address), 1, 2n, 1n, 4, ZERO)], err(E.InvalidInstruction));
    await d.fails("asset 1 wrong generation", a, [ix.updateAssetAuthority(m, a, s(insurer), 1, 1n, 1n, 1, insurer.address)], err(E.AssetGenerationMismatch));
    await d.fails("asset 2 (not configured)", a, [ix.updateAssetAuthority(m, a, s(insurer), 2, 3n, 0n, 1, insurer.address)], err(E.InvalidInstruction));
    await d.fails("asset 1 incoming not signing", a, [ix.updateAssetAuthority(m, a, r(insurer.address), 1, 2n, 1n, 2, insurer.address)], err(E.ExpectedSigner));
    const stranger = await d.funded();
    await d.fails("asset 1 incoming another key", a, [ix.updateAssetAuthority(m, a, s(stranger), 1, 2n, 1n, 2, insurer.address)], err(E.Unauthorized));
    await d.fails("asset 1 by a stranger", stranger, [ix.updateAssetAuthority(m, stranger, s(insurer), 1, 2n, 1n, 2, insurer.address)], err(E.Unauthorized));
    await d.ok("asset 1 operator by the incumbent insurer's admin", a, [ix.updateAssetAuthority(m, a, s(insurer), 1, 2n, 1n, 2, insurer.address)]);
    await d.ok("asset 1 admin burned", a, [ix.updateAssetAuthority(m, a, r(ZERO), 1, 2n, 2n, 0, ZERO)]);
    await d.fails(
      "asset 1 operator after the burn, by the old admin",
      a,
      [ix.updateAssetAuthority(m, a, s(stranger), 1, 2n, 3n, 2, stranger.address)],
      err(E.Unauthorized),
    );
    await d.ok("asset 1 insurance by its incumbent", insurer, [ix.updateAssetAuthority(m, insurer, s(stranger), 1, 2n, 3n, 1, stranger.address)]);

    const next = await d.funded();
    await d.fails("UpdateAuthority to zero", a, [ix.updateAuthority(m, a, r(ZERO), 0n, ZERO)], err(E.InvalidInstruction));
    await d.fails("UpdateAuthority incoming not signing", a, [ix.updateAuthority(m, a, r(next.address), 0n, next.address)], err(E.ExpectedSigner));
    await d.fails("UpdateAuthority by a stranger", stranger, [ix.updateAuthority(m, stranger, s(next), 0n, next.address)], err(E.Unauthorized));
    await d.fails("UpdateAuthority wrong epoch", a, [ix.updateAuthority(m, a, s(next), 3n, next.address)], err(E.EngineStale));
    await d.ok("UpdateAuthority", a, [ix.updateAuthority(m, a, s(next), 0n, next.address)]);
    await d.fails("policy by the old authority", a, [ix.marketPolicy(m, a, 37, 1n, 100n, 1n)], err(E.Unauthorized));
    await d.ok("policy by the new authority", next, [ix.marketPolicy(m, next, 37, 1n, 100n, 1n)]);
    await d.ok("UpdateAuthority back", next, [ix.updateAuthority(m, next, s(a), 1n, a.address)]);
  });

  it("ConfigurePermissionlessResolve (38) and the stale window it opens", async () => {
    const mk = await d.market({ capacity: 1 });
    const a = mk.admin;
    const frontier = 2n;
    await d.fails("resolve window 0", a, [ix.permissionlessResolve(mk, a, frontier, 0n, 1n, 1n, 0n)], err(E.InvalidInstruction));
    await d.fails("resolve window too long", a, [ix.permissionlessResolve(mk, a, frontier, 6_480_001n, 1n, 1n, 0n)], err(E.InvalidInstruction));
    await d.fails("force-close delay 0", a, [ix.permissionlessResolve(mk, a, frontier, 10n, 0n, 1n, 0n)], err(E.InvalidInstruction));
    await d.fails("force-close delay too long", a, [ix.permissionlessResolve(mk, a, frontier, 10n, 10_000_001n, 1n, 0n)], err(E.InvalidInstruction));
    await d.fails("resolve wrong frontier", a, [ix.permissionlessResolve(mk, a, 3n, 10n, 1n, 1n, 0n)], err(E.AssetGenerationMismatch));
    await d.ok("resolve window 10 slots", a, [ix.permissionlessResolve(mk, a, frontier, 10n, 10_000_000n, 1n, 0n)]);
    d.setClock(d.slot + 10n);
    await d.fails("resolve window matured", a, [ix.permissionlessResolve(mk, a, frontier, 20n, 1n, 2n, 0n)], err(E.OracleStale));
    const { owner, portfolio } = await d.newPortfolio();
    await d.fails("InitPortfolio on a matured market", owner, [ix.initPortfolio(mk, owner, portfolio)], err(E.OracleStale));
    d.setClock(d.slot - 1n);
    await d.ok("InitPortfolio one slot before", owner, [ix.initPortfolio(mk, owner, portfolio)]);
    await d.ok("resolve window widened", a, [ix.permissionlessResolve(mk, a, frontier, 6_480_000n, 1n, 2n, 0n)]);
    d.setClock(d.slot + 1n);
  });

  it("UpdateBaseUnitMints (60): new mints, the old vaults, every check", async () => {
    const mk = await d.market({ capacity: 1 });
    const a = mk.admin;
    const [p, q, odd] = [await d.mint(6), await d.mint(6), await d.mint(9)];
    await d.fails("mints equal", a, [ix.baseUnitMints(mk, a, p, p, 0n)], err(E.InvalidMint));
    await d.fails("mint zero", a, [ix.baseUnitMints(mk, a, ZERO, p, 0n)], err(E.InvalidMint));
    const swapped = replaced(ix.baseUnitMints(mk, a, p, q, 0n), 2, q);
    await d.fails("primary at another key", a, [swapped], errB("InvalidArgument"));
    await d.fails("decimals differ", a, [ix.baseUnitMints(mk, a, p, odd, 0n)], err(E.InvalidMint));
    await d.fails("the old vault missing", a, [ix.baseUnitMints(mk, a, p, q, 0n)], errB("NotEnoughAccountKeys"));
    await d.fails(
      "the old vault not the canonical one",
      a,
      [ix.baseUnitMints(mk, a, p, q, 0n, [await d.tokenAccount(mk.mint, mk.vaultPda)])],
      errB("InstructionErrorCustom { code: 12 }"),
    );
    await d.ok("primary replaced, the old vault empty", a, [ix.baseUnitMints(mk, a, p, q, 0n, [mk.vault])]);
    const [vaultP] = await pda(ATA_PROGRAM, [mk.vaultPda, TOKEN, p]);
    const [vaultQ] = await pda(ATA_PROGRAM, [mk.vaultPda, TOKEN, q]);
    d.write(vaultP, TOKEN, tokenAccountBytes({ mint: p, owner: mk.vaultPda, amount: 5n }));
    d.write(vaultQ, TOKEN, tokenAccountBytes({ mint: q, owner: mk.vaultPda, amount: 0n }));
    await d.fails("an old vault not empty", a, [ix.baseUnitMints(mk, a, mk.mint, q, 0n, [vaultP])], err(E.EngineLockActive));
    await d.ok("same mints again (no old vault)", a, [ix.baseUnitMints(mk, a, p, q, 0n)]);
    const [r1] = [await d.mint(6)];
    await d.ok("secondary replaced, its old vault empty", a, [ix.baseUnitMints(mk, a, p, r1, 0n, [vaultQ])]);
    d.write(odd, TOKEN, mintBytes({ decimals: 6, initialized: 0 }));
    await d.fails("an uninitialized mint", a, [ix.baseUnitMints(mk, a, p, odd, 0n)], err(E.InvalidMint));
  });

  it("SyncInsuranceLedger (54) and SyncBackingDomainLedger (53)", async () => {
    const a = m.admin;
    const ins = await d.address();
    d.write(ins, PROGRAM, new Uint8Array(176));
    await d.ok("insurance ledger created", a, [ix.syncInsuranceLedger(m, a, ins)]);
    await d.ok("insurance ledger synced", a, [ix.syncInsuranceLedger(m, a, ins)]);
    await d.fails("insurance ledger is the market", a, [ix.syncInsuranceLedger(m, a, m.market)], errB("AccountBorrowFailed"));
    const short = await d.address();
    d.write(short, PROGRAM, new Uint8Array(175));
    await d.fails("insurance ledger 175 bytes", a, [ix.syncInsuranceLedger(m, a, short)], err(E.InvalidAccountLen));
    const dirty = await d.address();
    d.write(dirty, PROGRAM, new Uint8Array(176).fill(1, 100, 101));
    await d.fails("insurance ledger not zero", a, [ix.syncInsuranceLedger(m, a, dirty)], errB("InvalidAccountData"));
    const stranger = await d.funded();
    await d.fails("insurance ledger by a stranger", stranger, [ix.syncInsuranceLedger(m, stranger, ins)], err(E.Unauthorized));
    for (const domain of [0, 1, 2, 3]) {
      const led = await d.address();
      d.write(led, PROGRAM, new Uint8Array(240));
      // Asset 1's backing authority is still the admin (asset 1's roles moved were insurance and operator).
      await d.ok(`backing ledger domain ${domain} created`, a, [ix.syncBackingLedger(m, a, led, domain)]);
      await d.ok(`backing ledger domain ${domain} synced`, a, [ix.syncBackingLedger(m, a, led, domain)]);
      if (domain === 0) await d.fails("backing ledger of another domain", a, [ix.syncBackingLedger(m, a, led, 1)], err(E.Unauthorized));
    }
    await d.fails("backing ledger unconfigured domain", a, [ix.syncBackingLedger(m, a, ins, 4)], err(E.InvalidInstruction));
    await d.fails("backing ledger is the market", a, [ix.syncBackingLedger(m, a, m.market, 0)], errB("AccountBorrowFailed"));
    await d.fails("backing ledger of insurance kind", a, [ix.syncBackingLedger(m, a, ins, 0)], err(E.InvalidAccountLen));
  });

  it("the compute units of every success are recorded", () => {
    const ok = d.rows.filter((row) => row.ok && row.percolator);
    expect(ok.length).toBeGreaterThan(30);
    for (const row of ok) expect(row.port < row.original, row.label).toBe(true);
  });
});

const ZERO = "11111111111111111111111111111111" as Address;

/** The instruction with position `at` replaced by `address`, read-only and not signing. */
function replaced(i: Instruction, at: number, address: Address): Instruction {
  return { ...i, accounts: (i.accounts ?? []).map((a, k) => (k === at ? { address, role: AccountRole.READONLY } : a)) };
}
export type { KeyPairSigner };
