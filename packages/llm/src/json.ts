import type { z } from "zod";
import { LLMError } from "./types.ts";

/**
 * Parses a model's text reply as JSON and validates it. Tolerates what local
 * models often add around the object: `<think>` blocks, code fences, and prose.
 */
export function parseJsonOutput<T>(text: string, schema: z.ZodType<T>): T {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    try {
      raw = start >= 0 && end > start ? JSON.parse(cleaned.slice(start, end + 1)) : undefined;
    } catch {
      raw = undefined;
    }
    if (raw === undefined) throw new LLMError("invalid", `model output is not JSON: ${cleaned.slice(0, 200)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new LLMError("invalid", `model output does not match the schema: ${issues}`);
  }
  return parsed.data;
}
