import { MemoryKind, MemoryStatus, type Memory } from "@standin/schema";
import { CliError } from "../errors.ts";
import { MEMORY_HEADERS, memoryRows, table } from "../format.ts";
import { loadInstance } from "../home.ts";
import { flag, json, str, type Command } from "./shared.ts";

function date(raw: string | undefined, flagName: string): Date | undefined {
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new CliError(`${flagName} must be an ISO-8601 date`);
  return d;
}

export const memoriesCommand: Command = {
  options: {
    status: { type: "string" },
    kind: { type: "string" },
    "as-of": { type: "string" },
    "recorded-at": { type: "string" },
    ...json,
  },
  async run(ctx) {
    const asOf = date(str(ctx, "as-of"), "--as-of");
    const recordedAt = date(str(ctx, "recorded-at"), "--recorded-at");
    if (recordedAt && !asOf) throw new CliError("--recorded-at requires --as-of");
    const status = str(ctx, "status");
    const kind = str(ctx, "kind");
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      let memories: Memory[];
      if (asOf) {
        memories = store.memoriesAsOf({ validAt: asOf, recordedAt });
      } else {
        memories = store.listMemories({
          status: status === undefined ? undefined : MemoryStatus.parse(status),
          kind: kind === undefined ? undefined : MemoryKind.parse(kind),
        });
      }
      if (flag(ctx, "json")) ctx.io.stdout(JSON.stringify(memories, null, 2));
      else if (memories.length === 0) ctx.io.stdout("No memories.");
      else ctx.io.stdout(table(MEMORY_HEADERS, memoryRows(memories)));
      return 0;
    } finally {
      store.close();
    }
  },
};
