# Introduction Sources

**Status:** design, decisions 69–72 approved in conversation; the rest awaits review.

**Extends** concept-cards §6a (the introduction). The introduction can now be built from text, a résumé or other file, or the person's own website. Each is parsed carefully into statements the person confirms, and those become the first guesses.

## 1. Why, and what "carefully" means

A pasted paragraph and a three-page résumé fail differently. A model reading a long document can invent a degree, merge two jobs, pick up a co-author's work, or follow instructions hidden in a web page. So:

- **Every statement is proved.** It carries a verbatim quote from its source, and code finds that quote in the text. A statement that can't be found never reaches the person.
- **The person is the gate.** Nothing counts until they confirm it, as in §6a.
- **The source is data.** Text from a file or page is never treated as instructions. Output is schema-constrained and quote-checked.
- **Only the person.** Statements are about the person who owns the instance, never about co-authors, colleagues or anyone else named in the source.

## 2. Related work

There is no standard system for this; the design borrows four patterns.

- **Skill extraction and linking** (Clavié & Soulié 2023, zero-shot ESCO matching; JOBSKAPE 2024): extract the mention, retrieve candidate concepts, then choose. Used in §5 to link concepts to existing nodes.
- **Grounded extraction** (LangExtract and its ports): the model extracts, and a separate alignment step maps each extraction to source offsets, with a match status. Used in §4.
- **Expert finding** (Balog et al. 2006): combining evidence from many documents into one expertise estimate. Used in §5.
- **Competence-based knowledge space theory**: prerequisite structures let one confirmed skill imply others. This already underlies `requires` edges and guesses.

## 3. Sources and intake (code only)

| Source | How it becomes text | Limits |
|---|---|---|
| Pasted text | as is | 20,000 characters |
| File: PDF, DOCX, Markdown, plain text | PDF text layer (`unpdf`); DOCX (`mammoth`); others as is | 10 MB, 30 pages. A PDF with no text layer is refused ("paste the text instead"); no OCR yet |
| Website | fetch the page, keep its main text (`@mozilla/readability` on `linkedom`), list its same-site links; the person ticks which to read too | https only; public hosts only (never private or loopback addresses); same host as the first page; 2 MB and 10 s per page; at most 10 pages; no cookies or login |

- Each source becomes one **observation** (`sourceKind`: `intro`, `file` or `website`, with the file name or URL as `sourceRef`).
- **Kept:** the extracted text, so quotes stay checkable and it can be re-read with a better model later. **Not kept:** the original file or HTML (decision 72).
- **Contact details are removed from the text** before it is stored or sent to a model: email addresses, phone numbers, and street addresses (best effort).
- The text is **split into sections**: by headings (Markdown headings, HTML h1–h3, or short title-like lines such as "Education" or "EXPERIENCE"), else into chunks of about 4,000 characters with a small overlap. Each section is read separately, so nothing is lost in a long document and every quote stays local.

## 4. Extraction with proof

One `map` call per section (purpose `intro`) returns statements:

```
{ statement, quote, type: education | role | project | publication | skill | other, start, end, current }
```

- **statement**: short, first person, one fact ("I worked on motion planning at X from 2022 to 2024").
- **quote**: the source text it rests on, copied exactly.
- **type** and **dates** feed §5.

**The alignment check, in code.** Both quote and source are normalized: case, whitespace, hyphenation at line breaks, and typographic quotes and dashes. The quote must then appear as a substring (exact). Failing that, it may match a source window by token overlap of at least **0.9** (fuzzy). Anything else is **dropped**. The same filters as §6a still apply: no duplicates, no sensitive categories, no contact details. At most 40 statements across all sources.

## 5. From evidence to guesses

- **One call per confirmation** (purpose `seed`), over all newly confirmed statements together, so evidence from the résumé and the website about the same concept is combined.
- It returns concepts. Each has a definition, 3–5 examples, a **depth 1–4 chosen by the model**, a reason, and its **evidence**: the statements it rests on, each tagged with an evidence type (decision 71). The model weighs strength and recency (current daily work or research, against a course years ago).
- **Evidence types** become hypothesis evidence kinds, so reliability counts learn which kinds the model over-trusts:
  - `degree`: a degree's required core;
  - `course`;
  - `job`: a job duty;
  - `project`;
  - `publication`;
  - `skill_list`: listed under "Skills" with nothing else behind it;
  - `self`: said about themselves in free text.

  A guess's kind is its strongest evidence: publication > job > project > course > degree > skill_list > self. Several independent pieces raise its raw score: one is low, two are medium, three or more are high.
- **Linking first.** Each concept is matched against existing nodes, by name and alias, then by the model choosing among the closest candidates, before a new node is created. This is the extract → candidates → choose pattern from §2.
- The guards from §6a still apply: nothing the person already spoke to is guessed, nothing sensitive, nothing that would loop.

## 6. The confirm screen

- Statements are grouped by source (the box, résumé.pdf, example.org/about, …).
- Each shows its quote on demand, and can be edited or removed. An edited statement keeps its quote as evidence; the person's wording is what gets stored.
- Counts of what was left out are shown, never the content: "4 statements couldn't be found in the source", "1 was about a sensitive subject", "contact details removed".
- "Looks right" stores the confirmed statements as approved background facts, each linked to its source observation and quote, and then seeds.

## 7. Decisions log

Continues from concept-cards decision 68.

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 69 | Proof | Every statement carries a verbatim quote; code finds it in the source or drops the statement | Quotes shown but not enforced; the model's reading only |
| 70 | Websites | The page given, then same-site pages the person ticks | Only the exact page; crawling up to 10 pages |
| 71 | Depth from evidence | The model picks depth 1–4, citing typed evidence; evidence types become hypothesis kinds so calibration learns per type | A fixed rule table; rules plus a ±1 model adjustment |
| 72 | What is kept | The extracted text, with contact details removed; never the original file | Text and file; only the confirmed statements |

## 8. Proposed numbers (starting values, tuned by experiment)

| Number | Value |
|---|---|
| Fuzzy quote match | token overlap ≥ 0.9 |
| Pasted text | ≤ 20,000 characters |
| File | ≤ 10 MB, ≤ 30 pages |
| Web page | ≤ 2 MB, 10 s, ≤ 10 pages, same host |
| Section chunk | ~4,000 characters |
| Statements per introduction | ≤ 40 |
| Raw score from evidence count | 1 → low, 2 → medium, ≥ 3 → high |

## 9. Not now

- OCR for scanned PDFs.
- LinkedIn and other sites behind a login.
- Anchoring to ESCO or ACM CCS (its own sub-project).
- Reading GitHub repositories (`standin observe` covers GitHub).
