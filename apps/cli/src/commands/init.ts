import { DEMO_PERSONA_NAME, demoObservations } from "@standin/demo-persona";
import { CliError } from "../errors.ts";
import { createInstance, isInitialized } from "../home.ts";
import { flag, str, type Command } from "./shared.ts";

export const initCommand: Command = {
  options: { name: { type: "string" }, demo: { type: "boolean" } },
  async run(ctx) {
    if (isInitialized(ctx.home)) throw new CliError(`an instance already exists at ${ctx.home}`);
    const demo = flag(ctx, "demo");
    const name = str(ctx, "name") ?? (demo ? DEMO_PERSONA_NAME : undefined);
    if (!name) throw new CliError("--name is required (or use --demo)");
    const { store } = createInstance(ctx.home, { persona: { name } }, ctx.io.clock);
    try {
      ctx.io.stdout(`Created standin instance for ${name} at ${ctx.home}`);
      if (demo) {
        const observations = demoObservations();
        for (const o of observations) store.addObservation(o);
        ctx.io.stdout(`Loaded ${observations.length} demo observations. Next: standin compact --demo-llm`);
      }
    } finally {
      store.close();
    }
    return 0;
  },
};
