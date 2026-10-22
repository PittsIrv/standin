import { assertNoSecret } from "@standin/airlock";
import { align, sections } from "@standin/intake";
import type { LLM } from "@standin/llm";
import { FactKind, type Memory } from "@standin/schema";
import { normalizeName, type Store } from "@standin/store";
import { isSensitive } from "./hypotheses/sensitive.ts";
import { buildIntroPrompt } from "./prompts.ts";
import { IntroSchema } from "./schemas.ts";

/** Most statements one introduction keeps, across all its sources. */
export const MAX_INTRO_STATEMENTS = 40;
const SKIPPED = "intro.skipped";

/** A source waiting to be read: its text is already free of contact details, and nothing is stored yet. */
export interface IntroSource {
  id: string;
  kind: "intro" | "file" | "website" | "answer";
  /** "your introduction", a file name, or a URL. */
  ref: string;
  text: string;
}

/** A statement as the person confirms it (possibly edited), with the quote it rests on. */
export interface ConfirmedStatement {
  sourceId: string;
  statement: string;
  quote: string;
  kind: FactKind;
  kindLabel: string | null;
  start: string | null;
  end: string | null;
  current: boolean;
}

export interface ReadStatement extends ConfirmedStatement {
  id: string;
}

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * One `map` call per section of a source (intro-sources spec §4). A statement survives only if its quote is found in
 * the source (exact or near-exact), it isn't sensitive, and it isn't a repeat; the rest are counted, not shown.
 */
export async function readSource(map: LLM, source: IntroSource, personaName: string): Promise<{ statements: ReadStatement[]; notFound: number; sensitive: number }> {
  const statements: ReadStatement[] = [];
  const seen = new Set<string>();
  let notFound = 0;
  let sensitive = 0;
  for (const section of sections(source.text)) {
    const out = await map.generateObject({ ...buildIntroPrompt(section, source.ref, personaName), schema: IntroSchema, purpose: "intro" });
    for (const s of out.statements) {
      const statement = tidy(s.statement);
      const key = normalizeName(statement);
      if (!key || seen.has(key)) continue;
      if (!(align(s.quote, section.text) ?? align(s.quote, source.text)) || statement.includes("[removed]")) {
        notFound++;
        continue;
      }
      if (isSensitive(statement) || isSensitive(s.quote)) {
        sensitive++;
        continue;
      }
      seen.add(key);
      const known = FactKind.safeParse(s.kind);
      const kind = known.success ? known.data : "other";
      const label = known.success ? (kind === "other" ? s.kindLabel : null) : s.kind;
      statements.push({
        id: `${source.id}:${statements.length + 1}`,
        sourceId: source.id,
        statement,
        quote: tidy(s.quote),
        kind,
        kindLabel: label ? tidy(label) : null,
        start: s.start,
        end: s.end,
        current: s.current,
      });
    }
  }
  return { statements, notFound, sensitive };
}

/**
 * Stores a confirmed introduction (spec §6): each source a confirmed statement came from becomes one observation (its
 * text, contact details already removed); each statement an approved background fact with its kind, quote and dates.
 * Sensitive and empty statements are dropped, and ones already known are skipped. At most 40.
 */
export function saveIntro(store: Store, sources: IntroSource[], statements: ConfirmedStatement[], opts: { homeNodeId?: string } = {}): { saved: Memory[]; dropped: string[] } {
  const known = new Set(store.listMemories({ kind: "fact" }).filter((m) => m.status !== "rejected").map((m) => normalizeName(m.statement)));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const dropped: string[] = [];
  const kept: ConfirmedStatement[] = [];
  for (const raw of statements) {
    const statement = tidy(raw.statement);
    assertNoSecret(statement); // the person may have typed it into the statement
    const key = normalizeName(statement);
    // The quote must still be in its source: an edited statement keeps its evidence, an invented one has none.
    if (!key || known.has(key) || !byId.has(raw.sourceId) || !align(raw.quote, byId.get(raw.sourceId)!.text)) continue;
    if (isSensitive(statement)) {
      dropped.push(statement);
      continue;
    }
    known.add(key);
    kept.push({ ...raw, statement });
  }
  const capped = kept.slice(0, MAX_INTRO_STATEMENTS);
  if (capped.length === 0) return { saved: [], dropped };
  return store.transaction(() => {
    const observations = new Map<string, string>();
    const observationFor = (sourceId: string) => {
      const src = byId.get(sourceId)!;
      if (!observations.has(sourceId))
        observations.set(sourceId, store.addObservation({ sourceKind: src.kind, sourceRef: src.ref, authorRole: "self", text: src.text, occurredAt: store.nowIso() }).id);
      return observations.get(sourceId)!;
    };
    const saved = capped.map((c) => {
      const attrs = {
        background: true,
        kind: c.kind,
        ...(c.kind === "other" && c.kindLabel ? { kindLabel: c.kindLabel } : {}),
        ...(c.quote ? { quote: c.quote } : {}),
        ...(c.start ? { start: c.start } : {}),
        ...(c.end ? { end: c.end } : {}),
        ...(c.current ? { current: true } : {}),
      };
      const m = store.insertMemory({ kind: "fact", statement: c.statement, tier: 1, isCurrentState: c.current, attrs }, {
        sourceObservationIds: [observationFor(c.sourceId)],
        entityIds: opts.homeNodeId ? [opts.homeNodeId] : [],
        actor: "person",
        ...(opts.homeNodeId ? { homeNodeId: opts.homeNodeId } : {}),
      });
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
