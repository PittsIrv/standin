import type { LLM } from "@standin/llm";
import type { Store } from "@standin/store";
import type { Tracer } from "@standin/trace";
import { syncStatedGaps } from "./gaps.ts";
import { computeLighting } from "./lighting.ts";
import { proposeLighting } from "./proposals.ts";
import { loadSnapshot } from "./snapshot.ts";
import { placeTopics, seedBackground } from "./tasks.ts";

export interface RefreshReport {
  placed: number;
  merged: number;
  /** Topics whose placement would have made a cycle. */
  refused: string[];
  /** Fields seeded from new background facts. */
  seeded: string[];
  gaps: number;
  proposed: number;
  replaced: number;
  warnings: string[];
}

/**
 * `standin map refresh`: seed from background, place new topics, record stated gaps, then propose lighting.
 * A failed model step is a warning; the steps after it still run on whatever the tree has.
 */
export async function refresh(o: { store: Store; map: LLM; tracer: Tracer; personaName: string }): Promise<RefreshReport> {
  return o.tracer.run("map-refresh", {}, async (run) => {
    const report: RefreshReport = { placed: 0, merged: 0, refused: [], seeded: [], gaps: 0, proposed: 0, replaced: 0, warnings: [] };
    const step = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        report.warnings.push(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await step("seeding from background", async () => {
      report.seeded = (await seedBackground(o.store, o.map, o.personaName)).seeded;
    });
    await step("placing topics", async () => {
      Object.assign(report, await placeTopics(o.store, o.map, o.personaName));
    });
    report.gaps = syncStatedGaps(o.store, loadSnapshot(o.store)).length;
    const snapshot = loadSnapshot(o.store);
    const proposals = proposeLighting(o.store, snapshot, computeLighting(snapshot));
    report.proposed = proposals.proposed.length;
    report.replaced = proposals.replaced.length;
    run.setAttributes({
      "standin.map.seeded": report.seeded.length,
      "standin.map.placed": report.placed,
      "standin.map.merged": report.merged,
      "standin.map.gaps": report.gaps,
      "standin.map.proposed": report.proposed,
    });
    return report;
  });
}
