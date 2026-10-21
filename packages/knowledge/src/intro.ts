import type { LLM } from "@standin/llm";
import type { Memory } from "@standin/schema";
import { normalizeName, type Store } from "@standin/store";
import { isSensitive } from "./hypotheses/sensitive.ts";
import { buildIntroPrompt } from "./prompts.ts";
import { IntroSchema } from "./schemas.ts";

/** Most statements one introduction is read into. */
export const MAX_INTRO_STATEMENTS = 12;
const SKIPPED = "intro.skipped";

/** Trimmed, non-empty, distinct and never sensitive (concept-cards spec §6a); returns the kept and the dropped. */
function clean(statements: string[]): { kept: string[]; dropped: string[] } {
  const seen = new Set<string>();
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of statements) {
    const s = raw.trim().replace(/\s+/g, " ");
    const key = normalizeName(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (isSensitive(s)) dropped.push(s);
    else kept.push(s);
  }
  return { kept: kept.slice(0, MAX_INTRO_STATEMENTS), dropped };
}

/** One `map` call: the introduction read into short background statements, for the person to confirm. Stores nothing. */
export async function readIntro(map: LLM, text: string, personaName: string): Promise<string[]> {
  const out = await map.generateObject({ ...buildIntroPrompt(text, personaName), schema: IntroSchema, purpose: "intro" });
  return clean(out.statements).kept;
}

/**
 * Stores a confirmed introduction: the text as one observation, each statement an approved background fact (the
 * person wrote and confirmed it). Sensitive statements are dropped, not stored, and returned so the page can say so.
 */
export function saveIntro(store: Store, text: string, statements: string[]): { saved: Memory[]; dropped: string[] } {
  const { kept, dropped } = clean(statements);
  if (kept.length === 0) return { saved: [], dropped };
  return store.transaction(() => {
    const obs = store.addObservation({ sourceKind: "intro", sourceRef: "review-page", authorRole: "self", text, occurredAt: store.nowIso() });
    const saved = kept.map((statement) => {
      const m = store.insertMemory({ kind: "fact", statement, tier: 1, isCurrentState: false, attrs: { background: true } }, { sourceObservationIds: [obs.id], entityIds: [], actor: "person" });
      return store.approve(m.id);
    });
    return { saved, dropped };
  });
}

/** The session opens with the introduction while nothing tells the standin about the person's background and they haven't skipped it. */
export function needsIntro(store: Store): boolean {
  if (store.getKv(SKIPPED) !== null) return false;
  if (store.listMemories({ status: "approved", kind: "fact" }).some((m) => m.kind === "fact" && m.attrs.background === true)) return false;
  return !store.listTopics({ includeDeleted: true }).some((t) => t.seedMemoryId !== null);
}

export function skipIntro(store: Store): void {
  store.setKv(SKIPPED, store.nowIso());
}
