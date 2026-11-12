/*
 * Runs the compiler builtins on SBF for test/language/builtins.test.ts. Account 0 holds the cases (a u64 count, then
 * 40 bytes each: an op byte, 7 bytes of padding, operands a and b as 128-bit little-endian values); the program writes
 * 16 bytes per case to account 1, the 128-bit result. Around each operation it logs the compute units left
 * (sol_log_compute_units), so the test can tell what each one cost. Plain C operators on values read from account
 * data, so clang emits the libcalls (__multi3, __udivti3, …) and nothing is folded.
 */
#include <solana_sdk.h>

typedef unsigned __int128 u128;
typedef __int128 i128;

static u128 ld128(const uint8_t *p) {
  uint64_t lo, hi;
  sol_memcpy(&lo, p, 8);
  sol_memcpy(&hi, p + 8, 8);
  return ((u128)hi << 64) | lo;
}

static void st128(uint8_t *p, u128 v) {
  uint64_t lo = (uint64_t)v, hi = (uint64_t)(v >> 64);
  sol_memcpy(p, &lo, 8);
  sol_memcpy(p + 8, &hi, 8);
}

/* One operation; noinline so that each one is the same code around the libcall in every build. */
static __attribute__((noinline)) u128 run(uint8_t op, u128 a, u128 b) {
  switch (op) {
    case 0: return a * b;
    case 1: return a / b;
    case 2: return a % b;
    case 3: return (u128)((i128)a / (i128)b);
    case 4: return (u128)((i128)a % (i128)b);
    case 5: return a << (unsigned)(b & 127);
    case 6: return a >> (unsigned)(b & 127);
    case 7: return (u128)((i128)a >> (unsigned)(b & 127));
    case 8: return (u128)(uint64_t)((int64_t)(uint64_t)a / (int64_t)(uint64_t)b);
    case 9: return (u128)(uint64_t)((int64_t)(uint64_t)a % (int64_t)(uint64_t)b);
    default: return 0;
  }
}

extern uint64_t entrypoint(const uint8_t *input) {
  SolAccountInfo accounts[2];
  SolParameters params = (SolParameters){.ka = accounts};
  if (!sol_deserialize(input, &params, SOL_ARRAY_SIZE(accounts)) || params.ka_num != 2) return ERROR_NOT_ENOUGH_ACCOUNT_KEYS;
  const uint8_t *in = accounts[0].data;
  uint8_t *out = accounts[1].data;
  uint64_t n;
  sol_memcpy(&n, in, 8);
  if (accounts[0].data_len < 8 + n * 40 || accounts[1].data_len < n * 16) return ERROR_ACCOUNT_DATA_TOO_SMALL;
  for (uint64_t i = 0; i < n; i++) {
    const uint8_t *c = in + 8 + i * 40;
    u128 a = ld128(c + 8), b = ld128(c + 24);
    sol_log_compute_units();
    u128 r = run(c[0], a, b);
    sol_log_compute_units();
    st128(out + i * 16, r);
  }
  return SUCCESS;
}
