import ts from "typescript";
import { MAX_RETURN_DATA, calleeName, resolveScalarType, resolveValueType, structNameOf, typesolName } from "../analyze.js";
import { INT_INFO, type AccountParam, type FieldType, type ScalarType, type ValueType, isScalar, optionKey, scalarSize, typeName } from "../model.js";
import {
  U64,
  BOOL,
  type Value,
  type Local,
  type Closure,
  type FunctionChoice,
  type Ref,
  cString,
  fixedVecC,
  helperSignature,
  optC,
  scalarC,
  scalarStorageC,
  storageDecl,
  valueC,
} from "./shared.js";
import { CpiEmitter } from "./cpi.js";
import { cTokens, declaredNames, isGlobalName, parameterDecls, usedNames } from "./outline.js";

/**
 * Statements: variables, assignment, control flow and return.
 */
export abstract class StatementEmitter extends CpiEmitter {
  protected statement(stmt: ts.Statement, topLevel = false): void {
    const outer = this.where;
    this.where = this.location(stmt);
    // --profile: a marker and the remaining compute units before every statement (see profile.ts).
    if (this.profile && !ts.isBlock(stmt)) {
      this.line(`sol_log(${cString(`ts:${this.where}`)});`);
      this.line(`sol_log_compute_units();`);
    }
    try {
      this.statementInner(stmt, topLevel);
    } finally {
      this.where = outer;
    }
  }

  protected statementInner(stmt: ts.Statement, topLevel: boolean): void {
    if (ts.isVariableStatement(stmt)) return this.variable(stmt.declarationList, topLevel);
    if (ts.isExpressionStatement(stmt)) return this.expressionStatement(stmt.expression, topLevel);
    if (ts.isIfStatement(stmt)) {
      const cond = this.expect(this.expr(stmt.expression, BOOL), BOOL, stmt.expression);
      this.line(`if (${cond.c}) {`);
      this.block(() => this.body(stmt.thenStatement));
      if (stmt.elseStatement) {
        this.line(`} else {`);
        this.block(() => this.body(stmt.elseStatement!));
      }
      this.line(`}`);
      return;
    }
    if (ts.isBlock(stmt)) {
      this.line(`{`);
      this.block(() => stmt.statements.forEach((s) => this.reporter.guard(() => this.statement(s))));
      this.line(`}`);
      return;
    }
    if (ts.isReturnStatement(stmt)) return this.returnStatement(stmt);
    if (ts.isSwitchStatement(stmt)) return this.switchStatement(stmt);
    if (ts.isForStatement(stmt)) return this.forLoop(stmt);
    if (ts.isForOfStatement(stmt)) return this.forOf(stmt);
    if (ts.isWhileStatement(stmt)) return this.loop(stmt.expression, stmt.statement, undefined);
    if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
      if (stmt.label) this.fail(stmt, "labeled break/continue is not supported");
      if (!this.loops.length) this.fail(stmt, `${ts.isBreakStatement(stmt) ? "break" : "continue"} outside a loop`);
      // Inside a switch, `break` leaves the switch (as in JS) and `continue` targets the enclosing loop.
      if (ts.isContinueStatement(stmt) && !this.loops.at(-1)) this.fail(stmt, "continue outside a loop");
      this.line(ts.isBreakStatement(stmt) ? `break;` : `goto ${this.loops.at(-1)};`);
      return;
    }
    if (ts.isDoStatement(stmt)) return this.doLoop(stmt);
    if (ts.isForInStatement(stmt)) this.fail(stmt, "for … in is not supported: use for (init; cond; step), for (const x of list), while or do … while");
    if (ts.isThrowStatement(stmt)) this.fail(stmt, 'throw is not supported: fail the instruction with require(false, ErrorCode.X) or require(cond, "message")');
    if (ts.isTryStatement(stmt))
      this.fail(stmt, "try/catch is not supported: a failed check or CPI aborts the whole instruction, so check first with require(…)");
    this.fail(stmt, `${ts.SyntaxKind[stmt.kind]} is not supported in TypeSOL`);
  }

  protected returnStatement(stmt: ts.ReturnStatement) {
    const frame = this.inlineFrames.at(-1);
    if (frame) return this.closureReturn(stmt, frame);
    const returns = this.helper ? this.helper.returns : this.ix!.returns;
    if (!returns) {
      if (stmt.expression) this.fail(stmt, this.helper ? "this helper returns void" : "this instruction returns void; use `return;`");
      for (const l of this.epilogue()) this.line(l);
      this.line(`return SUCCESS;`);
      return;
    }
    if (returns.kind === "struct") {
      if (!stmt.expression) this.fail(stmt, `return a ${returns.name}`);
      if (this.helper) {
        // Write the struct through the caller's out pointer (a literal, a place or another helper's result).
        this.writeAggregate({ lv: "(*ret)", type: returns, writable: true }, stmt.expression);
        this.line(`return SUCCESS;`);
        return;
      }
      // Return data: the struct's fixed layout, which the IDL describes field by field.
      const t = this.tmp("ret");
      this.line(`TSS_${returns.name} ${t};`);
      this.writeAggregate({ lv: t, type: returns, writable: true }, stmt.expression);
      if (this.model.structs.get(returns.name)!.layout === "borsh") {
        // A @layout borsh struct returns its Borsh bytes, as Anchor's return data does.
        const b = this.tmp("retb");
        const w = this.tmp("retw");
        this.line(`uint8_t *${b};`);
        this.line(`TS_TRY(ts_alloc(sizeof(${t}), &${b}));`);
        this.line(`uint64_t ${w} = 0;`);
        this.line(`TS_TRY(ts_pack_${returns.name}(&${t}, ${b}, sizeof(${t}), &${w}));`);
        this.line(`sol_set_return_data(${b}, ${w});`);
      } else this.line(`sol_set_return_data((const uint8_t *)&${t}, sizeof(${t}));`);
      for (const l of this.epilogue()) this.line(l);
      this.line(`return SUCCESS;`);
      return;
    }
    if (!stmt.expression) this.fail(stmt, `return a ${typeName(returns)}`);
    const v = this.expect(this.expr(stmt.expression, returns), returns, stmt.expression);
    if (this.helper && returns.kind === "string") {
      // The caller gets its own copy: the text may be account data the caller then changes.
      this.line(`TS_TRY(ts_str_copy(${v.c}, ret));`);
    } else if (this.helper) this.line(returns.kind === "pubkey" ? `*ret = *(${v.c});` : `*ret = ${v.c};`);
    else if (returns.kind === "string") {
      // Return data is the Borsh String: u32 length, then the bytes (at most 1024 in all).
      const s = this.tmp("rets");
      const b = this.tmp("retb");
      this.line(`TS_Str ${s} = ${v.c};`);
      this.line(
        `if (${s}.len > ${MAX_RETURN_DATA - 4}) TS_FAIL(TS_ERR_INSTRUCTION_DATA, "TypeSOL: returned string longer than ${MAX_RETURN_DATA - 4} bytes");`,
      );
      this.line(`uint8_t *${b};`);
      this.line(`TS_TRY(ts_alloc(4 + ${s}.len, &${b}));`);
      this.line(`ts_write_le(${b}, ${s}.len, 4);`);
      this.line(`ts_memcpy(${b} + 4, ${s}.ptr, ${s}.len);`);
      this.line(`sol_set_return_data(${b}, 4 + ${s}.len);`);
    } else if (returns.kind === "pubkey") this.line(`sol_set_return_data((const uint8_t *)(${v.c}), 32);`);
    else {
      // Return data is the Borsh encoding: little-endian at the declared width, bool as one byte.
      const t = this.tmp("ret");
      const ct = scalarStorageC(returns);
      this.line(`${ct} ${t} = (${ct})(${v.c});`);
      this.line(`sol_set_return_data((const uint8_t *)&${t}, ${scalarSize(returns)});`);
    }
    // CloseTo runs after the return value is computed (it wipes the account).
    for (const l of this.epilogue()) this.line(l);
    this.line(`return SUCCESS;`);
  }

  /** `switch` on integers, enums and `.kind` of data enums: a C switch, with JS fallthrough/break semantics. */
  protected switchStatement(stmt: ts.SwitchStatement) {
    const kindPlace = this.kindOf(stmt.expression);
    if (kindPlace) {
      const enumName = (kindPlace.type as { name: string }).name;
      const t = this.tmp("sw");
      this.line(`uint8_t ${t} = ${kindPlace.lv}.tag;`);
      this.line(`switch (${t}) {`);
      const seenVariants = new Set<number>();
      for (const clause of stmt.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          const vi = this.variantIndex(enumName, clause.expression);
          if (seenVariants.has(vi)) this.fail(clause.expression, "duplicate case");
          seenVariants.add(vi);
        }
        this.line(ts.isCaseClause(clause) ? `case ${this.variantIndex(enumName, clause.expression)}: {` : `default: {`);
        this.loops.push(this.loops.at(-1) ?? "");
        this.block(() => clause.statements.forEach((s) => this.reporter.guard(() => this.statement(s))));
        this.loops.pop();
        this.line(`}`);
      }
      this.line(`}`);
      return;
    }
    const subject = this.expr(stmt.expression);
    const typed = subject.literal !== undefined ? this.literal(subject.literal, U64, stmt.expression) : subject;
    if (typed.type.kind !== "int" && typed.type.kind !== "enum") this.fail(stmt.expression, "switch works on integers and enums");
    // C cannot switch on 128-bit values: pick the case's index with comparisons, then switch on that.
    const wide = typed.type.kind === "int" && INT_INFO[typed.type.name].bytes === 16;
    const t = this.tmp("sw");
    this.line(`${scalarC(typed.type as ScalarType)} ${t} = ${typed.c};`);
    const pick = wide ? this.tmp("swi") : undefined;
    const pickAt = this.lines.length;
    const cases: string[] = [];
    if (pick) this.line(`int ${pick} = -1;`);
    this.line(`switch (${pick ?? t}) {`);
    const seen = new Set<string>();
    for (const clause of stmt.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        // C case labels must be compile-time constants: literals, top-level constants or enum members.
        const e = clause.expression;
        const isConstLabel =
          ts.isBigIntLiteral(e) ||
          (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isBigIntLiteral(e.operand)) ||
          (ts.isIdentifier(e) && !this.lookup(e.text) && this.model.constants.has(e.text)) ||
          (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && !this.lookup(e.expression.text) && this.model.enums.has(e.expression.text));
        if (!isConstLabel) this.fail(e, "case labels must be literals, constants or enum members");
        const label = this.expect(this.expr(e, typed.type), typed.type, e);
        if (seen.has(label.c)) this.fail(clause.expression, "duplicate case");
        seen.add(label.c);
        if (pick) {
          cases.push(label.c);
          this.line(`case ${cases.length - 1}: {`);
        } else this.line(`case ${label.c}: {`);
      } else this.line(`default: {`);
      this.loops.push(this.loops.at(-1) ?? "");
      this.block(() => clause.statements.forEach((s) => this.reporter.guard(() => this.statement(s))));
      this.loops.pop();
      this.line(`}`);
    }
    this.line(`}`);
    if (pick && cases.length) {
      const pad = "  ".repeat(this.indent);
      this.lines.splice(pickAt + 1, 0, ...cases.map((c, i) => `${pad}${i ? "else " : ""}if (${t} == ${c}) ${pick} = ${i};`));
    }
  }

  protected forLoop(stmt: ts.ForStatement) {
    this.line(`{`);
    this.block(() => {
      const init = stmt.initializer;
      if (init) {
        if (ts.isVariableDeclarationList(init)) this.variable(init);
        else this.expressionStatement(init, false);
      }
      this.loop(stmt.condition, stmt.statement, stmt.incrementor);
    });
    this.line(`}`);
  }

  /**
   * `for (const x of list)` over a Vec or FixedArray: an index loop that binds `x` as `const x = list.get(i)` would,
   * so elements are values (scalars, strings) or references into the data (structs), with the same aliasing rules.
   * As in JS, the length is read again before every step, so a body that pushes or pops sees the new length.
   */
  protected forOf(stmt: ts.ForOfStatement) {
    if (stmt.awaitModifier) this.fail(stmt, "for await is not supported");
    const list = stmt.initializer;
    const d = ts.isVariableDeclarationList(list) && list.declarations.length === 1 ? list.declarations[0] : undefined;
    if (!d || !(list.flags & ts.NodeFlags.Const) || !ts.isIdentifier(d.name) || d.type)
      this.fail(stmt.initializer, "write for (const x of list): one const name, no type annotation");
    if (this.isRemaining(stmt.expression)) this.fail(stmt.expression, "iterate remaining accounts with for (let i = 0n; i < rest.length; i++) and rest.get(i)");
    if (ts.isArrayLiteralExpression(stmt.expression) && this.functionList(stmt.expression)) return this.forOfFunctions(stmt, d!.name as ts.Identifier);
    if (this.treeForOf(stmt, d!)) return;
    // Synthetic `list.length` / `list.get(i)` nodes placed at the loop, so errors and checks point at the source.
    const f = ts.factory;
    const index = `__of${this.temp++}`;
    const place = <T extends ts.Node>(n: T): T => {
      ts.setTextRange(n, stmt.expression);
      (n as { parent?: ts.Node }).parent = stmt;
      return n;
    };
    void place;
    const ci = this.tmp("of_i");
    const label = this.tmp("ts_continue_");
    const release = this.iterationClaims(stmt.statement);
    this.eachElement(stmt.expression, stmt, { index, ci, next: label, alwaysNext: true, atNext: release, body: stmt.statement }, (element) => {
      // The element's declaration: the source's own name (so aliasing checks find its uses) bound to the element.
      const decl = f.createVariableDeclaration(d.name, undefined, undefined, element);
      ts.setTextRange(decl, d);
      (decl as { parent?: ts.Node }).parent = list;
      const declList = { ...list, flags: ts.NodeFlags.Const, declarations: [decl] } as unknown as ts.VariableDeclarationList;
      this.variable(declList);
      this.loops.push(label);
      this.line(`{`);
      this.block(() => this.body(stmt.statement));
      this.line(`}`);
      this.loops.pop();
    });
  }

  /**
   * `for (const e of tree)` / `for (const e of tree.reversed())` over a RedBlackTree: lib-sokoban's in-order
   * iterator (a stack of nodes, left registers down, then the right one), smallest key first or, reversed, largest
   * first. `e` is the node (`e.key`, `e.value`, `e.index`), each read where it lies. The body may change values
   * but not the tree's structure (insert / remove / initialize on it are compile errors, as Rust's borrow forbids).
   */
  protected treeForOf(stmt: ts.ForOfStatement, d: ts.VariableDeclaration): boolean {
    let src = stmt.expression;
    while (ts.isParenthesizedExpression(src)) src = src.expression;
    let reversed = false;
    if (
      ts.isCallExpression(src) &&
      ts.isPropertyAccessExpression(src.expression) &&
      src.expression.name.text === "reversed" &&
      this.treeOf(src.expression.expression)
    ) {
      if (src.arguments.length) this.fail(src, "reversed() takes no arguments");
      reversed = true;
      src = src.expression.expression;
    }
    const tree = this.treeOf(src);
    if (!tree) return false;
    const t = tree.local.c;
    const S = tree.inst.stride;
    const [down, next] = reversed ? ["TS_RBT_RIGHT", "TS_RBT_LEFT"] : ["TS_RBT_LEFT", "TS_RBT_RIGHT"];
    const stack = this.tmp("rbs");
    const sp = this.tmp("rbsp");
    const ptr = this.tmp("rbp");
    const cur = this.tmp("rbc");
    const e = this.tmp("rbe");
    const label = this.tmp("ts_continue_");
    const release = this.iterationClaims(stmt.statement);
    this.line(`{`);
    this.block(() => {
      this.line(`uint32_t ${stack}[TS_RBT_STACK];`);
      this.line(`uint32_t ${sp} = 0;`);
      this.line(`uint32_t ${ptr} = TS_RBT_ROOT(${t}.base);`);
      this.line(`while (1) {`);
      this.block(() => {
        this.line(`while (${ptr} != 0) {`);
        this.line(`  if (${sp} == TS_RBT_STACK) ts_rbt_too_deep();`);
        this.line(`  ${stack}[${sp}++] = ${ptr};`);
        this.line(`  ${ptr} = ts_rbt_reg(&${t}, ${S}, ${ptr}, ${down});`);
        this.line(`}`);
        this.line(`if (${sp} == 0) break;`);
        this.line(`uint32_t ${cur} = ${stack}[--${sp}];`);
        this.line(`TsRbtEntry ${e} = {ts_rbt_node(&${t}, ${S}, ${cur}), ${cur}};`);
        // sokoban reads the next pointer when it yields the node, before the caller sees it.
        this.line(`${ptr} = ts_rbt_reg(&${t}, ${S}, ${cur}, ${next});`);
        this.scopes.at(-1)!.set((d.name as ts.Identifier).text, {
          c: e,
          type: { kind: "rbEntry", inst: tree.inst.key, writable: tree.writable },
          mutable: false,
          paths: [`@${t}[]`],
          decl: d,
        });
        const walking = !this.iteratingTrees.has(t);
        this.iteratingTrees.add(t);
        this.loops.push(label);
        try {
          this.line(`{`);
          this.block(() => this.body(stmt.statement));
          this.line(`}`);
        } finally {
          this.loops.pop();
          if (walking) this.iteratingTrees.delete(t);
        }
        this.line(`${label}:;`);
        release();
      });
      this.line(`}`);
    });
    this.line(`}`);
    return true;
  }

  /** The functions a list literal names (`[f, g]`: closures, helpers or choices), or undefined when it holds anything else. */
  protected functionList(list: ts.ArrayLiteralExpression): (Closure | FunctionChoice)[] | undefined {
    if (!list.elements.length) return undefined;
    const fns: (Closure | FunctionChoice)[] = [];
    for (const el of list.elements) {
      if (!ts.isIdentifier(el)) return undefined;
      const l = this.lookup(el.text);
      const f = l?.choice ?? this.functionNamed(el);
      if (!f) return undefined;
      fns.push(f);
    }
    return fns;
  }

  /**
   * `for (const f of [g, h]) …`: unrolled, the body once per function with f bound to it, in order. `continue` goes to
   * the next function, `break` past the last (the copies sit in a do { } while (0)).
   */
  protected forOfFunctions(stmt: ts.ForOfStatement, name: ts.Identifier) {
    const fns = this.functionList(stmt.expression as ts.ArrayLiteralExpression)!;
    this.line(`do {`);
    this.block(() => {
      for (const f of fns) {
        const next = this.tmp("ts_continue_");
        this.line(`{`);
        this.block(() => {
          this.scopes.at(-1)!.set(name.text, "sel" in f ? { c: "", type: BOOL, mutable: false, choice: f } : { c: "", type: BOOL, mutable: false, closure: f });
          this.loops.push(next);
          try {
            this.body(stmt.statement);
          } finally {
            this.loops.pop();
          }
        });
        this.line(`}`);
        this.line(`${next}:;`);
      }
    });
    this.line(`} while (0);`);
  }

  /**
   * `c ? f : h` where both sides name functions (or other choices): the condition is evaluated here, once, into a C bool,
   * and a call later expands only the chosen function. Undefined when the expression is not such a choice.
   */
  protected functionChoice(init: ts.Expression, name: string): FunctionChoice | undefined {
    const strip = (x: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(x) ? strip(x.expression) : x);
    const e = strip(init);
    if (!ts.isConditionalExpression(e)) return undefined;
    const inline = (x: ts.Expression): boolean => ts.isArrowFunction(strip(x)) || ts.isFunctionExpression(strip(x));
    // What a side names, decided from the names alone (nothing is evaluated): a function, a choice, or neither.
    const named = (x: ts.Expression): boolean => {
      const y = strip(x);
      if (ts.isIdentifier(y)) return !!(this.lookup(y.text)?.choice ?? this.functionNamed(y));
      return ts.isConditionalExpression(y) && named(y.whenTrue) && named(y.whenFalse);
    };
    const fnSide = (x: ts.Expression): boolean => {
      const y = strip(x);
      return named(y) || (ts.isConditionalExpression(y) && (fnSide(y.whenTrue) || fnSide(y.whenFalse)));
    };
    if (!fnSide(e.whenTrue) && !fnSide(e.whenFalse)) {
      if (inline(e.whenTrue) && inline(e.whenFalse)) this.fail(e, "declare each function with const first, then choose between them: const g = c ? f : h");
      return undefined; // a choice between values: an ordinary conditional
    }
    if (inline(e.whenTrue) || inline(e.whenFalse)) this.fail(e, "declare each function with const first, then choose between them: const g = c ? f : h");
    if (!named(e)) this.fail(e, "choose between functions on both sides: const g = c ? f : h");
    return this.bindChoice(e, name);
  }

  /**
   * Evaluate a function choice's conditions into C bools, as JS does: the outer one first, an inner one only when its
   * side is taken (`a ? f : b ? g : h` reads b only when a is false). Its sides are known to name functions.
   */
  private bindChoice(e: ts.ConditionalExpression, name: string, guard?: string): FunctionChoice {
    const strip = (x: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(x) ? strip(x.expression) : x);
    const sel = `l_${name}_sel_${this.temp++}`;
    if (guard === undefined) {
      const cond = this.expect(this.expr(e.condition, BOOL), BOOL, e.condition);
      this.line(`bool ${sel} = ${cond.c};`);
    } else {
      this.line(`bool ${sel} = false;`);
      this.line(`if (${guard}) {`);
      this.block(() => {
        const cond = this.expect(this.expr(e.condition, BOOL), BOOL, e.condition);
        this.line(`${sel} = ${cond.c};`);
      });
      this.line(`}`);
    }
    const within = (taken: string) => (guard === undefined ? taken : `(${guard}) && ${taken}`);
    const side = (x: ts.Expression, taken: string): Closure | FunctionChoice => {
      const y = strip(x);
      if (ts.isIdentifier(y)) return (this.lookup(y.text)?.choice ?? this.functionNamed(y))!;
      return this.bindChoice(y as ts.ConditionalExpression, name, within(taken));
    };
    return { sel, whenTrue: side(e.whenTrue, sel), whenFalse: side(e.whenFalse, `!${sel}`) };
  }

  /** A call of a function chosen at run time: an if / else, each side expanding its function with the same arguments. */
  protected callChoice(choice: FunctionChoice, args: readonly ts.Expression[], node: ts.Node): Value | undefined {
    const t = this.tmp("chosen");
    const declAt = this.lines.length;
    this.line(`/* ${t} */`);
    let type: ValueType | undefined;
    let anyValue = false;
    const branch = (f: Closure | FunctionChoice) => {
      const v = "sel" in f ? this.callChoice(f, args, node) : this.expandClosure(f, args, node);
      if (!v) return;
      anyValue = true;
      if (!type) type = v.type;
      const w = this.ownedString(this.expect(v, type, node));
      this.line(w.type.kind === "pubkey" ? `${t} = *(${w.c});` : `${t} = ${w.c};`);
    };
    this.line(`if (${choice.sel}) {`);
    this.block(() => branch(choice.whenTrue));
    this.line(`} else {`);
    this.block(() => branch(choice.whenFalse));
    this.line(`}`);
    if (!anyValue || !type) return undefined;
    const vt: ValueType = type;
    if (vt.kind === "account" || vt.kind === "remaining" || vt.kind === "structRef" || vt.kind === "vecArg")
      this.fail(node, "functions chosen at run time return plain values (integers, booleans, Pubkeys, strings, options)");
    this.lines[declAt] = this.lines[declAt]!.replace(`/* ${t} */`, `${vt.kind === "pubkey" ? "SolPubkey" : valueC(vt)} ${t};`);
    return vt.kind === "pubkey" ? { c: `(&${t})`, type: vt } : { c: t, type: vt };
  }

  /** The function an identifier names (a closure, a local function or a helper), as something to expand; else undefined. */
  protected functionNamed(id: ts.Identifier): Closure | undefined {
    const l = this.lookup(id.text);
    if (l) return l.closure;
    const name = calleeName(id, this.model.helperDecls, this.checker);
    const h = name ? (this.model.helpers.get(name) ?? this.model.generics.get(name)) : undefined;
    return h ? { node: h.node, name: h.display, scopes: [], env: this.noEnv(), imports: h.imports } : undefined;
  }

  /** `xs.map(…)` / `xs.filter(…)` (or a chain of them): a list built element by element, not stored anywhere yet. */
  protected isPipeline(e: ts.Expression): e is ts.CallExpression {
    return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && (e.expression.name.text === "map" || e.expression.name.text === "filter");
  }

  /** The list under a chain of map / filter calls, and the calls in the order they run. */
  protected pipelineStages(e: ts.Expression) {
    const stages: { kind: "map" | "filter"; fn: ts.ArrowFunction | ts.FunctionExpression }[] = [];
    let base = e;
    while (this.isPipeline(base)) {
      const access = base.expression as ts.PropertyAccessExpression;
      const kind = access.name.text as "map" | "filter";
      if (base.arguments.length !== 1) this.fail(base, `${kind}() takes one argument: the callback`);
      const fn = base.arguments[0]!;
      if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) this.fail(fn, `pass ${kind} an arrow function written here: xs.${kind}((x) => …)`);
      if (fn.parameters.length > 2) this.fail(fn.parameters[2]!, `${kind}'s callback takes the element and its index`);
      stages.unshift({ kind, fn });
      base = access.expression;
    }
    if (stages.length) {
      const l = ts.isIdentifier(base) ? this.lookup(base.text) : undefined;
      if (!(l?.type.kind === "vecArg" || l?.type.kind === "array" || this.peekArray(base) || this.isVecArgView(base) || this.isInlineArray(base)))
        this.fail(base, "map and filter work on a Vec, FixedArray or FixedVec");
    }
    return { base, stages };
  }

  /** List bases already made into locals (see holdList), so a list method and the loop under it make them once. */
  protected heldLists = new Map<ts.Node, ts.Identifier>();

  /**
   * A list written inline that must be made before it is read: `fixedArray<T, N>(fill)` (a local array, filled once)
   * or a slice of a Vec argument or the instruction data (a view, range-checked once). Made here, in a local named by
   * a synthetic identifier the loop reads; undefined for any other list (read in place).
   */
  protected holdList(base: ts.Expression): ts.Identifier | undefined {
    const held = this.heldLists.get(base);
    if (held) return held;
    let made: Local | undefined;
    if (this.isInlineArray(base)) {
      let call = base;
      while (ts.isParenthesizedExpression(call)) call = call.expression;
      const c = this.tmp("fa");
      made = { c, type: this.localArray(call as ts.CallExpression, c), mutable: false };
    } else if (!ts.isIdentifier(base) && this.isVecArgView(base)) {
      const v = this.vecArgView(base)!;
      made = { c: v.c, type: v.type, mutable: false };
    }
    if (!made) return undefined;
    const id = ts.factory.createIdentifier(`__hl${this.temp++}`);
    ts.setTextRange(id, base);
    (id as { parent?: ts.Node }).parent = base.parent;
    this.scopes.at(-1)!.set(id.text, made);
    return id;
  }

  /** The type of an inline `fixedArray<T, N>(fill)` from its type arguments, without emitting code. */
  protected inlineArrayType(e: ts.Expression): (FieldType & { kind: "array" }) | undefined {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!this.isInlineArray(e)) return undefined;
    const [elemNode, lenNode] = (e as ts.CallExpression).typeArguments ?? [];
    const elem = elemNode && this.localElem(elemNode);
    const len = lenNode && ts.isLiteralTypeNode(lenNode) && ts.isNumericLiteral(lenNode.literal) ? Number(lenNode.literal.text) : NaN;
    return elem && Number.isInteger(len) ? { kind: "array", elem, len } : undefined;
  }

  /**
   * Run `body` for each element of a list, or of a chain of `map` / `filter` calls on one (`xs.filter(f).map(g)`):
   * one index loop over the list (its length read every step, as `for … of`), each callback expanded in it. A
   * filter skips to the next element, a map binds its result, so a chain builds no list. `body` gets the element (as
   * `list.get(i)` gives it, structs by reference, or the mapped value) and its index in the chain's output (after a
   * filter, the count of elements it let through, as JS gives callbacks).
   */
  protected eachElement(
    list: ts.Expression,
    at: ts.Node,
    names: { index: string; ci: string; next?: string; alwaysNext?: boolean; atNext?: () => void; body?: ts.Node },
    body: (element: ts.Expression, index: ts.Expression) => void,
  ): void {
    const stagesOf = this.pipelineStages(list);
    const { stages } = stagesOf;
    // An inline fixedArray(…) or a slice of a Vec argument / the instruction data: made once, before the loop.
    const base: ts.Expression = this.holdList(stagesOf.base) ?? stagesOf.base;
    // A BigVec slice is lowered (and range-checked) once, here; the loop reads its length and elements from that.
    const sliced =
      ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression) && base.expression.name.text === "slice" ? this.ref(base) : undefined;
    if (sliced?.vec?.slice) this.sliceViews.set(base, sliced);
    try {
      // A BigVec runs to the size of its account (20,000 validators): its loops get a C function of their own.
      const big = (sliced ?? this.probe(() => this.ref(base)))?.vec?.big !== undefined;
      if (!big || !this.outlinedLoop(names.body, () => this.eachElementLoop(base, stages, at, names, body)))
        this.eachElementLoop(base, stages, at, names, body);
    } finally {
      this.sliceViews.delete(base);
    }
  }

  private eachElementLoop(
    base: ts.Expression,
    stages: ReturnType<StatementEmitter["pipelineStages"]>["stages"],
    at: ts.Node,
    names: { index: string; ci: string; next?: string; alwaysNext?: boolean; atNext?: () => void; body?: ts.Node },
    body: (element: ts.Expression, index: ts.Expression) => void,
  ): void {
    const f = ts.factory;
    const place = <T extends ts.Node>(n: T): T => {
      ts.setTextRange(n, at);
      (n as { parent?: ts.Node }).parent = at;
      return n;
    };
    const { index, ci } = names;
    const indexId = place(f.createIdentifier(index));
    const length = place(f.createPropertyAccessExpression(base, "length"));
    const get = place(f.createCallExpression(place(f.createPropertyAccessExpression(base, "get")), undefined, [indexId]));
    const next = names.next ?? (stages.some((s) => s.kind === "filter") ? this.tmp("ts_next_") : undefined);
    this.line(`{`);
    this.block(() => {
      this.line(`uint64_t ${ci} = 0;`);
      this.scopes.at(-1)!.set(index, { c: ci, type: U64, mutable: false });
      const counters = stages
        .filter((st) => st.kind === "filter")
        .map(() => {
          const k = this.tmp("lm_k");
          this.line(`uint64_t ${k} = 0;`);
          return k;
        });
      this.line(`while (1) {`);
      this.block(() => {
        const n = this.expect(this.expr(length, U64), U64, base);
        this.line(`if (!(${ci} < ${n.c})) break;`);
        let element: ts.Expression = get;
        let idx: ts.Expression = indexId;
        let k = 0;
        for (const st of stages) {
          if (st.kind === "map") {
            const ret = st.fn.body && !ts.isBlock(st.fn.body) ? st.fn.body : undefined;
            const bare = ret && ts.isParenthesizedExpression(ret) ? ret.expression : ret;
            if (bare && ts.isObjectLiteralExpression(bare)) {
              // A map to structs inside a chain: each element built in a struct of its own, which the next stage reads.
              const sname = st.fn.type ? structNameOf(st.fn.type, this.scope) : undefined;
              const S = sname ? this.model.structs.get(sname) : undefined;
              if (!S)
                this.fail(
                  st.fn,
                  "name the struct the callback builds: xs.map((x): MyStruct => ({ … })) (or store the list: const ys: FixedVec<MyStruct, N> = xs.map(…))",
                );
              if (S.size === undefined || S.vec) this.fail(st.fn, `${S.name} has variable-size fields and cannot be built in a chain`);
              const closure: Closure = { node: st.fn, name: "map's callback", scopes: [...this.scopes], env: this.envNow(), imports: this.scope.imports };
              const sc = this.tmp("lm_s");
              this.line(`TSS_${S.name} ${sc}__v;`);
              this.line(`ts_memzero(&${sc}__v, sizeof(${sc}__v));`);
              this.expandClosure(closure, [element, idx].slice(0, st.fn.parameters.length), st.fn, {
                lv: `${sc}__v`,
                type: { kind: "struct", name: S.name },
                writable: true,
              });
              this.line(`TSS_${S.name} *${sc} = &${sc}__v;`);
              const id = `__ls${this.temp++}`;
              this.scopes
                .at(-1)!
                .set(id, { c: sc, type: { kind: "structRef", struct: S.name, writable: true }, mutable: false, paths: [`@${sc}`], owned: true });
              element = place(f.createIdentifier(id));
              continue;
            }
          }
          const closure: Closure = { node: st.fn, name: `${st.kind}'s callback`, scopes: [...this.scopes], env: this.envNow(), imports: this.scope.imports };
          const v = this.expandClosure(closure, [element, idx].slice(0, st.fn.parameters.length), st.fn);
          if (st.kind === "filter") {
            if (!v) this.fail(st.fn, "filter's callback returns a boolean");
            const b = this.expect(v, BOOL, st.fn);
            this.line(`if (!(${b.c})) goto ${next};`);
            const id = `__lk${this.temp++}`;
            const ic = this.tmp("lm_ki");
            this.line(`uint64_t ${ic} = ${counters[k++]}++;`);
            this.scopes.at(-1)!.set(id, { c: ic, type: U64, mutable: false });
            idx = place(f.createIdentifier(id));
          } else {
            if (!v) this.fail(st.fn, "map's callback returns the new element");
            const mv = v.literal !== undefined ? this.literal(v.literal, U64, st.fn) : v;
            if (!["int", "bool", "pubkey", "enum"].includes(mv.type.kind))
              this.fail(st.fn, `map's callback returns integers, booleans, Pubkeys or enums (the new list's elements), not ${typeName(mv.type)}`);
            const id = `__lv${this.temp++}`;
            const mc = this.tmp("lm_v");
            this.line(mv.type.kind === "pubkey" ? `SolPubkey ${mc} = *(${mv.c});` : `${valueC(mv.type)} ${mc} = ${mv.c};`);
            this.scopes.at(-1)!.set(id, { c: mc, type: mv.type, mutable: false });
            element = place(f.createIdentifier(id));
          }
        }
        body(element, idx);
        if (next && (names.alwaysNext || counters.length)) this.line(`${next}:;`);
        names.atNext?.();
        this.line(`${ci}++;`);
      });
      this.line(`}`);
    });
    this.line(`}`);
  }

  /**
   * Run `emit` (a loop) as a C function of its own, called here: `TS_TRY(fn__loopN(params, …))`. SBF has ten
   * registers, four of them kept across calls; a loop inside a large function shares them with every value the
   * function holds across it, and clang spills the loop's own (the stake pool's pass over 20,000 validators paid a
   * reload and a store per entry). A function of its own has them all. It gets the caller's variables the loop uses:
   * by value when the loop only reads them, else through a pointer, copied in and back out when it is done (a failure
   * returns at once, as it would here). False, with nothing emitted, when the loop cannot move: its body returns from
   * the function, declares an account (create), or uses a variable of the caller that is not one of its locals or
   * parameters (a claim slot, a list held in place); it then stays where it is.
   */
  protected outlinedLoop(body: ts.Node | undefined, emit: () => void): boolean {
    const returns = (n: ts.Node): boolean => ts.isReturnStatement(n) || (!ts.isFunctionLike(n) && !ts.isClassLike(n) && (ts.forEachChild(n, returns) ?? false));
    if (body && returns(body)) return false;
    // The variables visible here, by C name (innermost first, as lookup finds them).
    const visible = new Map<string, Local>();
    for (const scope of [...[...this.scopes].reverse(), this.args]) for (const l of scope.values()) if (!visible.has(l.c)) visible.set(l.c, l);
    const saved = {
      lines: this.lines,
      hoisted: this.hoisted,
      indent: this.indent,
      temp: this.temp,
      diagnostics: this.reporter.diagnostics.length,
      outlined: this.outlinedLoops.length,
      seedArrays: new Map(this.seedArrays),
      state: () => JSON.stringify([[...this.created], [...this.pendingInit], [...this.bumps]]),
    };
    const state = saved.state();
    this.lines = [];
    this.hoisted = [];
    this.indent = 1;
    let lines: string[];
    let hoisted: string[];
    try {
      emit();
    } finally {
      lines = this.lines;
      hoisted = this.hoisted;
      this.lines = saved.lines;
      this.hoisted = saved.hoisted;
      this.indent = saved.indent;
      // Seed arrays the loop declared live in its function (their positions are in its lines).
      this.seedArrays.clear();
      saved.seedArrays.forEach((v, k) => this.seedArrays.set(k, v));
    }
    const plan = saved.state() === state ? this.outlinedParams([...hoisted, ...lines].join("\n"), visible) : undefined;
    if (!plan) {
      this.temp = saved.temp;
      this.reporter.diagnostics.length = saved.diagnostics;
      this.outlinedLoops.length = saved.outlined;
      return false;
    }
    // Heap buffers taken on first use stay declared in the caller, which passes each in by pointer: declared in the
    // loop's function, every call of it would take a new one (an emit or a helper's argument copy in a loop run many
    // times would exhaust the heap).
    const lazy = hoisted.filter((l) => this.lazyHoists.has(l));
    for (const l of lazy) {
      const { name: buffer, decl } = this.lazyHoists.get(l)!;
      this.hoisted.push(l);
      plan.params.push(decl(`*cp_${buffer}`));
      plan.args.push(`&${buffer}`);
      plan.copyIn.push(`  ${decl(buffer)} = *cp_${buffer};`);
      plan.copyOut.push(`  *cp_${buffer} = ${buffer};`);
    }
    hoisted = hoisted.filter((l) => !lazy.includes(l));
    const name = `${this.helper ? `fn_${this.helper.name}` : `ix_${this.ix!.name}`}__loop${this.outlinedLoops.length}`;
    this.outlinedLoops.push(
      [
        `static __attribute__((noinline)) uint64_t ${name}(${["TsParams *params", ...plan.params].join(", ")}) {`,
        ...plan.copyIn,
        ...hoisted,
        ...lines,
        ...plan.copyOut,
        `  return SUCCESS;`,
        `}`,
        ``,
      ].join("\n"),
    );
    this.line(`TS_TRY(${name}(${["params", ...plan.args].join(", ")}));`);
    return true;
  }

  /**
   * The parameters a loop moved out of this function takes for the caller's variables its C uses, or undefined when
   * it uses one that cannot be passed (or that is not a local or parameter at all).
   */
  private outlinedParams(c: string, visible: Map<string, Local>): { params: string[]; args: string[]; copyIn: string[]; copyOut: string[] } | undefined {
    const toks = cTokens(c);
    const own = declaredNames(toks);
    const signature = this.helper ? parameterDecls(helperSignature(this.helper)) : new Map<string, string>();
    const out = { params: [] as string[], args: [] as string[], copyIn: [] as string[], copyOut: [] as string[] };
    for (const n of [...usedNames(toks)].sort()) {
      if (own.has(n) || n === "params" || isGlobalName(n)) continue;
      const param = signature.get(n);
      if (param) {
        out.params.push(param);
        out.args.push(n);
        continue;
      }
      if (this.ix && n.startsWith("a_") && this.accounts.has(n.slice(2))) {
        out.params.push(`TsAccount *${n}`);
        out.args.push(n);
        continue;
      }
      const l = visible.get(n);
      if (!l || l.closure || l.choice) return undefined;
      const t = l.type;
      if (
        t.kind === "array" ||
        t.kind === "vec" ||
        t.kind === "remaining" ||
        t.kind === "arrayArg" ||
        t.kind === "optionArg" ||
        t.kind === "signerSeeds" ||
        t.kind === "dataEnumArg"
      )
        return undefined;
      const ct = t.kind === "pubkey" ? (l.ptr ? "const SolPubkey *" : "SolPubkey") : valueC(t);
      const decl = (name: string) => (ct.endsWith("*") ? `${ct}${name}` : `${ct} ${name}`);
      if (!l.mutable && (ct.endsWith("*") || t.kind === "int" || t.kind === "bool" || t.kind === "enum")) {
        out.params.push(decl(n));
        out.args.push(n);
        continue;
      }
      out.params.push(decl(`*cp_${n}`));
      out.args.push(`&${n}`);
      out.copyIn.push(`  ${decl(n)} = *cp_${n};`);
      if (l.mutable) out.copyOut.push(`  *cp_${n} = ${n};`);
    }
    return out;
  }

  /**
   * `const ys = xs.map(…)` / `xs.filter(…)`: the chain's elements in a local FixedVec, as big as the list it starts
   * from (a FixedArray's length, a FixedVec's capacity) or as annotated (`const ys: FixedVec<u64, 16> = …`, needed
   * when it starts from a Vec). It lives on the stack, so it holds at most 2 KiB; one more element than it holds aborts.
   */
  protected localList(d: ts.VariableDeclaration, init: ts.CallExpression, c: string): FieldType & { kind: "vec"; cap: number } {
    const { base, stages } = this.pipelineStages(init);
    let cap: number | undefined;
    let annotatedElem: FieldType | undefined;
    if (d.type) {
      const t = d.type;
      const args = ts.isTypeReferenceNode(t) ? (t.typeArguments ?? []) : [];
      const n = args[1] && ts.isLiteralTypeNode(args[1]) && ts.isNumericLiteral(args[1].literal) ? Number(args[1].literal.text) : NaN;
      const elemNode = args[0];
      const sn = elemNode && structNameOf(elemNode, this.scope);
      const fs = elemNode && typesolName(elemNode, this.scope.imports) === "FixedString" ? (elemNode as ts.TypeReferenceNode).typeArguments?.[0] : undefined;
      const fcap = fs && ts.isLiteralTypeNode(fs) && ts.isNumericLiteral(fs.literal) ? Number(fs.literal.text) : NaN;
      if (Number.isInteger(fcap) && fcap >= 1) this.model.fstrings.add(fcap);
      annotatedElem = elemNode
        ? (resolveScalarType(elemNode, this.scope) ??
          (sn && this.model.structs.has(sn) ? { kind: "struct", name: sn } : Number.isInteger(fcap) && fcap >= 1 ? { kind: "fstring", cap: fcap } : undefined))
        : undefined;
      if (!ts.isTypeReferenceNode(t) || typesolName(t, this.scope.imports) !== "FixedVec" || !annotatedElem || !Number.isInteger(n) || n < 1)
        this.fail(t, "annotate the new list as FixedVec<T, N> (N a literal)");
      cap = n;
    } else if (this.inlineArrayType(base)) cap = this.inlineArrayType(base)!.len;
    else {
      if (this.isVecArgView(base)) this.fail(init, "this list has no fixed size: annotate the new one with its capacity, const ys: FixedVec<T, N> = …");
      const r = this.reporter.guard(() => this.ref(base));
      const l = ts.isIdentifier(base) ? this.lookup(base.text) : undefined;
      if (r?.type.kind === "array") cap = r.type.len;
      else if (r?.type.kind === "vec" && r.type.cap !== undefined) cap = r.type.cap;
      if (cap === undefined || l?.type.kind === "vecArg")
        this.fail(init, "this list has no fixed size: annotate the new one with its capacity, const ys: FixedVec<T, N> = …");
    }
    // The element type: the last map's result, else the list's own elements (known once the loop is emitted).
    const declAt = this.lines.length;
    this.line(`/* ${c} */`);
    let elem: FieldType | undefined = stages.some((st) => st.kind === "map") ? undefined : this.listElem(base);
    const cap0 = cap!;
    // A last map to structs or FixedStrings (annotated) writes each result straight into its slot.
    const last = stages.at(-1);
    if (last?.kind === "map" && annotatedElem && !isScalar(annotatedElem)) {
      const target = annotatedElem;
      const inner = (init.expression as ts.PropertyAccessExpression).expression;
      this.eachElement(inner, init, { index: `__ml${this.temp++}`, ci: this.tmp("ml_i") }, (element, index) => {
        this.line(`if (${c}.len >= ${cap0}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: the new list is full");`);
        const closure: Closure = { node: last.fn, name: "map's callback", scopes: [...this.scopes], env: this.envNow(), imports: this.scope.imports };
        this.expandClosure(closure, [element, index].slice(0, last.fn.parameters.length), last.fn, {
          lv: `${c}.items[${c}.len]`,
          type: target,
          writable: true,
        });
        this.line(`${c}.len++;`);
      });
      elem = target;
    } else
      this.eachElement(init, init, { index: `__ml${this.temp++}`, ci: this.tmp("ml_i") }, (element) => {
        if (!elem) {
          const v = this.expr(element);
          elem = v.type as FieldType;
        }
        const target = annotatedElem ?? elem;
        const sub = { lv: `${c}.items[${c}.len]`, type: target, writable: true };
        this.line(`if (${c}.len >= ${cap0}) TS_FAIL(TS_ERR_INDEX, "TypeSOL: the new list is full");`);
        const vt = this.storageValueType(target);
        if (vt) this.line(this.writeStorage(sub, this.ownedString(this.expect(this.expr(element, vt), vt, element)).c) + ";");
        else this.writeAggregate(sub, element);
        this.line(`${c}.len++;`);
      });
    const t = { kind: "vec", elem: annotatedElem ?? elem!, cap: cap0 } as FieldType & { kind: "vec"; cap: number };
    this.checkLocalListSize(t, init, "the new list");
    this.model.localVecs.set(fixedVecC(t), t);
    const pad = "  ".repeat(this.indent);
    this.lines[declAt] = `${pad}${fixedVecC(t)} ${c};\n${pad}ts_memzero(&${c}, sizeof(${c}));`;
    return t;
  }
  /** The element type of a Vec, FixedArray, FixedVec or Vec argument. */
  protected listElem(list: ts.Expression): FieldType {
    const inline = this.inlineArrayType(list);
    if (inline) return inline.elem;
    // A slice of a Vec argument or the instruction data: the elements of the list it slices.
    let root = list;
    for (;;) {
      if (ts.isParenthesizedExpression(root)) root = root.expression;
      else if (ts.isCallExpression(root) && ts.isPropertyAccessExpression(root.expression) && root.expression.name.text === "slice" && this.isVecArgView(root))
        root = root.expression.expression;
      else break;
    }
    const l = ts.isIdentifier(root) ? this.lookup(root.text) : undefined;
    if (l?.type.kind === "vecArg") return l.type.elem;
    const r = this.ref(list);
    if (r && (r.type.kind === "array" || r.type.kind === "vec")) return r.type.elem;
    this.fail(list, "expected a Vec, FixedArray or FixedVec");
  }

  /** Whether `e` is the remaining accounts (or a const bound to them). */
  protected isRemaining(e: ts.Expression): boolean {
    if (ts.isCallExpression(e) && this.exportName(e.expression) === "remainingAccounts") return true;
    return ts.isIdentifier(e) && this.lookup(e.text)?.type.kind === "remaining";
  }

  /**
   * `while (1) { cond; if (!cond) break; body; continue_label: step }`. The condition is lowered
   * inside the loop so its checked-arithmetic temporaries are recomputed every iteration.
   */
  protected loop(cond: ts.Expression | undefined, body: ts.Statement, step: ts.Expression | undefined) {
    const label = this.tmp("ts_continue_");
    this.line(`while (1) {`);
    this.block(() => {
      if (cond) {
        const c = this.expect(this.expr(cond, BOOL), BOOL, cond);
        this.line(`if (!${c.c}) break;`);
      }
      const release = this.iterationClaims(body);
      this.loops.push(label);
      this.line(`{`);
      this.block(() => this.body(body));
      this.line(`}`);
      this.loops.pop();
      this.line(`${label}:;`);
      release();
      if (step) this.expressionStatement(step, false);
    });
    this.line(`}`);
  }

  /**
   * Expand a closure where it is called: the arguments are evaluated here, in order, into the parameters (scalars,
   * Pubkeys and strings by value, structs by reference, as JS passes objects); the body then runs with the names it
   * was declared with, so a block around the call that declares the same name does not change what it reads, and
   * writes to captured `let`s are seen by the enclosing function. Returns the result (undefined for no value).
   */
  protected expandClosure(c: Closure, args: readonly ts.Expression[], node: ts.Node, into?: Ref): Value | undefined {
    const fn = c.node;
    if (this.inlining.has(fn)) this.fail(node, `${c.name} calls itself: closures cannot be recursive`);
    // Its types are written in its own file: they mean what that file's imports say (the arguments are the caller's).
    const calleeScope = c.imports === this.scope.imports ? this.scope : { ...this.scope, imports: c.imports };
    if (args.length !== fn.parameters.length) this.fail(node, `${c.name}() takes ${fn.parameters.length} argument(s)`);
    const params = new Map<string, Local>();
    // Account parameters (of a helper expanded here) name the caller's accounts while the body runs.
    const aliases = new Map<string, AccountParam>();
    fn.parameters.forEach((p, i) => {
      if (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken) this.fail(p, "closure parameters are plain names");
      const arg = args[i]!;
      const name = p.name.text;
      // A function parameter (of a helper expanded here): the function given, expanded where the body calls it.
      if (p.type && ts.isFunctionTypeNode(p.type)) {
        params.set(name, { c: "", type: BOOL, mutable: false, closure: this.closureOf(arg) });
        return;
      }
      const passed = ts.isIdentifier(arg) && this.lookup(arg.text) ? undefined : this.accountAt(arg);
      if (p.type && passed && !resolveValueType(p.type, calleeScope)) {
        aliases.set(name, passed);
        return;
      }
      const c2 = `l_${name}_${this.temp++}`;
      const annotated = p.type ? resolveValueType(p.type, calleeScope) : undefined;
      if (!annotated && this.looksLikeStructPlace(arg)) {
        const place = this.structPlace(arg)!;
        this.line(`TSS_${place.struct} *${c2} = ${place.ptr};`);
        params.set(name, {
          c: c2,
          type: { kind: "structRef", struct: place.struct, writable: place.writable },
          mutable: false,
          paths: this.pathsOf(arg),
          decl: p,
        });
        return;
      }
      let v = this.expr(arg, annotated);
      if (v.isNull && !annotated) this.fail(arg, "give the parameter a type to pass null");
      if (v.literal !== undefined && !annotated) v = this.literal(v.literal, U64, arg);
      const type = annotated ?? v.type;
      v = this.expect(v, type, arg);
      if (type.kind === "pubkey") this.line(`SolPubkey ${c2} = *(${v.c});`);
      else this.line(`${valueC(type)}${type.kind === "account" ? "" : " "}${c2} = ${this.ownedString(v).c};`);
      params.set(name, { c: c2, type, mutable: true });
    });
    const declared = fn.type && fn.type.kind !== ts.SyntaxKind.VoidKeyword ? resolveValueType(fn.type, calleeScope) : undefined;
    if (fn.type && fn.type.kind !== ts.SyntaxKind.VoidKeyword && !declared && !into)
      this.fail(fn.type, "closures return integers, booleans, Pubkeys, strings, enums or Options");
    const frame = {
      label: this.tmp("ts_ret_"),
      result: this.tmp("ret"),
      type: declared,
      declAt: this.lines.length,
      pad: "  ".repeat(this.indent),
      node: fn,
      into,
    };
    this.line(declared ? `${declared.kind === "pubkey" ? "SolPubkey" : valueC(declared)} ${frame.result};` : `/* ${frame.result} */`);
    // The body names what it could where it was written: a closure the caller's arguments and accounts, a helper
    // only its own parameters (its account parameters name the caller's accounts) and the module.
    const swap = <K, V>(m: Map<K, V>, to: Map<K, V>) => {
      const before = new Map(m);
      m.clear();
      for (const [k, v] of to) m.set(k, v);
      return before;
    };
    const bodyAccounts = new Map(c.env.accounts);
    for (const [n, a] of aliases) bodyAccounts.set(n, a);
    // Accounts are found by name before locals: a parameter named like one the body can see would read the account.
    for (const n of params.keys())
      if (bodyAccounts.has(n))
        this.fail(fn.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === n) ?? node, `"${n}" shadows the account "${n}"; use another name`);
    const saved = {
      scope: this.scope,
      scopes: this.scopes,
      loops: this.loops.splice(0),
      args: swap(this.args, c.env.args),
      accounts: swap(this.accounts, bodyAccounts),
    };
    this.scopes = [...c.scopes, params];
    this.scope = calleeScope;
    this.inlining.add(fn);
    this.inlineFrames.push(frame);
    try {
      this.line(`{`);
      this.block(() => {
        const body = fn.body;
        if (!body) this.fail(fn, `${c.name} has no body`);
        if (ts.isBlock(body)) body.statements.forEach((s) => this.reporter.guard(() => this.statement(s)));
        else {
          // An expression body: its value is the result (a call may have none).
          const ret = ts.factory.createReturnStatement(body);
          ts.setTextRange(ret, body);
          (ret as { parent?: ts.Node }).parent = fn;
          if (ts.isCallExpression(body) && !frame.type && !into) {
            const v = this.call(body, false);
            if (v) this.closureResult(v, body, frame);
          } else this.closureReturn(ret, frame);
        }
      });
      this.line(`}`);
      this.line(`${frame.label}:;`);
    } finally {
      this.inlineFrames.pop();
      this.inlining.delete(fn);
      swap(this.args, saved.args);
      swap(this.accounts, saved.accounts);
      this.scopes = saved.scopes;
      this.scope = saved.scope;
      this.loops.push(...saved.loops);
    }
    if (!frame.type) {
      if (this.lines[frame.declAt]!.includes(`/* ${frame.result} */`)) this.lines[frame.declAt] = "";
      return undefined;
    }
    return frame.type.kind === "pubkey" ? { c: `(&${frame.result})`, type: frame.type } : { c: frame.result, type: frame.type };
  }

  /**
   * `xs.forEach / some / every / find / findIndex / reduce / includes / indexOf` on a Vec, FixedArray, FixedVec or Vec
   * argument: an index loop (the length read each step, as `for … of`), the callback (an arrow written at the call)
   * expanded with each element as `xs.get(i)` gives it (structs by reference) and, if it takes one, the index.
   * `find` gives an Option of the element (scalar elements), `findIndex` / `indexOf` an i64 (-1 when absent).
   */
  protected listMethod(node: ts.CallExpression, method: string): Value | undefined {
    // A list written inline is made first, as JS evaluates the receiver before the arguments (reduce's initial value).
    const base = this.pipelineStages((node.expression as ts.PropertyAccessExpression).expression).base;
    const held = this.holdList(base);
    if (!held) return this.listMethodLoop(node, method);
    this.heldLists.set(base, held);
    try {
      return this.listMethodLoop(node, method);
    } finally {
      this.heldLists.delete(base);
    }
  }

  private listMethodLoop(node: ts.CallExpression, method: string): Value | undefined {
    const access = node.expression as ts.PropertyAccessExpression;
    const list = access.expression;
    const args = node.arguments;
    const f = ts.factory;
    const place = <T extends ts.Node>(n: T): T => {
      ts.setTextRange(n, node);
      (n as { parent?: ts.Node }).parent = node;
      return n;
    };
    const valueForm = method === "includes" || method === "indexOf";
    if (args.length !== (method === "reduce" ? 2 : 1))
      this.fail(node, method === "reduce" ? "reduce(callback, initial) takes two arguments" : `${method}() takes one argument`);
    const cb = args[0]!;
    if (!valueForm && !ts.isArrowFunction(cb) && !ts.isFunctionExpression(cb))
      this.fail(cb, `pass ${method} an arrow function written here: xs.${method}((x) => …)`);
    const fn = cb as ts.ArrowFunction | ts.FunctionExpression;
    const index = `__lm${this.temp++}`;
    void place;
    const I64: ValueType = { kind: "int", name: "i64" };

    // The result, declared before the loop.
    const res = this.tmp("lm");
    let result: Value | undefined;
    let elemType: ValueType | undefined;
    let accType: ValueType | undefined;
    let needle: string | undefined;
    if (method === "some" || method === "includes") (this.line(`bool ${res} = false;`), (result = { c: res, type: BOOL }));
    if (method === "every") (this.line(`bool ${res} = true;`), (result = { c: res, type: BOOL }));
    if (method === "findIndex" || method === "indexOf") (this.line(`int64_t ${res} = -1;`), (result = { c: res, type: I64 }));
    if (method === "reduce") {
      const accParam = fn.parameters[0];
      const annotated = accParam?.type ? resolveValueType(accParam.type, this.scope) : undefined;
      let init = this.expr(args[1]!, annotated);
      if (init.literal !== undefined && !annotated) init = this.literal(init.literal, U64, args[1]!);
      accType = annotated ?? init.type;
      init = this.expect(init, accType, args[1]!);
      if (!["int", "bool", "pubkey", "string", "enum", "option"].includes(accType.kind))
        this.fail(args[1]!, `reduce accumulates integers, booleans, Pubkeys, strings, enums or Options, not ${typeName(accType)}`);
      this.line(accType.kind === "pubkey" ? `SolPubkey ${res} = *(${init.c});` : `${valueC(accType)} ${res} = ${this.ownedString(init).c};`);
      result = accType.kind === "pubkey" ? { c: `(&${res})`, type: accType } : { c: res, type: accType };
    }
    if (valueForm) {
      // The value looked for, read once, compared with === (scalars and strings).
      const v = this.expr(cb);
      needle = `__lv${this.temp++}`;
      const t = this.tmp("needle");
      const vt = v.literal !== undefined ? U64 : v.type;
      if (!["int", "bool", "pubkey", "string", "enum"].includes(vt.kind)) this.fail(cb, `${method} compares integers, booleans, Pubkeys, strings or enums`);
      const typed = v.literal !== undefined ? v : this.expect(v, vt, cb);
      this.line(vt.kind === "pubkey" ? `SolPubkey ${t} = *(${typed.c});` : `${valueC(vt)} ${t} = ${typed.c};`);
      this.scopes.at(-1)!.set(needle, { c: t, type: vt, mutable: false });
    }
    if (method === "find") {
      // Typed from the first element read inside the loop; declared here.
      result = { c: res, type: BOOL };
      this.line(`/* ${res} */`);
    }
    const findDecl = method === "find" ? this.lines.length - 1 : -1;
    // The result is the loop's to set: named in scope, so a loop moved into a function of its own gets it (outlinedLoop).
    if (result && method !== "find") this.scopes.at(-1)!.set(`__${res}`, { c: res, type: result.type, mutable: true });

    const ci = this.tmp("lm_i");
    this.eachElement(list, node, { index, ci }, (element, indexId) => {
      if (valueForm) {
        const eq = place(f.createBinaryExpression(element, ts.SyntaxKind.EqualsEqualsEqualsToken, place(f.createIdentifier(needle!))));
        const hit = this.expect(this.expr(eq, BOOL), BOOL, node);
        this.line(`if (${hit.c}) {`);
        this.line(method === "includes" ? `  ${res} = true;` : `  ${res} = (int64_t)${this.expr(indexId, U64).c};`);
        this.line(`  break;`);
        this.line(`}`);
      } else {
        const closure: Closure = { node: fn, name: `${method}'s callback`, scopes: [...this.scopes], env: this.envNow(), imports: this.scope.imports };
        const accId = method === "reduce" ? place(f.createIdentifier(`__acc${this.temp++}`)) : undefined;
        if (accId) this.scopes.at(-1)!.set(accId.text, { c: res, type: accType!, mutable: true });
        const all = method === "reduce" ? [accId!, element, indexId] : [element, indexId];
        const v = this.expandClosure(closure, all.slice(0, fn.parameters.length), cb);
        if (method === "forEach") {
          if (v) this.fail(cb, "forEach's callback returns nothing");
        } else if (method === "reduce") {
          if (!v) this.fail(cb, "reduce's callback returns the new accumulator");
          const nv = this.expect(v, accType!, cb);
          this.line(accType!.kind === "pubkey" ? `${res} = *(${nv.c});` : `${res} = ${nv.c};`);
        } else {
          if (!v) this.fail(cb, `${method}'s callback returns a boolean`);
          const b = this.expect(v, BOOL, cb);
          if (method === "some") this.line(`if (${b.c}) { ${res} = true; break; }`);
          if (method === "every") this.line(`if (!(${b.c})) { ${res} = false; break; }`);
          if (method === "findIndex") this.line(`if (${b.c}) { ${res} = (int64_t)${this.expr(indexId, U64).c}; break; }`);
          if (method === "find") {
            this.line(`if (${b.c}) {`);
            this.block(() => {
              const e = this.expr(element);
              elemType = e.type;
              if (!["int", "bool", "pubkey", "enum"].includes(e.type.kind))
                this.fail(node, "find returns an Option of the element, so the elements must be integers, booleans, Pubkeys or enums; use findIndex");
              this.line(`${res}.some = 1;`);
              this.line(e.type.kind === "pubkey" ? `${res}.v = *(${e.c});` : `${res}.v = ${e.c};`);
              this.line(`break;`);
            });
            this.line(`}`);
          }
        }
      }
    });
    if (method === "find") {
      const inner = elemType as ScalarType;
      this.model.options.set(optionKey(inner), inner);
      this.lines[findDecl] = `${"  ".repeat(this.indent)}${optC(inner)} ${res};\n${"  ".repeat(this.indent)}ts_memzero(&${res}, sizeof(${res}));`;
      return { c: res, type: { kind: "option", inner } as ValueType };
    }
    return result;
  }

  /** `return` inside an expanded closure: the value goes to the closure's result, then past its body. */
  protected closureReturn(stmt: ts.ReturnStatement, frame: (typeof this.inlineFrames)[number]) {
    if (frame.into && stmt.expression) {
      // Written straight into its place (an object literal for a struct, text for a FixedString, or a value).
      const target = frame.into;
      const vt = this.storageValueType(target.type);
      if (vt) this.line(this.writeStorage(target, this.ownedString(this.expect(this.expr(stmt.expression, vt), vt, stmt.expression)).c) + ";");
      else this.writeAggregate(target, stmt.expression);
      this.line(`goto ${frame.label};`);
      return;
    }
    if (!stmt.expression) {
      if (frame.type) this.fail(stmt, "this function returns a value");
      this.line(`goto ${frame.label};`);
      return;
    }
    this.closureResult(this.expr(stmt.expression, frame.type), stmt.expression, frame);
  }

  /** Store a closure's result (fixing its type on the first one) and jump past the rest of its body. */
  protected closureResult(value: Value, at: ts.Expression, frame: (typeof this.inlineFrames)[number]) {
    let v = value;
    const stmt = { expression: at };
    if (v.isNull && !frame.type) this.fail(stmt.expression, "give the function a return type to return null");
    if (!frame.type) {
      if (v.literal !== undefined) v = this.literal(v.literal, U64, stmt.expression);
      const t = v.type;
      if (!["int", "bool", "pubkey", "string", "enum", "option"].includes(t.kind))
        this.fail(stmt.expression, `closures return integers, booleans, Pubkeys, strings, enums or Options, not ${typeName(t)}`);
      frame.type = t;
      this.lines[frame.declAt] = `${frame.pad}${t.kind === "pubkey" ? "SolPubkey" : valueC(t)} ${frame.result};`;
    }
    v = this.expect(v, frame.type, stmt.expression);
    if (frame.type.kind === "pubkey") this.line(`${frame.result} = *(${v.c});`);
    else if (frame.type.kind === "option" && v.isNull) this.line(`ts_memzero(&${frame.result}, sizeof(${frame.result}));`);
    else this.line(`${frame.result} = ${this.ownedString(v).c};`);
    this.line(`goto ${frame.label};`);
  }

  /** `do { … } while (cond)`: the body once, then the test; `continue` goes to the test. */
  protected doLoop(stmt: ts.DoStatement) {
    const label = this.tmp("ts_continue_");
    this.line(`while (1) {`);
    this.block(() => {
      const release = this.iterationClaims(stmt.statement);
      this.loops.push(label);
      this.line(`{`);
      this.block(() => this.body(stmt.statement));
      this.line(`}`);
      this.loops.pop();
      this.line(`${label}:;`);
      release();
      const c = this.expect(this.expr(stmt.expression, BOOL), BOOL, stmt.expression);
      this.line(`if (!${c.c}) break;`);
    });
    this.line(`}`);
  }

  /**
   * The loadAccountMut calls of a loop body whose views end with the iteration: `const v = loadAccountMut<T>(…)` in the
   * body (not in a loop nested in it, which handles its own), with `v` never assigned or copied to a name, returned, put in
   * an object, or used in a function written in the body (other than a const closure of the body that stays in it). Their claims are recorded (declared here) and dropped at each iteration's end, so a
   * later iteration may load the same account again: the earlier view is out of scope by then. Returns the release.
   */
  protected iterationClaims(body: ts.Statement): () => void {
    const sites: ts.CallExpression[] = [];
    const isLoop = (n: ts.Node) => ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n);
    const isFunction = (n: ts.Node) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
    // A function written in the body may use the view when it is a const of the body that does not escape either (a
    // closure TypeSOL expands where it is called, within the iteration).
    const localFunction = (n: ts.Node, seen: Set<string>): boolean => {
      const d = n.parent;
      if (!d || !ts.isVariableDeclaration(d) || d.initializer !== n || !ts.isIdentifier(d.name)) return false;
      const list = d.parent;
      if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const)) return false;
      return !seen.has(d.name.text) && !escapes(d.name.text, new Set([...seen, d.name.text]));
    };
    const escapes = (name: string, seen = new Set([name])): boolean => {
      let found = false;
      const scan = (n: ts.Node, inFunction: boolean): void => {
        if (found) return;
        if (ts.isIdentifier(n) && n.text === name) {
          const p = n.parent;
          if (inFunction) found = true;
          else if (p && ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) found = true;
          else if (p && ts.isReturnStatement(p)) found = true;
          else if (p && ts.isVariableDeclaration(p) && p.initializer === n) found = true;
          else if (p && (ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer === n))) found = true;
        }
        ts.forEachChild(n, (c) => scan(c, inFunction || (isFunction(n) && !localFunction(n, seen))));
      };
      scan(body, false);
      return found;
    };
    const visit = (n: ts.Node): void => {
      if (n !== body && (isLoop(n) || isFunction(n))) return;
      if (ts.isVariableDeclarationList(n) && n.flags & ts.NodeFlags.Const)
        for (const d of n.declarations) {
          let init = d.initializer;
          while (init && ts.isParenthesizedExpression(init)) init = init.expression;
          if (
            ts.isIdentifier(d.name) &&
            init &&
            ts.isCallExpression(init) &&
            ts.isIdentifier(init.expression) &&
            init.expression.text === "loadAccountMut" &&
            !escapes(d.name.text)
          )
            sites.push(init);
        }
      ts.forEachChild(n, visit);
    };
    visit(body);
    const slots = sites.map((call) => {
      const slot = this.tmp("claim");
      this.line(`uint64_t ${slot} = (uint64_t)-1;`);
      this.claimSlots.set(call, slot);
      return slot;
    });
    return () => {
      for (const slot of slots) this.line(`ts_release_mut(params, &${slot});`);
    };
  }

  protected body(stmt: ts.Statement) {
    if (ts.isBlock(stmt)) stmt.statements.forEach((s) => this.reporter.guard(() => this.statement(s)));
    else this.statement(stmt);
  }

  protected variable(list: ts.VariableDeclarationList, topLevel = false) {
    const mutable = !(list.flags & ts.NodeFlags.Const);
    if (!(list.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) this.fail(list, "use const or let, not var");
    for (const d of list.declarations) {
      if (ts.isObjectBindingPattern(d.name) && d.initializer) {
        this.destructure(list, d, d.name, d.initializer, topLevel);
        continue;
      }
      if (!ts.isIdentifier(d.name) || !d.initializer) this.fail(d, "declare one plain name with an initializer");
      // A local function is a helper of its own (lifted when the program was analyzed): nothing to run here.
      if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
        // A closure: remembered with the scopes it can see, and expanded where it is called.
        if (this.model.closureDecls.has(d)) {
          this.scopes.at(-1)!.set(d.name.text, {
            c: "",
            type: BOOL,
            mutable: false,
            closure: { node: d.initializer, name: d.name.text, scopes: [...this.scopes], env: this.envNow(), imports: this.scope.imports },
          });
          continue;
        }
        if (!this.model.helperDecls.has(d)) this.fail(d, "declare local functions with const: const f = (…) => …");
        continue;
      }
      const name = d.name.text;
      if (this.scopes.at(-1)!.has(name)) this.fail(d.name, `"${name}" is already declared`);
      // Account lookups go by name, so a local must not hide a parameter (it would read the parameter instead).
      if (this.accounts.has(name) || this.args.has(name) || this.isGroup(name))
        this.fail(d.name, `"${name}" shadows the parameter "${name}"; use another name`);
      const c = `l_${name}_${this.temp++}`;

      const init = d.initializer;
      // Run-time offset views (loadRawAt, rawArrayAt, rbTreeAt) and references into a tree's nodes (views.ts).
      if (this.bindView(d, init, name, c, mutable)) continue;
      // A function as a value: another name for one (`const h = g`), or the one a function returns (`adder(5n)`).
      const made = ts.isCallExpression(init) ? this.madeFunction(init) : undefined;
      const alias = ts.isIdentifier(init) ? this.functionNamed(init) : undefined;
      const choice = this.functionChoice(init, name);
      if (choice) {
        if (mutable) this.fail(d, "bind functions with const");
        this.scopes.at(-1)!.set(name, { c: "", type: BOOL, mutable: false, choice });
        continue;
      }
      if (made || alias) {
        if (mutable) this.fail(d, "bind functions with const");
        this.scopes.at(-1)!.set(name, { c: "", type: BOOL, mutable: false, closure: (made ?? alias)! });
        continue;
      }
      const fn = ts.isCallExpression(init) ? this.exportName(init.expression) : undefined;
      // The instruction's data as sent, discriminator included (a @fallback's input): a list of u8.
      if (fn === "instructionData") {
        if ((init as ts.CallExpression).arguments.length) this.fail(init, "instructionData() takes no arguments");
        this.line(`TS_VecArg ${c} = {params->data, (uint32_t)params->data_len};`);
        this.scopes.at(-1)!.set(name, { c, type: { kind: "vecArg", elem: { kind: "int", name: "u8" } }, mutable: false });
        continue;
      }
      // One of two seed lists, picked at run time: `const pool = indexed ? signer([…, index, bump]) : signer([…, bump])`.
      // Both lists are built (seeds have no side effects to skip), then one is chosen.
      if (
        init &&
        ts.isConditionalExpression(init) &&
        [init.whenTrue, init.whenFalse].every((b) => ts.isCallExpression(b) && this.exportName(b.expression) === "signer")
      ) {
        if (mutable) this.fail(d, "bind seed lists with const");
        const cond = this.expect(this.expr(init.condition, BOOL), BOOL, init.condition);
        const flag = this.tmp("which");
        this.line(`bool ${flag} = ${cond.c};`);
        const a = this.signerSeedsArg(init.whenTrue);
        const b = this.signerSeedsArg(init.whenFalse);
        this.line(`const SolSignerSeed *${c} = ${flag} ? ${a.name} : ${b.name};`);
        this.line(`int ${c}__n = ${flag} ? ${a.count} : ${b.count};`);
        this.line(`(void)${c}; (void)${c}__n;`);
        this.scopes.at(-1)!.set(name, { c, type: { kind: "signerSeeds" }, mutable: false });
        continue;
      }
      // A seed list to sign with more than once: `const vault = signer(["vault", owner.key, bump])`.
      if (fn === "signer") {
        if (mutable) this.fail(d, "bind seed lists with const");
        const s = this.signerSeedsArg(init);
        this.line(`const SolSignerSeed *${c} = ${s.name};`);
        this.line(`int ${c}__n = ${s.count};`);
        this.line(`(void)${c}; (void)${c}__n;`);
        this.scopes.at(-1)!.set(name, { c, type: { kind: "signerSeeds" }, mutable: false });
        continue;
      }
      if (fn === "fixedArray") {
        const t = this.localArray(init as ts.CallExpression, c, d.type);
        this.scopes.at(-1)!.set(name, { c, type: t, mutable });
        continue;
      }
      if (this.isPipeline(init)) {
        const t = this.localList(d, init, c);
        this.scopes.at(-1)!.set(name, { c, type: t, mutable });
        continue;
      }
      if (fn === "loadAccount" || fn === "loadAccountMut" || fn === "loadForeign" || fn === "loadRaw" || fn === "loadRawMut") {
        if (mutable) this.fail(d, "bind loaded accounts with const");
        const t =
          fn === "loadForeign"
            ? this.loadForeign(init as ts.CallExpression)
            : fn === "loadRaw" || fn === "loadRawMut"
              ? this.loadRaw(init as ts.CallExpression, fn === "loadRawMut")
              : this.loadAccount(init as ts.CallExpression, fn === "loadAccountMut");
        this.line(`${valueC(t.type)}${c} = ${t.c};`);
        // The account it views, kept to pass the struct on to a helper that takes Account<T> / Mut<T>.
        let loaded: Local["loaded"];
        if ((fn === "loadAccount" || fn === "loadAccountMut") && t.type.kind === "structRef") {
          // The view is `((TSS_T *)(h->data + 8))` over a `TsAccount *h` that stays in scope with it.
          const h = /^\(\(TSS_\w+ \*\)\((\w+)->data \+ 8\)\)$/.exec(t.c)?.[1];
          if (h) loaded = { handle: h, struct: t.type.struct, mut: fn === "loadAccountMut" };
        }
        this.scopes.at(-1)!.set(name, { c, type: t.type, mutable: false, paths: [`@${c}`], decl: d, loaded, ...(t.bigCap ? { bigCap: t.bigCap } : {}) });
        continue;
      }
      // A local decoded from an account's Borsh bytes: `const pool = loadBorsh<StakePool>(acct)` (a copy, as Rust's).
      if (fn === "loadBorsh") {
        if (mutable) this.fail(d, "bind loadBorsh<T>(...) with const (its fields can still be updated)");
        const named = d.type && structNameOf(d.type, this.scope);
        const declared = named ? this.model.structs.get(named) : undefined;
        if (d.type && !declared) this.fail(d.type, "loadBorsh returns a struct: declare the local as one (or leave the type out)");
        const s = this.loadBorsh(init as ts.CallExpression, c, declared);
        this.scopes
          .at(-1)!
          .set(name, { c, type: { kind: "structRef", struct: s.name, writable: true }, mutable: false, paths: [`@${c}`], decl: d, owned: true });
        continue;
      }
      // A struct another program returned: `const q = returnData<Quote>(amm)` (Anchor's `get_return_data` + deserialize).
      if (fn === "returnData" && this.returnedStruct(init as ts.CallExpression)) {
        if (mutable) this.fail(d, "bind return data with const (its fields can still be updated)");
        const S = this.returnedStruct(init as ts.CallExpression)!;
        const call = init as ts.CallExpression;
        if (call.arguments.length !== 1) this.fail(call, "returnData<T>(program) takes the program that returned it");
        const program = this.anyAccount(call.arguments[0], "returnData's program");
        const bad = `TS_FAIL(TS_ERR_RETURN_DATA, "TypeSOL: invalid ${S.name} return data")`;
        if (S.layout === "borsh") {
          // Borsh of any size: unpacked into the fixed-layout struct, every byte used.
          const raw = `${c}__raw`;
          this.line(`uint8_t *${raw};`);
          this.line(`uint64_t ${raw}_len = 0, ${raw}_used = 0;`);
          this.line(`TS_TRY(ts_return_data_any(${program}, &${raw}, &${raw}_len));`);
          this.line(`TSS_${S.name} *${c};`);
          this.line(`TS_TRY(ts_alloc(sizeof(TSS_${S.name}), (uint8_t **)&${c}));`);
          this.line(`if (ts_unpack_${S.name}(${raw}, ${raw}_len, ${c}, &${raw}_used) != SUCCESS || ${raw}_used != ${raw}_len) ${bad};`);
          for (const f of S.fields) if (f.type.kind === "fstring") this.line(`if (!ts_utf8_valid(${c}->${f.name}.bytes, ${c}->${f.name}.len)) ${bad};`);
        } else {
          // A fixed layout whose bytes are its Borsh form: copied in, then bools and enums checked.
          this.line(`TSS_${S.name} ${c}__v;`);
          this.line(`TS_TRY(ts_return_data_exact(${program}, &${c}__v, sizeof(TSS_${S.name})));`);
          for (const l of this.validation(`${c}__v`, { kind: "struct", name: S.name }, "", bad)) this.line(l.trim());
          this.line(`TSS_${S.name} *${c} = &${c}__v;`);
        }
        this.scopes.at(-1)!.set(name, { c, type: { kind: "structRef", struct: S.name, writable: true }, mutable: false, paths: [`@${c}`], decl: d });
        continue;
      }
      // A local list declared with its type: `const metas: FixedVec<Meta, 4> = fixedVec([{ pubkey, isSigner, … }])`,
      // `const buf: FixedVec<u8, 600> = fixedVec([])`, or a copy of another list (a Vec argument, instruction data).
      const listType = d.type ? this.listAnnotation(d.type) : undefined;
      if (listType) {
        this.checkLocalListSize(listType, d.type!);
        if (listType.kind === "vec") {
          this.model.localVecs.set(fixedVecC(listType), listType);
          this.line(`${fixedVecC(listType)} ${c};`);
          this.line(`ts_memzero(&${c}, sizeof(${c}));`);
        } else this.line(`${storageDecl(listType, c)};`);
        this.writeAggregate({ lv: c, type: listType, writable: true }, init, true);
        this.scopes.at(-1)!.set(name, { c, type: listType, mutable });
        continue;
      }
      // Struct values: `const p: Point = { x, y }` (or a copy of another Point) is a local of its own.
      const structType = d.type && structNameOf(d.type, this.scope) ? this.model.structs.get(structNameOf(d.type, this.scope)!) : undefined;
      if (structType) {
        if (mutable) this.fail(d, "bind struct values with const (their fields can still be updated)");
        if (structType.size === undefined || structType.vec) this.fail(d.type!, `${structType.name} has variable-size fields and cannot be a local`);
        this.line(`TSS_${structType.name} ${c}__v;`);
        this.writeAggregate({ lv: `${c}__v`, type: { kind: "struct", name: structType.name }, writable: true }, init, true);
        this.line(`TSS_${structType.name} *${c} = &${c}__v;`);
        this.scopes
          .at(-1)!
          .set(name, { c, type: { kind: "structRef", struct: structType.name, writable: true }, mutable: false, paths: [`@${c}`], decl: d, owned: true });
        continue;
      }
      // Data enums: `const a: Action = { kind: "X", ... }` builds a local; `const a = acct.action` aliases storage.
      const enumType =
        d.type && ts.isTypeReferenceNode(d.type) && ts.isIdentifier(d.type.typeName) ? this.model.dataEnums.get(d.type.typeName.text) : undefined;
      if (enumType || (!d.type && this.looksLikeDataEnum(init))) {
        let name2: string;
        let ptr: string;
        let writable = true;
        let paths = [`@${c}`];
        if (enumType && ts.isObjectLiteralExpression(init)) {
          name2 = enumType.name;
          this.line(`TSE_${name2} ${c}__v;`);
          this.writeAggregate({ lv: `${c}__v`, type: { kind: "dataEnum", name: name2 }, writable: true }, init);
          ptr = `&${c}__v`;
        } else {
          const r = this.ref(init);
          if (!r || r.type.kind !== "dataEnum" || (enumType && r.type.name !== enumType.name)) this.fail(init, `expected a ${enumType?.name ?? "data enum"}`);
          name2 = r.type.name;
          ptr = `(&${r.lv})`;
          writable = r.writable;
          paths = this.pathsOf(init) ?? paths;
        }
        if (mutable) this.fail(d, "bind data enums with const (the value itself can still be updated)");
        this.line(`TSE_${name2} *${c} = ${ptr};`);
        this.scopes.at(-1)!.set(name, { c, type: { kind: "enumRef", name: name2, writable }, mutable: false, paths, decl: d });
        continue;
      }
      // `const o = book.asks.get(i)` (or a ternary of two such places) aliases account data, like a JS object reference.
      const target = d.type ? undefined : this.structPlace(init);
      if (target) {
        if (mutable) this.fail(d, "bind struct references with const");
        this.line(`TSS_${target.struct} *${c} = ${target.ptr};`);
        // A struct a helper returned lives in a local this function owns, not in account data.
        const owned = ts.isCallExpression(init) && !!this.helperOf(init);
        this.scopes.at(-1)!.set(name, {
          c,
          type: { kind: "structRef", struct: target.struct, writable: target.writable },
          mutable: false,
          paths: owned ? [`@${c}`] : this.pathsOf(init),
          decl: d,
          ...(owned ? { owned } : {}),
        });
        continue;
      }
      let declared: ValueType | undefined;
      if (d.type && typesolName(d.type, this.scope.imports) === "EpochRewards") declared = { kind: "epochRewards" };
      else if (d.type) {
        declared = resolveValueType(d.type, this.scope);
        if (!declared || declared.kind === "vecArg") this.fail(d.type, "local type must be an integer, boolean, Pubkey, enum, option or string");
      }
      // `const bump = acct.create(...)` / `const fresh = acct.createIfNeeded(...)` count as top-level statements.
      const isCreate =
        topLevel && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && /^create(IfNeeded)?$/.test(init.expression.name.text);
      const raw = isCreate ? this.call(init as ts.CallExpression, true) : undefined;
      const v = this.expect(raw ?? this.expr(init, declared), declared, init);
      const type = declared ?? v.type;
      if (type.kind === "remaining") {
        if (mutable) this.fail(d, "bind remainingAccounts() with const");
        this.scopes.at(-1)!.set(name, { c: v.c, type, mutable: false });
        continue;
      }
      if ((type.kind === "account" || type.kind === "structRef") && mutable) this.fail(d, "bind accounts with const");
      if (type.kind === "pubkey") this.line(`SolPubkey ${c} = *(${v.c});`);
      else this.line(`${valueC(type)}${type.kind === "account" ? "" : " "}${c} = ${this.ownedString(v).c};`);
      // A struct a helper returned lives in a local this function owns, not in account data.
      const owned = type.kind === "structRef" && ts.isCallExpression(init) && !!this.helperOf(init);
      this.scopes.at(-1)!.set(name, { c, type, mutable, ...(owned ? { paths: [`@${c}`], owned } : {}) });
    }
  }

  /**
   * `const { a, b: c } = s`: one declaration per name, `const a = s.a`, in source order. The source must be a name or
   * a field path (no calls), so reading it once per name reads the same thing JS reads once.
   */
  protected destructure(list: ts.VariableDeclarationList, d: ts.VariableDeclaration, pattern: ts.ObjectBindingPattern, init: ts.Expression, topLevel: boolean) {
    if (d.type) this.fail(d.type, "destructuring takes the types from the source; drop the annotation");
    const plain = (e: ts.Expression): boolean =>
      ts.isIdentifier(e) ||
      (ts.isPropertyAccessExpression(e) && !e.questionDotToken && plain(e.expression)) ||
      (ts.isParenthesizedExpression(e) && plain(e.expression));
    if (!plain(init)) this.fail(init, "destructure a variable or a field (a.b.c); bind a call to a const first");
    const f = ts.factory;
    for (const el of pattern.elements) {
      if (el.dotDotDotToken) this.fail(el, "...rest is not supported in destructuring");
      if (el.initializer) this.fail(el, "default values are not supported in destructuring");
      if (!ts.isIdentifier(el.name)) this.fail(el, "nested destructuring is not supported; destructure in two steps");
      const prop = el.propertyName ?? el.name;
      if (!ts.isIdentifier(prop)) this.fail(el, "use plain field names");
      const access = f.createPropertyAccessExpression(init, prop.text);
      ts.setTextRange(access, el);
      (access as { parent?: ts.Node }).parent = d;
      // The element's own name node, so aliasing checks and the type checker find its uses.
      const decl = f.createVariableDeclaration(el.name, undefined, undefined, access);
      ts.setTextRange(decl, el);
      (decl as { parent?: ts.Node }).parent = list;
      this.variable({ ...list, declarations: [decl] } as unknown as ts.VariableDeclarationList, topLevel);
    }
  }

  protected expressionStatement(e: ts.Expression, topLevel: boolean) {
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) return this.assign(e.left, e.right, undefined, topLevel);
      const compound: Partial<Record<ts.SyntaxKind, ts.BinaryOperator>> = {
        [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken,
        [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken,
        [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken,
        [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken,
        [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken,
        [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken,
        [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken,
        [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken,
        [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken,
        [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken,
      };
      const base = compound[op];
      if (base !== undefined) return this.assign(e.left, e.right, base);
      if (op === ts.SyntaxKind.AsteriskAsteriskEqualsToken) {
        // x **= n is x = x ** n; the target is read twice, so it must not run anything (no calls in it).
        let hasCall = false;
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && !this.isStorageCall(n)) hasCall = true;
          ts.forEachChild(n, visit);
        };
        visit(e.left);
        if (hasCall) this.fail(e.left, "**= on a target that calls a function: write x = x ** n with the target in a local");
        const f = ts.factory;
        const pow = f.createBinaryExpression(e.left, ts.SyntaxKind.AsteriskAsteriskToken, e.right);
        ts.setTextRange(pow, e);
        (pow as { parent?: ts.Node }).parent = e;
        return this.assign(e.left, pow);
      }
    }
    if (
      (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) &&
      (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const place = this.place(e.operand);
      if (place.type.kind !== "int") this.fail(e, "++ and -- need an integer");
      const one = this.literal(1n, place.type, e);
      const op = e.operator === ts.SyntaxKind.PlusPlusToken ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken;
      this.line(place.write(this.arith(op, { c: place.read, type: place.type }, one, e).c) + ";");
      return;
    }
    if (ts.isCallExpression(e)) {
      this.call(e, topLevel);
      return;
    }
    this.fail(e, "this expression has no effect; only assignments and calls can be statements");
  }

  protected assign(target: ts.Expression, valueNode: ts.Expression, op?: ts.BinaryOperator, topLevel = false) {
    // The place is resolved before the right side runs (JS order). A right side that can resize a Vec of the account
    // would move the element out from under it: the write would land in the bytes that follow.
    if (this.writesThroughVec(target) && this.mayResizeVecs(valueNode))
      this.fail(target, "the right side may change this Vec (a helper, closure or push/pop/clear); store its result in a local first");
    if (op !== undefined) {
      const place = this.place(target);
      let current: Value = { c: place.read, type: place.type };
      if (place.type.kind === "string") {
        // s += x: concatenation into a fresh heap string (x may be a string, integer or boolean).
        if (op !== ts.SyntaxKind.PlusToken) this.fail(target, "strings support += only");
        // Account text is read before the right side runs (which may change it), as in JS.
        let cur = current.c;
        if (!/^\w+$/.test(cur)) {
          cur = this.tmp("cur");
          this.line(`TS_Str ${cur};`);
          this.line(`TS_TRY(ts_str_copy(${current.c}, &${cur}));`);
        }
        // A local grows in place when it is the newest heap string (a loop of `s += …` copies each piece once); a
        // template on the right is appended piece by piece.
        const local = cur === current.c && place.write("X") === `${cur} = X`;
        const bare = (e: ts.Expression): ts.Expression => (ts.isParenthesizedExpression(e) ? bare(e.expression) : e);
        const rhsNode = bare(valueNode);
        if (local && ts.isTemplateExpression(rhsNode)) {
          const pieces = this.templatePieces(rhsNode);
          if (pieces.text !== undefined)
            this.line(`TS_TRY(ts_str_append(&${cur}, ts_str((const uint8_t *)${cString(pieces.text)}, ${Buffer.byteLength(pieces.text, "utf8")})));`);
          else if (pieces.only !== undefined) this.line(`TS_TRY(ts_str_append(&${cur}, ${pieces.only}));`);
          else this.line(`TS_TRY(ts_str_append_parts(&${cur}, ${pieces.arr}, ${pieces.n}));`);
          return;
        }
        const rhs = this.toText(valueNode);
        if (local) {
          this.line(`TS_TRY(ts_str_append(&${cur}, ${rhs}));`);
          return;
        }
        const t = this.tmp("cat");
        this.line(`TS_Str ${t};`);
        this.line(`TS_TRY(ts_str_concat(${cur}, ${rhs}, &${t}));`);
        this.line(place.write(t) + ";");
        return;
      }
      const mark = this.lines.length;
      const rhs = this.expect(this.expr(valueNode, place.type), place.type, valueNode);
      current = this.settle(current, mark);
      this.line(place.write(this.arith(op, current, rhs, target).c) + ";");
      return;
    }
    // JS evaluates the target (`a.get(i).x`: which element) before the right side. The exception is
    // `acct.field = acct.create(...)`, which must create the account before the field can be touched.
    // `fixedVec([…])` is a value written in place, not a call.
    const isCall = ts.isCallExpression(valueNode) && !this.isStorageCall(valueNode) && this.exportName(valueNode.expression) !== "fixedVec";
    const createsFirst = isCall && ts.isPropertyAccessExpression(valueNode.expression) && ["create", "createIfNeeded"].includes(valueNode.expression.name.text);
    let raw = createsFirst ? this.call(valueNode as ts.CallExpression, topLevel) : undefined;
    if (createsFirst && !raw) this.fail(valueNode, "this call does not produce a value");
    // A helper's struct result is copied like any struct (the target first, as JS evaluates it first).
    const structCall =
      isCall && ts.isIdentifier((valueNode as ts.CallExpression).expression)
        ? this.helperOf(valueNode as ts.CallExpression)?.returns?.kind === "struct"
        : false;
    // Whole arrays / structs: copy between identical layouts.
    const targetRef = isCall && !structCall ? undefined : this.ref(target);
    if (
      targetRef &&
      (targetRef.type.kind === "array" ||
        targetRef.type.kind === "struct" ||
        targetRef.type.kind === "dataEnum" ||
        (targetRef.type.kind === "vec" && (targetRef.type.cap !== undefined || !!targetRef.type.heap)) ||
        (targetRef.type.kind === "option" && targetRef.type.inner.kind === "struct"))
    ) {
      if (!targetRef.writable) this.fail(target, this.readOnly(targetRef));
      this.assertNotAliased(this.pathsOf(target), target);
      this.writeAggregate(targetRef, valueNode);
      return;
    }
    const place = this.place(target);
    if (isCall && !createsFirst) {
      raw = this.call(valueNode as ts.CallExpression, topLevel);
      if (!raw) this.fail(valueNode, "this call does not produce a value");
    }
    let value = this.expect(raw ?? this.expr(valueNode, place.type), place.type, valueNode);
    // A local, or a string field of a variable enum (a view), keeps its own copy of account text.
    if (ts.isIdentifier(target) || (value.type.kind === "string" && this.peekKind(target) === "string")) value = this.ownedString(value);
    this.line(place.write(value.c) + ";");
  }
}
