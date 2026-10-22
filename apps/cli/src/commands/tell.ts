import { clean } from "@standin/airlock";
import { readFileSync } from "node:fs";
import { ObservationInput } from "@standin/schema";
import { systemClock } from "@standin/store";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { removedNote, str, type Command } from "./shared.ts";

/** Tell the standin something directly. It is an ordinary observation: compaction and review still apply. */
export const tellCommand: Command = {
  options: { file: { type: "string" }, occurred: { type: "string" } },
  async run(ctx) {
    const file = str(ctx, "file");
    const text =
      ctx.positionals.length > 0 ? ctx.positionals.join(" ") : file ? readFileSync(file, "utf8") : ((await ctx.io.readStdin?.()) ?? "");
    if (!text.trim()) throw new CliError('nothing to tell: pass the text, e.g. standin tell "I ran my first marathon in 2024."');
    const now = (ctx.io.clock ?? systemClock).now();
    const occurredArg = str(ctx, "occurred");
    const occurred = occurredArg === undefined ? now : new Date(occurredArg);
    if (Number.isNaN(occurred.getTime())) throw new CliError(`--occurred is not a date: ${occurredArg}`);

    const { text: cleaned, cut } = clean(text.trim(), "refuse"); // a secret is refused before anything is stored
    const parsed = ObservationInput.safeParse({
      sourceKind: "manual",
      sourceRef: `tell:${now.toISOString()}`,
      authorRole: "self",
      occurredAt: occurred.toISOString(),
      text: cleaned,
    });
    if (!parsed.success) throw new CliError(parsed.error.issues.map((i) => i.message).join("; "));
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const o = store.addObservation(parsed.data);
      ctx.io.stdout(`${o.id}  ${o.compactedAt ? "(already told)" : "pending compaction"}${removedNote(cut.contacts)}\nNext: standin compact`);
      return 0;
    } finally {
      store.close();
    }
  },
};
