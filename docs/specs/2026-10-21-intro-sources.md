# Introduction Sources

**Status:** design approved in conversation (decisions 69–75).

**Extends** concept-cards §6a (the introduction). The introduction can now be built from text, a résumé or other file, or the person's own website. Each is parsed carefully into statements the person confirms, and those become the first guesses.

## 1. Why, and what "carefully" means

A pasted paragraph and a three-page résumé fail differently. A model reading a long document can invent a degree, merge two jobs, pick up a co-author's work, or follow instructions hidden in a web page. So:

- **Every statement is proved.** It carries a verbatim quote from its source, and code finds that quote in the text. A statement that can't be found never reaches the person.
- **The person is the gate.** Nothing counts until they confirm it, as in §6a.
- **The source is data.** Text from a file or page is never treated as instructions. Output is schema-constrained and quote-checked.
- **Text only.** Every model call gets text. Files and pages are turned into text by code; no model ever sees an image, a PDF or HTML.
- **Only the person.** Statements are about the person who owns the instance, never about co-authors, colleagues or anyone else named in the source.

## 2. Related work

There is no standard system for this; the design borrows these patterns.

- **Skill extraction and linking** (Clavié & Soulié 2023, zero-shot ESCO matching; JOBSKAPE 2024): extract the mention, retrieve candidate concepts, then choose. Used in §5 to link concepts to existing nodes.
- **Grounded extraction** (LangExtract and its ports): the model extracts, and a separate alignment step maps each extraction to source offsets, with a match status. Used in §4.
- **Expert finding** (Balog et al. 2006): combining evidence from many documents into one expertise estimate. Used in §5.
- **Competence-based knowledge space theory**: prerequisite structures let one confirmed skill imply others. This already underlies `requires` edges and guesses.
- **Personal knowledge graphs** (Balog & Kenter 2019; Skjæveland et al. 2023): structured facts about the entities that matter to one person, owned by them. That is the world tree.
- **Kinds of personal fact**: schema.org `Person` relations (alumniOf, hasOccupation with dates, worksFor, homeLocation, knowsLanguage, memberOf, award), and PeaCoK's persona dimensions (Gao et al., ACL 2023). Used in §4a.
- **Taxonomies**: OpenAlex topics (CC0: domain → field → subfield → topic, about 4,500 topics) and ESCO skills. Used in §5a.

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
{ statement, quote, kind, kindLabel, start, end, current }
```

- **statement**: short, first person, one fact ("I worked on motion planning at X from 2022 to 2024").
- **quote**: the source text it rests on, copied exactly.
- **kind** (§4a) and **dates** feed §5.

**The alignment check, in code.** Both quote and source are normalized: case, whitespace, hyphenation at line breaks, and typographic quotes and dashes. The quote must then appear as a substring (exact). Failing that, it may match a source window by token overlap of at least **0.9** (fuzzy). Anything else is **dropped**. The same filters as §6a still apply: no duplicates, no sensitive categories, no contact details. At most 40 statements across all sources.

## 4a. Kinds of fact: a rubric, not a cage

Every statement gets a **kind** from a fixed list, a rubric drawn from schema.org `Person` and PeaCoK:

| Kind | For | From |
|---|---|---|
| `education` | degrees, schools, courses | alumniOf |
| `occupation` | roles and jobs, with dates | hasOccupation, worksFor |
| `project` | things built or led | creator |
| `publication` | papers, talks, articles | creator |
| `skill` | named skills and tools | knowsAbout |
| `language` | languages spoken | knowsLanguage |
| `award` | awards and honors | award |
| `membership` | clubs, labs, communities | memberOf |
| `place` | where they live or have lived (city or country only) | homeLocation |
| `characteristic` | traits they state about themselves | PeaCoK |
| `routine` | habits and regular activities | PeaCoK |
| `goal` | plans and aims | PeaCoK |
| `experience` | things that happened to them | PeaCoK |
| `relationship` | people and pets, by role ("my advisor", "my two cats") | PeaCoK |
| `preference` | likes, dislikes, interests | |

When nothing fits, the model sets `kind: "other"` and names one in `kindLabel` ("volunteers at"). Those labels are counted, so the list can grow from what people actually say. The kind is stored on the fact, and placement uses it as a guide (education → Background, routine → Life, relationship → People). The person's own nodes stay theirs: the kind describes a fact, not the thing it's about.

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
- **Linking first.** Each concept is matched against existing nodes, then against anchors (§5a), before a new node is created.
- The guards from §6a still apply: nothing the person already spoke to is guessed, nothing sensitive, nothing that would loop.

## 5a. Anchors: OpenAlex for knowledge, ESCO for skills

> **Superseded** by `2026-10-22-anchors.md` (decision 79): only the OpenAlex fields and subfields are used, as a frame; ESCO is dropped.

A Knowledge concept is linked to a standard concept when one fits, so names, definitions and "Includes" come from a curated source instead of being invented.

- **Data, local.** The OpenAlex hierarchy (domains, fields, subfields, topics, with descriptions and keywords) ships as a data file in the repo; it is CC0. ESCO skills are downloaded into the instance on first use by `standin anchors fetch`, so they are never committed until their licence is confirmed. No lookup ever leaves the machine.
- **Extract → candidates → choose.** Code finds the closest anchors by name, alias and keywords (lexical scoring). The model chooses one of the top 10, or "none". "None" is a normal answer: a concept without an anchor keeps its own name and its place from the model.
- **Placement.** An anchored concept goes under its OpenAlex subfield, and that under its field. Ancestors are created only when something is placed under them, so there are still no nodes for unexplored areas.
- **What an anchor gives.** Its standard name becomes an alias, its description the definition, and its keywords the examples. All of these apply only where the node has none, and the person's edits always win.
- **Splits.** Above a topic, the structure comes from OpenAlex. Below it, the model splits as in concept-cards §6.
- **Later:** linking public things in other roots (places at city or country level, organizations, works, games, species) to Wikidata. People and pets are never linked anywhere.

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
| 73 | Text only | Code turns files and pages into text; models only ever see text | Multimodal models reading PDFs or pages |
| 74 | Anchors | OpenAlex topics as the main Knowledge taxonomy, ESCO for skills, linked by extract → candidates → choose, with "none" allowed | Model-invented structure only; Wikidata for everything |
| 75 | Personal facts | A fixed list of fact kinds (schema.org Person + PeaCoK) as a rubric, with model-named kinds when none fits; our own nodes stay | Wikidata classes for every node; free-form facts |

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
- ACM CCS and Wikidata anchors.
- Reading GitHub repositories (`standin observe` covers GitHub).
