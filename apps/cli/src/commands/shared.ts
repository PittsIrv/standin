import type { ParseArgsOptionsConfig } from "node:util";
import type { CliIO } from "../main.ts";

export interface CommandContext {
  io: CliIO;
  home: string;
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  positionals: string[];
}

export interface Command {
  options: ParseArgsOptionsConfig;
  run(ctx: CommandContext): Promise<number>;
}

export const str = (ctx: CommandContext, key: string): string | undefined => {
  const v = ctx.values[key];
  return typeof v === "string" ? v : undefined;
};
export const flag = (ctx: CommandContext, key: string): boolean => ctx.values[key] === true;
export const json = { json: { type: "boolean" } } as const satisfies ParseArgsOptionsConfig;
