# Introduction and Concrete Parts Implementation Plan

**Goal:** Cards say concretely what they ask about, and a session starts from the person's own introduction.

**Spec:** `docs/specs/2026-10-21-concept-cards.md` §2, §6, §6a; decisions 65–68.

**Architecture:** Examples are a column on `topics`, filled by splits and seeding and editable in the forest. The introduction is two `map` calls: one reads the text into statements, which the person confirms; then the existing seeding turns the confirmed background facts into guesses, now with a depth and reason per concept.

## Global constraints

- Sensitive categories are never read out of an introduction or guessed (`isSensitive`).
- Nothing from the introduction is stored before the person confirms it.
- Commits: Mingxi is the author; every commit ends with the Co-Authored-By trailer.

## Review focus

- An introduction with only non-knowledge statements ("I have two cats") seeds nothing and still starts the cards.
- Edited statements are what get stored, not the model's originals.
- A statement emptied in the confirm screen is dropped, not stored blank.
- Old nodes without examples still show "Includes" from their parts, and nothing at all when they have none.
- A guess the person already spoke to is not re-created by seeding.

---

### Task 1: Concrete parts

**Files:** `packages/schema/src/records.ts`, `packages/store/src/{migrations,tree}.ts`, `packages/knowledge/src/probing/{expand,prompts,schemas}.ts`, `packages/knowledge/src/cards/session.ts`, `packages/knowledge/src/node-detail.ts`, `packages/review/src/{routes.ts,page.html}`, `examples/demo-persona/src/{index,fixtures}.ts`

- `Topic.examples: string[]` (default `[]`), migration 10 adds `topics.examples TEXT NOT NULL DEFAULT '[]'`; `setTopic` takes `examples`.
- `checkSplit` refuses level and bucket words in names (word boundary: advanced, basic(s), fundamental(s), foundation(s), introduction, introductory, intro, elementary, intermediate, beginner(s), other, misc, miscellaneous, general) and fewer than 3 distinct examples (case-insensitive, not equal to the part's name); keeps the first 5.
- `ExpandSchema` components gain `examples: string[]`; the prompt asks for them and for content names.
- `ShownCard.examples`: stored examples, else up to 5 live part names (by name). `ShownCard.why`: the guess's reason, else null.
- Node detail returns `examples`; `POST /api/tree/describe {nodeId, definition, examples}` edits both (person's edit wins; roots refused).
- Page: "Includes: …" on the card, the guess's reason under it; definition and examples editable in the side panel.
- Demo: hand-written splits for the demo's concepts; the generic fallback uses content names.
- Tests: `checkSplit` name and example rules; `expandNode` stores examples; card examples fallback to parts; describe route.

### Task 2: The introduction

**Files:** `packages/schema/src/records.ts` (SourceKind `intro`), `packages/knowledge/src/{intro.ts,prompts.ts,schemas.ts,tasks.ts,cards/plan.ts,cards/session.ts}`, `packages/review/src/{cards.ts,routes.ts,page.html}`, demo persona.

- `readIntro(map, text, personaName): Promise<string[]>` — `map` purpose `intro`, `IntroSchema = { statements: string[] }`; trims, drops empties, sensitive ones and duplicates, keeps 12.
- `saveIntro(store, text, statements): Memory[]` — one observation (`sourceKind: "intro"`, author self), each statement an approved fact with `background: true`, tier 1.
- `needsIntro(store)`: no approved background fact, no seeded topic, and `kv("intro.skipped")` unset.
- `SeedSchema`: `field` nullable; field and core items gain `depth` (1–4, clamped; default 2), `reason`, `examples`; seed gains `evidence: "background" | "work"`. Seeding uses them; a node the person already spoke to gets no guess.
- New areas: seeded first, then by name.
- `CardSession.introduce(text, statements)` saves, then refreshes (seed → … → hypothesize); `skipIntro()` sets the kv.
- Review: `Card` gains `{ type: "intro" }`, first when `needsIntro`; routes `POST /api/intro/read {text}` → `{statements}`, `POST /api/intro/confirm {text, statements}`, `POST /api/intro/skip`. Page: the box, the confirm list (edit, remove), "Looks right", "Skip for now", and "Add to your introduction" on the Session tab.
- Demo: `intro` splits sentences; `seed` by keyword (degree → CS, games → Game AI, otherwise no field).
- Tests: read filters sensitive and empties; save stores edited statements only; needsIntro; seeding depth/reason/evidence and null field; area order; session intro flow end to end with the demo LLM.

### Task 3: Docs and browser check

README sections for the introduction and "Includes"; try the fresh-instance path in the browser (intro → confirm → guesses → parts with examples), phone width and dark mode.
