// The binaries a suite needs that a checkout may lack: the fetch-only programs in test/programs
// (scripts/fetch-programs.sh), the reference binaries built from source (test/programs/SOURCES.md's "no (build)" rows,
// e.g. scripts/percolator-v16-reference/build.sh) and the Anchor twins (pnpm build:twins). Every `skipIf` on a missing
// binary goes through present(), so that CI can make a missing one a failure instead of a quiet skip.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Group = "programs" | "built" | "twins";

/** Which binaries a run must have: CI_REQUIRE_ALL=programs, =built, =twins, a comma-separated mix, or =1 (all). */
export function required(group: Group): boolean {
  const want = (process.env.CI_REQUIRE_ALL ?? "").split(",").map((s) => s.trim());
  return want.includes("1") || want.includes(group);
}

let built: Set<string> | undefined;
/**
 * A binary's group: "twins" under test/anchor-twins, "built" for a file test/programs/SOURCES.md lists as built from
 * source ("no (build)": a reference that takes a Docker build of minutes, not a download), "programs" otherwise.
 */
export function group(file: string): Group {
  if (file.split(path.sep).includes("anchor-twins")) return "twins";
  built ??= new Set(
    [...readFileSync(fileURLToPath(new URL("./programs/SOURCES.md", import.meta.url)), "utf8").matchAll(/^\| `([\w.-]+\.so)` \|.*\| no \(build\) \|/gm)].map(
      (m) => m[1]!,
    ),
  );
  return built.has(path.basename(file)) ? "built" : "programs";
}

/**
 * Whether all `files` exist, for `describe.skipIf(!present(…))`. Locally a missing one skips the suite. Where
 * CI_REQUIRE_ALL names its group (see `group`), a missing one throws: the test file fails, naming what is missing,
 * rather than passing without the suite.
 */
export function present(...files: string[]): boolean {
  const missing = files.filter((f) => !existsSync(f));
  const forced = missing.filter((f) => required(group(f)));
  if (forced.length)
    throw new Error(
      `CI_REQUIRE_ALL=${process.env.CI_REQUIRE_ALL}: missing ${forced.join(", ")} (scripts/fetch-programs.sh, scripts/percolator-v16-reference/build.sh, pnpm build:twins)`,
    );
  return !missing.length;
}
