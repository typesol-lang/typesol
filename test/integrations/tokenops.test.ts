import * as spl from "@solana-program/token";
import * as t22 from "@solana-program/token-2022";
import { lamports } from "@solana/kit";
import { type Address, type KeyPairSigner, address, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../src/compiler/index.js";
import {
  BN,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  acct,
  customError,
  deployFile,
  expectOk,
  fundedSigner,
  ix,
  pda,
  send,
  type Deployed,
  TOKEN_2022,
} from "../harness.js";

const TREASURY = address("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
const NATIVE_MINT = address("So11111111111111111111111111111111111111112");
const pk = (a: string) => ({ toBuffer: () => Buffer.from(getAddressEncoder().encode(a as never)), toBase58: () => a });

describe("token operations, constraints and fields (test/fixtures/tokenops.ts)", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let config: Address;
  let bump: number;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/tokenops.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 50n);
    [config, bump] = await pda(d.programId, ["config"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: config, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
  });
  const ret = (r: ReturnType<typeof expectOk>) => Buffer.from(r.returnData().data()).readBigUInt64LE();
  const tokenAmount = (a: Address) => spl.getTokenDecoder().decode(new Uint8Array((d.svm.getAccount(a) as { data: Uint8Array }).data)).amount;

  async function world(program: Address) {
    const mint = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "create_mint", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: mint.address, signer: mint, writable: true },
          { address: config },
          { address: SYSTEM_PROGRAM },
          { address: program },
        ]),
      ]),
    );
    const [vault, vbump] = await pda(d.programId, ["vault", mint.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "create_vault", { bump: vbump }, [
          { address: payer.address, signer: payer, writable: true },
          { address: vault, writable: true },
          { address: mint.address },
          { address: config },
          { address: SYSTEM_PROGRAM },
          { address: program },
        ]),
      ]),
    );
    const mintTo = (to: Address, amount: number) =>
      send(d.svm, payer, [
        ix(d, "mint_to", { amount: new BN(amount) }, [
          { address: mint.address, writable: true },
          { address: to, writable: true },
          { address: config },
          { address: program },
        ]),
      ]);
    return { mint: mint.address, vault, mintTo };
  }

  for (const [label, program] of [
    ["SPL Token", TOKEN_PROGRAM],
    ["Token-2022", TOKEN_2022],
  ] as const) {
    it(`creates a mint and a PDA vault, mints, delegates, freezes and reads the fields (${label})`, async () => {
      const { mint, vault, mintTo } = await world(program);
      const m = t22.getMintDecoder().decode(new Uint8Array((d.svm.getAccount(mint) as { data: Uint8Array }).data));
      expect([m.decimals, m.isInitialized, (m.mintAuthority as { value?: string }).value, (m.freezeAuthority as { value?: string }).value]).toEqual([
        6,
        true,
        config,
        config,
      ]);
      expect((d.svm.getAccount(vault) as { programAddress: string }).programAddress).toBe(program);
      expectOk(await mintTo(vault, 500));
      expect(tokenAmount(vault)).toBe(500n);

      const inspect = async () => ret(expectOk(await send(d.svm, payer, [ix(d, "inspect", {}, [{ address: vault }, { address: mint }])])));
      expect(await inspect()).toBe(0n);
      const spender = (await generateKeyPairSigner()).address;
      const delegate = (amount: number, owner = config) =>
        send(d.svm, payer, [
          ix(d, "delegate", { amount: new BN(amount) }, [
            { address: vault, writable: true },
            { address: mint },
            { address: owner },
            { address: spender },
            { address: program },
          ]),
        ]);
      expectOk(await delegate(120));
      expect(await inspect()).toBe(120_000n + 10n);
      expectOk(await send(d.svm, payer, [ix(d, "undelegate", {}, [{ address: vault, writable: true }, { address: config }, { address: program }])]));
      expect(await inspect()).toBe(0n);

      const freeze = (on: boolean) =>
        send(d.svm, payer, [ix(d, "freeze", { on }, [{ address: vault, writable: true }, { address: mint }, { address: config }, { address: program }])]);
      expectOk(await freeze(true));
      expect(await inspect()).toBe(100n);
      expect(customError(await mintTo(vault, 1))).toBe(17); // SPL Token: AccountFrozen
      expectOk(await freeze(false));
      expectOk(await mintTo(vault, 1));
    });
  }

  it("enforces HasOne on token accounts and mints (2014 / 2015 / 2016 / 2017)", async () => {
    const a = await world(TOKEN_PROGRAM);
    const b = await world(TOKEN_PROGRAM);
    const spender = (await generateKeyPairSigner()).address;
    const stranger = await fundedSigner(d.svm);
    const delegate = (vault: Address, mint: Address, owner: Address) =>
      send(d.svm, payer, [
        ix(d, "delegate", { amount: new BN(1) }, [
          { address: vault, writable: true },
          { address: mint },
          { address: owner },
          { address: spender },
          { address: TOKEN_PROGRAM },
        ]),
      ]);
    expect(customError(await delegate(a.vault, b.mint, config))).toBe(2014);
    // Same mint, but a token account owned by someone else.
    const ata = (await spl.findAssociatedTokenPda({ owner: stranger.address, mint: a.mint, tokenProgram: TOKEN_PROGRAM }))[0];
    expectOk(await send(d.svm, stranger, [await spl.getCreateAssociatedTokenInstructionAsync({ payer: stranger, owner: stranger.address, mint: a.mint })]));
    expect(customError(await delegate(ata, a.mint, config))).toBe(2015);
    // A mint whose authorities are someone else.
    const foreign = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, stranger, [
        ...(await (async () => {
          const { getCreateAccountInstruction } = await import("@solana-program/system");
          return [
            getCreateAccountInstruction({
              payer: stranger,
              newAccount: foreign,
              lamports: lamports(d.svm.minimumBalanceForRentExemption(82n)),
              space: 82,
              programAddress: TOKEN_PROGRAM,
            }),
          ];
        })()),
        spl.getInitializeMint2Instruction({ mint: foreign.address, decimals: 0, mintAuthority: stranger.address, freezeAuthority: stranger.address }),
      ]),
    );
    const sAta = (await spl.findAssociatedTokenPda({ owner: stranger.address, mint: foreign.address, tokenProgram: TOKEN_PROGRAM }))[0];
    expectOk(
      await send(d.svm, stranger, [await spl.getCreateAssociatedTokenInstructionAsync({ payer: stranger, owner: stranger.address, mint: foreign.address })]),
    );
    const mintTo = send(d.svm, payer, [
      ix(d, "mint_to", { amount: new BN(1) }, [
        { address: foreign.address, writable: true },
        { address: sAta, writable: true },
        { address: config },
        { address: TOKEN_PROGRAM },
      ]),
    ]);
    expect(customError(await mintTo)).toBe(2016);
    const freeze = send(d.svm, payer, [
      ix(d, "freeze", { on: true }, [{ address: sAta, writable: true }, { address: foreign.address }, { address: config }, { address: TOKEN_PROGRAM }]),
    ]);
    expect(customError(await freeze)).toBe(2017);
  });

  it("hands over and removes authorities with setAuthority", async () => {
    const { mint } = await world(TOKEN_2022);
    const next = (await generateKeyPairSigner()).address;
    const authorities = async (who: Address) => ret(expectOk(await send(d.svm, payer, [ix(d, "authorities", { who: pk(who) }, [{ address: mint }])])));
    expect(await authorities(config)).toBe(11n);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "hand_over", { next: pk(next), keep: true }, [{ address: mint, writable: true }, { address: config }, { address: TOKEN_2022 }]),
      ]),
    );
    expect(await authorities(next)).toBe(1n);
    const { mint: m2 } = await world(TOKEN_PROGRAM);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "hand_over", { next: pk(next), keep: false }, [{ address: m2, writable: true }, { address: config }, { address: TOKEN_PROGRAM }]),
      ]),
    );
    expect(ret(expectOk(await send(d.svm, payer, [ix(d, "authorities", { who: pk(next) }, [{ address: m2 }])])))).toBe(2n);
  });

  it("checks associated token accounts declaratively (2015 / 2009)", async () => {
    const { mint, vault, mintTo } = await world(TOKEN_PROGRAM);
    const owner = await fundedSigner(d.svm);
    const ata = (await spl.findAssociatedTokenPda({ owner: owner.address, mint, tokenProgram: TOKEN_PROGRAM }))[0];
    expectOk(await send(d.svm, owner, [await spl.getCreateAssociatedTokenInstructionAsync({ payer: owner, owner: owner.address, mint })]));
    expectOk(await mintTo(ata, 9));
    const check = (acct: Address) => send(d.svm, payer, [ix(d, "check_ata", {}, [{ address: acct }, { address: owner.address }, { address: mint }])]);
    expect(ret(expectOk(await check(ata)))).toBe(9n);
    // Another wallet's token account: its owner is checked before its address, as Anchor's associated_token:: does.
    expect(customError(await check(vault))).toBe(2015);
    expect(d.idl.instructions.find((i) => i.name === "check_ata")!.accounts[0]).toMatchObject({ name: "account" });
  });

  it("pins Address<…> accounts (2012) and reads pubkey() constants", async () => {
    const pay = (to: Address) =>
      send(d.svm, payer, [
        ix(d, "pay_fee", { amount: new BN(1_000_000) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: to, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await pay(TREASURY));
    expect(d.svm.getBalance(TREASURY)).toBe(1_000_000n);
    expect(customError(await pay((await generateKeyPairSigner()).address))).toBe(2012);
    expect(d.idl.instructions.find((i) => i.name === "pay_fee")!.accounts[1]).toMatchObject({ name: "treasury", writable: true, address: TREASURY });
  });

  it("wraps SOL and syncs the native token amount", async () => {
    // litesvm ships the token programs but not the native mint account: plant it (9 decimals, initialized, no authorities).
    const data = new Uint8Array(82);
    data[44] = 9;
    data[45] = 1;
    d.svm.setAccount({
      address: NATIVE_MINT,
      data,
      executable: false,
      lamports: lamports(d.svm.minimumBalanceForRentExemption(82n)),
      programAddress: TOKEN_PROGRAM,
      space: 82n,
    });
    const owner = await fundedSigner(d.svm);
    const ata = (await spl.findAssociatedTokenPda({ owner: owner.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM }))[0];
    expectOk(await send(d.svm, owner, [await spl.getCreateAssociatedTokenInstructionAsync({ payer: owner, owner: owner.address, mint: NATIVE_MINT })]));
    const r = expectOk(
      await send(d.svm, owner, [
        ix(d, "wrap", { lamports: new BN(2_000_000) }, [
          { address: owner.address, signer: owner, writable: true },
          { address: ata, writable: true },
          { address: SYSTEM_PROGRAM },
          { address: TOKEN_PROGRAM },
        ]),
      ]),
    );
    expect(ret(r)).toBe(2_000_000n);
  });
});

// Wrapper arguments are evaluated left to right, as JS evaluates them: a signer seed list reads what an earlier
// argument's code left, and an amount is read before a seed list's code runs.
describe("token and system wrappers evaluate their arguments in source order", () => {
  const HEAD = `import { type u64, type u8, type u16, type i16, type Mut, type Signer, type TokenAccount, type Mint, type AccountInfo, type TokenProgram, type TokenInterface, type StakeProgram, type SystemProgram, type Pubkey, type Init, AuthorityType } from "typesol";
export interface St { count: u64; bump: u8; admin: Pubkey }
function next(st: Mut<St>): u64 { st.count += 1n; return 5n; }
function nextKey(st: Mut<St>): Pubkey { st.count += 1n; return st.admin; }
function next16(st: Mut<St>): u16 { st.count += 1n; return 5n; }
function nexti16(st: Mut<St>): i16 { st.count += 1n; return 5n; }
`;
  const le64 = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return new Uint8Array(b);
  };

  it("approve signs for the seeds after its amount ran; transfer and systemProgram.transfer send the amount read first", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "typesol-wrapper-order-")), "order.ts");
    writeFileSync(
      file,
      `${HEAD}export function setup(payer: Mut<Signer>, st: Init<St>, systemProgram: SystemProgram): void { st.create(payer, ["st"]); }
export function viaApprove(st: Mut<St>, src: Mut<TokenAccount>, delegate: AccountInfo, owner: AccountInfo, tokenProgram: TokenProgram, bump: u8): void {
  tokenProgram.approve(src, delegate, owner, next(st), ["vault", st.count, bump]);
}
export function viaTransfer(st: Mut<St>, src: Mut<TokenAccount>, to: Mut<TokenAccount>, owner: AccountInfo, tokenProgram: TokenProgram, bump: u8): void {
  tokenProgram.transfer(src, to, owner, st.count, ["vault", next(st), bump]);
}
export function viaSystem(st: Mut<St>, from: Mut<AccountInfo>, to: Mut<AccountInfo>, systemProgram: SystemProgram, bump: u8): void {
  systemProgram.transfer(from, to, st.count, ["vault", next(st), bump]);
}
`,
    );
    const d = await deployFile(file);
    const payer = await fundedSigner(d.svm);
    const [st] = await pda(d.programId, ["st"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: st, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const mint = await generateKeyPairSigner();
    const { getCreateAccountInstruction } = await import("@solana-program/system");
    expectOk(
      await send(d.svm, payer, [
        getCreateAccountInstruction({ payer, newAccount: mint, lamports: d.svm.minimumBalanceForRentExemption(82n), space: 82, programAddress: TOKEN_PROGRAM }),
        spl.getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: payer.address }),
      ] as never),
    );
    const tokenOf = async (owner: Address, amount = 0n) => {
      const a = await generateKeyPairSigner();
      expectOk(
        await send(d.svm, payer, [
          getCreateAccountInstruction({
            payer,
            newAccount: a,
            lamports: d.svm.minimumBalanceForRentExemption(165n),
            space: 165,
            programAddress: TOKEN_PROGRAM,
          }),
          spl.getInitializeAccount3Instruction({ account: a.address, mint: mint.address, owner }),
          ...(amount ? [spl.getMintToInstruction({ mint: mint.address, token: a.address, mintAuthority: payer, amount })] : []),
        ] as never),
      );
      return a.address;
    };
    const [v0, b0] = await pda(d.programId, ["vault", le64(0n)]);
    const [v1, b1] = await pda(d.programId, ["vault", le64(1n)]);
    const t0 = await tokenOf(v0);
    const t1 = await tokenOf(v1);
    const delegate = (await generateKeyPairSigner()).address;
    const approve = (src: Address, owner: Address, bump: number) =>
      send(d.svm, payer, [
        ix(d, "via_approve", { bump }, [
          { address: st, writable: true },
          { address: src, writable: true },
          { address: delegate },
          { address: owner },
          { address: TOKEN_PROGRAM },
        ]),
      ]);
    // count is 0; next(st) makes it 1 before the list is written: the program signs for ["vault", 1] only.
    const stale = await approve(t0, v0, b0);
    expect(() => expectOk(stale)).toThrow(/transaction failed/);
    d.svm.expireBlockhash();
    expectOk(await approve(t1, v1, b1));
    expect(spl.getTokenDecoder().decode(new Uint8Array(acct(d.svm, t1).data)).delegatedAmount).toBe(5n);
    // count is now 1 (the failed call changed nothing); transfer sends st.count as read before the seeds' next(st): 1, not 2.
    const [v5, b5] = await pda(d.programId, ["vault", le64(5n)]);
    const src = await tokenOf(v5, 10n);
    const dst = await tokenOf(payer.address);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "via_transfer", { bump: b5 }, [
          { address: st, writable: true },
          { address: src, writable: true },
          { address: dst, writable: true },
          { address: v5 },
          { address: TOKEN_PROGRAM },
        ]),
      ]),
    );
    expect(spl.getTokenDecoder().decode(new Uint8Array(acct(d.svm, dst).data)).amount).toBe(1n);
    // count is 2: the system transfer moves 2 lamports from the vault PDA, not 3.
    d.svm.airdrop(v5, lamports(1_000_000_000n));
    const to = (await generateKeyPairSigner()).address;
    d.svm.airdrop(to, lamports(1_000_000_000n));
    expectOk(
      await send(d.svm, payer, [
        ix(d, "via_system", { bump: b5 }, [
          { address: st, writable: true },
          { address: v5, writable: true },
          { address: to, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(d.svm.getBalance(to)).toBe(1_000_000_002n);
  });

  it("account text passed as a metadata string keeps what it held when a later argument rewrites it", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "typesol-meta-order-")), "meta.ts");
    const src = `import { type Mut, type Signer, type AccountInfo, type Token2022Program, type TokenMetadataProgram, type SystemProgram, type Init, type FixedString } from "typesol";
export interface Named { name: FixedString<32> }
function rename(st: Mut<Named>): string { st.name = "EVIL"; return "SYM"; }
export function setup(payer: Mut<Signer>, st: Init<Named>, systemProgram: SystemProgram): void { st.create(payer, ["st"]); st.name = "orig"; }
export function meta(st: Mut<Named>, mint: Mut<AccountInfo>, ua: AccountInfo, ma: Signer, tokenProgram: Token2022Program): void {
  tokenProgram.initializeMetadata(mint, ua, ma, st.name, rename(st), "uri");
}
export function rm(st: Mut<Named>, mint: Mut<AccountInfo>, ua: Signer, tokenProgram: Token2022Program): void {
  tokenProgram.removeMetadataKey(mint, ua, st.name, rename(st) === "SYM");
}
export function upd(st: Mut<Named>, md: Mut<AccountInfo>, ua: Signer, metadataProgram: TokenMetadataProgram): void {
  metadataProgram.updateMetadataAccountsV2(md, ua, { name: st.name, symbol: rename(st), uri: "u", sellerFeeBasisPoints: 0n }, null, null, null);
}
`;
    writeFileSync(file, src);
    // removeMetadataKey and updateMetadataAccountsV2: the name's bytes are copied before rename() runs.
    const c = generate(file).c;
    for (const fn of ["ix_rm", "ix_upd"]) {
      const body = c.slice(c.indexOf(`static uint64_t ${fn}(`));
      const copy = body.search(/ts_str_copy\(ts_fstr_view/);
      expect([fn, copy >= 0 && copy < body.search(/fn_rename\(params/)]).toEqual([fn, true]);
    }
    const d = await deployFile(file);
    const payer = await fundedSigner(d.svm);
    const [st] = await pda(d.programId, ["st"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: st, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const mint = await generateKeyPairSigner();
    const { getCreateAccountInstruction } = await import("@solana-program/system");
    expectOk(
      await send(d.svm, payer, [
        getCreateAccountInstruction({ payer, newAccount: mint, lamports: d.svm.minimumBalanceForRentExemption(1000n), space: 234, programAddress: TOKEN_2022 }),
        t22.getInitializeMetadataPointerInstruction({ mint: mint.address, authority: payer.address, metadataAddress: mint.address }),
        t22.getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: payer.address }),
      ] as never),
    );
    expectOk(
      await send(d.svm, payer, [
        ix(d, "meta", {}, [
          { address: st, writable: true },
          { address: mint.address, writable: true },
          { address: payer.address },
          { address: payer.address, signer: payer },
          { address: TOKEN_2022 },
        ]),
      ]),
    );
    const m = t22.getMintDecoder().decode(new Uint8Array(acct(d.svm, mint.address).data));
    const md = (m.extensions as { value: ({ __kind: string } & Record<string, unknown>)[] }).value.find((e) => e.__kind === "TokenMetadata")!;
    expect([md.name, md.symbol]).toEqual(["orig", "SYM"]);
  });

  it("every wrapper with signer seeds reads them after an earlier argument's code ran", () => {
    const S = `["vault", st.count, st.bump]`;
    const cases: Record<string, [string, string]> = {
      approve: ["src: Mut<TokenAccount>, dl: AccountInfo, tp: TokenInterface", `tp.approve(src, dl, auth, next(st), ${S})`],
      approveChecked: ["src: Mut<TokenAccount>, mint: Mint, dl: AccountInfo, tp: TokenInterface", `tp.approveChecked(src, mint, dl, auth, next(st), ${S})`],
      mintToChecked: ["mint: Mut<Mint>, to: Mut<TokenAccount>, tp: TokenInterface", `tp.mintToChecked(mint, to, auth, next(st), ${S})`],
      burnChecked: ["src: Mut<TokenAccount>, mint: Mut<Mint>, tp: TokenInterface", `tp.burnChecked(src, mint, auth, next(st), ${S})`],
      setAuthority: ["src: Mut<TokenAccount>, tp: TokenInterface", `tp.setAuthority(src, auth, AuthorityType.AccountOwner, nextKey(st), ${S})`],
      updateTransferHook: ["mint: Mut<Mint>, tp: TokenInterface", `tp.updateTransferHook(mint, auth, nextKey(st), ${S})`],
      updateInterestRate: ["mint: Mut<Mint>, tp: TokenInterface", `tp.updateInterestRate(mint, auth, nexti16(st), ${S})`],
      transferCheckedWithFee: [
        "src: Mut<TokenAccount>, mint: Mint, to: Mut<TokenAccount>, tp: TokenInterface",
        `tp.transferCheckedWithFee(src, mint, to, auth, next(st), 0n, ${S})`,
      ],
      setTransferFee: ["mint: Mut<Mint>, tp: TokenInterface", `tp.setTransferFee(mint, auth, next16(st), 0n, ${S})`],
      initializeTokenGroup: ["g: Mut<AccountInfo>, mint: Mint, tp: TokenInterface", `tp.initializeTokenGroup(g, mint, auth, null, next(st), ${S})`],
      updateGroupMaxSize: ["g: Mut<AccountInfo>, tp: TokenInterface", `tp.updateGroupMaxSize(g, auth, next(st), ${S})`],
      updateGroupAuthority: ["g: Mut<AccountInfo>, tp: TokenInterface", `tp.updateGroupAuthority(g, auth, nextKey(st), ${S})`],
      stakeSplit: ["stake: Mut<AccountInfo>, split: Mut<AccountInfo>, sp: StakeProgram", `sp.split(stake, split, auth, next(st), ${S})`],
      stakeAuthorize: ["stake: Mut<AccountInfo>, clock: AccountInfo, sp: StakeProgram", `sp.authorize(stake, clock, auth, nextKey(st), "staker", ${S})`],
      stakeWithdraw: [
        "stake: Mut<AccountInfo>, to: Mut<AccountInfo>, clock: AccountInfo, hist: AccountInfo, sp: StakeProgram",
        `sp.withdraw(stake, to, clock, hist, auth, next(st), ${S})`,
      ],
    };
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-seed-order-"));
    for (const [name, [params, call]] of Object.entries(cases)) {
      const file = path.join(dir, `${name}.ts`);
      writeFileSync(file, `${HEAD}export function go(st: Mut<St>, auth: AccountInfo, ${params}): void {\n  ${call};\n}\n`);
      const body = generate(file).c;
      const ixBody = body.slice(body.indexOf("static uint64_t ix_go"));
      // The seed's copy of st.count comes after the call to the helper that changes it.
      const seedAt = ixBody.search(/= d_st->count;/);
      const callAt = ixBody.search(/fn_next\w*\(params/);
      expect([name, seedAt > callAt && callAt > 0]).toEqual([name, true]);
    }
  });
});
