# WT-1: The World Tree. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution: Claude implements inline (the user's standing choice: no Codex, no subagents).

**Goal:** Every entity becomes a node in one tree under six fixed roots. Every memory gets a home node. Approved memories without a home, and nodes without a place, are placed automatically. Crowded nodes split, expansion children stay hidden on the frontier, and `standin map` shows the forest.

**Architecture:**
- **Schema and migration 7** turn every entity into a node:
  - each entity gets a `topics` row;
  - the six root nodes are created;
  - edges with more than one home parent become `related`;
  - memories get a home node.
- **The store** gains:
  - root lookup;
  - `ensureNode` with a label;
  - the single-home rule;
  - memory homes;
  - frontier;
  - rename, move, delete-edge and delete-node.
- **`@standin/knowledge`** places nodes across all roots, homes memories, and splits crowded nodes. Lighting and probing stay inside Knowledge.
- **The CLI's `map`** renders the forest.

**Tech Stack:** Node 24, TypeScript (strict), zod v4, vitest, `node:sqlite`.

**Spec:** `docs/specs/2026-10-21-world-tree.md` §3, §8, §9, §10 (WT-1), decisions 41–45 and 55.

## Global Constraints

- **Roots**, keyed and named exactly, in this display order:
  - `knowledge` "Knowledge"
  - `work` "Work"
  - `background` "Background"
  - `people` "People"
  - `views` "Views"
  - `life` "Life"
- **Labels:** `EntityKind` = `project | org | place | person | work | topic | pet | other`. Root nodes have label `other`.
- **Default root by label** (migration and fallbacks):
  - `topic` → `knowledge`
  - `project | org | work` → `work`
  - `person` → `people`
  - `place | pet | other` → `life`
- **Home rule:** a non-root node has at most one live `part_of` edge, which is its home parent. A root has none.
- **`related` edges:**
  - undirected, stored with `from < to` (string order);
  - no cycle check;
  - never carry lighting or boundaries.
- **Lighting and probing** only consider nodes whose root is `knowledge`. A node with no home parent yet counts as `knowledge` if its label is `topic`.
- **Frontier:** nodes created by expansion are `frontier = true`. They are hidden from the tree view unless `--all`, and cleared when a memory links to the node, a probe is written for it, or the person edits it.
- **`SPLIT_AT` = 12,** as config `tree.splitAt`.
- **Deleted nodes and edges** are never re-added (unchanged).
- **Commits:** the author is the repo's git user. Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Upgrading an existing instance** must keep every memory, edge, gap and probe, and give each memory with links a home. Task 2's migration test runs on a database built at migration 6.
2. **A node that already has a home** must never get a second `part_of` from placement or seeding. It is ignored, not an error. Task 3.
3. **Deleting a node that holds memories** moves their home to its parent, or to none for a top-level node. No memory is left pointing at a deleted node. Task 3.
4. **A split that names memory ids not in the node,** or a child equal to the node itself, is ignored safely. Task 6.
5. **Non-Knowledge nodes** (a pet, a person) are never probed, expanded or lit by competence rules. Task 5.

---

### Task 1: Schema

**Files:**
- Modify: `packages/schema/src/records.ts`, `packages/schema/src/config.ts`
- Test: `packages/schema/test/records.test.ts` (or the existing schema test file)

**Interfaces:**
- Produces:
  - `RootKey = z.enum(["knowledge","work","background","people","views","life"])`
  - `ROOTS: { key: RootKey; name: string }[]` (the order above)
  - `defaultRoot(label: EntityKind): RootKey`
  - `EntityKind` gains `pet`, `other`. `EdgeKind` gains `related`.
  - `Topic` gains `label: EntityKind`, `rootKey: RootKey | null` (non-null only on root nodes), `frontier: boolean`.
  - `Memory` gains `homeNodeId: string | null`.
  - Config `tree: { splitAt: number }`, default 12.
- [ ] Failing tests:
  - `defaultRoot` maps every label as in Global Constraints;
  - `ROOTS` names and order;
  - config default `tree.splitAt === 12`.
- [ ] Implement. Run `pnpm vitest run packages/schema`. PASS.
- [ ] Commit: `Schema: roots, labels, related edges, memory homes`

### Task 2: Migration 7

**Files:**
- Modify: `packages/store/src/migrations.ts` (migrations may now be `string | ((db: DatabaseSync) => void)`), `packages/store/src/memories.ts` (row mapping of `home_node_id`), `packages/store/src/tree.ts` (row mapping of `label`, `root_key`, `frontier`)
- Test: `packages/store/test/migration-7.test.ts`

**Interfaces:**
- Produces, in migration 7:
  - **Columns:** `topics.root_key TEXT` (with a unique index where it is not null), `topics.frontier INTEGER NOT NULL DEFAULT 0`, `memories.home_node_id TEXT REFERENCES entities(id)`.
  - **Steps, in order:**
    1. Insert a `topics` row for every entity without one.
    2. Create the six root entities (kind `other`) and their `topics` rows with `root_key`.
    3. For each `from_topic` with more than one live `part_of`:
       - keep the oldest (by `created_at`, then `id`);
       - turn the others into `related`, normalized `from < to`;
       - drop any that would duplicate an existing edge.
    4. Every parentless non-root node *that has parts* gets `part_of` → `defaultRoot(label)`. Loose nodes, with no parent and no parts, stay unplaced for refresh.
    5. `home_node_id` for each memory = its linked node with the greatest tree depth. Ties go to the earliest linked. No links means null.
- [ ] **Failing test.** `migrate(db, 6)` on a temp database, then insert raw rows:
  - a topic tree A → B;
  - a second parent edge A → C;
  - a project entity;
  - a memory linked to A and B;
  - a memory with no links.

  Then `migrate(db)` and assert:
  - six roots exist with their keys;
  - every entity has a node;
  - A has exactly one `part_of` (to B, the oldest) and a `related` edge with C;
  - B → Knowledge root;
  - the project has no parent;
  - memory 1's home is A (deeper);
  - memory 2's home is null.
- [ ] Implement, and run `pnpm vitest run packages/store`. The whole store suite stays green.
- [ ] Commit: `Migration 7: every entity is a node, six roots, memory homes`

### Task 3: Store: nodes, homes and edits

**Files:**
- Modify: `packages/store/src/tree.ts`, `packages/store/src/memories.ts`, `packages/store/src/store.ts`, `packages/store/src/errors.ts`, `packages/store/src/index.ts`
- Test: `packages/store/test/tree.test.ts`

**Interfaces:**
- Produces, as `Store` methods:
  - `roots(): Topic[]` (in `ROOTS` order) and `root(key: RootKey): Topic`.
  - `ensureNode(name: string, label: EntityKind, definition?: string | null): Topic`. `ensureTopic(name, def)` becomes `ensureNode(name, "topic", def)`.
  - `homeParent(id: string): string | null`, and `rootOf(id: string): RootKey | null` (walks home parents; a root returns its own key).
  - `addEdge` changes:
    - for `part_of`, it returns `null` when `from` already has a live home or is a root;
    - for `related`, it normalizes `from < to` and skips the cycle check.
  - `setHome(memoryId: string, nodeId: string | null): Memory`, and `nodeMemories(nodeId: string, filter?: { status?: MemoryStatus }): Memory[]` (memories whose *home* is the node).
  - `insertMemory`'s `InsertContext` gains `homeNodeId?: string | null`, default null.
  - `setTopic` patch gains `frontier?: boolean`. `linkMemory` and the probe insert clear `frontier` on the nodes they touch.
  - Edits (from the old review-page plan, Task 1):
    - `renameTopic(id, name): Topic` (old name to aliases; `NameTakenError` if another node of the same label matches; renaming a root throws `CliError`-free `InvalidTransitionError("root")`);
    - `moveTopic(id, parentId | null): TopicEdge | null` (soft-deletes the old home, adds `source: "person"`, all in one transaction; `CycleError` leaves it unchanged; roots cannot move);
    - `deleteEdge(edgeId)`;
    - `deleteTopic(id)`. This moves its home memories to its home parent, or null. Roots cannot be deleted.
  - Edits clear `frontier`.
  - `mergeTopics` also moves `home_node_id`.
- [ ] **Failing tests** in `tree.test.ts`, `describe("world tree")`:
  - roots exist in order;
  - `ensureNode("Miso","pet")` differs from `ensureNode("Miso","topic")`;
  - a second `part_of` returns null and the first stays;
  - `related` is normalized and its duplicate returns null;
  - `rootOf` walks to the root, and an unplaced node gives null;
  - homes: insert with `homeNodeId`, then `nodeMemories`;
  - `deleteTopic` moves home memories to the parent;
  - merge moves homes;
  - rename, move, cycle refusal, `deleteEdge` and `NameTakenError`, as in the old plan;
  - a root cannot be renamed, moved or deleted;
  - frontier is cleared by a memory link and by `insertProbe`.
- [ ] Implement, and run `pnpm vitest run packages/store`. PASS.
- [ ] Commit: `Store: nodes under roots, single home, memory homes, tree edits`

### Task 4: Compaction sets homes

**Files:**
- Modify: `packages/compaction/src/compact.ts`
- Test: `packages/compaction/test/compact.test.ts` (the existing file)

**Interfaces:**
- Consumes: `ensureNode`, `rootOf`, `insertMemory` with `homeNodeId`.
- Produces:
  - Entities resolve through `ensureNode(name, kind)`. A competence domain resolves through `ensureNode(domain, "topic")`.
  - A new memory's `homeNodeId` is the deepest of its linked nodes, by home-chain length, ties to the first listed. A competence memory's home is its domain node.
- [ ] **Failing test:** compacting the demo "Kite" observation gives a memory whose home is the deepest of its nodes, and a competence memory homed at its domain node.
- [ ] Implement, and run `pnpm vitest run packages/compaction`. PASS.
- [ ] Commit: `Compaction gives each memory a home node`

### Task 5: Knowledge stays in Knowledge; placement across roots

**Files:**
- Modify:
  - `packages/knowledge/src/snapshot.ts` (adds `rootOf: Map<string, RootKey | null>`, and filters `topics` to knowledge nodes for lighting via `knowledgeIds: Set<string>`);
  - `packages/knowledge/src/lighting.ts`, `probing/plan.ts`, `probing/expand.ts`, `tasks.ts`, `prompts.ts`, `schemas.ts`
  - `examples/demo-persona/src/index.ts`, `fixtures.ts`
- Test: `packages/knowledge/test/world.test.ts`

**Interfaces:**
- Produces:
  - **Snapshot:**
    - `TreeSnapshot.rootOf`;
    - `TreeSnapshot.knowledge: Set<string>`: live nodes with `rootOf === "knowledge"`, or unplaced with label `topic`.
    - `computeLighting` and `nextTarget` ignore nodes outside `knowledge`. `answerMode` returns `decline` for them, until WT-2 and SP4 define other roots.
  - **Expansion:** `expandNode` marks components it *created* as `frontier: true`. One that existed before is untouched.
  - **Seeding:** `seedBackground` attaches the seeded field under the Knowledge root.
  - **Placement:**
    - `unplacedNodes(store)` returns non-root live nodes with no home parent and no parts that have at least one approved memory linked or homed.
    - `placeNodes(store, model, personaName)` replaces `placeTopics`.
    - Its prompt outline lists the six roots and every node with its label. Its purpose stays `place`.
    - The schema adds `root: RootKey` and `parentLabel: EntityKind` per placement. If `parent` names no existing node, it is created with `parentLabel` under that root. Both are ignored when the parent exists.
  - **Demo:**
    - `PLACEMENTS` gains entries for the demo's non-topic entities, e.g. its project, under Work;
    - the demo `placements()` returns `root`;
    - the fallback is `["Other topics", …]` under `knowledge` for topics, and the label's default root for others.
- [ ] **Failing tests** in `world.test.ts`:
  - a pet node with an approved fact is placed under Life (scripted `place` response);
  - lighting ignores a competence-labeled memory linked to a Life node;
  - `nextTarget` never targets a non-knowledge node;
  - expansion marks only new components as frontier;
  - the seeded field sits under Knowledge.
- [ ] Implement. Run `pnpm vitest run packages/knowledge examples apps/cli`. The existing map and e2e tests stay green, updated only where output now shows roots (a ledger ruling if so).
- [ ] Commit: `Knowledge lighting stays in the Knowledge root; placement across all roots`

### Task 6: Homing and splitting

**Files:**
- Create: `packages/knowledge/src/organize.ts`
- Modify: `prompts.ts`, `schemas.ts`, `refresh.ts`, `index.ts`, and the demo persona
- Test: `packages/knowledge/test/organize.test.ts`

**Interfaces:**
- Produces:
  - `homeMemories(store, model, personaName): Promise<{ homed: number; created: string[] }>`:
    - **Which memories:** approved memories with `homeNodeId === null`.
    - **How:** one `map` call, purpose `home`. The schema is `{ homes: [{ memoryId, node, newNode: { parent, label, definition } | null }] }`.
      - If `node` names an existing node, it is homed there.
      - If `newNode` is set, the node is created with `ensureNode(node, newNode.label, definition)` under `newNode.parent` (an existing node or root name).
    - **Never invented:** unknown memory ids are ignored.
  - `splitNodes(store, model, personaName, splitAt): Promise<{ split: string[] }>`:
    - **Which nodes:** non-root nodes that have more than `splitAt` approved home memories, or that gained a child through `homeMemories` in this refresh while they still hold home memories.
    - **How:** one `map` call per node, purpose `split`, schema `{ children: [{ name, label, definition, memoryIds: string[] }] }`.
      - Each child is created under the node (or reused if it already exists).
      - Only the listed memory ids that are home to this node move.
      - A child whose name equals the node's is skipped.
  - `RefreshReport` gains `homed`, `split: string[]`.
  - The refresh order is: seed → place nodes → home memories → split → gaps and proposals (unchanged).
  - **Demo `home`:** each memory to the deepest fixture node by keyword, else to the Life root. **Demo `split`:** no children.
- [ ] **Failing tests:**
  - a homeless "I have two cats" fact gets homed at a new Pets node under Life;
  - a Pets node with 13 facts mentioning Miso and Tofu splits (scripted) into Miso and Tofu, moving only the listed ids, with shared facts left on Pets;
  - a node at 12 facts does not split;
  - bad memory ids are ignored;
  - a split child equal to the node is skipped.
- [ ] Implement. Run `pnpm vitest run packages/knowledge`. PASS.
- [ ] Commit: `Refresh homes memories and splits crowded nodes`

### Task 7: The forest in `standin map`

**Files:**
- Create: `packages/knowledge/src/tree-view.ts`
- Modify: `apps/cli/src/commands/map.ts`, `apps/cli/src/main.ts` (USAGE: `map [--json] [--private] [--all]`), `packages/knowledge/src/index.ts`
- Test: `packages/knowledge/test/tree-view.test.ts`, `apps/cli/test/map.test.ts`

**Interfaces:**
- Produces:
  - `TreeNode`: the CLI's old `NodeView`, plus:
    - `parentId: string | null`
    - `root: RootKey | null`
    - `label: EntityKind`
    - `frontier: boolean`
    - `facts: number`, the approved home memories
    - `state: "lit" | "dark" | "unlit" | "root"`. For non-knowledge nodes: `lit` when `facts > 0`. For knowledge nodes: `lit` when depth ≥ 1, `dark` when depth 0 or a gap at 0, else `unlit`. WT-2 adds `probable`.
  - `treeNodes(t, opts: { all?: boolean }): TreeNode[]`. Frontier nodes are excluded unless `all`.
  - `nodeStatus(v): string`. For non-knowledge nodes: `N facts`. For knowledge nodes, as today.
  - `renderForest(t, opts): string`. The six roots are always shown, in order, each with its branch indented, then "Not yet placed (run `standin map refresh`):" if any.
  - `standin map --all` includes frontier nodes, marked `(frontier)`.
- [ ] **Failing tests:**
  - `renderForest` prints all six roots in order with a pet under Life showing `2 facts`;
  - a frontier node is hidden without `all` and shown with it;
  - the CLI `map --json` nodes carry `root`, `label`, `state`, `facts`.
- [ ] Implement. Then run `pnpm test && pnpm typecheck && pnpm guard`. All PASS.
- [ ] Commit: `standin map shows the world forest`
