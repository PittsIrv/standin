import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evalDedup, KS, loadDedupCases, METHODS } from "@standin/compaction";
import { agreement, baselineOf, buildCases, compareBaseline, readCases, repoCases, runCases, Suite, SUITES, writeCases, type Baseline, type EvalCase } from "@standin/evals";
import { CliError } from "../errors.ts";
import { table } from "../format.ts";
import { loadInstance } from "../home.ts";
import { fmtUsd, instanceModels, instanceTracer, instanceTurn } from "../runtime.ts";
import { flag, json, str, type Command, type CommandContext } from "./shared.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Where private cases, runs and the baseline live: never in the repo (answering spec §5.1). */
export const evalsDir = (home: string) => join(home, "evals");
export const casesPath = (home: string) => join(evalsDir(home), "cases.jsonl");

function ensureDir(home: string): string {
  const dir = evalsDir(home);
  mkdirSync(join(dir, "runs"), { recursive: true, mode: 0o700 });
  return dir;
}

function dedup(ctx: CommandContext): number {
  const cases = loadDedupCases();
  const reports = evalDedup(cases);
  if (flag(ctx, "json")) {
    ctx.io.stdout(JSON.stringify(reports, null, 2));
    return 0;
  }
  const rows = reports.map((r) => [r.method, ...KS.map((k) => pct(r.recall[k])), r.avgCandidates.toFixed(1), r.misses.join(", ") || "-"]);
  ctx.io.stdout(table(["method", ...KS.map((k) => `recall@${k}`), "sent", "missed at 8"], rows));
  ctx.io.stdout(
    `\n${cases.length} labeled cases. "sent" is the average number of memories passed to reconcile.\n` + METHODS.map((m) => `  ${m.name}: ${m.describe}`).join("\n"),
  );
  return 0;
}

async function build(ctx: CommandContext): Promise<number> {
  const { store, config } = loadInstance(ctx.home, ctx.io.clock);
  try {
    const tracer = instanceTracer(ctx, store, config);
    const models = instanceModels(ctx, config, tracer, { demo: flag(ctx, "demo-llm") });
    const file = casesPath(ctx.home);
    const existing = readCases(file).cases;
    const cases = await tracer.run("eval-build", {}, () => buildCases(store, models.for("judge"), config.persona.name, { perSuite: config.evals.perSuite, existing }));
    ensureDir(ctx.home);
    writeCases(file, cases);
    ctx.io.stdout(table(["suite", "cases"], SUITES.filter((s) => s !== "extraction").map((s) => [s, String(cases.filter((c) => c.suite === s).length)])));
    const kept = cases.filter((c) => c.edited).length;
    ctx.io.stdout(
      `\nWrote ${cases.length} cases to ${file}${kept ? ` (kept ${kept} you edited)` : ""}. They are private and never leave this machine.\n` +
        'Edit or delete any case; add "edited": true to one you changed so a rebuild keeps it. Next: standin eval run',
    );
    return 0;
  } finally {
    store.close();
  }
}

async function run(ctx: CommandContext): Promise<number> {
  const only = str(ctx, "suite");
  if (only !== undefined && !Suite.safeParse(only).success) throw new CliError(`--suite must be one of: ${SUITES.join(", ")}`);
  const given = str(ctx, "cases");
  const read = readCases(given ?? casesPath(ctx.home));
  let cases: EvalCase[] = given ? read.cases : [...read.cases, ...repoCases("extraction")];
  if (only) cases = cases.filter((c) => c.suite === only);
  const warnings = read.errors.map((e) => `${given ?? "cases.jsonl"} line ${e.line}: ${e.message} (skipped)`);
  if (cases.length === 0) throw new CliError(`No cases to run${only ? ` in ${only}` : ""}. Write yours first: standin eval build`);

  const { store, config } = loadInstance(ctx.home, ctx.io.clock);
  try {
    const tracer = instanceTracer(ctx, store, config);
    const models = instanceModels(ctx, config, tracer, { demo: flag(ctx, "demo-llm") });
    const report = await runCases({ ...instanceTurn(store, config, tracer, models), judge: models.for("judge"), store, personaName: config.persona.name, speakAt: config.hypotheses.speakAt }, cases);
    const dir = ensureDir(ctx.home);
    writeFileSync(join(dir, "runs", `${report.at.replace(/[:.]/g, "-")}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
    const basePath = join(dir, "baseline.json");
    const reset = flag(ctx, "baseline") || !existsSync(basePath);
    const base: Baseline | null = reset ? null : (JSON.parse(readFileSync(basePath, "utf8")) as Baseline);
    const regressed = base ? compareBaseline(report, base, config.evals.regression).regressed : [];
    if (reset) writeFileSync(basePath, JSON.stringify(baselineOf(report), null, 2), { mode: 0o600 });
    const quiz = agreement(store.listQuizAnswers());
    const failed = report.safetyFailed || regressed.length > 0;

    if (flag(ctx, "json")) {
      ctx.io.stdout(JSON.stringify({ report, regressed, baseline: reset ? "saved" : base, quiz, warnings }, null, 2));
      return failed ? 1 : 0;
    }
    const lines = [...warnings.map((w) => `warning: ${w}`)];
    const rows = SUITES.filter((s) => report.suites[s].n > 0).map((s) => {
      const r = report.suites[s];
      return [s, String(r.n), String(r.passed), r.score === null ? "-" : pct(r.score), base?.scores[s] === undefined ? "-" : pct(base.scores[s]!)];
    });
    lines.push(table(["suite", "cases", "passed", "score", "baseline"], rows));
    if (report.failures.length) {
      lines.push("", "Failures:");
      for (const f of report.failures.slice(0, 20)) lines.push(`  ✗ [${f.suite}] ${f.question}`, `      reply: ${f.reply}`, `      ${f.why.join("; ")}`);
      if (report.failures.length > 20) lines.push(`  …and ${report.failures.length - 20} more (--json shows all)`);
    }
    const m = report.checkMisses;
    lines.push(
      "",
      m.judged === 0
        ? "Check: no grounded replies to judge"
        : `Check: the judge found made-up claims in ${m.missed} of ${m.judged} replies the check let through (check model: ${config.models.roles.check ? "override" : "small tier"})`,
      quiz.rated === 0 ? "Self-quiz: no answers yet (quiz cards come up in standin review)" : quiz.score === null ? `Self-quiz: ${quiz.rated} rated, too few to say (needs 20)` : `Self-quiz: ${pct(quiz.score)} agreement over ${quiz.rated} answers`,
      `Cost: ${fmtUsd(report.costUsd)}`,
    );
    if (reset) lines.push("Saved this run as the baseline.");
    for (const r of regressed) lines.push(`Regressed: ${r.suite} ${pct(r.from)} → ${pct(r.to)} (more than ${config.evals.regression} points)`);
    if (report.safetyFailed) lines.push("A safety case failed: something private or a marker reached a reply.");
    ctx.io.stdout(lines.join("\n"));
    return failed ? 1 : 0;
  } finally {
    store.close();
  }
}

export const evalCommand: Command = {
  options: { ...json, "demo-llm": { type: "boolean" }, suite: { type: "string" }, cases: { type: "string" }, baseline: { type: "boolean" } },
  async run(ctx) {
    const sub = ctx.positionals[0];
    if (sub === "dedup") return dedup(ctx);
    if (sub === "build") return build(ctx);
    if (sub === "run") return run(ctx);
    throw new CliError("usage: standin eval build | run [--suite S] [--cases F] [--baseline] | dedup [--json]");
  },
};
