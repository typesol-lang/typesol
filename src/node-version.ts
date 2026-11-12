// The Node.js check the CLI runs before it loads anything else: on an older Node the compiler or its dependencies
// fail later with errors that do not say why (npm crashing during an install, `Map.groupBy is not a function`).
// No imports here, so nothing can fail before the check.

/** The oldest Node.js the CLI runs on (package.json "engines"). */
export const MIN_NODE = [22, 12] as const;

/** The one line to print when `version` (process.versions.node) is too old, or undefined when it is new enough. */
export function nodeVersionProblem(version: string): string | undefined {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return undefined;
  return `error: TypeSOL needs Node.js ${MIN_NODE.join(".")} or later, and this is Node.js ${version}. Install a newer one from https://nodejs.org (or \`nvm install 22\` with nvm), then run the command again.`;
}
