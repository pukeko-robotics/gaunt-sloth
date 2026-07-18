# Documentation Authoring Standard

This is a **contributor/process doc**: the ruleset for writing gaunt-sloth's human-facing docs
(`README.md`, `docs/*.md`, `--help`/`/help` text). It is not itself user-facing content. Every
rule below is written so an author can self-check against it before opening a PR — if you can't
point at where in your draft a rule is satisfied, it isn't satisfied yet.

This formalizes and extends a convention that was already partly in place: `docs/COMMANDS.md`'s
`### Examples` sub-heading under most commands is the existing pattern; the rules below make it
mandatory, extend it to `--help`/`/help` output, and add the checks (source-tracing, rendering)
that were previously implicit or skipped.

## 1. One page per distinct concept, feature, or surface

Each doc page owns exactly one concept (a command family, a config domain, a subsystem). When a
change would make an existing page (`COMMANDS.md`, `CONFIGURATION.md`, `ux-guidelines.md`, …) cover
an unrelated concept, **split a new page** instead of growing the old one into two topics.

- Before adding a section, ask: does this belong to the page's existing concept, or is it a new
  one riding along because it was convenient to bolt on? If it's new, it gets its own file.
- **Cross-link both directions.** The new page links back to the page it split from (context/
  entry point), and the original page links forward to the new one (so a reader who lands on the
  old page isn't stranded). A split that only links one way is incomplete.
- **Never fork a near-duplicate page for a variant of something already covered.** If you're about
  to write `docs/debug-dump-in-code-mode.md` next to `docs/debug-dump.md`, that's a sign the
  existing page needs a section, not a sibling file.
- Filename convention: cardinal/index docs are UPPERCASE (`COMMANDS.md`, `CONFIGURATION.md`,
  `DOC-STYLE.md` — like `README`/`CLAUDE`); topical or single-feature docs are kebab-case
  (`ux-guidelines.md`, `debug-dump.md`).

## 2. Exactly one worked use case per page

Every page leads with **one** real goal, phrased as *"I want to do A — to do that: B, then C, then
D"* — not a list of every possible invocation, and not a synopsis without a goal attached. If a
page's subject genuinely has multiple common workflows, pick the most representative one for the
lead use case; the rest belong in an `### Examples` block (rule 6), not a second competing "here's
another scenario" narrative.

The example must be **complete and runnable exactly as written**:

- A real command line, not `gsloth <command> <your-value-here>`. Pick an actual value — a real
  file path that exists in a plausible project, a real flag combination — and use it consistently
  through the worked example.
- A real config snippet if config is involved, not an elided `{ ... }`.
- If you can't run it yourself to check it works, that's a sign you don't have a real use case yet
  — go find one, don't write a placeholder and hedge.

## 3. State each fact once

If a warning, caveat, or gotcha matters, it goes in **the one place** a reader will actually be
looking when it becomes relevant — not the top, middle, and bottom of the page "to be safe."
Restating the same warning three times doesn't make a reader three times more likely to see it; it
makes the page read as padded and makes the *one* place that matters harder to find.

Self-check: grep your draft for the warning's key phrase. If it appears more than once, delete all
but the instance that sits where the reader's eyes are when the fact becomes actionable (e.g. right
next to the command that triggers the risk, not in a general "Notes" section three screens away).

## 4. Every factual claim is traced to source or a passing test before the page ships

Command syntax, output text, default paths/env vars, config keys, and — especially — **which
modes or contexts a feature works in** must be verified against the code or a test run, not
inferred from what "sounds right." If you're not sure, go read the source or run the command;
don't hedge into the page with "should," "typically," or "in most cases" as a substitute for
finding out.

Concretely:

- A claim about output text: paste it from an actual run, or quote it from the source string that
  produces it (cite the file).
- A claim about "supported in modes X/Y but not Z": grep the actual wiring (which entry points
  construct/pass the feature through) — don't guess from the modes' names or descriptions.
- A default path/env var/config key: quote it from the resolver/constant that defines it, not from
  memory of a similar-sounding one elsewhere.
- A page's author is expected to be able to say, for each non-trivial claim, "here's the file and
  line (or the test) that proves this" if asked.

## 5. No filler

- No restating what the heading already said in the first sentence under it.
- No throat-clearing intros ("In this section, we will discuss...").
- No marketing adjectives the feature hasn't earned ("powerful," "seamless," "blazing fast")
  unless the claim is backed by a number or a citation.
- Every sentence of prose must convey something the heading and the code/command sample next to it
  don't already say. If a sentence would still be true with the heading and sample deleted, it's
  probably filler; if deleting the sentence loses no information, delete it.

## 6. `--help` / `/help` must include a runnable example

Every command's `--help` output (and every slash command's `/help` line, where applicable) must
include **at least one concrete, runnable usage example** — not just an abstract flag/description
list that leaves the reader to guess how the pieces combine.

- Mechanism: Commander's `.addHelpText('after', ...)`, appended after the command's `.option(...)`
  chain, containing one or more real invocations (see `packages/app/src/commands/askCommand.ts`
  after this ticket's fix, or `reviewCommand.ts`, for the pattern).
- **Anti-pattern this rule exists to fix:** `askCommand.ts`'s `.description('Ask a question')` had
  no example anywhere in its `--help` output — a user running `gsloth ask --help` saw the flag list
  and nothing showing how to actually invoke it. Fixed as part of this ticket; use it as the
  before/after reference.
- The example in `--help` should be the same one that's correct in `docs/COMMANDS.md`'s
  `### Examples` block for that command — one source of truth for "how do I actually call this,"
  not two documents that can drift apart.

## 7. The `### Examples` convention (COMMANDS.md)

`docs/COMMANDS.md` already uses an `### Examples` sub-heading under most commands, with one or more
realistic, runnable command lines in a fenced code block. This is the house convention this
document formalizes: any page documenting a command or CLI-invokable feature uses the same
`### Examples` sub-heading, with real invocations (not placeholders), consistent with rule 2's
"exactly one worked use case" as the page's lead — `### Examples` is where the *additional*
variations live once the one worked use case has been told as a story.

## 8. Verification gate: rendered, not just diffed

A new or modified page is not done when the markdown diff looks right — it is done when it has
been **visually checked as rendered HTML**. A markdown diff cannot show you a code fence that
swallowed the next heading, a table that didn't parse, or a cross-link that 404s.

Until the PLAT-10 Starlight docs site exists, do this locally before calling a doc page finished:

```bash
pnpm typedoc
npx serve docs-generated    # or: python3 -m http.server <port> --directory docs-generated
```

Then load the changed page in a browser and confirm:

- every heading renders as a heading (not swallowed inside the previous code fence);
- code fences render as code blocks, and the heading *after* a fence actually renders as a heading
  (the classic failure mode is an unclosed/mis-closed fence eating everything after it);
- tables render as tables, not literal pipe-and-dash text;
- every cross-link you added or changed actually resolves (no 404) — click it, don't eyeball the
  href.

Record what you checked and what you saw (which page, which browser/tooling, screenshot if
available) in the PR description or task report — "I looked at a diff" is not evidence this gate
was met.
