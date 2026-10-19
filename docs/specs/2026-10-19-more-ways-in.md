# More ways in: detailed question banks and direct facts

Status: approved in conversation on 2026-10-19 (decisions in §5). The question wording is reviewed with the plan.
Builds on: the interview kit (PR #2) and the [memory-core simplification](2026-10-18-memory-core-simplify.md). Lands as its own PR after the simplification and before SP2a.

## 1. Goal

The interview's 32 questions are a starting point. Some people want to answer much more, or just state facts. Every new channel produces ordinary **observations** that go through the same compaction and review. Whatever the input, the memories that come out have the same atomic, first-person shape, with a kind, entities and a suggested tier.

## 2. Detailed question banks

Five optional banks join `core-v1`. Each one uses the same flow:
1. `standin interview template --bank <id>` writes an answer sheet;
2. `standin interview import <file>` reads it back.

Detail comes from **repeating items**: the sheet asks you to list things (projects, skills, courses), then repeats the same questions for each one.

| Bank id | Per item | Mainly produces |
|---|---|---|
| `projects-v1` | What it is; your role; the stack; the hardest problem and how you solved it; the outcome; what you'd do differently | facts, competence, voice |
| `skills-v1` | For each skill or tool: depth 0–4 (with the scale printed on the sheet); where you used it; what you can't do yet | competence claims with an explicit depth; negatives |
| `education-v1` | Program, school and year; for each course: what it covered and how deep you went | background, competence claims |
| `opinions-v1` | How you like to work; strong opinions in your field; things you disagree with most people about | stances, voice |
| `life-v1` | Hobbies, games, reading, what you're into lately | facts, current-state memories |

**Sheet format:**
- Each repeating group is a block marked `<!-- repeat: projects -->`. To add a project, copy the block.
- The parser numbers the copies (`projects.1.role`, `projects.2.role`, …), so each answer becomes its own observation with `sourceRef interview:<bank>#<question>`.

**Extraction:**
- A skills answer like "Rust: 3" becomes a competence memory with depth 3 as a **claim**.
- "What you can't do yet" becomes a negative memory. SP2a decides whether such negatives also seed gap notes.

## 3. Direct facts

- **`standin tell "<text>"`**, or `standin tell --file F`, adds an observation with `sourceKind: manual`, `authorRole: self` and `sourceRef: tell:<timestamp>`.
- **No shortcut.** Compaction processes it like any other observation, and a paragraph of facts becomes several atomic memories. Nothing skips extraction or review.
- **On the page.** SP2a's review page gets the same thing as a text box.

## 4. Out of scope

- **Model-written follow-up questions** (the `checkin` role asking about gaps in your memories). These were considered and not chosen for now.
- **Gap notes from skills-bank negatives:** decided in SP2a.

## 5. Decisions log

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 1 | Extra inputs | Detailed question banks, and direct facts processed through the normal pipeline | Model-written follow-up questions (for now) |
| 2 | Banks | Projects, skills and depth, education and coursework, work style and opinions, life and interests | A subset |
| 3 | Sequencing | Its own PR after the simplification, before SP2a | Inside the simplification PR; with SP2a |
