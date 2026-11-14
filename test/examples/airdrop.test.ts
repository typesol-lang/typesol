import { type Address, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployExample, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

describe("examples/airdrop.ts (remaining accounts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployExample("airdrop");
  });

  async function pot(fund: bigint) {
    const admin = await fundedSigner(d.svm, 20n);
    const [addr] = await pda(d.programId, ["pot", admin.address]);
    expectOk(
      await send(d.svm, admin, [
        ix(d, "setup", {}, [{ address: admin.address, signer: admin, writable: true }, { address: addr, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    d.svm.airdrop(addr, fund as never);
    return { admin, addr };
  }

  const extra = (addrs: Address[], writable = true) => addrs.map((address) => ({ address, writable }));

  /** A new owner joins the pot at `potAddr`; returns the Member account. */
  async function join(potAddr: Address, owner?: KeyPairSigner) {
    const who = owner ?? (await fundedSigner(d.svm));
    const [m] = await pda(d.programId, ["member", potAddr, who.address]);
    expectOk(
      await send(d.svm, who, [
        ix(d, "join", {}, [
          { address: who.address, signer: who, writable: true },
          { address: potAddr },
          { address: m, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    return m;
  }

  it("pays every remaining account from a program-owned pot", async () => {
    const { admin, addr } = await pot(1_000_000_000n);
    const people = await Promise.all([1, 2, 3, 4].map(() => generateKeyPairSigner()));
    const drop = (each: number, to: { address: Address; writable: boolean }[]) =>
      ix(d, "airdrop", { each: new BN(each) }, [{ address: admin.address, signer: admin }, { address: addr, writable: true }, ...to]);
    expectOk(await send(d.svm, admin, [drop(1_000_000, extra(people.map((p) => p.address)))]));
    for (const p of people) expect(d.svm.getBalance(p.address)).toBe(1_000_000n);
    expect(decodeAccount<{ paid_out?: BN; paidOut?: BN }>(d, d.svm, "Pot", addr)).toMatchObject({});
    const state = decodeAccount<Record<string, BN>>(d, d.svm, "Pot", addr);
    expect((state.paid_out ?? state.paidOut).toString()).toBe("4000000");

    // A read-only remaining account is refused when the program tries to credit it.
    expect(customError(await send(d.svm, admin, [drop(1, extra([people[0].address], false))]))).toBe(3006);
    // 996M lamports remain above rent: 4 x 249.2M would dip into the rent reserve (6001); asking for
    // more than the pot holds at all fails the checked subtraction first (5100).
    expect(customError(await send(d.svm, admin, [drop(249_200_000, extra(people.map((p) => p.address)))]))).toBe(6001);
    expect(customError(await send(d.svm, admin, [drop(400_000_000, extra(people.map((p) => p.address)))]))).toBe(5100);
    // No remaining accounts: nothing happens.
    expectOk(await send(d.svm, admin, [drop(5, [])]));
  });

  it("updates many Member accounts via loadAccountMut and rejects anything else", async () => {
    const { admin, addr } = await pot(100_000_000n);
    const members: Address[] = [];
    for (let i = 0; i < 3; i++) members.push(await join(addr));
    const award = (points: number, to: { address: Address; writable: boolean }[], who: KeyPairSigner = admin) =>
      ix(d, "award", { points: new BN(points) }, [{ address: who.address, signer: who }, { address: addr }, ...to]);
    expectOk(await send(d.svm, admin, [award(10, extra(members)), award(5, extra(members.slice(1)))]));
    expect(members.map((m) => decodeAccount<{ points: BN }>(d, d.svm, "Member", m).points.toString())).toEqual(["10", "15", "15"]);

    expect(customError(await send(d.svm, admin, [award(1, extra([admin.address]))]))).toBe(3007); // a wallet is not a Member
    expect(customError(await send(d.svm, admin, [award(1, extra([addr]))]))).toBe(3003); // the Pot is ours but not a Member (49 bytes, shorter than a Member: 3003 before the discriminator check)
    expect(customError(await send(d.svm, admin, [award(1, extra([members[0]], false))]))).toBe(3006);
    expect(customError(await send(d.svm, admin, [award(1, extra([members[0], members[0]]))]))).toBe(2040); // same member twice
    const stranger = await fundedSigner(d.svm);
    expect(customError(await send(d.svm, stranger, [award(1, extra(members), stranger)]))).toBe(6000);
  });

  it("refuses to award points to members of another pot (an admin of their own pot is not an admin of yours)", async () => {
    const victim = await pot(10_000_000n);
    const theirs = await join(victim.addr);
    const attacker = await pot(10_000_000n);
    const own = await join(attacker.addr, attacker.admin);
    const award = (who: KeyPairSigner, potAddr: Address, to: Address[]) =>
      ix(d, "award", { points: new BN(1_000_000) }, [{ address: who.address, signer: who }, { address: potAddr }, ...extra(to)]);
    // The attacker signs as the admin of their own pot and passes the victim pot's member: refused (WrongPot).
    expect(customError(await send(d.svm, attacker.admin, [award(attacker.admin, attacker.addr, [theirs])]))).toBe(6002);
    expect(customError(await send(d.svm, attacker.admin, [award(attacker.admin, attacker.addr, [own, theirs])]))).toBe(6002);
    expect(decodeAccount<{ points: BN }>(d, d.svm, "Member", theirs).points.toString()).toBe("0");
    // Naming the victim's pot needs the victim's admin.
    expect(customError(await send(d.svm, attacker.admin, [award(attacker.admin, victim.addr, [theirs])]))).toBe(6000);
    // The honest paths still work.
    expectOk(await send(d.svm, attacker.admin, [award(attacker.admin, attacker.addr, [own])]));
    expectOk(await send(d.svm, victim.admin, [award(victim.admin, victim.addr, [theirs])]));
    expect(decodeAccount<{ points: BN }>(d, d.svm, "Member", theirs).points.toString()).toBe("1000000");
    expect(decodeAccount<{ points: BN }>(d, d.svm, "Member", own).points.toString()).toBe("1000000");
  });

  it("forwards remaining accounts into CPIs", async () => {
    const payer = await fundedSigner(d.svm, 5n);
    const people = await Promise.all([1, 2, 3].map(() => generateKeyPairSigner()));
    const tip = (to: { address: Address; writable: boolean }[]) =>
      ix(d, "tip", { amount: new BN(2_000_000) }, [{ address: payer.address, signer: payer, writable: true }, { address: SYSTEM_PROGRAM }, ...to]);
    expectOk(await send(d.svm, payer, [tip(extra(people.map((p) => p.address)))]));
    for (const p of people) expect(d.svm.getBalance(p.address)).toBe(2_000_000n);
    expect(customError(await send(d.svm, payer, [tip(extra([people[0].address], false))]))).toBe(3006);
  });
});
