import { EvidenceKind, RawScore } from "@standin/schema";
import type { Store } from "@standin/store";
import { cellKey, outcomeOf } from "./hypotheses/calibrate.ts";
import { computeLighting } from "./lighting.ts";
import { loadSnapshot } from "./snapshot.ts";

/** One settled guess, with nothing in it that names a person, a topic or a time (world-tree §7). */
export interface OutcomeRecord {
  evidenceKind: string;
  rawScore: string;
  /** Steps from the node the guess started from to the guessed node. */
  hops: number;
  /** The level known at the start of the path, or null when the guess started at the node itself. */
  startDepth: number | null;
  hypothesizedDepth: number;
  outcome: "confirmed" | "refuted";
}

/** The text-free record of every settled guess, for `standin outcomes export` (questions spec §3). */
export function outcomeRecords(store: Store): OutcomeRecord[] {
  const responses = store.listResponses({ rated: true });
  const lit = computeLighting(loadSnapshot(store));
  return store.listHypotheses({ status: "settled" }).flatMap((h) => {
    const outcome = outcomeOf(h, responses);
    if (!outcome) return [];
    const hops = h.path.length - 1;
    return [{ evidenceKind: h.kind, rawScore: h.rawScore, hops, startDepth: hops > 0 ? (lit.get(h.path[0]!)?.depth ?? null) : null, hypothesizedDepth: h.depth, outcome }];
  });
}

const PRIORS = "priors";

/**
 * Loads default reliabilities, `{ "<kind>:<rawScore>": { a, b } }` (questions spec §3). Each cell is scaled down so that
 * `a + b` is at most `cap`, so the person's own outcomes soon outweigh it. Throws, storing nothing, on a bad file.
 */
export function setPriors(store: Store, file: unknown, cap: number): Record<string, { a: number; b: number }> {
  if (typeof file !== "object" || file === null || Array.isArray(file)) throw new Error("a priors file is an object of cells");
  const known = new Set(EvidenceKind.options.flatMap((k) => RawScore.options.map((r) => cellKey(k, r))));
  const out: Record<string, { a: number; b: number }> = {};
  for (const [key, cell] of Object.entries(file)) {
    if (!known.has(key)) throw new Error(`unknown cell "${key}" (expected "<evidence kind>:<low|medium|high>")`);
    const { a, b } = (cell ?? {}) as { a?: unknown; b?: unknown };
    if (typeof a !== "number" || typeof b !== "number" || !(a > 0) || !(b > 0)) throw new Error(`cell "${key}" needs positive counts a and b`);
    const scale = Math.min(1, cap / (a + b));
    out[key] = { a: a * scale, b: b * scale };
  }
  store.setKv(PRIORS, JSON.stringify(out));
  return out;
}

export function clearPriors(store: Store): void {
  store.deleteKv(PRIORS);
}
