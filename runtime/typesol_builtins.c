/*
 * The compiler builtins a TypeSOL program can call, compiled with the program's clang and linked into every program
 * in place of platform-tools' compiler-builtins Rust library. That library is built separately for each platform-tools
 * host package (macOS, Linux arm64, Linux x86_64): the functions have the same instructions in each, but each build
 * splits them into differently numbered archive members, so the linker laid out the ones a program called (128-bit or
 * signed division, which pull in shared helpers) in another order and the program's calls had other offsets. These
 * definitions are compiled from this file by the clang that compiles the program, after the program's object, so the
 * binary depends on the clang and this source only.
 *
 * clang emits a call to these where SBF has no instruction for the operation: 128-bit multiplication, division and
 * variable shifts, and (SBPF v0 and v1) signed 64-bit division. The set is every symbol C integer code can reference,
 * for SBPF v0, v1 and v2 (test/language/builtins.test.ts checks it on every operator of every width).
 *
 * Two kinds of definition:
 * - Division (__udivti3, __umodti3, __divti3, __modti3, __divdi3, __moddi3) in C below, taking the shortest route for
 *   the operands' sizes (one 64-bit division when both fit in 64 bits, three for a divisor below 2^32, the 64-bit
 *   division for signed 64-bit values, where compiler-builtins divides bit by bit), so they cost no more compute units
 *   than compiler-builtins' versions on any input measured, and fewer on most.
 * - Multiplication and shifts (__multi3, __ashlti3, __lshrti3, __ashrti3) as assembly: the instructions
 *   compiler-builtins' build of them has for that SBPF version (https://github.com/rust-lang/compiler-builtins,
 *   licensed "MIT AND Apache-2.0 WITH LLVM-exception AND (MIT OR Apache-2.0)"; its LICENSE.txt is
 *   runtime/LICENSE-compiler-builtins.txt, and NOTICE says what is taken), one for one, so a program that calls only
 *   these links to the same bytes and costs the same compute units as before. clang compiles the equivalent C to
 *   other register choices, one to four units dearer per shift. The exception is __multi3 on SBPF v1 and v2 (whose
 *   stack frames work differently), in C, which costs less there: on v1 a program that calls __multi3 (128-bit or
 *   checked 64-bit multiplication) links to other bytes than with compiler-builtins.
 *
 * Rules for the C: no 128-bit multiplication, division or variable shift (each would call one of these functions,
 * itself included); 128-bit values are taken apart into 64-bit halves and put together with constant shifts, which are
 * register moves. Each function has the calling convention clang uses for the libcall (a 128-bit result through a
 * pointer in r1, a 128-bit argument in two registers, the shift amount in one), which is that of its C signature.
 *
 * Division by zero: every division TypeSOL emits checks its divisor first and fails with TS_ERR_DIV_ZERO, so none of
 * these is called with a zero divisor. If one were, it divides by zero with the 64-bit instruction, which the VM stops
 * with its division-by-zero error (compiler-builtins leaves that case undefined).
 */

typedef unsigned long long ts_u64;
typedef long long ts_i64;
typedef unsigned __int128 ts_u128;
typedef __int128 ts_i128;

#define TS_BUILTIN __attribute__((visibility("hidden")))
#define TS_LO(x) ((ts_u64)(x))
#define TS_HI(x) ((ts_u64)((ts_u128)(x) >> 64))
#define TS_MK(hi, lo) (((ts_u128)(ts_u64)(hi) << 64) | (ts_u64)(lo))
#define TS_M32 0xffffffffull

#if !defined(TS_SBPF_V0) && !defined(TS_SBPF_V1) && !defined(TS_SBPF_V2)
#error "compile with -DTS_SBPF_V0, -DTS_SBPF_V1 or -DTS_SBPF_V2 (builtinsCflags in src/compiler/toolchain.ts)"
#endif

/* Leading zeros of a nonzero 64-bit value: a binary search (SBF has no count-leading-zeros instruction). */
static inline __attribute__((always_inline)) ts_u64 ts_clz64(ts_u64 x) {
  ts_u64 n = 0;
  if ((x >> 32) == 0) n += 32, x <<= 32;
  if ((x >> 48) == 0) n += 16, x <<= 16;
  if ((x >> 56) == 0) n += 8, x <<= 8;
  if ((x >> 60) == 0) n += 4, x <<= 4;
  if ((x >> 62) == 0) n += 2, x <<= 2;
  if ((x >> 63) == 0) n += 1;
  return n;
}

/* a * b as 128 bits: SBPF v2's high-half multiply, else from 32-bit halves (the 64-bit multiply keeps the low half). */
static inline __attribute__((always_inline)) ts_u64 ts_mul_wide(ts_u64 a, ts_u64 b, ts_u64 *hi) {
#ifdef TS_SBPF_V2
  ts_u128 p = (ts_u128)a * b; /* mul64 and uhmul64: no __multi3 on v2 */
  *hi = TS_HI(p);
  return TS_LO(p);
#else
  ts_u64 a0 = a & TS_M32, a1 = a >> 32, b0 = b & TS_M32, b1 = b >> 32;
  ts_u64 p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
  ts_u64 mid = (p00 >> 32) + (p01 & TS_M32) + (p10 & TS_M32); /* below 3 * 2^32 */
  *hi = p11 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
  return (p00 & TS_M32) | (mid << 32);
#endif
}

/*
 * (u1:u0) / v for u1 < v, v normalized (its top bit set): the quotient (which fits in 64 bits) and the remainder.
 * Knuth's algorithm D on 32-bit digits, as Hacker's Delight's divlu: each quotient digit is estimated from the top two
 * digits by one 64-bit division and corrected at most twice.
 */
static inline __attribute__((always_inline)) ts_u64 ts_divlu_norm(ts_u64 u1, ts_u64 u0, ts_u64 v, ts_u64 *r) {
  const ts_u64 b = 1ull << 32;
  ts_u64 vn1 = v >> 32, vn0 = v & TS_M32;
  ts_u64 un1 = u0 >> 32, un0 = u0 & TS_M32;
  ts_u64 q1 = u1 / vn1, rhat = u1 - q1 * vn1;
  while (q1 >= b || q1 * vn0 > ((rhat << 32) | un1)) {
    q1 -= 1;
    rhat += vn1;
    if (rhat >= b) break;
  }
  ts_u64 un21 = (u1 << 32) + un1 - q1 * v;
  ts_u64 q0 = un21 / vn1;
  rhat = un21 - q0 * vn1;
  while (q0 >= b || q0 * vn0 > ((rhat << 32) | un0)) {
    q0 -= 1;
    rhat += vn1;
    if (rhat >= b) break;
  }
  *r = (un21 << 32) + un0 - q0 * v;
  return (q1 << 32) | q0;
}

/* a / b and a % b, unsigned 128-bit. A zero b divides by zero with the 64-bit instruction (see the top). */
static inline __attribute__((always_inline)) ts_u128 ts_udivmod128(ts_u128 a, ts_u128 b, ts_u128 *rem) {
  ts_u64 ah = TS_HI(a), al = TS_LO(a), bh = TS_HI(b), bl = TS_LO(b);
  if (bh == 0) {
    if (ah == 0) {
      /* Both fit in 64 bits: one division. */
      *rem = al % bl;
      return al / bl;
    }
    if ((bl >> 32) == 0) {
      /* A divisor below 2^32: short division, 64 then 32 then 32 bits of the dividend. */
      ts_u64 qh = ah / bl, r = ah % bl;
      ts_u64 mid = (r << 32) | (al >> 32);
      ts_u64 q1 = mid / bl;
      r = mid % bl;
      ts_u64 lo = (r << 32) | (al & TS_M32);
      ts_u64 q0 = lo / bl;
      *rem = lo % bl;
      return TS_MK(qh, (q1 << 32) | q0);
    }
    /* A 64-bit divisor: the high quotient word by one division, the low one from (ah % bl):al. */
    ts_u64 qh = 0, r1 = ah;
    if (ah >= bl) {
      qh = ah / bl;
      r1 = ah % bl;
    }
    ts_u64 s = ts_clz64(bl), r;
    ts_u64 u1 = s ? (r1 << s) | (al >> (64 - s)) : r1;
    ts_u64 q0 = ts_divlu_norm(u1, al << s, bl << s, &r);
    *rem = r >> s;
    return TS_MK(qh, q0);
  }
  /* b >= 2^64, so the quotient fits in 64 bits. */
  if (ah < bh || (ah == bh && al < bl)) {
    *rem = a;
    return 0;
  }
  if ((ah ^ bh) <= (ah & bh)) {
    /* The same top bit (the xor clears it, the and keeps it) and a >= b: the quotient is 1. */
    *rem = TS_MK(ah - bh - (al < bl), al - bl);
    return 1;
  }
  ts_u64 da = ts_clz64(ah), db = ts_clz64(bh), q, r;
  if (db - da < 32) {
    /*
     * The top 64 bits of a over the same bits of b (at least 2^32): the quotient or one more than it, as in
     * compiler-builtins' "two possibility" step. One less never overflows, so it is the start, corrected once.
     */
    ts_u64 sh = 64 - da;
    ts_u64 duo = da ? (ah << da) | (al >> sh) : ah, div = da ? (bh << da) | (bl >> sh) : bh;
    q = duo / div - 1;
  } else {
    /*
     * Hacker's Delight's divu128: the top 64 bits of b (normalized) into a / 2 by Knuth's step, which gives the
     * quotient or one more than it.
     */
    ts_u64 v1 = (bh << db) | (bl >> (64 - db)); /* db >= 32 here */
    ts_u64 q1 = ts_divlu_norm(ah >> 1, (ah << 63) | (al >> 1), v1, &r);
    q = q1 >> (63 - db);
    if (q != 0) q -= 1;
  }
  /* a - q * b (q * b <= a), then one correction. */
  ts_u64 ph, pl = ts_mul_wide(q, bl, &ph);
  ph += q * bh;
  ts_u64 rl = al - pl, rh = ah - ph - (al < pl);
  if (rh > bh || (rh == bh && rl >= bl)) {
    q += 1;
    rh -= bh + (rl < bl);
    rl -= bl;
  }
  *rem = TS_MK(rh, rl);
  return q;
}

TS_BUILTIN ts_u128 __udivti3(ts_u128 a, ts_u128 b) {
  ts_u128 r;
  return ts_udivmod128(a, b, &r);
}

TS_BUILTIN ts_u128 __umodti3(ts_u128 a, ts_u128 b) {
  ts_u128 r;
  ts_udivmod128(a, b, &r);
  return r;
}

/* Signed: the quotient rounds toward zero and the remainder has the dividend's sign, as in C (MIN / -1 wraps to MIN). */
TS_BUILTIN ts_i128 __divti3(ts_i128 a, ts_i128 b) {
  ts_u128 ua = a < 0 ? (ts_u128)0 - (ts_u128)a : (ts_u128)a, ub = b < 0 ? (ts_u128)0 - (ts_u128)b : (ts_u128)b, r;
  ts_u128 q = ts_udivmod128(ua, ub, &r);
  return (ts_i128)((a < 0) != (b < 0) ? (ts_u128)0 - q : q);
}

TS_BUILTIN ts_i128 __modti3(ts_i128 a, ts_i128 b) {
  ts_u128 ua = a < 0 ? (ts_u128)0 - (ts_u128)a : (ts_u128)a, ub = b < 0 ? (ts_u128)0 - (ts_u128)b : (ts_u128)b, r;
  ts_udivmod128(ua, ub, &r);
  return (ts_i128)(a < 0 ? (ts_u128)0 - r : r);
}

TS_BUILTIN ts_i64 __divdi3(ts_i64 a, ts_i64 b) {
  ts_u64 ua = a < 0 ? 0 - (ts_u64)a : (ts_u64)a, ub = b < 0 ? 0 - (ts_u64)b : (ts_u64)b;
  ts_u64 q = ua / ub;
  return (ts_i64)((a < 0) != (b < 0) ? 0 - q : q);
}

TS_BUILTIN ts_i64 __moddi3(ts_i64 a, ts_i64 b) {
  ts_u64 ua = a < 0 ? 0 - (ts_u64)a : (ts_u64)a, ub = b < 0 ? 0 - (ts_u64)b : (ts_u64)b;
  ts_u64 r = ua % ub;
  return (ts_i64)(a < 0 ? 0 - r : r);
}

/*
 * The assembly. In: r1 the result's address, r2 and r3 the first operand's low and high halves, r4 and r5 the second's
 * (__multi3) or r4 the shift amount, 0 to 127. Out: 16 bytes at r1. r6 to r9 and the stack frame at r10 are the
 * callee's, as in any SBF function.
 */
#ifdef TS_SBPF_V0
__asm__(
  ".section .text.__multi3,\"ax\",@progbits\n"
  ".hidden __multi3\n"
  ".globl __multi3\n"
  ".p2align 3\n"
  ".type __multi3,@function\n"
  "__multi3:\n"
  "  stxdw [r10 - 16], r3\n"
  "  stxdw [r10 - 8], r1\n"
  "  mov64 r1, r2\n"
  "  lsh64 r1, 32\n"
  "  rsh64 r1, 32\n"
  "  mov64 r7, r4\n"
  "  lsh64 r7, 32\n"
  "  rsh64 r7, 32\n"
  "  mov64 r6, r2\n"
  "  rsh64 r6, 32\n"
  "  mov64 r3, r7\n"
  "  mul64 r3, r1\n"
  "  mul64 r7, r6\n"
  "  mov64 r0, r4\n"
  "  rsh64 r0, 32\n"
  "  mov64 r9, r0\n"
  "  mul64 r9, r1\n"
  "  mov64 r1, r9\n"
  "  add64 r1, r7\n"
  "  mov64 r8, 1\n"
  "  jlt r1, r9, .Lmulti3_b0\n"
  "  mov64 r8, 0\n"
  ".Lmulti3_b0:\n"
  "  mov64 r9, r1\n"
  "  lsh64 r9, 32\n"
  "  mov64 r7, r3\n"
  "  add64 r7, r9\n"
  "  mov64 r9, 1\n"
  "  jlt r7, r3, .Lmulti3_e8\n"
  "  mov64 r9, 0\n"
  ".Lmulti3_e8:\n"
  "  ldxdw r3, [r10 - 8]\n"
  "  stxdw [r3 + 0], r7\n"
  "  rsh64 r1, 32\n"
  "  lsh64 r8, 32\n"
  "  or64 r8, r1\n"
  "  ldxdw r1, [r10 - 16]\n"
  "  mul64 r4, r1\n"
  "  mul64 r5, r2\n"
  "  add64 r5, r4\n"
  "  mul64 r0, r6\n"
  "  add64 r0, r5\n"
  "  add64 r0, r8\n"
  "  add64 r0, r9\n"
  "  stxdw [r3 + 8], r0\n"
  "  exit\n"
  ".size __multi3, .-__multi3\n"
  ".text\n");
#else
/* The low 128 bits of a * b (SBPF v1 and v2). */
TS_BUILTIN ts_u128 __multi3(ts_u128 a, ts_u128 b) {
  ts_u64 al = TS_LO(a), bl = TS_LO(b), hi;
  ts_u64 lo = ts_mul_wide(al, bl, &hi);
  return TS_MK(hi + al * TS_HI(b) + TS_HI(a) * bl, lo);
}
#endif

#if defined(TS_SBPF_V0) || defined(TS_SBPF_V1)
/* SBPF v0 and v1 (compiler-builtins has the same instructions for both). */
__asm__(
  ".section .text.__ashlti3,\"ax\",@progbits\n"
  ".hidden __ashlti3\n"
  ".globl __ashlti3\n"
  ".p2align 3\n"
  ".type __ashlti3,@function\n"
  "__ashlti3:\n"
  "  mov64 r5, r4\n"
  "  and64 r5, 64\n"
  "  jne r5, 0, .Lashlti3_70\n"
  "  jeq r4, 0, .Lashlti3_90\n"
  "  mov64 r5, r4\n"
  "  and64 r5, 63\n"
  "  lsh64 r3, r5\n"
  "  neg64 r4\n"
  "  and64 r4, 63\n"
  "  mov64 r0, r2\n"
  "  rsh64 r0, r4\n"
  "  or64 r3, r0\n"
  "  lsh64 r2, r5\n"
  "  ja .Lashlti3_90\n"
  ".Lashlti3_70:\n"
  "  and64 r4, 63\n"
  "  mov64 r3, r2\n"
  "  lsh64 r3, r4\n"
  "  mov64 r2, 0\n"
  ".Lashlti3_90:\n"
  "  stxdw [r1 + 0], r2\n"
  "  stxdw [r1 + 8], r3\n"
  "  exit\n"
  ".size __ashlti3, .-__ashlti3\n"
  ".section .text.__lshrti3,\"ax\",@progbits\n"
  ".hidden __lshrti3\n"
  ".globl __lshrti3\n"
  ".p2align 3\n"
  ".type __lshrti3,@function\n"
  "__lshrti3:\n"
  "  mov64 r5, r4\n"
  "  and64 r5, 64\n"
  "  jne r5, 0, .Llshrti3_78\n"
  "  jeq r4, 0, .Llshrti3_98\n"
  "  mov64 r5, r4\n"
  "  and64 r5, 63\n"
  "  rsh64 r2, r5\n"
  "  neg64 r4\n"
  "  and64 r4, 63\n"
  "  mov64 r0, r3\n"
  "  lsh64 r0, r4\n"
  "  or64 r0, r2\n"
  "  rsh64 r3, r5\n"
  "  mov64 r2, r0\n"
  "  ja .Llshrti3_98\n"
  ".Llshrti3_78:\n"
  "  and64 r4, 63\n"
  "  rsh64 r3, r4\n"
  "  mov64 r2, r3\n"
  "  mov64 r3, 0\n"
  ".Llshrti3_98:\n"
  "  stxdw [r1 + 0], r2\n"
  "  stxdw [r1 + 8], r3\n"
  "  exit\n"
  ".size __lshrti3, .-__lshrti3\n"
  ".section .text.__ashrti3,\"ax\",@progbits\n"
  ".hidden __ashrti3\n"
  ".globl __ashrti3\n"
  ".p2align 3\n"
  ".type __ashrti3,@function\n"
  "__ashrti3:\n"
  "  mov64 r5, r4\n"
  "  and64 r5, 64\n"
  "  jne r5, 0, .Lashrti3_70\n"
  "  jeq r4, 0, .Lashrti3_98\n"
  "  mov64 r5, r4\n"
  "  neg64 r5\n"
  "  and64 r5, 63\n"
  "  mov64 r0, r3\n"
  "  lsh64 r0, r5\n"
  "  and64 r4, 63\n"
  "  rsh64 r2, r4\n"
  "  or64 r0, r2\n"
  "  mov64 r2, r0\n"
  "  ja .Lashrti3_90\n"
  ".Lashrti3_70:\n"
  "  and64 r4, 63\n"
  "  mov64 r2, r3\n"
  "  arsh64 r2, r4\n"
  "  mov64 r4, 63\n"
  ".Lashrti3_90:\n"
  "  arsh64 r3, r4\n"
  ".Lashrti3_98:\n"
  "  stxdw [r1 + 0], r2\n"
  "  stxdw [r1 + 8], r3\n"
  "  exit\n"
  ".size __ashrti3, .-__ashrti3\n"
  ".text\n");
#else
/* SBPF v2: its 32-bit ALU forms (sub32 with immediate 0 is v2's negation). */
__asm__(
  ".section .text.__ashlti3,\"ax\",@progbits\n"
  ".hidden __ashlti3\n"
  ".globl __ashlti3\n"
  ".p2align 3\n"
  ".type __ashlti3,@function\n"
  "__ashlti3:\n"
  "  mov64 r5, r4\n"
  "  and32 w5, 64\n"
  "  jne r5, 0, .Lashlti3_v2_78\n"
  "  mov32 w5, w4\n"
  "  jeq r5, 0, .Lashlti3_v2_98\n"
  "  mov64 r5, r4\n"
  "  and32 w5, 63\n"
  "  lsh64 r3, r5\n"
  "  sub32 w4, 0\n"
  "  and32 w4, 63\n"
  "  mov64 r0, r2\n"
  "  rsh64 r0, r4\n"
  "  or64 r3, r0\n"
  "  lsh64 r2, r5\n"
  "  ja .Lashlti3_v2_98\n"
  ".Lashlti3_v2_78:\n"
  "  and32 w4, 63\n"
  "  mov64 r3, r2\n"
  "  lsh64 r3, r4\n"
  "  mov64 r2, 0\n"
  ".Lashlti3_v2_98:\n"
  "  stxdw [r1 + 0], r2\n"
  "  stxdw [r1 + 8], r3\n"
  "  exit\n"
  ".size __ashlti3, .-__ashlti3\n"
  ".section .text.__lshrti3,\"ax\",@progbits\n"
  ".hidden __lshrti3\n"
  ".globl __lshrti3\n"
  ".p2align 3\n"
  ".type __lshrti3,@function\n"
  "__lshrti3:\n"
  "  mov64 r5, r4\n"
  "  and32 w5, 64\n"
  "  jne r5, 0, .Llshrti3_v2_80\n"
  "  mov32 w5, w4\n"
  "  jeq r5, 0, .Llshrti3_v2_a0\n"
  "  mov64 r5, r4\n"
  "  and32 w5, 63\n"
  "  rsh64 r2, r5\n"
  "  sub32 w4, 0\n"
  "  and32 w4, 63\n"
  "  mov64 r0, r3\n"
  "  lsh64 r0, r4\n"
  "  or64 r0, r2\n"
  "  rsh64 r3, r5\n"
  "  mov64 r2, r0\n"
  "  ja .Llshrti3_v2_a0\n"
  ".Llshrti3_v2_80:\n"
  "  and32 w4, 63\n"
  "  rsh64 r3, r4\n"
  "  mov64 r2, r3\n"
  "  mov64 r3, 0\n"
  ".Llshrti3_v2_a0:\n"
  "  stxdw [r1 + 0], r2\n"
  "  stxdw [r1 + 8], r3\n"
  "  exit\n"
  ".size __lshrti3, .-__lshrti3\n"
  ".section .text.__ashrti3,\"ax\",@progbits\n"
  ".hidden __ashrti3\n"
  ".globl __ashrti3\n"
  ".p2align 3\n"
  ".type __ashrti3,@function\n"
  "__ashrti3:\n"
  "  mov64 r5, r4\n"
  "  and32 w5, 64\n"
  "  jne r5, 0, .Lashrti3_v2_78\n"
  "  mov32 w5, w4\n"
  "  jeq r5, 0, .Lashrti3_v2_a0\n"
  "  mov64 r5, r4\n"
  "  sub32 w5, 0\n"
  "  and32 w5, 63\n"
  "  mov64 r0, r3\n"
  "  lsh64 r0, r5\n"
  "  and32 w4, 63\n"
  "  rsh64 r2, r4\n"
  "  or64 r0, r2\n"
  "  mov64 r2, r0\n"
  "  ja .Lashrti3_v2_98\n"
  ".Lashrti3_v2_78:\n"
  "  and32 w4, 63\n"
  "  mov64 r2, r3\n"
  "  arsh64 r2, r4\n"
  "  mov64 r4, 63\n"
  ".Lashrti3_v2_98:\n"
  "  arsh64 r3, r4\n"
  ".Lashrti3_v2_a0:\n"
  "  stxdw [r1 + 0], r2\n"
  "  stxdw [r1 + 8], r3\n"
  "  exit\n"
  ".size __ashrti3, .-__ashrti3\n"
  ".text\n");
#endif
