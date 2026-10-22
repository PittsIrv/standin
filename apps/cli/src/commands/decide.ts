import { Tier } from "@standin/schema";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { queuePlace } from "@standin/compaction";
import { str, type Command, type CommandContext } from "./shared.ts";

function targetId(ctx: CommandContext): string {
  const id = ctx.positionals[0];
  if (!id) throw new CliError("missing <id>");
  return id;
}

export const approveCommand: Command = {
  options: { tier: { type: "string" }, statement: { type: "string" } },
  async run(ctx) {
    const id = targetId(ctx);
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      if (id.startsWith("exm_")) {
        const e = store.approveExemplar(id);
        store.recordQueueDecision({ itemId: e.id, itemKind: "exemplar", group: null, position: null, decision: "approve" });
        ctx.io.stdout(`approved exemplar ${e.id}`);
        return 0;
      }
      const tierRaw = str(ctx, "tier");
      const tier = tierRaw === undefined ? undefined : Tier.safeParse(Number(tierRaw));
      if (tier && !tier.success) throw new CliError("--tier must be 1, 2, 3 or 4");
      const place = queuePlace(store, config, store.getMemory(id).id);
      const m = store.approve(id, { tier: tier?.data, statement: str(ctx, "statement") });
      store.recordQueueDecision({ itemId: m.id, itemKind: "memory", ...place, decision: "approve" });
      ctx.io.stdout(`approved ${m.id} (tier ${m.tier}): ${m.statement}`);
      const shapesTree = m.kind === "competence" || m.kind === "negative" || (m.kind === "fact" && m.attrs.background === true);
      if (shapesTree) ctx.io.stdout("Run `standin map refresh` to update your knowledge tree.");
      return 0;
    } finally {
      store.close();
    }
  },
};

export const rejectCommand: Command = {
  options: {},
  async run(ctx) {
    const id = targetId(ctx);
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      if (id.startsWith("exm_")) {
        const e = store.rejectExemplar(id);
        store.recordQueueDecision({ itemId: e.id, itemKind: "exemplar", group: null, position: null, decision: "reject" });
        ctx.io.stdout(`rejected exemplar ${e.id}`);
        return 0;
      }
      const place = queuePlace(store, config, store.getMemory(id).id);
      const m = store.reject(id);
      store.recordQueueDecision({ itemId: m.id, itemKind: "memory", ...place, decision: "reject" });
      ctx.io.stdout(`rejected ${m.id}; it will not be proposed again`);
      return 0;
    } finally {
      store.close();
    }
  },
};

export const retractCommand: Command = {
  options: {},
  async run(ctx) {
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const m = store.retract(targetId(ctx));
      ctx.io.stdout(`retracted ${m.id}`);
      return 0;
    } finally {
      store.close();
    }
  },
};

/** "Still true?" → yes: renews a current-state memory. */
export const keepCommand: Command = {
  options: {},
  async run(ctx) {
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const id = store.getMemory(targetId(ctx)).id;
      const place = queuePlace(store, config, id);
      const m = store.keepCurrent(id);
      store.recordQueueDecision({ itemId: m.id, itemKind: "still-true", ...place, decision: "keep" });
      ctx.io.stdout(`kept ${m.id}: ${m.statement}`);
      return 0;
    } finally {
      store.close();
    }
  },
};

/** "Still true?" → no: expires a current-state memory as the person's decision. */
export const expireCommand: Command = {
  options: {},
  async run(ctx) {
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const id = store.getMemory(targetId(ctx)).id;
      const place = queuePlace(store, config, id);
      const m = store.expire(id, "no longer true", "person");
      store.recordQueueDecision({ itemId: m.id, itemKind: "still-true", ...place, decision: "expire" });
      ctx.io.stdout(`expired ${m.id}: ${m.statement}`);
      return 0;
    } finally {
      store.close();
    }
  },
};
