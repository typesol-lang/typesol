// showcase/mainnet/spl-stake-pool against SPL Stake Pool as deployed on mainnet (test/programs/spl_stake_pool.so): a
// seeded random walk over many epochs. A pool of several validators (added and removed as it goes), several users and
// a cluster small enough that stake warms up and cools down over several epochs; at each epoch boundary the active
// stake earns rewards (its delegation grows with its lamports, as inflation rewards do) and some stake accounts get
// tips (lamports past their delegation). Every step is one instruction of a user, the staker or the manager, chosen at
// random with random amounts, some of them wrong on purpose (too much, the wrong validator, a stale pool, a missing
// authority); each is sent to both programs through `both()`, which requires the same outcome, logs and bytes. Every
// account the walk knows is also compared after each epoch and every 25 steps, so nothing drifts unseen.
//
// The choices and amounts come from the seed (the keys are fresh each run): reproduce a run with FUZZ_SEED=<seed>,
// lengthen it with STAKE_POOL_FUZZ_STEPS=<n>, compare every account after each step with STAKE_POOL_FUZZ_SWEEP=1. The
// walk's transactions are not in the counts the other files give.
import { type Address, type Instruction, type KeyPairSigner, address, lamports } from "@solana/kit";
import { EpochRewards } from "litesvm";
import { describe, expect, it } from "vitest";
import { stakeHistoryEntry } from "../../src/testing-stake.js";
import { Rng } from "./fuzz-rng.js";
import {
  Diff,
  type Fee,
  type FeeType,
  type Pool,
  SOL,
  STAKE,
  STAKE_ACCOUNT_SIZE,
  STAKE_OFFSETS,
  depositAuthority,
  ephemeralStake,
  fee,
  ix,
  key,
  stakeAuthorizeBoth,
  transientStake,
  u32,
  validatorStake,
} from "./spl-stake-pool-helpers.js";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const STEPS = Number(process.env.STAKE_POOL_FUZZ_STEPS ?? 150);

/** The most compute a transaction may use, appended after the pool's instruction (so its errors stay at index 0). */
const BUDGET: Instruction = {
  programAddress: address("ComputeBudget111111111111111111111111111111"),
  accounts: [],
  data: new Uint8Array(Buffer.concat([Buffer.from([2]), u32(1_400_000)])),
};
const STATUS = ["Active", "DeactivatingTransient", "ReadyForRemoval", "DeactivatingValidator", "DeactivatingAll"];

/** A user's stake account, made and delegated by the Stake program; `authority` holds its staker and withdrawer. */
interface UserStake {
  at: Address;
  owner: KeyPairSigner;
  authority: KeyPairSigner | Address;
}

describe("a random walk over epochs", () => {
  it("deposits, withdraws, rebalances, updates and changes settings at random, the same in both", async () => {
    const rng = new Rng(SEED);
    // The rest of the cluster, the entry each epoch ends with: mostly as on mainnet (400M SOL, any delegation warms up
    // and cools down within the epoch), but in slow stretches of a few epochs only a few hundred SOL, of which about 9%
    // may warm up or cool down per epoch, so stake activates over several epochs (and the pool's merges wait for it). A
    // slow epoch also has a little stake warming up and cooling down: a delegation that grew after its warmup (stake
    // merged into it, rewards) then finishes it, rather than staying partly activating once the cluster has none.
    const slowEpochs = new Set<bigint>();
    const d = await Diff.create({
      cluster: { base: (epoch) => (slowEpochs.has(epoch) ? stakeHistoryEntry(300n * SOL, SOL, SOL) : stakeHistoryEntry(400_000_000n * SOL)) },
    });
    let slow = 0;
    const payer = await d.funded(100_000n);
    const rent = d.original.minimumBalanceForRentExemption(STAKE_ACCOUNT_SIZE);
    const randomFee = (): Fee => {
      const denominator = rng.pick([0n, 100n, 1000n, 10_000n]);
      return fee(denominator === 0n ? 0n : BigInt(rng.int(Number(denominator) / 10 + 1)), denominator);
    };
    const p: Pool = await d.createPool(payer, {
      reserveLamports: 500n * SOL,
      maxValidators: 8,
      epochFee: randomFee(),
      withdrawalFee: fee(BigInt(rng.int(5)), 1000n),
      depositFee: randomFee(),
      referral: rng.int(101),
      label: "fuzz: initialize",
    });

    const stats: Record<string, Record<string, number>> = {};
    const count = (op: string, o: string) => {
      const k = o === "ok" ? "ok" : (/code: (\d+)/.exec(o)?.[1] ?? /error: (\w+) \}$/.exec(o)?.[1] ?? "other");
      (stats[op] ??= {})[k] = (stats[op]![k] ?? 0) + 1;
    };
    let step = -1;
    /** Every address the walk has named: compared across the two VMs after each epoch and every 25 steps. */
    const known = new Set<Address>([p.pool, p.list, p.reserve, p.mint, p.managerFee]);
    const run = async (op: string, what: string, signer: KeyPairSigner, i: Instruction, watch: Address[] = []) => {
      for (const m of i.accounts ?? []) known.add(m.address);
      const got = await d.both(`fuzz step ${step} (seed ${SEED}): ${what}`, signer, [i, BUDGET], watch);
      count(op, got);
      return got;
    };
    const sweep = (when: string) => {
      for (const a of known) expect(d.bytes(d.port, a), `${when} (seed ${SEED}): ${a}`).toBe(d.bytes(d.original, a));
    };

    // The validators: a set of vote accounts, three of them in the pool to begin with.
    const votes: Address[] = [];
    for (let i = 0; i < 10; i++) votes.push(await d.vote(payer));
    const outsider = await d.vote(payer);
    const listed = () => d.validators(p);
    const stakeOf = (v: { vote: Address; seed: number }) => validatorStake(v.vote, p.pool, v.seed);
    /** The validators of the list that are preferred (for deposits or withdrawals): the only votes the pool account holds. */
    const preferredValidators = () => {
      const pool = d.data(p.pool).subarray(330);
      return listed().filter((v) => pool.includes(key(v.vote)));
    };
    for (const v of votes.slice(0, 3)) known.add(await validatorStake(v, p.pool));
    for (const v of votes.slice(0, 3)) await d.ok(`fuzz: add validator ${v}`, payer, [ix.addValidator(p, p.staker, await validatorStake(v, p.pool), v)]);
    const MIN = listed()[0]!.active - rent;

    // The users: SOL, a pool-token account each, and stake accounts they make as they go.
    const users: { k: KeyPairSigner; tokens: Address }[] = [];
    for (let i = 0; i < 3; i++) {
      const k = await d.funded(100_000n);
      users.push({ k, tokens: await d.tokenAccount(payer, p.mint, k.address) });
    }
    const referrer = await d.tokenAccount(payer, p.mint, payer.address);
    for (const u of users) known.add(u.tokens);
    known.add(referrer);
    const stakes: UserStake[] = [];

    // The funding authorities the manager has set (keys the walk holds).
    const auth: { solDeposit?: KeyPairSigner; solWithdraw?: KeyPairSigner; stakeDeposit?: KeyPairSigner } = {};
    const keys = [await d.funded(10n), await d.funded(10n)];
    const pdaDeposit = await depositAuthority(p.pool);
    /** The SOL deposit or withdraw authority to pass: the right one mostly, sometimes none or another key. */
    const fundingSigner = (set: KeyPairSigner | undefined) => {
      if (!set) return rng.chance(3) ? keys[0] : undefined;
      const r = rng.int(100);
      return r < 90 ? set : r < 95 ? undefined : keys.find((k) => k !== set);
    };

    /** Some of `held` pool tokens: a share mostly, now and then dust or more than held. */
    const someTokens = (held: bigint) => {
      const r = rng.int(100);
      if (r < 8) return BigInt(rng.int(3));
      if (r < 14) return held + 1n + (rng.next() % (held + 1n));
      return (held * BigInt(1 + rng.int(100))) / 100n;
    };
    /** A slippage minimum: none mostly, else around what the instruction would give (some of them too much). */
    const minimum = (around: bigint) => (rng.chance(70) ? undefined : (around * BigInt(rng.int(130))) / 100n);

    /** A validator of the list (or, now and then, one that is not). */
    const someValidator = () => {
      const list = listed();
      if (list.length === 0 || rng.chance(5))
        return { vote: rng.chance(50) ? outsider : rng.pick(votes), seed: 0, status: 0, active: 0n, transient: 0n, transientSeed: 0n };
      return rng.pick(list);
    };
    /** An amount of stake to move: mostly between the minimum and `cap`, at times under the minimum or over `cap`. */
    const stakeAmount = (cap: bigint) => {
      const r = rng.int(100);
      if (r < 8) return BigInt(rng.int(Number(MIN)));
      if (r < 16) return cap + 1n + (rng.next() % (cap + SOL));
      if (cap <= MIN) return MIN;
      return MIN + (rng.next() % (cap - MIN + 1n));
    };

    /** The epoch's end: rewards on the active stake, tips, then the next epoch (the pool not updated yet). */
    const nextEpoch = async () => {
      sweep(`before epoch ${d.cluster.epoch + 1n}`);
      if (slow === 0 && rng.chance(12)) slow = 1 + rng.int(5);
      if (slow > 0) {
        slowEpochs.add(d.cluster.epoch);
        slow--;
      }
      d.nextEpoch();
      // In the order the walk met the accounts (not the VM's), so that a seed makes the same choices.
      for (const at of known) {
        if (at === p.reserve || d.original.getAccount(at).programAddress !== STAKE) continue;
        const state = d.stake(at);
        if (state?.kind !== "Stake") continue;
        const a = d.cluster.activation(at);
        if (a.effective === 0n || a.activating !== 0n || a.deactivating !== 0n) continue;
        if (!rng.chance(70)) continue;
        // The account is about to be written in both from the original's bytes: it must agree first.
        expect(d.bytes(d.port, at), `rewards (seed ${SEED}): ${at}`).toBe(d.bytes(d.original, at));
        // A reward the history still counts as fully active: with a cluster this small, a delegation grown past
        // what its warmup took would be partly activating again (no cluster pays such rewards).
        let reward = (a.effective * BigInt(1 + rng.int(50))) / 100_000n;
        while (reward > 0n && d.cluster.activation({ ...state.stake.delegation, stake: state.stake.delegation.stake + reward }).activating !== 0n) reward /= 4n;
        if (reward === 0n) continue;
        d.patch(at, (b) => b.writeBigUInt64LE(b.readBigUInt64LE(STAKE_OFFSETS.stake) + reward, STAKE_OFFSETS.stake), { lamports: d.lamports(at) + reward });
      }
      // Tips: lamports past the delegation, in a validator stake account, a transient one or the reserve.
      for (let i = rng.int(3); i > 0; i--) {
        const list = listed();
        const v = list.length ? rng.pick(list) : undefined;
        const to = v && rng.chance(70) ? (rng.chance(80) ? await stakeOf(v) : await transientStake(v.vote, p.pool, v.transientSeed)) : p.reserve;
        if (!d.original.getAccount(to).exists) continue;
        const tip = BigInt(1 + rng.int(1_000_000_000));
        for (const vm of d.vms) vm.airdrop(to, lamports(tip));
        known.add(to);
      }
      sweep(`after epoch ${d.cluster.epoch}`);
    };

    /** UpdateValidatorListBalance over the list in random chunks (or only a part of it), then the pool, at times. */
    const update = async (whole: boolean) => {
      const list = listed();
      const pairs = await Promise.all(list.map(async (v) => [await stakeOf(v), await transientStake(v.vote, p.pool, v.transientSeed)] as [Address, Address]));
      const noMerge = rng.chance(15);
      if (whole) {
        for (let i = 0; i < Math.max(pairs.length, 1);) {
          const n = 1 + rng.int(5);
          await run(
            "update list",
            `update list ${i}+${n}${noMerge ? " no merge" : ""}`,
            payer,
            ix.updateValidatorListBalance(p, i, noMerge, pairs.slice(i, i + n)),
          );
          i += n;
        }
        await run("update pool", "update pool", payer, ix.updateStakePoolBalance(p));
        if (rng.chance(50)) await run("cleanup", "cleanup", payer, ix.cleanupRemovedValidatorEntries(p));
        return;
      }
      const start = rng.int(pairs.length + 2);
      const n = rng.int(5);
      await run(
        "update list",
        `update list part ${start}+${n}${noMerge ? " no merge" : ""}`,
        payer,
        ix.updateValidatorListBalance(p, start, noMerge, pairs.slice(start, start + n)),
      );
    };

    for (step = 0; step < STEPS; step++) {
      if (step % (process.env.STAKE_POOL_FUZZ_SWEEP ? 1 : 25) === 0) sweep(`step ${step}`);
      const op = rng.int(96);
      const u = rng.pick(users);
      const held = d.tokenBalance(u.tokens);
      if (op < 10) {
        // DepositSol (and its slippage form).
        const amount = rng.chance(10) ? BigInt(rng.int(1000)) : rng.chance(5) ? 2_000_000n * SOL : 1n + (rng.next() % (100n * SOL));
        const min = minimum(amount);
        const i = ix.depositSol(
          p,
          { from: u.k, to: u.tokens, referrer: rng.chance(80) ? referrer : u.tokens, authority: fundingSigner(auth.solDeposit) },
          amount,
          min,
        );
        await run(min === undefined ? "deposit sol" : "deposit sol slippage", `deposit sol ${amount} min ${min}`, payer, i);
      } else if (op < 19) {
        // WithdrawSol (and its slippage form), now and then by the manager from the fee account.
        const fromFees = rng.chance(10);
        const [who, from] = fromFees ? [p.manager, p.managerFee] : [u.k, u.tokens];
        const amount = someTokens(d.tokenBalance(from));
        const min = minimum(amount);
        const i = ix.withdrawSol(p, { transferAuthority: who, from, to: u.k.address, authority: fundingSigner(auth.solWithdraw) }, amount, min);
        await run(min === undefined ? "withdraw sol" : "withdraw sol slippage", `withdraw sol ${amount} min ${min}${fromFees ? " (fees)" : ""}`, payer, i);
      } else if (op < 25) {
        // A user stakes with a validator (of the pool mostly): a stake account the Stake program makes and delegates.
        const preferred = preferredValidators();
        const v =
          preferred.length && rng.chance(50)
            ? rng.pick(preferred).vote
            : rng.chance(85) && listed().length
              ? rng.pick(listed()).vote
              : rng.chance(50)
                ? outsider
                : rng.pick(votes);
        const at = await d.userStake(payer, u.k, MIN + (rng.next() % (40n * SOL)), v);
        stakes.push({ at, owner: u.k, authority: u.k });
        known.add(at);
        count("make user stake", "ok");
      } else if (op < 33) {
        // DepositStake (and its slippage form): the stake handed to the deposit authority first.
        const live = stakes.filter((s) => d.original.getAccount(s.at).exists);
        if (live.length === 0) continue;
        const s = rng.pick(live);
        const state = d.stake(s.at);
        const voter = state?.kind === "Stake" ? state.stake.delegation.voterPubkey : rng.pick(votes);
        const target = auth.stakeDeposit ?? pdaDeposit;
        if (typeof s.authority !== "string" && s.authority.address !== (typeof target === "string" ? target : target.address) && rng.chance(95)) {
          await d.setup(payer, stakeAuthorizeBoth(s.at, s.authority, typeof target === "string" ? target : target.address));
          s.authority = target;
        }
        const entry = listed().find((v) => v.vote === voter);
        // The validator stake account of the stake's validator mostly; another validator's at times.
        const validator = entry && rng.chance(88) ? await stakeOf(entry) : await stakeOf(someValidator());
        const signer = auth.stakeDeposit && rng.chance(95) ? auth.stakeDeposit : (auth.stakeDeposit?.address ?? pdaDeposit);
        const min = minimum(d.lamports(s.at));
        const i = ix.depositStake(
          p,
          { depositAuthority: signer, stake: s.at, validatorStake: validator, to: u.tokens, referrer: rng.chance(80) ? referrer : u.tokens },
          min,
        );
        await run(min === undefined ? "deposit stake" : "deposit stake slippage", `deposit stake ${s.at} into ${validator} min ${min}`, payer, i);
      } else if (op < 41) {
        // WithdrawStake (and its slippage form): mostly from a validator with stake to give (the preferred one at
        // times) and an amount it can give; else from the fullest validator, any one, a transient stake account or the
        // reserve, and any amount.
        const list = listed();
        const preferred = preferredValidators();
        const giving = list.filter((v) => v.active > rent + MIN + SOL);
        const fromFees = rng.chance(10);
        const [who, tokens] = fromFees ? [p.manager, p.managerFee] : [u.k, u.tokens];
        const r = rng.int(100);
        let from: Address = p.reserve;
        let amount = someTokens(d.tokenBalance(tokens));
        if (giving.length && r < 50) {
          const g = preferred.find((v) => giving.includes(v));
          const v = g && rng.chance(70) ? g : rng.pick(giving);
          from = await stakeOf(v);
          const { lamports: total, supply } = d.totals(p);
          const want = ((v.active - rent - MIN) * BigInt(1 + rng.int(100))) / 100n;
          const worth = total === 0n ? want : (want * supply) / total;
          amount = worth < d.tokenBalance(tokens) ? worth : d.tokenBalance(tokens);
        } else if (preferred.length && r < 60) from = await stakeOf(rng.pick(preferred));
        else if (list.length && r < 70) from = await stakeOf(list.reduce((a, b) => (b.active > a.active ? b : a)));
        else if (list.length && r < 80) from = await stakeOf(rng.pick(list));
        else if (list.length && r < 90) {
          const v = rng.pick(list);
          from = await transientStake(v.vote, p.pool, v.transientSeed);
        }
        const min = minimum(amount);
        const receive = await d.allocated(payer, STAKE_ACCOUNT_SIZE, STAKE);
        known.add(receive);
        const i = ix.withdrawStake(p, { split: from, receive, newAuthority: u.k.address, transferAuthority: who, from: tokens }, amount, min);
        await run(min === undefined ? "withdraw stake" : "withdraw stake slippage", `withdraw stake ${amount} from ${from} min ${min}`, payer, i);
      } else if (op < 49) {
        // IncreaseValidatorStake / IncreaseAdditionalValidatorStake, out of the reserve.
        const v = someValidator();
        const reserveFree = d.lamports(p.reserve) - 2n * rent;
        const amount = stakeAmount(reserveFree > 0n ? reserveFree / 3n : 0n);
        const additional = v.transient > 0n ? rng.chance(65) : rng.chance(30);
        const seed = v.transient > 0n && rng.chance(85) ? v.transientSeed : BigInt(rng.int(1000));
        const transient = await transientStake(v.vote, p.pool, seed);
        const ephemeralSeed = BigInt(rng.int(4));
        const stake = await stakeOf(v);
        known.add(transient);
        const i = additional
          ? ix.increaseAdditionalValidatorStake(
              p,
              p.staker,
              { ephemeral: await ephemeralStake(p.pool, ephemeralSeed), transient, stake, vote: v.vote },
              amount,
              seed,
              ephemeralSeed,
            )
          : ix.increaseValidatorStake(p, p.staker, transient, stake, v.vote, amount, seed);
        await run(additional ? "increase additional" : "increase", `increase${additional ? " additional" : ""} ${v.vote} by ${amount} seed ${seed}`, payer, i);
      } else if (op < 57) {
        // DecreaseValidatorStakeWithReserve / DecreaseAdditionalValidatorStake / the deprecated DecreaseValidatorStake.
        const v = someValidator();
        const stake = await stakeOf(v);
        const amount = stakeAmount(v.active > 2n * (MIN + rent) ? v.active - MIN - 2n * rent : MIN);
        const r = rng.int(100);
        const seed = v.transient > 0n && rng.chance(85) ? v.transientSeed : BigInt(rng.int(1000));
        const transient = await transientStake(v.vote, p.pool, seed);
        known.add(transient);
        if (r < 50) {
          await run(
            "decrease with reserve",
            `decrease with reserve ${v.vote} by ${amount} seed ${seed}`,
            payer,
            ix.decreaseValidatorStakeWithReserve(p, p.staker, stake, transient, amount, seed),
          );
        } else if (r < 85) {
          const ephemeralSeed = BigInt(rng.int(4));
          const i = ix.decreaseAdditionalValidatorStake(
            p,
            p.staker,
            { stake, ephemeral: await ephemeralStake(p.pool, ephemeralSeed), transient },
            amount,
            seed,
            ephemeralSeed,
          );
          await run("decrease additional", `decrease additional ${v.vote} by ${amount} seed ${seed}`, payer, i);
        } else {
          // The deprecated form pays no rent: the transient account is funded beforehand, mostly.
          if (rng.chance(75) && !d.original.getAccount(transient).exists) for (const vm of d.vms) vm.airdrop(transient, lamports(rent));
          await run(
            "decrease (deprecated)",
            `decrease ${v.vote} by ${amount} seed ${seed}`,
            payer,
            ix.decreaseValidatorStake(p, p.staker, stake, transient, amount, seed),
          );
        }
      } else if (op < 63) {
        await update(rng.chance(70));
      } else if (op < 66) {
        await run("update pool", "update pool", payer, ix.updateStakePoolBalance(p));
      } else if (op < 68) {
        await run("cleanup", "cleanup", payer, ix.cleanupRemovedValidatorEntries(p));
      } else if (op < 71) {
        // AddValidatorToPool: a vote account not in the list mostly.
        const inList = new Set(listed().map((v) => v.vote));
        const free = votes.filter((v) => !inList.has(v));
        const v = free.length && rng.chance(90) ? rng.pick(free) : rng.pick(votes);
        const seed = rng.int(3);
        const stake = await validatorStake(v, p.pool, seed);
        known.add(stake);
        await run("add validator", `add validator ${v} seed ${seed}`, payer, ix.addValidator(p, p.staker, stake, v, seed));
      } else if (op < 73) {
        // RemoveValidatorFromPool (its transient stake account named by the entry's seed, mostly).
        const v = someValidator();
        const seed = rng.chance(90) ? v.transientSeed : BigInt(rng.int(1000));
        await run(
          "remove validator",
          `remove validator ${v.vote}`,
          payer,
          ix.removeValidator(p, p.staker, await stakeOf(v), await transientStake(v.vote, p.pool, seed)),
        );
      } else if (op < 77) {
        const type = rng.chance(50) ? "Deposit" : "Withdraw";
        const r = rng.int(100);
        const vote = r < 70 ? someValidator().vote : r < 85 ? null : outsider;
        await run("set preferred", `set preferred ${type} ${vote}`, payer, ix.setPreferredValidator(p, p.staker, type, vote));
      } else if (op < 82) {
        const kinds = ["SolReferral", "StakeReferral", "Epoch", "StakeWithdrawal", "SolDeposit", "StakeDeposit", "SolWithdrawal"] as const;
        const kind = rng.pick(kinds);
        let f: FeeType;
        if (kind === "SolReferral" || kind === "StakeReferral") f = { kind, percent: rng.int(110) };
        else if (kind === "StakeWithdrawal" || kind === "SolWithdrawal") {
          // Withdrawal fees may rise by half at most: near the current value mostly.
          const n = BigInt(rng.int(12));
          f = { kind, fee: rng.chance(10) ? randomFee() : fee(n, 1000n) };
        } else f = { kind, fee: rng.chance(8) ? fee(BigInt(101 + rng.int(20)), 100n) : randomFee() };
        await run(
          "set fee",
          `set fee ${JSON.stringify(f, (_, x) => (typeof x === "bigint" ? String(x) : x))}`,
          payer,
          ix.setFee(p, rng.chance(95) ? p.manager : p.staker, f),
        );
      } else if (op < 86) {
        const type = rng.pick(["StakeDeposit", "SolDeposit", "SolWithdraw"] as const);
        const set = rng.chance(60) ? rng.pick(keys) : undefined;
        const who = rng.chance(95) ? p.manager : p.staker;
        const got = await run(
          "set funding authority",
          `set funding ${type} ${set?.address}`,
          payer,
          ix.setFundingAuthority(p, who, type, set?.address ?? null),
        );
        if (got === "ok") {
          if (type === "StakeDeposit") auth.stakeDeposit = set;
          else if (type === "SolDeposit") auth.solDeposit = set;
          else auth.solWithdraw = set;
        }
      } else if (op < 88) {
        // SetStaker (by the manager or the staker): to a new key, which the walk then uses.
        const next = await d.funded(10n);
        const by = rng.chance(50) ? p.manager : p.staker;
        if ((await run("set staker", `set staker ${next.address}`, payer, ix.setStaker(p, by, next.address))) === "ok") p.staker = next;
      } else if (op < 89) {
        // SetManager: to a new key and fee account.
        const next = await d.funded(10n);
        const feeAccount = await d.tokenAccount(payer, p.mint, next.address);
        known.add(feeAccount);
        if ((await run("set manager", `set manager ${next.address}`, payer, ix.setManager(p, p.manager, next, feeAccount))) === "ok") {
          p.manager = next;
          p.managerFee = feeAccount;
        }
      } else {
        // The epoch ends; the pool is updated at once mostly, else later (the instructions meanwhile meet a stale
        // pool). Now and then the cluster still pays rewards out when the update comes.
        await nextEpoch();
        if (rng.chance(5)) {
          const inactive = d.original.getEpochRewards();
          for (const vm of d.vms)
            vm.setEpochRewards(new EpochRewards(d.original.getClock().slot + 2n, 4n, inactive.parentBlockhash, 10n ** 20n, 5n * SOL, SOL, true));
          await update(false);
          for (const vm of d.vms) vm.setEpochRewards(inactive);
        }
        if (rng.chance(85)) await update(true);
        count("next epoch", "ok");
      }
    }
    // At the end: the pool brought up to date, and every account the walk knows compared.
    await nextEpoch();
    await update(true);
    sweep("end");
    const list = listed();
    console.log(
      `stake-pool fuzz (seed ${SEED}): ${STEPS} steps, epoch ${d.cluster.epoch}, ${d.compared} transactions, ${list.length} validators ` +
        `(${list.map((v) => `${STATUS[v.status]} ${v.active}/${v.transient}`).join(", ")}), totals ${JSON.stringify(d.totals(p), (_, x) => (typeof x === "bigint" ? String(x) : x))}`,
    );
    console.log(JSON.stringify(stats));
  }, 3_600_000);
});
