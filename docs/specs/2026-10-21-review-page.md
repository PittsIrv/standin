# One Review Page, and the Forest as a Grove

**Status:** design approved in conversation (decisions 76–78).

**Extends** concept-cards (the review page) and intro-sources (the introduction).

## 1. Why

The review page had a front door (the introduction), a session that ended with **Finish**, and a forest drawn like a database diagram. Two problems showed up in use:

- **It ended too hard.** After the last card, the page said the session was finished and locked itself, so the person could not see the tree their answers had just built.
- **The forest didn't look like one.** An outline of labelled dots is a fine editor, but it isn't something a person wants to look at, and the forest is the payoff for answering.

## 2. One page, four tabs (decision 76)

**Questions · Add · Forest · Boundaries.**

- **Questions** is the card flow as before: guesses, parts, areas, keep-or-lower decisions, then the review queue's items. The separate Queue tab is gone. Those items were already decided here.
- **Add** is the introduction: text, files and the person's website, read with proof and confirmed (intro-sources). It is always there, not only at the start. When the standin knows nothing about the person yet, the page opens on Add with "Introduce yourself" and "Skip for now". Otherwise it is titled "Add to what your standin knows". Confirming goes back to Questions, where the new guesses come first.
- **Forest** draws the grove (§4).
- **Boundaries** is unchanged.

## 3. Stop any time, resume next time (decision 77)

- **There is no Finish button.** Every answer is stored the moment it is given, as before. The person stops by closing the tab; the command ends with Ctrl-C, which ends the session record and prints what was answered.
- **Resume.** The next `standin review` picks up where the last one stopped. A card that was on screen but not answered is shown first, carried into the new session with the prediction recorded when it was first shown. After it come the parts the last answers opened, and the rest of the plan. Nothing already answered is asked again (as before).
- **Unconfirmed sources are dropped.** Sources added on Add but not confirmed live only in memory, so they are gone when the session ends. The rule stands: nothing is stored before the person confirms it.
- **Running out is not an ending.** When nothing is left to ask, the page switches to the Forest with "No more questions for now. Here is your forest." The Questions tab then offers the forest and Add. Nothing is ever disabled.

## 4. The forest as a grove (decision 78)

The six roots are six trees standing on one ground line, in the fixed root order: Knowledge, Work, Background, People, Views, Life.

- **Shape.** Each tree grows upward from its trunk. Its branches fan out over the upper half-circle, and each subtree gets a share of the fan in proportion to how many leaves it holds. Each level sits further from the trunk. A branch is a curve that leaves its parent going up, then bends toward its child. Its thickness grows with the number of nodes beneath it, so the parts of a life the person has said most about are visibly the stoutest. A small bend per branch, derived from the node's id, keeps trees from looking like org charts. The same tree is always drawn the same way.
- **Leaves are nodes.** Their colours mean what they meant before: known knowledge glows amber, brighter and with a larger halo the deeper it goes; guesses are dashed and filled by their probability; nodes with facts in the other trees are teal; "No" is gray; not yet lit is an outline. A legend says so.
- **Empty trees are saplings,** a short trunk and two buds under the root's name, so a root with nothing yet is visible and invites adding.
- **Reading it.** Root names sit on the ground under each trunk. Zoomed out, only the first ring of branches is labelled. Zoom in (or click a tree's name or trunk, which zooms to fit that tree) and every leaf is labelled. A focused or hovered leaf always shows its name. "Fit" shows the whole grove again.
- **Using it.** Click a leaf for the side panel (facts, guess, history, edits), as before. Drag a leaf onto another leaf or a tree to move it. Cross-links (requires, related) are drawn only for the selected leaf, as thin dashed vines, so the grove stays readable. "Show unexplored" adds the frontier as small dashed buds.
- **One moment of motion.** The first time the forest opens, leaves fade in from the trunk outward. There is nothing else, and nothing at all when reduced motion is set.
- Leaves are focusable buttons named for screen readers, and every edit in the panel can be done from the keyboard (Move under…, as before).

## 5. Decisions log

Continues from intro-sources decision 75.

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 76 | Page shape | One page: Questions, Add, Forest, Boundaries; the queue folded into Questions; the introduction always on Add | Introduction only as a front door; separate Queue tab |
| 77 | Ending | No Finish: answers save as given, the next review resumes (the unanswered card first), unconfirmed sources are dropped, running out opens the Forest | A Finish that locks the page; keeping unconfirmed sources |
| 78 | Forest drawing | A grove: six trees on a ground line, fanned branches thickened by what's beneath, leaves coloured by state, labels by zoom | Canopy (nested crowns from above); sideways tapered branches |

## 6. Numbers (starting values, tuned by eye)

| Number | Value |
|---|---|
| Fan | the upper half-circle, 200° to 340° |
| Ring spacing | 74 px per level |
| Branch width | 1.5 + 1.3·√(nodes beneath), at most 16 px |
| Leaf radius | 7 px (frontier buds 4 px) |
| Labels for every leaf | zoom ≥ 1.1, or the tree is focused |
