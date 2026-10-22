import { GITLEAKS_RULES, GLOBAL_ALLOWLIST } from "./gitleaks.gen.ts";
import { labelOf } from "./labels.ts";
import type { PortedAllowlist, PortedRule } from "./rules.ts";

/** Something in a text that must not be stored or sent to a model as it is (personal-data guard spec §2). */
export interface Finding {
  rule: string;
  label: string;
  kind: "secret" | "contact";
  start: number;
  end: number;
}

/** Shannon entropy of a string, in bits per character. */
export function shannon(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** The generic-key threshold (decision 95); gitleaks' own value for its generic rule. */
export const GENERIC_ENTROPY = 3.5;

// ---- ported gitleaks rules ------------------------------------------------

interface Compiled {
  rule: PortedRule;
  re: RegExp;
  allow: { target: PortedAllowlist["target"]; regexes: RegExp[]; stopwords: string[] }[];
}

const compileList = (a: PortedAllowlist) => ({ target: a.target, regexes: a.regexes.map((r) => new RegExp(r)), stopwords: a.stopwords });
let compiled: { rules: Compiled[]; global: ReturnType<typeof compileList> } | null = null;

function rules() {
  compiled ??= {
    rules: GITLEAKS_RULES.map((rule) => ({ rule, re: new RegExp(rule.regex, "gd"), allow: (rule.allowlists ?? []).map(compileList) })),
    global: compileList(GLOBAL_ALLOWLIST),
  };
  return compiled;
}

function lineAround(text: string, start: number, end: number): string {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const to = text.indexOf("\n", end);
  return text.slice(from, to < 0 ? text.length : to);
}

function allowed(list: ReturnType<typeof compileList>, secret: string, match: string, line: string): boolean {
  const target = list.target === "match" ? match : list.target === "line" ? line : secret;
  if (list.regexes.some((r) => r.test(target))) return true;
  const lower = secret.toLowerCase();
  return list.stopwords.some((w) => lower.includes(w));
}

/** gitleaks' detection loop for one text: keyword prefilter, regex, secret group, entropy, allowlists. */
function gitleaks(text: string): Finding[] {
  const lower = text.toLowerCase();
  const { rules: all, global } = rules();
  const out: Finding[] = [];
  for (const c of all) {
    if (c.rule.keywords.length && !c.rule.keywords.some((k) => lower.includes(k))) continue;
    c.re.lastIndex = 0;
    for (const m of text.matchAll(c.re)) {
      if (!m[0]) continue;
      let g = c.rule.secretGroup ?? 0;
      if (!g) for (let i = 1; i < m.length; i++) if (m[i]) { g = i; break; } // first non-empty group, as gitleaks does
      const secret = m[g] ?? m[0];
      const [start, end] = m.indices?.[g] ?? [m.index, m.index + m[0].length];
      if (c.rule.entropy) {
        if (shannon(secret) <= c.rule.entropy) continue;
        if (c.rule.id.startsWith("generic") && !/\d/.test(secret)) continue;
      }
      const line = lineAround(text, start, end);
      if (allowed(global, secret, m[0], line) || c.allow.some((a) => allowed(a, secret, m[0], line))) continue;
      out.push({ rule: c.rule.id, label: labelOf(c.rule.id), kind: "secret", start, end });
    }
  }
  return out;
}

// ---- our own rules --------------------------------------------------------

const ASSIGN = String.raw`(?:\s+(?:is|was)\s+|\s*[:=]\s*)`;
const PROSE_KEY = new RegExp(
  String.raw`\b(?:api[ _-]?(?:key|token|secret)|access[ _-]?(?:key|token)|secret[ _-]?key|client[ _-]?secret|auth[ _-]?token|token|secret)${ASSIGN}["'\x60]?([^\s"'\x60,;]{8,150})`,
  "gid",
);
const PASSWORD = new RegExp(
  String.raw`\b(?:password|passwd|passcode|passphrase|pwd|pin)${ASSIGN}(?:"([^"\n]{1,64})"|'([^'\n]{1,64})'|“([^”\n]{1,64})”|([^\s"'“]+))`,
  "gid",
);
const PRIVATE_KEY = /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----)?/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){3,8}\b/g;
const CN_ID = /\b\d{17}[\dXx]\b/g;
const SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(compact: string): boolean {
  if (compact.length < 15 || compact.length > 34) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

const CN_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
function cnIdValid(id: string): boolean {
  const [y, m, d] = [Number(id.slice(6, 10)), Number(id.slice(10, 12)), Number(id.slice(12, 14))];
  const born = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || born.getUTCMonth() !== m - 1 || born.getUTCDate() !== d) return false;
  const sum = CN_WEIGHTS.reduce((s, w, i) => s + w * Number(id[i]), 0);
  return "10X98765432"[sum % 11] === id[17]!.toUpperCase();
}

/** A password value has to look like one: a digit, a symbol, or a capital after its first letter (decision 100). */
function looksLikePassword(value: string): boolean {
  const v = value.replace(/[.!?,;:)\]]+$/, "");
  return v.length > 0 && (/\d/.test(v) || /[^\p{L}\p{N}\s]/u.test(v) || /.\p{Lu}/u.test(v));
}

function own(text: string): Finding[] {
  const out: Finding[] = [];
  const push = (rule: string, start: number, end: number) => out.push({ rule, label: labelOf(rule), kind: "secret", start, end });
  for (const m of text.matchAll(PROSE_KEY)) {
    const v = m[1]!;
    if (shannon(v) > GENERIC_ENTROPY && /\d/.test(v)) push("generic-api-key", ...m.indices![1]!);
  }
  for (const m of text.matchAll(PASSWORD)) {
    const g = [1, 2, 3, 4].find((i) => m[i] !== undefined)!;
    if (g < 4 || looksLikePassword(m[4]!)) push("password", ...m.indices![g]!);
  }
  for (const m of text.matchAll(PRIVATE_KEY)) push("private-key", m.index, m.index + m[0].length);
  for (const m of text.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && luhn(digits)) push("card-number", m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(IBAN)) {
    // A greedy match can run into the next word; drop trailing groups until the check passes.
    const parts = m[0].split(" ");
    for (let n = parts.length; n >= 1; n--) {
      const s = parts.slice(0, n).join(" ");
      if (ibanValid(s.replace(/ /g, ""))) {
        push("iban", m.index, m.index + s.length);
        break;
      }
    }
  }
  for (const m of text.matchAll(CN_ID)) if (cnIdValid(m[0])) push("cn-resident-id", m.index, m.index + m[0].length);
  for (const m of text.matchAll(SSN)) push("us-ssn", m.index, m.index + m[0].length);
  return out;
}

// ---- contacts (moved from @standin/intake; intro-sources spec §3) ---------

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g;
const ADDRESS = /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace)\b\.?/g;
// International (+…), North American ((412) 555-0100, 412-555-0100) and Chinese mobile numbers. Dates, version
// strings and paper ids have other shapes, so they are left alone.
const PHONE = /\+\d[\d\s().-]{6,}\d|(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b|\b1[3-9]\d{9}\b/g;

function contacts(text: string): Finding[] {
  const out: Finding[] = [];
  const push = (rule: string, start: number, end: number) => out.push({ rule, label: labelOf(rule), kind: "contact", start, end });
  for (const m of text.matchAll(EMAIL)) push("email", m.index, m.index + m[0].length);
  for (const m of text.matchAll(ADDRESS)) push("street-address", m.index, m.index + m[0].length);
  for (const m of text.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, "").length;
    if (digits < 8 || digits > 15) continue;
    push("phone", m.index, m.index + m[0].length);
  }
  return out;
}

// ---- all together ---------------------------------------------------------

/** Lower wins when two findings overlap: a named provider, then our own secret rules, then generic, then contacts. */
function rank(f: Finding): number {
  if (f.kind === "contact") return 3;
  if (f.rule.startsWith("generic")) return 2;
  return GITLEAKS_RULES.some((r) => r.id === f.rule) ? 0 : 1;
}

/** Every secret and contact detail in `text`, in order, none overlapping. */
export function scan(text: string): Finding[] {
  const all = [...gitleaks(text), ...own(text), ...contacts(text)].sort((a, b) => rank(a) - rank(b) || a.start - b.start || b.end - a.end);
  const kept: Finding[] = [];
  for (const f of all) if (!kept.some((k) => f.start < k.end && k.start < f.end)) kept.push(f);
  return kept.sort((a, b) => a.start - b.start);
}
