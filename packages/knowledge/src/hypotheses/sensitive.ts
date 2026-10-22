/**
 * Categories the standin never guesses about (world-tree spec §6.2). The person may still tell it about them; those
 * facts are stored like any other, under their own disclosure tier. Matching is deterministic: whole words or phrases,
 * case-insensitive, chosen to avoid ordinary knowledge topics ("race condition", "union type", "Great Depression").
 */
export const SENSITIVE_CATEGORIES: Record<string, string[]> = {
  health: [
    "insulin", "hiv", "aids", "diabetes", "diabetic", "chemotherapy", "cancer treatment", "antidepressant", "antidepressants",
    "clinical depression", "mental illness", "mental health condition", "eating disorder", "bipolar", "schizophrenia",
    "adhd medication", "dialysis", "chronic illness", "disability", "pregnancy", "miscarriage", "rehab", "addiction recovery",
  ],
  religion: [
    "torah", "talmud", "bible study", "quran", "koran", "islamic", "muslim", "christian", "catholic", "protestant", "evangelical",
    "jewish", "judaism", "hindu", "hinduism", "buddhist", "buddhism", "sikh", "mormon", "church", "mosque", "synagogue",
    "prayer", "worship", "religious", "religion", "scripture",
  ],
  sexuality: ["lgbtq", "lgbt", "gay", "lesbian", "bisexual", "queer", "homosexual", "sexual orientation", "coming out"],
  "gender identity": ["transgender", "gender identity", "nonbinary", "non-binary", "gender transition"],
  politics: [
    "democratic party", "republican party", "labour party", "conservative party", "political party", "party affiliation",
    "party member", "voting record", "voted for", "political affiliation", "campaign donation",
  ],
  "ethnicity or race": ["ethnic", "ethnicity", "racial", "ancestry"],
  "immigration status": ["asylum", "refugee status", "visa status", "immigration status", "undocumented", "green card", "deportation"],
  finances: ["tax return", "tax returns", "salary", "income", "net worth", "debt", "bank account", "credit score", "mortgage", "loan", "bankruptcy"],
  "criminal history": ["criminal record", "arrest", "arrested", "conviction", "felony", "prison sentence", "incarceration", "expungement"],
  "trade-union membership": ["trade union", "union membership", "union member", "labor union", "labour union"],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERNS = Object.entries(SENSITIVE_CATEGORIES).map(([category, words]) => ({
  category,
  re: new RegExp(`(?<![\\w-])(?:${words.map(escape).join("|")})(?![\\w-])`, "i"),
}));

/** The sensitive category a text touches, or null. */
export function isSensitive(text: string): string | null {
  return PATTERNS.find((p) => p.re.test(text))?.category ?? null;
}
