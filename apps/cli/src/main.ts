import { parseArgs } from "node:util";
import { AmbiguousIdError, InvalidTransitionError, NotFoundError, type Clock } from "@standin/store";
import { commands, type CommandContext } from "./commands/index.ts";
import { CliError } from "./errors.ts";
import { NotInitializedError, resolveHome } from "./home.ts";

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  readStdin?: () => Promise<string>;
  clock?: Clock;
}

export const USAGE = `Usage: standin <command> [options]

Commands:
  init [--name N] [--languages en,zh] [--demo]   create an instance in $STANDIN_HOME (default ~/.standin)
  observe --source K --role R --lang L [--ref S] [--occurred ISO] [--file F]
                                                 add an observation (from a file or stdin)
  compact [--limit N] [--retry-failed] [--demo-llm]
                                                 turn observations into proposed memories
  queue                                          show this week's review queue
  approve <id> [--tier T] [--statement S]        approve a proposed memory (or exm_ exemplar)
  reject <id>                                    reject a proposed memory (or exm_ exemplar)
  retract <id>                                   retract an approved memory
  memories [--status S] [--kind K] [--as-of ISO] [--recorded-at ISO]
                                                 list memories (bitemporal with --as-of)
  consolidate                                    expire stale memories, decay confidence, purge raw text

List commands accept --json.`;

/** Runs one CLI invocation and returns the exit code. Never calls process.exit, so it is testable. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [name, ...rest] = argv;
  const command = name ? commands[name] : undefined;
  if (!command) {
    io.stderr(name && name !== "help" && name !== "--help" ? `Unknown command: ${name}\n\n${USAGE}` : USAGE);
    return name === "help" || name === "--help" ? 0 : 2;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: command.options, allowPositionals: true, strict: true });
    const ctx: CommandContext = { io, home: resolveHome(io.env), values, positionals };
    return await command.run(ctx);
  } catch (err) {
    if (
      err instanceof NotInitializedError ||
      err instanceof NotFoundError ||
      err instanceof AmbiguousIdError ||
      err instanceof InvalidTransitionError ||
      err instanceof CliError
    ) {
      io.stderr(`error: ${err.message}`);
      return 1;
    }
    if (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS")) {
      io.stderr(`error: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 1;
  }
}
