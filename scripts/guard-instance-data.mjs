#!/usr/bin/env node
// Refuses commits that contain private instance data (SQLite stores, ~/.standin
// contents, raw observation dumps). Runs in the pre-commit hook and in CI.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const RULES = [
  { test: (p) => /\.(db|sqlite)(-[a-z]+)?$/i.test(p), reason: "SQLite database file" },
  { test: (p) => /(^|\/)\.standin\//.test(p), reason: "path inside a .standin instance directory" },
  {
    test: (p) => /(^|\/)observations[^/]*\.jsonl$/i.test(p) && !p.startsWith("examples/"),
    reason: "raw observation dump outside examples/",
  },
];

/** Returns the subset of paths that look like private instance data. */
export function findViolations(paths) {
  return paths.filter((p) => RULES.some((r) => r.test(p)));
}

function reasonFor(path) {
  return RULES.find((r) => r.test(path))?.reason ?? "instance data";
}

function gitPaths() {
  const run = (args) =>
    execFileSync("git", args, { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  return [...new Set([...run(["ls-files"]), ...run(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])])];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findViolations(gitPaths());
  if (violations.length > 0) {
    console.error("standin guard: refusing to commit private instance data:");
    for (const v of violations) console.error(`  ${v}  (${reasonFor(v)})`);
    process.exit(1);
  }
  console.log("standin guard: no instance data tracked.");
}
