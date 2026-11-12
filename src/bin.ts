#!/usr/bin/env node
// The `typesol` command: the Node.js version first, then the CLI (src/cli.ts), loaded only once the check passed.
import { nodeVersionProblem } from "./node-version.js";

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  console.error(problem);
  process.exit(1);
}
await import("./cli.js");
