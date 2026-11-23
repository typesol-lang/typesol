// SyncMaintenanceFee (48) and Withdraw (4) of the Percolator v16 port (showcase/mainnet/percolator-v16) against the
// reference: Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and aeyakovenko/percolator,
// Apache-2.0; test/programs/percolator_v16.so is the Rust build of those commits, not a deployed program. Every
// transaction is compared whole (percolator-v16-helpers.ts `Diff`): outcome, logs, inner instructions (Withdraw's SPL
// Token Transfer signed by the vault PDA), return data and every named account; the port must use fewer compute units
// on each success.
//
// - The fee and the withdrawal on portfolios the ported instructions make (no legs): the fee charged into asset 0's
//   insurance budgets with the carry alternating odd atoms, the cranker's share, a portfolio emptied by its fee and
//   closed into the market, withdrawals of part, all (the fee collected first), nothing and too much.
// - Their refusals in order, on the accounts and on patched state.
// - Generated states (percolator-v16-states.ts): the market and both portfolios rewritten into states the original's
//   validators accept (legs, PnL of either sign, fee debt, locks, money totals, budgets, the fee rate up to u128::MAX,
//   the fee slot against the Clock), then SyncMaintenanceFee (no cranker, itself, the other portfolio), Withdraw,
//   Deposit or ClosePortfolio; PERCOLATOR_V16_STATE_FUZZ (400) states. A Live portfolio with an active leg whose fee
//   anchor has moved has its legs settled first (`settle_account_side_effects_not_atomic`), compared like the rest.
// - States with open legs the fee settles (`generate(…, open)`: claims and liens on the market's domains, K/F/B indices
//   a step from the legs' snapshots, stale cohorts), PERCOLATOR_V16_OPEN_STATES (300); the count of successes that
//   settled legs is printed (PERCOLATOR_V16_STATE_OUTCOMES=1 also prints SyncMaintenanceFee's outcomes on them).
import type { Address, Instruction, KeyPairSigner } from "@solana/kit";
import { AccountRole, getAddressEncoder } from "@solana/kit";
import { pda } from "../../test/harness.js";
import { beforeAll, describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import {
  ATA_PROGRAM,
  Diff,
  HAVE_PORT,
  HAVE_REFERENCE,
  type Market,
  TOKEN,
  TOKEN_2022,
  err,
  errB,
  ix,
  marketAt,
  portfolioAt,
} from "./percolator-v16-helpers.js";
import { tokenAccountBytes } from "./percolator-helpers.js";
import { apply, generate } from "./percolator-v16-states.js";
import { SEED, World } from "./percolator-v16-world.js";
import { sizeOf } from "./percolator-v16-layout.js";

const LEG_LEN = sizeOf("PortfolioLeg");

const E = {
  ExpectedSigner: 6,
  ExpectedWritable: 7,
  Unauthorized: 8,
  InvalidInstruction: 9,
  InvalidMint: 10,
  InvalidTokenAccount: 11,
  InvalidVaultAccount: 12,
  InvalidTokenProgram: 13,
  EngineInvalidConfig: 14,
  EngineStale: 19,
  EngineLockActive: 21,
  EngineProvenanceMismatch: 16,
} as const;
const STATE_FUZZ = Number(process.env.PERCOLATOR_V16_STATE_FUZZ ?? 400);
/** States whose open legs the fee settles (`generate(…, open)`); PERCOLATOR_V16_OPEN_STATES for a larger run. */
const OPEN_STATES = Number(process.env.PERCOLATOR_V16_OPEN_STATES ?? 300);

function role(i: Instruction, at: number, r: AccountRole): Instruction {
  const accounts = [...(i.accounts ?? [])] as { address: Address; role: AccountRole }[];
  accounts[at] = { address: accounts[at]!.address, role: r };
  return { ...i, accounts: accounts as Instruction["accounts"] };
}
function replace(i: Instruction, at: number, address: Address): Instruction {
  const accounts = [...(i.accounts ?? [])] as { address: Address; role: AccountRole }[];
  accounts[at] = { address, role: accounts[at]!.role };
  return { ...i, accounts: accounts as Instruction["accounts"] };
}
function setInt(b: Buffer, at: number, size: number, v: bigint): void {
  let x = v < 0n ? (1n << BigInt(8 * size)) + v : v;
  for (let i = 0; i < size; i++) {
    b[at + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}
const u128At = (b: Buffer, at: number) => b.readBigUInt64LE(at) | (b.readBigUInt64LE(at + 8) << 64n);

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: SyncMaintenanceFee and Withdraw", () => {
  let d: Diff;
  let m: Market;
  beforeAll(async () => {
    d = await Diff.create();
  });

  /** An SPL Token account of `mint` held by `owner` (with a state, a delegate). */
  async function token(o: Parameters<typeof tokenAccountBytes>[0]): Promise<Address> {
    const k = await d.address();
    d.write(k, TOKEN, tokenAccountBytes(o));
    return k;
  }

  /** A market charging `rate` a slot, a portfolio of its owner holding `deposit`, the owner's token account. */
  async function funded(rate: bigint, deposit: bigint): Promise<{ owner: KeyPairSigner; portfolio: Address; source: Address }> {
    const { owner, portfolio } = await d.newPortfolio();
    await d.ok("InitPortfolio", owner, [ix.initPortfolio(m, owner, portfolio)]);
    const source = await d.tokenAccount(m.mint, owner.address, 10n ** 12n);
    if (deposit !== 0n)
      await d.ok("Deposit", owner, [ix.deposit(m, owner, portfolio, source, d.portfolioId(portfolio), d.portfolioSequence(portfolio), deposit)]);
    void rate;
    return { owner, portfolio, source };
  }

  it("charges the fee into asset 0's budgets, pays the cranker's share, closes a portfolio its fee empties", async () => {
    m = await d.market({ args: { maintenanceFeePerSlot: 7n } });
    const a = await funded(7n, 1_000_000n);
    const b = await funded(7n, 1_000_000n);
    // The Clock moves; nothing synced yet: each sync charges rate × elapsed slots.
    d.setClock(d.slot + 101n);
    await d.ok("SyncMaintenanceFee, no cranker (707: odd, the carry flips)", a.owner, [ix.syncMaintenanceFee(m, a.portfolio, 0n)]);
    d.setClock(d.slot + 3n);
    await d.ok("SyncMaintenanceFee, again (21: odd, the carry flips back)", a.owner, [ix.syncMaintenanceFee(m, a.portfolio, 0n)]);
    await d.ok("SyncMaintenanceFee, same slot (nothing)", a.owner, [ix.syncMaintenanceFee(m, a.portfolio, 5n)]);
    // The cranker's share (the market authority's maintenance-fee policy sets it; patched here, both VMs).
    d.patch(m.market, (x) => x.writeUInt16LE(2_500, marketAt.wrapper("maintenance_cranker_fee_share_bps")));
    d.setClock(d.slot + 10n);
    await d.ok("SyncMaintenanceFee, the portfolio as its own cranker", b.owner, [ix.syncMaintenanceFee(m, a.portfolio, 0n, a.portfolio)]);
    d.setClock(d.slot + 13n);
    await d.ok("SyncMaintenanceFee, another portfolio as the cranker", b.owner, [ix.syncMaintenanceFee(m, a.portfolio, 0n, b.portfolio)]);
    d.patch(m.market, (x) => x.writeUInt16LE(10_000, marketAt.wrapper("maintenance_cranker_fee_share_bps")));
    d.setClock(d.slot + 1n);
    await d.ok("SyncMaintenanceFee, the whole fee to the cranker", b.owner, [ix.syncMaintenanceFee(m, b.portfolio, 0n, a.portfolio)]);
    d.patch(m.market, (x) => x.writeUInt16LE(0, marketAt.wrapper("maintenance_cranker_fee_share_bps")));
    // A portfolio holding exactly the fee due: emptied, deregistered and closed into the market.
    const c = await funded(7n, 70n);
    d.setClock(d.slot + 10n);
    await d.ok("SyncMaintenanceFee, the fee empties the portfolio: closed", a.owner, [ix.syncMaintenanceFee(m, c.portfolio, 0n)]);
    expect(d.reference.getAccount(c.portfolio).exists).toBe(false);
    // A portfolio holding less than the fee due: all of it charged, closed.
    const e = await funded(7n, 5n);
    d.setClock(d.slot + 10n);
    await d.ok("SyncMaintenanceFee, the fee above the capital: all charged, closed", a.owner, [ix.syncMaintenanceFee(m, e.portfolio, 0n, a.portfolio)]);
    // A portfolio not emptied by its fee (LockActive from the deregistration, swallowed: NOTES.md site 1).
    d.setClock(d.slot + 10n);
    await d.ok("SyncMaintenanceFee, not empty after the fee (LockActive swallowed)", a.owner, [ix.syncMaintenanceFee(m, b.portfolio, 0n)]);
    expect(d.reference.getAccount(b.portfolio).exists).toBe(true);
  });

  it("withdraws part, all with the fee collected first, nothing, and refuses too much", async () => {
    m = await d.market({ args: { maintenanceFeePerSlot: 3n } });
    const a = await funded(3n, 1_000_000n);
    const w = (amount: bigint, o: { dest?: Address } = {}) =>
      ix.withdraw(m, a.owner, a.portfolio, o.dest ?? a.source, d.portfolioId(a.portfolio), d.portfolioSequence(a.portfolio), amount);
    d.setClock(d.slot + 5n);
    await d.ok("Withdraw part (the fee collected first)", a.owner, [w(1_000n)]);
    await d.ok("Withdraw 0 (ends after the token checks)", a.owner, [w(0n)]);
    await d.fails("Withdraw more than the capital", a.owner, [w(10n ** 9n)], err(E.EngineLockActive));
    await d.fails("Withdraw above u64", a.owner, [w(1n << 64n)], err(E.InvalidInstruction));
    d.setClock(d.slot + 50n);
    const capital = u128At(d.data(a.portfolio), portfolioAt("capital"));
    // The amount submitted is the capital before this instruction's fee: all that is left after it is withdrawn.
    await d.ok("Withdraw all (the stale balance after the fee)", a.owner, [w(capital)]);
    expect(u128At(d.data(a.portfolio), portfolioAt("capital"))).toBe(0n);
    await d.ok("Withdraw all of nothing (a zero transfer)", a.owner, [w(0n)]);
    // Deposit and withdraw again without a fee.
    m = await d.market({ args: { maintenanceFeePerSlot: 0n } });
    const z = await funded(0n, 500n);
    await d.ok("Withdraw without a fee", z.owner, [
      ix.withdraw(m, z.owner, z.portfolio, z.source, d.portfolioId(z.portfolio), d.portfolioSequence(z.portfolio), 500n),
    ]);
  });

  it("refuses Withdraw in the original's order", async () => {
    m = await d.market({ args: { maintenanceFeePerSlot: 1n } });
    const a = await funded(1n, 1_000_000n);
    const stranger = await d.funded();
    const base = () => ix.withdraw(m, a.owner, a.portfolio, a.source, d.portfolioId(a.portfolio), d.portfolioSequence(a.portfolio), 10n);
    await d.fails("Withdraw: 6 accounts", a.owner, [{ ...base(), accounts: base().accounts!.slice(0, 6) }], errB("NotEnoughAccountKeys"));
    await d.fails("Withdraw: owner not signing", stranger, [role(base(), 0, AccountRole.READONLY)], err(E.ExpectedSigner));
    for (const at of [1, 2, 3, 4])
      await d.fails(`Withdraw: position ${at} read-only`, a.owner, [role(base(), at, AccountRole.READONLY)], err(E.ExpectedWritable));
    await d.fails("Withdraw: the market not the program's", a.owner, [replace(base(), 1, a.source)], errB("IncorrectProgramId"));
    await d.fails("Withdraw: Token-2022", a.owner, [replace(base(), 6, TOKEN_2022)], err(E.InvalidTokenProgram));
    await d.fails(
      "Withdraw: another id",
      a.owner,
      [ix.withdraw(m, a.owner, a.portfolio, a.source, 99n, d.portfolioSequence(a.portfolio), 10n)],
      err(E.EngineProvenanceMismatch),
    );
    await d.fails(
      "Withdraw: a stale sequence",
      a.owner,
      [ix.withdraw(m, a.owner, a.portfolio, a.source, d.portfolioId(a.portfolio), 7n, 10n)],
      err(E.EngineStale),
    );
    await d.fails("Withdraw: the vault authority", a.owner, [replace(base(), 5, a.source)], errB("InvalidArgument"));
    const other = await d.mint();
    const foreign = await d.tokenAccount(other, a.owner.address, 0n);
    await d.fails("Withdraw: a destination of another mint", a.owner, [replace(base(), 3, foreign)], err(E.InvalidMint));
    const strangers = await d.tokenAccount(m.mint, stranger.address, 0n);
    await d.fails("Withdraw: a destination of another owner", a.owner, [replace(base(), 3, strangers)], err(E.InvalidTokenAccount));
    const frozen = await token({ mint: m.mint, owner: a.owner.address, state: 2 });
    await d.fails("Withdraw: a frozen destination", a.owner, [replace(base(), 3, frozen)], err(E.InvalidTokenAccount));
    const loose = await d.tokenAccount(m.mint, m.vaultPda, 0n);
    await d.fails("Withdraw: a vault not at the canonical address", a.owner, [replace(base(), 4, loose)], err(E.InvalidVaultAccount));
    d.patch(m.vault, (x) => {
      x.writeUInt32LE(1, 72);
    });
    await d.fails("Withdraw: a vault with a delegate", a.owner, [base()], err(E.InvalidVaultAccount));
    d.patch(m.vault, (x) => x.writeUInt32LE(0, 72));
    // A delegate on the destination is allowed (require_unencumbered_dest is false).
    const delegated = await token({ mint: m.mint, owner: a.owner.address, delegate: stranger.address });
    await d.ok("Withdraw: a destination with a delegate", a.owner, [replace(base(), 3, delegated)]);
    await d.fails(
      "Withdraw: the stranger signing for the portfolio",
      stranger,
      [ix.withdraw(m, stranger, a.portfolio, strangers, d.portfolioId(a.portfolio), d.portfolioSequence(a.portfolio), 10n)],
      err(E.Unauthorized),
    );
    // The vault's balance below the amount (the engine's accounts allow it).
    const amount = d.amount(m.vault);
    d.patch(m.vault, (x) => x.writeBigUInt64LE(5n, 64));
    await d.fails("Withdraw: the vault's balance short", a.owner, [base()], err(E.InvalidTokenAccount));
    d.patch(m.vault, (x) => x.writeBigUInt64LE(amount, 64));
    // Patched portfolios: a loss the capital cannot cover, a fee debt above the equity, an open leg (no fee: Stale).
    const snap = d.data(a.portfolio);
    d.patch(a.portfolio, (x) => setInt(x, portfolioAt("fee_credits"), 16, -(10n ** 9n)));
    await d.fails("Withdraw: the fee debt above the equity after", a.owner, [base()], err(E.EngineInvalidConfig));
    d.patch(a.portfolio, (x) => snap.copy(x));
    d.patch(m.market, (x) => x.writeBigUInt64LE(1n, marketAt.group("negative_pnl_account_count")));
    d.patch(a.portfolio, (x) => setInt(x, portfolioAt("pnl"), 16, -(10n ** 7n)));
    await d.fails("Withdraw: a loss above the capital (settled, still negative)", a.owner, [base()], err(E.EngineLockActive));
    d.patch(a.portfolio, (x) => snap.copy(x));
    d.patch(a.portfolio, (x) => setInt(x, portfolioAt("pnl"), 16, -400n));
    await d.ok("Withdraw: a loss the capital covers (settled from principal first)", a.owner, [base()]);
    // The secondary collateral mint: its canonical vault and a destination of it (the market's config names it).
    const second = await d.mint();
    const [secondVault] = await pda(ATA_PROGRAM, [m.vaultPda, TOKEN, second]);
    d.write(secondVault, TOKEN, tokenAccountBytes({ mint: second, owner: m.vaultPda, amount: 10n ** 6n }));
    const secondDest = await token({ mint: second, owner: a.owner.address });
    const viaSecond = replace(replace(base(), 3, secondDest), 4, secondVault);
    await d.fails("Withdraw: a mint the market does not name", a.owner, [viaSecond], err(E.InvalidMint));
    d.patch(m.market, (x) => Buffer.from(getAddressEncoder().encode(second)).copy(x, marketAt.wrapper("secondary_collateral_mint")));
    await d.ok("Withdraw: from the secondary mint's vault", a.owner, [viaSecond]);
    // The market in Resolved: refused before the token checks.
    const ms = d.data(m.market);
    d.patch(m.market, (x) => (x[marketAt.group("mode")] = 1));
    await d.fails("Withdraw: a resolved market", a.owner, [base()], err(E.EngineLockActive));
    d.patch(m.market, (x) => ms.copy(x));
  });

  it("refuses SyncMaintenanceFee in the original's order", async () => {
    m = await d.market({ args: { maintenanceFeePerSlot: 2n } });
    const a = await funded(2n, 1_000n);
    const b = await funded(2n, 0n);
    const payer = await d.funded();
    const base = (cranker?: Address) => ix.syncMaintenanceFee(m, a.portfolio, 0n, cranker);
    await d.fails("Sync: 1 account", payer, [{ ...base(), accounts: base().accounts!.slice(0, 1) }], errB("NotEnoughAccountKeys"));
    for (const at of [0, 1]) await d.fails(`Sync: position ${at} read-only`, payer, [role(base(), at, AccountRole.READONLY)], err(E.ExpectedWritable));
    // The portfolio repeated read-only as its cranker is writable (the transaction merges an account's roles).
    await d.ok("Sync: the portfolio again, read-only, as its cranker", payer, [role(base(a.portfolio), 2, AccountRole.READONLY)]);
    await d.fails("Sync: the cranker read-only", payer, [role(base(b.portfolio), 2, AccountRole.READONLY)], err(E.ExpectedWritable));
    await d.fails("Sync: the cranker not the program's", payer, [replace(base(a.portfolio), 2, payer.address)], errB("IncorrectProgramId"));
    await d.send("Sync: the market as the cranker", payer, [replace(base(a.portfolio), 2, m.market)]);
    await d.send("Sync: the market as the portfolio", payer, [replace(base(), 1, m.market)]);
    await d.send("Sync: the cranker an uninitialized account of the program", payer, [replace(base(a.portfolio), 2, (await d.newPortfolio()).portfolio)]);
    const snap = d.data(m.market);
    d.patch(m.market, (x) => (x[marketAt.group("mode")] = 2));
    await d.fails("Sync: a market in Recovery", payer, [base()], err(E.EngineLockActive));
    d.patch(m.market, (x) => snap.copy(x));
    d.patch(a.portfolio, (x) => x.writeBigUInt64LE(d.slot + 10n, portfolioAt("last_fee_slot")));
    await d.fails("Sync: the fee slot ahead of the Clock", payer, [base()], err(E.EngineStale));
  });

  async function states(count: number, open: boolean, seed: bigint): Promise<void> {
    const STATE_FUZZ = count;
    const w = await World.build(seed);
    w.accounts.push(w.m.vault);
    w.take();
    const rng = new Rng(seed);
    const tally = new Map<string, [number, number]>();
    const byKind = new Map<string, [number, number]>();
    const refusals = new Map<string, number>();
    const settled = new Map<string, number>();
    const outcomes = new Map<string, number>();
    let accepted = 0;
    let probed = 0;
    for (let n = 0; n < STATE_FUZZ; n++) {
      w.restore();
      w.d.setClock(w.d.slot + BigInt(rng.chance(80) ? rng.int(100) : rng.int(10_000_000)));
      const { patch, info } = generate(w, rng, open);
      const k = rng.chance(75) ? 0 : 1;
      const [o, p] = [w.owners[k]!, w.portfolios[k]!];
      const id = w.d.portfolioId(p);
      // Acceptance by the validators: a Deposit of 0 on a Live state runs validate_with_market and nothing else of the
      // engine (`deposit_not_atomic` returns after it for 0); the market's shape is checked by the view before.
      apply(w, patch);
      if (info.mode === "live") {
        probed++;
        const got = await w.d.send(`state ${n} probe (Deposit 0)`, o, [ix.deposit(w.m, o, p, w.sources[k]!, id, w.d.portfolioSequence(p), 0n)]);
        if (got === "ok") accepted++;
        else refusals.set(got.replace(/.*error: /, ""), (refusals.get(got.replace(/.*error: /, "")) ?? 0) + 1);
        w.restore();
        apply(w, patch);
      }
      const capital = u128At(w.d.data(p), portfolioAt("capital"));
      const seq = w.d.portfolioSequence(p);
      // With open legs: SyncMaintenanceFee mostly (the settlement's caller), Withdraw often.
      const r = open ? rng.pick([0, 0, 1, 1, 2, 3, 4, 5, 8, 9]) : rng.int(10);
      let tag: number;
      let tx: Instruction;
      let name: string;
      if (r < 4) {
        tag = 48;
        const c = rng.int(3);
        name = ["SyncMaintenanceFee", "SyncMaintenanceFee (self cranker)", "SyncMaintenanceFee (other cranker)"][c]!;
        tx = ix.syncMaintenanceFee(w.m, p, BigInt(rng.int(3)), c === 0 ? undefined : c === 1 ? p : w.portfolios[1 - k]!);
      } else if (r < 8) {
        tag = 4;
        name = "Withdraw";
        const pickAmount = rng.int(8);
        const amount =
          pickAmount === 0
            ? 0n
            : pickAmount === 1
              ? 1n
              : pickAmount < 4
                ? capital
                : pickAmount === 4
                  ? capital + 1n
                  : pickAmount === 5
                    ? capital / 2n
                    : BigInt(rng.int(1_000_000));
        tx = ix.withdraw(w.m, o, p, w.sources[k]!, id, seq, amount);
      } else if (r === 8) {
        tag = 3;
        name = "Deposit";
        tx = ix.deposit(w.m, o, p, w.sources[k]!, id, seq, BigInt(rng.int(3) === 0 ? 0 : rng.int(1_000_000)));
      } else {
        tag = 8;
        name = "ClosePortfolio";
        tx = ix.closePortfolio(w.m, o, p, id, seq, 0n);
      }
      const label = `state ${n} ${name} (${info.mode}, ${info.legs} legs, PnL ${info.pnl}, rate ${info.feeRate})`;
      const legsOf = () => {
        const a = w.d.reference.getAccount(p);
        return a.exists && a.data.length === 9563 ? Buffer.from(a.data.subarray(portfolioAt("legs"), portfolioAt("legs") + 2 * LEG_LEN)) : Buffer.alloc(0);
      };
      const legsBefore = legsOf();
      const got = await w.d.send(label, o, [tx]);
      // The leg settlement ran (and the transaction succeeded) where a leg's snapshots moved.
      if (got === "ok" && legsBefore.length && legsOf().length && !legsBefore.equals(legsOf())) settled.set(name, (settled.get(name) ?? 0) + 1);
      const t = tally.get(name) ?? [0, 0];
      t[0]++;
      if (got === "ok") t[1]++;
      tally.set(name, t);
      const kind = `${info.mode}, ${info.legs ? "legs" : "flat"}`;
      if (process.env.PERCOLATOR_V16_STATE_OUTCOMES && kind === "live, legs" && tag === 48) {
        const key = got === "ok" ? "ok" : got.replace(/[\s\S]*?(InstructionErrorCustom \{ code: \d+ \}|InstructionError[A-Za-z]+)[\s\S]*/, "$1");
        outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
      }
      const s = byKind.get(kind) ?? [0, 0];
      s[0]++;
      if (got === "ok") s[1]++;
      byKind.set(kind, s);
    }
    const fmt = (m: Map<string, [number, number]>) => [...m].map(([k, [n, ok]]) => `${k} ${ok}/${n}`).join(", ");
    console.log(
      `generated states${open ? " with open legs" : ""}: ${STATE_FUZZ}; accepted by the validators (Deposit 0 on Live states) ${accepted}/${probed}; successes in both by instruction: ${fmt(tally)}; by state: ${fmt(byKind)}; successes that settled legs: ${[...settled].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; the probe's refusals: ${[...refusals].map(([k, v]) => `${k} ×${v}`).join(", ") || "none"}`,
    );
    if (outcomes.size) console.log(`SyncMaintenanceFee on Live states with legs: ${[...outcomes].map(([k, v]) => `${k} ×${v}`).join(", ")}`);
    expect(accepted).toBeGreaterThan(probed / 2);
    return;
  }

  it(
    `generated states: ${STATE_FUZZ} of them, each with SyncMaintenanceFee, Withdraw, Deposit or ClosePortfolio`,
    () => states(STATE_FUZZ, false, SEED + 7n),
    1_800_000,
  );
  it(
    `generated states with open legs the fee settles: ${OPEN_STATES} of them, each with SyncMaintenanceFee, Withdraw, Deposit or ClosePortfolio`,
    () => states(OPEN_STATES, true, SEED + 11n),
    3_600_000,
  );
});

export { TOKEN };
