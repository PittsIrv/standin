#!/usr/bin/env node
// Ports gitleaks' default rules (config/gitleaks.toml, MIT) to packages/airlock/src/gitleaks.gen.ts.
// Usage: node scripts/port-gitleaks.mjs <gitleaks.toml> <commit> [<gitleaks LICENSE>]
// Rules that only apply to file paths, and rules that don't compile in JavaScript, are dropped and reported.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The few TOML shapes gitleaks.toml uses: tables, arrays of tables, '''literals''', "strings", numbers, arrays. */
export function parseGitleaksToml(src) {
  const root = { rules: [] };
  let table = root;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[[rules]]") {
      table = { allowlists: [] };
      root.rules.push(table);
      continue;
    }
    if (line === "[[rules.allowlists]]") {
      table = {};
      root.rules.at(-1).allowlists.push(table);
      continue;
    }
    if (line === "[allowlist]") {
      table = {};
      root.allowlist = table;
      continue;
    }
    const eq = line.indexOf(" = ");
    if (eq < 0) throw new Error(`line ${i + 1}: can't read ${line}`);
    const key = line.slice(0, eq);
    let rest = line.slice(eq + 3);
    if (rest.startsWith("[") && !closesArray(rest)) {
      while (!closesArray(rest)) rest += `\n${lines[++i]}`;
    }
    table[key] = value(rest, i + 1);
  }
  return root;
}

function closesArray(text) {
  return values(text.slice(1)).closed;
}

/** Scans array items, skipping over quoted text so a "]" inside a literal doesn't end the array. */
function values(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (text.startsWith("'''", i)) {
      const end = text.indexOf("'''", i + 3);
      if (end < 0) return { out, closed: false };
      out.push(text.slice(i + 3, end));
      i = end + 3;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return { out, closed: false };
      out.push(JSON.parse(text.slice(i, j + 1)));
      i = j + 1;
    } else if (c === "]") {
      return { out, closed: true };
    } else i++;
  }
  return { out, closed: false };
}

function value(raw, lineNo) {
  if (raw.startsWith("'''")) return raw.slice(3, raw.lastIndexOf("'''"));
  if (raw.startsWith('"')) return JSON.parse(raw);
  if (raw.startsWith("[")) return values(raw.slice(1)).out;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  throw new Error(`line ${lineNo}: can't read value ${raw}`);
}

const POSIX = { alnum: "a-zA-Z0-9", alpha: "a-zA-Z", digit: "0-9", lower: "a-z", upper: "A-Z", space: "\\s", xdigit: "0-9a-fA-F", word: "\\w", punct: "!-\\/:-@\\[-`{-~" };

/**
 * A Go RE2 pattern as a JavaScript one. Go flag switches like `(?i)` apply to the rest of their group, so each
 * becomes a modifier group `(?i:` closed where that group ends. Named groups lose their `P`, POSIX classes are
 * spelled out, `\z` is `$`, and a `]` first in a class is escaped (JavaScript reads `[^]` as "anything").
 */
export function toJs(go) {
  let s = go.replace(/\(\?P</g, "(?<").replace(/\\z/g, "$").replace(/\\A/g, "^");
  s = s.replace(/\[:(\w+):\]/g, (m, name) => {
    if (!POSIX[name]) throw new Error(`unknown POSIX class ${m}`);
    return POSIX[name];
  });
  s = s.replace(/\[(\^?)\]/g, "[$1\\]");
  for (;;) {
    const at = findFlagSwitch(s);
    if (at < 0) break;
    const flags = s.slice(at + 2, s.indexOf(")", at));
    const end = groupEnd(s, at);
    s = `${s.slice(0, at)}(?${flags}:${s.slice(s.indexOf(")", at) + 1, end)})${s.slice(end)}`;
  }
  return s;
}

/** Index of a bare flag switch like `(?i)` or `(?s)`, outside character classes and escapes. */
function findFlagSwitch(s) {
  let inClass = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      if (s[i + 1] === "^") i++;
      if (s[i + 1] === "]") i++;
      continue;
    }
    if (c === "(" && /^\(\?[a-zA-Z-]+\)/.test(s.slice(i))) return i;
  }
  return -1;
}

/** Where the group enclosing position `from` closes (or the end of the pattern). */
function groupEnd(s, from) {
  let depth = 0;
  let inClass = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      if (s[i + 1] === "^") i++;
      if (s[i + 1] === "]") i++;
    } else if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return s.length;
}

function compiles(source) {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** One allowlist, kept only if it can apply to text with no file path. */
function allowlist(a) {
  const hasPaths = Array.isArray(a.paths) && a.paths.length > 0;
  const condition = a.condition === "AND" ? "AND" : "OR";
  if (hasPaths && condition === "AND") return null; // needs a path to match, and text has none
  const regexes = (a.regexes ?? []).map(toJs);
  const stopwords = a.stopwords ?? [];
  if (!regexes.length && !stopwords.length) return null;
  const bad = regexes.filter((r) => !compiles(r));
  if (bad.length) throw new Error(`allowlist regex doesn't compile: ${bad[0]}`);
  return { target: a.regexTarget ?? "secret", regexes, stopwords };
}

export function port(toml) {
  const parsed = parseGitleaksToml(toml);
  const rules = [];
  const dropped = [];
  for (const r of parsed.rules) {
    if (!r.regex || r.path) {
      dropped.push({ id: r.id, why: "file paths only" });
      continue;
    }
    const regex = toJs(r.regex);
    if (!compiles(regex)) {
      dropped.push({ id: r.id, why: "doesn't compile in JavaScript" });
      continue;
    }
    const out = { id: r.id, regex, keywords: (r.keywords ?? []).map((k) => k.toLowerCase()) };
    if (r.entropy) out.entropy = r.entropy;
    if (r.secretGroup) out.secretGroup = r.secretGroup;
    const lists = r.allowlists.map(allowlist).filter(Boolean);
    if (lists.length) out.allowlists = lists;
    rules.push(out);
  }
  const global = allowlist({ regexes: parsed.allowlist?.regexes, stopwords: parsed.allowlist?.stopwords });
  return { rules, global, dropped };
}

function main() {
  const [tomlPath, commit, licensePath] = process.argv.slice(2);
  if (!tomlPath || !commit) {
    console.error("usage: node scripts/port-gitleaks.mjs <gitleaks.toml> <commit> [<LICENSE>]");
    process.exit(2);
  }
  const { rules, global, dropped } = port(readFileSync(tomlPath, "utf8"));
  const license = licensePath ? readFileSync(licensePath, "utf8").trim() : "MIT License\n\nCopyright (c) 2019 Zachary Rice";
  const out = `// Generated by scripts/port-gitleaks.mjs from gitleaks ${commit} (config/gitleaks.toml). Do not edit by hand.
// https://github.com/gitleaks/gitleaks
//
${license
  .split("\n")
  .map((l) => `// ${l}`.trimEnd())
  .join("\n")}

import type { PortedRule, PortedAllowlist } from "./rules.ts";

export const GITLEAKS_COMMIT = ${JSON.stringify(commit)};

export const GLOBAL_ALLOWLIST: PortedAllowlist = ${JSON.stringify(global, null, 2)};

export const GITLEAKS_RULES: PortedRule[] = ${JSON.stringify(rules, null, 2)};
`;
  const target = fileURLToPath(new URL("../packages/airlock/src/gitleaks.gen.ts", import.meta.url));
  writeFileSync(target, out);
  console.log(`${rules.length} rules ported to ${target}`);
  for (const d of dropped) console.log(`dropped ${d.id}: ${d.why}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
