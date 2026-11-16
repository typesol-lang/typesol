// showcase/mainnet/percolator against Percolator v12.20 as deployed on mainnet (test/programs/percolator_v12.so): the
// account-list mutation fuzzer. For each of the 27 instructions, its valid transaction in eight market states (empty;
// funded accounts; open positions; a reset-pending side with stale accounts; resolved; Hyperp; Chainlink; inverted) is
// sent once as it is, then with one or two mutations of its account list: an account replaced by another of the test
// world (the slab, another market's slab, an uninitialized slab, the vault, the vault authority, token accounts of the
// market's mint and of others, the mint, the oracle, another oracle, a Chainlink account, the clock and other sysvars,
// the token, system and compute-budget programs, Percolator itself, the matcher and its context, the LP PDA, users,
// the admin, the fee payer, a funded system account, program-owned accounts too short, too long, zeroed or tiny, a key
// with no account), an account duplicated into another position, the last ones dropped, extra ones appended, two
// swapped, the signer and writable flags flipped (a required signer unsigned, writable made read-only, any account
// made a signer: every account of the world is at a keypair's address, so the slab, a token account or the vault can
// sign). Each mutated transaction goes to both programs and is compared as `both()` compares (outcome, error code,
// logs, inner instructions, return data, every named account's bytes, fewer compute units on a success); every account
// is put back afterwards, so every mutation starts from the same state.
//
// PERCOLATOR_MUTATE_SCALE=<n> runs n times as many mutations (default 1: 60 per instruction and state, besides the
// base), PERCOLATOR_MUTATE_SEED another seed, PERCOLATOR_MUTATE_VERBOSE=1 the tally by instruction.
import { type Address, type Instruction } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { HAVE_ORIGINAL } from "./percolator-helpers.js";
import {
  type AccountEntry,
  type Base,
  SCALE,
  SEED,
  type State,
  Tally,
  World,
  bases,
  isSigner,
  isWritable,
  role,
  swapIx,
  trial,
  withSigners,
} from "./percolator-mutate.js";

const PER = Math.max(1, Math.round(60 * SCALE));

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: account-list mutations", () => {
  let w: World;
  const t = new Tally();
  beforeAll(async () => {
    w = await World.create(SEED);
    await w.build();
  }, 600_000);

  /** One random mutation of an account list (in place); its description. */
  async function mutate(s: State, list: AccountEntry[], rng: World["rng"]): Promise<string> {
    const pool = w.pool(s);
    const at = () => rng.int(Math.max(list.length, 1));
    const op = rng.int(9);
    if (list.length === 0) {
      const c = rng.pick(pool);
      list.push({ address: c.address, role: role(false, rng.chance(50)) });
      return `appended ${c.label}`;
    }
    switch (op) {
      case 0: {
        // Replace, with random flags (a signer where the account can sign).
        const i = at();
        const c = rng.pick(pool);
        list[i] = { address: c.address, role: role(rng.chance(30), rng.chance(50)) };
        return `#${i} = ${c.label} (${isSigner(list[i]!.role) ? "signer" : "unsigned"}, ${isWritable(list[i]!.role) ? "writable" : "read-only"})`;
      }
      case 1: {
        // Replace, keeping the position's flags (a signer stays one: every world account can sign).
        const i = at();
        const c = rng.chance(8) ? { label: "a key with no account", address: (await w.key()).address } : rng.pick(pool);
        list[i] = { address: c.address, role: list[i]!.role };
        return `#${i} = ${c.label}`;
      }
      case 2: {
        const [i, j] = [at(), at()];
        list[j] = { address: list[i]!.address, role: list[j]!.role };
        return `#${j} = #${i}`;
      }
      case 3: {
        const n = 1 + rng.int(2);
        list.splice(Math.max(0, list.length - n));
        return `dropped the last ${n}`;
      }
      case 4: {
        const n = 1 + rng.int(3);
        const names: string[] = [];
        for (let k = 0; k < n; k++) {
          const c = rng.pick(pool);
          list.push({ address: c.address, role: role(rng.chance(15), rng.chance(50)) });
          names.push(c.label);
        }
        return `appended ${names.join(", ")}`;
      }
      case 5: {
        const [i, j] = [at(), at()];
        [list[i], list[j]] = [list[j]!, list[i]!];
        return `swapped #${i} and #${j}`;
      }
      case 6: {
        const i = at();
        list[i] = { address: list[i]!.address, role: role(!isSigner(list[i]!.role), isWritable(list[i]!.role)) };
        return `#${i} signer ${isSigner(list[i]!.role)}`;
      }
      case 7: {
        const i = at();
        list[i] = { address: list[i]!.address, role: role(isSigner(list[i]!.role), !isWritable(list[i]!.role)) };
        return `#${i} writable ${isWritable(list[i]!.role)}`;
      }
      default: {
        const i = at();
        list[i] = { address: w.payer.address, role: list[i]!.role };
        return `#${i} = the fee payer`;
      }
    }
  }

  async function run(s: State, b: Base, rng: World["rng"]): Promise<void> {
    const base = b.ixs[b.at]!;
    await trial(w, t, "base", b.name, `${s.name}: ${b.name} (base)`, b.ixs);
    for (let k = 0; k < PER; k++) {
      const list = [...(base.accounts ?? [])].map((a) => ({ address: a.address, role: a.role })) as AccountEntry[];
      const what = [await mutate(s, list, rng)];
      if (rng.chance(35)) what.push(await mutate(s, list, rng));
      const signed = withSigners(w, list);
      if (!signed) continue;
      const i: Instruction = { ...base, accounts: signed as Instruction["accounts"] };
      await trial(w, t, "accounts", b.name, `${s.name}: ${b.name}: ${what.join("; ")}`, swapIx(b, i));
    }
  }

  it("every instruction in every state, its account list mutated", async () => {
    for (const s of w.states)
      for (const b of bases(s)) {
        const rng = w.rng;
        await run(s, b, rng);
      }
    t.print("account-list mutations");
    expect(t.divergences, t.divergences.slice(0, 20).join("\n\n")).toEqual([]);
  }, 3_600_000);

  it("every position replaced by the slab and by the fee payer, and duplicated into every other", async () => {
    // Every position of every instruction replaced by the state's slab, by another market's slab and by the fee payer,
    // and every position duplicated into every other: the aliasing cases the random walk reaches only by chance.
    const t2 = new Tally();
    for (const s of w.states)
      for (const b of bases(s)) {
        const base = b.ixs[b.at]!;
        const n = (base.accounts ?? []).length;
        const subs: [string, Address][] = [
          ["the slab", s.m.slab],
          ["the fee payer", w.payer.address],
        ];
        for (let i = 0; i < n; i++) {
          for (const [label, a] of subs) {
            const list = [...(base.accounts ?? [])].map((x) => ({ address: x.address, role: x.role })) as AccountEntry[];
            if (list[i]!.address === a) continue;
            list[i] = { address: a, role: list[i]!.role };
            const signed = withSigners(w, list);
            if (!signed) continue;
            await trial(
              w,
              t2,
              "aliases",
              b.name,
              `${s.name}: ${b.name}: #${i} = ${label}`,
              swapIx(b, { ...base, accounts: signed as Instruction["accounts"] }),
            );
          }
          for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const list = [...(base.accounts ?? [])].map((x) => ({ address: x.address, role: x.role })) as AccountEntry[];
            if (list[i]!.address === list[j]!.address) continue;
            list[j] = { address: list[i]!.address, role: role(isSigner(list[j]!.role) || isSigner(list[i]!.role), isWritable(list[j]!.role)) };
            const signed = withSigners(w, list);
            if (!signed) continue;
            await trial(w, t2, "aliases", b.name, `${s.name}: ${b.name}: #${j} = #${i}`, swapIx(b, { ...base, accounts: signed as Instruction["accounts"] }));
          }
        }
      }
    t2.print("aliases");
    expect(t2.divergences, t2.divergences.slice(0, 20).join("\n\n")).toEqual([]);
  }, 3_600_000);
});
