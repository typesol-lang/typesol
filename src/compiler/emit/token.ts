import ts from "typescript";
import { type ValueType, isWritable } from "../model.js";
import { U64, U8, I64, BOOL, PUBKEY, STRING, type CpiAcct, type CpiProgram, type Value, cBytes, optC } from "./shared.js";
import { CreateEmitter } from "./create.js";

/** SPL Token and Token-2022 instructions (`tokenProgram.transfer(…)` and the rest) and the ATA program's. */
export abstract class TokenEmitter extends CreateEmitter {
  protected tokenOp(node: ts.CallExpression, program: CpiProgram, method: string): undefined {
    const a = node.arguments;
    const p = program.c;
    // A TokenAccount / Mint parameter, or an AccountInfo one (a token account this instruction created, an account a
    // native port takes unchecked) or a remaining account: the token program checks those.
    const want = (n: ts.Expression, kind: "token" | "mint", mut: boolean, what: string): CpiAcct => {
      const x = this.cpiAccount(n, what);
      const acct = x.param;
      if (!acct || (acct.kind.kind === "info" && (!mut || isWritable(acct.kind)))) return x;
      if (acct.kind.kind !== kind || (mut && !(acct.kind as { mut: boolean }).mut)) {
        const type = kind === "token" ? "TokenAccount" : "Mint";
        this.fail(n, `${what} must be a ${mut ? `Mut<${type}> or a Mut<AccountInfo>` : `${type} or an AccountInfo`}`);
      }
      return x;
    };
    const arity = (fixed: number) => {
      if (a.length !== fixed && a.length !== fixed + 1) this.fail(node, `${method} takes ${fixed} arguments plus optional signerSeeds`);
    };
    const amount = (n: ts.Expression) => this.expect(this.expr(n, U64), U64, n).c;
    switch (method) {
      case "transfer": {
        arity(4);
        const from = want(a[0], "token", true, "the source");
        const to = want(a[1], "token", true, "the destination");
        const auth = this.cpiAccount(a[2], "the authority");
        const amt = amount(a[3]);
        const s = this.signerSeeds(a[4], auth, a[2]);
        this.line(`TS_TRY(ts_token_transfer(params, ${p}, ${from.c}, ${to.c}, ${auth.c}, ${amt}, ${s.name}, ${s.count}));`);
        return undefined;
      }
      case "transferChecked": {
        arity(5);
        const from = want(a[0], "token", true, "the source");
        const mint = want(a[1], "mint", false, "the mint");
        const to = want(a[2], "token", true, "the destination");
        const auth = this.cpiAccount(a[3], "the authority");
        const amt = amount(a[4]);
        const s = this.signerSeeds(a[5], auth, a[3]);
        this.line(`TS_TRY(ts_token_transfer_checked(params, ${p}, ${from.c}, ${mint.c}, ${to.c}, ${auth.c}, ${amt}, ${s.name}, ${s.count}));`);
        return undefined;
      }
      case "mintTo": {
        arity(4);
        // A Mut<Mint>, or a mint created and initialized earlier in this instruction (Mut<Signer> / Mut<AccountInfo>).
        const mint = this.cpiAccount(a[0], "the mint");
        const mp = mint.param;
        if (mp && (!isWritable(mp.kind) || (mp.kind.kind !== "mint" && mp.kind.kind !== "signer" && mp.kind.kind !== "info")))
          this.fail(a[0], "the mint must be a Mut<Mint>, or a Mut<Signer> / Mut<AccountInfo> mint this instruction created");
        const to = want(a[1], "token", true, "the destination");
        const auth = this.cpiAccount(a[2], "the mint authority");
        const amt = amount(a[3]);
        const s = this.signerSeeds(a[4], auth, a[2]);
        this.line(`TS_TRY(ts_token_mint_to(params, ${p}, ${mint.c}, ${to.c}, ${auth.c}, ${amt}, ${s.name}, ${s.count}));`);
        return undefined;
      }
      case "burn": {
        arity(4);
        const from = want(a[0], "token", true, "the burned account");
        const mint = want(a[1], "mint", true, "the mint");
        const auth = this.cpiAccount(a[2], "the authority");
        const amt = amount(a[3]);
        const s = this.signerSeeds(a[4], auth, a[2]);
        this.line(`TS_TRY(ts_token_burn(params, ${p}, ${from.c}, ${mint.c}, ${auth.c}, ${amt}, ${s.name}, ${s.count}));`);
        return undefined;
      }
      case "initializeMetadata": {
        if (program.kind.kind === "tokenProgram" && program.kind.flavor === "token")
          this.fail(node, "metadata lives in Token-2022 mints; use Token2022Program or TokenInterface");
        if (a.length !== 6 && a.length !== 7) this.fail(node, "initializeMetadata(mint, updateAuthority, mintAuthority, name, symbol, uri, signerSeeds?)");
        // The mint may have been created and initialized earlier in this instruction (a Mut<Signer> or Mut<AccountInfo>).
        const mint = this.cpiAccount(a[0], "the mint");
        if (mint.param && !isWritable(mint.param.kind)) this.fail(a[0], "the mint must be writable (Mut<...>)");
        const ua = this.cpiAccount(a[1], "the update authority");
        const ma = this.cpiAccount(a[2], "the mint authority");
        const [nm, sym, uri] = [a[3], a[4], a[5]].map((n) => this.expect(this.expr(n, STRING), STRING, n).c);
        const s = this.signerSeeds(a[6], ma, a[2]);
        this.line(`TS_TRY(ts_t22_init_metadata(params, ${p}, ${mint.c}, ${ua.c}, ${ma.c}, ${nm}, ${sym}, ${uri}, ${s.name}, ${s.count}));`);
        return undefined;
      }
      case "closeAccount": {
        arity(3);
        // A token account, or (Token-2022, with a MintCloseAuthority and no supply left) a mint.
        const acct = this.cpiAccount(a[0], "the closed account");
        const k = acct.param?.kind;
        if (k && !(((k.kind === "token" || k.kind === "mint") && k.mut) || (k.kind === "info" && k.mut)))
          this.fail(a[0], "the closed account must be a Mut<TokenAccount>, a Mut<Mint> or a Mut<AccountInfo>");
        const dest = this.cpiAccount(a[1], "the destination");
        if (dest.param && !isWritable(dest.param.kind)) this.fail(a[1], "the destination must be writable (Mut<...>)");
        const auth = this.cpiAccount(a[2], "the authority");
        const s = this.signerSeeds(a[3], auth, a[2]);
        this.line(`TS_TRY(ts_token_close(params, ${p}, ${acct.c}, ${dest.c}, ${auth.c}, ${s.name}, ${s.count}));`);
        return undefined;
      }
    }
    // The remaining SPL Token instructions share one shape: a tag, a few fixed fields, and fixed account metas.
    const anyAcct = (n: ts.Expression, what: string, mut: boolean) => {
      const acct = this.cpiAccount(n, what);
      if (mut && acct.param && !isWritable(acct.param.kind)) this.fail(n, `${what} must be writable (Mut<...>)`);
      return acct;
    };
    type Put = (src: string, n: string, bytes?: number) => void;
    const simple = (tag: number, fields: ((put: Put) => void)[], metas: [CpiAcct, boolean, boolean][], seeds: { name: string; count: number | string }) => {
      const { buf, len, put, finish } = this.byteBuffer("tok", 128, "TS_ERR_INSTRUCTION_DATA", "token instruction");
      const t = this.tmp("tag");
      this.line(`uint8_t ${t} = ${tag};`);
      put(`&${t}`, "1", 1);
      for (const f of fields) f(put);
      finish(node);
      this.cpi(
        p,
        metas.map(([acc, w, sg]) => [acc.c, w, sg]),
        buf,
        len,
        seeds,
      );
    };
    const value = (n: ts.Expression, t: ValueType) => (put: Put) => this.serialize(this.expect(this.expr(n, t), t, n), n, put);
    const optKey: ValueType = { kind: "option", inner: PUBKEY };
    const U16: ValueType = { kind: "int", name: "u16" };
    const I16: ValueType = { kind: "int", name: "i16" };
    const decimals = (mint: CpiAcct) => (put: Put) => put(`&${mint.c}->data[44]`, "1", 1);
    const byte = (k: number) => (put: Put) => {
      const t = this.tmp("b");
      this.line(`uint8_t ${t} = ${k};`);
      put(`&${t}`, "1", 1);
    };
    /** Token-2022's OptionalNonZeroPubkey: 32 bytes, all zero for none. */
    const nonZeroKey = (n: ts.Expression) => (put: Put) => {
      this.model.options.set("pubkey", PUBKEY);
      const v = this.expect(this.expr(n, optKey), optKey, n);
      const t = this.tmp("nzk");
      this.line(`SolPubkey ${t};`);
      this.line(`{ ${optC(PUBKEY)} o = ${v.c}; if (o.some) ${t} = o.v; else ts_memzero(&${t}, 32); }`);
      put(`&${t}`, "32", 32);
    };
    const token2022Only = () => {
      if (program.kind.kind === "tokenProgram" && program.kind.flavor === "token")
        this.fail(node, `${method} is a Token-2022 extension; use Token2022Program or TokenInterface`);
    };
    const mintOnly = (n: number, usage: string) => {
      token2022Only();
      if (a.length !== n) this.fail(node, usage);
      return anyAcct(a[0], "the mint", true);
    };
    const none = { name: "NULL", count: 0 };
    // The Token Group interface (spl-token-group-interface), which Token-2022 implements: 8-byte discriminators.
    const grouped = (disc: number[], fields: ((put: Put) => void)[], metas: [CpiAcct, boolean, boolean][], seeds: { name: string; count: number | string }) => {
      const { buf, len, put, finish } = this.byteBuffer("grp", 96, "TS_ERR_INSTRUCTION_DATA", "token group instruction");
      const d = this.tmp("disc");
      this.line(`static const uint8_t ${d}[8] = {${disc.join(", ")}};`);
      put(d, "8", 8);
      for (const f of fields) f(put);
      finish(node);
      this.cpi(
        p,
        metas.map(([acc, w, sg]) => [acc.c, w, sg]),
        buf,
        len,
        seeds,
      );
    };
    switch (method) {
      case "initializeTokenGroup": {
        token2022Only();
        if (a.length !== 5 && a.length !== 6)
          this.fail(node, "initializeTokenGroup(group, mint, mintAuthority, updateAuthority | null, maxSize, signerSeeds?)");
        const group = anyAcct(a[0], "the group", true);
        const mint = anyAcct(a[1], "the mint", false);
        const auth = this.cpiAccount(a[2], "the mint authority");
        grouped(
          [121, 113, 108, 39, 54, 51, 0, 4],
          [nonZeroKey(a[3]), value(a[4], U64)],
          [
            [group, true, false],
            [mint, false, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[5], auth, a[2]),
        );
        return undefined;
      }
      case "initializeGroupMember": {
        token2022Only();
        if (a.length !== 5 && a.length !== 6)
          this.fail(node, "initializeGroupMember(member, memberMint, memberMintAuthority, group, groupUpdateAuthority, signerSeeds?)");
        const member = anyAcct(a[0], "the member", true);
        const memberMint = anyAcct(a[1], "the member mint", false);
        const mintAuth = this.cpiAccount(a[2], "the member mint's authority");
        const group = anyAcct(a[3], "the group", true);
        const groupAuth = this.cpiAccount(a[4], "the group's update authority");
        grouped(
          [152, 32, 222, 176, 223, 237, 116, 134],
          [],
          [
            [member, true, false],
            [memberMint, false, false],
            [mintAuth, false, true],
            [group, true, false],
            [groupAuth, false, true],
          ],
          a[5] ? this.signingSeeds(a[5]) : none,
        );
        return undefined;
      }
      case "updateGroupMaxSize": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "updateGroupMaxSize(group, updateAuthority, maxSize, signerSeeds?)");
        const group = anyAcct(a[0], "the group", true);
        const auth = this.cpiAccount(a[1], "the update authority");
        grouped(
          [108, 37, 171, 143, 248, 30, 18, 110],
          [value(a[2], U64)],
          [
            [group, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[1]),
        );
        return undefined;
      }
      case "updateGroupAuthority": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "updateGroupAuthority(group, updateAuthority, next | null, signerSeeds?)");
        const group = anyAcct(a[0], "the group", true);
        const auth = this.cpiAccount(a[1], "the update authority");
        grouped(
          [161, 105, 88, 1, 237, 221, 216, 203],
          [nonZeroKey(a[2])],
          [
            [group, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[1]),
        );
        return undefined;
      }
      case "initializeTransferFeeConfig": {
        const mint = mintOnly(5, "initializeTransferFeeConfig(mint, configAuthority | null, withdrawAuthority | null, basisPoints, maximumFee)");
        this.model.options.set("pubkey", PUBKEY);
        // Arguments in source order, as JS evaluates them: the basis points are checked when they are read.
        const bps = (put: Put) => {
          const v = this.expect(this.expr(a[3], U16), U16, a[3]);
          this.line(`if (${v.c} > 10000) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: transfer fee above 10000 basis points");`);
          this.serialize(v, a[3], put);
        };
        simple(26, [byte(0), value(a[1], optKey), value(a[2], optKey), bps, value(a[4], U64)], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeMintCloseAuthority": {
        const mint = mintOnly(2, "initializeMintCloseAuthority(mint, closeAuthority | null)");
        this.model.options.set("pubkey", PUBKEY);
        simple(25, [value(a[1], optKey)], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeNonTransferableMint": {
        const mint = mintOnly(1, "initializeNonTransferableMint(mint)");
        simple(32, [], [[mint, true, false]], none);
        return undefined;
      }
      case "initializePermanentDelegate": {
        const mint = mintOnly(2, "initializePermanentDelegate(mint, delegate)");
        simple(35, [value(a[1], PUBKEY)], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeDefaultAccountState": {
        const mint = mintOnly(2, "initializeDefaultAccountState(mint, frozen)");
        const frozen = this.expect(this.expr(a[1], BOOL), BOOL, a[1]);
        const st = this.tmp("st");
        this.line(`uint8_t ${st} = (${frozen.c}) ? 2 : 1;`); // AccountState::Frozen / Initialized
        simple(28, [byte(0), (put) => put(`&${st}`, "1", 1)], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeMetadataPointer":
      case "initializeGroupPointer":
      case "initializeGroupMemberPointer":
      case "initializeTransferHook": {
        const tag = { initializeMetadataPointer: 39, initializeGroupPointer: 40, initializeGroupMemberPointer: 41, initializeTransferHook: 36 }[method];
        const second = {
          initializeMetadataPointer: "metadataAddress",
          initializeGroupPointer: "groupAddress",
          initializeGroupMemberPointer: "memberAddress",
          initializeTransferHook: "programId",
        }[method];
        const mint = mintOnly(3, `${method}(mint, authority | null, ${second} | null)`);
        simple(tag, [byte(0), nonZeroKey(a[1]), nonZeroKey(a[2])], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeInterestBearingMint": {
        const mint = mintOnly(3, "initializeInterestBearingMint(mint, rateAuthority | null, rate)");
        simple(33, [byte(0), nonZeroKey(a[1]), value(a[2], I16)], [[mint, true, false]], none);
        return undefined;
      }
      case "initializeImmutableOwner": {
        token2022Only();
        if (a.length !== 1) this.fail(node, "initializeImmutableOwner(account)");
        const acct = anyAcct(a[0], "the token account", true);
        simple(22, [], [[acct, true, false]], none);
        return undefined;
      }
      case "updateDefaultAccountState": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "updateDefaultAccountState(mint, freezeAuthority, frozen, signerSeeds?)");
        const mint = anyAcct(a[0], "the mint", true);
        const auth = this.cpiAccount(a[1], "the freeze authority");
        const frozen = this.expect(this.expr(a[2], BOOL), BOOL, a[2]);
        const st = this.tmp("st");
        this.line(`uint8_t ${st} = (${frozen.c}) ? 2 : 1;`);
        simple(
          28,
          [byte(1), (put) => put(`&${st}`, "1", 1)],
          [
            [mint, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[1]),
        );
        return undefined;
      }
      case "enableRequiredMemoTransfers":
      case "disableRequiredMemoTransfers": {
        token2022Only();
        if (a.length !== 2 && a.length !== 3) this.fail(node, `${method}(account, owner, signerSeeds?)`);
        const acct = anyAcct(a[0], "the token account", true);
        const owner = this.cpiAccount(a[1], "the owner");
        simple(
          30,
          [byte(method === "enableRequiredMemoTransfers" ? 0 : 1)],
          [
            [acct, true, false],
            [owner, false, true],
          ],
          this.signerSeeds(a[2], owner, a[1]),
        );
        return undefined;
      }
      case "updateTransferHook": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "updateTransferHook(mint, authority, programId | null, signerSeeds?)");
        const mint = anyAcct(a[0], "the mint", true);
        const auth = this.cpiAccount(a[1], "the transfer hook authority");
        simple(
          36,
          [byte(1), nonZeroKey(a[2])],
          [
            [mint, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[1]),
        );
        return undefined;
      }
      case "updateInterestRate": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "updateInterestRate(mint, rateAuthority, rate, signerSeeds?)");
        const mint = anyAcct(a[0], "the mint", true);
        const auth = this.cpiAccount(a[1], "the rate authority");
        simple(
          33,
          [byte(1), value(a[2], I16)],
          [
            [mint, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[1]),
        );
        return undefined;
      }
      case "transferCheckedWithFee": {
        token2022Only();
        if (a.length !== 6 && a.length !== 7) this.fail(node, "transferCheckedWithFee(from, mint, to, authority, amount, fee, signerSeeds?)");
        const from = want(a[0], "token", true, "the source");
        const mint = want(a[1], "mint", false, "the mint");
        const to = want(a[2], "token", true, "the destination");
        const auth = this.cpiAccount(a[3], "the authority");
        // The decimals are the mint's own (checked when the mint was), as transferChecked does.
        const dec = (put: Put) => {
          const t = this.tmp("dec");
          this.line(`uint8_t ${t} = ${mint.c}->data[44];`);
          put(`&${t}`, "1", 1);
        };
        simple(
          26,
          [byte(1), value(a[4], U64), dec, value(a[5], U64)],
          [
            [from, true, false],
            [mint, false, false],
            [to, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[6], auth, a[3]),
        );
        return undefined;
      }
      case "harvestWithheldTokensToMint": {
        token2022Only();
        if (a.length !== 2) this.fail(node, "harvestWithheldTokensToMint(mint, sources): sources is remainingAccounts() or rest.slice(a, b)");
        if (!this.ix) this.fail(node, "harvestWithheldTokensToMint takes remaining accounts, so only instructions can call it");
        const mint = anyAcct(a[0], "the mint", true);
        const range = this.remainingRange(a[1]) ?? this.fail(a[1], "pass the source token accounts as remainingAccounts() or rest.slice(a, b)");
        const { buf, len, put, finish } = this.byteBuffer("tok", 2, "TS_ERR_INSTRUCTION_DATA", "token instruction");
        byte(26)(put);
        byte(4)(put);
        finish(node);
        // The sources go as they were passed (Token-2022 skips any it cannot harvest from).
        this.cpi(p, [[mint.c, true, false]], buf, len, none, { ...range, asPassed: true });
        return undefined;
      }
      case "withdrawWithheldTokensFromMint": {
        token2022Only();
        if (a.length !== 3 && a.length !== 4) this.fail(node, "withdrawWithheldTokensFromMint(mint, destination, authority, signerSeeds?)");
        const mint = anyAcct(a[0], "the mint", true);
        const dest = want(a[1], "token", true, "the destination");
        const auth = this.cpiAccount(a[2], "the withdraw authority");
        simple(
          26,
          [byte(2)],
          [
            [mint, true, false],
            [dest, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[2]),
        );
        return undefined;
      }
      case "setTransferFee": {
        token2022Only();
        if (a.length !== 4 && a.length !== 5) this.fail(node, "setTransferFee(mint, configAuthority, basisPoints, maximumFee, signerSeeds?)");
        const mint = anyAcct(a[0], "the mint", true);
        const auth = this.cpiAccount(a[1], "the config authority");
        const bps = (put: Put) => {
          const v = this.expect(this.expr(a[2], U16), U16, a[2]);
          this.line(`if (${v.c} > 10000) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: transfer fee above 10000 basis points");`);
          this.serialize(v, a[2], put);
        };
        simple(
          26,
          [byte(5), bps, value(a[3], U64)],
          [
            [mint, true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[4], auth, a[1]),
        );
        return undefined;
      }
      case "updateMetadataField":
      case "removeMetadataKey":
      case "updateMetadataAuthority":
      case "emitMetadata": {
        token2022Only();
        // The Token Metadata interface (spl-token-metadata-interface), served by Token-2022 for metadata in the mint.
        const usage = {
          updateMetadataField: "updateMetadataField(mint, updateAuthority, field, value, signerSeeds?)",
          removeMetadataKey: "removeMetadataKey(mint, updateAuthority, key, idempotent, signerSeeds?)",
          updateMetadataAuthority: "updateMetadataAuthority(mint, updateAuthority, newAuthority | null, signerSeeds?)",
          emitMetadata: "emitMetadata(mint)",
        }[method];
        const fixedArgs = { updateMetadataField: 4, removeMetadataKey: 4, updateMetadataAuthority: 3, emitMetadata: 1 }[method];
        if (a.length !== fixedArgs && (method === "emitMetadata" || a.length !== fixedArgs + 1)) this.fail(node, usage);
        const disc = {
          updateMetadataField: "dde9312db5cadcc8",
          removeMetadataKey: "ea122038598d25b5",
          updateMetadataAuthority: "d7e4a6e45464567b",
          emitMetadata: "faa6b4fa0d0cb846",
        }[method];
        const mint = anyAcct(a[0], "the mint", method !== "emitMetadata");
        const auth = method === "emitMetadata" ? undefined : this.cpiAccount(a[1], "the update authority");
        const { buf, len, put, finish } = this.byteBuffer("tmd", 1232, "TS_ERR_INSTRUCTION_DATA", "token metadata instruction");
        const d = this.tmp("disc");
        this.line(`static const uint8_t ${d}[8] = ${cBytes([...Buffer.from(disc, "hex")])};`);
        put(d, "8", 8);
        if (method === "updateMetadataField") {
          // Field: Name / Symbol / Uri for those names, otherwise Key(field), as the Token-2022 CLI reads them.
          const f = this.expect(this.expr(a[2], STRING), STRING, a[2]);
          const ft = this.tmp("field");
          const tag = this.tmp("ftag");
          this.line(`TS_Str ${ft} = ${f.c};`);
          this.line(
            `uint8_t ${tag} = ts_str_eq(${ft}, ts_str((const uint8_t *)"name", 4)) ? 0 : ts_str_eq(${ft}, ts_str((const uint8_t *)"symbol", 6)) ? 1 : ts_str_eq(${ft}, ts_str((const uint8_t *)"uri", 3)) ? 2 : 3;`,
          );
          put(`&${tag}`, "1", 1);
          const kl = this.tmp("klen");
          this.line(`uint32_t ${kl} = (uint32_t)${ft}.len;`);
          put(`&${kl}`, `(${tag} == 3 ? 4 : 0)`);
          put(`${ft}.ptr`, `(${tag} == 3 ? ${ft}.len : 0)`);
          this.serialize(this.expect(this.expr(a[3], STRING), STRING, a[3]), a[3], put);
        } else if (method === "removeMetadataKey") {
          const key = this.expect(this.expr(a[2], STRING), STRING, a[2]);
          const idem = this.expect(this.expr(a[3], BOOL), BOOL, a[3]);
          const t = this.tmp("idem");
          this.line(`uint8_t ${t} = (${idem.c}) ? 1 : 0;`);
          put(`&${t}`, "1", 1);
          this.serialize(key, a[2], put);
        } else if (method === "updateMetadataAuthority") {
          nonZeroKey(a[2])(put);
        } else {
          // start: None, end: None (the whole TokenMetadata as return data).
          byte(0)(put);
          byte(0)(put);
        }
        finish(node);
        const seeds = auth ? this.signerSeeds(a[fixedArgs], auth, a[1]) : none;
        this.cpi(
          p,
          auth
            ? [
                [mint.c, true, false],
                [auth.c, false, true],
              ]
            : [[mint.c, false, false]],
          buf,
          len,
          seeds,
        );
        return undefined;
      }
      case "approve": {
        arity(4);
        const src = want(a[0], "token", true, "the source");
        const delegate = this.cpiAccount(a[1], "the delegate");
        const owner = this.cpiAccount(a[2], "the owner");
        const s = this.signerSeeds(a[4], owner, a[2]);
        const amt = value(a[3], U64);
        simple(
          4,
          [amt],
          [
            [src, true, false],
            [delegate, false, false],
            [owner, false, true],
          ],
          s,
        );
        return undefined;
      }
      // The checked forms take the decimals from the mint, as transferChecked does.
      case "approveChecked": {
        arity(5);
        const src = want(a[0], "token", true, "the source");
        const mint = want(a[1], "mint", false, "the mint");
        const delegate = this.cpiAccount(a[2], "the delegate");
        const owner = this.cpiAccount(a[3], "the owner");
        const s = this.signerSeeds(a[5], owner, a[3]);
        simple(
          13,
          [value(a[4], U64), decimals(mint)],
          [
            [src, true, false],
            [mint, false, false],
            [delegate, false, false],
            [owner, false, true],
          ],
          s,
        );
        return undefined;
      }
      case "mintToChecked": {
        arity(4);
        const mint = want(a[0], "mint", true, "the mint");
        const to = want(a[1], "token", true, "the destination");
        const auth = this.cpiAccount(a[2], "the mint authority");
        const s = this.signerSeeds(a[4], auth, a[2]);
        simple(
          14,
          [value(a[3], U64), decimals(mint)],
          [
            [mint, true, false],
            [to, true, false],
            [auth, false, true],
          ],
          s,
        );
        return undefined;
      }
      case "burnChecked": {
        arity(4);
        const from = want(a[0], "token", true, "the burned account");
        const mint = want(a[1], "mint", true, "the mint");
        const auth = this.cpiAccount(a[2], "the authority");
        const s = this.signerSeeds(a[4], auth, a[2]);
        simple(
          15,
          [value(a[3], U64), decimals(mint)],
          [
            [from, true, false],
            [mint, true, false],
            [auth, false, true],
          ],
          s,
        );
        return undefined;
      }
      case "revoke": {
        arity(2);
        const src = want(a[0], "token", true, "the source");
        const owner = this.cpiAccount(a[1], "the owner");
        simple(
          5,
          [],
          [
            [src, true, false],
            [owner, false, true],
          ],
          this.signerSeeds(a[2], owner, a[1]),
        );
        return undefined;
      }
      case "setAuthority": {
        arity(4);
        const target = anyAcct(a[0], "the mint or token account", true);
        const current = this.cpiAccount(a[1], "the current authority");
        this.model.options.set("pubkey", PUBKEY);
        const s = this.signerSeeds(a[4], current, a[1]);
        simple(
          6,
          [value(a[2], U8), value(a[3], optKey)],
          [
            [target, true, false],
            [current, false, true],
          ],
          s,
        );
        return undefined;
      }
      case "freezeAccount":
      case "thawAccount": {
        arity(3);
        const acct = want(a[0], "token", true, "the token account");
        const mint = this.cpiAccount(a[1], "the mint");
        const auth = this.cpiAccount(a[2], "the freeze authority");
        simple(
          method === "freezeAccount" ? 10 : 11,
          [],
          [
            [acct, true, false],
            [mint, false, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[3], auth, a[2]),
        );
        return undefined;
      }
      case "syncNative": {
        if (a.length !== 1) this.fail(node, "syncNative(account) takes the wrapped-SOL token account");
        const acct = anyAcct(a[0], "the token account", true);
        simple(17, [], [[acct, true, false]], { name: "NULL", count: 0 });
        return undefined;
      }
      case "initializeMint2": {
        if (a.length !== 4) this.fail(node, "initializeMint2(mint, decimals, mintAuthority, freezeAuthority | null)");
        const mint = anyAcct(a[0], "the mint", true);
        this.model.options.set("pubkey", PUBKEY);
        simple(20, [value(a[1], U8), value(a[2], PUBKEY), value(a[3], optKey)], [[mint, true, false]], { name: "NULL", count: 0 });
        return undefined;
      }
      case "initializeAccount3": {
        if (a.length !== 3) this.fail(node, "initializeAccount3(account, mint, owner)");
        const acct = anyAcct(a[0], "the token account", true);
        const mint = this.cpiAccount(a[1], "the mint");
        simple(
          18,
          [value(a[2], PUBKEY)],
          [
            [acct, true, false],
            [mint, false, false],
          ],
          { name: "NULL", count: 0 },
        );
        return undefined;
      }
    }
    this.fail(
      node.expression,
      `token programs support transfer, transferChecked, mintTo, burn, closeAccount, approve, revoke, setAuthority, freezeAccount, thawAccount, syncNative, initializeMint2, initializeAccount3, initializeMetadata, updateMetadataField, removeMetadataKey, updateMetadataAuthority, emitMetadata, the Token-2022 extension instructions (updateDefaultAccountState, updateTransferHook, enableRequiredMemoTransfers, disableRequiredMemoTransfers, updateInterestRate, transferCheckedWithFee, harvestWithheldTokensToMint, withdrawWithheldTokensFromMint, setTransferFee) and initializers (initializeTransferFeeConfig, initializeMintCloseAuthority, initializeNonTransferableMint, initializePermanentDelegate, initializeDefaultAccountState, initializeMetadataPointer, initializeGroupPointer, initializeGroupMemberPointer, initializeTransferHook, initializeInterestBearingMint, initializeImmutableOwner), not ${method}`,
    );
  }

  protected ataOp(node: ts.CallExpression, program: CpiProgram, method: string): undefined {
    if (method !== "create" && method !== "createIdempotent") this.fail(node.expression, "the Associated Token program supports create and createIdempotent");
    const a = node.arguments;
    if (a.length !== 6) this.fail(node, `${method}(payer, ata, owner, mint, systemProgram, tokenProgram) takes six accounts`);
    const payer = this.cpiAccount(a[0], "the payer");
    if (payer.param && (payer.param.kind.kind !== "signer" || !payer.param.kind.mut)) this.fail(a[0], "the payer must be a Mut<Signer>");
    const ata = this.cpiAccount(a[1], "the token account");
    if (ata.param && !isWritable(ata.param.kind)) this.fail(a[1], "the token account must be Mut<AccountInfo>");
    const [owner, mint, sys, tp] = [a[2], a[3], a[4], a[5]].map((n, i) =>
      this.cpiAccount(n, ["the owner", "the mint", "the system program", "the token program"][i]),
    );
    if (sys.param && sys.param.kind.kind !== "system") this.fail(a[4], "pass the SystemProgram parameter");
    if (tp.param && tp.param.kind.kind !== "tokenProgram") this.fail(a[5], "pass a token program parameter");
    this.line(`TS_TRY(ts_ata_create(params, ${program.c}, ${payer.c}, ${ata.c}, ${owner.c}, ${mint.c}, ${sys.c}, ${tp.c}, ${method === "createIdempotent"}));`);
    return undefined;
  }

  /** memoProgram.memo(text, signers?, signerSeeds?): SPL Memo v2, the UTF-8 text as data, each signer a signing account. */
  protected memoOp(node: ts.CallExpression, program: CpiProgram, method: string): undefined {
    if (method !== "memo") this.fail(node.expression, "the Memo program has memo(text, signers?, signerSeeds?)");
    const a = node.arguments;
    if (a.length < 1 || a.length > 3) this.fail(node, "memo(text, signers?, signerSeeds?)");
    const text = this.expect(this.expr(a[0], STRING), STRING, a[0]);
    const list = a[1];
    if (list && !ts.isArrayLiteralExpression(list)) this.fail(list, "the signers are a list of accounts: [authority, …]");
    const signers = list ? (list as ts.ArrayLiteralExpression).elements.map((e) => this.cpiAccount(e, "a memo signer")) : [];
    const t = this.tmp("memo");
    this.line(`TS_Str ${t} = ${text.c};`);
    const seeds = a[2] ? this.signingSeeds(a[2]) : { name: "NULL", count: 0 };
    if (!signers.length) this.line(`TS_TRY(ts_cpi(params, ${program.c}, (uint8_t *)${t}.ptr, ${t}.len, NULL, 0, ${seeds.name}, ${seeds.count}));`);
    else
      this.cpi(
        program.c,
        signers.map((s) => [s.c, false, true]),
        `(uint8_t *)${t}.ptr`,
        `${t}.len`,
        seeds,
      );
    return undefined;
  }

  /**
   * The Stake program (bincode: a u32 instruction tag, as solana-stake-interface's StakeInstruction numbers them):
   * initialize, authorize, delegate, split, deactivate, withdraw, merge and getMinimumDelegation, with the account
   * metas of its instruction builders and the sysvar and config accounts it reads passed in. Each authority signs (a
   * PDA of this program with `signerSeeds`).
   */
  protected stakeOp(node: ts.CallExpression, program: CpiProgram, method: string): Value | undefined {
    const a = node.arguments;
    type Put = (src: string, n: string, bytes?: number) => void;
    const acct = (i: number, what: string, mut = false) => {
      const x = this.cpiAccount(a[i]!, what);
      if (mut && x.param && !isWritable(x.param.kind)) this.fail(a[i]!, `${what} must be writable (Mut<...>)`);
      return x;
    };
    /**
     * A sysvar or config slot: an account, or `named(account, address)`, which names `address` in the instruction's
     * account list as solana_program's stake instruction builders do while handing the runtime `account` (the slot's
     * account, as Rust passes it to invoke_signed): the runtime looks the address up among the CPI's accounts only, so
     * a slot holding another account fails (MissingAccount), as the original does.
     */
    const sysvar = (i: number, what: string): CpiAcct => {
      let n = a[i]!;
      while (ts.isParenthesizedExpression(n)) n = n.expression;
      if (ts.isCallExpression(n) && this.exportName(n.expression) === "named") {
        if (n.arguments.length !== 2) this.fail(n, "named(account, address) takes the slot's account and the address the instruction names");
        const x = this.cpiAccount(n.arguments[0]!, what);
        const k = this.expect(this.expr(n.arguments[1]!, PUBKEY), PUBKEY, n.arguments[1]!);
        const t = this.tmp("named");
        this.line(`const SolPubkey *${t} = ${k.c};`);
        return { ...x, named: t };
      }
      if (this.checker.typeToString(this.checker.getTypeAtLocation(n)) === "Pubkey")
        this.fail(n, `pass ${what} as an account, or named(account, address) to name its address with the slot's account`);
      return acct(i, what);
    };
    const send = (tag: number, fields: ((put: Put) => void)[], metas: [CpiAcct, boolean, boolean][], seeds: { name: string; count: number | string }) => {
      const { buf, len, put, finish } = this.byteBuffer("stk", 116, "TS_ERR_INSTRUCTION_DATA", "stake instruction");
      const t = this.tmp("tag");
      this.line(`uint32_t ${t} = ${tag};`);
      put(`&${t}`, "4", 4);
      for (const f of fields) f(put);
      finish(node);
      if (metas.some(([x]) => x.named)) {
        // Addresses named with the slot's account: the account infos are the CPI's accounts, as passed (ts_cpi_named).
        const m = this.tmp("metas");
        const infos = this.tmp("accts");
        this.line(
          `SolAccountMeta ${m}[${metas.length}] = {${metas.map(([x, w, sg]) => `{${x.named ? `(SolPubkey *)${x.named}` : `&${x.c}->key`}, ${w}, ${sg}}`).join(", ")}};`,
        );
        this.line(`const TsAccount *${infos}[${metas.length}] = {${metas.map(([x]) => x.c).join(", ")}};`);
        this.line(`TS_TRY(ts_cpi_named(params, ${program.c}, ${buf}, ${len}, ${m}, ${metas.length}, ${infos}, ${seeds.name}, ${seeds.count}));`);
        return;
      }
      this.cpi(
        program.c,
        metas.map(([x, w, sg]) => [x.c, w, sg]),
        buf,
        len,
        seeds,
      );
    };
    const value = (n: ts.Expression, t: ValueType) => (put: Put) => this.serialize(this.expect(this.expr(n, t), t, n), n, put);
    const zeros = (n: number) => (put: Put) => {
      const z = this.tmp("z");
      this.line(`uint8_t ${z}[${n}] = {0};`);
      put(z, String(n), n);
    };
    const arity = (n: number, usage: string) => {
      if (a.length !== n && a.length !== n + 1) this.fail(node, usage);
    };
    // signerSeeds, or an account (a lockup custodian) in the optional slot before it.
    const isSeeds = (n: ts.Expression | undefined) =>
      !!n &&
      (ts.isArrayLiteralExpression(n) ||
        (ts.isIdentifier(n) && this.lookup(n.text)?.type.kind === "signerSeeds") ||
        (ts.isCallExpression(n) && this.exportName(n.expression) === "signer"));
    /** The optional custodian at `i` (then the seeds at i + 1), or the seeds there. */
    const custodianAt = (i: number): { custodian?: ts.Expression; seeds?: ts.Expression } =>
      a[i] && !isSeeds(a[i]) ? { custodian: a[i], seeds: a[i + 1] } : { seeds: a[i] };
    /** The lockup custodian signs too: a Signer, or a PDA of this program covered by the seeds. */
    const custodian = (n: ts.Expression, seeds: ts.Expression | undefined): [CpiAcct, boolean, boolean] => {
      const x = this.cpiAccount(n, "the lockup custodian");
      if (!seeds && x.param && x.param.kind.kind !== "signer") this.fail(n, "the custodian must be a Signer, or pass signerSeeds for a PDA custodian");
      return [x, false, true];
    };
    switch (method) {
      case "initialize": {
        // Authorized { staker, withdrawer }, Lockup { unix_timestamp, epoch, custodian }: none, or the one given.
        if (a.length !== 4 && a.length !== 5) this.fail(node, "initialize(stake, rentSysvar, staker, withdrawer, lockup?)");
        send(
          0,
          [value(a[2]!, PUBKEY), value(a[3]!, PUBKEY), a[4] ? (put) => this.stakeLockup(a[4]!, put) : zeros(48)],
          [
            [acct(0, "the stake account", true), true, false],
            [sysvar(1, "the Rent sysvar"), false, false],
          ],
          {
            name: "NULL",
            count: 0,
          },
        );
        return undefined;
      }
      case "authorize": {
        const usage = 'authorize(stake, clockSysvar, authority, newAuthority, "staker" | "withdrawer", custodian?, signerSeeds?)';
        if (a.length < 5 || a.length > 7) this.fail(node, usage);
        const kind = a[4]!;
        const i = ts.isStringLiteral(kind) ? ["staker", "withdrawer"].indexOf(kind.text) : -1;
        if (i < 0) this.fail(kind, 'the authority to change is "staker" or "withdrawer"');
        const opt = custodianAt(5);
        if (a.length === 7 && !opt.custodian) this.fail(a[5]!, usage);
        const auth = acct(2, "the authority");
        const k = this.tmp("which");
        send(
          1,
          [value(a[3]!, PUBKEY), (put) => (this.line(`uint32_t ${k} = ${i};`), put(`&${k}`, "4", 4))],
          [
            [acct(0, "the stake account", true), true, false],
            [sysvar(1, "the Clock sysvar"), false, false],
            [auth, false, true],
            ...(opt.custodian ? [custodian(opt.custodian, opt.seeds)] : []),
          ],
          this.signerSeeds(opt.seeds, auth, a[2]!),
        );
        return undefined;
      }
      case "delegate": {
        arity(6, "delegate(stake, vote, clockSysvar, stakeHistorySysvar, stakeConfig, staker, signerSeeds?)");
        const staker = acct(5, "the staker");
        send(
          2,
          [],
          [
            [acct(0, "the stake account", true), true, false],
            [acct(1, "the vote account"), false, false],
            [sysvar(2, "the Clock sysvar"), false, false],
            [sysvar(3, "the StakeHistory sysvar"), false, false],
            [sysvar(4, "the stake config account"), false, false],
            [staker, false, true],
          ],
          this.signerSeeds(a[6], staker, a[5]!),
        );
        return undefined;
      }
      case "split": {
        arity(4, "split(stake, splitStake, authority, lamports, signerSeeds?)");
        const auth = acct(2, "the staker");
        send(
          3,
          [value(a[3]!, U64)],
          [
            [acct(0, "the stake account", true), true, false],
            [acct(1, "the split stake account", true), true, false],
            [auth, false, true],
          ],
          this.signerSeeds(a[4], auth, a[2]!),
        );
        return undefined;
      }
      case "deactivate": {
        arity(3, "deactivate(stake, clockSysvar, staker, signerSeeds?)");
        const staker = acct(2, "the staker");
        send(
          5,
          [],
          [
            [acct(0, "the stake account", true), true, false],
            [sysvar(1, "the Clock sysvar"), false, false],
            [staker, false, true],
          ],
          this.signerSeeds(a[3], staker, a[2]!),
        );
        return undefined;
      }
      case "withdraw": {
        const usage = "withdraw(stake, to, clockSysvar, stakeHistorySysvar, withdrawer, lamports, custodian?, signerSeeds?)";
        if (a.length < 6 || a.length > 8) this.fail(node, usage);
        const opt = custodianAt(6);
        if (a.length === 8 && !opt.custodian) this.fail(a[6]!, usage);
        const withdrawer = acct(4, "the withdrawer");
        send(
          4,
          [value(a[5]!, U64)],
          [
            [acct(0, "the stake account", true), true, false],
            [acct(1, "the destination", true), true, false],
            [sysvar(2, "the Clock sysvar"), false, false],
            [sysvar(3, "the StakeHistory sysvar"), false, false],
            [withdrawer, false, true],
            ...(opt.custodian ? [custodian(opt.custodian, opt.seeds)] : []),
          ],
          this.signerSeeds(opt.seeds, withdrawer, a[4]!),
        );
        return undefined;
      }
      case "merge": {
        arity(5, "merge(destination, source, clockSysvar, stakeHistorySysvar, staker, signerSeeds?)");
        const staker = acct(4, "the staker");
        send(
          7,
          [],
          [
            [acct(0, "the destination stake account", true), true, false],
            [acct(1, "the source stake account", true), true, false],
            [sysvar(2, "the Clock sysvar"), false, false],
            [sysvar(3, "the StakeHistory sysvar"), false, false],
            [staker, false, true],
          ],
          this.signerSeeds(a[5], staker, a[4]!),
        );
        return undefined;
      }
      case "getMinimumDelegation": {
        // GetMinimumDelegation (no accounts), then the u64 the Stake program returns, read as
        // solana_program::stake::tools::get_minimum_delegation reads it (and fails as it does).
        if (a.length) this.fail(node, "getMinimumDelegation() takes no arguments");
        const t = this.tmp("tag");
        const out = this.tmp("mindel");
        const from = this.tmp("from");
        const n = this.tmp("n");
        const pre = this.model.constants.get("PROGRAM_ERROR_LOG_PREFIX")?.value;
        const fail = (code: number, name: string, why: string) =>
          this.programFail(`((uint64_t)${code}) << 32`, typeof pre === "string" ? `${pre}${name}` : `TypeSOL: ${why}`);
        this.line(`uint32_t ${t} = 13;`);
        this.line(`TS_TRY(ts_cpi(params, ${program.c}, (uint8_t *)&${t}, 4, NULL, 0, NULL, 0));`);
        this.line(`uint64_t ${out} = 0;`);
        this.line(`SolPubkey ${from};`);
        this.line(`uint64_t ${n} = sol_get_return_data((uint8_t *)&${out}, 8, &${from});`);
        this.line(`if (${n} == 0) ${fail(3, "InvalidInstructionData", "no minimum delegation returned")};`);
        this.line(`if (!ts_key_eq(&${from}, &${program.c}->key)) ${fail(7, "IncorrectProgramId", "return data not from the Stake program")};`);
        this.line(`if (${n} != 8) ${fail(3, "InvalidInstructionData", "the minimum delegation is not a u64")};`);
        return { c: out, type: U64 };
      }
    }
    this.fail(
      node.expression,
      `the Stake program supports initialize, authorize, delegate, split, deactivate, withdraw, merge and getMinimumDelegation, not ${method}`,
    );
  }

  /** A stake Lockup { unix_timestamp: i64, epoch: u64, custodian: Pubkey } from `{ unixTimestamp, epoch, custodian }`. */
  protected stakeLockup(n: ts.Expression, put: (src: string, n: string, bytes?: number) => void): void {
    if (!ts.isObjectLiteralExpression(n)) this.fail(n, "the lockup is written { unixTimestamp, epoch, custodian }");
    const props = this.literalProps(n, ["unixTimestamp", "epoch", "custodian"], "the lockup");
    for (const f of ["unixTimestamp", "epoch", "custodian"]) if (!props.has(f)) this.fail(n, `the lockup needs ${f} (unixTimestamp, epoch, custodian)`);
    // Evaluated in source order (as JS does), laid out in the Lockup's.
    const types: Record<string, ValueType> = { unixTimestamp: I64, epoch: U64, custodian: PUBKEY };
    const held = new Map<string, string>();
    for (const [k, e] of props) {
      const v = this.expect(this.expr(e, types[k]), types[k], e);
      const t = this.tmp("lk");
      this.line(k === "custodian" ? `SolPubkey ${t} = *(${v.c});` : `${k === "epoch" ? "uint64_t" : "int64_t"} ${t} = ${v.c};`);
      held.set(k, t);
    }
    put(`&${held.get("unixTimestamp")}`, "8", 8);
    put(`&${held.get("epoch")}`, "8", 8);
    put(`&${held.get("custodian")}`, "32", 32);
  }
}
