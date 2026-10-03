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

## Try it (offline, fictional demo persona)

```bash
pnpm install
export STANDIN_HOME=$(mktemp -d)/standin   # keep the demo away from ~/.standin
pnpm standin init --demo                   # creates the instance and loads 10 observations
pnpm standin compact --demo-llm            # observations → proposed memories (scripted model, no network)
pnpm standin queue                         # review queue: contradictions first, then by salience
pnpm standin approve <id> [--tier 1-4]     # or: reject <id>
pnpm standin memories --as-of 2026-09-01   # what was true then, according to what we know now
pnpm standin consolidate                   # expire stale memories, decay confidence, purge raw text
```

On your own data, `standin compact` calls Claude (default `claude-opus-5-5`) through the official SDK. Credentials resolve the SDK's default way (`ANTHROPIC_API_KEY` or `ant auth login`).

## Start with an interview

Interviews are the cleanest source: you decide exactly what goes in. The first question bank (`core-v1`) has about 30 bilingual questions, including what you *don't* know, which is what lets the standin say "I don't know" instead of guessing.

```bash
pnpm standin init --name "Your Name" --languages en,zh
pnpm standin interview template                 # writes $STANDIN_HOME/interviews/core-v1-<date>.md (owner-only)
# answer in your editor, in whatever mix of languages you'd actually use; leave questions blank to skip
pnpm standin interview import <that file>       # one observation per answer; re-importing is idempotent
pnpm standin compact && pnpm standin queue
```

## Choosing models

Each stage picks its own model in `$STANDIN_HOME/config.json`. A bare string is an Anthropic model id:

```jsonc
"compaction": {
  "model": "claude-opus-5-5",            // extraction: long reads, quality-critical
  "reconcileModel": "claude-haiku-4-5-20251001"  // short classification; defaults to `model`
}
```

Any OpenAI-compatible server works too (Ollama, vLLM, LM Studio, llama.cpp, hosted open models). With a local server, your raw data never leaves your machine:

```jsonc
"model": {
  "provider": "openai-compatible",
  "baseURL": "http://localhost:11434/v1",  // Ollama
  "model": "qwen3:8b",
  "apiKeyEnv": "MY_PROVIDER_KEY"           // optional: the env var name, never the key itself
}
```

Every reply is validated against the schema locally, and an invalid reply gets one repair attempt. Failures mark the observation failed (`standin compact --retry-failed`), so the cost of a weaker model is retries, not bad data.

**Batch mode** (Anthropic): `standin compact --batch` sends extraction through the Message Batches API at about half the price, and a later `standin compact --batch` collects the results (or add `--wait`). Reconciliation stays live and in order, so results match live compaction.

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
