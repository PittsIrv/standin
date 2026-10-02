import { LLMError, type GenerateObjectRequest, type LLM } from "./types.ts";

export type ScriptHandler = (req: GenerateObjectRequest<unknown>) => unknown | Promise<unknown>;

/** Deterministic LLM for tests and offline demos. Output is still validated against the request schema. */
export class ScriptedLLM implements LLM {
  readonly calls: GenerateObjectRequest<unknown>[] = [];

  constructor(private readonly handler: ScriptHandler) {}

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
    this.calls.push(req as GenerateObjectRequest<unknown>);
    let raw: unknown;
    try {
      raw = await this.handler(req as GenerateObjectRequest<unknown>);
    } catch (err) {
      throw new LLMError(`scripted handler failed: ${(err as Error).message}`, { cause: err });
    }
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) throw new LLMError(`scripted output does not match schema: ${parsed.error.message}`);
    return parsed.data;
  }
}
