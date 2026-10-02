import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { parseConfig, type ObservationInput } from "@standin/schema";
import { openStore } from "@standin/store";

export const config = parseConfig({ persona: { name: "Lin Qiao", languages: ["en", "zh"] } });

export class FakeClock {
  constructor(public current = new Date("2026-10-01T12:00:00.000Z")) {}
  now() {
    return new Date(this.current);
  }
}

export function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "standin-compaction-"));
  const clock = new FakeClock();
  return { store: openStore({ path: join(dir, "standin.db"), clock }), clock };
}

export function obs(text: string, overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    sourceKind: "interview",
    sourceRef: "interview-01",
    authorRole: "self",
    lang: "en",
    text,
    occurredAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

export type Candidate = {
  kind?: "fact" | "competence" | "stance" | "negative";
  statement: string;
  lang?: "en" | "zh" | "mixed" | "other";
  entities?: { name: string; kind: "project" | "org" | "place" | "person" | "work" | "topic" }[];
  suggestedTier?: 1 | 2 | 3;
  validFrom?: string | null;
  validUntil?: string | null;
  isCurrentState?: boolean;
  competence?: { domain: string; depth: number } | null;
  stance?: { topic: string; strength: number } | null;
};

export function extraction(memories: Candidate[], exemplars: { text: string; register: "casual" | "formal" }[] = []) {
  return {
    memories: memories.map((m) => ({
      kind: "fact",
      lang: "en",
      entities: [],
      suggestedTier: 1,
      validFrom: null,
      validUntil: null,
      isCurrentState: false,
      competence: null,
      stance: null,
      ...m,
    })),
    exemplars,
  };
}

export const observationText = (prompt: string) => /<observation>\n([\s\S]*?)\n<\/observation>/.exec(prompt)?.[1] ?? "";
export const candidateStatement = (prompt: string) => /^candidate: (.*)$/m.exec(prompt)?.[1] ?? "";
export const neighborIds = (prompt: string) => [...prompt.matchAll(/\[(mem_[0-9a-f]{12})\]/g)].map((m) => m[1]!);

type Decision = { action: "new" | "duplicate" | "update" | "contradiction"; targetId: string | null; reason: string };

/** Routes extraction by observation text and reconciliation by a callback. */
export function script(
  extractions: Record<string, ReturnType<typeof extraction> | (() => never)>,
  reconcile: (candidate: string, neighbors: string[]) => Decision = () => ({ action: "new", targetId: null, reason: "" }),
) {
  return new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
    if (req.purpose === "extract") {
      const e = extractions[observationText(req.prompt)];
      if (e === undefined) return extraction([]);
      return typeof e === "function" ? e() : e;
    }
    return reconcile(candidateStatement(req.prompt), neighborIds(req.prompt));
  });
}
