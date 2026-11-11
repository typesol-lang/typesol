// The binaries a suite needs that a checkout may lack: the fetch-only programs in test/programs
// (scripts/fetch-programs.sh) and the Anchor twins (pnpm build:twins). Every `skipIf` on a missing binary goes through
// present(), so that CI can make a missing one a failure instead of a quiet skip.
import { existsSync } from "node:fs";
import path from "node:path";

/** Which binaries a run must have: CI_REQUIRE_ALL=programs, =twins, =programs,twins or =1 (all). */
function required(group: "programs" | "twins"): boolean {
  const want = (process.env.CI_REQUIRE_ALL ?? "").split(",").map((s) => s.trim());
  return want.includes("1") || want.includes(group);
}

/**
 * Whether all `files` exist, for `describe.skipIf(!present(…))`. Locally a missing one skips the suite. Where
 * CI_REQUIRE_ALL names its group (test/anchor-twins builds are "twins", everything else "programs"), a missing one
 * throws: the test file fails, naming what is missing, rather than passing without the suite.
 */
export function present(...files: string[]): boolean {
  const missing = files.filter((f) => !existsSync(f));
  const forced = missing.filter((f) => required(f.split(path.sep).includes("anchor-twins") ? "twins" : "programs"));
  if (forced.length)
    throw new Error(`CI_REQUIRE_ALL=${process.env.CI_REQUIRE_ALL}: missing ${forced.join(", ")} (scripts/fetch-programs.sh, pnpm build:twins)`);
  return !missing.length;
}
