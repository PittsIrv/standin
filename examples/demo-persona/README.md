# Demo persona: Lin Qiao (乔林)

A **fictional** bilingual graduate student who builds board-game AIs. Use it to try standin end to end without connecting any real data. CI also runs it on every push.

`observations.jsonl` holds ten observations that exercise every compaction path:

| Path | Observation |
|---|---|
| Exposure ≠ knowledge | A lab Slack announcement the persona only saw (`authorRole: exposed`), which is skipped |
| Duplicate → corroboration | The website repeating "I build AIs for board games" |
| Update (current state) | A check-in replacing "working on the Lantern trainer" with "working on Kite" |
| Contradiction | An interview ("Rust, not Python") contradicting a ChatGPT-memory claim ("prefers Python") |
| Negative knowledge | "I've never been to Japan", "I don't know much about chess engines" |
| Competence | Strong at game-playing AI; only working knowledge of RL theory (in Chinese) |
| Sensitive (tier 3) | Salary questions go to email (in Chinese) |

`src/fixtures.ts` contains hand-written model outputs, so `standin compact --demo-llm` runs offline.
