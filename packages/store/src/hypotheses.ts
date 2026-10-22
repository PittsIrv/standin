import { Hypothesis, newId, type HypothesisStatus } from "@standin/schema";
import { NotFoundError } from "./errors.ts";
import type { Row } from "./rows.ts";
import type { Store } from "./store.ts";

const rowToHypothesis = (r: Row): Hypothesis =>
  Hypothesis.parse({
    id: r.id,
    nodeId: r.node_id,
    depth: r.depth,
    rawScore: r.raw_score,
    kind: r.kind,
    path: JSON.parse(String(r.path)),
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
    settledAt: r.settled_at ?? null,
  });

export type NewHypothesis = Omit<Hypothesis, "id" | "status" | "createdAt" | "settledAt">;

export function insertHypothesis(s: Store, h: NewHypothesis): Hypothesis {
  const id = newId("hyp");
  s.db
    .prepare("INSERT INTO hypotheses (id, node_id, depth, raw_score, kind, path, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)")
    .run(id, h.nodeId, h.depth, h.rawScore, h.kind, JSON.stringify(h.path), h.reason, s.nowIso());
  return getHypothesis(s, id);
}

export function getHypothesis(s: Store, id: string): Hypothesis {
  const r = s.db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new NotFoundError("hypothesis", id);
  return rowToHypothesis(r);
}

export function listHypotheses(s: Store, f: { status?: HypothesisStatus; nodeId?: string } = {}): Hypothesis[] {
  const rows = s.db
    .prepare("SELECT * FROM hypotheses WHERE (? IS NULL OR status = ?) AND (? IS NULL OR node_id = ?) ORDER BY created_at, rowid")
    .all(f.status ?? null, f.status ?? null, f.nodeId ?? null, f.nodeId ?? null) as Row[];
  return rows.map(rowToHypothesis);
}

export function setHypothesisStatus(s: Store, id: string, status: Exclude<HypothesisStatus, "open">): Hypothesis {
  getHypothesis(s, id);
  s.db.prepare("UPDATE hypotheses SET status = ?, settled_at = ? WHERE id = ?").run(status, s.nowIso(), id);
  return getHypothesis(s, id);
}
