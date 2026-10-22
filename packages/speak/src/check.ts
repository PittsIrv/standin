import type { SpeakOut } from "./schemas.ts";

/** A reply quoting this many words in a row of a hidden statement is a leak (answering spec §2, step 6). */
export const LEAK_RUN = 8;

const tokens = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Whether `reply` repeats `n` words in a row from `hidden`. */
export function leaks(reply: string, hidden: string, n = LEAK_RUN): boolean {
  const h = tokens(hidden);
  if (h.length < n) return false;
  const r = ` ${tokens(reply).join(" ")} `;
  for (let i = 0; i + n <= h.length; i++) if (r.includes(` ${h.slice(i, i + n).join(" ")} `)) return true;
  return false;
}

export interface CodeCheckContext {
  allowed: Set<string>;
  /** A guess item or a stance is in the context: "inferred" has something to stand on. */
  inferable: boolean;
  generalAllowed: boolean;
  canary: string;
  hidden: string[];
}

/** The hard rules, checked in code (decision 85). The reason a reply is rejected, or null. */
export function codeCheck(out: SpeakOut, ctx: CodeCheckContext): string | null {
  const forged = out.cites.filter((id) => !ctx.allowed.has(id));
  if (forged.length) return `cites ids it wasn't given: ${forged.join(", ")}`;
  if (out.state === "grounded" && out.cites.length === 0) return "grounded with no cites";
  if (out.state === "inferred" && !ctx.inferable) return "inferred with no guess or stance in context";
  if (out.general && !ctx.generalAllowed) return "general knowledge where every concept declines";
  if (out.reply.includes(ctx.canary)) return "contains the canary";
  if (ctx.hidden.some((h) => leaks(out.reply, h))) return `repeats ${LEAK_RUN}+ words of a hidden memory`;
  return null;
}
