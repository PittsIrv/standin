import {
  newId,
  Probe,
  ProbeResponse,
  ReviewSession,
  type AnswerModeName,
  type ProbeKind,
  type Rating,
} from "@standin/schema";
import { AlreadyRatedError, NotFoundError } from "./errors.ts";
import type { Row } from "./rows.ts";
import type { Store } from "./store.ts";

const rowToProbe = (r: Row): Probe =>
  Probe.parse({
    id: r.id,
    nodeId: r.node_id,
    checkOf: r.check_of ?? null,
    kind: r.kind,
    difficulty: r.difficulty,
    question: r.question,
    holdout: r.holdout,
    createdAt: r.created_at,
    releasedAt: r.released_at ?? null,
  });

const rowToResponse = (r: Row): ProbeResponse =>
  ProbeResponse.parse({
    id: r.id,
    probeId: r.probe_id,
    sessionId: r.session_id,
    shownAt: r.shown_at,
    predictedMode: r.predicted_mode,
    rating: r.rating ?? null,
    answeredAt: r.answered_at ?? null,
    spotCheck: r.spot_check,
    spotCheckAnswer: r.spot_check_answer ?? null,
    observationId: r.observation_id ?? null,
    grade: r.grade ?? null,
    gradeReason: r.grade_reason ?? null,
    gradeBatchId: r.grade_batch_id ?? null,
    judged: r.judged ?? null,
  });

const rowToSession = (r: Row): ReviewSession =>
  ReviewSession.parse({ id: r.id, startedAt: r.started_at, endedAt: r.ended_at ?? null, size: r.size });

export function startSession(s: Store, size: number): ReviewSession {
  const id = newId("ses");
  s.db.prepare("INSERT INTO review_sessions (id, started_at, size) VALUES (?, ?, ?)").run(id, s.nowIso(), size);
  return getSession(s, id);
}

export function getSession(s: Store, id: string): ReviewSession {
  const r = s.db.prepare("SELECT * FROM review_sessions WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new NotFoundError("review session", id);
  return rowToSession(r);
}

export function endSession(s: Store, id: string): ReviewSession {
  getSession(s, id);
  s.db.prepare("UPDATE review_sessions SET ended_at = ? WHERE id = ?").run(s.nowIso(), id);
  return getSession(s, id);
}

export function listSessions(s: Store): ReviewSession[] {
  return (s.db.prepare("SELECT * FROM review_sessions ORDER BY started_at, rowid").all() as Row[]).map(rowToSession);
}

export function insertProbe(s: Store, p: Omit<Probe, "id" | "createdAt" | "releasedAt">): Probe {
  const id = newId("prb");
  s.db
    .prepare("INSERT INTO probes (id, node_id, check_of, kind, difficulty, question, holdout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, p.nodeId, p.checkOf, p.kind, p.difficulty, p.question.trim(), p.holdout, s.nowIso());
  s.db.prepare("UPDATE topics SET frontier = 0 WHERE entity_id = ?").run(p.nodeId);
  return getProbe(s, id);
}

export function getProbe(s: Store, id: string): Probe {
  const r = s.db.prepare("SELECT * FROM probes WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new NotFoundError("probe", id);
  return rowToProbe(r);
}

export function listProbes(s: Store, f: { nodeId?: string; kind?: ProbeKind } = {}): Probe[] {
  const rows = s.db
    .prepare("SELECT * FROM probes WHERE (? IS NULL OR node_id = ?) AND (? IS NULL OR kind = ?) ORDER BY created_at, rowid")
    .all(f.nodeId ?? null, f.nodeId ?? null, f.kind ?? null, f.kind ?? null) as Row[];
  return rows.map(rowToProbe);
}

/** Shows a probe: creates its response with the standin's prediction recorded before any rating. A probe is shown once. */
export function showProbe(s: Store, probeId: string, sessionId: string, predictedMode: AnswerModeName): ProbeResponse {
  getProbe(s, probeId);
  if (s.db.prepare("SELECT 1 FROM probe_responses WHERE probe_id = ?").get(probeId)) throw new Error(`probe ${probeId} was already shown`);
  const id = newId("rsp");
  s.db
    .prepare("INSERT INTO probe_responses (id, probe_id, session_id, shown_at, predicted_mode, spot_check) VALUES (?, ?, ?, ?, ?, 'none')")
    .run(id, probeId, sessionId, s.nowIso(), predictedMode);
  return getResponse(s, id);
}

export function getResponse(s: Store, id: string): ProbeResponse {
  const r = s.db.prepare("SELECT * FROM probe_responses WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new NotFoundError("probe response", id);
  return rowToResponse(r);
}

export function rateResponse(s: Store, id: string, rating: Rating, spotCheck: boolean): ProbeResponse {
  if (getResponse(s, id).rating !== null) throw new AlreadyRatedError(id);
  s.db
    .prepare("UPDATE probe_responses SET rating = ?, answered_at = ?, spot_check = ? WHERE id = ? AND rating IS NULL")
    .run(rating, s.nowIso(), spotCheck ? "requested" : "none", id);
  return getResponse(s, id);
}

export function answerSpotCheck(s: Store, id: string, answer: string, observationId: string): ProbeResponse {
  getResponse(s, id);
  s.db
    .prepare("UPDATE probe_responses SET spot_check = 'answered', spot_check_answer = ?, observation_id = ? WHERE id = ?")
    .run(answer.trim(), observationId, id);
  return getResponse(s, id);
}

export function judgeResponse(s: Store, id: string, judged: "gap" | "not_gap"): ProbeResponse {
  getResponse(s, id);
  s.db.prepare("UPDATE probe_responses SET judged = ? WHERE id = ?").run(judged, id);
  return getResponse(s, id);
}

export function recordGrade(s: Store, id: string, grade: "pass" | "fail", reason: string): ProbeResponse {
  getResponse(s, id);
  s.db.prepare("UPDATE probe_responses SET grade = ?, grade_reason = ?, grade_batch_id = NULL WHERE id = ?").run(grade, reason, id);
  return getResponse(s, id);
}

export function setGradeBatch(s: Store, ids: string[], batchId: string | null): void {
  const stmt = s.db.prepare("UPDATE probe_responses SET grade_batch_id = ? WHERE id = ?");
  s.transaction(() => {
    for (const id of ids) stmt.run(batchId, id);
  });
}

/** Responses with their probes. `ungraded`: answered spot-checks without a grade. */
export function listResponses(
  s: Store,
  f: { sessionId?: string; rated?: boolean; ungraded?: boolean } = {},
): (ProbeResponse & { probe: Probe })[] {
  const rows = s.db
    .prepare(
      `SELECT r.* FROM probe_responses r
       WHERE (? IS NULL OR r.session_id = ?)
         AND (? = 0 OR r.rating IS NOT NULL)
         AND (? = 0 OR (r.spot_check = 'answered' AND r.grade IS NULL))
       ORDER BY r.shown_at, r.rowid`,
    )
    .all(f.sessionId ?? null, f.sessionId ?? null, f.rated ? 1 : 0, f.ungraded ? 1 : 0) as Row[];
  return rows.map((r) => {
    const response = rowToResponse(r);
    return { ...response, probe: getProbe(s, response.probeId) };
  });
}

/** Releases rotating probes that have a rated response in any of these sessions. */
export function releaseRotating(s: Store, sessionIds: string[]): Probe[] {
  if (sessionIds.length === 0) return [];
  const marks = sessionIds.map(() => "?").join(", ");
  const ids = (
    s.db
      .prepare(
        `SELECT DISTINCT p.id FROM probes p JOIN probe_responses r ON r.probe_id = p.id
         WHERE p.holdout = 'rotating' AND p.released_at IS NULL AND r.rating IS NOT NULL AND r.session_id IN (${marks})`,
      )
      .all(...sessionIds) as Row[]
  ).map((r) => String(r.id));
  const now = s.nowIso();
  for (const id of ids) s.db.prepare("UPDATE probes SET released_at = ? WHERE id = ?").run(now, id);
  return ids.map((id) => getProbe(s, id));
}
