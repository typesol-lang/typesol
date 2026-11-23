// The persisted structs and wire conversions of the Percolator v16 port (showcase/mainnet/percolator-v16/state.ts and
// wire.ts; Percolator v16 at commit 7b110913, engine 5e3af07, aeyakovenko/percolator-prog and aeyakovenko/percolator,
// Apache-2.0):
//
// - every TypeSOL struct of state.ts against the offsets and sizes rustc printed for the pinned sources
//   (fixtures/percolator-v16-layout.json), field by field, read from the TypeSOL compiler's own model of the program
//   (what the generated code lays out), not from a second hand-written table: a drifted, missing or extra field fails;
//   and state.ts's layout constants against the constants rustc printed;
// - the wire conversions (the engine's `try_to_runtime` decoders, the signed instruction readers) and some state checks
//   on known vectors, run on chain through a test program (fixtures/percolator-v16-wire.ts) in LiteSVM, with structs
//   the reference binary initialised as the starting points (skipped without the reference).
import { type Address, type KeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM, type TransactionMetadata } from "litesvm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../src/compiler/index.js";
import { type FieldType, type ProgramModel, scalarSize } from "../../src/compiler/model.js";
import { send } from "../../test/harness.js";
import { deployV16, Diff, HAVE_REFERENCE, builtin, custom, instruction, ix, marketAt, outcome, portfolioAt } from "./percolator-v16-helpers.js";
import { HEADER, MARKET, PORTFOLIO, offsetOf, sizeOf } from "./percolator-v16-layout.js";

const WIRE = fileURLToPath(new URL("./fixtures/percolator-v16-wire.ts", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/percolator-v16-layout.json", import.meta.url), "utf8")) as {
  structs: Record<string, { size: number; fields: Record<string, [number, number]> }>;
  constants: Record<string, string>;
};

/** A field type's byte size in the compiler's model (packed: no padding anywhere). */
function typeSize(model: ProgramModel, t: FieldType): number {
  if (t.kind === "array") return typeSize(model, t.elem) * t.len;
  if (t.kind === "struct") return model.structs.get(t.name)!.size!;
  if (t.kind === "int" || t.kind === "pubkey" || t.kind === "bool" || t.kind === "enum") return scalarSize(t);
  throw new Error(`unexpected field type ${t.kind}`);
}

describe("Percolator v16 port: the TypeSOL structs against the Rust layout", () => {
  const model = generate(WIRE).model;
  const ours = [...model.structs.values()].filter((s) => s.node.getSourceFile().fileName.endsWith("percolator-v16/state.ts"));
  /** Each struct's fields as the compiler lays them out: its Rust name (`@idlName`, else its own), offset and size. */
  const laid = (name: string) => {
    const s = model.structs.get(name)!;
    let at = 0;
    return s.fields.map((f) => {
      const size = typeSize(model, f.type);
      const row = { name: f.idlName ?? f.name, offset: at, size };
      at += size;
      return row;
    });
  };

  it("state.ts declares every struct rustc printed, and two of its own", () => {
    const names = ours.map((s) => s.name).sort();
    expect(names).toEqual([...Object.keys(fixture.structs), "AccountHeader", "AssetOracleWrapper"].sort());
  });

  for (const name of Object.keys(fixture.structs))
    it(`${name}: every field's offset and size as rustc lays it out`, () => {
      const rust = fixture.structs[name]!;
      const rows = laid(name);
      expect(rows.map((r) => r.name)).toEqual(Object.keys(rust.fields));
      for (const r of rows) expect([r.offset, r.size], `${name}.${r.name}`).toEqual(rust.fields[r.name]);
      expect(model.structs.get(name)!.size, `${name}: size`).toBe(rust.size);
    });

  it("the two structs of the port's own: the account header and an asset slot's 512-byte wrapper", () => {
    expect(laid("AccountHeader")).toEqual([
      { name: "magic", offset: HEADER.magic, size: 8 },
      { name: "version", offset: HEADER.version, size: 2 },
      { name: "kind", offset: HEADER.kind, size: 1 },
      { name: "zero", offset: 11, size: 5 },
    ]);
    expect(model.structs.get("AccountHeader")!.size).toBe(Number(fixture.constants.HEADER_LEN));
    expect(laid("AssetOracleWrapper")).toEqual([
      { name: "profile", offset: 0, size: Number(fixture.constants.ASSET_ORACLE_PROFILE_LEN) },
      { name: "controls", offset: Number(fixture.constants.ASSET_CONTROL_SEQUENCES_OFF), size: Number(fixture.constants.ASSET_CONTROL_SEQUENCES_LEN) },
    ]);
    expect(model.structs.get("AssetOracleWrapper")!.size).toBe(Number(fixture.constants.ASSET_ORACLE_WRAPPER_LEN));
  });

  it("state.ts's constants: those rustc printed, and the ones derived from the layout", () => {
    const value = (n: string) => {
      const c = model.constants.get(n);
      if (!c) throw new Error(`state.ts has no constant ${n}`);
      return c.value as bigint;
    };
    for (const [k, v] of Object.entries(fixture.constants)) expect(value(k.toUpperCase()), k).toBe(BigInt(v));
    expect(value("ENGINE_ASSET_SLOT_LEN")).toBe(BigInt(fixture.structs.EngineAssetSlot!.size));
    expect(value("MAINTENANCE_FEE_SPLIT_CARRY_OFF")).toBe(BigInt(fixture.structs.WrapperConfig!.fields._padding0![0]));
    expect(value("PORTFOLIO_LEGACY_ACCOUNT_LEN")).toBe(BigInt(fixture.constants.PORTFOLIO_MATCHER_SEQUENCE_OFF!));
    expect(value("PORTFOLIO_PRE_EXPIRY_ACCOUNT_LEN")).toBe(BigInt(fixture.constants.PORTFOLIO_MATCHER_EXPIRY_OFF!));
    // `marketViewChecks` reads the configured slot count at MARKET_GROUP_OFF + 34.
    expect(offsetOf("GroupHeader", "config.max_market_slots")).toBe(34);
  });
});

// ---- The conversions on chain ----------------------------------------------------------------------------------------

const V16 = { ok: 0n, invalidConfig: 1n, arithmeticOverflow: 2n, provenanceMismatch: 3n, hiddenLeg: 4n };
const I128_MIN = -(1n << 127n);
const U128_MAX = (1n << 128n) - 1n;
const BOUND = 1_000_000_000_000n;
/** PercolatorError codes. */
const E = { InvalidVersion: 1, NotInitialized: 3, InvalidAccountKind: 4, InvalidAccountLen: 5 };

const le = (v: bigint, n: number) => {
  const b = Buffer.alloc(n);
  let x = BigInt.asUintN(n * 8, v);
  for (let i = 0; i < n; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
};

describe.skipIf(!HAVE_REFERENCE)("Percolator v16 port: wire conversions and state checks on known vectors", () => {
  let vm: LiteSVM;
  let program: Address;
  let payer: KeyPairSigner;
  let out: Address;
  let input: Address;
  let marketBytes: Buffer;
  let portfolioBytes: Buffer;

  beforeAll(async () => {
    // A market and a portfolio initialised by the reference: the starting bytes of the struct vectors.
    const d = await Diff.create({ port: "reference" });
    const m = await d.market();
    const p = await d.newPortfolio();
    await d.ok("InitPortfolio", p.owner, [ix.initPortfolio(m, p.owner, p.portfolio)]);
    marketBytes = d.data(m.market);
    portfolioBytes = d.data(p.portfolio);
    const deployed = await deployV16(WIRE);
    vm = deployed.svm;
    program = deployed.programId;
    payer = await d.funded();
    vm.airdrop(payer.address, lamports(10_000_000_000n));
    out = await d.address();
    input = await d.address();
    put(out, Buffer.alloc(24));
  }, 120_000);

  function put(at: Address, data: Buffer): void {
    vm.setAccount({
      address: at,
      data: new Uint8Array(data),
      executable: false,
      lamports: lamports(1_000_000_000n),
      programAddress: program,
      space: BigInt(data.length),
    });
  }
  async function run(op: number, args: Buffer = Buffer.alloc(0), bytes?: Buffer): Promise<TransactionMetadata | FailedTransactionMetadata> {
    if (bytes) put(input, bytes);
    const i = instruction(Buffer.concat([Buffer.from([op]), args]), [{ address: out, writable: true }, { address: input }]);
    return send(vm, payer, [{ ...i, programAddress: program }]);
  }
  async function answer(op: number, args?: Buffer, bytes?: Buffer): Promise<{ code: bigint; value: bigint }> {
    const res = await run(op, args, bytes);
    if (res instanceof FailedTransactionMetadata)
      throw new Error(`op ${op} failed: ${outcome(res)} ${JSON.stringify(res.err())}\n${res.meta().logs().join("\n")}`);
    const o = vm.getAccount(out);
    if (!o.exists) throw new Error("no out");
    const b = Buffer.from(o.data);
    return { code: b.readBigUInt64LE(0), value: BigInt.asIntN(128, (b.readBigUInt64LE(16) << 64n) | b.readBigUInt64LE(8)) };
  }
  const code = async (op: number, bytes: Buffer) => (await answer(op, Buffer.alloc(0), bytes)).code;
  /** A struct of `size` bytes taken from `from` at `at`, then `edit` applied. */
  const take = (from: Buffer, at: number, size: number, edit: (b: Buffer) => void = () => {}) => {
    const b = Buffer.from(from.subarray(at, at + size));
    edit(b);
    return b;
  };

  it("read_i64 / read_i128 (the v12.20 readers, shared): two's complement little-endian", async () => {
    for (const v of [0n, 1n, -1n, 0x7fff_ffff_ffff_ffffn, -(1n << 63n), 123456789n, -987654321n]) expect((await answer(0, le(v, 8))).value, String(v)).toBe(v);
    for (const v of [0n, 1n, -1n, (1n << 127n) - 1n, I128_MIN, -(1n << 64n), 1n << 64n, -12345678901234567890123n])
      expect((await answer(1, le(v, 16))).value, String(v)).toBe(v);
  });

  it("the enum and bool bytes: every byte value, accepted exactly up to the last variant", async () => {
    const last: Record<number, number> = { 2: 1, 3: 1, 4: 2, 5: 5, 6: 2, 7: 3, 8: 7 };
    for (const [op, max] of Object.entries(last))
      for (let v = 0; v < 256; v++) expect((await answer(Number(op), Buffer.from([v]))).code, `op ${op} byte ${v}`).toBe(v <= max ? V16.ok : V16.invalidConfig);
    expect((await answer(9, le(I128_MIN, 16))).code).toBe(V16.arithmeticOverflow);
    expect((await answer(9, le(I128_MIN + 1n, 16))).code).toBe(V16.ok);
    expect((await answer(9, le(-1n, 16))).code).toBe(V16.ok);
  });

  it("OptionalRecoveryReason and ProvenanceHeader", async () => {
    const cases: [number, number, bigint][] = [
      [0, 0, V16.ok],
      [0, 1, V16.invalidConfig],
      [1, 0, V16.ok],
      [1, 7, V16.ok],
      [1, 8, V16.invalidConfig],
      [2, 0, V16.invalidConfig],
      [255, 255, V16.invalidConfig],
    ];
    for (const [present, value, want] of cases) expect(await code(10, Buffer.from([present, value])), `${present},${value}`).toBe(want);
    const ph = portfolioAt("provenance_header");
    const header = take(portfolioBytes, ph, sizeOf("ProvenanceHeader"));
    expect(await code(11, header)).toBe(V16.ok);
    const at = (f: string) => offsetOf("ProvenanceHeader", f);
    expect(
      await code(
        11,
        take(header, 0, header.length, (b) => b.writeUInt16LE(2, at("version"))),
      ),
    ).toBe(V16.provenanceMismatch);
    expect(
      await code(
        11,
        take(header, 0, header.length, (b) => b.writeUInt16LE(17, at("layout_discriminator"))),
      ),
    ).toBe(V16.provenanceMismatch);
  });

  it("the engine config: decode_runtime and the shape check", async () => {
    const cfg = take(marketBytes, marketAt.group("config"), sizeOf("Config"));
    expect(await code(12, cfg)).toBe(V16.ok);
    expect(await code(13, cfg)).toBe(V16.ok);
    const at = (f: string) => offsetOf("Config", f);
    const edit = (f: (b: Buffer) => void) => take(cfg, 0, cfg.length, f);
    // A bool byte of 2: refused by both; a bool of 0 decodes but fails the shape.
    expect(
      await code(
        12,
        edit((b) => (b[at("public_liveness_profile_crank_forward")] = 2)),
      ),
    ).toBe(V16.invalidConfig);
    expect(
      await code(
        13,
        edit((b) => (b[at("public_liveness_profile_crank_forward")] = 2)),
      ),
    ).toBe(V16.invalidConfig);
    expect(
      await code(
        12,
        edit((b) => (b[at("stale_certificate_penalty_enabled")] = 0)),
      ),
    ).toBe(V16.ok);
    expect(
      await code(
        13,
        edit((b) => (b[at("stale_certificate_penalty_enabled")] = 0)),
      ),
    ).toBe(V16.invalidConfig);
    // backing_freshness_buckets is a plain u8 to decode, 1 at most to the shape.
    expect(
      await code(
        12,
        edit((b) => (b[at("backing_freshness_buckets")] = 9)),
      ),
    ).toBe(V16.ok);
    expect(
      await code(
        13,
        edit((b) => (b[at("backing_freshness_buckets")] = 9)),
      ),
    ).toBe(V16.invalidConfig);
    expect(
      await code(
        13,
        edit((b) => b.writeUInt16LE(0, at("max_portfolio_assets"))),
      ),
    ).toBe(V16.invalidConfig);
    expect(
      await code(
        13,
        edit((b) => b.writeUInt16LE(17, at("max_portfolio_assets"))),
      ),
    ).toBe(V16.invalidConfig);
    // The backing fee rates' sum overflowing u64 is InvalidConfig too.
    expect(
      await code(
        13,
        edit((b) => {
          b.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, at("backing_fee_base_rate_e9_per_slot"));
          b.writeBigUInt64LE(1n, at("backing_fee_slope_at_kink_e9_per_slot"));
        }),
      ),
    ).toBe(V16.invalidConfig);
  });

  it("AssetState: the lifecycle and side modes first, then the K/F fields not i128::MIN", async () => {
    const asset = take(marketBytes, marketAt.engine(0, "asset"), sizeOf("AssetState"));
    expect(await code(14, asset)).toBe(V16.ok);
    const at = (f: string) => offsetOf("AssetState", f);
    const edit = (f: (b: Buffer) => void) => take(asset, 0, asset.length, f);
    expect(
      await code(
        14,
        edit((b) => (b[at("lifecycle")] = 6)),
      ),
    ).toBe(V16.invalidConfig);
    expect(
      await code(
        14,
        edit((b) => (b[at("mode_short")] = 3)),
      ),
    ).toBe(V16.invalidConfig);
    for (const f of [
      "k_long",
      "k_short",
      "f_long_num",
      "f_short_num",
      "k_epoch_start_long",
      "k_epoch_start_short",
      "f_epoch_start_long_num",
      "f_epoch_start_short_num",
    ])
      expect(
        await code(
          14,
          edit((b) => le(I128_MIN, 16).copy(b, at(f))),
        ),
        f,
      ).toBe(V16.arithmeticOverflow);
    // Both wrong: the decode of the modes comes first (InvalidConfig, not ArithmeticOverflow).
    expect(
      await code(
        14,
        edit((b) => {
          b[at("mode_long")] = 9;
          le(I128_MIN, 16).copy(b, at("k_long"));
        }),
      ),
    ).toBe(V16.invalidConfig);
  });

  it("BackingBucket: the status byte and the amounts each status allows", async () => {
    const empty = take(marketBytes, marketAt.engine(0, "backing_long"), sizeOf("BackingBucket"));
    expect(await code(15, empty)).toBe(V16.ok);
    const at = (f: string) => offsetOf("BackingBucket", f);
    const bucket = (o: Record<string, bigint>) => {
      const b = Buffer.alloc(sizeOf("BackingBucket"));
      for (const [f, v] of Object.entries(o)) {
        if (f === "status") b[at(f)] = Number(v);
        else le(v, f === "market_id" || f === "expiry_slot" ? 8 : 16).copy(b, at(f));
      }
      return b;
    };
    const cases: [Record<string, bigint>, bigint][] = [
      [{ status: 4n }, V16.invalidConfig],
      [{ status: 0n, market_id: 7n }, V16.ok],
      [{ status: 0n, utilization_fee_earnings: 1n }, V16.invalidConfig],
      [{ status: 1n, market_id: 1n, expiry_slot: 1n }, V16.invalidConfig],
      [{ status: 1n, market_id: 1n, expiry_slot: 1n, valid_liened_backing_num: 5n }, V16.ok],
      [{ status: 1n, market_id: 1n, expiry_slot: 1n, fresh_unliened_backing_num: U128_MAX, valid_liened_backing_num: 1n }, V16.arithmeticOverflow],
      [{ status: 1n, market_id: 0n, expiry_slot: 1n, fresh_unliened_backing_num: U128_MAX, valid_liened_backing_num: 1n }, V16.invalidConfig],
      [{ status: 2n, market_id: 1n, consumed_liened_backing_num: 3n }, V16.ok],
      [{ status: 2n, market_id: 1n, impaired_liened_backing_num: 3n }, V16.invalidConfig],
      [{ status: 3n, market_id: 1n }, V16.invalidConfig],
      [{ status: 3n, market_id: 1n, impaired_liened_backing_num: 1n }, V16.ok],
    ];
    for (const [o, want] of cases)
      expect(
        await code(15, bucket(o)),
        JSON.stringify(o, (_, v) => (typeof v === "bigint" ? String(v) : v)),
      ).toBe(want);
  });

  it("InsuranceCreditReservation: empty, atom-aligned, the reservation covering the encumbered amount", async () => {
    const at = (f: string) => offsetOf("InsuranceCreditReservation", f);
    const res = (o: Record<string, bigint>) => {
      const b = Buffer.alloc(sizeOf("InsuranceCreditReservation"));
      for (const [f, v] of Object.entries(o)) le(v, f === "source_credit_epoch" ? 8 : 16).copy(b, at(f));
      return b;
    };
    const top = (U128_MAX / BOUND) * BOUND;
    const cases: [Record<string, bigint>, bigint][] = [
      [{}, V16.ok],
      [{ source_credit_epoch: 1n }, V16.ok],
      [{ consumed_insurance_num: 1n }, V16.ok],
      [{ insurance_credit_reserved_num: 1n }, V16.invalidConfig],
      [{ insurance_credit_reserved_num: BOUND, valid_liened_insurance_num: BOUND }, V16.ok],
      [{ insurance_credit_reserved_num: BOUND, valid_liened_insurance_num: 2n * BOUND }, V16.invalidConfig],
      [{ insurance_credit_reserved_num: BOUND, impaired_liened_insurance_num: 7n }, V16.invalidConfig],
      [{ insurance_credit_reserved_num: top, valid_liened_insurance_num: top, impaired_liened_insurance_num: BOUND }, V16.arithmeticOverflow],
    ];
    for (const [o, want] of cases)
      expect(
        await code(16, res(o)),
        JSON.stringify(o, (_, v) => (typeof v === "bigint" ? String(v) : v)),
      ).toBe(want);
  });

  it("PortfolioLeg (its decoding), HealthCert, CloseProgressLedger, the resolved payout ledger and receipt", async () => {
    const leg = take(portfolioBytes, portfolioAt("legs"), sizeOf("PortfolioLeg"));
    const at = (f: string) => offsetOf("PortfolioLeg", f);
    const edit = (f: (b: Buffer) => void) => take(leg, 0, leg.length, f);
    expect(await code(17, leg)).toBe(V16.ok);
    expect(
      await code(
        17,
        edit((b) => (b[at("active")] = 2)),
      ),
    ).toBe(V16.invalidConfig);
    expect(
      await code(
        17,
        edit((b) => (b[at("side")] = 2)),
      ),
    ).toBe(V16.invalidConfig);
    expect(
      await code(
        17,
        edit((b) => (b[at("stale")] = 2)),
      ),
    ).toBe(V16.invalidConfig);
    // Inactive but not the EMPTY leg (a_basis is ADL_ONE there): HiddenLeg.
    expect(
      await code(
        17,
        edit((b) => le(0n, 16).copy(b, at("a_basis"))),
      ),
    ).toBe(V16.hiddenLeg);
    expect(
      await code(
        17,
        edit((b) => (b[at("side")] = 1)),
      ),
    ).toBe(V16.hiddenLeg);
    expect(
      await code(
        17,
        edit((b) => (b[at("active")] = 1)),
      ),
    ).toBe(V16.ok);

    const cert = take(portfolioBytes, portfolioAt("health_cert"), sizeOf("HealthCert"));
    const c = (f: string) => offsetOf("HealthCert", f);
    expect(await code(18, cert)).toBe(V16.ok);
    expect(
      await code(
        18,
        take(cert, 0, cert.length, (b) => (b[c("valid")] = 2)),
      ),
    ).toBe(V16.invalidConfig);
    expect(
      await code(
        18,
        take(cert, 0, cert.length, (b) => le(I128_MIN, 16).copy(b, c("certified_equity"))),
      ),
    ).toBe(V16.arithmeticOverflow);
    expect(
      await code(
        18,
        take(cert, 0, cert.length, (b) => {
          b[c("valid")] = 3;
          le(I128_MIN, 16).copy(b, c("certified_equity"));
        }),
      ),
    ).toBe(V16.invalidConfig);

    const close = take(portfolioBytes, portfolioAt("close_progress"), sizeOf("CloseProgressLedger"));
    expect(await code(19, close)).toBe(V16.ok);
    for (const f of ["active", "finalized", "canceled", "domain_side"])
      expect(
        await code(
          19,
          take(close, 0, close.length, (b) => (b[offsetOf("CloseProgressLedger", f)] = 2)),
        ),
        f,
      ).toBe(V16.invalidConfig);

    const ledger = take(marketBytes, marketAt.group("resolved_payout_ledger"), sizeOf("ResolvedPayoutLedger"));
    expect(await code(20, ledger)).toBe(V16.ok);
    for (const f of ["payout_halted", "finalized"])
      expect(
        await code(
          20,
          take(ledger, 0, ledger.length, (b) => (b[offsetOf("ResolvedPayoutLedger", f)] = 2)),
        ),
        f,
      ).toBe(V16.invalidConfig);
    const receipt = take(portfolioBytes, portfolioAt("resolved_payout_receipt"), sizeOf("ResolvedPayoutReceipt"));
    expect(await code(21, receipt)).toBe(V16.ok);
    for (const f of ["present", "finalized"])
      expect(
        await code(
          21,
          take(receipt, 0, receipt.length, (b) => (b[offsetOf("ResolvedPayoutReceipt", f)] = 2)),
        ),
        f,
      ).toBe(V16.invalidConfig);
  });

  it("check_header, market_slot_capacity, validate_wrapper_config, validate_asset_oracle_profile, oracle_leg_config_ok", async () => {
    const fails = async (op: number, args: Buffer, bytes: Buffer) => outcome(await run(op, args, bytes));
    expect(await fails(22, Buffer.from([1]), marketBytes)).toBe("ok");
    expect(await fails(22, Buffer.from([2]), marketBytes)).toBe(custom(E.InvalidAccountKind));
    expect(
      await fails(
        22,
        Buffer.from([1]),
        take(marketBytes, 0, marketBytes.length, (b) => (b[8] = 15)),
      ),
    ).toBe(custom(E.InvalidVersion));
    expect(
      await fails(
        22,
        Buffer.from([1]),
        take(marketBytes, 0, marketBytes.length, (b) => (b[0] ^= 1)),
      ),
    ).toBe(custom(E.NotInitialized));
    expect(await fails(22, Buffer.from([1]), marketBytes.subarray(0, 15))).toBe(custom(E.InvalidAccountLen));
    expect(await fails(22, Buffer.from([2]), portfolioBytes)).toBe("ok");

    expect((await answer(23, Buffer.alloc(0), marketBytes)).value).toBe(1n);
    expect((await answer(23, Buffer.alloc(0), Buffer.concat([marketBytes, Buffer.alloc(MARKET.slotLen)]))).value).toBe(2n);
    expect((await answer(23, Buffer.alloc(0), marketBytes.subarray(0, MARKET.slots))).value).toBe(0n);
    expect(await fails(23, Buffer.alloc(0), Buffer.concat([marketBytes, Buffer.alloc(1)]))).toBe(builtin("InvalidAccountData"));
    expect(await fails(23, Buffer.alloc(0), marketBytes.subarray(0, MARKET.slots - 1))).toBe(custom(E.InvalidAccountLen));

    const wrapper = take(marketBytes, MARKET.wrapper, sizeOf("WrapperConfig"));
    const w = (f: string) => offsetOf("WrapperConfig", f);
    expect(await fails(24, Buffer.alloc(0), wrapper)).toBe("ok");
    for (const [f, v] of [
      ["invert", 2],
      ["_padding0", 2],
      ["oracle_mode", 4],
      ["oracle_leg_count", 1],
      ["oracle_leg_flags", 4],
      ["_reserved_insurance_withdraw_deposits_only", 1],
    ] as const)
      expect(
        await fails(
          24,
          Buffer.alloc(0),
          take(wrapper, 0, wrapper.length, (b) => (b[w(f)] = v)),
        ),
        f,
      ).toBe(builtin("InvalidAccountData"));
    expect(
      await fails(
        24,
        Buffer.alloc(0),
        take(wrapper, 0, wrapper.length, (b) => (b[w("_padding0")] = 1)),
      ),
    ).toBe("ok");
    expect(
      await fails(
        24,
        Buffer.alloc(0),
        take(wrapper, 0, wrapper.length, (b) => b.fill(0, w("collateral_mint"), w("collateral_mint") + 32)),
      ),
    ).toBe(builtin("InvalidAccountData"));

    const profile = take(marketBytes, marketAt.profile(0, ""), sizeOf("AssetOracleProfile"));
    const p = (f: string) => offsetOf("AssetOracleProfile", f);
    expect(await fails(25, Buffer.alloc(0), profile)).toBe("ok");
    for (const [f, v] of [
      ["_padding0", 1],
      ["invert", 2],
      ["effective_price_provenance", 1],
      ["oracle_mode", 9],
    ] as const)
      expect(
        await fails(
          25,
          Buffer.alloc(0),
          take(profile, 0, profile.length, (b) => (b[p(f)] = v)),
        ),
        f,
      ).toBe(builtin("InvalidAccountData"));

    // oracle_leg_config_ok over the wrapper config's legs: count, flags and three feeds.
    const legs = (count: number, flags: number, feeds: number[]) =>
      take(wrapper, 0, wrapper.length, (b) => {
        b[w("oracle_leg_count")] = count;
        b[w("oracle_leg_flags")] = flags;
        for (let i = 0; i < 3; i++) b.fill(feeds[i]!, w("oracle_leg_feeds") + 32 * i, w("oracle_leg_feeds") + 32 * (i + 1));
      });
    const legCases: [number, number, number[], bigint][] = [
      [0, 0, [0, 0, 0], 1n],
      [0, 1, [0, 0, 0], 0n],
      [0, 0, [1, 0, 0], 0n],
      [1, 0, [1, 0, 0], 1n],
      [1, 1, [1, 0, 0], 0n],
      [1, 0, [0, 0, 0], 0n],
      [2, 1, [1, 2, 0], 1n],
      [2, 2, [1, 2, 0], 0n],
      [2, 0, [1, 1, 0], 0n],
      [3, 3, [1, 2, 3], 1n],
      [3, 0, [1, 2, 2], 0n],
      [3, 0, [1, 2, 1], 0n],
      [4, 0, [1, 2, 3], 0n],
      [1, 4, [1, 0, 0], 0n],
    ];
    for (const [count, flags, feeds, want] of legCases) expect(await code(26, legs(count, flags, feeds)), `${count} ${flags} ${feeds}`).toBe(want);
  });

  it("the portfolio fixture is the reference's: version 1, layout discriminator 18, all legs empty", () => {
    expect(portfolioBytes.length).toBe(PORTFOLIO.len);
    expect(portfolioBytes.readUInt16LE(portfolioAt("provenance_header.version"))).toBe(1);
    expect(portfolioBytes.readUInt16LE(portfolioAt("provenance_header.layout_discriminator"))).toBe(18);
  });
});
