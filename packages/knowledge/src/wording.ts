/** Lighting in the person's voice, one sentence per depth (spec §3.6). */
const TEMPLATES: ((t: string) => string)[] = [
  (t) => `${t} isn't something I know.`,
  (t) => `I've heard of ${t} but haven't used it.`,
  (t) => `I've used ${t} and can get things done with it.`,
  (t) => `I know ${t} well.`,
  (t) => `${t} is one of my deep areas.`,
];

export function statementFor(depth: number, topic: string): string {
  const template = TEMPLATES[depth];
  if (!template) throw new RangeError(`depth must be 0–4, got ${depth}`);
  return template(topic);
}

export const gapStatement = (sub: string, level: number): string => `I'm fine with ${sub} up to ${level}, but not deeper.`;
