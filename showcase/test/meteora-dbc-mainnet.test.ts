// showcase/mainnet/meteora-dbc (a port subject to Meteora's Non-commercial Licence, see that directory's LICENSE.md) and
// Meteora's Dynamic Bonding Curve 0.2.2 on mainnet, side by side, on real accounts: two pools that were still on their
// curves when read from mainnet (showcase/test/fixtures/meteora-dbc/mainnet, slot in ../slot.txt), one with an SPL
// base and one with a Token-2022 base, both quoted in wrapped SOL, with their configs, mints and vaults. Both programs
// get the same swaps, in every mode and both directions, to the end of the curve.
import * as t22 from "@solana-program/token-2022";
import { type Address, type Instruction, type KeyPairSigner, address, generateKeyPairSigner, lamports } from "@solana/kit";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN } from "../../test/harness.js";
import { present } from "../../test/binaries.js";
import { type Meta, type Pair, ORIGINAL, PROGRAM, TOKEN, custom, pair } from "./meteora-dbc-helpers.js";

const DIR = fileURLToPath(new URL("./fixtures/meteora-dbc/mainnet", import.meta.url));
const POOL_AUTHORITY = address("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
const WSOL = address("So11111111111111111111111111111111111111112");
/** The two pools: pool, config, base mint, base vault, quote vault. */
const POOLS = [
  [
    "DMUJHCaxzNywxZZrMpr1ktGYLVpTPV6rsviGWJ6fQfHi",
    "SETa8PQZvYVAWEaFtzt1Dd1Loh6iJx1K5WNTUeW4iJR",
    "B5uhh2hZs1fpLmFJkngu3ttWjUm3eXDJxBWEYPdZBAGS",
    "2M4TVs58NajuBjpu4tz4H28ZekpKd9T2q9ZxxR1de9dW",
    "8A9UYFtEW2eerS6MJjXVSgzdJHJ2nGCtyspZVGt6oNhC",
  ],
  [
    "BPiQBYsYPn4DGQHwE2StQbCRunWVkW5RcBsGoKp7hCS7",
    "6xy45AqAsthfcDiVqGEsBZfKLrtpdPfHG4FuephzjjrY",
    "4MtF2J66JdxvY7GnJaY2CoK3UC2j3bcWXUEEChv4bYcN",
    "3xyNroUKWdRczau8qQh3cTHvqEr8K29xzbfViMyHdAE5",
    "DeNBUTNtajWpnkNMn5iKkaHW2ru2UTXD8vZYBDgH9UMt",
  ],
].map((xs) => xs.map((x) => address(x)));

interface Cloned {
  address: string;
  lamports: string;
  owner: string;
  executable: boolean;
  data: string;
}

describe.skipIf(!present(ORIGINAL))("showcase/mainnet/meteora-dbc on mainnet pools against Meteora DBC 0.2.2", () => {
  let p: Pair;
  beforeAll(async () => {
    p = await pair();
    for (const f of readdirSync(DIR)) {
      const a = JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Cloned;
      const data = Buffer.from(a.data, "base64");
      for (const vm of p.vms())
        vm.setAccount({
          address: address(a.address),
          data: new Uint8Array(data),
          executable: a.executable,
          lamports: lamports(BigInt(a.lamports)),
          programAddress: address(a.owner),
          space: BigInt(data.length),
        });
    }
    // the clock past both pools' activation (their activation points are timestamps or slots of 2026-11)
    for (const vm of p.vms()) {
      const c = vm.getClock();
      c.slot = BigInt(readFileSync(path.join(DIR, "../slot.txt"), "utf8").trim()) + 100n;
      c.unixTimestamp = 1_794_600_000n;
      c.epoch = 900n;
      vm.setClock(c);
    }
  }, 300_000);

  /** A trader's token accounts (associated, created in both), their balances written in. */
  async function account(owner: Address, m: Address, program: Address, amount: bigint) {
    const payer = await p.funded();
    const [at] = await t22.findAssociatedTokenPda({ owner, mint: m, tokenProgram: program });
    await p.setup(payer, [t22.getCreateAssociatedTokenIdempotentInstruction({ payer, ata: at, owner, mint: m, tokenProgram: program }) as Instruction]);
    for (const vm of p.vms()) {
      const a = vm.getAccount(at);
      if (!a.exists) throw new Error("no account");
      const data = Buffer.from(a.data);
      data.writeBigUInt64LE(amount, 64);
      // a wrapped-SOL account holds its amount as lamports beyond its rent
      vm.setAccount({ ...a, data: new Uint8Array(data), lamports: m === WSOL ? lamports(a.lamports + amount) : a.lamports });
    }
    return at;
  }

  for (const [i, [pool, config, baseMint, baseVault, quoteVault]] of POOLS.entries())
    it(`pool ${pool}: the same swaps give the same bytes, to the end of its curve`, async () => {
      const baseProgram = p.original.getAccount(baseMint).exists
        ? address((p.original.getAccount(baseMint) as { programAddress: Address }).programAddress)
        : TOKEN;
      const who: KeyPairSigner = await p.funded();
      const quote = await account(who.address, WSOL, TOKEN, 10n ** 13n);
      const base = await account(who.address, baseMint, baseProgram, 0n);
      const swap = (label: string, quoteToBase: boolean, a0: bigint, a1: bigint, mode: number) => {
        const metas: Meta[] = [
          { address: POOL_AUTHORITY },
          { address: config },
          { address: pool, writable: true },
          { address: quoteToBase ? quote : base, writable: true },
          { address: quoteToBase ? base : quote, writable: true },
          { address: baseVault, writable: true },
          { address: quoteVault, writable: true },
          { address: baseMint },
          { address: WSOL },
          { address: who.address, signer: who },
          { address: baseProgram },
          { address: TOKEN },
          { address: PROGRAM },
          { address: p.eventAuthority },
          { address: PROGRAM },
        ];
        return p.both(
          `pool ${i}: ${label}`,
          who,
          [p.ix("swap2", { params: { amount_0: new BN(a0.toString()), amount_1: new BN(a1.toString()), swap_mode: mode } }, metas)],
          [pool, baseVault, quoteVault, quote, base],
        );
      };
      expect(await swap("quote in, exact", true, 100_000_000n, 0n, 0)).toBe("ok");
      expect(await swap("base out, exact", true, 1_000_000_000n, 10n ** 12n, 2)).toBe("ok");
      expect(await swap("base in, exact", false, 500_000_000n, 0n, 0)).toBe("ok");
      expect(await swap("quote out, exact", false, 10_000_000n, 10n ** 15n, 2)).toBe("ok");
      expect(await swap("slippage", true, 100_000_000n, 18_000_000_000_000_000_000n, 0)).toBe(custom(6002));
      expect(await swap("partial fill to the threshold", true, 10n ** 12n, 0n, 1)).toBe("ok");
      expect(await swap("after completion", true, 100_000_000n, 0n, 0)).toBe(custom(6013));
    });
});
