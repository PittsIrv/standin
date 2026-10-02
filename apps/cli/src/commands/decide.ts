import { Tier } from "@standin/schema";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
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
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      if (id.startsWith("exm_")) {
        const e = store.approveExemplar(id);
        ctx.io.stdout(`approved exemplar ${e.id}`);
        return 0;
      }
      const tierRaw = str(ctx, "tier");
      const tier = tierRaw === undefined ? undefined : Tier.safeParse(Number(tierRaw));
      if (tier && !tier.success) throw new CliError("--tier must be 1, 2, 3 or 4");
      const m = store.approve(id, { tier: tier?.data, statement: str(ctx, "statement") });
      ctx.io.stdout(`approved ${m.id} (tier ${m.tier}): ${m.statement}`);
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
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      if (id.startsWith("exm_")) {
        ctx.io.stdout(`rejected exemplar ${store.rejectExemplar(id).id}`);
        return 0;
      }
      const m = store.reject(id);
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
