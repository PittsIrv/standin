/** Every limit in one place (intro-sources spec §8). */
export const LIMITS = {
  textChars: 20_000,
  fileBytes: 10 * 1024 * 1024,
  pdfPages: 30,
  pageBytes: 2 * 1024 * 1024,
  pageTimeoutMs: 10_000,
  sitePages: 10,
  sectionChars: 4_000,
  sectionOverlap: 200,
  fuzzyOverlap: 0.9,
} as const;

const REMOVED = "[removed]";
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ADDRESS = /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace)\b\.?/g;
const PHONE = /\+?\(?\d[\d\s().-]{5,}\d/g;

/** Contact details out of a source's text before it is stored or sent to a model (spec §3). Best effort for addresses. */
export function stripContacts(text: string): { text: string; removed: number } {
  let removed = 0;
  const cut = () => {
    removed++;
    return REMOVED;
  };
  const out = text
    .replace(EMAIL, cut)
    .replace(ADDRESS, cut)
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, "").length;
      // A year range ("1999-2003") or a short number is not a phone number.
      if (digits < 7 || digits > 15 || /^\d{4}\s*-\s*\d{4}$/.test(m.trim())) return m;
      return cut();
    });
  return { text: out, removed };
}

/** Case, whitespace, typography and hyphens (including at line breaks) set aside, for comparing a quote with its source. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”„″]/g, '"')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[‐‑‒–—―-]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‐‑‒–—―-]/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Where a quote stands in its source (spec §4): "exact" when it appears once normalized, "fuzzy" when some window of
 * the source shares at least 90% of its words, else null (the statement is dropped).
 */
export function align(quote: string, source: string): "exact" | "fuzzy" | null {
  const q = normalize(quote);
  if (!q) return null;
  if (normalize(source).includes(q)) return "exact";
  const qt = tokens(quote);
  const st = tokens(source);
  const n = qt.length;
  if (n === 0 || st.length < n) return null;
  const want = new Map<string, number>();
  for (const t of qt) want.set(t, (want.get(t) ?? 0) + 1);
  for (let i = 0; i + n <= st.length; i++) {
    const have = new Map<string, number>();
    for (const t of st.slice(i, i + n)) have.set(t, (have.get(t) ?? 0) + 1);
    let shared = 0;
    for (const [t, c] of want) shared += Math.min(c, have.get(t) ?? 0);
    if (shared / n >= LIMITS.fuzzyOverlap) return "fuzzy";
  }
  return null;
}

const titleLike = (line: string) => {
  const t = line.trim();
  if (!t || t.length > 60 || /[.,;:!?]$/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 5) return false;
  return t === t.toUpperCase() ? /\p{L}/u.test(t) : words.every((w) => /^[\p{Lu}\d&(]/u.test(w) || /^(of|and|in|the|for|at|to|&)$/.test(w));
};

/** A source split into sections by its headings, then into chunks of at most 4,000 characters with 200 of overlap. */
export function sections(text: string): { heading: string | null; text: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const md = /^#{1,6}\s+(.+)$/.exec(line.trim());
    const next = lines.slice(i + 1).find((l) => l.trim());
    if (md || (titleLike(line) && next !== undefined && !titleLike(next))) out.push({ heading: (md ? md[1]! : line).trim(), lines: [] });
    else out.at(-1)!.lines.push(line);
  }
  const step = LIMITS.sectionChars - LIMITS.sectionOverlap;
  return out.flatMap(({ heading, lines: ls }) => {
    const body = ls.join("\n").trim();
    if (!body) return [];
    if (body.length <= LIMITS.sectionChars) return [{ heading, text: body }];
    const chunks: { heading: string | null; text: string }[] = [];
    for (let at = 0; at < body.length; at += step) {
      chunks.push({ heading, text: body.slice(at, at + LIMITS.sectionChars) });
      if (at + LIMITS.sectionChars >= body.length) break;
    }
    return chunks;
  });
}
