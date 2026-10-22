import { cutOut, describeAll, scan, type Described } from "@standin/airlock";
import type { Store } from "./store.ts";

/** A finding in stored data: which row holds it, and the masked context; never the matched text. */
export interface StoredFinding extends Described {
  where: string;
}

interface Field {
  col: string;
  /** JSON whose string values are scanned; `keyed` names the key in `where` (a fact's quote). */
  json?: "keyed" | "plain";
}

/** Every column that can hold text a person or a model wrote (personal-data guard spec §4). */
const TARGETS: { table: string; id: string; what: string; fields: Field[] }[] = [
  { table: "observations", id: "id", what: "observation", fields: [{ col: "text" }] },
  { table: "memories", id: "id", what: "fact", fields: [{ col: "statement" }, { col: "attrs", json: "keyed" }] },
  { table: "memory_events", id: "id", what: "fact edit", fields: [{ col: "note" }] },
  { table: "exemplars", id: "id", what: "exemplar", fields: [{ col: "text" }] },
  { table: "quiz_answers", id: "id", what: "quiz answer", fields: [{ col: "person_answer" }, { col: "question" }, { col: "standin_reply" }] },
  { table: "preference_pairs", id: "id", what: "preference pair", fields: [{ col: "person_answer" }, { col: "question" }, { col: "standin_answer" }] },
  { table: "probe_responses", id: "id", what: "spot check", fields: [{ col: "spot_check_answer" }, { col: "grade_reason" }] },
  { table: "entities", id: "id", what: "node", fields: [{ col: "name" }] },
  { table: "topics", id: "entity_id", what: "node", fields: [{ col: "definition" }] },
  { table: "span_content", id: "span_id", what: "trace", fields: [{ col: "content", json: "plain" }] },
];

/** Each string in a JSON value with its key (top-level key, or "" for nested and plain strings). */
function strings(value: unknown, key = ""): { key: string; text: string }[] {
  if (typeof value === "string") return [{ key, text: value }];
  if (Array.isArray(value)) return value.flatMap((v) => strings(v, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, key || k));
  return [];
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

type Row = { id: string } & Record<string, string | null>;
const rows = (s: Store, t: (typeof TARGETS)[number]) =>
  s.db.prepare(`SELECT ${t.id} AS id, ${t.fields.map((f) => f.col).join(", ")} FROM ${t.table}`).all() as Row[];

export function scanStored(s: Store): StoredFinding[] {
  const out: StoredFinding[] = [];
  for (const t of TARGETS)
    for (const r of rows(s, t))
      t.fields.forEach((f, i) => {
        const raw = r[f.col];
        if (!raw) return;
        const parts = f.json ? strings(parse(raw)) : [{ key: "", text: raw }];
        for (const p of parts) {
          const found = scan(p.text);
          if (!found.length) continue;
          const suffix = f.json === "keyed" ? ` (${p.key || f.col})` : !f.json && i > 0 ? ` (${f.col.replace(/_/g, " ")})` : "";
          for (const d of describeAll(p.text, found)) out.push({ where: `${t.what} ${r.id}${suffix}`, ...d });
        }
      });
  return out;
}

const cutAll = (text: string) => {
  const found = scan(text);
  return found.length ? cutOut(text, found) : text;
};

/**
 * Removes what `scanStored` finds. A compacted observation's raw text and a span's trace text are deleted, as
 * `purge` does; everywhere else each finding becomes "[removed]". Not reversible.
 */
export function purgeStored(s: Store): { observations: number; spanContent: number; rewritten: number } {
  return s.transaction(() => {
    let observations = 0;
    let spanContent = 0;
    let rewritten = 0;
    const now = s.nowIso();
    for (const t of TARGETS)
      for (const r of rows(s, t))
        for (const f of t.fields) {
          const raw = r[f.col];
          if (!raw) continue;
          const next = f.json ? JSON.stringify(mapStrings(parse(raw), cutAll)) : cutAll(raw);
          if (next === raw || (f.json && JSON.stringify(parse(raw)) === next)) continue;
          if (t.table === "span_content") {
            s.db.prepare("DELETE FROM span_content WHERE span_id = ?").run(r.id);
            spanContent++;
          } else if (t.table === "observations" && (s.db.prepare("SELECT compacted_at FROM observations WHERE id = ?").get(r.id) as { compacted_at: string | null }).compacted_at) {
            s.db.prepare("UPDATE observations SET text = NULL, purged_at = ? WHERE id = ?").run(now, r.id);
            observations++;
          } else {
            s.db.prepare(`UPDATE ${t.table} SET ${f.col} = ? WHERE ${t.id} = ?`).run(next, r.id);
            rewritten++;
          }
        }
    return { observations, spanContent, rewritten };
  });
}
