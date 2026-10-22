import { parseArgs } from "node:util";
import { LLMError } from "@standin/llm";
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
  /** Used while polling a batch; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Registers a Ctrl-C handler and returns its unregister function (default: process SIGINT). */
  onInterrupt?: (handler: () => void) => () => void;
}

export const USAGE = `Usage: standin <command> [options]

Commands:
  init [--name N] [--demo]                       create an instance in $STANDIN_HOME (default ~/.standin)
  tell "<text>" | --file F [--occurred ISO]      tell the standin something directly (goes through compaction and review)
  observe --source K --role R [--ref S] [--occurred ISO] [--file F]
                                                 add an observation (from a file or stdin)
  interview template [--bank B] [--out F | --stdout]
                                                 banks: core-v1, projects-v1, skills-v1, education-v1, opinions-v1, life-v1
                                                 write a private answer sheet (default: $STANDIN_HOME/interviews/)
  interview import <file> [--occurred ISO] [--dry-run]
                                                 turn each answered question into an observation
  compact [--limit N] [--retry-failed] [--demo-llm]
                                                 turn observations into proposed memories
  compact --batch [--wait]                       same, through the batch API at about half the price:
                                                 submits, then collects on a later run (--wait polls)
  compact --abandon-batch                        give up on the open batch; its observations go back to pending
  queue                                          the review queue, in order: contradictions, still true?, updates, new
  approve <id> [--tier T] [--statement S]        approve a proposed memory (or exm_ exemplar)
  reject <id>                                    reject a proposed memory (or exm_ exemplar)
  retract <id>                                   retract an approved memory
  keep <id>                                      a "currently…" memory is still true (renews it)
  expire <id>                                    a "currently…" memory is no longer true
  memories [--status S] [--kind K] [--as-of ISO] [--recorded-at ISO]
                                                 list memories (bitemporal with --as-of)
  map [--json] [--private] [--all]               your world tree: six roots, what's lit, at what depth, and why; calibration
                                                 (--private adds the presented score; --all shows frontier nodes)
  review [--port P] [--lan] [--demo-llm]          rate concepts, review proposals and edit your world tree in a local page
                                                 (--lan: reachable from your phone, with a QR code; Ctrl-C stops)
  ask "<question>" [--work] [--demo-llm]         answer as a visitor would be answered: the reply, its state and citations
                                                 (--work: what it looked at, filtered and checked, and the cost)
  questions [--sheet]                            open questions about your life (--sheet: an answer sheet for interview import)
  outcomes export [--out F]                      text-free records of settled guesses, to a local file (needs sharing.outcomes)
  outcomes priors <file> | --clear               load (or clear) default reliabilities, capped per cell
  map refresh [--demo-llm]                       place new topics, seed from background, propose lighting (calls the map model)
  consolidate                                    expire memories whose validity has ended
  purge --before ISO                             delete raw text and trace text for observations compacted before ISO
  usage [--since ISO] [--by role|model]          model calls, tokens and cost
  traces [--since ISO] [--kind K] [--limit N]    recent runs (compaction, import, ...)
  trace <id> | --last [--content]                one run as a tree of steps
  eval build [--demo-llm]                        write private test cases from your store to $STANDIN_HOME/evals/cases.jsonl
                                                 (edit freely; add "edited": true to keep a case through rebuilds)
  eval run [--suite S] [--cases F] [--baseline] [--demo-llm]
                                                 answer every case as a visitor would be answered and grade it; exit 1 on
                                                 any leak or a quality drop of more than 5 points (--baseline: reset it)
  eval dedup                                     recall@1/4/8 of each duplicate-search method on the labeled set

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
      err instanceof CliError ||
      err instanceof LLMError
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
