import { readFileSync } from "node:fs";
import { ObservationInput } from "@standin/schema";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { str, type Command } from "./shared.ts";

export const observeCommand: Command = {
  options: {
    source: { type: "string" },
    role: { type: "string" },
    lang: { type: "string" },
    ref: { type: "string" },
    occurred: { type: "string" },
    file: { type: "string" },
  },
  async run(ctx) {
    const file = str(ctx, "file");
    let text: string;
    if (file) text = readFileSync(file, "utf8");
    else if (ctx.io.readStdin) text = await ctx.io.readStdin();
    else throw new CliError("provide --file or pipe text on stdin");

    const parsed = ObservationInput.safeParse({
      sourceKind: str(ctx, "source"),
      authorRole: str(ctx, "role"),
      lang: str(ctx, "lang"),
      sourceRef: str(ctx, "ref") ?? (file ? `file:${file}` : "stdin"),
      occurredAt: str(ctx, "occurred") ?? new Date().toISOString(),
      text,
    });
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      throw new CliError(`invalid observation: ${issues}`);
    }
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const o = store.addObservation(parsed.data);
      ctx.io.stdout(`${o.id}  ${o.sourceKind}/${o.authorRole}/${o.lang}  ${o.compactedAt ? "(already compacted)" : "pending compaction"}`);
    } finally {
      store.close();
    }
    return 0;
  },
};
