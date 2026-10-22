# Personal-Data Guard

**Status:** draft (decisions 93–100). **Builds on** architecture §7 (the airlock's deterministic scanners) and intro-sources §3 (contact details are cut before storing).

Your standin needs to know what you did and what you think, not how to log in as you. Before this, a password, API key or card number typed into `standin tell`, the Add box, a question answer or a quiz answer was stored as raw text, sent to the model provider during compaction, copied into the trace log, and could come back as a fact to approve. This adds the airlock's deterministic scanners now, at the point where text comes in, instead of only at publish time.

## 1. Intent

- **Nothing that looks like a secret is stored or sent to a model.** Text you typed is refused until you remove it. Text from a file or web page has the match cut, and you are told what was cut.
- **Warn while typing.** The review page checks a draft locally as you type and says what it found before you save.
- **Contact details are cut on every way in**, not only from intro sources.
- **Old data can be checked.** `standin scan` finds what got in before the guard existed and can remove it.
- **Non-goals:** the LLM sensitivity classifier (health, finance, third parties); the publish-time scan; scanning model output.
- **Anti-goals:**
  - a secret that reaches the database, a model prompt or a trace by any path;
  - a scan report or error message that prints the secret it found.

## 2. What counts (decisions 94–96, 100)

`@standin/airlock` (new package, no runtime dependencies) exports `scan(text) → Finding[]`. A finding is `{ rule, label, kind: "secret" | "contact", start, end }`.

**Secrets:**

| Rule | Matches |
|---|---|
| Provider keys | gitleaks' default rules, ported (§2.1) |
| Unknown keys | gitleaks' `generic-api-key`: a keyword (key, token, secret, password, auth, credential…) with an assignment, then a value with Shannon entropy **≥ 3.5** bits per character that contains a digit. Plus a prose form of the same: "my api token is …" (keyword, then `is`/`was`/`:`/`=`, then a value meeting the same entropy rule). |
| Passwords | `password`, `passwd`, `passcode`, `passphrase`, `pwd`, `PIN`, then `is`/`was`/`:`/`=`, then a value that has a digit, a symbol or a capital letter after its first character, or is in quotes |
| Private keys | `-----BEGIN … PRIVATE KEY-----` blocks |
| Card numbers | 13–19 digits (spaces or dashes allowed between groups) that pass the Luhn check |
| IBAN | country code, 2 check digits, 11–30 letters and digits, passing mod-97 |
| Chinese resident ID | 18 characters (17 digits + digit or X) with a valid date of birth and ISO 7064 mod 11-2 check |
| US SSN | `AAA-GG-SSSS`, excluding area 000, 666, 900–999, group 00 and serial 0000 |

Passport and driver's-license numbers are not checked: they have no checksum and vary too much by country.

**Contacts:** the existing email, phone and street-address patterns, moved here from `@standin/intake`.

### 2.1 Porting gitleaks

- `scripts/port-gitleaks.mjs <gitleaks.toml> <commit>` writes `packages/airlock/src/gitleaks.gen.ts`. It records the gitleaks commit and its MIT notice, and is rerun by hand to refresh the rules.
- Each rule keeps its id, its regex (converted from Go RE2 to JavaScript), its keywords (a case-insensitive prefilter), its entropy threshold, its secret group and its allowlists. Allowlists can be regexes over the secret, the match or the line, or stopwords.
- Rules that only match file paths are dropped, and so are path-only allowlists. Rules that don't compile in JavaScript are dropped, and the script reports them.
- As in gitleaks, generic rules also require a digit in the secret.
- Labels come from the rule id, e.g. `github-pat` → "GitHub token".

## 3. Where it runs

| Way in | Typed by you? | On a secret | Contacts |
|---|---|---|---|
| `standin tell`, `observe`, `interview import` | yes | refused | cut |
| Review page: Add (typed text), question answers, quiz answers, edits on approval cards, tree names and descriptions | yes | refused | cut |
| `standin ask`, the Ask tab | yes | refused | cut (the question still goes to a model and the trace) |
| Intro files and web pages | no | cut, and listed beside the source before you confirm | cut |

- **One checkpoint in the store.** Every store method that writes text from a person checks it, so a new way in can't skip the guard. These are `addObservation`, memory edits, quiz answers, preference pairs, and node names and descriptions. A secret raises `SecretFoundError`, which carries the findings: their label, their line and column, and a few words of context with the secret replaced by `•••`. No part of the secret is kept. Intro files and pages are cleaned before they reach the store.
- **CLI:** `standin tell` exits with an error listing each finding by line and column, then "Your standin never needs this; remove it and try again." A multi-item import is refused as a whole, listing every item that matched, so nothing is half-imported.
- **Review page** (decision 98): half a second after you stop typing in any text box listed above, the page posts the draft to `/api/check`, a local call that stores nothing and makes no model call. It highlights each secret with its label and disables Save until it's gone. A contact gets a note, "will be removed when you save", and doesn't block. The server checks again on save and answers 422 with the same findings.

## 4. `standin scan` (decision 97)

- `standin scan [--purge] [--json]` checks everything already stored: raw observation text, facts and their edits, trace text, quiz answers, preference pairs, exemplars, and the private eval cases.
- It lists each finding by where it is (for example `observation obs_… line 3`), with its label and masked context, and gives a count per kind.
- `--purge`:
  - deletes the raw text of matched observations, as `purge` does;
  - deletes the trace text of matched spans;
  - in facts, quiz answers, preference pairs, exemplars and eval cases, replaces each match with `[removed]`.

  It prints what it changed and can't be undone.

## 5. Decisions log

| # | Decision | Choice | Rejected |
|---|---|---|---|
| 93 | On a secret in typed text | Refuse until it's removed | Cut it and say so; warn and allow an override |
| 94 | Where the patterns come from | Port gitleaks' default rules (MIT), plus our own for passwords, cards, IDs and private keys | Depend on secretlint; a short hand-written list |
| 95 | Keys from unknown providers | Generic rule, entropy ≥ 3.5, keyword required | Entropy ≥ 4.0; no generic rule |
| 96 | Contact details | Cut on every way in, at the same checkpoint | Keep the intro-only scope; refuse like secrets |
| 97 | Data stored before the guard | `standin scan`, with `--purge` | Scan once during the migration; leave it |
| 98 | When the page warns | As you type, checked locally after half a second | Only when you save |
| 99 | Secrets in files and web pages | Cut and listed before you confirm | Refuse the source |
| 100 | Password phrases and ID numbers | A password value must look like one (digit, symbol, inner capital, or quotes); checksummed IDs (card, IBAN, Chinese ID) plus US SSN | Any value after the phrase; quoted values only; passport and license phrases; cards and SSN only |

## 6. Numbers

| Number | Value |
|---|---|
| Generic-key entropy | 3.5 bits per character |
| Check delay while typing | 500 ms |
| Characters of a secret shown anywhere | 0 |
| Context words shown around a finding | 4 on each side |
