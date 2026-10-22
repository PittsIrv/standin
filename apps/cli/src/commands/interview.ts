import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answersToObservations,
  AnswerSheetError,
  BANKS,
  CORE_V1,
  parseAnswerSheet,
  renderTemplate,
} from "@standin/interview";
import { isMostlyLatin } from "@standin/schema";
import { systemClock } from "@standin/store";
import { CliError } from "../errors.ts";
import { isInitialized, loadInstance, NotInitializedError } from "../home.ts";
import { instanceTracer } from "../runtime.ts";
import { flag, json, str, type Command, type CommandContext } from "./shared.ts";

function template(ctx: CommandContext): number {
  const bankId = str(ctx, "bank") ?? CORE_V1.id;
  const bank = BANKS[bankId];
  if (!bank) throw new CliError(`unknown question bank "${bankId}" (available: ${Object.keys(BANKS).join(", ")})`);
  const sheet = renderTemplate(bank);

  if (flag(ctx, "stdout")) {
    ctx.io.stdout(sheet.trimEnd());
    return 0;
  }
  let out = str(ctx, "out");
  if (!out) {
    // Default to the instance directory: answers are private data.
    if (!isInitialized(ctx.home)) throw new NotInitializedError(ctx.home);
    const dir = join(ctx.home, "interviews");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const day = (ctx.io.clock ?? systemClock).now().toISOString().slice(0, 10);
    out = join(dir, `${bank.id}-${day}.md`);
  }
  if (existsSync(out)) throw new CliError(`${out} already exists; edit it, or pass --out to write somewhere else`);
  writeFileSync(out, sheet, { mode: 0o600 });
  ctx.io.stdout(`Wrote ${out}\nFill it in, then run: standin interview import ${out}`);
  return 0;
}

async function importSheet(ctx: CommandContext): Promise<number> {
  const file = ctx.positionals[1];
  if (!file) throw new CliError("usage: standin interview import <file>");
  const occurredArg = str(ctx, "occurred");
  const occurred = occurredArg === undefined ? (ctx.io.clock ?? systemClock).now() : new Date(occurredArg);
  if (Number.isNaN(occurred.getTime())) throw new CliError(`--occurred is not a date: ${occurredArg}`);
  const occurredAt = occurred.toISOString();

  let sheet;
  try {
    sheet = parseAnswerSheet(readFileSync(file, "utf8"), BANKS);
  } catch (err) {
    if (err instanceof AnswerSheetError) throw new CliError(`${file}: ${err.message}`);
    throw err;
  }
  // Checked on the answer alone: the English question around it would mask a short non-English answer.
  const nonEnglish = sheet.answers.filter((a) => !isMostlyLatin(a.answer)).map((a) => a.questionId);
  if (nonEnglish.length > 0)
    throw new CliError(`${file}: standin is English-only for now; rewrite these answers in English: ${nonEnglish.join(", ")}. Nothing was imported.`);
  const inputs = answersToObservations(sheet.answers, sheet.bankId ? BANKS[sheet.bankId]! : null, { bankId: sheet.bankId, occurredAt });

  const dryRun = flag(ctx, "dry-run");
  const { store, config } = loadInstance(ctx.home, ctx.io.clock);
  // One row per observation: a plain question, or a whole repeated item ("projects.2").
  const rows: { key: string; status: "added" | "unchanged" | "would add"; observationId: string | null }[] = [];
  const importAll = () =>
    store.transaction(() => {
      for (const { key, input } of inputs) {
        const existing = store.findObservationByContent(input.sourceKind, input.text);
        if (existing) rows.push({ key, status: "unchanged", observationId: existing.id });
        else if (dryRun) rows.push({ key, status: "would add", observationId: null });
        else rows.push({ key, status: "added", observationId: store.addObservation(input).id });
      }
      // An answer to an open question (from standin questions --sheet) answers it.
      if (!dryRun)
        for (const a of sheet.answers) {
          const q = a.questionId.startsWith("qst_") ? store.listQuestions({ status: "open" }).find((x) => x.id === a.questionId) : undefined;
          if (q) store.setQuestionStatus(q.id, "answered");
        }
    });
  try {
    // A dry run writes nothing, its trace included.
    if (dryRun) importAll();
    else
      await instanceTracer(ctx, store, config).run("import", { "standin.import.source": "interview", "standin.import.bank": sheet.bankId }, async (run) => {
        importAll();
        run.setAttributes({
          "standin.import.added": rows.filter((r) => r.status === "added").length,
          "standin.import.unchanged": rows.filter((r) => r.status === "unchanged").length,
          "standin.import.blank": sheet.skipped.length,
        });
      });
  } finally {
    store.close();
  }

  const count = (s: string) => rows.filter((r) => r.status === s).length;
  if (flag(ctx, "json")) {
    ctx.io.stdout(JSON.stringify({ bank: sheet.bankId, answers: rows, blank: sheet.skipped }, null, 2));
    return 0;
  }
  for (const r of rows) ctx.io.stdout(`${(r.observationId ?? "-").padEnd(16)}  ${r.status.padEnd(9)}  ${r.key}`);
  const summary = dryRun
    ? `would add ${count("would add")}, unchanged ${count("unchanged")}, blank ${sheet.skipped.length} (dry run; nothing written)`
    : `added ${count("added")}, unchanged ${count("unchanged")}, blank ${sheet.skipped.length}`;
  ctx.io.stdout(`${summary}${!dryRun && count("added") > 0 ? "\nNext: standin compact" : ""}`);
  return 0;
}

export const interviewCommand: Command = {
  options: {
    bank: { type: "string" },
    out: { type: "string" },
    stdout: { type: "boolean" },
    occurred: { type: "string" },
    "dry-run": { type: "boolean" },
    ...json,
  },
  async run(ctx) {
    const sub = ctx.positionals[0];
    if (sub === "template") return template(ctx);
    if (sub === "import") return importSheet(ctx);
    throw new CliError("usage: standin interview template | import <file>");
  },
};
