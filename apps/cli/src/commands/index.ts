import { compactCommand } from "./compact.ts";
import { consolidateCommand } from "./consolidate.ts";
import { approveCommand, rejectCommand, retractCommand } from "./decide.ts";
import { initCommand } from "./init.ts";
import { memoriesCommand } from "./memories.ts";
import { observeCommand } from "./observe.ts";
import { queueCommand } from "./queue.ts";
import type { Command } from "./shared.ts";

export type { Command, CommandContext } from "./shared.ts";

export const commands: Record<string, Command> = {
  init: initCommand,
  observe: observeCommand,
  compact: compactCommand,
  queue: queueCommand,
  approve: approveCommand,
  reject: rejectCommand,
  retract: retractCommand,
  memories: memoriesCommand,
  consolidate: consolidateCommand,
};
