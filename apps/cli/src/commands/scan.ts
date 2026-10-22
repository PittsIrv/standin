import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { cutOut, describeAll, scan } from "@standin/airlock";
import type { StoredFinding } from "@standin/store";
import { loadInstance } from "../home.ts";
import { flag, json, type Command } from "./shared.ts";

const TEXT_FILES = new Set([".md", ".txt", ".json", ".jsonl"]);

/** Private text files in the instance folder: eval cases and runs, interview sheets, exports. */
function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return textFiles(path);
    return TEXT_FILES.has(extname(e.name)) ? [path] : [];
  });
}

const cutAll = (text: string) => {
  const found = scan(text);
  return found.length ? cutOut(text, found) : text;
};

function mapStrings(value: unknown): unknown {
  if (typeof value === "string") return cutAll(value);
  if (Array.isArray(value)) return value.map(mapStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v)]));
  return value;
}

/** A file with each finding cut; JSON stays valid because only its string values change. */
function purged(path: string, text: string): string {
  const ext = extname(path);
  try {
    if (ext === ".jsonl") return text.split("\n").map((l) => (l.trim() ? JSON.stringify(mapStrings(JSON.parse(l))) : l)).join("\n");
    if (ext === ".json") return `${JSON.stringify(mapStrings(JSON.parse(text)), null, 2)}\n`;
  } catch {
    // not valid JSON after all: cut it as plain text
  }
  return cutAll(text);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `standin scan [--purge]`: secrets and contact details stored before the guard existed (personal-data guard §4). */
export const scanCommand: Command = {
  options: { purge: { type: "boolean" }, ...json },
  async run(ctx) {
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const files = textFiles(ctx.home).map((path) => ({ path, text: readFileSync(path, "utf8") }));
      const findings: StoredFinding[] = [
        ...store.scanStored().map((f) => ({ ...f, where: f.line > 1 ? `${f.where} line ${f.line}` : f.where })),
        ...files.flatMap((f) => describeAll(f.text, scan(f.text)).map((d) => ({ ...d, where: `${relative(ctx.home, f.path)} line ${d.line}` }))),
      ];
      if (flag(ctx, "purge")) {
        const r = store.purgeStored();
        let rewrote = 0;
        for (const f of files) {
          const next = purged(f.path, f.text);
          if (next === f.text) continue;
          writeFileSync(f.path, next, { mode: 0o600 });
          rewrote++;
        }
        const done = [
          r.observations ? `${plural(r.observations, "observation")}' raw text deleted` : "",
          r.spanContent ? `${plural(r.spanContent, "trace text")} deleted` : "",
          r.rewritten ? `${plural(r.rewritten, "field")} rewritten in the database` : "",
          rewrote ? `${plural(rewrote, "file")} rewritten` : "",
        ].filter(Boolean);
        ctx.io.stdout(done.length ? `Removed: ${done.join(", ")}.` : "Nothing found.");
        return 0;
      }
      if (flag(ctx, "json")) {
        ctx.io.stdout(JSON.stringify({ findings }, null, 2));
        return 0;
      }
      if (!findings.length) {
        ctx.io.stdout("Nothing found.");
        return 0;
      }
      const secrets = findings.filter((f) => f.kind === "secret").length;
      const contacts = findings.length - secrets;
      ctx.io.stdout(
        [
          ...findings.map((f) => `${f.where}  ${f.label}  “${f.context}”`),
          "",
          `${plural(secrets, "secret")} and ${plural(contacts, "contact detail")} found. Run standin scan --purge to remove them; it can't be undone.`,
        ].join("\n"),
      );
      return 0;
    } finally {
      store.close();
    }
  },
};
