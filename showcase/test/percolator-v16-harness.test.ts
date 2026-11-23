// The differential harness of the Percolator v16 port (percolator-v16-helpers.ts; Percolator v16 at commit 7b110913,
// engine 5e3af07, aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0), checked on the reference
// binary run on both sides, before any instruction is ported: the comparison passes where the two agree, fails where
// one account's bytes, length or owner, or one outcome differs, records compute units, and follows accounts the
// program grows. It also pins the reference's own behaviour the harness relies on: the heap preamble.
import { ComputeBudget } from "litesvm";
import { describe, expect, it } from "vitest";
import {
  CU_LIMIT,
  Diff,
  HAVE_PORT,
  HAVE_REFERENCE,
  HEAP_FRAME,
  PROGRAM,
  builtin,
  custom,
  defaultInitArgs,
  ix,
  instruction,
  u8,
} from "./percolator-v16-helpers.js";
import { PORTFOLIO, marketLen } from "./percolator-v16-layout.js";

/** PercolatorError codes (src/v16_program.rs `mod error`, in declaration order). */
const ALREADY_INITIALIZED = 2;
const INVALID_ACCOUNT_LEN = 5;

describe.skipIf(!HAVE_REFERENCE)("Percolator v16 harness, reference against itself", () => {
  it("agrees with itself on successes and refusals, and records compute units", async () => {
    const d = await Diff.create({ port: "reference" });
    const m = await d.market();
    const { owner, portfolio } = await d.newPortfolio();
    await d.ok("InitPortfolio", owner, [ix.initPortfolio(m, owner, portfolio)]);
    // The preamble's two Compute Budget instructions come first: the program's instruction is index 2.
    await d.fails("InitMarket again", m.admin, [ix.initMarket(m, defaultInitArgs())], custom(ALREADY_INITIALIZED, 2));
    await d.fails("tag 2 (unused)", m.admin, [instruction(u8(2), [])], builtin("InvalidInstructionData", 2));
    await d.fails("no data", m.admin, [instruction(Buffer.alloc(0), [])], builtin("InvalidInstructionData", 2));
    const extra = ix.initPortfolio(m, owner, portfolio);
    await d.fails("InitPortfolio + 1 byte", owner, [{ ...extra, data: new Uint8Array([1, 0]) }], builtin("InvalidInstructionData", 2));
    expect(d.compared).toBe(6);
    // Both sides ran the same binary: the same units, recorded per label.
    for (const [label, [a, b]] of Object.entries(d.cu)) {
      expect(a, label).toBe(b);
      expect(a > 0n, label).toBe(true);
    }
    expect(d.rows.filter((r) => r.ok && r.percolator).map((r) => r.label)).toEqual(["InitMarket", "InitPortfolio"]);
  });

  it("fails the comparison when one byte, one length, one owner or one outcome differs", async () => {
    // One byte of the market changed in the second VM only: InitPortfolio succeeds on both, the market then differs,
    // reported by offset and field.
    const d = await Diff.create({ port: "reference" });
    const m = await d.market();
    const { owner, portfolio } = await d.newPortfolio();
    const acct = d.port.getAccount(m.market);
    if (!acct.exists) throw new Error("no market");
    const bytes = new Uint8Array(acct.data);
    bytes[marketLen(1) - 1] ^= 1;
    d.port.setAccount({ ...acct, data: bytes });
    await expect(d.send("InitPortfolio, market patched on one side", owner, [ix.initPortfolio(m, owner, portfolio)])).rejects.toThrow(
      /data: expected '@3034 \(slot\[0\]\.engine\.provider_princi/,
    );

    // The same account with another length on one side.
    const e = await Diff.create({ port: "reference" });
    const at = await e.address();
    e.write(at, PROGRAM, new Uint8Array(16), 1_000_000n);
    const a = e.port.getAccount(at);
    if (!a.exists) throw new Error("no account");
    e.port.setAccount({ ...a, data: new Uint8Array(17), space: 17n });
    expect(() => e.expectSame(at, "lengths")).toThrow(/^lengths: account: /);
    // Another owner on one side.
    e.port.setAccount({ ...a, programAddress: at });
    expect(() => e.expectSame(at, "owners")).toThrow(/^owners: account: /);

    // The portfolio not owned by the program in the second VM: it refuses there and succeeds in the reference.
    const f = await Diff.create({ port: "reference" });
    const n = await f.market();
    const third = await f.newPortfolio();
    const q = f.port.getAccount(third.portfolio);
    if (!q.exists) throw new Error("no portfolio");
    f.port.setAccount({ ...q, programAddress: third.owner.address });
    await expect(f.send("InitPortfolio, owner differs on one side", third.owner, [ix.initPortfolio(n, third.owner, third.portfolio)])).rejects.toThrow(
      /to be 'ok'/,
    );
  });

  it("follows accounts the program grows: a portfolio given 0 bytes is reallocated to 9,563", async () => {
    const d = await Diff.create({ port: "reference" });
    const m = await d.market();
    const { owner, portfolio } = await d.newPortfolio(0);
    await d.ok("InitPortfolio (0 bytes)", owner, [ix.initPortfolio(m, owner, portfolio)]);
    expect(d.data(portfolio).length).toBe(PORTFOLIO.len);
    // InitMarket takes the market account as allocated: one byte short of the group header is InvalidAccountLen.
    const short = await d.newMarket();
    d.write(short.market, PROGRAM, new Uint8Array(marketLen(0) - 1));
    await d.fails("InitMarket, account short of the group header", short.admin, [ix.initMarket(short, defaultInitArgs())], custom(INVALID_ACCOUNT_LEN, 2));
  });

  it("the reference's run under a raised budget starts from the accounts as they were and ends as that run left them", async () => {
    // The first VM (the reference) is given too few compute units for ClosePortfolio, the second (the reference
    // again) the usual budget: the reference runs out where the other side succeeds, and `send` runs the transaction
    // again in the raised reference. ClosePortfolio moves the portfolio's lamports to the market and removes it.
    const budget = (units: number) => {
      const b = new ComputeBudget();
      b.computeUnitLimit = BigInt(units);
      b.heapSize = HEAP_FRAME;
      return b;
    };
    const d = await Diff.create({ port: "reference" });
    const m = await d.market();
    const ps: { owner: Awaited<ReturnType<Diff["funded"]>>; portfolio: Awaited<ReturnType<Diff["address"]>>; id: bigint }[] = [];
    for (let i = 0; i < 3; i++) {
      const { owner, portfolio } = await d.newPortfolio();
      await d.ok(`InitPortfolio ${i}`, owner, [ix.initPortfolio(m, owner, portfolio)]);
      ps.push({ owner, portfolio, id: d.portfolioId(portfolio) });
    }
    const close = (i: number) => ix.closePortfolio(m, ps[i]!.owner, ps[i]!.portfolio, ps[i]!.id, 0n, 0n);
    const exists = (i: number) => d.vms.map((vm) => vm.getAccount(ps[i]!.portfolio).exists);
    // A portfolio the replay closes: removed in the reference afterwards, as in the other VM (an account the run
    // removed is not left as it was in the reference).
    d.reference.withComputeBudget(budget(2_000));
    await d.ok("ClosePortfolio 0, past the limit", ps[0]!.owner, [close(0)], { watch: [ps[1]!.portfolio] });
    expect(d.raised.map((r) => r.label)).toEqual(["ClosePortfolio 0, past the limit"]);
    expect(exists(0)).toEqual([false, false]);
    // Portfolio 1 (watched, so copied into the raised reference above) closed by an ordinary run, then watched by a
    // second replay: it does not exist before that transaction, and the raised reference must not answer with its
    // old copy.
    d.reference.withComputeBudget(budget(CU_LIMIT));
    await d.ok("ClosePortfolio 1", ps[1]!.owner, [close(1)]);
    expect(d.raised.length).toBe(1);
    expect(exists(1)).toEqual([false, false]);
    d.reference.withComputeBudget(budget(2_000));
    await d.ok("ClosePortfolio 2, past the limit, portfolio 1 watched", ps[2]!.owner, [close(2)], { watch: [ps[1]!.portfolio] });
    expect(d.raised.length).toBe(2);
    expect([exists(1), exists(2)]).toEqual([
      [false, false],
      [false, false],
    ]);
    // The market took the three portfolios' lamports in both.
    d.expectSame(m.market, "the market after the closes");
  });

  it("the heap: InitMarket and InitPortfolio also run without the preamble (the runtime's 32 KiB frame)", async () => {
    // The reference's allocator assumes 256 KiB; these two allocate little enough for the default frame. The preamble
    // (256 KiB) stays the harness's default for every instruction until each is measured.
    const d = await Diff.create({ port: "reference" });
    const m = await d.newMarket();
    await d.fails("InitMarket, no heap request", m.admin, [ix.initMarket(m, defaultInitArgs())], "ok", { heap: null, cuLimit: null });
    const { owner, portfolio } = await d.newPortfolio();
    await d.fails("InitPortfolio, no heap request", owner, [ix.initPortfolio(m, owner, portfolio)], "ok", { heap: null, cuLimit: null });
  });
});

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 harness, reference against the port: the refusals of the entry", () => {
  it("refuses empty data and every unknown tag as the reference does, and records both compute units", async () => {
    const d = await Diff.create();
    const m = await d.newMarket();
    const payer = m.admin;
    const known = new Set([0, 1, 3, 4, 5, 6, 8, 9, 10, 13, 19, 24, 28, 30, 32, 34, 35, 36, 37, 38, 39, 40, 42, 43, 44, 45, 46, 48, 49, 50, 51]);
    for (let t = 52; t <= 70; t++) known.add(t);
    expect(known.size).toBe(50);
    const invalid = builtin("InvalidInstructionData", 2);
    await d.fails("no data", payer, [instruction(Buffer.alloc(0), [])], invalid);
    await d.fails(
      "no data, 3 accounts",
      payer,
      [instruction(Buffer.alloc(0), [{ address: payer.address, signer: payer }, { address: m.market, writable: true }, { address: m.mint }])],
      invalid,
    );
    for (let t = 0; t < 256; t++) {
      if (known.has(t)) continue;
      await d.fails(`tag ${t}`, payer, [instruction(u8(t), [])], invalid);
    }
    // With a body after the tag, and with accounts: still the tag alone decides.
    await d.fails("tag 2 + 302 bytes", payer, [instruction(Buffer.concat([u8(2), Buffer.alloc(302, 7)]), [])], invalid);
    await d.fails("tag 71, market and mint", payer, [instruction(u8(71), [{ address: m.market, writable: true }, { address: m.mint }])], invalid);
    // 39 accounts (TradeCpi's 7 and a 32-account tail) and 255, the most an instruction can name, with repeats: the
    // reference builds its AccountInfo list for all of them before it decodes the tag (an O(n²) scan for repeats).
    const others = await Promise.all(Array.from({ length: 8 }, () => d.address()));
    const tail = (n: number) => Array.from({ length: n }, (_, i) => ({ address: i === 0 ? m.market : others[i % others.length]! }));
    await d.fails("tag 2, 39 accounts", payer, [instruction(u8(2), tail(39))], invalid);
    await d.fails("tag 255, 255 accounts", payer, [instruction(u8(255), tail(255))], invalid);
    // The runtime's own 32 KiB heap frame: the reference's account list for 255 accounts still fits.
    await d.fails("tag 255, 255 accounts, no heap request", payer, [instruction(u8(255), tail(255))], builtin("InvalidInstructionData", 0), {
      heap: null,
      cuLimit: null,
    });
    expect(d.compared).toBe(2 + 206 + 2 + 3);
    // The port is cheaper on every refusal here (not required of refusals; recorded in the README).
    for (const [label, [reference, port]] of Object.entries(d.cu)) expect(port < reference, `${label}: ${port} < ${reference}`).toBe(true);
  });
});
