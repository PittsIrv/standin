# Introduction Sources Implementation Plan (PR 1)

**Goal:** The introduction accepts pasted text, files (PDF, DOCX, Markdown, text) and the person's website, reads each into quote-checked statements of a known kind, and turns confirmed ones into evidence-typed guesses.

**Spec:** `docs/specs/2026-10-21-intro-sources.md` §1–§6 (decisions 69–73, 75). Anchors (§5a, decision 74) are PR 2.

## Global constraints

- Models see text only (decision 73).
- Nothing from a source is stored before the person confirms; a source is kept (as text, contact details removed) only if a confirmed statement came from it.
- Fetched text is data: wrapped in tags, schema-constrained output, quote-checked.
- Website fetches: https, public addresses only (checked after DNS and on every redirect), same host, 2 MB, 10 s, ≤ 10 pages.
- Commits: Mingxi is the author; every commit ends with the Co-Authored-By trailer.

## Review focus

- A quote the model paraphrased (not in the source) is dropped, and counted.
- A redirect from the person's site to a private address (or another host) is refused.
- A scanned PDF with no text layer gets a clear message, not an empty read.
- An upload over the limit gets 413 from the server, not a crash.
- A statement edited on the confirm screen keeps its quote, and only the edited text is stored.

---

### Task 1: `packages/intake` — sources to text

**Files:** `packages/intake/{package.json,src/index.ts,src/text.ts,src/files.ts,src/web.ts,src/sections.ts,src/align.ts}`, tests in `packages/intake/test/`.

- `stripContacts(text): { text: string; removed: number }` — emails, phone numbers (7+ digits with separators, optional +), street addresses (number + name + street word) → `[removed]`.
- `fileToText(name, bytes): Promise<{ text: string; pages?: number }>` — `.pdf` via `unpdf` (refuse > 30 pages; `NoTextError` when the text layer is empty), `.docx` via `mammoth`, `.md`/`.txt` as UTF-8; anything else `UnsupportedFileError`; > 10 MB `TooLargeError`.
- `fetchPage(url, opts?): Promise<{ url, title, text, links: { url, title }[] }>` — https only; hostname and every resolved address must be public (`isPublicAddress`); manual redirects (≤ 3), each re-checked and same host; 2 MB, 10 s; main text via `@mozilla/readability` on `linkedom`; links: same host, deduped, without fragments, ≤ 50. `opts.fetch` and `opts.lookup` are injectable for tests.
- `sections(text): { heading: string | null; text: string }[]` — split on Markdown headings or title-like lines (≤ 5 words, no final period, Title Case or UPPER CASE, followed by text), then any section over 4,000 characters into chunks with 200 characters of overlap.
- `align(quote, source): "exact" | "fuzzy" | null` — normalize both (case, whitespace, line-break hyphens, typographic quotes and dashes); substring → exact; else the best window of the quote's token length has token overlap ≥ 0.9 → fuzzy.

### Task 2: Extraction and the new seeding

**Files:** `packages/schema/src/records.ts` (FactKind, FactAttrs, EvidenceKind, SourceKind `file`/`website`), `packages/knowledge/src/{intro.ts,prompts.ts,schemas.ts,tasks.ts}`, demo persona.

- `FactKind` = education | occupation | project | publication | skill | language | award | membership | place | characteristic | routine | goal | experience | relationship | preference | other. `FactAttrs` gains `kind`, `kindLabel`, `quote`, `start`, `end`, `current` (all optional).
- `EvidenceKind` gains degree | course | job | project | publication | skill_list | self; `EVIDENCE_STRENGTH` orders them publication > job > project > course > degree > skill_list > self.
- `readSource(map, source: { id, ref, text }, personaName): Promise<{ statements: ReadStatement[]; notFound: number; sensitive: number }>` — one `map` call (purpose `intro`) per section; each statement aligned against its section's text, else against the whole source; contact patterns and sensitive ones dropped; duplicates dropped.
- `saveIntro(store, sources, statements)` — stores each source that has a kept statement as an observation (kind `intro` | `file` | `website`, `sourceRef` its name or URL), each statement an approved fact with `background: true` and its kind, label, quote and dates; skips known facts and sensitive ones; ≤ 40.
- `seedBackground` becomes one `map` call (purpose `seed`) over all unseeded background facts, numbered: `{ concepts: [{ name, definition, examples, depth, reason, partOf: string | null, evidence: [{ fact: number, type: EvidenceKind }] }] }`. A concept with no valid evidence is skipped; its hypothesis kind is its strongest evidence type, its raw score low/medium/high for 1/2/≥ 3 distinct facts. `partOf` names another concept in the answer (placed first) or null for the Knowledge root. Guards as before. Every fact in the batch is marked seeded.
- Demo: `intro` returns each sentence of the section with itself as the quote and a keyword kind; `seed` unions the keyword seeds, citing the facts that matched.

### Task 3: The review page

**Files:** `packages/review/src/{server.ts,routes.ts,page.html}`, `packages/knowledge/src/cards/session.ts`.

- Sources wait in the session (memory only) until confirmed: `CardSession.addSource({ kind, ref, text })`, `sources()`, `removeSource(id)`.
- Routes: `POST /api/intro/text {text}`, `POST /api/intro/file {name, data}` (base64; this route alone accepts 14 MB bodies), `POST /api/intro/site {url}` → `{ source, links }`, `POST /api/intro/pages {urls}` (same host as a site already added, ≤ 10 pages in total), `POST /api/intro/remove {sourceId}`, `POST /api/intro/read {}` → `{ groups: [{ sourceId, ref, statements }], notFound, sensitive, contacts }`, `POST /api/intro/confirm {statements}`, `POST /api/intro/skip`.
- Page: the box plus "Add a file" and "Add your website"; a list of added sources (remove any); site links as checkboxes; "Read them"; confirm screen grouped by source, each statement editable with its kind and a "Source" toggle showing the quote; counts of what was left out.

### Task 4: Docs and browser check

README introduction section; try text + a PDF + a local test page in the browser; phone width.
