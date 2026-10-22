/** One allowlist from gitleaks: a match is not a secret if any regex hits its target, or the secret holds a stopword. */
export interface PortedAllowlist {
  target: "secret" | "match" | "line";
  regexes: string[];
  stopwords: string[];
}

/** One gitleaks rule, its regex already converted to JavaScript (scripts/port-gitleaks.mjs). */
export interface PortedRule {
  id: string;
  regex: string;
  keywords: string[];
  entropy?: number;
  secretGroup?: number;
  allowlists?: PortedAllowlist[];
}
