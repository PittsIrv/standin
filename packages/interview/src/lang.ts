import type { Lang } from "@standin/schema";

const HAN = /\p{Script=Han}/gu;
const LATIN_WORD = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;

/**
 * Rough language label for a piece of text. Han characters are weighted as
 * about 1.5 per word so a sentence of either language counts similarly.
 */
export function detectLang(text: string): Lang {
  const han = text.match(HAN)?.length ?? 0;
  const latin = text.match(LATIN_WORD)?.length ?? 0;
  const zh = han / 1.5;
  if (zh + latin === 0) return "other";
  const share = zh / (zh + latin);
  if (share >= 0.85) return "zh";
  if (share <= 0.15) return "en";
  return "mixed";
}
