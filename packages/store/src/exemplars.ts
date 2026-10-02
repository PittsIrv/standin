import { Exemplar, newId, type ExemplarStatus, type Lang, type Register } from "@standin/schema";
import { InvalidTransitionError, NotFoundError } from "./errors.ts";
import type { Row } from "./rows.ts";
import type { Store } from "./store.ts";
import { contentHash, normalizeText } from "./text.ts";

function rowToExemplar(r: Row): Exemplar {
  return Exemplar.parse({
    id: r.id,
    observationId: r.observation_id,
    text: r.text,
    lang: r.lang,
    register: r.register,
    status: r.status,
    contentHash: r.content_hash,
    recordedAt: r.recorded_at,
    decidedAt: r.decided_at,
  });
}

export function getExemplar(s: Store, id: string): Exemplar {
  const r = s.db.prepare("SELECT * FROM exemplars WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new NotFoundError("exemplar", id);
  return rowToExemplar(r);
}

/** Returns null when an exemplar with the same normalized text already exists, in any status. */
export function insertExemplar(
  s: Store,
  input: { observationId: string; text: string; lang: Lang; register: Register },
): Exemplar | null {
  const text = input.text.trim();
  const hash = contentHash("exemplar", normalizeText(text));
  if (s.db.prepare("SELECT 1 FROM exemplars WHERE content_hash = ?").get(hash)) return null;
  s.getObservation(input.observationId);
  const id = newId("exm");
  s.db
    .prepare(
      `INSERT INTO exemplars (id, observation_id, text, lang, register, status, content_hash, recorded_at)
       VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    )
    .run(id, input.observationId, text, input.lang, input.register, hash, s.nowIso());
  return getExemplar(s, id);
}

function decide(s: Store, id: string, to: "approved" | "rejected"): Exemplar {
  const e = getExemplar(s, id);
  if (e.status !== "proposed") throw new InvalidTransitionError(e.id, e.status, to);
  s.db.prepare("UPDATE exemplars SET status = ?, decided_at = ? WHERE id = ?").run(to, s.nowIso(), id);
  return getExemplar(s, id);
}

export const approveExemplar = (s: Store, id: string) => decide(s, id, "approved");
export const rejectExemplar = (s: Store, id: string) => decide(s, id, "rejected");

export function listExemplars(s: Store, filter: { status?: ExemplarStatus } = {}): Exemplar[] {
  const rows = s.db
    .prepare("SELECT * FROM exemplars WHERE (? IS NULL OR status = ?) ORDER BY recorded_at, rowid")
    .all(filter.status ?? null, filter.status ?? null) as Row[];
  return rows.map(rowToExemplar);
}
