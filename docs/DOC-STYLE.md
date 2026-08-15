# Documentation Authoring Standard

This is a **contributor/process doc**: the ruleset for writing gaunt-sloth's human-facing docs
(`README.md`, `docs/*.md`, `--help`/`/help` text). It is not itself user-facing content. Every
rule below is written so an author can self-check against it before opening a PR — if you can't
point at where in your draft a rule is satisfied, it isn't satisfied yet.

This formalizes and extends a convention that was already partly in place: `docs/COMMANDS.md`'s
`### Examples` sub-heading under most commands is the existing pattern; the rules below make it
mandatory, extend it to `--help`/`/help` output, and add the checks (source-tracing, rendering)
that were previously implicit or skipped.

## Scope: `docs/` is public, `maintenance/` is internal

This is the foundational classification everything else in this file assumes: **`docs/` is
reserved for the source of the public, user-facing docs site** — command references, config
guides, migration notes, feature walkthroughs (`COMMANDS.md`, `CONFIGURATION.md`, `MIGRATION.md`,
`debug-dump.md`, …). **Internal engineering/contributor/release-process content lives in
`maintenance/` instead** — TUI implementation rulesets for contributors, release/versioning
mechanics, test-deploy runbooks, and similar maintainer-facing material never belong in `docs/`,
however useful they are to have written down.

Before adding a new page, ask: would this make sense to a user reading the public docs site, or is
it instructions for someone hacking on this repo? If it's the latter, it goes in `maintenance/`,
not `docs/` — a docs-site build should never have to filter contributor content out of `docs/`
after the fact.

## 1. One page per distinct concept, feature, or surface

Each doc page owns exactly one concept (a command family, a config domain, a subsystem). When a
change would make an existing page (`COMMANDS.md`, `CONFIGURATION.md`, `debug-dump.md`, …) cover
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
  (`debug-dump.md`).

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

### The route for `docs/` pages

TypeDoc renders every page listed in `typedoc.json`'s `projectDocuments`, which is the same build
that produces the published site. Until the PLAT-10 Starlight docs site exists:

```bash
pnpm typedoc
```

Then open the changed page in a browser. Opening the file directly over `file://` is enough —
every asset TypeDoc emits is pulled in by a script tag, so navigation and search work with no
server. Which file to open depends on where the page lives, and only the first of the three lands
under `documents/`:

- a page under `docs/` renders to `docs-generated/documents/<flattened path>.html`, so
  `docs/configuration/tools.md` is `docs-generated/documents/docs_configuration_tools.html`;
- the **root `README.md`** renders as the project index, `docs-generated/index.html`;
- a **published package's `README.md`** renders as that package's module page under
  `docs-generated/modules/`, named after the package with `@` and `/` replaced by `_` — so
  `packages/core/README.md` is `docs-generated/modules/_gaunt-sloth_core.html` and
  `packages/app/README.md` is `docs-generated/modules/gaunt-sloth.html`. That same README is the
  package's npm landing page, so check it there too, against rule 9's link self-check.

If you want it over http instead, serve the directory with something already installed —
`python3 -m http.server 8099 --directory docs-generated`. Do not reach for `npx serve` or a `dlx`
equivalent: that downloads and executes an unpinned package off the registry to look at files you
already have on disk.

In the browser, confirm:

- every heading renders as a heading (not swallowed inside the previous code fence);
- code fences render as code blocks, and the heading *after* a fence actually renders as a heading
  (the classic failure mode is an unclosed/mis-closed fence eating everything after it);
- tables render as tables, not literal pipe-and-dash text;
- every cross-link you added or changed actually resolves (no 404) — click it, don't eyeball the
  href.

### Read the run's warnings, not only the page

`pnpm typedoc` exits 0 with hundreds of warnings, so nothing stops on your page's behalf. Two of
the lines in that stream are about your page and `grep` finds them; two further failure modes
produce no line at all:

- **`The glob …/docs/<page>.md did not match any files`** — `projectDocuments` names a path that
  does not exist, so that entry renders nothing. This is how the gate goes quiet: it keeps passing
  while covering less than it claims.
- **`… links to <target>, but the anchor does not exist`** — a cross-link whose `#anchor` misses.
  Write the anchor the way **GitHub** slugs the heading: rule 10 makes GitHub's slug the
  authoritative one and configures TypeDoc to agree with it, so a warning here is normally a
  genuinely wrong anchor and not the two renderers disagreeing. Rule 10 lists the heading shapes
  where they still do disagree — check the target heading against that list, on both renderers,
  before editing anything.
- **Nothing at all** — the failure mode with no warning. A relative link to a `.md` file that
  `projectDocuments` does not match is not an error to TypeDoc: it copies the target into
  `docs-generated/media/` and links to the raw markdown, which a reader gets as a download rather
  than a page. So when you add a page under `docs/`, add it to `projectDocuments` in the same
  change — the `docs/configuration/*.md` and `docs/guides/*.md` globs already cover those two
  trees, and `packages/core/spec/typedocProjectDocuments.spec.ts` fails the unit suite if any
  `docs/` page is left unmatched or any listed path stops existing.
- **Nothing at all, again — a link into the page's own headings.** TypeDoc checks the anchor of a
  link that crosses to another page, and says nothing whatsoever about one pointing into the page
  it sits on. A clean warning stream is therefore no evidence that a page's own internal links
  resolve, so run the sweep below rather than reading the warning stream as coverage. When one is
  wrong, **fix the link, never the heading** — renaming a heading breaks every inbound link from
  outside this repo, which is a worse failure than the anchor you set out to repair. Check both
  renderers before you decide it is wrong: a link the sweep reports dead on the site but that
  resolves on GitHub is one of rule 10's diverging shapes, where neither the link nor the heading
  is the thing to edit.

Since no warning names them, enumerate the same-page links yourself. For the page you changed,
`grep -on '](#[^)]*' docs/configuration/tools.md` prints each internal link with its line number,
and you click each one in the rendered HTML. To sweep every rendered page at once — the whole tree,
not just `documents/`:

```bash
node -e 'const fs=require("fs"),walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).flatMap((e)=>e.isDirectory()?walk(d+"/"+e.name):[d+"/"+e.name]);for(const f of walk("docs-generated")){if(!f.endsWith(".html"))continue;const h=fs.readFileSync(f,"utf8"),ids=new Set([...h.matchAll(/ id="([^"]+)"/g)].map((m)=>m[1])),bad=[...new Set([...h.matchAll(/href="#([^"]+)"/g)].map((m)=>decodeURIComponent(m[1])))].filter((a)=>!ids.has(a));if(bad.length)console.log(f,bad.join(", "))}'
```

Each line of output is a page and the anchors on it that point at no heading, so find the one you
changed rather than reading it as a to-do list.

### Pages TypeDoc does not render

`docs/DOC-STYLE.md` and everything under `maintenance/` are contributor docs, read on GitHub rather
than on the docs site — check those as **GitHub** renders them (open the file on your pushed
branch, or the PR's Files-changed view), against the same four points above — as is any other
markdown the run does not turn into a page, such as `examples/*/README.md`.

Record what you checked and what you saw (which page, which browser/tooling, screenshot if
available) in the PR description or task report — "I looked at a diff" is not evidence this gate
was met.

## 9. Publishable package READMEs use absolute links, never relative ones

A package's `README.md` is its **npm landing page** — npmjs.com renders it for anyone viewing
`@gaunt-sloth/<pkg>`. This rule governs every **published** package README (`packages/*/README.md`).
It does **not** apply to the workspace-root `README.md`: the root package is private and never
published to npm, and that README is only ever read on GitHub, where relative links work — leave its
relative links alone.

**The rule:** in a published README, any link that points *outside the package's own published
files* — to a sibling `@gaunt-sloth/*` package, to a repo file like `docs/COMMANDS.md` or the root
README, or to an image — must be an **absolute URL**, never a repo-relative path (`../core`,
`../../README.md`, `./assets/x.png`).

**Why relative links don't work on npm.** npmjs.com does not serve the sibling files. It rewrites a
relative link against the package's `repository.directory` into a link to the **GitHub source tree**,
and drops relative images entirely. So ``[`@gaunt-sloth/core`](../core)`` on `@gaunt-sloth/batch`'s
npm page never takes the reader to core's npm page — at best it lands them in GitHub source, at worst
it 404s. A reader on npm who wants the sibling package wants its **npm page**, which a relative link
can never express.

**For a cross-package reference, give both absolute links — npm and GitHub source:**

```markdown
- [`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) — Core utilities, config,
  and agent infrastructure
  ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/core))
```

- **npm page** (the primary link, since the README is read on npm):
  `https://www.npmjs.com/package/<name>` — e.g. `.../package/@gaunt-sloth/core`; the app package is
  `.../package/gaunt-sloth`.
- **GitHub source:** a package →
  `https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/<dir>`; a repo file (root
  README, `docs/COMMANDS.md`, another package's README section) →
  `https://github.com/pukeko-robotics/gaunt-sloth/blob/main/<path>` (append `#anchor` to deep-link a
  heading). The org is `pukeko-robotics` — not the pre-move org.

**Self-check (must pass before you ship):** `grep -nE '\]\(\.\.?/' packages/*/README.md` returns
nothing. Every match is a relative link that will misresolve on npm; replace it with the absolute
npm+GitHub form above.

## 10. GitHub's heading slug is the authoritative anchor

Every page here is rendered by more than one thing — GitHub, the generated site, npm for a package
README — and each of them turns a heading into an `#anchor` by its own rules. **Write every anchor
the way GitHub slugs the heading, and make the other renderers agree with GitHub** rather than
editing links to suit whichever one you happened to check.

GitHub is the authoritative one because its slugs are the ones already pointed at from outside this
repo — bookmarks, issue comments, chat messages, other projects' docs. Those links cannot be found
or fixed, so anything that changes a GitHub anchor breaks them permanently, while an anchor on a
generated site can be regenerated at will.

Two consequences, both easy to get backwards:

- **Never rename a heading to repair an anchor.** The rename fixes one link and silently breaks
  every inbound one.
- **Never edit a link to satisfy one renderer.** If a link resolves on GitHub and not on the site,
  the renderer is what needs configuring; editing the link just moves the breakage to the surface
  where it currently works.

**How TypeDoc is made to agree.** TypeDoc builds a heading's anchor from that heading's text tokens
only, so an inline code span would contribute nothing and `The ladder: ` + `` `approvals` `` would
anchor as `#the-ladder` while GitHub anchors it as `#the-ladder-approvals`.
`scripts/typedoc-github-heading-anchors.mjs` — registered in `typedoc.json`'s `plugin` array and
covered by `packages/core/spec/typedocHeadingAnchors.spec.ts` — closes that gap by feeding the code
span's text to the anchor generator, without changing a byte of the rendered heading. `pnpm typedoc`
is not a CI job, so if you change how docs are built, keep that plugin registered: dropping it
re-breaks every link into a code-span heading, and the only symptom is a link that stops resolving.

**Where the two still disagree.** The plugin feeds TypeDoc the same heading *text* GitHub slugs; it
does not give TypeDoc GitHub's slug algorithm, and the two algorithms are different functions.
TypeDoc strips a fixed punctuation set, turns whitespace into hyphens, collapses the **first** run
of two or more hyphens, and falls back to `_` when nothing survives. GitHub strips a wider set,
collapses nothing, and emits no anchor you can link to when nothing survives. They therefore agree
on a heading of letters, digits and single spaces, and three shapes are measured to diverge:

- **A slug that ends up with a run of two or more hyphens** — `Local & free models` anchors as
  `#local--free-models` on GitHub and `#local-free-models` on the site. Any heading with `&`, an em
  dash, or a `/` surrounded by spaces produces one, because both renderers drop the character and
  leave the spaces either side of it. Only TypeDoc's *first* run collapses, so a site slug can
  itself carry `----` and still not match GitHub's.
- **A character TypeDoc keeps and GitHub strips** — an arrow or an emoji. Nothing is collapsed
  here; the character simply survives into one slug and not the other. `Old → new` is `#old-→-new`
  on the site and `#old--new` on GitHub; `Party 🎉` is `#party-🎉` and `#party-`.
- **A heading that slugs to nothing at all**, such as one that is a single punctuation-only code
  span: the site anchors it as `#_`, and GitHub gives it no anchor to link to.

Three shapes measured on both renderers, not a proof that there is no fourth: anything in a heading
beyond letters, digits and single spaces is worth checking on both before you link to it.

**What to do about all three:**

- **When you write or rename a heading, keep it to letters, digits and single spaces** —
  `Local and free models` slugs identically everywhere and reads better in a link than
  `Local & free models` does.
- **When one already exists, leave it alone** (renaming it is the failure above) and simply don't
  deep-link it from a page that has to resolve on both surfaces; link the section above it instead.

**Self-check (must pass before you ship):** `pnpm typedoc` reports no `anchor does not exist`
warnings, and rule 8's sweep prints no pages — with no exception for a page you did not write. The
sweep covers the whole generated tree, API reference pages included, so it can name a generated
page rather than one of yours; that is a separate defect to raise, and still not something to ship
past.
