import { getCreateAccountInstruction } from "@solana-program/system";
import * as spl from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { type Address, type KeyPairSigner, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { beforeAll, describe, expect, it } from "vitest";
import {
  BN,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  customError,
  decodeAccount,
  deployExample,
  expectOk,
  fundedSigner,
  ix,
  pda,
  send,
  type Deployed,
  acct,
  TOKEN_2022,
} from "../harness.js";

describe("examples/minter.ts on SPL Token and Token-2022", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployExample("minter");
  });

  /**
   * A mint created with `admin` as its authority, then set up: `setup` moves the mint authority to the program's
   * config PDA. Token-2022 mints get a MintCloseAuthority extension.
   */
  async function setupMint(program: Address) {
    const { svm } = d;
    const admin = await fundedSigner(svm);
    const { mint, config } = await createMint(program, admin);
    expectOk(await send(svm, admin, [setupIx(admin, config, mint.address, program)]));
    const ata = async (owner: KeyPairSigner) => {
      const create = program === TOKEN_2022
        ? await t22.getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner: owner.address, mint: mint.address, tokenProgram: TOKEN_2022 })
        : await t22.getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner: owner.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM });
      expectOk(await send(svm, admin, [create]));
      return create.accounts[1].address as Address;
    };
    return { svm, admin, mint: mint.address, config, ata, program };
  }

  /** A mint whose mint authority is `authority`. */
  async function createMint(program: Address, authority: KeyPairSigner) {
    const { svm } = d;
    const mint = await generateKeyPairSigner();
    const [config] = await pda(d.programId, ["config", mint.address]);
    const is2022 = program === TOKEN_2022;
    const space = is2022 ? t22.getMintSize([{ __kind: "MintCloseAuthority", closeAuthority: authority.address }]) : spl.getMintSize();
    const rent = svm.minimumBalanceForRentExemption(BigInt(space));
    const ixs = [
      getCreateAccountInstruction({ payer: authority, newAccount: mint, lamports: lamports(rent), space, programAddress: program }),
      ...(is2022 ? [t22.getInitializeMintCloseAuthorityInstruction({ mint: mint.address, closeAuthority: authority.address })] : []),
      is2022
        ? t22.getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: authority.address })
        : spl.getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: authority.address }),
    ];
    expectOk(await send(svm, authority, ixs));
    return { mint, config };
  }

  const setupIx = (signer: KeyPairSigner, config: Address, mint: Address, program: Address, cap = 1_000_000) =>
    ix(d, "setup", { cap: new BN(cap) }, [
      { address: signer.address, signer, writable: true },
      { address: config, writable: true },
      { address: mint, writable: true },
      { address: program },
      { address: SYSTEM_PROGRAM },
    ]);

  /** The mint's COption<Pubkey> mint authority (offsets 0..36 in both token programs). */
  const mintAuthorityOf = (svm: Deployed["svm"], mint: Address) => {
    const data = Buffer.from(acct(svm, mint).data);
    return data.readUInt32LE(0) === 1 ? data.subarray(4, 36) : null;
  };

  const balance = (svm: Deployed["svm"], a: Address) => {
    const acct = svm.getAccount(a);
    if (!acct.exists) return undefined;
    return Buffer.from(acct.data).readBigUInt64LE(64);
  };

  for (const [label, program] of [
    ["SPL Token", TOKEN_PROGRAM],
    ["Token-2022 (with extensions)", TOKEN_2022],
  ] as const) {
    it(`issues under a cap, pays with transferChecked and burns — ${label}`, async () => {
      const m = await setupMint(program);
      const alice = await fundedSigner(m.svm);
      const bob = await fundedSigner(m.svm);
      const [aliceAta, bobAta] = [await m.ata(alice), await m.ata(bob)];
      if (program === TOKEN_2022) expect(acct(m.svm, aliceAta).data.length).toBeGreaterThan(165);

      const issue = (amount: number, signer = m.admin) =>
        ix(d, "issue", { amount: new BN(amount) }, [
          { address: signer.address, signer },
          { address: m.config, writable: true },
          { address: m.mint, writable: true },
          { address: aliceAta, writable: true },
          { address: m.program },
        ]);
      expectOk(await send(m.svm, m.admin, [issue(700_000)]));
      expect(balance(m.svm, aliceAta)).toBe(700_000n);
      expect(decodeAccount<{ minted: BN }>(d, m.svm, "Config", m.config).minted.toString()).toBe("700000");
      expect(customError(await send(m.svm, m.admin, [issue(300_001)]))).toBe(6001);
      expect(customError(await send(m.svm, alice, [issue(1, alice)]))).toBe(6000);

      expectOk(
        await send(m.svm, alice, [
          ix(d, "pay", { amount: new BN(250_000) }, [
            { address: alice.address, signer: alice },
            { address: aliceAta, writable: true },
            { address: m.mint },
            { address: bobAta, writable: true },
            { address: m.program },
          ]),
        ]),
      );
      expect([balance(m.svm, aliceAta), balance(m.svm, bobAta)]).toEqual([450_000n, 250_000n]);

      const burned = expectOk(
        await send(m.svm, bob, [
          ix(d, "burn", { amount: new BN(50_000) }, [
            { address: bob.address, signer: bob },
            { address: bobAta, writable: true },
            { address: m.mint, writable: true },
            { address: m.program },
          ]),
        ]),
      );
      expect(Buffer.from(burned.returnData().data()).readBigUInt64LE()).toBe(650_000n);
    });
  }

  for (const [label, program] of [
    ["SPL Token", TOKEN_PROGRAM],
    ["Token-2022", TOKEN_2022],
  ] as const) {
    it(`only the mint's current authority can set up its config, which takes over the mint authority — ${label}`, async () => {
      const { svm } = d;
      const owner = await fundedSigner(svm);
      const attacker = await fundedSigner(svm);
      const { mint, config } = await createMint(program, owner);
      // Someone else cannot claim the config of this mint (and so choose its admin and cap): 2016 (ConstraintMintMintAuthority).
      expect(customError(await send(svm, attacker, [setupIx(attacker, config, mint.address, program, 1_000_000_000)]))).toBe(2016);
      expect(svm.getAccount(config).exists).toBe(false);
      // The mint's authority can, and the config PDA becomes the mint authority.
      expectOk(await send(svm, owner, [setupIx(owner, config, mint.address, program)]));
      expect(Buffer.from(mintAuthorityOf(svm, mint.address) ?? []).equals(Buffer.from(getAddressEncoder().encode(config)))).toBe(true);
      expect(decodeAccount<{ admin: { toBase58(): string } }>(d, svm, "Config", config).admin.toBase58()).toBe(owner.address);
      // Once the authority has moved, no one (not even the former authority) can set the mint up again.
      expect(await send(svm, owner, [setupIx(owner, config, mint.address, program)])).toBeInstanceOf(FailedTransactionMetadata);
      // A mint whose authority is already the config PDA cannot be set up by anyone: no one can sign for the PDA.
      const preset = await createMint(program, owner);
      expectOk(
        await send(svm, owner, [
          (program === TOKEN_2022 ? t22 : spl).getSetAuthorityInstruction({
            owned: preset.mint.address,
            owner,
            authorityType: 0,
            newAuthority: preset.config,
          } as never),
        ]),
      );
      expect(customError(await send(svm, attacker, [setupIx(attacker, preset.config, preset.mint.address, program)]))).toBe(2016);
    });
  }

  it("refuses a token account of another mint and a fake token program", async () => {
    const a = await setupMint(TOKEN_2022);
    const b = await setupMint(TOKEN_PROGRAM);
    const alice = await fundedSigner(a.svm);
    const foreign = await b.ata(alice);
    const issue = (to: Address, program: Address) =>
      ix(d, "issue", { amount: new BN(1) }, [
        { address: a.admin.address, signer: a.admin },
        { address: a.config, writable: true },
        { address: a.mint, writable: true },
        { address: to, writable: true },
        { address: program },
      ]);
    expect(customError(await send(a.svm, a.admin, [issue(foreign, TOKEN_2022)]))).toBe(6002);
    expect(customError(await send(a.svm, a.admin, [issue(await a.ata(alice), SYSTEM_PROGRAM)]))).toBe(3008);
  });
});
