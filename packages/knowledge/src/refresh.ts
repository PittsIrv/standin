import type { LLM } from "@standin/llm";
import type { Store } from "@standin/store";
import type { Tracer } from "@standin/trace";
import { anchorConcepts } from "./anchors.ts";
import { askQuestions, QUESTION_LIMITS } from "./questions.ts";
import { syncStatedGaps } from "./gaps.ts";
import { computeLighting } from "./lighting.ts";
import { loadSnapshot } from "./snapshot.ts";
import { hypothesize } from "./hypotheses/hypothesize.ts";
import { homeMemories, splitNodes } from "./organize.ts";
import { placeNodes, seedBackground } from "./tasks.ts";

export interface RefreshReport {
  placed: number;
  merged: number;
  /** Topics whose placement would have made a cycle. */
  refused: string[];
  /** Top-level Knowledge concepts placed under their OpenAlex subfield. */
  anchored: string[];
  /** Fields seeded from new background facts. */
  seeded: string[];
  /** Approved memories given a home node. */
  homed: number;
  /** Nodes split into children. */
  split: string[];
  /** New questions about gaps in the person's world. */
  asked: number;
  gaps: number;
  /** Hypotheses added, withdrawn and rejected by the `hypothesize` step (with why). */
  hypotheses: { added: number; withdrawn: number; rejected: string[] };
  warnings: string[];
}

/**
 * `standin map refresh`: seed from background, place new nodes, anchor top-level concepts in the OpenAlex frame, home memories, split crowded nodes, record stated
 * gaps, then guess what the person probably knows.
 * A failed model step is a warning; the steps after it still run on whatever the tree has.
 */
export async function refresh(o: {
  store: Store;
  map: LLM;
  tracer: Tracer;
  personaName: string;
  splitAt?: number;
  /** The `hypothesize` role's model; without it, no new guesses are made this refresh. */
  hypothesize?: LLM;
  hypotheses?: { dropBelow: number; dropAfter: number };
  questions?: { perRefresh: number; open: number };
}): Promise<RefreshReport> {
  return o.tracer.run("map-refresh", {}, async (run) => {
    const report: RefreshReport = { placed: 0, merged: 0, refused: [], anchored: [], seeded: [], homed: 0, split: [], asked: 0, gaps: 0, hypotheses: { added: 0, withdrawn: 0, rejected: [] }, warnings: [] };
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
    await step("placing nodes", async () => {
      Object.assign(report, await placeNodes(o.store, o.map, o.personaName));
    });
    await step("anchoring concepts", async () => {
      report.anchored = (await anchorConcepts(o.store, o.map, o.personaName)).anchored;
    });
    let grew = new Set<string>();
    await step("homing memories", async () => {
      const homed = await homeMemories(o.store, o.map, o.personaName);
      report.homed = homed.homed;
      grew = new Set(homed.grew);
    });
    await step("splitting nodes", async () => {
      report.split = (await splitNodes(o.store, o.map, o.personaName, o.splitAt ?? 12, grew)).split;
    });
    await step("asking about gaps", async () => {
      report.asked = (await askQuestions(o.store, o.map, o.personaName, o.questions ?? QUESTION_LIMITS)).asked;
    });
    const before = loadSnapshot(o.store);
    report.gaps = syncStatedGaps(o.store, before, computeLighting(before)).length;
    const model = o.hypothesize;
    if (model)
      await step("hypothesizing", async () => {
        report.hypotheses = await hypothesize(o.store, model, o.personaName, o.hypotheses ?? { dropBelow: 0.3, dropAfter: 10 });
      });
    run.setAttributes({
      "standin.map.seeded": report.seeded.length,
      "standin.map.placed": report.placed,
      "standin.map.merged": report.merged,
      "standin.map.homed": report.homed,
      "standin.map.split": report.split.length,
      "standin.map.gaps": report.gaps,
      "standin.map.hypotheses.added": report.hypotheses.added,
    });
    return report;
  });
}
