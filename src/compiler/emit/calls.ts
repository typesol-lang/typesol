import ts from "typescript";
import { calleeName, discriminator, resolveScalarType, resolveValueType, snakeCase, structNameOf, typesolName } from "../analyze.js";
import { borshIdentical, borshNativeStructUnsupported } from "./borsh.js";
import { ANCHOR_ERRORS } from "../anchor-errors.js";
import { decodeAddress } from "../../keys.js";
import {
  INT_INFO,
  INT_NAMES,
  type AccountParam,
  type ErrorDef,
  type FieldType,
  type Helper,
  type IntName,
  type ParamKind,
  type ScalarType,
  type StructDef,
  type ValueType,
  isScalar,
  isWritable,
  sameType,
  scalarSize,
  typeName,
} from "../model.js";
import {
  U64,
  U32,
  U8,
  I64,
  I32,
  BOOL,
  PUBKEY,
  STRING,
  HASH,
  type Value,
  type Ref,
  type CpiAcct,
  type CpiProgram,
  cBytes,
  cString,
  scalarC,
  scalarStorageC,
  optC,
  valueC,
  fieldC,
  storageDecl,
  accountMismatch,
  vecCount,
  emptySizeC,
  vecLenCheck,
  type Closure,
  type Local,
} from "./shared.js";
import { ExpressionEmitter } from "./expressions.js";

/**
 * Calls: built-in functions, Vec methods, helpers, remaining accounts, foreign account reads and return data.
 */
/** List methods taking a callback (or a value) that expand into a loop. */
/** solana_program's ProgramError variants with no data, in order from InvalidArgument (2) on. */
const PROGRAM_ERRORS = [
  "InvalidArgument",
  "InvalidInstructionData",
  "InvalidAccountData",
  "AccountDataTooSmall",
  "InsufficientFunds",
  "IncorrectProgramId",
  "MissingRequiredSignature",
  "AccountAlreadyInitialized",
  "UninitializedAccount",
  "NotEnoughAccountKeys",
  "AccountBorrowFailed",
  "MaxSeedLengthExceeded",
  "InvalidSeeds",
  "BorshIoError",
  "AccountNotRentExempt",
  "UnsupportedSysvar",
  "IllegalOwner",
  "MaxAccountsDataAllocationsExceeded",
  "InvalidRealloc",
  "MaxInstructionTraceLengthExceeded",
  "BuiltinProgramsMustConsumeComputeUnits",
  "InvalidAccountOwner",
  "ArithmeticOverflow",
  "Immutable",
  "IncorrectAuthority",
];

const LIST_METHODS = new Set(["forEach", "some", "every", "find", "findIndex", "reduce", "includes", "indexOf"]);
/** The byte builders of a FixedVec<u8, N> (byteListMethod). */
const BYTE_METHODS = new Set(["pushLE", "pushKey", "pushBorsh", "setLE", "truncate"]);

export abstract class CallEmitter extends ExpressionEmitter {
  protected call(node: ts.CallExpression, topLevel: boolean): Value | undefined {
    const callee = node.expression;
    const args = node.arguments;
    const builtin = this.exportName(callee);

    if (builtin && (INT_NAMES as readonly string[]).includes(builtin)) {
      if (args.length !== 1) this.fail(node, `${builtin}() takes one argument`);
      return this.cast(args[0], { kind: "int", name: builtin as IntName });
    }
    switch (builtin) {
      case "stackHeight": {
        if (args.length) this.fail(node, "stackHeight() takes no arguments");
        return { c: "sol_get_stack_height()", type: U64 };
      }
      case "constraint":
        this.fail(node, "constraint(account, condition, error?) goes at the start of an instruction's body, before any other statement");
      case "require": {
        if (args.length !== 2) this.fail(node, "require(condition, error) takes two arguments");
        const cond = this.expect(this.expr(args[0], BOOL), BOOL, args[0]);
        if (!this.namesError(args[1])) {
          // A code computed at run time (a helper that returns its error as a value): u32, the program error it names.
          const v = this.expr(args[1], U32);
          if (v.type.kind === "string")
            this.fail(
              args[1],
              "require's error is a string literal, a member of an error enum (CounterError.X) or a u32 code; a template string or string variable is not: give the message to an error enum member",
            );
          const code = v.literal !== undefined ? this.literal(v.literal, U32, args[1]) : this.expect(v, U32, args[1]);
          if (this.quietErrors()) this.line(`if (!${cond.c}) return ts_fail_code_quiet(${code.c});`);
          else this.line(`if (!${cond.c}) return ts_fail_code(${code.c}, ${cString(`Error: the code returned (${this.location(node)})`)});`);
          return undefined;
        }
        // A built-in ProgramError: its u64 form (the index shifted into the high 32 bits), as solana_program returns it.
        if (ts.isPropertyAccessExpression(args[1]) && this.exportName(args[1].expression) === "ProgramError") {
          if (!PROGRAM_ERRORS.includes(args[1].name.text)) this.fail(args[1].name, `ProgramError has no ${args[1].name.text}`);
          this.line(`if (!${cond.c}) ${this.programErrorFail(args[1].name.text, node)};`);
          return undefined;
        }
        const err = this.errorRef(args[1]);
        // `const ERROR_LOG_PREFIX = "AMM error: "`: the program's errors log as its native entrypoint logs them.
        // `const ERROR_LOG_PREFIX = null`: nothing logged, only the code returned.
        const prefix = this.model.constants.get("ERROR_LOG_PREFIX")?.value;
        const text = typeof prefix === "string" ? `${prefix}${err.msg}` : `Error ${err.code} ${err.name}: ${err.msg} (${this.location(node)})`;
        if (prefix === null) this.line(`if (!${cond.c}) return ts_fail_quiet(${err.code});`);
        else this.line(`if (!${cond.c}) TS_FAIL(${err.code}, ${cString(text)});`);
        return undefined;
      }
      case "panic": {
        // String literals, or top-level string constants.
        const text = (a: ts.Expression): string | undefined => {
          if (ts.isStringLiteralLike(a)) return a.text;
          const v = ts.isIdentifier(a) ? this.model.constants.get(a.text)?.value : undefined;
          return typeof v === "string" ? v : undefined;
        };
        // A null message: nothing logged, only the runtime's line (a native program whose panic handler logs nothing).
        const silent = args.length > 0 && args[0]!.kind === ts.SyntaxKind.NullKeyword;
        if (args.length > 2 || args.some((a, i) => !(i === 0 && silent) && text(a) === undefined))
          this.fail(
            node,
            'panic() takes an optional message (or null to log nothing) and an optional "file:line:column" location: string literals or string constants',
          );
        const msg = silent ? undefined : args.length ? text(args[0]!)! : "explicit panic";
        if (silent && this.panicStyle())
          this.fail(
            args[0]!,
            'under PANIC_STYLE "solana-1.14" a panic logs its message, as solana_program 1.14\'s panic handler always does: pass the message',
          );
        // The location the runtime reports ("SBF program Panicked in <file> at <line>:<column>"), or the panic line
        // logs: the given one, as a ported program's panic reports it, else this source line (with its column under
        // PANIC_STYLE, as Rust always gives one).
        const at = args.length > 1 ? text(args[1]!)! : this.panicStyle() ? this.locationWithColumn(node) : this.location(node);
        for (const l of this.panicC(msg, at)) this.line(l);
        return undefined;
      }
      case "panicsAt": {
        // The checked arithmetic of `expression` panics as Rust's does at `location`, with Rust's messages.
        const first = args[0];
        const loc = first && (ts.isStringLiteralLike(first) ? first.text : ts.isIdentifier(first) ? this.model.constants.get(first.text)?.value : undefined);
        if (args.length !== 2 || typeof loc !== "string" || !/^.+:\d+:\d+$/.test(loc))
          this.fail(
            node,
            'panicsAt(location, expression) takes a "file:line:column" string literal (or string constant) and the expression whose arithmetic panics there',
          );
        // Prettier writes an assignment argument in parentheses: `panicsAt(loc, (total += fee))`.
        let inner = args[1]!;
        while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
        const outer = this.panicAt;
        this.panicAt = loc;
        try {
          // A statement: an assignment, a compound assignment (`total += fee`) or ++ / --.
          const assigns =
            (ts.isBinaryExpression(inner) &&
              inner.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
              inner.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
            ((ts.isPrefixUnaryExpression(inner) || ts.isPostfixUnaryExpression(inner)) &&
              (inner.operator === ts.SyntaxKind.PlusPlusToken || inner.operator === ts.SyntaxKind.MinusMinusToken));
          if (assigns) {
            if (!ts.isExpressionStatement(node.parent))
              this.fail(inner, "an assignment inside panicsAt is a statement of its own: panicsAt(location, total += fee);");
            this.expressionStatement(inner, topLevel);
            return undefined;
          }
          return this.expr(inner);
        } finally {
          this.panicAt = outer;
        }
      }
      case "abort": {
        // Rust's abort on SBF: the runtime's `abort` syscall ("SBF program panicked", no location, nothing logged).
        if (args.length) this.fail(node, "abort() takes no arguments; log the original's message first with log(…) where it writes one");
        this.line(`abort();`);
        return undefined;
      }
      case "log": {
        if (args.length !== 1) this.fail(node, "log() takes one argument");
        const v = this.expr(args[0]);
        if (v.stringLiteral !== undefined) this.line(`sol_log(${cString(v.stringLiteral)});`);
        else if (v.type.kind === "string") {
          const t = this.tmp("s");
          this.line(`TS_Str ${t} = ${v.c};`);
          this.line(`sol_log_((const char *)${t}.ptr, ${t}.len);`);
        } else {
          let value = v.literal !== undefined ? this.expect(v, U64, args[0]) : v;
          // An Option TypeScript has narrowed to its value (after `x === null` was ruled out): log the value.
          if (value.type.kind === "option") {
            const t = this.checker.getTypeAtLocation(args[0]);
            if (t.isUnion() && t.types.some((m) => m.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)))
              this.fail(args[0], "log() takes a value, not an Option that may be null: check `x !== null` first, or log `${x}` (null prints as null)");
            value = this.unwrap(value, args[0]);
          }
          if (value.type.kind === "pubkey") this.line(`sol_log_pubkey(${value.c});`);
          else if (value.type.kind === "int") {
            // Decimal, like console.log (sol_log_64 would print five hex words).
            const t = this.tmp("s");
            this.line(`TS_Str ${t};`);
            this.line(this.textOfInt(value.type.name, value.c, t));
            this.line(`sol_log_((const char *)${t}.ptr, ${t}.len);`);
          } else if (value.type.kind === "bool") this.line(`sol_log((${value.c}) ? "true" : "false");`);
          else this.line(`sol_log_64(0, 0, 0, 0, (uint64_t)(${value.c}));`);
        }
        return undefined;
      }
      case "byteLength": {
        if (args.length !== 1) this.fail(node, "byteLength(s) takes one argument");
        const v = this.expect(this.expr(args[0]), STRING, args[0]);
        return { c: `(${v.c}).len`, type: U64 };
      }
      case "requirePda": {
        if (args.length !== 3) this.fail(node, "requirePda(account, seeds, bump) takes three arguments");
        const a = this.accountParam(args[0], "requirePda's first argument");
        // Seeds before the bump, as JS evaluates them (seed values are copied as they are lowered).
        const seeds = this.seeds(args[1], 1);
        const bump = this.expect(this.expr(args[2], U8), U8, args[2]);
        this.recordPda(a, seeds.idl);
        const b = this.tmp("bump");
        this.line(`uint8_t ${b} = ${bump.c};`);
        this.line(`${seeds.name}[${seeds.count}] = (SolSignerSeed){&${b}, 1};`);
        this.line(`TS_TRY(ts_require_pda(a_${a.name}, ${seeds.name}, ${seeds.count + 1}, params->program_id));`);
        return undefined;
      }
      case "close": {
        if (args.length !== 2) this.fail(node, "close(account, destination) takes two arguments");
        const a = this.accountParam(args[0], "close's account");
        if (a.kind.kind !== "account" || !a.kind.mut) this.fail(args[0], "close() needs a Mut<Struct> account owned by this program");
        const d = this.accountParam(args[1], "close's destination");
        if (!isWritable(d.kind)) this.fail(args[1], "the destination must be writable (Mut<...>)");
        this.line(`TS_TRY(ts_close(a_${a.name}, a_${d.name}));`);
        return undefined;
      }
      case "minimumBalance": {
        if (args.length !== 1) this.fail(node, "minimumBalance(account) takes one argument");
        const a = this.accountParam(args[0], "minimumBalance's argument");
        const t = this.tmp();
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_minimum_balance(a_${a.name}->data_len, &${t}));`);
        return { c: t, type: U64 };
      }
      case "slotsPerEpoch":
      case "firstNormalEpoch":
      case "firstNormalSlot":
      case "epochWarmup":
      case "lastRestartSlot": {
        if (args.length !== 0) this.fail(node, `${builtin}() takes no arguments`);
        const t = this.tmp();
        this.line(`uint64_t ${t};`);
        if (builtin === "lastRestartSlot") this.line(`TS_TRY(ts_last_restart_slot(&${t}));`);
        else this.line(`TS_TRY(ts_epoch_schedule(${{ slotsPerEpoch: 0, epochWarmup: 2, firstNormalEpoch: 3, firstNormalSlot: 4 }[builtin]}, &${t}));`);
        return builtin === "epochWarmup" ? { c: `(${t} != 0)`, type: BOOL } : { c: t, type: U64 };
      }
      case "epochRewards": {
        if (args.length !== 0) this.fail(node, "epochRewards() takes no arguments");
        // Rust's EpochRewards::get() (sol_get_epoch_rewards_sysvar): a copy of the sysvar, read where it is called.
        const t = this.tmp("erw");
        this.line(`TsEpochRewards ${t};`);
        this.line(`TS_TRY(ts_epoch_rewards(&${t}));`);
        return { c: t, type: { kind: "epochRewards" } };
      }
      case "currentSlot":
      case "currentEpoch":
      case "epochStartTimestamp":
      case "now": {
        if (args.length !== 0) this.fail(node, `${builtin}() takes no arguments`);
        // Clock { slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp }
        const field = builtin === "currentSlot" ? 0 : builtin === "currentEpoch" ? 2 : builtin === "epochStartTimestamp" ? 1 : 4;
        const t = this.tmp();
        if (this.ix) {
          // The Clock does not change within a transaction: an instruction reads it once, on first use.
          if (!this.hoisted.some((l) => l.includes("ts_clk_ok"))) this.hoisted.push(`  uint64_t ts_clk[5]; bool ts_clk_ok = false;`);
          this.line(`if (!ts_clk_ok) { TS_TRY(ts_read_clock(ts_clk)); ts_clk_ok = true; }`);
          if (builtin === "now") return { c: `((int64_t)ts_clk[4])`, type: I64 };
          if (builtin === "epochStartTimestamp") return { c: `((int64_t)ts_clk[1])`, type: I64 };
          this.line(`uint64_t ${t} = ts_clk[${field}];`);
          return { c: t, type: U64 };
        }
        if (builtin === "now") {
          this.line(`int64_t ${t};`);
          this.line(`TS_TRY(ts_now(&${t}));`);
          return { c: t, type: I64 };
        }
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_clock_u64(${field}, &${t}));`);
        if (builtin === "epochStartTimestamp") return { c: `((int64_t)${t})`, type: I64 };
        return { c: t, type: U64 };
      }
      case "pubkey": {
        const lit = args[0];
        if (args.length !== 1 || !ts.isStringLiteral(lit)) this.fail(node, 'pubkey("…") takes one base58 string literal');
        const bytes = decodeAddress(lit.text);
        if (!bytes) this.fail(lit, `"${lit.text}" is not a valid base58 Solana address`);
        const t = this.tmp("pk");
        this.line(`static const SolPubkey ${t} = {${cBytes([...bytes])}};`);
        return { c: `(&${t})`, type: PUBKEY };
      }
      case "mulDiv":
      case "mulDivCeil": {
        // a * b / c with a double-width intermediate (128-bit for u64, 256-bit for u128), rounding down or up;
        // aborts if the result does not fit. All three are u64, or all u128 (literals take the others' type).
        if (args.length !== 3) this.fail(node, `${builtin}(a, b, c) takes three u64, u128 or u256 values`);
        const vals: Value[] = [];
        for (const a of args) {
          const mark = this.lines.length;
          const v = this.expr(a);
          for (let j = 0; j < vals.length; j++) vals[j] = this.settle(vals[j], mark);
          vals.push(v);
        }
        const typed = vals.find((v) => v.literal === undefined);
        if (typed?.type.kind === "int" && typed.type.name === "u256") {
          // u256: a 512-bit product in the runtime.
          const ty: Value["type"] = typed.type;
          const [x, y, z] = vals.map((v, i) => this.expect(v.literal !== undefined ? this.literal(v.literal, ty, args[i]) : v, ty, args[i]));
          const t = this.tmp("md");
          this.line(`TsU256 ${t};`);
          this.line(`if (ts_u256_is_zero(${z.c})) TS_FAIL(TS_ERR_DIV_ZERO, "TypeSOL: division by zero");`);
          this.line(
            `if (!ts_u256_muldiv(${x.c}, ${y.c}, ${z.c}, ${builtin === "mulDivCeil"}, &${t})) TS_FAIL(TS_ERR_OVERFLOW, "TypeSOL: arithmetic overflow");`,
          );
          return { c: t, type: ty };
        }
        const wide = typed?.type.kind === "int" && typed.type.name === "u128";
        const ty: Value["type"] = wide ? { kind: "int", name: "u128" } : U64;
        const [x, y, z] = vals.map((v, i) => this.expect(v.literal !== undefined ? this.literal(v.literal, ty, args[i]) : v, ty, args[i]));
        const t = this.tmp("md");
        this.line(`${wide ? "unsigned __int128" : "uint64_t"} ${t};`);
        this.line(`TS_TRY(ts_mul_div${wide ? "_u128" : ""}(${x.c}, ${y.c}, ${z.c}, ${builtin === "mulDivCeil"}, &${t}));`);
        return { c: t, type: ty };
      }
      case "f64FromBits":
      case "f64Bits": {
        // An f64 is its IEEE bits held as a u64: both are the same value, typed for the IDL and for TypeScript.
        if (args.length !== 1) this.fail(node, `${builtin}(x) takes one ${builtin === "f64Bits" ? "f64" : "u64"}`);
        const v = this.expr(args[0]);
        const x = v.literal !== undefined ? this.literal(v.literal, U64, args[0]) : this.expect(v, U64, args[0]);
        return { c: x.c, type: builtin === "f64Bits" ? U64 : { kind: "int", name: "u64", f64: true } };
      }
      case "isqrt": {
        if (args.length !== 1) this.fail(node, "isqrt(x) takes one unsigned integer");
        const v = this.expr(args[0]);
        const x = v.literal !== undefined ? this.literal(v.literal, U64, args[0]) : v;
        if (x.type.kind !== "int" || INT_INFO[x.type.name].signed) this.fail(args[0], "isqrt needs an unsigned integer (u8 … u256)");
        if (x.type.name === "u256") return { c: `ts_isqrt_u256(${x.c})`, type: x.type };
        const wide = INT_INFO[x.type.name].bytes === 16;
        return { c: wide ? `ts_isqrt_u128(${x.c})` : `((${INT_INFO[x.type.name].c})ts_isqrt_u64((uint64_t)(${x.c})))`, type: x.type };
      }
      case "min":
      case "max": {
        if (args.length !== 2) this.fail(node, `${builtin}(a, b) takes two integers of the same type`);
        let a = this.expr(args[0]);
        const mark = this.lines.length;
        let b = this.expr(args[1], a.type.kind === "int" && a.literal === undefined ? a.type : undefined);
        a = this.settle(a, mark);
        if (a.literal !== undefined && b.literal !== undefined) {
          a = this.literal(a.literal, U64, args[0]);
          b = this.literal(b.literal, U64, args[1]);
        } else if (a.literal !== undefined) a = this.expect(a, b.type, args[0]);
        else b = this.expect(b, a.type, args[1]);
        if (a.type.kind !== "int" || !sameType(a.type, b.type)) this.fail(node, `${builtin}(a, b) takes two integers of the same type`);
        const t = this.tmp("mm");
        this.line(`${INT_INFO[a.type.name].c} ${t} = (${a.c} ${builtin === "min" ? "<" : ">"} ${b.c}) ? ${a.c} : ${b.c};`);
        return { c: t, type: a.type };
      }
      case "realloc": {
        // Resize a struct account of this program: growth is paid by `payer`; shrinking keeps the lamports in the account.
        if (args.length !== 3) this.fail(node, "realloc(account, newSize, payer) takes three arguments");
        if (!this.ix) this.fail(node, "realloc() is only available in instructions");
        const acct = this.accountParam(args[0], "realloc's account");
        const k = acct.kind;
        const struct = k.kind === "account" || k.kind === "init" || k.kind === "initIfNeeded" || k.kind === "zeroed" ? k.struct : undefined;
        // Only struct accounts: their owner and type are checked, and they never shrink below the struct.
        if (!isWritable(acct.kind) || !struct) this.fail(args[0], "realloc needs a Mut<Struct> account of this program");
        if (struct?.vec) this.fail(args[0], `${struct.name} has a growable Vec, which sizes the account itself (push/pop/clear)`);
        const size = this.expect(this.expr(args[1], U64), U64, args[1]);
        const payer = this.accountParam(args[2], "the payer");
        if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(args[2], "the payer must be a Mut<Signer>");
        const min = struct ? `8 + sizeof(TSS_${struct.name})` : "0";
        this.line(`TS_TRY(ts_realloc(params, a_${payer.name}, a_${acct.name}, ${size.c}, entry_${acct.name}, ${min}));`);
        return undefined;
      }
      case "coreAssetOwner":
      case "coreAssetCollection": {
        // Read a Metaplex Core asset: its owner, or the collection it belongs to.
        if (args.length !== 1) this.fail(node, `${builtin}(asset) takes a Metaplex Core asset account`);
        const acct = this.anyAccount(args[0], "the asset");
        this.line(`TS_TRY(ts_core_asset(${acct}));`);
        const t = this.tmp("core");
        if (builtin === "coreAssetOwner") {
          this.line(`SolPubkey ${t};`);
          this.line(`ts_memcpy(&${t}, ${acct}->data + 1, 32);`);
          return { c: `(&${t})`, type: PUBKEY };
        }
        this.model.options.set("pubkey", PUBKEY);
        this.line(`${optC(PUBKEY)} ${t};`);
        this.line(`${t}.some = ${acct}->data[33] == 2 && ${acct}->data_len >= 66;`);
        this.line(`if (${t}.some) ts_memcpy(&${t}.v, ${acct}->data + 34, 32); else ts_memzero(&${t}.v, 32);`);
        return { c: t, type: { kind: "option", inner: PUBKEY } };
      }
      case "transferFee": {
        if (args.length !== 2) this.fail(node, "transferFee(mint, amount) takes the mint and the amount sent");
        const m = this.anyAccount(args[0], "the mint");
        this.line(`TS_TRY(ts_t22_layout(${m}, 1));`);
        const amt = this.expect(this.expr(args[1], U64), U64, args[1]);
        const t = this.tmp("fee");
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_t22_transfer_fee(${m}, ${amt.c}, &${t}));`);
        return { c: t, type: U64 };
      }
      case "transferFeeInverse": {
        if (args.length !== 2) this.fail(node, "transferFeeInverse(mint, amountReceived) takes the mint and the amount the recipient is to get");
        const m = this.anyAccount(args[0], "the mint");
        this.line(`TS_TRY(ts_t22_layout(${m}, 1));`);
        const amt = this.expect(this.expr(args[1], U64), U64, args[1]);
        const t = this.tmp("fee");
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_t22_transfer_fee_inverse(${m}, ${amt.c}, &${t}));`);
        return { c: t, type: U64 };
      }
      case "transferFeeBasisPoints":
      case "transferFeeMaximum": {
        if (args.length !== 1) this.fail(node, `${builtin}(mint) takes the mint`);
        const m = this.anyAccount(args[0], "the mint");
        this.line(`TS_TRY(ts_t22_layout(${m}, 1));`);
        const t = this.tmp("tf");
        this.line(`uint64_t ${t}b, ${t}m;`);
        this.line(`TS_TRY(ts_t22_epoch_fee(${m}, &${t}b, &${t}m));`);
        return builtin === "transferFeeBasisPoints" ? { c: `((uint16_t)${t}b)`, type: { kind: "int", name: "u16" } } : { c: `${t}m`, type: U64 };
      }
      case "extensionsWithin": {
        if (args.length !== 2 || !ts.isArrayLiteralExpression(args[1]))
          this.fail(node, "extensionsWithin(account, [types…]) takes a Token-2022 mint or account and a list of u16 extension types");
        const m = this.anyAccount(args[0], "the account");
        this.line(`TS_TRY(ts_t22_layout(${m}, 0));`);
        const types = args[1].elements.map((e) => this.expect(this.expr(e, { kind: "int", name: "u16" }), { kind: "int", name: "u16" }, e).c);
        const t = this.tmp("ext");
        this.line(`const uint16_t ${t}[${Math.max(types.length, 1)}] = {${types.join(", ")}};`);
        return { c: `ts_t22_extensions_within(${m}, ${t}, ${types.length})`, type: BOOL };
      }
      case "isTransferring": {
        // TransferHookAccount (15) on a Token-2022 token account: set only while Token-2022 runs a transfer of it.
        if (args.length !== 1) this.fail(node, "isTransferring(tokenAccount) takes the source token account");
        const m = this.anyAccount(args[0], "the token account");
        this.line(`TS_TRY(ts_t22_layout(${m}, 2));`);
        const off = this.tmp("eo");
        this.line(`uint64_t ${off}, ${off}l;`);
        return { c: `(ts_t22_ext(${m}, 15, &${off}, &${off}l) && ${off}l >= 1 && ${m}->data[${off}] != 0)`, type: BOOL };
      }
      case "transferHookProgram":
      case "transferHookAuthority":
      case "permanentDelegate":
      case "mintCloseAuthority": {
        // Token-2022 mint extensions holding an optional Pubkey: TransferHook (14, program at +32),
        // PermanentDelegate (12), MintCloseAuthority (3).
        if (args.length !== 1) this.fail(node, `${builtin}(mint) takes the mint`);
        const m = this.anyAccount(args[0], "the mint");
        this.line(`TS_TRY(ts_t22_layout(${m}, 1));`);
        const [type, field] =
          builtin === "transferHookProgram" ? [14, 32] : builtin === "transferHookAuthority" ? [14, 0] : builtin === "permanentDelegate" ? [12, 0] : [3, 0];
        this.model.options.set("pubkey", PUBKEY);
        const t = this.tmp("ext");
        this.line(`${optC(PUBKEY)} ${t};`);
        this.line(`${t}.some = ts_t22_key(${m}, ${type}, ${field}, &${t}.v);`);
        this.line(`if (!${t}.some) ts_memzero(&${t}.v, 32);`);
        return { c: t, type: { kind: "option", inner: PUBKEY } };
      }
      case "hasExtension": {
        if (args.length !== 2) this.fail(node, "hasExtension(account, extensionType) takes a Token-2022 mint or account and a u16 type");
        const m = this.anyAccount(args[0], "the account");
        this.line(`TS_TRY(ts_t22_layout(${m}, 0));`);
        const type = this.expect(this.expr(args[1], { kind: "int", name: "u16" }), { kind: "int", name: "u16" }, args[1]);
        const off = this.tmp("eo");
        this.line(`uint64_t ${off}, ${off}l;`);
        return { c: `ts_t22_ext(${m}, ${type.c}, &${off}, &${off}l)`, type: BOOL };
      }
      case "rentExempt": {
        if (args.length !== 1) this.fail(node, "rentExempt(space) takes the account size in bytes");
        const space = this.expect(this.expr(args[0], U64), U64, args[0]);
        const t = this.tmp();
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_minimum_balance(${space.c}, &${t}));`);
        return { c: t, type: U64 };
      }
      case "invoke":
        return this.invoke(node);
      case "invokeInstruction":
        return this.invokeInstruction(node);
      case "sha256":
      case "keccak256":
        return this.hashCall(node, builtin);
      case "merkleVerify": {
        if (args.length !== 3) this.fail(node, "merkleVerify(leaf, proof, root) takes three arguments");
        let leaf = this.expect(this.expr(args[0], HASH), HASH, args[0]);
        const proof = ts.isIdentifier(args[1]) ? this.lookup(args[1].text) : undefined;
        if (proof?.type.kind !== "vecArg" || !sameType(proof.type.elem, HASH)) this.fail(args[1], "the proof must be a Vec<Hash> instruction argument");
        const mark = this.lines.length;
        const root = this.expect(this.expr(args[2], HASH), HASH, args[2]);
        leaf = this.settle(leaf, mark);
        return { c: `ts_merkle_verify(${leaf.c}, ${proof.c}.ptr, ${proof.c}.len, ${root.c})`, type: BOOL };
      }
      case "verifyEd25519": {
        if (args.length !== 3) this.fail(node, "verifyEd25519(instructionsSysvar, signer, message) takes three arguments");
        const ixs = this.accountParam(args[0], "the instructions sysvar");
        if (ixs.kind.kind !== "instructionsSysvar") this.fail(args[0], "pass an InstructionsSysvar parameter");
        let signer = this.expect(this.expr(args[1], PUBKEY), PUBKEY, args[1]);
        const mark = this.lines.length;
        const msg = this.expr(args[2]);
        signer = this.settle(signer, mark);
        const m =
          msg.type.kind === "string"
            ? msg.c
            : msg.type.kind === "pubkey"
              ? `ts_str((const uint8_t *)(${msg.c}), 32)`
              : this.fail(args[2], "the message must be a string, Hash or Pubkey");
        return { c: `ts_ed25519_verified(a_${ixs.name}, ${signer.c}, ${m})`, type: BOOL };
      }
      case "ethMessageHash": {
        // EIP-191 personal_sign: keccak256("\x19Ethereum Signed Message:\n" + byte length + message).
        if (args.length !== 1) this.fail(node, "ethMessageHash(message) takes the signed text");
        const m = this.expect(this.expr(args[0], STRING), STRING, args[0]);
        const msg = this.tmp("em");
        const len = this.tmp("eml");
        const parts = this.tmp("emp");
        const out = this.tmp("h");
        this.line(`TS_Str ${msg} = ${m.c};`);
        this.line(`TS_Str ${len};`);
        this.line(`TS_TRY(ts_str_u64(${msg}.len, false, &${len}));`);
        this.line(
          `SolBytes ${parts}[3] = {{(uint8_t *)${cString("\x19Ethereum Signed Message:\n")}, 26}, {(uint8_t *)${len}.ptr, ${len}.len}, {(uint8_t *)${msg}.ptr, ${msg}.len}};`,
        );
        this.line(`SolPubkey ${out};`);
        this.line(`sol_keccak256(${parts}, 3, (uint8_t *)&${out});`);
        return { c: `(&${out})`, type: HASH };
      }
      case "verifySecp256k1": {
        if (args.length !== 5) this.fail(node, "verifySecp256k1(hash, recoveryId, r, s, ethAddress) takes five arguments");
        // For any public key a signature can be made up for *some* hash, so a hash taken from instruction data
        // proves nothing: the program must compute it from the message itself.
        const hashFn = ts.isCallExpression(args[0]) ? this.exportName(args[0].expression) : undefined;
        if (hashFn !== "keccak256" && hashFn !== "ethMessageHash")
          this.fail(
            args[0],
            "compute the signed hash here: verifySecp256k1(keccak256(...message), …) or verifySecp256k1(ethMessageHash(message), …); a hash passed in can be forged",
          );
        const [h, id, r, sv, eth] = this.lowerInOrder(args, [HASH, U8, HASH, HASH, HASH]);
        return { c: `ts_secp256k1_verify(${h.c}, (uint64_t)${id.c}, ${r.c}, ${sv.c}, ${eth.c})`, type: BOOL };
      }
      case "pythPrice": {
        if (args.length !== 3 && args.length !== 4) this.fail(node, "pythPrice(update, feedId, maxAgeSeconds, exponent?) takes three or four arguments");
        const u = this.accountParam(args[0], "the price update");
        if (u.kind.kind !== "pyth") this.fail(args[0], "pass a PythPriceUpdate parameter");
        const [feed, age, expo] = this.lowerInOrder(args.slice(1), [HASH, U64, I32]);
        const t = this.tmp("px");
        this.line(`int64_t ${t};`);
        this.line(`TS_TRY(ts_pyth_price(a_${u.name}, ${feed.c}, ${age.c}, ${expo ? `true, ${expo.c}` : "false, 0"}, &${t}));`);
        return { c: t, type: I64 };
      }
      case "switchboardValue": {
        // Anyone can create a Switchboard feed: like pythPrice's feed id, the expected feed address is required.
        if (args.length !== 4 && args.length !== 5)
          this.fail(node, "switchboardValue(feed, expectedFeed, maxStaleSlots, decimals, minSamples?) takes four or five arguments");
        const f = this.accountParam(args[0], "the feed");
        if (f.kind.kind !== "switchboard") this.fail(args[0], "pass a SwitchboardFeed parameter");
        const [expected, stale, dec, min] = this.lowerInOrder(args.slice(1), [PUBKEY, U64, U8, U8]);
        const t = this.tmp("sb");
        this.line(`int64_t ${t};`);
        this.line(`if (!ts_key_eq(&a_${f.name}->key, ${expected.c})) TS_FAIL(TS_ERR_ORACLE, "TypeSOL: not the expected Switchboard feed");`);
        this.line(`TS_TRY(ts_switchboard_value(a_${f.name}, ${stale.c}, ${dec.c}, ${min ? min.c : "1"}, &${t}));`);
        return { c: t, type: I64 };
      }
      case "associatedTokenAddress": {
        if (args.length !== 3) this.fail(node, "associatedTokenAddress(owner, mint, tokenProgram) takes three Pubkeys");
        const [o, m, tp] = this.lowerInOrder(args, [PUBKEY, PUBKEY, PUBKEY]);
        const t = this.tmp("ata");
        this.line(`SolPubkey ${t};`);
        this.line(`TS_TRY(ts_ata_address(${o.c}, ${m.c}, ${tp.c}, &${t}));`);
        return { c: `(&${t})`, type: PUBKEY };
      }
      case "programId":
        if (args.length !== 0) this.fail(node, "programId() takes no arguments");
        return { c: `params->program_id`, type: PUBKEY };
      case "findProgramAddressBump": {
        // Pubkey::find_program_address(seeds, program).1: the bump of the canonical PDA.
        if (args.length !== 2) this.fail(node, "findProgramAddressBump(seeds, program) takes the seeds and the program's address");
        const seeds = this.seeds(args[0]!, 0);
        const program = this.expect(this.expr(args[1], PUBKEY), PUBKEY, args[1]);
        const t = this.tmp("pda");
        const b = this.tmp("bump");
        this.line(`SolPubkey ${t}; uint8_t ${b};`);
        this.line(
          `if (ts_find_pda(${seeds.name}, ${seeds.count}, ${program.c}, &${t}, &${b}) != SUCCESS) TS_FAIL(TS_ERR_SEEDS, "TypeSOL: no program address for these seeds");`,
        );
        return { c: `((uint64_t)${b})`, type: { kind: "int", name: "u8" } };
      }
      case "initAccount": {
        // Anchor's AccountLoader::load_init on an account created in the body (system createAccount / allocate +
        // assign): owned by this program (3007), writable (3006), large enough (3003), discriminator still zero
        // (3000); then the discriminator is written and the struct is a mutable view of the data.
        const targ = node.typeArguments?.[0];
        const s = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
        if (!s || s.size === undefined || s.vec || s.layout === "borsh")
          this.fail(node, "initAccount<T>(account) takes a fixed-layout account struct of this program (no growable Vec, not @layout borsh)");
        if (args.length !== 1) this.fail(node, "initAccount<T>(account) takes one account");
        let h = this.handle(args[0]);
        if (!h) {
          const acct = this.accountParam(args[0], "the account");
          if (acct.kind.kind !== "info") this.fail(args[0], "initAccount<T>(account) takes a Mut<AccountInfo> parameter or a remaining account");
          h = `a_${acct.name}`;
        }
        this.model.accountStructs.add(s.name);
        this.line(`TS_TRY(ts_init_account(${h}, params->program_id, TS_DISC_${s.name}, sizeof(TSS_${s.name})));`);
        return { c: `((TSS_${s.name} *)(${h}->data + 8))`, type: { kind: "structRef", struct: s.name, writable: true } };
      }
      case "createProgramAddress": {
        // Pubkey::create_program_address(seeds, program): the bump is the last seed; null when the seeds give a point
        // on the curve (Rust's Err(PubkeyError::InvalidSeeds)) or are too many / too long.
        if (args.length !== 2) this.fail(node, "createProgramAddress(seeds, program) takes the seeds (bump last) and the program's address");
        const seeds = this.seeds(args[0]!, 0);
        const program = this.expect(this.expr(args[1], PUBKEY), PUBKEY, args[1]);
        const t = this.tmp("cpa");
        this.model.options.set("pubkey", PUBKEY);
        this.line(`${optC(PUBKEY)} ${t};`);
        this.line(`${t}.some = ts_create_pda_address(${seeds.name}, ${seeds.count}, ${program.c}, &${t}.v) == SUCCESS;`);
        return { c: t, type: { kind: "option", inner: PUBKEY } };
      }
      case "logBase64": {
        // msg!("{prefix}{base64 of the struct's bytes}"): a fixed-layout struct's bytes are its bincode / Borsh form
        // when it holds integers and Pubkeys only (Raydium's ray_log).
        if (args.length !== 2 || !ts.isStringLiteralLike(args[0]!)) this.fail(node, 'logBase64("prefix", value) takes a string literal and a struct value');
        const place = this.structPlace(args[1]!);
        if (!place) this.fail(args[1]!, "logBase64 logs a struct value (a local, a literal bound to a const, or account data)");
        const sd = this.model.structs.get(place.struct)!;
        if (sd.size === undefined || sd.vec || sd.fields.some((f) => !["int", "pubkey", "array"].includes(f.type.kind)))
          this.fail(args[1]!, `${sd.name} must hold only integers, Pubkeys and fixed arrays of them for its bytes to be its serialized form`);
        const prefix = (args[0] as ts.StringLiteralLike).text;
        this.line(`ts_log_base64(${cString(prefix)}, ${Buffer.byteLength(prefix)}, (const uint8_t *)${place.ptr}, sizeof(TSS_${sd.name}));`);
        return undefined;
      }
      case "findProgramAddressWithBump":
        this.fail(node, "bind both results where it is called: const [address, bump] = findProgramAddressWithBump(seeds, program)");
      case "findProgramAddress": {
        // Pubkey::find_program_address(seeds, program).0: the canonical PDA of any program.
        if (args.length !== 2) this.fail(node, "findProgramAddress(seeds, program) takes the seeds and the program's address");
        const seeds = this.seeds(args[0]!, 0);
        const program = this.expect(this.expr(args[1], PUBKEY), PUBKEY, args[1]);
        const t = this.tmp("pda");
        const b = this.tmp("bump");
        this.line(`SolPubkey ${t}; uint8_t ${b};`);
        this.line(
          `if (ts_find_pda(${seeds.name}, ${seeds.count}, ${program.c}, &${t}, &${b}) != SUCCESS) TS_FAIL(TS_ERR_SEEDS, "TypeSOL: no program address for these seeds");`,
        );
        return { c: `(&${t})`, type: PUBKEY };
      }
      case "metadataAddress":
      case "masterEditionAddress": {
        if (args.length !== 1) this.fail(node, `${builtin}(mint) takes the mint`);
        const m = this.expect(this.expr(args[0], PUBKEY), PUBKEY, args[0]);
        const t = this.tmp("md");
        this.line(`SolPubkey ${t};`);
        this.line(`TS_TRY(${builtin === "metadataAddress" ? "ts_metadata_address" : "ts_master_edition_address"}(${m.c}, &${t}));`);
        return { c: `(&${t})`, type: PUBKEY };
      }
      case "initExtraAccountMetas":
      case "updateExtraAccountMetas": {
        if (args.length !== 4 && args.length !== 5) this.fail(node, `${builtin}(payer, account, mint, systemProgram, extraAccounts?)`);
        const payer = this.accountParam(args[0], "the payer");
        if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(args[0], "the payer must be a Mut<Signer>");
        const acct = this.accountParam(args[1], "the extra-account-metas account");
        if (!isWritable(acct.kind)) this.fail(args[1], "the extra-account-metas account must be Mut<AccountInfo>");
        const mint = this.accountParam(args[2], "the mint");
        const sys = this.accountParam(args[3], "the system program");
        if (sys.kind.kind !== "system") this.fail(args[3], "pass the SystemProgram parameter");
        const { name: entries, count } = args[4] ? this.extraAccountMetas(args[4]) : { name: "NULL", count: 0 };
        const fn = builtin === "initExtraAccountMetas" ? "ts_init_extra_metas" : "ts_update_extra_metas";
        this.line(`TS_TRY(${fn}(params, a_${payer.name}, a_${acct.name}, &a_${mint.name}->key, ${entries}, ${count}));`);
        return undefined;
      }
      case "remainingAccounts":
        if (!this.ix) this.fail(node, "remainingAccounts() is only available in instructions; pass it to a helper that takes RemainingAccounts");
        return { c: String(this.ix.accounts.length), type: { kind: "remaining" } };
      case "readData":
        return this.readData(node);
      case "writeData":
        return this.writeData(node);
      case "resizeAccount": {
        if (args.length !== 2) this.fail(node, "resizeAccount(account, newSize) takes the account and its new size");
        // A remaining account (or a helper's RemainingAccount): its size when the instruction started is the one the
        // entrypoint recorded in the record's padding, as solana_program 1.14's entrypoint records it for realloc.
        const h = this.handle(args[0]!);
        if (h) {
          if (!this.nativeAccountWrites()) this.line(`TS_TRY(ts_check_writable(${h}));`);
          const size = this.expect(this.expr(args[1], U64), U64, args[1]);
          this.line(`TS_TRY(ts_resize_raw(${h}, ${size.c}, ts_entry_len(${h})));`);
          return undefined;
        }
        if (!this.ix) this.fail(node, "resizeAccount() is only available in instructions (or on a remaining account a helper was given)");
        const acct = this.accountParam(args[0], "resizeAccount's account");
        if (acct.kind.kind !== "info" || (!isWritable(acct.kind) && !this.nativeAccountWrites()))
          this.fail(args[0], "resizeAccount needs a Mut<AccountInfo> parameter or a remaining account");
        const size = this.expect(this.expr(args[1], U64), U64, args[1]);
        this.line(`TS_TRY(ts_resize_raw(a_${acct.name}, ${size.c}, entry_${acct.name}));`);
        return undefined;
      }
      case "closeRaw": {
        // Phoenix's Tombstone, in its order: receiver.lamports = receiver.lamports + account.lamports;
        // account.lamports = 0; account.assign(&system_program::id()); account.realloc(0, false). The data is not
        // zeroed (realloc's zero_init is false): the runtime drops it with the length, and then accepts the new owner.
        if (args.length !== 2) this.fail(node, "closeRaw(account, receiver) takes the account to close and the account that gets its lamports");
        const a = this.inPlaceAccount(args[0]!, "closeRaw's account", true);
        const r = this.inPlaceAccount(args[1]!, "closeRaw's receiver", false);
        // Closing an account into itself would burn its lamports (the runtime then refuses the instruction).
        if (!this.nativeAccountWrites()) this.line(`if (${a} == ${r}) TS_FAIL(TS_ERR_DUPLICATE_MUT, "TypeSOL: closeRaw's receiver is the account itself");`);
        const sum = this.tmp("sum");
        this.line(`uint64_t ${sum};`);
        this.line(`if (ts_add_overflow_u64(${r}->lamports, ${a}->lamports, &${sum})) TS_FAIL(TS_ERR_OVERFLOW, "TypeSOL: arithmetic overflow");`);
        this.line(`${r}->lamports = ${sum};`);
        this.line(`${a}->lamports = 0;`);
        this.line(`ts_memcpy(&${a}->owner, &TS_SYSTEM_PROGRAM_ID, 32);`);
        this.line(`${a}->data_len = 0;`);
        return undefined;
      }
      case "assignOwner": {
        // AccountInfo::assign: the owner field written in place; the runtime accepts it at the end of the instruction
        // (or at a CPI) only for an account of this program that is writable and whose data is empty or zeroed.
        if (args.length !== 2) this.fail(node, "assignOwner(account, owner) takes the account and its new owner's address");
        const a = this.inPlaceAccount(args[0]!, "assignOwner's account", true);
        const owner = this.expect(this.expr(args[1], PUBKEY), PUBKEY, args[1]);
        this.line(`ts_memcpy(&${a}->owner, ${owner.c}, 32);`);
        return undefined;
      }
      case "bigEndian":
        this.fail(node, "bigEndian(value) is a PDA seed: use it inside a seeds list");
      case "loadAccount":
      case "loadAccountMut":
      case "loadRaw":
      case "loadRawMut":
      case "loadForeign":
      case "loadBorsh":
        this.fail(node, `bind ${builtin}<T>(...) to a const first: const p = ${builtin}<T>(account)`);
      case "loadRawAt":
      case "loadRawMutAt":
      case "rawArrayAt":
      case "rawArrayMutAt":
      case "rbTreeAt":
      case "rbTreeMutAt":
        this.fail(node, `bind ${builtin}(…) to a const first: const v = ${builtin}<…>(account, offset${builtin.startsWith("load") ? "" : ", capacity"})`);
      case "storeBorsh":
        return this.storeBorsh(node);
      case "emit":
        return this.emitEvent(node);
      case "emitCpi": {
        // Anchor emit_cpi!: the event goes into a self-CPI's instruction data (not truncated like logs).
        if (!this.ix) this.fail(node, "emitCpi() is only available in instructions");
        if (args.length !== 3) this.fail(node, "emitCpi<T>({ ... }, eventAuthority, self) takes the event, the EventAuthority and the SelfProgram parameters");
        const auth = this.accountParam(args[1], "the event authority");
        if (auth.kind.kind !== "eventAuthority") this.fail(args[1], "pass the EventAuthority parameter");
        const self = this.accountParam(args[2], "this program");
        if (self.kind.kind !== "selfProgram") this.fail(args[2], "pass the SelfProgram parameter");
        return this.emitEvent(node, { authority: auth.name, program: self.name });
      }
      case "returnData":
        return this.returnData(node);
      case "setReturnData": {
        // Rust's set_return_data(&bytes): the bytes as they are. More than 1024 is left to the syscall, which refuses
        // it exactly as it refuses the original's call.
        if (args.length !== 1) this.fail(node, "setReturnData(bytes) takes one list of u8");
        if (this.ix?.returns)
          this.fail(
            node,
            `${this.ix.name} returns a value, which is its return data: return it instead of calling setReturnData (or declare the instruction void)`,
          );
        const what = "setReturnData takes a list of u8: a local FixedVec<u8, N>, a Vec or FixedVec in account data, or the instruction data or a slice of it";
        const s = this.listSpan(args[0]!) ?? this.fail(args[0]!, what);
        if (s.elem.kind !== "int" || s.elem.name !== "u8") this.fail(args[0]!, what);
        this.line(`sol_set_return_data((const uint8_t *)${s.items}, ${s.count});`);
        return undefined;
      }
      case "logComputeUnits": {
        if (args.length) this.fail(node, "logComputeUnits() takes no arguments");
        this.line(`sol_log_compute_units();`);
        return undefined;
      }
      case "programAt":
      case "sysvarAt":
        return this.programAt(node, builtin);
      case "instructionData":
        this.fail(node, "bind the data to a local first: const data = instructionData()");
      case "fixedArray":
        this.fail(node, "fixedArray<T, N>(fill) is only allowed as a local declaration: const xs = fixedArray<u64, 4>(0n)");
      case "readonly":
      case "writable":
      case "readonlySigner":
      case "writableSigner":
        this.fail(node, `${builtin}() is only valid inside the accounts list of invoke()`);
      case "sighash":
      case "hex":
        this.fail(node, `${builtin}() is only valid inside the data list of invoke()`);
      case "named":
        this.fail(node, "named(account, address) is only valid as a Stake CPI's sysvar or stake config argument");
    }
    if (builtin) this.fail(callee, `${builtin} cannot be called here`);

    // `adder(5n)(1n)`: the function a function returns, called right away.
    if (ts.isCallExpression(callee)) {
      const made = this.madeFunction(callee);
      if (made) return this.expandClosure(made, node.arguments, node);
    }
    if (ts.isIdentifier(callee)) {
      const local = this.lookup(callee.text);
      if (local?.closure && this.returnedFunction(local.closure.node))
        this.fail(node, `${callee.text} returns a function: bind it (const f = ${callee.text}(…)) or call it right away (${callee.text}(…)(…))`);
      if (local?.closure) return this.expandClosure(local.closure, node.arguments, node);
      if (local?.choice) return this.callChoice(local.choice, node.arguments, node);
      const name = calleeName(callee, this.model.helperDecls, this.checker) ?? callee.text;
      if (!local && this.model.factories.has(name))
        this.fail(node, `${callee.text} returns a function: bind it (const f = ${callee.text}(…)) or call it right away (${callee.text}(…)(…))`);
    }
    const inlined = this.helperWithClosure(node);
    if (inlined) return inlined.value;
    const helper = this.helperOf(node);
    if (helper) return this.callHelper(node, helper);

    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      // A RedBlackTree's methods (rbTreeAt / rbTreeMutAt).
      const onTree = this.treeCall(node);
      if (onTree) return onTree.value;
      const introspected = this.instructionsCall(node, callee, method);
      if (introspected) return introspected;
      // xs.some(…) and friends on a Vec, FixedArray, FixedVec or Vec argument: a loop with the callback expanded in it.
      if (LIST_METHODS.has(method)) {
        const l = ts.isIdentifier(callee.expression) ? this.lookup(callee.expression.text) : undefined;
        if (
          l?.type.kind === "vecArg" ||
          l?.type.kind === "array" ||
          this.isPipeline(callee.expression) ||
          this.peekArray(callee.expression) ||
          this.isVecArgView(callee.expression) ||
          this.isInlineArray(callee.expression)
        )
          return this.listMethod(node, method);
      }
      // A map / filter chain is consumed by a list method, `.length` or for…of, or stored: const ys = xs.map(…).
      if (this.isPipeline(node))
        this.fail(node, `${method} builds a new list: store it (const ys = xs.${method}(…)), or use it right away with a list method, .length or for…of`);
      // Vec<T> instruction arguments (and the instruction data) are read-only views; slice gives another one.
      if (this.isVecArgView(callee.expression)) {
        if (method === "slice") return this.vecArgView(node);
        const l = this.vecArgView(callee.expression)!;
        {
          // Bytes (instruction data, a Vec<u8> argument): little-endian reads at a byte offset, bounds-checked (5104).
          const le: Record<string, [string, number, Value["type"]]> = {
            readU8: ["uint8_t", 1, U8],
            readU16: ["uint16_t", 2, { kind: "int", name: "u16" }],
            readU32: ["uint32_t", 4, { kind: "int", name: "u32" }],
            readU64: ["uint64_t", 8, U64],
            readU128: ["__uint128_t", 16, { kind: "int", name: "u128" }],
            readPubkey: ["SolPubkey", 32, PUBKEY],
          };
          if (le[method] && l.type.elem.kind === "int" && l.type.elem.name === "u8") {
            if (args.length !== 1) this.fail(node, `${method}(offset) takes the byte offset`);
            const [c, size, type] = le[method]!;
            const off = this.tmp("off");
            this.line(`uint64_t ${off} = ${this.expect(this.expr(args[0], U64), U64, args[0]).c};`);
            this.line(
              `if (${off} > (uint64_t)${l.c}.len || (uint64_t)${l.c}.len - ${off} < ${size}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: read past the end of the bytes");`,
            );
            const t = this.tmp("rd");
            this.line(`${c} ${t};`);
            this.line(`ts_memcpy(&${t}, ${l.c}.ptr + ${off}, ${size});`);
            return type.kind === "pubkey" ? { c: `(&${t})`, type } : { c: t, type };
          }
          if (method !== "get" || args.length !== 1)
            this.fail(node, "Vec arguments are read-only: use .get(i), .length, and on bytes readU8/U16/U32/U64/U128/readPubkey(offset)");
          const elem = l.type.elem;
          if (elem.kind === "string") {
            const idx = this.index(args[0], `(uint64_t)${l.c}.len`);
            return { c: `(((const TS_Str *)${l.c}.ptr)[${idx}])`, type: STRING };
          }
          if (!isScalar(elem))
            this.fail(node, `read a field of the element: ${ts.isIdentifier(callee.expression) ? callee.expression.text : "list"}.get(i).field`);
          const idx = this.index(args[0], `(uint64_t)${l.c}.len`);
          const t = this.tmp("el");
          this.line(`${scalarStorageC(elem)} ${t};`);
          this.line(`ts_memcpy(&${t}, ${l.c}.ptr + ${idx} * ${scalarSize(elem)}, ${scalarSize(elem)});`);
          if (elem.kind === "pubkey") return { c: `(&${t})`, type: elem };
          if (elem.kind === "bool") {
            this.line(`if (${t} > 1) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid bool in Vec argument");`);
            return { c: `(${t} != 0)`, type: elem };
          }
          if (elem.kind === "enum")
            this.line(
              `if (${t} >= ${this.model.enums.get(elem.name)!.variants.length}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: invalid enum in Vec argument");`,
            );
          return { c: t, type: elem };
        }
      }
      // Vec<T> fields in account data
      const vecRef = this.ref(callee.expression);
      if (vecRef?.type.kind === "vec") return this.vecMethod(node, method, vecRef);
      // Array methods
      const arr = vecRef ?? this.ref(callee.expression);
      if (arr?.type.kind === "array") {
        if (method === "set") {
          if (args.length !== 2) this.fail(node, "set(index, value) takes two arguments");
          if (!arr.writable) this.fail(node, this.readOnly(arr));
          const idx = this.index(args[0], arr.type.len);
          const el: Ref = { ...arr, lv: `${arr.lv}[${idx}]`, type: arr.type.elem };
          const vt = this.storageValueType(el.type);
          if (!vt) {
            this.assertNotAliased(
              this.pathsOf(callee.expression)?.map((p) => `${p}[]`),
              node,
            );
            this.writeAggregate(el, args[1]);
            return undefined;
          }
          const v = this.expect(this.expr(args[1], vt), vt, args[1]);
          this.line(this.writeStorage(el, v.c) + ";");
          return undefined;
        }
        if (method !== "get") this.fail(node, `arrays support get(i), set(i, v) and .length, not ${method}()`);
      }
      if (method === "compare") {
        // Pubkey.compare: Rust's Ord on [u8; 32] (lexicographic bytes), as -1, 0 or 1.
        if (args.length !== 1) this.fail(node, "compare() takes one argument");
        const left = this.expr(callee.expression);
        if (left.type.kind !== "pubkey") this.fail(callee.expression, "compare() orders Pubkeys or Hashes");
        const mark = this.lines.length;
        const right = this.expect(this.expr(args[0], left.type), left.type, args[0]);
        return { c: `ts_key_cmp(${this.settle(left, mark).c}, ${right.c})`, type: { kind: "int", name: "i64" } };
      }
      if (method === "equals") {
        if (args.length !== 1) this.fail(node, "equals() takes one argument");
        // Pubkey.equals and Hash.equals (both 32 bytes, but not interchangeable).
        const left = this.expr(callee.expression);
        if (left.type.kind !== "pubkey") this.fail(callee.expression, "equals() compares Pubkeys or Hashes");
        const mark = this.lines.length;
        const right = this.expect(this.expr(args[0], left.type), left.type, args[0]);
        return { c: `ts_key_eq(${this.settle(left, mark).c}, ${right.c})`, type: BOOL };
      }
      const at = this.programAtValue(callee.expression);
      if (at) return this.programAtMethod(node, at, method);
      if (this.accountAt(callee.expression)) {
        const target = this.accountAt(callee.expression);
        // Program accounts used through their methods (systemProgram.transfer, tokenProgram.*…) may be optional.
        if (target?.optional) this.assertUsable(target, callee.expression);
        if (
          (target?.kind.kind === "token" || target?.kind.kind === "mint") &&
          target.kind.init &&
          method === (target.kind.init === "create" ? "create" : "createIfNeeded")
        )
          return target.kind.kind === "token" && target.constraints.ata ? this.createAta(node, target, topLevel)! : this.createToken(node, target, topLevel);
        if (target?.kind.kind === "init" && method === "create") return this.create(node, target, topLevel);
        if (target?.kind.kind === "migrate" && method === "migrate") return this.migrate(node, target, topLevel);
        if (target?.kind.kind === "initIfNeeded" && method === "createIfNeeded") return this.create(node, target, topLevel, true);
        if (target?.kind.kind === "system" && method === "transfer") return this.systemTransfer(node);
        if (target?.kind.kind === "system" && method === "createAccount") return this.createAccount(node, this.programParam(target));
        if (target?.kind.kind === "system" && method === "createPda") return this.createPda(node);
        if (target?.kind.kind === "system" && (method === "allocate" || method === "assign"))
          return this.allocateOrAssign(node, this.programParam(target), method);
        if (target?.kind.kind === "tokenProgram") return this.tokenOp(node, this.programParam(target), method);
        if (target?.kind.kind === "ataProgram") return this.ataOp(node, this.programParam(target), method);
        if (target?.kind.kind === "memoProgram") return this.memoOp(node, this.programParam(target), method);
        if (target?.kind.kind === "stakeHistory") return this.stakeHistoryRead(node, `a_${target.name}`, method);
        if (target?.kind.kind === "sbRandomness") {
          if (method !== "value" && method !== "valueU64") this.fail(callee.name, "SwitchboardRandomness has value() and valueU64()");
          if (args.length) this.fail(node, `${method}() takes no arguments`);
          const t = this.tmp("rand");
          this.line(`const uint8_t *${t};`);
          this.line(`TS_TRY(ts_sb_randomness_value(a_${target.name}, &${t}));`);
          return method === "value" ? { c: `((const SolPubkey *)${t})`, type: HASH } : { c: `ts_read_le(${t}, 8)`, type: U64 };
        }
        if (target?.kind.kind === "stakeProgram") return this.stakeOp(node, this.programParam(target), method);
        if (target?.kind.kind === "metadataProgram") return this.metadataOp(node, target, method);
        // Each Metaplex CPI in its own C block: its data buffer's stack slot is reused by the next one.
        if (target?.kind.kind === "coreProgram" || target?.kind.kind === "bubblegumProgram") {
          const t = target;
          this.line("{");
          this.block(() => (t.kind.kind === "coreProgram" ? this.coreOp(node, t, method) : this.bubblegumOp(node, t, method)));
          this.line("}");
          return undefined;
        }
      }
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isCallExpression(callee.expression) && this.exportName(callee.expression.expression) === "fixedArray")
      this.fail(callee.expression, "fixedArray<T, N>(fill) is only allowed as a local declaration: const xs = fixedArray<u64, 4>(0n)");
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "slice" && this.isRemaining(callee.expression))
      this.fail(node, "rest.slice(a, b) is only for spreading into a CPI's accounts: invoke(p, [..., ...readonly(rest.slice(a, b))], data)");
    this.fail(node, this.unsupportedCall(callee));
  }

  /** "unsupported call" naming the callee, with the TypeSOL form of common JavaScript calls. */
  private unsupportedCall(callee: ts.Expression): string {
    const text = callee.getText();
    const hints: Record<string, string> = {
      "console.log": "log(…)",
      "Math.min": "min(a, b)",
      "Math.max": "max(a, b)",
      "Date.now": "now() (the Clock's unix timestamp)",
      "JSON.stringify": "log(…) with the values",
      Number: "u64(x) or another integer cast",
      BigInt: "u64(x) or another integer cast",
      String: "a FixedString<N> field, or log(…)",
    };
    const hint = hints[text];
    if (hint) return `unsupported call: ${text}; use ${hint}`;
    if (ts.isPropertyAccessExpression(callee) && this.accountAt(callee.expression))
      return `unsupported call: the account ${callee.expression.getText()} has no method ${callee.name.text}`;
    return `unsupported call: ${text.length > 60 ? `${text.slice(0, 57)}…` : text}`;
  }

  protected vecMethod(node: ts.CallExpression, method: string, v: Ref): Value | undefined {
    const args = node.arguments;
    const vt = v.type as FieldType & { kind: "vec" };
    const info = v.vec!;
    const elemRef = (idx: string): Ref => this.withFixedVec({ ...v, lv: `${info.items}[${idx}]`, type: vt.elem, vec: undefined, path: undefined });
    const count = vecCount(info);
    /**
     * Evaluate the value into a temporary first (JS evaluates arguments before the call runs), then return a
     * writer for the element: `push(v.length)` sees the old length, `set(i, pop())` checks i after the pop.
     */
    const stageElem = (valueNode: ts.Expression): ((el: Ref) => void) => {
      const st = this.storageValueType(vt.elem);
      const t = this.tmp("elv");
      if (!st) {
        this.line(`${fieldC(vt.elem)} ${t};`);
        this.writeAggregate({ lv: t, type: vt.elem, writable: true }, valueNode);
        return (el) => this.line(`ts_memcpy(&${el.lv}, &${t}, sizeof(${t}));`);
      }
      const val = this.ownedString(this.expect(this.expr(valueNode, st), st, valueNode));
      if (st.kind === "pubkey") this.line(`SolPubkey ${t} = *(${val.c});`);
      else this.line(`${valueC(st)} ${t} = ${val.c};`);
      const c = st.kind === "pubkey" ? `(&${t})` : t;
      return (el) => this.line(this.writeStorage(el, c) + ";");
    };
    const needWritable = () => {
      if (!v.writable) this.fail(node, this.readOnly(v));
    };
    // Elements removed or replaced here must not be referenced afterwards.
    const elemPaths = () => (ts.isPropertyAccessExpression(node.expression) ? this.pathsOf(node.expression.expression)?.map((p) => `${p}[]`) : undefined);
    const resize = (newLen: string, payer: string) => {
      if (info.cap !== undefined || info.heap) return; // a FixedVec has its room already; a heap Vec is not in the account
      if (!info.resizable || !v.account) this.fail(node, "only Vecs of Mut<...> / Init<...> accounts can grow or shrink");
      this.line(`TS_TRY(ts_resize(params, ${payer}, a_${v.account.name}, 8 + ${info.fixed} + (${newLen}) * ${info.elemSize}, entry_${v.account.name}));`);
    };
    if (BYTE_METHODS.has(method)) return this.byteListMethod(node, method, v);
    if (info.big !== undefined) {
      const done = this.bigVecMethod(node, method, v, { stageElem, needWritable, elemPaths });
      if (done) return done.value;
    }
    /**
     * The growable Vecs stored after this one move by `by` bytes (+ grows, - shrinks): where they start and how many
     * bytes they take, read before the resize; references into them cannot outlive this call.
     */
    const tail = info.tail;
    const tailStart = () => {
      if (!tail) return undefined;
      this.assertNotAliased(tail.paths, node);
      const at = this.tmp("tail");
      const n = this.tmp("tail_n");
      this.line(`uint8_t *${at} = ${tail.end};`);
      this.line(`uint64_t ${n} = (uint64_t)(${tail.dataEnd} - ${at});`);
      return { at, n };
    };
    switch (method) {
      case "pushAll": {
        // Every element of another list appended in one copy (a memcpy, not a loop of pushes).
        if (info.cap === undefined || info.heap)
          this.fail(node, "pushAll(items) appends to a FixedVec; a Vec grows one push(value) at a time (for (const x of items) list.push(x, …))");
        if (args.length !== 1) this.fail(node, "pushAll(items) takes the list to append");
        needWritable();
        const src = this.bulkSource(args[0]!, vt.elem);
        const n = this.tmp("n");
        const k = this.tmp("k");
        this.line(`uint64_t ${n} = ${count};`);
        this.line(`uint64_t ${k} = ${src.count};`);
        this.line(`if (${k} > ${info.cap} - ${n}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: pushAll() past the FixedVec's room");`);
        this.line(`ts_memcpy_bulk((uint8_t *)${info.items} + ${n} * ${info.elemSize}, (const uint8_t *)${src.items}, ${k} * ${info.elemSize});`);
        this.line(`${info.len} = (uint32_t)(${n} + ${k});`);
        return undefined;
      }
      case "set": {
        if (args.length !== 2) this.fail(node, "set(index, value) takes two arguments");
        needWritable();
        if (!this.storageValueType(vt.elem)) this.assertNotAliased(elemPaths(), node);
        const i = this.indexValue(args[0]);
        const write = stageElem(args[1]);
        this.checkIndex(i, count);
        write(elemRef(i));
        return undefined;
      }
      case "push": {
        if (info.heap) {
          // A Vec in a @layout borsh account: room on the heap, which may move the elements (no references may
          // outlive it); the account bounds the list when it is written back (3004), as under Anchor.
          if (args.length !== 1) this.fail(node, "push(value) on a Vec of a @layout borsh account takes the value only (the account is resized by realloc)");
          needWritable();
          this.assertNotAliased(elemPaths(), node);
          const write = stageElem(args[0]);
          const n = this.tmp("n");
          this.line(`uint64_t ${n} = (uint64_t)${info.len};`);
          this.line(`TS_TRY(ts_hvec_reserve(&${info.len.replace(/\.len$/, "")}, ${n} + 1, ${info.elemSize}));`);
          this.line(`${info.len} = (uint32_t)(${n} + 1);`);
          write(elemRef(n));
          return undefined;
        }
        if (info.cap !== undefined) {
          if (args.length !== 1) this.fail(node, "push(value) on a FixedVec takes the value (it has room for its capacity already)");
          needWritable();
          const write = stageElem(args[0]);
          const n = this.tmp("n");
          this.line(`uint64_t ${n} = ${count};`);
          this.line(`if (${n} >= ${info.cap}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: push() on a full FixedVec");`);
          this.line(`${info.len} = (uint32_t)(${n} + 1);`);
          write(elemRef(n));
          return undefined;
        }
        if (args.length !== 2) this.fail(node, "push(value, payer) takes the value and a Mut<Signer> that pays for the extra rent");
        needWritable();
        const payer = this.accountParam(args[1], "the payer");
        if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(args[1], "the payer must be a Mut<Signer>");
        const write = stageElem(args[0]);
        const n = this.tmp("n");
        this.line(`uint64_t ${n} = (uint64_t)${info.len};`);
        const t = tailStart();
        // Resizing does not move the data, so element pointers stay valid; the Vecs after this one shift up.
        resize(`${n} + 1`, `a_${payer.name}`);
        if (t) this.line(`ts_memmove(${t.at} + ${info.elemSize}, ${t.at}, ${t.n});`);
        this.line(`${info.len} = (uint32_t)(${n} + 1);`);
        write(elemRef(n));
        return undefined;
      }
      case "pop": {
        if (args.length !== 0) this.fail(node, "pop() takes no arguments");
        needWritable();
        this.assertNotAliased(elemPaths(), node);
        const st = this.storageValueType(vt.elem);
        const n = this.tmp("n");
        this.line(`uint64_t ${n} = ${count};`);
        this.line(`if (${n} == 0) TS_FAIL(TS_ERR_INDEX, "TypeSOL: pop() on an empty Vec");`);
        // Structs and arrays are dropped (pop() as a statement); read .get(length - 1) first to keep one.
        let result: Value | undefined;
        if (st) {
          const out = this.tmp("popped");
          const val = this.readStorage(elemRef(`${n} - 1`), node);
          if (st.kind === "pubkey") this.line(`SolPubkey ${out} = *(${val.c});`);
          else if (st.kind === "string") {
            // The bytes are about to be cut off: copy them to the heap first.
            this.line(`TS_Str ${out};`);
            this.line(`TS_TRY(ts_str_copy(${val.c}, &${out}));`);
          } else this.line(`${valueC(st)} ${out} = ${val.c};`);
          result = st.kind === "pubkey" ? { c: `(&${out})`, type: st } : { c: out, type: st };
        }
        const t = info.cap === undefined && !info.heap ? tailStart() : undefined;
        if (t) this.line(`ts_memmove(${t.at} - ${info.elemSize}, ${t.at}, ${t.n});`);
        this.line(`${info.len} = (uint32_t)(${n} - 1);`);
        resize(`${n} - 1`, "NULL");
        return result;
      }
      case "clear": {
        if (args.length !== 0) this.fail(node, "clear() takes no arguments");
        needWritable();
        this.assertNotAliased(elemPaths(), node);
        const t = info.cap === undefined && !info.heap ? tailStart() : undefined;
        if (t) this.line(`ts_memmove((uint8_t *)${info.items}, ${t.at}, ${t.n});`);
        this.line(`${info.len} = 0;`);
        resize("0", "NULL");
        return undefined;
      }
    }
    this.fail(node, `Vecs support get, set, push, pop, clear and .length, not ${method}()`);
  }

  /**
   * The methods a BigVec adds or changes (SPL's big_vec): `push` into the account's room, `retain`, and the refusals;
   * undefined for the methods it shares with other lists (`set`).
   */
  private bigVecMethod(
    node: ts.CallExpression,
    method: string,
    v: Ref,
    h: { stageElem: (n: ts.Expression) => (el: Ref) => void; needWritable: () => void; elemPaths: () => string[] | undefined },
  ): { value: Value | undefined } | undefined {
    const args = node.arguments;
    const info = v.vec!;
    const vt = v.type as FieldType & { kind: "vec" };
    if (method === "set") return undefined;
    if (info.raw)
      this.fail(node, `a RawArray has get, set, .length, for … of and the list methods (its length is the capacity it was made with), not ${method}()`);
    if (method === "slice")
      this.fail(node, "use slice(start, end) right where it is read: for (const x of list.slice(a, b)), list.slice(a, b).forEach(…) or .get(i)");
    if (info.slice) this.fail(node, `a slice has get, set, .length, for … of and the list methods; call ${method}() on the BigVec itself`);
    switch (method) {
      case "push": {
        // BigVec::push: the element goes after the last one if the account has room for it, else AccountDataTooSmall.
        if (args.length !== 1) this.fail(node, "push(value) on a BigVec takes the value (its room is the account's, never resized)");
        h.needWritable();
        const write = h.stageElem(args[0]!);
        const n = this.tmp("n");
        this.line(`uint64_t ${n} = (uint64_t)${info.len};`);
        this.line(`if (${n} >= ${info.big}) ${this.programErrorFail("AccountDataTooSmall", node)};`);
        this.line(`${info.len} = (uint32_t)(${n} + 1);`);
        write(this.withFixedVec({ ...v, lv: `${info.items}[${n}]`, type: vt.elem, vec: undefined, path: undefined }));
        return { value: undefined };
      }
      case "retain": {
        // BigVec::retain: one pass, the predicate reading each element where it was; each run of kept elements moves
        // down once (sol_memmove), when the next removal (or the end) is found. Bytes past the new end keep what they held.
        if (args.length !== 1) this.fail(node, "retain(fn) takes one argument: (x) => keep it");
        const cb = args[0]!;
        if (!ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb)) this.fail(cb, "pass retain an arrow function written here: xs.retain((x) => …)");
        if (cb.parameters.length > 1) this.fail(cb.parameters[1]!, "retain's callback takes the element");
        h.needWritable();
        this.assertNotAliased(h.elemPaths(), node);
        const size = info.elemSize;
        if (vt.elem.kind === "struct") return this.retainStructs(node, cb, v, vt.elem.name, size);
        const items = this.tmp("rt_items");
        const n = this.tmp("rt_n");
        const removed = this.tmp("rt_removed");
        const dst = this.tmp("rt_dst");
        const i = this.tmp("rt_i");
        const move = (count: string) => `sol_memmove_(${items} + ${dst} * ${size}, ${items} + (${dst} + ${removed}) * ${size}, (${count}) * ${size});`;
        this.line(`{`);
        this.block(() => {
          this.line(`uint8_t *${items} = (uint8_t *)${info.items};`);
          this.line(`uint64_t ${n} = ${vecCount(info)}, ${removed} = 0, ${dst} = 0;`);
          this.line(`for (uint64_t ${i} = 0; ${i} < ${n}; ${i}++) {`);
          this.block(() => {
            const f = ts.factory;
            const place = <T extends ts.Node>(x: T): T => {
              ts.setTextRange(x, node);
              (x as { parent?: ts.Node }).parent = node;
              return x;
            };
            const index = `__rt${this.temp++}`;
            this.scopes.at(-1)!.set(index, { c: i, type: U64, mutable: false });
            const list = (node.expression as ts.PropertyAccessExpression).expression;
            const element = place(f.createCallExpression(place(f.createPropertyAccessExpression(list, "get")), undefined, [place(f.createIdentifier(index))]));
            const closure: Closure = { node: cb, name: "retain's callback", scopes: [...this.scopes], env: this.envNow(), imports: this.scope.imports };
            const kept = this.expandClosure(closure, [element].slice(0, cb.parameters.length), cb);
            if (!kept) this.fail(cb, "retain's callback returns a boolean: true keeps the element");
            const b = this.expect(kept, BOOL, cb);
            this.line(`if (!(${b.c})) {`);
            this.line(`  if (${removed} > 0 && ${i} - ${removed} > ${dst}) ${move(`${i} - ${removed} - ${dst}`)}`);
            this.line(`  ${dst} = ${i} - ${removed};`);
            this.line(`  ${removed}++;`);
            this.line(`}`);
          });
          this.line(`}`);
          this.line(`if (${removed} > 0 && ${n} - ${removed} > ${dst}) ${move(`${n} - ${removed} - ${dst}`)}`);
          this.line(`${info.len} = (uint32_t)(${n} - ${removed});`);
        });
        this.line(`}`);
        return { value: undefined };
      }
      case "pop":
      case "clear":
        this.fail(node, `a BigVec has push and retain (as SPL's big_vec), not ${method}(): remove elements with retain((x) => …)`);
    }
    this.fail(node, `a BigVec supports get, set, push, retain, slice, find / findIndex and the other list methods, .length and .capacity, not ${method}()`);
  }

  /**
   * BigVec::retain over struct elements, walked with a pointer: the predicate gets each element in place, a kept one
   * costs its predicate and the step. `run` is the first element not yet moved (the run of kept ones since the last
   * removal), `dst` where that run goes; each run moves down once, when the next removal (or the end) is found, and
   * only once something before it was removed. The length is written once, at the end (the moves never reach it).
   */
  private retainStructs(node: ts.CallExpression, cb: ts.ArrowFunction | ts.FunctionExpression, v: Ref, struct: string, size: number): { value: undefined } {
    const info = v.vec!;
    const items = this.tmp("rt_items");
    const end = this.tmp("rt_end");
    const run = this.tmp("rt_run");
    const dst = this.tmp("rt_dst");
    const p = this.tmp("rt_p");
    this.line(`{`);
    this.block(() => {
      this.line(`uint8_t *${items} = (uint8_t *)${info.items};`);
      this.line(`uint8_t *${end} = ${items} + ${vecCount(info)} * ${size}, *${run} = ${items}, *${dst} = ${items};`);
      this.line(`for (uint8_t *${p} = ${items}; ${p} < ${end}; ${p} += ${size}) {`);
      this.block(() => {
        const el = this.tmp("rt_el");
        this.line(`TSS_${struct} *${el} = (TSS_${struct} *)${p};`);
        const list = (node.expression as ts.PropertyAccessExpression).expression;
        const id = ts.factory.createIdentifier(`__rt${this.temp++}`);
        ts.setTextRange(id, node);
        (id as { parent?: ts.Node }).parent = node;
        // The element as list.get(i) gives it: a reference into the list, with the list's aliasing paths.
        this.scopes.at(-1)!.set(id.text, {
          c: el,
          type: { kind: "structRef", struct, writable: !!v.writable },
          mutable: false,
          paths: this.pathsOf(list)?.map((x) => `${x}[]`),
        });
        const closure: Closure = { node: cb, name: "retain's callback", scopes: [...this.scopes], env: this.envNow(), imports: this.scope.imports };
        const kept = this.expandClosure(closure, [id].slice(0, cb.parameters.length), cb);
        if (!kept) this.fail(cb, "retain's callback returns a boolean: true keeps the element");
        const b = this.expect(kept, BOOL, cb);
        const at = this.tmp("rt_at");
        this.line(`if (!(${b.c})) {`);
        // The removal's own copy of the position, so the scan loop keeps a single pointer (see ts_opaque_ptr).
        this.line(`  uint8_t *${at} = ts_opaque_ptr(${p});`);
        this.line(`  if (${dst} != ${run} && ${at} != ${run}) sol_memmove_(${dst}, ${run}, ${at} - ${run});`);
        this.line(`  ${dst} += ${at} - ${run};`);
        this.line(`  ${run} = ${at} + ${size};`);
        this.line(`}`);
      });
      this.line(`}`);
      this.line(`if (${dst} != ${run} && ${end} != ${run}) sol_memmove_(${dst}, ${run}, ${end} - ${run});`);
      this.line(`${info.len} = (uint32_t)((uint64_t)(${dst} + (${end} - ${run}) - ${items}) / ${size});`);
    });
    this.line(`}`);
    return { value: undefined };
  }

  /** sha256(...) / keccak256(...) over strings, Pubkeys, Hashes, integers (LE) and booleans. */
  protected hashCall(node: ts.CallExpression, fn: "sha256" | "keccak256"): Value {
    if (node.arguments.length === 0 || node.arguments.length > 16) this.fail(node, `${fn}(...parts) takes 1..16 parts`);
    const parts: string[] = [];
    const values: Value[] = [];
    for (const a of node.arguments) {
      const mark = this.lines.length;
      const v = this.expr(a);
      for (let j = 0; j < values.length; j++) values[j] = this.settle(values[j], mark);
      values.push(v.literal !== undefined ? this.literal(v.literal, U64, a) : v);
    }
    for (const [i, a] of node.arguments.entries()) {
      const typed = values[i];
      if (typed.type.kind === "string") {
        const t = this.tmp("hs");
        this.line(`TS_Str ${t} = ${typed.c};`);
        parts.push(`{(uint8_t *)${t}.ptr, ${t}.len}`);
      } else if (typed.type.kind === "pubkey") parts.push(`{(uint8_t *)(${typed.c}), 32}`);
      else if (isScalar(typed.type)) {
        const t = this.tmp("hv");
        this.line(`${scalarStorageC(typed.type)} ${t} = (${scalarStorageC(typed.type)})(${typed.c});`);
        parts.push(`{(uint8_t *)&${t}, ${scalarSize(typed.type)}}`);
      } else this.fail(a, `${fn} accepts strings, Pubkeys, Hashes, integers and booleans`);
    }
    const arr = this.tmp("hp");
    const out = this.tmp("h");
    this.line(`SolBytes ${arr}[${parts.length}] = {${parts.join(", ")}};`);
    this.line(`SolPubkey ${out};`);
    this.line(`sol_${fn}(${arr}, ${parts.length}, (uint8_t *)&${out});`);
    return { c: `(&${out})`, type: HASH };
  }

  /**
   * The extra accounts of a transfer hook, as ExtraAccountMeta records (35 bytes each): `{ address, isSigner?, isWritable? }`
   * for a fixed address, `{ seeds: [...], program?, isSigner?, isWritable? }` for a PDA of this program (or, with
   * `program: index`, of the program at that account index). Seeds: string literals, seedAccountKey(i),
   * seedAccountData(i, offset, length), seedInstructionData(offset, length); packed into 32 bytes.
   */
  protected extraAccountMetas(node: ts.Expression): { name: string; count: number } {
    if (!ts.isArrayLiteralExpression(node)) this.fail(node, "the extra accounts must be an array literal of { address } / { seeds } objects");
    const bytes: number[] = [];
    const fixups: { offset: number; c: string }[] = [];
    const small = (e: ts.Expression, what: string, max = 255): number => {
      if (!ts.isBigIntLiteral(e)) this.fail(e, `${what} must be a bigint literal`);
      const v = Number(BigInt(e.text.replace(/n$/, "")));
      if (v < 0 || v > max) this.fail(e, `${what} must be 0..${max}`);
      return v;
    };
    for (const el of node.elements) {
      if (!ts.isObjectLiteralExpression(el)) this.fail(el, "each extra account is { address, … } or { seeds: [...], … }");
      const props = new Map<string, ts.Expression>();
      for (const p of el.properties) {
        if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) this.fail(p, "use plain properties: address, seeds, program, isSigner, isWritable");
        if (!["address", "seeds", "program", "isSigner", "isWritable"].includes(p.name.text)) this.fail(p.name, `unknown property "${p.name.text}"`);
        props.set(p.name.text, p.initializer);
      }
      const flag = (k: string) => {
        const v = props.get(k);
        if (!v) return 0;
        if (v.kind === ts.SyntaxKind.TrueKeyword) return 1;
        if (v.kind === ts.SyntaxKind.FalseKeyword) return 0;
        this.fail(v, `${k} must be true or false`);
      };
      const start = bytes.length;
      const address = props.get("address");
      const seeds = props.get("seeds");
      if (!!address === !!seeds) this.fail(el, "give either address or seeds");
      if (address) {
        if (props.has("program")) this.fail(props.get("program")!, "program goes with seeds, not with address");
        const v = this.expect(this.expr(address, PUBKEY), PUBKEY, address);
        bytes.push(0, ...new Array(32).fill(0));
        fixups.push({ offset: start + 1, c: v.c });
      } else {
        if (!ts.isArrayLiteralExpression(seeds!)) this.fail(seeds!, "seeds must be an array literal");
        const packed: number[] = [];
        for (const s of seeds.elements) {
          if (ts.isStringLiteral(s)) {
            const b = [...Buffer.from(s.text, "utf8")];
            if (b.length > 32) this.fail(s, "a literal seed can be at most 32 bytes");
            packed.push(1, b.length, ...b);
            continue;
          }
          const fn = ts.isCallExpression(s) ? this.exportName(s.expression) : undefined;
          const a = ts.isCallExpression(s) ? s.arguments : ([] as unknown as ts.NodeArray<ts.Expression>);
          if (fn === "seedInstructionData" && a.length === 2) packed.push(2, small(a[0]!, "the data index"), small(a[1]!, "the length"));
          else if (fn === "seedAccountKey" && a.length === 1) packed.push(3, small(a[0]!, "the account index"));
          else if (fn === "seedAccountData" && a.length === 3)
            packed.push(4, small(a[0]!, "the account index"), small(a[1]!, "the data index"), small(a[2]!, "the length"));
          else this.fail(s, "a seed is a string literal, seedAccountKey(i), seedAccountData(i, offset, length) or seedInstructionData(offset, length)");
        }
        if (packed.length > 32) this.fail(seeds!, `the packed seeds take ${packed.length} bytes; at most 32 fit`);
        const program = props.get("program");
        bytes.push(program ? 128 + small(program, "program (an account index)", 127) : 1, ...packed, ...new Array(32 - packed.length).fill(0));
      }
      bytes.push(flag("isSigner")!, flag("isWritable")!);
    }
    const count = node.elements.length;
    if (!count) return { name: "NULL", count: 0 };
    const name = this.tmp("extra_metas");
    this.line(`${fixups.length ? "" : "static const "}uint8_t ${name}[${bytes.length}] = ${cBytes(bytes)};`);
    for (const f of fixups) this.line(`ts_memcpy(${name} + ${f.offset}, ${f.c}, 32);`);
    return { name, count };
  }

  /** The index of the first remaining account among the instruction's accounts, as C: a constant, or a helper's parameter. */
  protected remainingBase(node: ts.Expression): string {
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l?.type.kind === "remaining" && l.c) return l.c;
    }
    if (!this.ix) this.fail(node, "remainingAccounts() is only available in instructions; pass it to a helper that takes RemainingAccounts");
    return String(this.ix.accounts.length);
  }

  /** `remainingAccounts()` or a const bound to it. */
  protected isRemaining(node: ts.Expression): boolean {
    if (ts.isIdentifier(node)) return this.lookup(node.text)?.type.kind === "remaining";
    return ts.isCallExpression(node) && this.exportName(node.expression) === "remainingAccounts";
  }

  /** C pointer (`TsAccount *`) for an expression naming a remaining account, or undefined. */
  /** Whether `node` is an InstructionsSysvar parameter. */
  protected instructionsParam(node: ts.Expression) {
    const a = this.accountAt(node);
    return a?.kind.kind === "instructionsSysvar" ? a : undefined;
  }

  /** Whether `node` is a TransactionInstruction: a local holding one, or `ixs.get(i)`. */
  protected isTxIx(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node)) return this.isTxIx(node.expression);
    if (ts.isIdentifier(node)) return this.lookup(node.text)?.type.kind === "txIx";
    return (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      !!this.instructionsParam(node.expression.expression)
    );
  }

  /**
   * InstructionsSysvar.currentIndex() / .get(i) and the methods of a TransactionInstruction: bounds-checked reads of the
   * sysvar (ts_ix_* in the runtime). Undefined when the call is something else.
   */
  protected instructionsCall(node: ts.CallExpression, callee: ts.PropertyAccessExpression, method: string): Value | undefined {
    const args = node.arguments;
    const sysvar = this.instructionsParam(callee.expression);
    if (sysvar) {
      this.assertUsable(sysvar, callee.expression);
      if (method === "currentIndex") {
        if (args.length) this.fail(node, "currentIndex() takes no arguments");
        const t = this.tmp("ixi");
        this.line(`uint64_t ${t};`);
        this.line(`TS_TRY(ts_ix_current(a_${sysvar.name}, &${t}));`);
        return { c: t, type: U64 };
      }
      if (method === "get") {
        if (args.length !== 1) this.fail(node, "get(index) takes the instruction's index");
        const i = this.expect(this.expr(args[0], U64), U64, args[0]);
        const t = this.tmp("ix");
        this.line(`TsIx ${t};`);
        this.line(`TS_TRY(ts_ix_load(a_${sysvar.name}, ${i.c}, &${t}));`);
        return { c: t, type: { kind: "txIx" } };
      }
      this.fail(node, "the Instructions sysvar has .length, currentIndex() and get(index)");
    }
    if (!this.isTxIx(callee.expression)) return undefined;
    const ix = this.expr(callee.expression);
    const one = (what: string) => {
      if (args.length !== 1) this.fail(node, `${method}(${what}) takes one argument`);
      return this.expect(this.expr(args[0], U64), U64, args[0]).c;
    };
    if (method === "accountKey" || method === "accountIsSigner" || method === "accountIsWritable") {
      const i = one("i");
      const t = this.tmp("ixa");
      this.line(`const uint8_t *${t};`);
      this.line(`TS_TRY(ts_ix_account(&${ix.c}, ${i}, &${t}));`);
      if (method === "accountKey") return { c: `((const SolPubkey *)(${t} + 1))`, type: PUBKEY };
      return { c: `((${t}[0] & ${method === "accountIsSigner" ? 1 : 2}) != 0)`, type: BOOL };
    }
    const reads: Record<string, [string, Value["type"]]> = {
      readU8: ["uint8_t", U8],
      readU16: ["uint16_t", { kind: "int", name: "u16" }],
      readU32: ["uint32_t", { kind: "int", name: "u32" }],
      readU64: ["uint64_t", U64],
      readPubkey: ["SolPubkey", PUBKEY],
    };
    if (reads[method]) {
      const [c, type] = reads[method]!;
      const off = one("offset");
      const t = this.tmp("ixr");
      this.line(`${c} ${t};`);
      this.line(`TS_TRY(ts_ix_read(&${ix.c}, ${off}, sizeof(${c}), &${t}));`);
      return type.kind === "pubkey" ? { c: `(&${t})`, type } : { c: t, type };
    }
    if (method === "is") {
      if (args.length !== 2 || !ts.isStringLiteralLike(args[1]))
        this.fail(node, 'is(program, "instruction_name") takes the program and the instruction name as a string literal');
      const program = this.expect(this.expr(args[0], PUBKEY), PUBKEY, args[0]);
      const disc = this.tmp("disc");
      this.line(`static const uint8_t ${disc}[8] = ${cBytes(discriminator(`global:${snakeCase(args[1].text)}`))};`);
      return { c: `ts_ix_is(&${ix.c}, ${program.c}, ${disc})`, type: BOOL };
    }
    this.fail(
      node,
      "a TransactionInstruction has programId, accountsLength, dataLength, accountKey/accountIsSigner/accountIsWritable(i), readU8/U16/U32/U64/readPubkey(offset) and is(program, name)",
    );
  }

  /** `fixedArray<T, N>(fill)` written inline (a list method, a map / filter chain or `for … of` over it). */
  protected isInlineArray(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node)) return this.isInlineArray(node.expression);
    return ts.isCallExpression(node) && this.exportName(node.expression) === "fixedArray";
  }

  /**
   * Whether `node` is a read-only view of a Vec argument or the instruction data, without emitting code: a local or
   * helper parameter holding one, or `.slice(start, end?)` of such a view.
   */
  protected isVecArgView(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node)) return this.isVecArgView(node.expression);
    if (ts.isIdentifier(node)) return this.lookup(node.text)?.type.kind === "vecArg";
    return (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "slice" &&
      this.isVecArgView(node.expression.expression)
    );
  }

  /**
   * The view `node` names (see isVecArgView) as a `TS_VecArg` C expression. `.slice(start, end)` is elements start..end-1
   * in place (`end` defaults to the length): unlike JS's slice it does not clamp, an `end` past the length or before
   * `start` fails with 5104. Undefined when `node` is not such a view.
   */
  protected vecArgView(node: ts.Expression): { c: string; type: ValueType & { kind: "vecArg" } } | undefined {
    if (ts.isParenthesizedExpression(node)) return this.vecArgView(node.expression);
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      return l?.type.kind === "vecArg" ? { c: l.c, type: l.type } : undefined;
    }
    if (!this.isVecArgView(node)) return undefined;
    const call = node as ts.CallExpression;
    const base = this.vecArgView((call.expression as ts.PropertyAccessExpression).expression)!;
    if (base.type.optional) this.fail(call, "check the Option argument is not null before slicing it");
    const elem = base.type.elem;
    if (elem.kind === "string") this.fail(call, "slice works on lists of fixed-size elements, not on a Vec<string>");
    if (call.arguments.length < 1 || call.arguments.length > 2)
      this.fail(call, "slice(start, end?) takes the first element's index and the index after the last one");
    const start = this.tmp("sl_start");
    const end = this.tmp("sl_end");
    this.line(`uint64_t ${start} = ${this.expect(this.expr(call.arguments[0]!, U64), U64, call.arguments[0]!).c};`);
    this.line(`uint64_t ${end} = ${call.arguments[1] ? this.expect(this.expr(call.arguments[1], U64), U64, call.arguments[1]).c : `(uint64_t)${base.c}.len`};`);
    this.line(`if (${end} > (uint64_t)${base.c}.len || ${start} > ${end}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: slice out of range");`);
    const t = this.tmp("view");
    this.line(`TS_VecArg ${t} = {${base.c}.ptr + ${start} * ${this.fieldBytes(elem)}, (uint32_t)(${end} - ${start})};`);
    return { c: t, type: { kind: "vecArg", elem } };
  }

  /**
   * A list's elements as one contiguous run, for a bulk copy or a CPI: a Vec argument, the instruction data or a slice
   * of them; a Vec, FixedVec, BigVec (slice) or FixedArray in account data or a local. Undefined for anything else.
   */
  protected listSpan(e: ts.Expression): { items: string; count: string; elem: FieldType; view: boolean } | undefined {
    if (this.isVecArgView(e)) {
      const v = this.vecArgView(e)!;
      return { items: `${v.c}.ptr`, count: `((uint64_t)${v.c}.len)`, elem: v.type.elem, view: true };
    }
    const r = this.ref(e);
    if (r?.type.kind === "array") return { items: `${r.lv}`, count: `${r.type.len}ULL`, elem: r.type.elem, view: false };
    if (r?.vec && r.type.kind === "vec") return { items: r.vec.items, count: vecCount(r.vec), elem: r.type.elem, view: false };
    return undefined;
  }

  /** `pushAll(items)`'s source: a list of exactly `elem` (see listSpan). */
  protected bulkSource(e: ts.Expression, elem: FieldType): { items: string; count: string } {
    const what = `pushAll takes a list of ${typeName(elem)}: a Vec, FixedVec or FixedArray, a Vec argument, or the instruction data or a slice of it`;
    const s = this.listSpan(e) ?? this.fail(e, what);
    if (!sameType(s.elem, elem)) this.fail(e, what);
    // A Vec argument's booleans and enums are checked as each is read (get, for … of), not on entry.
    if (s.view && (elem.kind === "bool" || elem.kind === "enum"))
      this.fail(e, "a Vec argument's booleans and enums are checked as each is read: push them one by one (for … of)");
    return s;
  }

  /**
   * Whether `node` names one account a choice may pick, without emitting code: a remaining account (`rest.get(i)`), a
   * local or `RemainingAccount` helper parameter bound to one, an `AccountInfo` parameter, or a choice between those.
   */
  protected looksLikeAccountHandle(node: ts.Expression): boolean {
    if (ts.isParenthesizedExpression(node)) return this.looksLikeAccountHandle(node.expression);
    if (ts.isConditionalExpression(node)) return this.looksLikeAccountHandle(node.whenTrue) && this.looksLikeAccountHandle(node.whenFalse);
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l) return l.type.kind === "account";
      return this.accountAt(node)?.kind.kind === "info";
    }
    return (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      this.isRemaining(node.expression.expression)
    );
  }

  /**
   * `c ? rest.get(5n) : reserve`: one of two accounts, chosen at run time (only the chosen side runs), as a `TsAccount *`
   * usable wherever a remaining account is. Each side is a remaining account, a local or helper parameter bound to one,
   * an `AccountInfo` parameter or another such choice; a `programAt` check is kept when both sides carry the same one.
   */
  protected accountChoice(node: ts.ConditionalExpression): Value {
    const side = (e: ts.Expression): Value => {
      if (ts.isParenthesizedExpression(e)) return side(e.expression);
      if (ts.isConditionalExpression(e)) return this.accountChoice(e);
      if (ts.isIdentifier(e)) {
        const l = this.lookup(e.text);
        if (l?.type.kind === "account") return { c: l.c, type: l.type };
        const a = this.accountAt(e);
        if (!l && a?.kind.kind === "info") return { c: `a_${this.accountParam(e, "a choice between accounts").name}`, type: { kind: "account" } };
      }
      const h = this.handle(e);
      if (h) return { c: h, type: { kind: "account" } };
      this.fail(
        e,
        "choose between accounts of the same kind: remaining accounts (rest.get(i), a local or RemainingAccount parameter bound to one) or AccountInfo parameters",
      );
    };
    const cond = this.expect(this.expr(node.condition, BOOL), BOOL, node.condition);
    const t = this.tmp("acct");
    this.line(`TsAccount *${t};`);
    this.line(`if (${cond.c}) {`);
    let a!: Value;
    let b!: Value;
    this.block(() => {
      a = side(node.whenTrue);
      this.line(`${t} = ${a.c};`);
    });
    this.line(`} else {`);
    this.block(() => {
      b = side(node.whenFalse);
      this.line(`${t} = ${b.c};`);
    });
    this.line(`}`);
    const pa = a.type.kind === "account" ? a.type.program : undefined;
    const pb = b.type.kind === "account" ? b.type.program : undefined;
    const program = pa && pb && JSON.stringify(pa) === JSON.stringify(pb) ? pa : undefined;
    return { c: t, type: { kind: "account", ...(program ? { program } : {}) } };
  }

  protected handle(node: ts.Expression): string | undefined {
    if (ts.isParenthesizedExpression(node)) return this.handle(node.expression);
    if (ts.isConditionalExpression(node) && this.looksLikeAccountHandle(node)) return this.accountChoice(node).c;
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      return l?.type.kind === "account" ? l.c : undefined;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      this.isRemaining(node.expression.expression)
    ) {
      if (node.arguments.length !== 1) this.fail(node, "get(index) takes one argument");
      const n = this.remainingBase(node.expression.expression);
      const idx = this.index(node.arguments[0], `(uint64_t)(params->ka_num - ${n})`);
      const t = this.tmp("acct");
      this.line(`TsAccount *${t} = params->ka[${n} + ${idx}];`);
      return t;
    }
    return undefined;
  }

  /** A declared account parameter or a remaining account, as a `TsAccount *` C expression. */
  protected anyAccount(node: ts.Expression, what: string): string {
    const h = this.handle(node);
    if (h) return h;
    return `a_${this.accountParam(node, what).name}`;
  }

  /**
   * An account argument of a typed CPI: a declared account parameter (`param`, its kind and writability checked by
   * the caller), or a remaining account, a local bound to one, a RemainingAccount helper parameter or a loaded struct
   * (no compile-time checks: the called program and the runtime check them).
   */
  protected cpiAccount(node: ts.Expression, what: string): CpiAcct {
    const h = this.handle(node);
    if (h) return { c: h };
    const loaded = ts.isIdentifier(node) ? this.lookup(node.text)?.loaded : undefined;
    if (loaded) return { c: loaded.handle };
    const param = this.accountParam(node, what);
    return { c: `a_${param.name}`, param };
  }

  /** A declared program parameter as the program of a typed CPI. */
  protected programParam(a: AccountParam): CpiProgram {
    return { c: `a_${a.name}`, kind: a.kind };
  }

  /**
   * `programAt<P>(acct)` / `sysvarAt<S>(acct)`: the account (a remaining account or an AccountInfo parameter) checked
   * to be that program or sysvar by its key, once, then usable with P's typed methods. A wrong program fails with
   * ProgramError.IncorrectProgramId and a wrong sysvar with ProgramError.InvalidArgument, as solana_program's checks do.
   */
  protected programAt(node: ts.CallExpression, fn: "programAt" | "sysvarAt"): Value {
    const programs: Record<string, [ParamKind, string | undefined, string]> = {
      StakeProgram: [{ kind: "stakeProgram" }, "TS_STAKE_PROGRAM_ID", "the Stake program"],
      SystemProgram: [{ kind: "system" }, "TS_SYSTEM_PROGRAM_ID", "the System Program"],
      TokenProgram: [{ kind: "tokenProgram", flavor: "token" }, "TS_TOKEN_PROGRAM_ID", "the Token program"],
      Token2022Program: [{ kind: "tokenProgram", flavor: "token2022" }, "TS_TOKEN_2022_PROGRAM_ID", "the Token-2022 program"],
      TokenInterface: [{ kind: "tokenProgram", flavor: "tokenInterface" }, undefined, "a token program"],
      AssociatedTokenProgram: [{ kind: "ataProgram" }, "TS_ATA_PROGRAM_ID", "the Associated Token program"],
      MemoProgram: [{ kind: "memoProgram" }, "TS_MEMO_PROGRAM_ID", "the Memo program"],
    };
    const sysvars: typeof programs = { StakeHistorySysvar: [{ kind: "stakeHistory" }, "TS_STAKE_HISTORY_ID", "the StakeHistory sysvar"] };
    const table = fn === "programAt" ? programs : sysvars;
    const targ = node.typeArguments?.[0];
    const name = targ && typesolName(targ, this.scope.imports);
    const entry = name ? table[name] : undefined;
    if (!entry)
      this.fail(
        targ ?? node,
        fn === "programAt" ? `programAt<P>(account): P is one of ${Object.keys(programs).join(", ")}` : "sysvarAt<S>(account): S is StakeHistorySysvar",
      );
    if (node.arguments.length !== 1) this.fail(node, `${fn}<${name}>(account) takes one remaining account or AccountInfo parameter`);
    const arg = node.arguments[0]!;
    let h = this.handle(arg);
    if (!h) {
      const acct = this.accountParam(arg, `${fn}'s account`);
      if (acct.kind.kind !== "info")
        this.fail(arg, `pass a remaining account (remainingAccounts().get(i)) or an AccountInfo parameter; a declared parameter can be typed ${name} itself`);
      h = `a_${acct.name}`;
    }
    const [kind, id, what] = entry;
    const err = PROGRAM_ERRORS.indexOf(fn === "programAt" ? "IncorrectProgramId" : "InvalidArgument");
    // `const PROGRAM_ERROR_LOG_PREFIX = "Program error: "`: logged as a native entrypoint logs the error.
    const pre = this.model.constants.get("PROGRAM_ERROR_LOG_PREFIX")?.value;
    const text = typeof pre === "string" ? `${pre}${PROGRAM_ERRORS[err]}` : `TypeSOL: not ${what}`;
    const bad = id ? `!ts_key_eq(&${h}->key, &${id})` : `!ts_is_token_program(&${h}->key)`;
    this.line(`if (${bad}) ${this.programFail(`((uint64_t)${err + 2}) << 32`, text)};`);
    if (kind.kind === "stakeHistory") this.line(`if (${h}->data_len < 8) TS_FAIL(TS_ERR_SYSVAR, "TypeSOL: not the StakeHistory sysvar's data");`);
    return { c: h, type: { kind: "account", program: kind } };
  }

  /** A value `programAt` / `sysvarAt` checked (a local bound to one, or the call itself), as the program it is. */
  protected programAtValue(node: ts.Expression): CpiProgram | undefined {
    if (ts.isParenthesizedExpression(node)) return this.programAtValue(node.expression);
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      return l?.type.kind === "account" && l.type.program ? { c: l.c, kind: l.type.program } : undefined;
    }
    if (!ts.isCallExpression(node)) return undefined;
    const fn = this.exportName(node.expression);
    if (fn !== "programAt" && fn !== "sysvarAt") return undefined;
    const v = this.programAt(node, fn);
    return { c: v.c, kind: (v.type as { program: ParamKind }).program };
  }

  /** `stake.split(…)` on a programAt value: the same typed methods as on a declared program parameter. */
  protected programAtMethod(node: ts.CallExpression, at: CpiProgram, method: string): Value | undefined {
    switch (at.kind.kind) {
      case "system":
        if (method === "transfer") return this.systemTransfer(node);
        if (method === "createAccount") return this.createAccount(node, at);
        if (method === "createPda") return this.createPda(node);
        if (method === "allocate" || method === "assign") return this.allocateOrAssign(node, at, method);
        this.fail(node.expression, `the System Program has transfer, createAccount, createPda, allocate and assign, not ${method}`);
      case "tokenProgram":
        return this.tokenOp(node, at, method);
      case "ataProgram":
        return this.ataOp(node, at, method);
      case "memoProgram":
        return this.memoOp(node, at, method);
      case "stakeProgram":
        return this.stakeOp(node, at, method);
      case "stakeHistory":
        return this.stakeHistoryRead(node, at.c, method);
    }
    this.fail(node.expression, `unsupported call: ${method}`);
  }

  /** StakeHistorySysvar's has / effective / activating / deactivating(epoch), on the sysvar account `h`. */
  protected stakeHistoryRead(node: ts.CallExpression, h: string, method: string): Value {
    const args = node.arguments;
    const fields: Record<string, number> = { has: 0, effective: 1, activating: 2, deactivating: 3 };
    if (!(method in fields))
      this.fail(
        (node.expression as ts.PropertyAccessExpression).name,
        "StakeHistorySysvar has has(epoch), effective(epoch), activating(epoch) and deactivating(epoch)",
      );
    if (args.length !== 1) this.fail(node, `${method}(epoch) takes the epoch`);
    const epoch = this.expect(this.expr(args[0]!, U64), U64, args[0]!);
    const f = this.tmp("shf");
    const v = this.tmp("shv");
    this.line(`bool ${f};`);
    this.line(`uint64_t ${v} = ts_stake_history(${h}, ${epoch.c}, ${Math.max(1, fields[method]!)}, &${f});`);
    return method === "has" ? { c: f, type: BOOL } : { c: v, type: U64 };
  }

  /** `readData<T>(account, offset)`: a bounds-checked little-endian read of any account's data. */
  protected readData(node: ts.CallExpression): Value {
    const targ = node.typeArguments?.[0];
    const t = targ && resolveScalarType(targ, this.scope);
    if (!t) this.fail(node, "readData needs a value type: readData<u64>(account, offset)");
    if (node.arguments.length !== 2) this.fail(node, "readData<T>(account, offset) takes an account and a byte offset");
    const acct = this.anyAccount(node.arguments[0], "readData's account");
    const off = this.expect(this.expr(node.arguments[1], U64), U64, node.arguments[1]);
    const size = scalarSize(t);
    const o = this.tmp("off");
    const out = this.tmp("rd");
    this.line(`uint64_t ${o} = ${off.c};`);
    this.line(
      `if (${o} > ${acct}->data_len || ${acct}->data_len - ${o} < ${size}) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: read past the end of the account data");`,
    );
    this.line(`${scalarStorageC(t)} ${out};`);
    this.line(`ts_memcpy(&${out}, ${acct}->data + ${o}, ${size});`);
    if (t.kind === "pubkey") return { c: `(&${out})`, type: t };
    if (t.kind === "bool") {
      this.line(`if (${out} > 1) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: not a boolean");`);
      return { c: `(${out} != 0)`, type: BOOL };
    }
    if (t.kind === "enum")
      this.line(`if (${out} >= ${this.model.enums.get(t.name)!.variants.length}) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: invalid enum value");`);
    return { c: out, type: t };
  }

  /** `writeData<T>(account, offset, value)`: a little-endian store into a writable AccountInfo's data. */
  protected writeData(node: ts.CallExpression): undefined {
    const targ = node.typeArguments?.[0];
    const t = targ && resolveScalarType(targ, this.scope);
    if (!t) this.fail(node, "writeData needs a value type: writeData<u64>(account, offset, value)");
    if (node.arguments.length !== 3) this.fail(node, "writeData<T>(account, offset, value) takes an account, a byte offset and a value");
    const acct = this.accountParam(node.arguments[0], "writeData's account");
    if (acct.kind.kind !== "info" || !isWritable(acct.kind)) this.fail(node.arguments[0], "writeData needs a Mut<AccountInfo> parameter");
    const off = this.expect(this.expr(node.arguments[1], U64), U64, node.arguments[1]);
    const o = this.tmp("off");
    this.line(`uint64_t ${o} = ${off.c};`);
    const v = this.expect(this.expr(node.arguments[2], t), t, node.arguments[2]);
    const size = scalarSize(t);
    const a = `a_${acct.name}`;
    this.line(
      `if (${o} > ${a}->data_len || ${a}->data_len - ${o} < ${size}) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: write past the end of the account data");`,
    );
    if (t.kind === "pubkey") this.line(`ts_memcpy(${a}->data + ${o}, ${v.c}, 32);`);
    else {
      const w = this.tmp("wr");
      this.line(`${scalarStorageC(t)} ${w} = (${scalarStorageC(t)})(${v.c});`);
      this.line(`ts_memcpy(${a}->data + ${o}, &${w}, ${size});`);
    }
    return undefined;
  }

  /** `loadForeign<T>(account, owner)`: read-only view of another program's Anchor account. */
  protected loadForeign(node: ts.CallExpression): Value {
    const targ = node.typeArguments?.[0];
    const s = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
    if (!s || s.size === undefined || s.vec) this.fail(node, "loadForeign needs a fixed-size struct type: loadForeign<Pool>(account, owner)");
    if (s.accountDiscriminator.length !== 8) this.fail(node, `${s.name}'s discriminator is shorter than 8 bytes: take it as Owner<Account<${s.name}>, "…">`);
    if (s.layout === "borsh") this.fail(node, `${s.name} is @layout borsh: loadForeign reads fixed layouts only`);
    if (node.arguments.length !== 2) this.fail(node, "loadForeign<T>(account, owner) takes the account and its owning program's address");
    const h = this.anyAccount(node.arguments[0], "loadForeign's account");
    const owner = this.expect(this.expr(node.arguments[1], PUBKEY), PUBKEY, node.arguments[1]);
    const disc = this.tmp("disc");
    this.line(`static const uint8_t ${disc}[8] = ${cBytes(s.accountDiscriminator)};`);
    this.line(`if (!ts_key_eq(&${h}->owner, ${owner.c})) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: account not owned by the expected program");`);
    this.line(`if (${h}->data_len < 8 + sizeof(TSS_${s.name})) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: account data too small");`);
    this.line(`if (!ts_mem_eq(${h}->data, ${disc}, 8)) TS_FAIL(TS_ERR_DISCRIMINATOR, "TypeSOL: account discriminator mismatch");`);
    // Another program wrote these bytes: check bools, enums, option tags and string lengths like arguments.
    const view = `(*((TSS_${s.name} *)(${h}->data + 8)))`;
    for (const l of this.validation(view, { kind: "struct", name: s.name }, "", `TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: malformed foreign account data")`))
      this.line(l.trim());
    return { c: `((TSS_${s.name} *)(${h}->data + 8))`, type: { kind: "structRef", struct: s.name, writable: false } };
  }

  /**
   * `loadRaw<T>(acct)` / `loadRawMut<T>(acct)`: a native program's account (no discriminator) as a fixed-layout struct
   * from byte 0, checked as a `#[repr(C)]` type's load_checked does: this program's (3007), large enough (3003).
   */
  protected loadRaw(node: ts.CallExpression, mut: boolean): Value {
    const fn = mut ? "loadRawMut" : "loadRaw";
    const targ = node.typeArguments?.[0];
    const s = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
    if (!s || s.size === undefined || (s.vec && !s.bigVec)) this.fail(node, `${fn} needs a fixed-size struct type: ${fn}<MyStruct>(account)`);
    if (s.layout === "borsh") this.fail(node, `${s.name} is @layout borsh: ${fn} reads fixed layouts only`);
    if (node.arguments.length !== 1) this.fail(node, `${fn}<T>(account) takes one remaining account or AccountInfo parameter`);
    const { h, param } = this.rawAccount(node, fn, mut);
    this.line(`if (!ts_key_eq(&${h}->owner, params->program_id)) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: account not owned by this program");`);
    this.line(`if (${h}->data_len < sizeof(TSS_${s.name})) TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: account data too small");`);
    // A BigVec's stored length must fit in the account. Its capacity is kept in a local: every access is clamped to it
    // (the length may be written again after this), without a division each time.
    let bigCap: string | undefined;
    if (s.bigVec) {
      bigCap = this.tmp("bv_cap");
      this.line(`uint64_t ${bigCap} = (${h}->data_len - sizeof(TSS_${s.name})) / ${s.bigVec.elemSize};`);
      this.line(`if ((uint64_t)((TSS_${s.name} *)(${h}->data))->${s.bigVec.name}__len > ${bigCap}) ${this.programErrorFail("AccountDataTooSmall", node)};`);
      // Named in scope, so a loop moved into a function of its own is given it (see outlinedLoop).
      this.scopes.at(-1)!.set(`__${bigCap}`, { c: bigCap, type: U64, mutable: false });
    }
    if (mut) this.claimRawMut(node, h, param);
    return { c: `((TSS_${s.name} *)(${h}->data))`, type: { kind: "structRef", struct: s.name, writable: mut }, ...(bigCap ? { bigCap } : {}) };
  }

  /**
   * The account a loadRaw-style view reads (its first argument): a remaining account, or an AccountInfo parameter of
   * the instruction (`param`: its position, for the claim). `fn` names the call in messages.
   */
  protected rawAccount(node: ts.CallExpression, fn: string, mut: boolean): { h: string; param?: number } {
    const h = this.handle(node.arguments[0]);
    if (h) return { h };
    const acct = this.accountParam(node.arguments[0], "the account");
    if (acct.kind.kind !== "info") this.fail(node.arguments[0], "pass a remaining account (remainingAccounts().get(i)) or an AccountInfo parameter");
    if (mut && !isWritable(acct.kind) && !this.nativeAccountWrites())
      this.fail(
        node.arguments[0],
        `${acct.name} must be Mut<AccountInfo> to load it with ${fn} (or declare const NATIVE_ACCOUNT_WRITES = true to leave writability to the runtime, as a native program does)`,
      );
    if (!this.ix) this.fail(node, `load ${acct.name} in the instruction and pass the struct on`);
    return { h: `a_${acct.name}`, param: this.ix.accounts.indexOf(acct) };
  }

  /**
   * A writable view's checks: the account is writable and loaded mutably once in the instruction (2040).
   * NATIVE_ACCOUNT_WRITES: no writability check and no claim. The view writes in place; the runtime refuses the
   * instruction if a read-only account's data changed, and two views of one account share its bytes (the loader
   * gives a duplicate the same record), as two AccountInfos of one account share one buffer in Rust.
   */
  protected claimRawMut(node: ts.CallExpression, h: string, param: number | undefined): void {
    if (this.nativeAccountWrites()) return;
    this.line(`TS_TRY(ts_check_writable(${h}));`);
    const slot = this.claimSlots.get(node);
    if (slot)
      this.line(
        param === undefined ? `TS_TRY(ts_claim_mut_rec(params, ${h}, &${slot}, params->ka_num));` : `TS_TRY(ts_claim_mut_at_rec(params, ${param}, &${slot}));`,
      );
    else this.line(param === undefined ? `TS_TRY(ts_claim_mut(params, ${h}));` : `TS_TRY(ts_claim_mut_at(params, ${param}));`);
  }

  /**
   * `const v = loadBorsh<T>(acct)`: the account's data from byte 0 decoded as Borsh into a local `T` (a copy), as
   * `try_from_slice_unchecked` reads it: no owner check, no discriminator, trailing bytes ignored; bytes that are not
   * a valid `T` (too short, an Option tag or bool not 0/1, an enum tag out of range) fail with BorshIoError.
   */
  protected loadBorsh(node: ts.CallExpression, c: string, declared: StructDef | undefined): StructDef {
    const s = this.borshNativeStruct(node, node.typeArguments?.[0], declared, "loadBorsh");
    if (node.arguments.length !== 1) this.fail(node, "loadBorsh<T>(account) takes one remaining account or AccountInfo parameter");
    const h = this.borshAccount(node.arguments[0], "loadBorsh", false);
    this.line(`TSS_${s.name} ${c}__v;`);
    this.line(`if (ts_bdec_${s.name}(${h}->data, ${h}->data_len, &${c}__v, NULL)) ${this.programErrorFail("BorshIoError", node)};`);
    this.line(`TSS_${s.name} *${c} = &${c}__v;`);
    return s;
  }

  /**
   * `storeBorsh(acct, value)`: `value` encoded as Borsh into the account's data from byte 0, as Rust's
   * `value.serialize(&mut &mut data[..])` writes it: only the encoded bytes (the rest of the account is left as it
   * was), BorshIoError when they do not fit. The account must be writable.
   */
  protected storeBorsh(node: ts.CallExpression): undefined {
    if (node.arguments.length !== 2) this.fail(node, "storeBorsh(account, value) takes the account and the struct value to write");
    const h = this.borshAccount(node.arguments[0], "storeBorsh", true);
    const valueNode = node.arguments[1];
    const targ = node.typeArguments?.[0];
    let ptr: string;
    let s: StructDef;
    const inner = ts.isParenthesizedExpression(valueNode) ? valueNode.expression : valueNode;
    if (ts.isObjectLiteralExpression(inner)) {
      if (!targ) this.fail(valueNode, "storeBorsh needs the struct type for an object literal: storeBorsh<MyStruct>(account, { … })");
      s = this.borshNativeStruct(node, targ, undefined, "storeBorsh");
      const t = this.tmp("bval");
      this.line(`TSS_${s.name} ${t};`);
      this.writeAggregate({ lv: t, type: { kind: "struct", name: s.name }, writable: true }, inner, true);
      ptr = `(&${t})`;
    } else {
      const place = this.structPlace(valueNode);
      if (!place) this.fail(valueNode, "storeBorsh writes a struct value: a local (const pool = loadBorsh<Pool>(acct)), a struct field or an object literal");
      const want = targ ? this.borshNativeStruct(node, targ, undefined, "storeBorsh") : undefined;
      if (want && want.name !== place.struct) this.fail(valueNode, `expected a ${want.name}, got a ${place.struct}`);
      s = this.borshNativeStruct(node, undefined, this.model.structs.get(place.struct), "storeBorsh");
      ptr = place.ptr;
    }
    this.line(`if (ts_benc_${s.name}(${ptr}, ${h}->data, ${h}->data_len, NULL)) ${this.programErrorFail("BorshIoError", node)};`);
    return undefined;
  }

  /** The struct loadBorsh / storeBorsh decodes or encodes: from the type argument, else the declared type. */
  private borshNativeStruct(node: ts.Node, targ: ts.TypeNode | undefined, declared: StructDef | undefined, fn: string): StructDef {
    let s = declared;
    if (targ) {
      const named = ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
      if (!named) this.fail(targ, `${fn} needs a struct type: ${fn === "loadBorsh" ? "loadBorsh<MyStruct>(account)" : "storeBorsh<MyStruct>(account, value)"}`);
      if (declared && declared.name !== named.name) this.fail(node, `loadBorsh<${named.name}> is bound to a ${declared.name}`);
      s = named;
    }
    if (!s)
      this.fail(
        node,
        `${fn} needs a struct type: ${fn === "loadBorsh" ? "const pool = loadBorsh<MyStruct>(account)" : "storeBorsh<MyStruct>(account, value)"}`,
      );
    const why = borshNativeStructUnsupported(s, this.model);
    if (why) this.fail(targ ?? node, `${fn} cannot take ${s.name}: ${why}`);
    this.model.borshNative.add(s.name);
    return s;
  }

  /** The account loadBorsh reads or storeBorsh writes (writable: checked at run time, or Mut<AccountInfo>). */
  private borshAccount(node: ts.Expression, fn: string, write: boolean): string {
    const h = this.handle(node);
    // NATIVE_ACCOUNT_WRITES: written as Rust's serialize writes it, the runtime judging writability afterwards.
    const native = this.nativeAccountWrites();
    // Without the flag, a write also needs the account passed once: given again (as another declared account or a
    // remaining one), what the program reads through the other would not be what it wrote here.
    if (h) {
      if (write && !native) {
        this.line(`TS_TRY(ts_check_writable(${h}));`);
        this.line(`TS_TRY(ts_check_unaliased(params, ${h}));`);
      }
      return h;
    }
    const acct = this.accountParam(node, `${fn}'s account`);
    if (acct.kind.kind !== "info") this.fail(node, `${fn} takes a remaining account (remainingAccounts().get(i)) or an AccountInfo parameter`);
    if (write && !isWritable(acct.kind) && !native)
      this.fail(
        node,
        `${acct.name} must be Mut<AccountInfo> to write it with storeBorsh (or declare const NATIVE_ACCOUNT_WRITES = true to leave writability to the runtime, as a native program does)`,
      );
    if (write && !native) this.line(`TS_TRY(ts_check_unaliased(params, a_${acct.name}));`);
    return `a_${acct.name}`;
  }

  /**
   * An account `closeRaw` / `assignOwner` writes in place: a remaining account (a helper's RemainingAccount, a ternary
   * between them) or an AccountInfo parameter. Without NATIVE_ACCOUNT_WRITES it is checked as the other writes to
   * accounts the compiler cannot see are: writable (3006; a parameter must be Mut<AccountInfo>), passed once (2040), and
   * for `owned` this program's (3007). With the flag nothing is checked: the runtime judges the result, as it judges a
   * native program's.
   */
  protected inPlaceAccount(node: ts.Expression, what: string, owned: boolean): string {
    const native = this.nativeAccountWrites();
    let h = this.handle(node);
    if (!h) {
      const acct = this.accountParam(node, what);
      if (acct.kind.kind !== "info") this.fail(node, `${what} is a remaining account (remainingAccounts().get(i)) or an AccountInfo parameter`);
      if (!isWritable(acct.kind) && !native)
        this.fail(
          node,
          `${acct.name} must be Mut<AccountInfo> to change it in place (or declare const NATIVE_ACCOUNT_WRITES = true to leave writability to the runtime, as a native program does)`,
        );
      h = `a_${acct.name}`;
    } else if (!native) this.line(`TS_TRY(ts_check_writable(${h}));`);
    if (native) return h;
    this.line(`TS_TRY(ts_check_unaliased(params, ${h}));`);
    if (owned) this.line(`if (!ts_key_eq(&${h}->owner, params->program_id)) TS_FAIL(TS_ERR_WRONG_OWNER, "TypeSOL: account not owned by this program");`);
    return h;
  }

  /** `TS_FAIL` with a built-in ProgramError (no custom code), logged as `require(…, ProgramError.X)` logs it. */
  protected programErrorFail(name: string, node: ts.Node): string {
    const idx = PROGRAM_ERRORS.indexOf(name);
    // `const PROGRAM_ERROR_LOG_PREFIX = "Program error: "`: the log line a native entrypoint writes for it.
    const pre = this.model.constants.get("PROGRAM_ERROR_LOG_PREFIX")?.value;
    const text = typeof pre === "string" ? `${pre}${name}` : `Error: ${name} (${this.location(node)})`;
    return this.programFail(`((uint64_t)${idx + 2}) << 32`, text);
  }

  /** A failure with a built-in ProgramError's code: logged with `text`, or nothing under `PROGRAM_ERROR_LOG_PREFIX = null`. */
  protected programFail(code: string, text: string): string {
    if (this.model.constants.get("PROGRAM_ERROR_LOG_PREFIX")?.value === null) return `return ts_fail_quiet(${code})`;
    return `TS_FAIL(${code}, ${cString(text)})`;
  }

  /** `const ERROR_LOG_PREFIX = null`: the program's own errors (and codes returned by its helpers) log nothing. */
  protected quietErrors(): boolean {
    return this.model.constants.get("ERROR_LOG_PREFIX")?.value === null;
  }

  /** `loadAccount<T>(acct)` / `loadAccountMut<T>(acct)`: checked view of a program account. */
  protected loadAccount(node: ts.CallExpression, mut: boolean): Value {
    let targ = node.typeArguments?.[0];
    // loadAccountMut<Dup<T>>: the account may be passed more than once among the remaining accounts (a route back
    // through one pool), loaded once per loop iteration; two live views of it are still refused.
    const dup = !!targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) && targ.typeName.text === "Dup" && targ.typeArguments?.length === 1;
    if (dup) {
      if (!mut) this.fail(node, "Dup<…> is for loadAccountMut (loadAccount reads, any number of times)");
      targ = (targ as ts.TypeReferenceNode).typeArguments![0];
    }
    const s = targ && ts.isTypeReferenceNode(targ) && ts.isIdentifier(targ.typeName) ? this.model.structs.get(targ.typeName.text) : undefined;
    if (!s || s.size === undefined) this.fail(node, "loadAccount needs an account struct type: loadAccount<MyStruct>(account)");
    if (s.accountDiscriminator.length !== 8) this.fail(node, `${s.name}'s discriminator is shorter than 8 bytes: take it as Owner<Account<${s.name}>, "…">`);
    if (s.layout === "borsh") this.fail(node, `${s.name} is @layout borsh: declare it as an instruction parameter (remaining accounts are read in place)`);
    if (s.bigVec) this.fail(node, `${s.name} ends in a BigVec, a native program's list (no discriminator): read it with loadRaw / loadRawMut`);
    if (node.arguments.length !== 1) this.fail(node, "loadAccount<T>(account) takes one remaining account or AccountInfo parameter");
    let h = this.handle(node.arguments[0]);
    // An AccountInfo parameter (Anchor: AccountLoader::try_from on an UncheckedAccount). The entry checks already
    // refuse it aliasing another writable parameter (unless Dup<…>), so only a second load of it is refused here.
    let param: number | undefined;
    if (!h) {
      const acct = this.accountParam(node.arguments[0], "the account");
      if (acct.kind.kind !== "info") this.fail(node.arguments[0], "pass a remaining account (remainingAccounts().get(i)) or an AccountInfo parameter");
      if (mut && !isWritable(acct.kind)) this.fail(node.arguments[0], `${acct.name} must be Mut<AccountInfo> to load it with loadAccountMut`);
      if (!this.ix) this.fail(node, `load ${acct.name} in the instruction and pass the struct to this helper as ${mut ? "Mut" : "Account"}<${s.name}>`);
      h = `a_${acct.name}`;
      param = this.ix.accounts.indexOf(acct);
    }
    if (this.model.events.has(s.name) && s.fields.some((f) => f.type.kind === "option" || f.type.kind === "dataEnum"))
      this.fail(node, `${s.name} is emitted as an event and has Option or enum fields; declare a separate event struct`);
    this.model.accountStructs.add(s.name);
    this.line(
      `TS_TRY(${s.idlMeta?.serialization?.startsWith("bytemuck") ? "ts_check_loader_account" : "ts_check_program_account"}(${h}, params->program_id, TS_DISC_${s.name}, ${emptySizeC(s)}));`,
    );
    if (s.vec) for (const l of vecLenCheck(s, h, `((TSS_${s.name} *)(${h}->data + 8))`, "")) this.line(l);
    if (mut) {
      this.line(`TS_TRY(ts_check_writable(${h}));`);
      const slot = this.claimSlots.get(node);
      // Repeats may come only after the instruction's own accounts, and only for Dup<…>: otherwise any repeat is refused.
      const declared = dup && this.ix ? String(this.ix.accounts.length) : "params->ka_num";
      if (dup && (param !== undefined || !slot)) this.fail(node, "loadAccountMut<Dup<T>> is for remaining accounts loaded in a loop (one view per iteration)");
      if (slot)
        this.line(
          param === undefined ? `TS_TRY(ts_claim_mut_rec(params, ${h}, &${slot}, ${declared}));` : `TS_TRY(ts_claim_mut_at_rec(params, ${param}, &${slot}));`,
        );
      else this.line(param === undefined ? `TS_TRY(ts_claim_mut(params, ${h}));` : `TS_TRY(ts_claim_mut_at(params, ${param}));`);
    }
    return { c: `((TSS_${s.name} *)(${h}->data + 8))`, type: { kind: "structRef", struct: s.name, writable: mut } };
  }

  /**
   * `acct.migrate(payer, value)` on a Migrate<From, To> account: the new value is built in full first (it may read
   * acct.from, whose bytes the rewrite overwrites), then the account is resized (the payer tops up the rent when it
   * grows; shrinking keeps the lamports) and rewritten with To's discriminator and the value.
   */
  protected migrate(node: ts.CallExpression, a: AccountParam, topLevel: boolean): Value | undefined {
    const k = a.kind as { kind: "migrate"; from: StructDef; to: StructDef };
    const call = `${a.name}.migrate`;
    if (!topLevel) this.fail(node, `${call}(…) must be a top-level statement of the instruction`);
    if (this.created.has(a.name)) this.fail(node, `${a.name} is already migrated`);
    if (node.arguments.length !== 2) this.fail(node, `${call}(payer, value) takes the payer and the new ${k.to.name}`);
    const payer = this.accountParam(node.arguments[0]!, "the payer");
    if (payer.kind.kind !== "signer" || !payer.kind.mut) this.fail(node.arguments[0]!, "the payer must be a Mut<Signer>");
    this.assertNotAliased([a.name], node, "migrate");
    const To = k.to.name;
    const tmp = this.tmp("next");
    this.line(`TSS_${To} *${tmp} = NULL;`);
    this.line(`TS_TRY(ts_alloc(sizeof(TSS_${To}), (uint8_t **)&${tmp}));`);
    this.writeAggregate({ lv: `(*${tmp})`, type: { kind: "struct", name: To }, writable: true }, node.arguments[1]!);
    this.line(`TS_TRY(ts_resize(params, a_${payer.name}, a_${a.name}, 8 + sizeof(TSS_${To}), entry_${a.name}));`);
    this.line(`ts_memcpy(a_${a.name}->data, TS_DISC_${To}, 8);`);
    this.line(`ts_memcpy(a_${a.name}->data + 8, ${tmp}, sizeof(TSS_${To}));`);
    this.line(`TSS_${To} *dt_${a.name} = (TSS_${To} *)(a_${a.name}->data + 8);`);
    this.line(`(void)dt_${a.name};`);
    this.created.add(a.name);
    this.pendingInit.delete(a.name);
    return undefined;
  }

  /** Whether a helper (or one it calls) grows a Vec, which needs the instruction's SystemProgram for rent. */
  private helperGrows(body: ts.Node, seen = new Set<ts.Node>()): boolean {
    if (seen.has(body)) return false;
    seen.add(body);
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        // Vec.push(value, payer) grows the account; FixedVec.push(value) does not.
        if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "push" && n.arguments.length === 2) found = true;
        else if (ts.isIdentifier(n.expression)) {
          const name = calleeName(n.expression, this.model.helperDecls, this.checker);
          const callee = name ? (this.model.generics.get(name)?.node ?? this.model.helpers.get(name)?.node) : undefined;
          if (callee && this.helperGrows(callee, seen)) found = true;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return found;
  }

  /**
   * A helper given a closure (a function that reads the caller's variables) for a function parameter: a closure only
   * runs where it is declared, so the helper is expanded here, like a closure, with the closure bound to the
   * parameter. Helpers expanded so take values (not accounts) and have no type parameters.
   */
  protected helperWithClosure(node: ts.CallExpression): { value: Value | undefined } | undefined {
    const g = this.givenClosure(node);
    if (!g) return undefined;
    // Type parameters: bound from the call (as an instance would be) while the body is expanded.
    const saved = this.scope;
    if (g.typeParams.length) {
      const typeArgs = this.typeArgsOf(node, g);
      const bound = new Map<string, ScalarType>();
      const structs = new Map<string, string>();
      g.typeParams.forEach((n, i) => {
        const t = typeArgs[i]!;
        if (t.kind === "struct") structs.set(n, t.name);
        else bound.set(n, t);
      });
      this.scope = { ...this.scope, typeArgs: bound, structArgs: structs };
    }
    try {
      return { value: this.expandClosure({ node: g.node, name: g.display, scopes: [], env: this.noEnv(), imports: g.imports }, node.arguments, node) };
    } finally {
      this.scope = saved;
    }
  }

  /** The function a function returns (`return (x) => x + n`, or an arrow body `(n) => (x) => x + n`), if it returns one. */
  protected returnedFunction(fn: Closure["node"]): ts.ArrowFunction | ts.FunctionExpression | undefined {
    const strip = (e: ts.Expression | undefined): ts.Expression | undefined => (e && ts.isParenthesizedExpression(e) ? strip(e.expression) : e);
    const body = fn.body;
    let ret: ts.Expression | undefined;
    if (body && !ts.isBlock(body)) ret = strip(body);
    else if (body && body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!)) ret = strip(body.statements[0].expression);
    if (ret && (ts.isArrowFunction(ret) || ts.isFunctionExpression(ret))) return ret;
    if (fn.type && ts.isFunctionTypeNode(fn.type))
      this.fail(fn, "a function that returns a function has one statement: return (x) => … (the function it makes)");
    return undefined;
  }

  /**
   * `adder(5n)`, where `adder` returns a function: the arguments are evaluated here into locals of the current block,
   * and the function it returns is bound to them as a closure (expanded where it is called, like any closure).
   */
  protected madeFunction(call: ts.CallExpression): Closure | undefined {
    if (!ts.isIdentifier(call.expression)) return undefined;
    const local = this.lookup(call.expression.text);
    let maker: Closure | undefined = local?.closure;
    if (!maker && !local) {
      const name = calleeName(call.expression, this.model.helperDecls, this.checker) ?? call.expression.text;
      const f = this.model.factories.get(name);
      if (f) maker = { node: f.node, name: call.expression.text, scopes: [], env: this.noEnv(), imports: f.imports };
    }
    if (!maker) return undefined;
    const made = this.returnedFunction(maker.node);
    if (!made) return undefined;
    const fn = maker.node;
    if (call.arguments.length !== fn.parameters.length) this.fail(call, `${maker.name}() takes ${fn.parameters.length} argument(s)`);
    const params = new Map<string, Local>();
    fn.parameters.forEach((p, i) => {
      if (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken) this.fail(p, "parameters are plain names");
      const arg = call.arguments[i]!;
      if (p.type && ts.isFunctionTypeNode(p.type)) {
        params.set(p.name.text, { c: "", type: BOOL, mutable: false, closure: this.closureOf(arg) });
        return;
      }
      const annotated = p.type ? resolveValueType(p.type, this.scope) : undefined;
      let v = this.expr(arg, annotated);
      if (v.literal !== undefined && !annotated) v = this.literal(v.literal, U64, arg);
      const type = annotated ?? v.type;
      if (!["int", "bool", "pubkey", "string", "enum", "option"].includes(type.kind))
        this.fail(arg, `the function made keeps integers, booleans, Pubkeys, strings, enums or Options, not ${typeName(type)}`);
      v = this.expect(v, type, arg);
      const c = `l_${p.name.text}_${this.temp++}`;
      if (type.kind === "pubkey") this.line(`SolPubkey ${c} = *(${v.c});`);
      else this.line(`${valueC(type)} ${c} = ${this.ownedString(v).c};`);
      params.set(p.name.text, { c, type, mutable: true });
    });
    return { node: made, name: `the function ${maker.name}() made`, scopes: [...maker.scopes, params], env: maker.env, imports: maker.imports };
  }

  /** A function given for a function parameter of an expanded helper or closure, as something to expand. */
  protected closureOf(arg: ts.Expression): Closure {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))
      return { node: arg, name: "the function passed", scopes: [...this.scopes], env: this.envNow(), imports: this.scope.imports };
    if (ts.isIdentifier(arg)) {
      const l = this.lookup(arg.text);
      if (l?.closure) return l.closure;
      const name = calleeName(arg, this.model.helperDecls, this.checker) ?? arg.text;
      const h = this.model.helpers.get(name) ?? this.model.generics.get(name);
      if (h) return { node: h.node, name: h.display, scopes: [], env: this.noEnv(), imports: h.imports };
    }
    this.fail(arg, "pass a function: its name, or an arrow written here");
  }

  protected callHelper(node: ts.CallExpression, h: Helper): Value | undefined {
    if (this.ix && !this.ix.accounts.some((a) => a.kind.kind === "system" && !a.optional) && h.params.some((p) => p.account) && this.helperGrows(h.node))
      this.fail(node, `${h.display}() grows a Vec (push): the instruction needs a SystemProgram parameter to top up rent`);
    // Function arguments were bound when the helper was instantiated: they have no C parameter.
    const argNodes = h.fnArgIndexes ? node.arguments.filter((_, i) => !h.fnArgIndexes!.includes(i)) : node.arguments;
    if (argNodes.length !== h.params.length) this.fail(node, `${h.display}() takes ${h.params.length} argument(s)`);
    // Arguments are evaluated left to right: settle earlier ones when a later one runs statements.
    // A helper that takes accounts may change account data, so account text it gets is copied first.
    // A RemainingAccount(s) parameter counts: the helper may load and write a struct through it.
    const takesAccounts = h.params.some((p) => p.account || p.type.kind === "account" || p.type.kind === "remaining");
    const values: Value[] = [];
    const pieces: (number | string)[] = [];
    h.params.forEach((p, i) => {
      const n = argNodes[i];
      const mark = this.lines.length;
      const raw = this.helperArg(h, p, n);
      for (let j = 0; j < values.length; j++) values[j] = this.settle(values[j], mark);
      if (typeof raw === "string") pieces.push(raw);
      else {
        pieces.push(values.length);
        values.push(takesAccounts ? this.ownedString(raw) : raw);
      }
    });
    if (h.params.some((p) => p.inout))
      this.checkInoutCall(
        node,
        h,
        argNodes,
        pieces.map((x) => (typeof x === "string" ? x : undefined)),
      );
    // A helper that takes a writable struct account may replace anything stored in it (see assertNotAliased).
    for (const [i, p] of h.params.entries())
      if (p.account && p.account.kind === "account" && p.account.mut && ts.isIdentifier(argNodes[i]))
        this.assertNotAliased([argNodes[i].text], node, h.display);
    const args = ["params", ...pieces.map((x) => (typeof x === "number" ? (values[x].type.kind === "pubkey" ? `*(${values[x].c})` : values[x].c) : x))];
    if (!h.returns) {
      this.line(`TS_TRY(fn_${h.name}(${args.join(", ")}));`);
      return undefined;
    }
    const t = this.tmp();
    if (h.returns.kind === "struct") {
      // The result lives in a local the caller owns: a reference to it reads and copies like any struct. Declared at
      // the top of the function, so a reference taken inside a block (a ternary's branch) stays valid after it.
      this.hoisted.push(`  TSS_${h.returns.name} ${t};`);
      this.line(`TS_TRY(fn_${h.name}(${[...args, `&${t}`].join(", ")}));`);
      return { c: `(&${t})`, type: { kind: "structRef", struct: h.returns.name, writable: true } };
    }
    if (h.returns.kind === "string") {
      this.line(`TS_Str ${t};`);
      this.line(`TS_TRY(fn_${h.name}(${[...args, `&${t}`].join(", ")}));`);
      return { c: t, type: STRING };
    }
    this.line(`${scalarC(h.returns)} ${t};`);
    this.line(`TS_TRY(fn_${h.name}(${[...args, `&${t}`].join(", ")}));`);
    return h.returns.kind === "pubkey" ? { c: `(&${t})`, type: h.returns } : { c: t, type: h.returns };
  }

  /** One helper argument: a C argument list fragment (accounts, seeds, references) or a value to settle. */
  protected helperArg(h: Helper, p: Helper["params"][number], n: ts.Expression): Value | string {
    if (p.account) {
      // A struct of this program loaded with loadAccount / loadAccountMut: its account, as Account<T> / Mut<T>.
      const l = ts.isIdentifier(n) ? this.lookup(n.text) : undefined;
      if (l?.loaded) {
        const want = p.account;
        if (want.kind !== "account" || want.struct.name !== l.loaded.struct || want.struct.layout === "borsh" || want.struct.vec)
          this.fail(n, `${h.name}() takes ${p.name} as another kind of account; ${(n as ts.Identifier).text} is a loaded ${l.loaded.struct}`);
        if (want.mut && !l.loaded.mut) this.fail(n, `${h.name}() takes ${p.name} as Mut<${l.loaded.struct}>: load it with loadAccountMut`);
        return l.loaded.handle;
      }
      // A program or sysvar programAt / sysvarAt checked: as that kind of account.
      const at = this.programAtValue(n);
      if (at) {
        const why = accountMismatch(at.kind, p.account);
        if (why) this.fail(n, `${h.name}() takes ${p.name} as ${why}`);
        return at.c;
      }
      const acct = this.accountParam(n, `${h.name}()'s ${p.name}`);
      const why = accountMismatch(acct.kind, p.account);
      if (why) this.fail(n, `${h.name}() takes ${p.name} as ${why}`);
      // A @layout borsh account goes with the struct it is being worked on as.
      if (p.account.kind === "account" && p.account.struct.layout === "borsh") return `a_${acct.name}, d_${acct.name}`;
      if (p.account.kind === "account" && p.account.mut && p.account.struct.vec) return `a_${acct.name}, entry_${acct.name}`;
      return `a_${acct.name}`;
    }
    if (p.inout) return this.inoutArg(h, p, n);
    switch (p.type.kind) {
      case "signerSeeds": {
        const seeds = this.signerSeedsArg(n);
        return `${seeds.name}, ${seeds.count}`;
      }
      case "structRef":
      case "arrayArg": {
        const want: FieldType = p.type.kind === "structRef" ? { kind: "struct", name: p.type.struct } : p.type.array;
        const built = this.literalArg(n, want);
        if (built) return built;
        let r = this.ref(n);
        // A narrowed Option<Struct> / Option<FixedArray> place (`c.opt !== null` before it): its value.
        if (r && r.type.kind === "option" && sameType(r.type.inner as FieldType, want)) r = this.someValue(r);
        if (!r || !sameType(r.type, want)) this.fail(n, `expected a ${typeName(want)}`);
        return this.snapshotPlace(r.lv, want, h, n);
      }
      case "dataEnumArg": {
        const built = this.literalArg(n, { kind: "dataEnum", name: p.type.name });
        if (built) return built;
        const r = this.ref(n);
        if (!r || r.type.kind !== "dataEnum" || r.type.name !== p.type.name) this.fail(n, `expected a ${p.type.name}`);
        return this.snapshotPlace(r.lv, { kind: "dataEnum", name: p.type.name }, h, n);
      }
      case "vecArg": {
        // A slice of a Vec argument or the instruction data: a view of its own, passed like the list.
        if (!ts.isIdentifier(n) && this.isVecArgView(n)) {
          const v = this.vecArgView(n)!;
          if (!sameType(v.type, p.type)) this.fail(n, `expected a ${typeName(p.type)}`);
          return v.c;
        }
        const l = ts.isIdentifier(n) ? this.lookup(n.text) : undefined;
        // An Option<Vec<T>> argument passes as its list once checked against null (TypeScript narrows it).
        const t = l?.type.kind === "vecArg" && l.type.optional ? { ...l.type, optional: undefined } : l?.type;
        if (l && t && sameType(t, p.type)) return l.c;
        // A list of the caller's (a local FixedVec or FixedArray, a field of a local struct, or one in account data): a
        // read-only view of its elements, passed by pointer.
        const view = this.listViewArg(n, p.type, h);
        if (view) return view;
        const what = p.type.elem.kind === "int" && p.type.elem.name === "u8" && p.type.cap === undefined ? "list of u8" : `list of ${typeName(p.type.elem)}`;
        this.fail(
          n,
          `expected a ${what}: an instruction argument, the instruction data or a slice of it, or a FixedVec / FixedArray of ${typeName(p.type.elem)} (a local, a field)`,
        );
      }
      default:
        return this.expect(this.expr(n, p.type), p.type, n);
    }
  }

  /**
   * An `Inout<T>` argument: a pointer to the caller's place itself (never a copy), which must be writable. A literal
   * (`f({ … })`, `fixedArray(…)`) is built in a local of its own, as JS passes a fresh object; a ternary must pick
   * between two places (a literal branch would be a copy the helper's writes never reach).
   */
  protected inoutArg(h: Helper, p: Helper["params"][number], n: ts.Expression): string {
    const want = p.inout!;
    const what = `Inout<${typeName(want)}>`;
    let bare = n;
    while (ts.isParenthesizedExpression(bare)) bare = bare.expression;
    if (want.kind !== "vec" && (ts.isObjectLiteralExpression(bare) || (ts.isCallExpression(bare) && this.exportName(bare.expression) === "fixedArray")))
      return this.literalArg(n, want)!;
    if (ts.isConditionalExpression(bare)) {
      if (want.kind !== "struct") this.fail(n, `${h.display}() takes ${p.name} as ${what}: pass the list itself, not a choice between lists`);
      const place = this.structPlace(bare);
      if (!place)
        this.fail(n, `${h.display}() takes ${p.name} as ${what}: both branches must be ${want.name} places (a local, a field, a list element), not values`);
      if (place.struct !== want.name) this.fail(n, `${h.display}() takes ${p.name} as ${what}; this is a ${place.struct}`);
      if (!place.writable) this.fail(n, `${h.display}() changes ${p.name} (Inout), and a branch of this choice is read-only`);
      return place.ptr;
    }
    let r = this.ref(n);
    // A narrowed Option<Struct> / Option<FixedArray> place (`c.opt !== null` before it): the value inside it.
    if (r && r.type.kind === "option" && sameType(r.type.inner as FieldType, want)) r = this.someValue(r);
    if (!r || !sameType(r.type, want)) {
      const l = ts.isIdentifier(n) ? this.lookup(n.text) : undefined;
      if (l?.type.kind === "vecArg" || l?.type.kind === "optionArg")
        this.fail(n, `${h.display}() changes ${p.name} (Inout): instruction arguments are read-only; copy the value into a local first`);
      this.fail(n, `${h.display}() takes ${p.name} as ${what}: pass a ${typeName(want)} place of yours (a local, a field, a list element) for it to change`);
    }
    if (!r.writable) this.fail(n, `${h.display}() changes ${p.name} (Inout): ${this.readOnly(r)}`);
    if (r.vec?.slice) this.fail(n, `${h.display}() takes ${p.name} as ${what}: pass the list, not a slice of it`);
    return `(&${r.lv})`;
  }

  /**
   * The rules of a call with `Inout<T>` arguments, so the helper's pointer is the only way to the place while it runs
   * (Rust's one `&mut` at a time) and stays valid: no other argument may share storage with an Inout one (two places,
   * one inside the other, the same list's elements whatever their indexes, an account and a place in it); a place in
   * a list whose elements can move is refused when the call may move them; a reference into the place read after the
   * call is refused (the helper may replace what it points at). Places whose roots differ but may be the same bytes at
   * run time (two `Dup<…>` accounts, two loadRawMut views under NATIVE_ACCOUNT_WRITES, a helper's account parameters)
   * are compared at run time (2040).
   */
  protected checkInoutCall(node: ts.CallExpression, h: Helper, argNodes: readonly ts.Expression[], passed: (string | undefined)[]) {
    const show = (e: ts.Expression) => {
      try {
        return e.getText();
      } catch {
        return "this argument";
      }
    };
    const fresh = (e: ts.Expression): boolean => {
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      // A literal, or a struct a helper returns: a value of its own that nothing else reaches.
      if (ts.isObjectLiteralExpression(e)) return true;
      if (!ts.isCallExpression(e)) return false;
      return this.exportName(e.expression) === "fixedArray" || this.helperOf(e)?.returns?.kind === "struct";
    };
    // Each argument passed by reference (Inout, read-only structs and lists, accounts, loaded structs) and its storage.
    const refs: { i: number; inout: boolean; paths: string[] }[] = [];
    h.params.forEach((p, i) => {
      const n = argNodes[i]!;
      if (p.inout) {
        const paths = this.pathsOf(n);
        if (!paths && !fresh(n))
          this.fail(n, `${h.display}() changes ${p.name} (Inout): pass a local, a field path or a list element (bind anything else to a const first)`);
        if (paths) refs.push({ i, inout: true, paths });
        return;
      }
      const byRef = p.account || p.type.kind === "structRef" || p.type.kind === "arrayArg" || p.type.kind === "dataEnumArg" || p.type.kind === "vecArg";
      const paths = byRef ? this.pathsOf(n) : undefined;
      if (paths) refs.push({ i, inout: false, paths });
    });
    for (let a = 0; a < refs.length; a++)
      for (let b = a + 1; b < refs.length; b++) {
        const x = refs[a]!;
        const y = refs[b]!;
        if ((!x.inout && !y.inout) || !this.placesOverlap(x.paths, y.paths)) continue;
        const [w, o] = x.inout ? [x, y] : [y, x];
        const wn = show(argNodes[w.i]!);
        const on = show(argNodes[o.i]!);
        const op = h.params[o.i]!;
        const why = `${wn} and ${on} share storage, and ${h.display}() changes ${h.params[w.i]!.name} (Inout) in place: while it runs, its parameter must be the only way to that place`;
        if (op.inout)
          this.fail(
            argNodes[Math.max(w.i, o.i)]!,
            `${why}. Two elements of one list count as one place whatever their indexes; pass what holds both, or copy one into a local and store it back after the call`,
          );
        if (op.account) this.fail(argNodes[o.i]!, `${why}. Pass the account alone and reach ${wn} through it in the helper, or pass only ${wn}`);
        this.fail(argNodes[o.i]!, `${why}. Copy ${on} into a local first (const copy: T = ${on}) and pass the copy`);
      }
    for (const r of refs) {
      if (!r.inout) continue;
      const n = argNodes[r.i]!;
      if (this.throughMovableList(n) && this.mayResizeVecs(node))
        this.fail(
          n,
          `${show(n)} is in a list whose elements move when it grows, shrinks or is filtered (a Vec or BigVec), and ${h.display}() may do that (it takes writable or remaining accounts) while it holds ${show(n)}; copy the element into a local (const e: T = …), pass the local and store it back after the call`,
        );
      this.assertNothingInside(r.paths, node, h.display, show(n));
    }
    // Different roots that may still be the same bytes: compared at run time.
    const root = (p: string) => p.split(/[.[]/)[0]!;
    const local = (c: string) => {
      for (const s of [...this.scopes, this.args]) for (const l of s.values()) if (l.c === c) return l;
      return undefined;
    };
    const mayShare = (a: string, b: string): boolean => {
      if (a === b) return false;
      const acct = (r: string) => (r.startsWith("@") ? undefined : this.accounts.get(r));
      const view = (r: string) => (r.startsWith("@") && local(r.slice(1))?.view ? r : undefined);
      const [aa, ba] = [acct(a), acct(b)];
      if (aa && ba) return aa.index === -1 || ba.index === -1 || !!aa.constraints.dup || !!ba.constraints.dup;
      if (!this.nativeAccountWrites()) return false;
      return !!((aa || view(a)) && (ba || view(b)));
    };
    const inouts = refs.filter((r) => r.inout && passed[r.i]);
    for (let a = 0; a < inouts.length; a++)
      for (let b = a + 1; b < inouts.length; b++) {
        const x = inouts[a]!;
        const y = inouts[b]!;
        if (!x.paths.some((p) => y.paths.some((q) => mayShare(root(p), root(q))))) continue;
        const [pa, pb] = [passed[x.i]!, passed[y.i]!];
        this.line(
          `if ((uint8_t *)${pa} < (uint8_t *)${pb} + sizeof(*${pb}) && (uint8_t *)${pb} < (uint8_t *)${pa} + sizeof(*${pa})) TS_FAIL(TS_ERR_DUPLICATE_MUT, ${cString(`TypeSOL: ${h.display}() was given ${show(argNodes[x.i]!)} and ${show(argNodes[y.i]!)}, which share storage`)});`,
        );
      }
  }

  /**
   * A struct, array or data-enum helper argument written as a literal (`f({ a: 1n, b: { c } })`, `g([1n, 2n])`, or a
   * ternary with a literal branch): built in a local of its own, as `const x: T = { … }; f(x)` would, and passed by
   * pointer (the helper cannot change it, and nothing else sees it). Undefined for anything else.
   */
  protected literalArg(n: ts.Expression, want: FieldType): string | undefined {
    const literal = (e: ts.Expression): boolean => {
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isConditionalExpression(e)) return literal(e.whenTrue) || literal(e.whenFalse);
      if (want.kind === "array") return ts.isCallExpression(e) && this.exportName(e.expression) === "fixedArray";
      return ts.isObjectLiteralExpression(e);
    };
    if (!literal(n)) return undefined;
    if (want.kind === "struct") {
      const s = this.model.structs.get(want.name)!;
      if (s.size === undefined || s.vec) this.fail(n, `${s.name} has variable-size fields and cannot be built as an argument`);
    }
    const t = this.tmp("larg");
    this.line(`${want.kind === "array" ? storageDecl(want, t) : `${fieldC(want)} ${t}`};`);
    this.writeAggregate({ lv: t, type: want, writable: true }, n, true);
    return `(&${t})`;
  }

  /**
   * A struct/array/data-enum helper argument. Helpers that take accounts may change account data, so they get a
   * copy taken at the call (JS passes the object as it was); other helpers cannot write, so a pointer is enough.
   */
  protected snapshotPlace(lv: string, type: FieldType, h: Helper, node?: ts.Expression): string {
    if (!h.params.some((p) => p.account || p.type.kind === "account" || p.type.kind === "remaining")) return `(&${lv})`;
    // A struct this function owns (a literal, or a helper's result it holds), or part of one, is not account data: what
    // the helper writes cannot change it, so the helper reads it in place.
    if (node && this.ownedRoot(node)) return `(&${lv})`;
    const n = this.fieldBytes(type);
    // One buffer per call site, allocated on first use: a call in a loop must not take new heap every pass.
    const t = this.tmp("argc");
    this.hoistLazy(t, (n) => (type.kind === "array" ? storageDecl(type, `(*${n})`) : `${fieldC(type)} *${n}`));
    this.line(`if (${t} == NULL) TS_TRY(ts_alloc(${n}, (uint8_t **)&${t}));`);
    this.line(`ts_memcpy(${t}, &${lv}, ${n});`);
    return t;
  }

  /**
   * A FixedVec or FixedArray of `elem` given for a read-only list parameter: a `TS_VecArg` view of its elements (the
   * length as it is at the call). A list this function holds (a local, a field of a struct it owns) is read in place;
   * one in account data is copied first when the helper takes accounts, as a struct argument is (the helper may write
   * the account). Undefined when `n` is not such a list.
   */
  protected listViewArg(n: ts.Expression, want: ValueType & { kind: "vecArg" }, h: Helper): string | undefined {
    const r = this.probe(() => this.ref(n));
    if (!r) return undefined;
    const elem = want.elem;
    // A FixedVec<T, N> parameter holds at most N elements: a list with room for more is refused here, as an
    // instruction argument with more is refused when decoded.
    const holds = r.type.kind === "vec" ? r.type.cap : r.type.kind === "array" ? r.type.len : undefined;
    if (want.cap !== undefined && holds !== undefined && holds > want.cap && (r.type.kind === "vec" || r.type.kind === "array") && sameType(r.type.elem, elem))
      this.fail(
        n,
        `${h.display}() takes at most ${want.cap} elements here (FixedVec<${typeName(elem)}, ${want.cap}>) and this list holds up to ${holds}: declare the parameter FixedVec<${typeName(elem)}, ${holds}> (or InstructionBytes / Vec<${typeName(elem)}>, no limit)`,
      );
    let items: string;
    let count: string;
    let room: number;
    if (r.type.kind === "vec" && r.type.cap !== undefined && !r.type.heap && !r.type.big && !r.type.raw && r.vec && !r.vec.slice) {
      if (!sameType(r.type.elem, elem)) return undefined;
      const fresh = this.ref(n)!;
      items = fresh.vec!.items;
      count = vecCount(fresh.vec!);
      room = r.type.cap;
    } else if (r.type.kind === "array") {
      if (!sameType(r.type.elem, elem)) return undefined;
      items = this.ref(n)!.lv;
      count = String(r.type.len);
      room = r.type.len;
    } else return undefined;
    const size = this.fieldBytes(elem);
    const t = this.tmp("lview");
    if (h.params.some((p) => p.account || p.type.kind === "account" || p.type.kind === "remaining") && !this.callerHoldsList(n)) {
      // One buffer per call site, allocated on first use: a call in a loop must not take new heap every pass.
      const buf = this.tmp("argl");
      this.hoistLazy(buf, (v) => `uint8_t *${v}`);
      this.line(`if (${buf} == NULL) TS_TRY(ts_alloc(${room * size}, &${buf}));`);
      this.line(`TS_VecArg ${t} = {${buf}, (uint32_t)${count}};`);
      this.line(`ts_memcpy_bulk(${buf}, (const uint8_t *)${items}, (uint64_t)${t}.len * ${size});`);
      return t;
    }
    this.line(`TS_VecArg ${t} = {(const uint8_t *)${items}, (uint32_t)${count}};`);
    return t;
  }

  /** Whether `node` is a list this function holds on its stack (a local list, a field of a struct it owns), not account data. */
  protected callerHoldsList(node: ts.Expression): boolean {
    let n: ts.Expression = node;
    for (;;) {
      if (ts.isParenthesizedExpression(n)) n = n.expression;
      else if (ts.isPropertyAccessExpression(n)) n = n.expression;
      else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get") n = n.expression.expression;
      else break;
    }
    if (!ts.isIdentifier(n)) return false;
    const l = this.lookup(n.text);
    if (!l) return false;
    // A declared list local has no storage paths; an Inout parameter's (`@p_x`) may be account data.
    if ((l.type.kind === "vec" || l.type.kind === "array") && !l.paths && !l.readonly) return true;
    return !!l.owned;
  }

  /** Whether `node` is (part of) a struct value this function owns: `h`, `h.inner`, `h.list.get(i)`. */
  protected ownedRoot(node: ts.Expression): boolean {
    let n: ts.Expression = node;
    for (;;) {
      if (ts.isParenthesizedExpression(n)) n = n.expression;
      else if (ts.isPropertyAccessExpression(n)) n = n.expression;
      else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get") n = n.expression.expression;
      else break;
    }
    return ts.isIdentifier(n) && !!this.lookup(n.text)?.owned;
  }

  /** `signer([...seeds])` (one PDA signature), or a SignerSeeds parameter passed on. */
  protected signerSeedsArg(n: ts.Expression): { name: string; count: number | string } {
    if (ts.isIdentifier(n)) {
      const l = this.lookup(n.text);
      if (l?.type.kind === "signerSeeds") return { name: l.c, count: `${l.c}__n` };
    }
    if (ts.isCallExpression(n) && this.exportName(n.expression) === "signer") {
      if (n.arguments.length !== 1) this.fail(n, "signer([...seeds]) takes the seeds (with the bump) as an array; signer([]) signs for nothing");
      return this.seeds(n.arguments[0], 0);
    }
    this.fail(n, "pass signer([...seeds with the bump]) or a SignerSeeds parameter");
  }

  /** Whether `require`'s error is named in the source (an error enum member, AnchorError.X or a message). */
  protected namesError(node: ts.Expression): boolean {
    if (ts.isStringLiteral(node)) return true;
    if (!ts.isPropertyAccessExpression(node)) return false;
    if (this.exportName(node.expression) === "AnchorError" || this.exportName(node.expression) === "ProgramError") return true;
    return ts.isIdentifier(node.expression) && this.model.errorEnums.has(node.expression.text);
  }

  protected errorRef(node: ts.Expression): ErrorDef {
    // `AnchorError.X`: one of Anchor's own codes (not one of this program's errors, so not in the IDL).
    if (ts.isPropertyAccessExpression(node) && this.exportName(node.expression) === "AnchorError") {
      const code = ANCHOR_ERRORS[node.name.text];
      if (code === undefined) this.fail(node.name, `AnchorError has no ${node.name.text}`);
      return { code, name: node.name.text, msg: node.name.text };
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const def = this.model.errorEnums.get(node.expression.text)?.get(node.name.text);
      if (def) return def;
    }
    if (ts.isStringLiteral(node)) {
      const existing = this.model.errors.find((e) => e.msg === node.text && e.name.startsWith("RequireFailed"));
      if (existing) return existing;
      const code = Math.max(5999, ...this.model.errors.map((e) => e.code)) + 1;
      const def = { code, name: `RequireFailed${code - 6000}`, msg: node.text };
      this.model.errors.push(def);
      return def;
    }
    this.fail(node, "the error must be a member of an exported error enum or a string literal");
  }

  /** The struct of `returnData<Quote>(…)`, when T is one; refused when its bytes are not its Borsh form. */
  protected returnedStruct(node: ts.CallExpression): StructDef | undefined {
    const targ = node.typeArguments?.[0];
    const name = targ && structNameOf(targ, this.scope);
    const s = name ? this.model.structs.get(name) : undefined;
    if (!s) return undefined;
    if (s.layout !== "borsh" && !borshIdentical({ kind: "struct", name: s.name }, this.model))
      this.fail(targ!, `${s.name} holds Options or FixedStrings, whose fixed layout is not Borsh: declare it /** @layout borsh */ to read it as return data`);
    return s;
  }

  protected returnData(node: ts.CallExpression): Value {
    if (this.returnedStruct(node)) this.fail(node, "bind a returned struct to a local: const quote = returnData<Quote>(program)");
    const targ = node.typeArguments?.[0];
    const t = targ && resolveScalarType(targ, this.scope);
    if (!t) this.fail(node, "returnData needs an explicit type: returnData<u64>(program)");
    if (node.arguments.length !== 1) this.fail(node, "returnData<T>(program) takes the program that returned it");
    const program = this.anyAccount(node.arguments[0], "returnData's program");
    const out = this.tmp("rd");
    if (t.kind === "pubkey") {
      this.line(`SolPubkey ${out};`);
      this.line(`TS_TRY(ts_return_data(${program}, (uint8_t *)&${out}, 32));`);
      return { c: `(&${out})`, type: t };
    }
    if (t.kind === "bool") {
      this.line(`uint8_t ${out};`);
      this.line(`TS_TRY(ts_return_data(${program}, &${out}, 1));`);
      this.line(`if (${out} > 1) TS_FAIL(TS_ERR_RETURN_DATA, "TypeSOL: invalid bool return data");`);
      return { c: `(${out} == 1)`, type: BOOL };
    }
    if (t.kind === "enum") {
      this.line(`uint8_t ${out};`);
      this.line(`TS_TRY(ts_return_data(${program}, &${out}, 1));`);
      this.line(`if (${out} >= ${this.model.enums.get(t.name)!.variants.length}) TS_FAIL(TS_ERR_RETURN_DATA, "TypeSOL: invalid enum return data");`);
      return { c: out, type: t };
    }
    this.line(`${INT_INFO[t.name].c} ${out};`);
    this.line(`TS_TRY(ts_return_data(${program}, (uint8_t *)&${out}, ${INT_INFO[t.name].bytes}));`);
    return { c: out, type: t };
  }
}
