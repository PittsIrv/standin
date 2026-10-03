import type { z } from "zod";
import {
  LLMError,
  type BatchLLM,
  type BatchOutcome,
  type BatchRequest,
  type BatchStatus,
  type GenerateObjectRequest,
} from "./types.ts";

export type ScriptHandler = (req: GenerateObjectRequest<unknown>) => unknown | Promise<unknown>;

/**
 * Scripted batches are kept per process, not per instance, so a batch submitted
 * by one ScriptedLLM can be collected by another (as with a real provider)
 * within the same process. They do not survive a restart.
 */
const BATCHES = new Map<string, { requests: BatchRequest<unknown>[]; pollsLeft: number }>();
let batchCounter = 0;

function scriptedBatch(batchId: string) {
  const b = BATCHES.get(batchId);
  if (!b) throw new LLMError(`unknown batch ${batchId} (scripted batches only live within one process; abandon it and use --wait)`);
  return b;
}

/** Deterministic LLM for tests and offline demos. Output is still validated against the request schema. */
export class ScriptedLLM implements BatchLLM {
  readonly calls: GenerateObjectRequest<unknown>[] = [];

  /** `batchPolls`: how many status checks report a batch as still processing before it ends. */
  constructor(
    private readonly handler: ScriptHandler,
    private readonly opts: { batchPolls?: number } = {},
  ) {}

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

  async submitBatch(requests: BatchRequest<unknown>[]): Promise<string> {
    const id = `scripted_batch_${++batchCounter}`;
    BATCHES.set(id, { requests, pollsLeft: this.opts.batchPolls ?? 0 });
    return id;
  }

  async batchStatus(batchId: string): Promise<BatchStatus> {
    const b = scriptedBatch(batchId);
    const ended = b.pollsLeft <= 0;
    if (!ended) b.pollsLeft--;
    return { ended, processing: ended ? 0 : b.requests.length, succeeded: ended ? b.requests.length : 0, errored: 0 };
  }

  async batchResults<T>(batchId: string, schema: z.ZodType<T>): Promise<Map<string, BatchOutcome<T>>> {
    const b = scriptedBatch(batchId);
    const out = new Map<string, BatchOutcome<T>>();
    for (const { id, req } of b.requests) {
      try {
        // Answered by this instance's handler, whichever instance submitted the batch.
        out.set(id, { ok: true, value: await this.generateObject({ ...req, schema }) });
      } catch (err) {
        out.set(id, { ok: false, error: (err as Error).message });
      }
    }
    return out;
  }
}
