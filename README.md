# standin

**A disclosure-aware personal agent that talks to people as you.** It uses your voice and knows what you know. It says "I don't know" when you wouldn't know. And it only shares what you've approved.

standin learns from your private data, but **nothing reaches the public agent unless you approve it**. Disclosure is enforced in code, not requested in a prompt, and it is measured by evals.

> Status: early. Sub-project 1 (the memory core) is in progress. See [`docs/specs/`](docs/specs/) for the architecture.

## How it works

```
PRIVATE (your machine, ~/.standin)                          PUBLIC (edge)
ingest (read-only) → L0 observations → compaction → L1 memories → airlock (you) → public agent
                                                   → L2 profile
```

- **Memories, not chunks.** Atomic, sourced, tiered memories: `fact`, `competence`, `stance`, `negative`.
- **Knows what you don't know.** Competence-gated knowledge and explicit negative memories. Unknowns are answered "not on record" instead of guessed.
- **Default-deny airlock.** Raw data stays local. Only approved memories are published.
- **Bitemporal.** Every memory records when it was true and when it was recorded, so you can ask what the standin knew as of any date.
- **No guessed weights.** The review queue follows plain rules you can read in one sentence, and each memory shows its sources instead of a made-up confidence score. Where a number does change outcomes (duplicate search), it is measured, not guessed.
- **English only, for now.** People talk differently in different languages, so the standin learns one voice at a time.

## Try it (offline, fictional demo persona)

```bash
pnpm install
export STANDIN_HOME=$(mktemp -d)/standin   # keep the demo away from ~/.standin
pnpm standin init --demo                   # creates the instance and loads 10 observations
pnpm standin compact --demo-llm            # observations → proposed memories (scripted model, no network)
pnpm standin queue                         # review queue: contradictions, still true?, updates, new
pnpm standin approve <id> [--tier 1-4]     # or: reject <id>
pnpm standin memories --as-of 2026-09-01   # what was true then, according to what we know now
pnpm standin map refresh --demo-llm        # build the world tree and its first guesses
pnpm standin review --demo-llm             # open the review page: rate concepts, explore and edit the forest
pnpm standin consolidate                   # expire memories whose validity has ended
pnpm standin eval dedup                    # how well duplicate search finds known duplicates (recall@k)
```

On your own data, `standin compact` calls Claude (default `claude-opus-5-5`) through the official SDK. Credentials resolve the SDK's default way (`ANTHROPIC_API_KEY` or `ant auth login`).

## Start with an interview

Interviews are the cleanest source: you decide exactly what goes in. The first question bank (`core-v1`) has about 30 questions, including what you *don't* know, which is what lets the standin say "I don't know" instead of guessing.

```bash
pnpm standin init --name "Your Name"
pnpm standin interview template                 # writes $STANDIN_HOME/interviews/core-v1-<date>.md (owner-only)
# answer in your editor the way you'd actually talk; leave questions blank to skip
pnpm standin interview import <that file>       # one observation per answer; re-importing is idempotent
pnpm standin compact && pnpm standin queue
```

Want to say more? Five detailed banks repeat their questions for each project, skill, course, opinion or interest. Copy a block to add another one; each item becomes one observation.

```bash
pnpm standin interview template --bank projects-v1   # also: skills-v1, education-v1, opinions-v1, life-v1
pnpm standin tell "I ran my first marathon in 2024."  # or --file F; goes through compaction and review like everything else
```

## Reviewing

Everything the standin learns waits for you in one queue, with no weekly cap. Stop whenever you like.

1. **Contradictions:** a new memory conflicts with one you approved.
2. **Still true?:** a "currently…" memory nobody has mentioned for 120 days. `standin keep <id>` renews it; `standin expire <id>` retires it. Nothing expires silently.
3. **Updates:** a newer version of something you approved.
4. **New** memories.

Within each group, memories with more sources come first, then older ones. Sources from another AI's memory of you are marked *unverified*. Every decision is logged with where the item sat in the queue, so a smarter ordering can later be tested against this one.

Raw observation text and trace text stay on your machine until you purge them: `standin purge --before <date>`.

## Your world tree

Everything the standin knows about you lives in one tree with six fixed roots: **Knowledge, Work, Background, People, Views, Life**. Nodes grow only where you've said something. `standin map` prints it:

```
Knowledge
  Computer science  probable 2 (p 0.50, background)
    Algorithms  probable 2 (p 0.50, background)
    Machine learning  probable 2 (p 0.50, background)
      reinforcement learning theory  lit 2 (claimed)
  Game AI  probable 2 (p 0.50, part)
    chess engines  dark (you said so)
    game-playing AI  lit 3 (claimed)
Work
  Projects  0 facts
    Kite  1 fact
Life
  Places  0 facts
    Japan  1 fact
```

- **Every memory has a home node.** Compaction files it at the most specific node it's about; `standin map refresh` places new nodes under the right root, homes anything left over, and splits a crowded node when parts get their own identity (two cats, then Miso and Tofu).
- **Lit means known.** Your claims and your concept-card answers light a Knowledge node at your level (0–4) and the branch below it. A non-Knowledge node is lit when it holds approved facts.
- **Probable means guessed, with evidence.** Your background seeds its field's core at level 2, and the `hypothesize` model proposes guesses ("PPO at 4, so RL at 3"), each with an evidence path at most two steps from something you said. Guesses never build on guesses, never touch health, religion, politics or other sensitive topics, and never go where you said you don't know.
- **It learns which guesses to trust.** Each confirmed or refuted guess updates a reliability count for its kind of evidence; that count turns the model's confidence into a probability. If learning ever predicts your answers worse than not learning, it switches itself off.
- **Depth decides the answer:** 3–4 explain, 2 brief, 0–1 or dark decline. A probable node is spoken only at p ≥ 0.8, and never beyond brief.

```bash
pnpm standin map refresh   # place nodes, home memories, seed from your background, guess (calls the map and hypothesize models)
pnpm standin map           # see the forest (no model calls); --all shows frontier nodes, --private adds learning scores
pnpm standin review        # the review page: rate concepts, then look at and edit the forest
```

## Concept cards and the review page

`standin review` opens a private page on your machine (`--lan` adds a QR code for your phone). There are no quizzes: you tell the standin how well you know each concept, one click per card.

- **A card is a concept** with its definition and its place in the tree. Answer **Expert / Know well / Used it / Heard of it / No** (keys `4`–`0`), or **Wouldn't say** (`w`), which puts a boundary on it.
- **Your answer lights its whole branch.** Expert and No settle it. A middle answer opens the concept's parts, but only parts up to one level above your answer: "Heard of it" on RL asks about rewards and policies, never async RL. "Skip the rest" (`s`) stops there.
- **What comes first:** the standin's guesses (the ones it's least sure of), then the parts your answers opened, then areas you haven't talked about. Your claims are never asked again. If you rate parts of a claim lower than the claim, you choose to **keep** it or **lower** it.
- **Splits are made once, on demand,** by the `map` model: 3–7 non-overlapping parts, each with a definition and a level, checked in code. Your edits in the forest always win.
- **Predict, then learn.** Before each card the standin records what it expected you to say. `standin map` reports how often that matched; each answer then teaches the guesses.

The **Forest** tab draws the whole tree: lit nodes glow brighter the deeper they go, guesses are dashed and filled by their probability, dark ones are gray. Click a node for its facts, its guess and evidence, and what you've said about it; rename, move, add a child, delete, unlink, or refile a fact from there, or drag a node onto another to move it.

## Choosing models: roles and tiers

Every model call belongs to a **role**, and each role defaults to a **tier**. The cheapest thing that does the job well wins: code first, then a cache, then small, medium, and large models.

| Role | Tier | Zone | Job |
|---|---|---|---|
| `extract` | large | private | Extract memories from an observation (quality-critical) |
| `reconcile` | small | private | Classify a candidate against similar memories |
| `screen` | medium | private | Flag possibly sensitive memories for review (the safety net, so not the cheapest tier) |
| `answer` | small | public | Answer a visitor (the $20/month public agent) |
| `checkin`, `attack` | medium | private | Check-in questions, break-me attempts |
| `style`, `judge` | large | private | Style-card rewrites, eval grading |
| `map`, `hypothesize` | large | private | Organize the world tree and split concepts; guess what you probably know, with evidence |

`$STANDIN_HOME/config.json` maps tiers to models and can override any role. A bare string is an Anthropic model id:

```jsonc
"models": {
  "tiers": { "small": "claude-haiku-4-5-20251001", "medium": "claude-sonnet-5-5", "large": "claude-opus-5-5" },
  "roles": {
    "reconcile": {                             // any OpenAI-compatible server: Ollama, vLLM, LM Studio, hosted open models
      "provider": "openai-compatible",
      "baseURL": "http://localhost:11434/v1",
      "model": "qwen3:8b",
      "apiKeyEnv": "MY_PROVIDER_KEY"           // optional: the env var's name, never the key itself
    }
  },
  "prices": { "qwen3:8b": { "inputPerMTok": 0, "outputPerMTok": 0 } }   // USD per million tokens
}
```

Public-zone roles run on Cloudflare and can't reach your machine, so config validation rejects a local model for `answer` and tells you which setting to change. Every reply is validated against its schema locally and gets one repair attempt. A weaker model costs retries, not bad data.

**Batch mode** (Anthropic): `standin compact --batch` sends extraction through the Message Batches API at half the price. A later `standin compact --batch` collects the results (or add `--wait`). Reconciliation stays live and in order, so results match live compaction.

## Observability

Every run (a compaction, an import) is recorded as a trace: a tree of steps shaped like OpenTelemetry spans, with model calls following the GenAI semantic conventions (`gen_ai.usage.input_tokens`, `gen_ai.response.model`, …) plus the role, tier, cost, and outcome.

```bash
pnpm standin traces                  # recent runs: duration, model calls, cost
pnpm standin trace --last            # one run as a tree; --content shows prompts and outputs
pnpm standin usage --by role         # calls, tokens, and cost per role (or --by model)
```

Prices come from Anthropic's pricing page and can be overridden under `models.prices`. A call with no known price is reported as unpriced, never as $0.

To view traces in Jaeger, Arize Phoenix, or Langfuse, point standin at their OTLP/HTTP endpoint:

```jsonc
"tracing": { "otlp": { "endpoint": "http://localhost:4318/v1/traces", "headersEnv": "OTLP_HEADERS", "exportContent": false } }
```

Prompts and outputs are stored apart from the trace structure. Locally they are kept, like raw observation text, until you run `standin purge --before <date>` (or set `consolidation.purgeAfterDays`). They leave your machine only if you set `exportContent: true`.

## Your data stays out of this repo

Instance data lives in `$STANDIN_HOME` (default `~/.standin`). A pre-commit hook and CI guard (`pnpm guard`) refuse to commit SQLite stores or observation dumps.

## Development

Requires Node ≥ 22.13 (for `node:sqlite`) and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test
```

## License

Apache-2.0
