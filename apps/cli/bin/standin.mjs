#!/usr/bin/env node
import { register } from "tsx/esm/api";

// node:sqlite is stable enough for us; keep its experimental notice out of the CLI's output.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes("SQLite is an experimental feature")) return;
  return emitWarning.call(process, warning, ...rest);
};

register();
const { runCli } = await import("../src/main.ts");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(`${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
  env: process.env,
  readStdin,
});
