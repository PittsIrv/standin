import { compactCommand } from "./compact.ts";
import { consolidateCommand } from "./consolidate.ts";
import { approveCommand, expireCommand, keepCommand, rejectCommand, retractCommand } from "./decide.ts";
import { evalCommand } from "./eval.ts";
import { initCommand } from "./init.ts";
import { interviewCommand } from "./interview.ts";
import { mapCommand } from "./map.ts";
import { memoriesCommand } from "./memories.ts";
import { observeCommand } from "./observe.ts";
import { purgeCommand } from "./purge.ts";
import { queueCommand } from "./queue.ts";
import { reviewCommand } from "./review.ts";
import { tellCommand } from "./tell.ts";
import { traceCommand, tracesCommand } from "./traces.ts";
import { usageCommand } from "./usage.ts";
import type { Command } from "./shared.ts";

export type { Command, CommandContext } from "./shared.ts";

export const commands: Record<string, Command> = {
  init: initCommand,
  observe: observeCommand,
  tell: tellCommand,
  interview: interviewCommand,
  compact: compactCommand,
  queue: queueCommand,
  approve: approveCommand,
  reject: rejectCommand,
  retract: retractCommand,
  keep: keepCommand,
  expire: expireCommand,
  memories: memoriesCommand,
  map: mapCommand,
  review: reviewCommand,
  consolidate: consolidateCommand,
  purge: purgeCommand,
  eval: evalCommand,
  usage: usageCommand,
  traces: tracesCommand,
  trace: traceCommand,
};
