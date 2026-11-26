// The persisted layouts of Percolator v16 at commit 7b110913 (engine 5e3af07; aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0), as showcase/test/percolator-v16-layout.ts writes them down, checked two ways:
//
// - against the Rust compiler: fixtures/percolator-v16-layout.json holds `size_of`, `align_of`, and each field's
//   `offset_of!` and size, printed for the pinned sources by scripts/percolator-v16-reference/layout.ts in Docker;
// - against the reference binary (test/programs/percolator_v16.so, built from the same commits; skipped without it):
//   markets and a portfolio it initialised, read back through the table.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONSTANTS,
  HEADER,
  KIND,
  MAGIC,
  MARKET,
  PORTFOLIO,
  PRIMITIVES,
  STRUCTS,
  VERSION,
  BACKING_DOMAIN_LEDGER_LEN,
  INSURANCE_LEDGER_LEN,
  layout,
  marketLen,
  sizeOf,
} from "./percolator-v16-layout.js";
import { Diff, HAVE_REFERENCE, PROGRAM, defaultInitArgs, field, ix, keyAt, key, marketAt, portfolioAt, readUint } from "./percolator-v16-helpers.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/percolator-v16-layout.json", import.meta.url), "utf8")) as {
  source: Record<string, string>;
  structs: Record<string, { size: number; align: number; fields: Record<string, [number, number]> }>;
  constants: Record<string, string>;
};

describe("Percolator v16 layouts: the table against the Rust compiler", () => {
  it("was printed for the pinned commits", () => {
    expect(fixture.source).toMatchObject({
      "percolator-prog": "7b11091328de23cded2e4afe96592bbd060a6828",
      percolator: "5e3af0710ec7e9b7077393012f8a94a31b2f07ef",
    });
    expect(Object.keys(fixture.structs).sort()).toEqual(Object.keys(STRUCTS).sort());
  });

  for (const name of Object.keys(STRUCTS))
    it(`${name} (${STRUCTS[name]!.rust}): every field's offset and size, and the fields tile the struct`, () => {
      const rust = fixture.structs[name]!;
      const rows = layout(name);
      expect(Object.keys(rust.fields)).toEqual(rows.map((r) => r.name));
      for (const r of rows) expect([r.offset, r.size], `${name}.${r.name}`).toEqual(rust.fields[r.name]);
      // No gap and nothing after the last field: a field the table left out would show here.
      let at = 0;
      for (const r of rows) {
        expect(r.offset, `${name}.${r.name} starts where the previous field ends`).toBe(at);
        at += r.size;
      }
      expect(at, `${name}: the fields add up to size_of`).toBe(rust.size);
      expect(sizeOf(name)).toBe(rust.size);
      // The engine's structs are byte arrays all the way down (alignment 1). The program's wrapper structs use native
      // integers, aligned on the host that printed them (u128 is 16 there, 8 on SBF); Pod forbids padding on both.
      if (STRUCTS[name]!.rust.startsWith("percolator::")) expect(rust.align, `${name}: alignment`).toBe(1);
    });

  it("the program's layout constants", () => {
    for (const [k, v] of Object.entries(CONSTANTS)) expect(Number(fixture.constants[k]), k).toBe(v);
    expect(BigInt(fixture.constants.MAGIC!)).toBe(MAGIC);
    expect(Number(fixture.constants.VERSION)).toBe(VERSION);
    expect(Number(fixture.constants.KIND_MARKET)).toBe(KIND.market);
    expect(Number(fixture.constants.KIND_PORTFOLIO)).toBe(KIND.portfolio);
    expect(Number(fixture.constants.KIND_BACKING_DOMAIN_LEDGER)).toBe(KIND.backingDomainLedger);
    expect(Number(fixture.constants.KIND_INSURANCE_LEDGER)).toBe(KIND.insuranceLedger);
    expect(Number(fixture.constants.KIND_CLOSED_MARKET)).toBe(KIND.closedMarket);
  });

  it("the account sizes (the two ledgers settled: 240 and 176 bytes)", () => {
    expect(PRIMITIVES.key).toBe(32);
    expect({
      market1: marketLen(1),
      slot: MARKET.slotLen,
      groupHeader: sizeOf("GroupHeader"),
      wrapper: sizeOf("WrapperConfig"),
      portfolio: PORTFOLIO.len,
      portfolioState: sizeOf("Portfolio"),
      backingDomainLedger: BACKING_DOMAIN_LEDGER_LEN,
      insuranceLedger: INSURANCE_LEDGER_LEN,
    }).toEqual({
      market1: 3_035,
      slot: 1_845,
      groupHeader: 726,
      wrapper: 448,
      portfolio: 9_563,
      portfolioState: 9_419,
      backingDomainLedger: 240,
      insuranceLedger: 176,
    });
  });
});

describe.skipIf(!HAVE_REFERENCE)("Percolator v16 layouts: accounts the reference binary initialised", () => {
  it("InitMarket and InitPortfolio write the fields where the table puts them", async () => {
    // The reference on both sides: the harness's own VMs, compared as a port would be.
    const d = await Diff.create({ port: "reference" });
    for (const capacity of [1, 3]) {
      const args = defaultInitArgs({ maxPortfolioAssets: capacity, initialPrice: 2_345_678n });
      const m = await d.newMarket({ capacity });
      await d.ok(`InitMarket (capacity ${capacity})`, m.admin, [ix.initMarket(m, args)]);
      const b = d.data(m.market);
      expect(b.length).toBe(marketLen(capacity));
      expect(readUint(b, HEADER.magic, 8)).toBe(MAGIC);
      expect(readUint(b, HEADER.version, 2)).toBe(BigInt(VERSION));
      expect(b[HEADER.kind]).toBe(KIND.market);
      expect(keyAt(b, marketAt.wrapper("marketauth"))).toEqual(key(m.admin.address));
      expect(keyAt(b, marketAt.wrapper("collateral_mint"))).toEqual(key(m.mint));
      expect(field(b, MARKET.wrapper, "WrapperConfig", "mark_ewma_e6")).toBe(args.initialPrice);
      expect(field(b, MARKET.wrapper, "WrapperConfig", "oracle_target_price_e6")).toBe(args.initialPrice);
      expect(field(b, MARKET.wrapper, "WrapperConfig", "mark_ewma_last_slot")).toBe(d.slot);
      expect(field(b, MARKET.wrapper, "WrapperConfig", "last_good_oracle_slot")).toBe(d.slot);
      expect(field(b, MARKET.wrapper, "WrapperConfig", "mark_ewma_halflife_slots")).toBe(600n);
      expect(field(b, MARKET.wrapper, "WrapperConfig", "next_portfolio_id")).toBe(1n);
      expect(keyAt(b, marketAt.group("market_group_id"))).toEqual(key(m.market));
      expect(field(b, MARKET.group, "GroupHeader", "config.max_portfolio_assets")).toBe(BigInt(capacity));
      expect(field(b, MARKET.group, "GroupHeader", "config.max_market_slots")).toBe(BigInt(capacity));
      expect(field(b, MARKET.group, "GroupHeader", "config.h_max")).toBe(args.hMax);
      expect(field(b, MARKET.group, "GroupHeader", "config.public_b_chunk_atoms")).toBe(args.publicBChunkAtoms);
      expect(field(b, MARKET.group, "GroupHeader", "config.max_bankrupt_close_lifetime_slots")).toBe(args.maxBankruptCloseLifetimeSlots);
      expect(field(b, MARKET.group, "GroupHeader", "asset_slot_capacity")).toBe(BigInt(capacity));
      expect(field(b, MARKET.group, "GroupHeader", "next_market_id")).toBe(BigInt(capacity + 1));
      expect(field(b, MARKET.group, "GroupHeader", "slot_last")).toBe(d.slot);
      expect(field(b, MARKET.group, "GroupHeader", "current_slot")).toBe(d.slot);
      for (let i = 0; i < capacity; i++) {
        const engine = marketAt.engine(i, "");
        expect(field(b, engine, "EngineAssetSlot", "asset.market_id"), `slot ${i}`).toBe(BigInt(i + 1));
        expect(field(b, engine, "EngineAssetSlot", "asset.raw_oracle_target_price")).toBe(args.initialPrice);
        expect(field(b, engine, "EngineAssetSlot", "asset.effective_price")).toBe(args.initialPrice);
        expect(field(b, engine, "EngineAssetSlot", "asset.fund_px_last")).toBe(args.initialPrice);
        expect(field(b, engine, "EngineAssetSlot", "asset.slot_last")).toBe(d.slot);
        expect(field(b, marketAt.profile(i, ""), "AssetOracleProfile", "oracle_target_price_e6"), `slot ${i} profile`).toBe(args.initialPrice);
      }

      // A portfolio: given zero bytes, reallocated by the program to its full length.
      const { owner, portfolio } = await d.newPortfolio(0);
      await d.ok(`InitPortfolio (capacity ${capacity})`, owner, [ix.initPortfolio(m, owner, portfolio)]);
      const p = d.data(portfolio);
      expect(p.length).toBe(PORTFOLIO.len);
      expect(readUint(p, HEADER.magic, 8)).toBe(MAGIC);
      expect(p[HEADER.kind]).toBe(KIND.portfolio);
      expect(keyAt(p, portfolioAt("provenance_header.market_group_id"))).toEqual(key(m.market));
      expect(keyAt(p, portfolioAt("provenance_header.portfolio_account_id"))).toEqual(key(portfolio));
      expect(keyAt(p, portfolioAt("provenance_header.owner"))).toEqual(key(owner.address));
      expect(keyAt(p, portfolioAt("owner"))).toEqual(key(owner.address));
      expect(readUint(p, PORTFOLIO.id, 8)).toBe(1n);
      const after = d.data(m.market);
      expect(field(after, MARKET.wrapper, "WrapperConfig", "next_portfolio_id")).toBe(2n);
      expect(field(after, MARKET.group, "GroupHeader", "materialized_portfolio_count")).toBe(1n);
      const held = d.reference.getAccount(portfolio);
      expect(held.exists && held.programAddress).toBe(PROGRAM);
    }
  });
});
