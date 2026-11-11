import ts from "typescript";
import { type FieldType, isWritable } from "../model.js";
import { EmitterBase } from "./base.js";

/** A tree's methods other than get that return a node of it. */
const TREE_NODE_METHODS = new Set(["min", "max", "nodeAt", "remove", "removeAt"]);

/**
 * Aliasing, in one place. A struct read from account data is a reference into that data, not a copy, so code that
 * replaces or moves the data under a reference still in use would let it read a value JS would not show. The rules:
 *
 * - `pathsOf` names the storage an expression refers to (`acct.a.b`, `v[]` for a Vec element, a reference local's
 *   paths); every reference local records its paths when it is declared (statements.ts).
 * - `assertNotAliased(paths, at)` refuses replacing a place while a reference into it is read later (`usedAfter`).
 *   Called for: assigning a struct or list (statements.ts `assign`); `set` of a struct element of an array or Vec,
 *   `pop` and `clear` (calls.ts); any push / pop / clear that moves the growable Vecs stored after the one it resizes
 *   (calls.ts `tailStart`); a helper taking a writable struct account (calls.ts); `acct.migrate(…)` (calls.ts).
 * - `mayResizeVecs(node)` decides whether evaluating a value may resize a growable Vec (moving the Vecs after it); an
 *   assignment whose target is reached through a Vec element (`writesThroughVec`) is then refused (statements.ts).
 *
 * Accounts passed twice are a separate rule: function.ts refuses two writable parameters naming one account (2040)
 * unless `Dup<…>` allows it for in-place accounts.
 */
export abstract class AliasEmitter extends EmitterBase {
  /**
   * The trees a `for … of` is walking, by C name, with the account each views: no tree view that may be the same tree
   * (the same local, or another view of an account that may be the walked one's) may change its structure in the
   * loop (Rust's borrow).
   */
  protected iteratingTrees = new Map<string, { name: string; acct: string }>();

  protected abstract peekKind(node: ts.Expression): FieldType["kind"] | undefined;

  /**
   * Storage paths an expression names, syntactically: `acct.a.b` -> ["acct.a.b"], `v.get(i)` -> ["v[]"],
   * a reference local -> the paths it aliases, a ternary -> both sides. Undefined when unknown.
   */
  protected pathsOf(node: ts.Expression): string[] | undefined {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) return this.pathsOf(node.expression);
    if (ts.isIdentifier(node)) {
      const l = this.lookup(node.text);
      if (l) return l.paths ?? (l.type.kind === "array" || l.type.kind === "vec" || l.type.kind === "rbTree" ? [`@${l.c}`] : undefined);
      return this.accounts.has(node.text) ? [node.text] : undefined;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const field = this.accountAt(node);
      if (field && !ts.isIdentifier(node)) return [field.name];
      return this.pathsOf(node.expression)?.map((p) => `${p}.${node.name.text}`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "get")
      return this.pathsOf(node.expression.expression)?.map((p) => `${p}[]`);
    // A tree's methods that hand out a node (`t.min()`, `t.nodeAt(i)`, `t.remove(k)`): a reference into its nodes.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && TREE_NODE_METHODS.has(node.expression.name.text)) {
      const base = node.expression.expression;
      const l = ts.isIdentifier(base) ? this.lookup(base.text) : undefined;
      if (l?.type.kind === "rbTree") return [`@${l.c}[]`];
    }
    // `big.slice(a, b)` is a view of the list's own elements: the same storage.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "slice")
      return this.pathsOf(node.expression.expression);
    if (ts.isConditionalExpression(node)) {
      const a = this.pathsOf(node.whenTrue);
      const b = this.pathsOf(node.whenFalse);
      return a && b ? [...a, ...b] : undefined;
    }
    return undefined;
  }

  /**
   * In JS, replacing an object (`acct.pos = {...}`, `v.set(i, {...})`, `v.pop()`) leaves earlier references
   * to the old object unchanged. Here a reference is a pointer into account data, so it would see the new
   * value. Refuse when a live reference into the replaced place is still used afterwards.
   */
  protected assertNotAliased(replaced: string[] | undefined, at: ts.Node, helper?: string) {
    if (!replaced) return;
    for (const scope of this.scopes)
      for (const [name, l] of scope) {
        if (!l.paths || !l.decl) continue;
        const hit = replaced.find((r) => l.paths!.some((p) => p === r || p.startsWith(`${r}.`) || p.startsWith(`${r}[]`)));
        if (!hit || !this.usedAfter(l.decl, at)) continue;
        this.fail(
          at,
          helper
            ? `"${name}" still refers to data in ${this.showPath(hit)}, and ${helper}() may replace it (then "${name}" would read the new value; in JS it keeps the old one). Copy the fields you need into locals first`
            : `"${name}" still refers to ${this.showPath(hit)}; replacing it here would change what "${name}" reads (in JS it keeps the old value). Copy the fields you need into locals first`,
        );
      }
  }

  /**
   * Whether the variable declared by `decl` is read after `at` (later in its block, or anywhere in a loop around `at`).
   * A parameter (of a closure or helper expanded here) is read after `at` when its function reads it after `at`; when
   * `at` is in another function (a closure or helper it calls), any read of it in its own function counts.
   */
  protected usedAfter(decl: ts.VariableDeclaration | ts.ParameterDeclaration, at: ts.Node): boolean {
    const symbol = this.checker.getSymbolAtLocation(decl.name);
    if (!symbol) return true;
    if (ts.isParameter(decl)) {
      const fn = decl.parent;
      const inside = at.getSourceFile() === fn.getSourceFile() && at.pos >= fn.pos && at.end <= fn.end;
      let read = false;
      const visitParam = (n: ts.Node) => {
        if (read) return;
        if (ts.isIdentifier(n) && n !== decl.name && this.checker.getSymbolAtLocation(n) === symbol) {
          if (!inside || n.pos >= at.end) read = true;
          // A loop inside the function, around `at`, reads it again on its next turn.
          for (let p: ts.Node | undefined = at.parent; inside && p && p !== fn; p = p.parent)
            if ((ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && n.pos >= p.pos && n.end <= p.end)
              read = true;
        }
        ts.forEachChild(n, visitParam);
      };
      const body = (fn as { body?: ts.Node }).body;
      if (body) visitParam(body);
      return read;
    }
    // Loops around `at` that do not also contain the declaration run their earlier statements again later.
    let loop: ts.Node | undefined;
    for (let n: ts.Node | undefined = at.parent; n && n !== decl.parent; n = n.parent)
      if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) && !(decl.pos >= n.pos && decl.end <= n.end))
        loop = n;
    let found = false;
    const scope = decl.parent.parent.parent; // VariableDeclaration -> List -> Statement -> enclosing block
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(n) && n !== decl.name && this.checker.getSymbolAtLocation(n) === symbol) {
        if (n.pos >= at.end || (loop && n.pos >= loop.pos && n.end <= loop.end)) found = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return found;
  }

  /**
   * A helper given a place to change (`Inout<T>`) may replace what is stored inside it (`rec.inner = { … }`,
   * `rec.items.pop()`), so a reference into it that is read after the call would read the new value where JS keeps the
   * old object. References to the place itself (or to what holds it) see the same object as JS does, so only those
   * strictly inside it are refused.
   */
  protected assertNothingInside(place: string[], at: ts.Node, helper: string, arg: string) {
    for (const scope of this.scopes)
      for (const [name, l] of scope) {
        if (!l.paths || !l.decl) continue;
        const hit = place.find((r) => l.paths!.some((p) => p.startsWith(`${r}.`) || p.startsWith(`${r}[]`)));
        if (!hit || !this.usedAfter(l.decl, at)) continue;
        this.fail(
          at,
          `"${name}" refers to data inside ${arg}, which ${helper}() may change in place (Inout); if it replaced that data, "${name}" would read the new value where JS keeps the old one. Copy the fields you need into locals before the call, or read them through ${arg} after it`,
        );
      }
  }

  /**
   * The account a native view's first argument names, as `viewAcct` records it: a declared parameter's name, or "?"
   * when it is not one (a remaining account, a choice between accounts).
   */
  protected viewAccountKey(node: ts.Expression): string {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return ts.isIdentifier(node) && !this.lookup(node.text) && this.accounts.has(node.text) ? node.text : "?";
  }

  /**
   * Whether two accounts `viewAccountKey` named may be one account at run time: the same name, one not a declared
   * parameter, or two parameters the runtime does not keep apart (a helper's, any two under NATIVE_ACCOUNT_WRITES, a
   * read-only or Dup one; function.ts refuses two writable parameters naming one account otherwise).
   */
  protected mayBeSameAccount(a: string, b: string): boolean {
    if (a === b || a === "?" || b === "?" || this.nativeAccountWrites()) return true;
    const [x, y] = [this.accounts.get(a), this.accounts.get(b)];
    if (!x || !y || x.index === -1 || y.index === -1) return true;
    return !(isWritable(x.kind) && isWritable(y.kind) && !x.constraints.dup && !y.constraints.dup);
  }

  /**
   * `closeRaw(acct, …)` / `resizeAccount(acct, n)` (or a helper that may do either, `target` "?"): a view checks its
   * bounds once, when it is made, so a view of the account made before (and anything read through it) would reach past
   * the account's new end afterwards. Refused when it is used later; the fix is to take the view again.
   */
  protected assertNoViewAfter(target: string, at: ts.Node, what: string): void {
    const dead = new Set<string>();
    for (const scope of this.scopes) for (const l of scope.values()) if (l.viewAcct !== undefined && this.mayBeSameAccount(l.viewAcct, target)) dead.add(l.c);
    if (!dead.size) return;
    for (const scope of this.scopes)
      for (const [name, l] of scope) {
        if (!l.decl) continue;
        const hit = dead.has(l.c) || !!l.paths?.some((p) => p.startsWith("@") && dead.has(p.slice(1).split(/[.[]/)[0]!));
        if (!hit || !this.usedAfter(l.decl, at)) continue;
        this.fail(
          at,
          `"${name}" reads account data through a view made before ${what}, which changes the account's length: a view checks its bounds when it is made, so "${name}" could reach past the new end. Take the view again after ${what} and read through the new one`,
        );
      }
  }

  /** A storage path as the source names it: `@<C local>.x` becomes `<its name>.x` (`@p_rec.items[]` → `rec.items[]`). */
  protected showPath(path: string): string {
    if (!path.startsWith("@")) return path;
    // A @heap local is named through its pointer: `@(*l_x)`.
    const c = /^@(\(\*\w+\)|\w+)/.exec(path)?.[1];
    for (const s of [...this.scopes].reverse().concat(this.args))
      for (const [name, l] of s) if (c && (l.c === c || l.c === `(*${c})`)) return name + path.slice(c.length + 1);
    return path;
  }

  /** Whether two places share storage: the same path, or one inside the other. */
  protected placesOverlap(a: string[], b: string[]): boolean {
    const inside = (x: string, y: string) => x === y || x.startsWith(`${y}.`) || x.startsWith(`${y}[]`);
    return a.some((x) => b.some((y) => inside(x, y) || inside(y, x)));
  }

  /**
   * Whether a place is reached through an element of a list whose elements can move: a growable Vec of an account (a
   * push or pop of it, or of a Vec stored before it, moves them), a heap Vec (`@layout borsh`) or a BigVec (`retain`
   * shifts them). FixedVec and FixedArray elements stay where they are.
   */
  protected throughMovableList(node: ts.Expression): boolean {
    for (let n: ts.Expression = node; ;) {
      if (ts.isParenthesizedExpression(n)) n = n.expression;
      else if (ts.isConditionalExpression(n)) return this.throughMovableList(n.whenTrue) || this.throughMovableList(n.whenFalse);
      else if (ts.isPropertyAccessExpression(n)) n = n.expression;
      else if (ts.isNonNullExpression(n)) n = n.expression;
      else if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        (n.expression.name.text === "get" || n.expression.name.text === "slice")
      ) {
        const base: ts.Expression = n.expression.expression;
        // A list reached through another call (`a.get(i).get(j)`, `big.slice(s, e).get(i)`) is judged by the list under
        // it, walked next; it is not probed itself (a probed slice would keep a view whose lines were dropped).
        if (!ts.isCallExpression(base)) {
          const t = this.peekType(base);
          if (t?.kind === "vec" && t.cap === undefined) return true;
        }
        n = base;
      } else if (ts.isIdentifier(n)) return !!this.lookup(n.text)?.movable;
      else return false;
    }
  }

  protected abstract peekType(node: ts.Expression): FieldType | undefined;

  /** Whether a place goes through a Vec element (`v.get(i).x`, `v.get(i)`). */
  protected writesThroughVec(node: ts.Expression): boolean {
    for (let n: ts.Expression = node; ;) {
      if (ts.isParenthesizedExpression(n)) n = n.expression;
      else if (ts.isPropertyAccessExpression(n)) n = n.expression;
      else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "get") {
        if (this.peekKind(n.expression.expression) === "vec") return true;
        n = n.expression.expression;
      } else return false;
    }
  }

  protected helperTakesMutAccounts(node: ts.CallExpression): boolean {
    const h = this.helperOf(node);
    // A RemainingAccount(s) parameter may be loaded with loadAccountMut inside.
    return !!h?.params.some((p) => (p.account ? isWritable(p.account) : p.type.kind === "account" || p.type.kind === "remaining"));
  }

  /**
   * Whether evaluating `node` may resize a growable Vec (and so move the Vecs after it): a push / pop / clear, a
   * realloc or close, a helper taking a writable account or a function argument, or a closure (its body is not
   * looked into: it may capture the account). Conservative: it only decides whether a Vec element may be the target.
   */
  protected mayResizeVecs(node: ts.Node): boolean {
    let found = false;
    const isClosure = (e: ts.Expression) => ts.isArrowFunction(e) || ts.isFunctionExpression(e) || (ts.isIdentifier(e) && !!this.lookup(e.text)?.closure);
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isPropertyAccessExpression(callee) && ["push", "pop", "clear"].includes(callee.name.text)) found = true;
        else if (ts.isCallExpression(callee))
          found = true; // a function a function returns
        else if (ts.isIdentifier(callee)) {
          if (this.lookup(callee.text)?.closure) found = true;
          else if (["realloc", "resizeAccount", "close"].includes(this.exportName(callee) ?? "")) found = true;
          else if (this.helperOf(n) && (this.helperTakesMutAccounts(n) || n.arguments.some(isClosure))) found = true;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  }
}
