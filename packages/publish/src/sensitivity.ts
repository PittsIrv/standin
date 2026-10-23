import type { LLM } from "@standin/llm";
import { PRIVATE_CATEGORIES } from "@standin/speak";
import { z } from "zod";
import type { Item } from "./items.ts";

export const SensitivitySchema = z.object({ flags: z.array(z.object({ item: z.number().int(), reason: z.string() })) });

const describe = (i: Item) => (i.kind === "node" ? `(topic) ${i.fields.map((f) => f.text).join(" — ")}` : `(${i.kind}) ${i.fields[0]!.text}`);

export function buildSensitivityPrompt(personaName: string, items: Item[]): { system: string; prompt: string } {
  return {
    system: [
      `You check items about ${personaName} before they go on a public website, where anyone can read them.`,
      `Flag an item if it tells a reader something about ${personaName} in one of these categories: ${PRIVATE_CATEGORIES.join("; ")}.`,
      "Also flag details about another person that they might not want public.",
      "Don't flag ordinary facts about study, work, projects, skills, or views on technical subjects.",
      "For each flagged item give its number and one short line saying which category it touches and why.",
    ].join("\n"),
    prompt: items.map((i, n) => `[${n + 1}] ${describe(i)}`).join("\n"),
  };
}

/**
 * The model's sensitivity check (publish spec §4, decision 106), in batches of `batch`: for each item, whether it
 * touches a private category, with a reason. A failed call throws: nothing goes public unchecked.
 */
export async function flagSensitive(screen: LLM, personaName: string, items: Item[], batch: number): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < items.length; i += batch) {
    const chunk = items.slice(i, i + batch);
    const r = await screen.generateObject({ ...buildSensitivityPrompt(personaName, chunk), schema: SensitivitySchema, purpose: "sensitivity" });
    for (const it of chunk) out.set(it.key, null);
    for (const f of r.flags) if (f.item >= 1 && f.item <= chunk.length) out.set(chunk[f.item - 1]!.key, f.reason.trim() || "flagged");
  }
  return out;
}
