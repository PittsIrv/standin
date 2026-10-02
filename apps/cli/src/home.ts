import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseConfig, type Config, type ConfigInput } from "@standin/schema";
import { openStore, type Clock, type Store } from "@standin/store";

export class NotInitializedError extends Error {
  constructor(home: string) {
    super(`No standin instance at ${home}; run \`standin init\` first.`);
    this.name = "NotInitializedError";
  }
}

export function resolveHome(env: Record<string, string | undefined>): string {
  return env.STANDIN_HOME ?? join(homedir(), ".standin");
}

export const configPath = (home: string) => join(home, "config.json");
export const dbPath = (home: string) => join(home, "standin.db");

export interface Instance {
  home: string;
  config: Config;
  store: Store;
}

export function isInitialized(home: string): boolean {
  return existsSync(configPath(home));
}

/** Creates the instance directory (owner-only permissions: it holds private data) and its config. */
export function createInstance(home: string, config: ConfigInput, clock?: Clock): Instance {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const parsed = parseConfig(config);
  writeFileSync(configPath(home), `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  return { home, config: parsed, store: openStore({ path: dbPath(home), clock, currentStateHalfLifeDays: parsed.consolidation.currentStateHalfLifeDays }) };
}

export function loadInstance(home: string, clock?: Clock): Instance {
  if (!isInitialized(home)) throw new NotInitializedError(home);
  const config = parseConfig(JSON.parse(readFileSync(configPath(home), "utf8")));
  return { home, config, store: openStore({ path: dbPath(home), clock, currentStateHalfLifeDays: config.consolidation.currentStateHalfLifeDays }) };
}
