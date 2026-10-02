import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerToObservation,
  AnswerSheetError,
  BANKS,
  CORE_V1,
  parseAnswerSheet,
  renderTemplate,
  type TemplateLang,
} from "@standin/interview";
import { Lang } from "@standin/schema";
import { systemClock } from "@standin/store";
import { CliError } from "../errors.ts";
import { isInitialized, loadInstance, NotInitializedError } from "../home.ts";
import { flag, json, str, type Command, type CommandContext } from "./shared.ts";

const TEMPLATE_LANGS = new Set<TemplateLang>(["both", "en", "zh"]);

function template(ctx: CommandContext): number {
  const bankId = str(ctx, "bank") ?? CORE_V1.id;
  const bank = BANKS[bankId];
  if (!bank) throw new CliError(`unknown question bank "${bankId}" (available: ${Object.keys(BANKS).join(", ")})`);
  const lang = (str(ctx, "lang") ?? "both") as TemplateLang;
  if (!TEMPLATE_LANGS.has(lang)) throw new CliError(`--lang must be one of: ${[...TEMPLATE_LANGS].join(", ")}`);
  const sheet = renderTemplate(bank, lang);

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

function importSheet(ctx: CommandContext): number {
  const file = ctx.positionals[1];
  if (!file) throw new CliError("usage: standin interview import <file>");
  const langArg = str(ctx, "lang");
  const lang = langArg === undefined ? undefined : Lang.safeParse(langArg);
  if (lang && !lang.success) throw new CliError(`--lang must be one of: ${Lang.options.join(", ")}`);
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
  const inputs = sheet.answers.map((a) => ({
    questionId: a.questionId,
    input: answerToObservation(a, { bankId: sheet.bankId, occurredAt, lang: lang?.data }),
  }));

  const dryRun = flag(ctx, "dry-run");
  const { store } = loadInstance(ctx.home, ctx.io.clock);
  const rows: { questionId: string; lang: string; status: "added" | "unchanged" | "would add"; observationId: string | null }[] = [];
  try {
    store.transaction(() => {
      for (const { questionId, input } of inputs) {
        const existing = store.findObservationByContent(input.sourceKind, input.text);
        if (existing) rows.push({ questionId, lang: input.lang, status: "unchanged", observationId: existing.id });
        else if (dryRun) rows.push({ questionId, lang: input.lang, status: "would add", observationId: null });
        else rows.push({ questionId, lang: input.lang, status: "added", observationId: store.addObservation(input).id });
      }
    });
  } finally {
    store.close();
  }

  const count = (s: string) => rows.filter((r) => r.status === s).length;
  if (flag(ctx, "json")) {
    ctx.io.stdout(JSON.stringify({ bank: sheet.bankId, answers: rows, blank: sheet.skipped }, null, 2));
    return 0;
  }
  for (const r of rows) ctx.io.stdout(`${(r.observationId ?? "-").padEnd(16)}  ${r.status.padEnd(9)}  ${r.lang.padEnd(5)}  ${r.questionId}`);
  const summary = dryRun
    ? `would add ${count("would add")}, unchanged ${count("unchanged")}, blank ${sheet.skipped.length} (dry run; nothing written)`
    : `added ${count("added")}, unchanged ${count("unchanged")}, blank ${sheet.skipped.length}`;
  ctx.io.stdout(`${summary}${!dryRun && count("added") > 0 ? "\nNext: standin compact" : ""}`);
  return 0;
}

export const interviewCommand: Command = {
  options: {
    bank: { type: "string" },
    lang: { type: "string" },
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
