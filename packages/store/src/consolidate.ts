import type { Config } from "@standin/schema";
import { expire, listMemories } from "./memories.ts";
import { purgeSpanContent } from "./spans.ts";
import type { Store } from "./store.ts";

export interface ConsolidationReport {
  expired: string[];
  purged: number;
  purgedSpanContent: number;
}

const DAY_MS = 86_400_000;

/**
 * The periodic pass: expire memories whose stated validity has ended. Nothing expires silently
 * otherwise; stale "currently…" memories get a "Still true?" card instead. Raw and trace text are
 * purged only when `consolidation.purgeAfterDays` is set.
 */
export function consolidate(s: Store, config: Config): ConsolidationReport {
  const { purgeAfterDays } = config.consolidation;
  return s.transaction(() => {
    const now = s.clock.now();
    const nowIso = now.toISOString();
    const expired: string[] = [];
    for (const m of listMemories(s, { status: "approved" })) {
      if (m.validUntil !== null && m.validUntil < nowIso) {
        expire(s, m.id, "validity ended");
        expired.push(m.id);
      }
    }
    const purged =
      purgeAfterDays === undefined
        ? { observations: 0, spanContent: 0 }
        : purgeText(s, new Date(now.getTime() - purgeAfterDays * DAY_MS).toISOString(), "ingested_at");
    return { expired, purged: purged.observations, purgedSpanContent: purged.spanContent };
  });
}

/** Deletes raw text of observations compacted before `before`, then the trace text recorded before it or tied to them. */
export function purge(s: Store, before: string): { observations: number; spanContent: number } {
  return purgeText(s, before, "compacted_at");
}

/** The retention window (`purgeAfterDays`) counts from ingestion, as before; `standin purge --before` counts from compaction. */
function purgeText(s: Store, before: string, by: "ingested_at" | "compacted_at"): { observations: number; spanContent: number } {
  return s.transaction(() => {
    const observations = Number(
      s.db
        .prepare(
          `UPDATE observations SET text = NULL, purged_at = ?
           WHERE compacted_at IS NOT NULL AND ${by} < ? AND text IS NOT NULL`,
        )
        .run(s.nowIso(), before).changes,
    );
    return { observations, spanContent: purgeSpanContent(s, before) };
  });
}
