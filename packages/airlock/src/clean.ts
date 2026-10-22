import { REMOVED, scan, type Finding } from "./scan.ts";

const MASK = "•••";
/** Words of context shown on each side of a finding; none of the finding itself (spec §6). */
export const CONTEXT_WORDS = 4;

/** A finding as it may be shown: where it is and the words around it, never the matched text. */
export interface Described {
  label: string;
  kind: Finding["kind"];
  line: number;
  column: number;
  context: string;
}

/** Each finding as it may be shown. Every finding is masked in every context, so one never shows its neighbor. */
export function describeAll(text: string, findings: Finding[]): Described[] {
  const sorted = [...findings].sort((a, b) => a.start - b.start);
  let masked = "";
  let at = 0;
  const maskedAt = new Map<Finding, number>();
  for (const f of sorted) {
    masked += text.slice(at, f.start);
    maskedAt.set(f, masked.length);
    masked += MASK;
    at = f.end;
  }
  masked += text.slice(at);
  return findings.map((f) => {
    const before = text.slice(0, f.start);
    const pos = maskedAt.get(f)!;
    const left = masked.slice(0, pos).match(new RegExp(`(?:\\S+\\s+){0,${CONTEXT_WORDS}}$`))![0];
    const right = masked.slice(pos + MASK.length).match(new RegExp(`^(?:\\s*\\S+){0,${CONTEXT_WORDS}}`))![0];
    return {
      label: f.label,
      kind: f.kind,
      line: before.split("\n").length,
      column: f.start - before.lastIndexOf("\n"),
      context: `${left}${MASK}${right}`.replace(/\s+/g, " ").trim(),
    };
  });
}

export function describeFinding(text: string, f: Finding, all: Finding[] = [f]): Described {
  const list = all.includes(f) ? all : [...all, f];
  return describeAll(text, list)[list.indexOf(f)]!;
}

/** Typed text with a secret in it: refused, so it is never stored or sent to a model (decision 93). */
export class SecretFoundError extends Error {
  constructor(readonly findings: Described[]) {
    const list = findings.map((f) => `${f.label} (line ${f.line}: “${f.context}”)`).join("; ");
    super(
      `${findings.length === 1 ? "This looks like a" : `This has ${findings.length} things that look like secrets: a`} ${list}. Your standin never needs ${findings.length === 1 ? "it" : "them"}; remove ${findings.length === 1 ? "it" : "them"} and try again.`,
    );
    this.name = "SecretFoundError";
  }
}

export interface Cut {
  secrets: { label: string; count: number }[];
  contacts: number;
}

/** `text` with the given findings replaced by "[removed]". */
export function cutOut(text: string, findings: Finding[]): string {
  let out = text;
  for (const f of [...findings].sort((a, b) => b.start - a.start)) out = out.slice(0, f.start) + REMOVED + out.slice(f.end);
  return out;
}

/**
 * The guard on every way in (spec §3). Contact details are always cut. Secrets are refused in text the person typed
 * (`refuse`) and cut from files and pages they can't edit (`cut`, decision 99).
 */
export function clean(text: string, mode: "refuse" | "cut"): { text: string; cut: Cut } {
  const found = scan(text);
  const secrets = found.filter((f) => f.kind === "secret");
  if (mode === "refuse" && secrets.length) throw new SecretFoundError(describeAll(text, found).filter((d) => d.kind === "secret"));
  const counts = new Map<string, number>();
  for (const f of secrets) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
  return {
    text: found.length ? cutOut(text, found) : text,
    cut: { secrets: [...counts].map(([label, count]) => ({ label, count })), contacts: found.length - secrets.length },
  };
}

/** Refuses on a secret and returns the text unchanged otherwise; for fields where cutting a contact makes no sense. */
export function assertNoSecret(text: string): void {
  const found = scan(text);
  if (found.some((f) => f.kind === "secret")) throw new SecretFoundError(describeAll(text, found).filter((d) => d.kind === "secret"));
}
