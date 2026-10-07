import type { Config } from "@standin/schema";
import { expire, listMemories, recomputeConfidence } from "./memories.ts";
import { purgeSpanContent } from "./spans.ts";
import type { Store } from "./store.ts";

export interface ConsolidationReport {
  expired: string[];
  recomputed: number;
  purged: number;
  /** Spans whose stored text (prompts, outputs) was deleted; their structure is kept. */
  purgedSpanContent: number;
}

const DAY_MS = 86_400_000;

/**
 * The periodic "sleep" pass: expire memories that are no longer true or no longer fresh,
 * re-score confidence, and drop raw text that compaction has already consumed.
 */
export function consolidate(s: Store, config: Config): ConsolidationReport {
  const { retentionDays, freshnessDays, currentStateHalfLifeDays } = config.consolidation;
  return s.transaction(() => {
    const now = s.clock.now();
    const nowIso = now.toISOString();
    const staleBefore = new Date(now.getTime() - freshnessDays * DAY_MS).toISOString();

    const expired: string[] = [];
    for (const m of listMemories(s, { status: "approved" })) {
      if (m.validUntil !== null && m.validUntil < nowIso) {
        expire(s, m.id, "validity ended");
        expired.push(m.id);
      } else if (m.isCurrentState && m.lastCorroboratedAt < staleBefore) {
        expire(s, m.id, `not corroborated in ${freshnessDays} days`);
        expired.push(m.id);
      }
    }

    let recomputed = 0;
    for (const m of [...listMemories(s, { status: "proposed" }), ...listMemories(s, { status: "approved" })]) {
      recomputeConfidence(s, m.id, currentStateHalfLifeDays);
      recomputed++;
    }

    const purgeBefore = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
    const purged = s.db
      .prepare(
        `UPDATE observations SET text = NULL, purged_at = ?
         WHERE compacted_at IS NOT NULL AND text IS NOT NULL AND ingested_at < ?`,
      )
      .run(nowIso, purgeBefore).changes;

    const purgedSpanContent = purgeSpanContent(s, purgeBefore);

    return { expired, recomputed, purged: Number(purged), purgedSpanContent };
  });
}
