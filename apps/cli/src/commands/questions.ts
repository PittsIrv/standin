import type { Store } from "@standin/store";
import { table } from "../format.ts";
import { loadInstance } from "../home.ts";
import { flag, json, type Command } from "./shared.ts";

/** Where a question's node sits: root › … › node. */
function place(store: Store, nodeId: string): string {
  const names = [store.getTopic(nodeId).name];
  const seen = new Set<string>();
  for (let at = store.homeParent(nodeId); at && !seen.has(at); at = store.homeParent(at)) {
    seen.add(at);
    names.unshift(store.getTopic(at).name);
  }
  return names.join(" › ");
}

/** `standin questions [--sheet]`: open questions about the person's life (questions spec §2). */
export const questionsCommand: Command = {
  options: { ...json, sheet: { type: "boolean" } },
  async run(ctx) {
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const open = store.listQuestions({ status: "open" }).map((q) => ({ ...q, place: place(store, q.nodeId) }));
      if (flag(ctx, "json")) {
        ctx.io.stdout(JSON.stringify(open, null, 2));
        return 0;
      }
      if (flag(ctx, "sheet")) {
        // An answer sheet `standin interview import` reads back: answers go under each "### id".
        const out = [`# Questions for ${config.persona.name}`, "", "- Write your answer under each question; leave it blank to skip it.", "- Keep the \"### id\" headings as they are, then: standin interview import <this file>", ""];
        for (const q of open) out.push(`### ${q.id}`, `> **${q.text}**`, `> _${q.place}_`, "", "", "");
        ctx.io.stdout(out.join("\n").trimEnd());
        return 0;
      }
      if (open.length === 0) {
        ctx.io.stdout("No open questions. A refresh asks about gaps in your world: standin map refresh");
        return 0;
      }
      ctx.io.stdout(table(["id", "about", "question"], open.map((q) => [q.id, q.place, q.text])));
      ctx.io.stdout(`\n${open.length} open. Answer them on the review page (standin review), or offline: standin questions --sheet`);
      return 0;
    } finally {
      store.close();
    }
  },
};
