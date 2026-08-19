# v2.0.0-beta.0 The 2.0 Line

The first beta of the 2.0 line, and the first 2.0 release aimed at people outside the project.
2.0 is a **breaking release**: the package is renamed, the config schema is validated strictly with
no back-compat coercion, shell execution moves onto a five-rung approvals ladder, and the
interactive session gains a full-screen terminal interface.

Read [docs/MIGRATION.md](../docs/MIGRATION.md) before upgrading a 1.x config. `gth config validate`
checks a migrated config against the 2.0 schema without building an LLM or running anything.

## Before You Upgrade

The 2.0 line ships under a **renamed package**, `gaunt-sloth`. The 1.x package is
`gaunt-sloth-assistant`, and it owns the same bin names, so installing on top of it can abort the
whole install with `npm error EEXIST` while `gth --version` keeps reporting the old version. Remove
the old package first:

```bash
npm rm -g gaunt-sloth-assistant
npm i -g gaunt-sloth
gth --version
```

## New Commands

- **`gth exec`** — Run a markdown prompt-executable (prose plus code snippets) once, reliably and
  near-deterministically. Non-interactive and pipe-clean, so it belongs in scripts and CI. Takes a
  `.md` script path, `-m/--message` inline text, or a script on stdin; `-f/--file` prepends context
  files and `-t/--temperature` controls sampling.
- **`gth batch`** — Run one prompt-executable across a matrix of inputs and/or models — "xargs for
  prompts". `--over <csv|jsonl>` binds each row into the script through `{{field}}` placeholders,
  `--models a,b,c` fans out across models, `-j/--concurrency` caps in-flight cells (default `1`;
  parallelism is opt-in because a local single-GPU backend and a low-tier cloud key both degrade
  under a burst), `--retry` retries a failed cell, and `-o/--output` writes structured per-cell JSON
  plus a `results.json` summary. It exits `0` as long as the cells ran — a poor answer is not a
  harness failure.
- **`gth eval`** — Grade agent output. Runs suites of cases, judges them with the system-under-test
  model or an independent `--judge` profile, sweeps declared config cells into one comparison table,
  scores classifier corpora with confusion matrices and metric gates, and diffs a run against a
  previous one with `--compare-to`. `--export-blind` and `--relabel-diff` support an independent
  second labelling of a corpus. Reporters are pluggable via `-r/--reporter`: `text` by default, plus
  `@gaunt-sloth/eval-reporter-junit` and `@gaunt-sloth/eval-reporter-teamcity` for CI.
- **`gth workflow`** — Run a local JavaScript orchestration script (`.mjs`/`.js`) that drives one or
  more agent calls: call, inspect, decide, call again, fan out and join — control flow a shell
  pipeline of `gth` invocations cannot express. The default export receives a context object
  (`ctx.agent`, `ctx.parallel`, `ctx.z`, `ctx.log`, `ctx.args`) and its return value is the output —
  a string prints as-is, anything else as pretty JSON. `--args <json>` supplies `ctx.args`. The
  script is arbitrary local ESM with full Node privileges; run only scripts you trust.
- **`gth config`** — Inspect and manage configuration. `config print` renders the fully-resolved
  config with secrets redacted (`--json` for machine-readable output), `config validate` checks it
  against the schema and exits non-zero when invalid, and `config profile create <name>` scaffolds a
  named profile under `.gsloth-settings/<name>/` (`--model`, `--force`).
- **`gth models`** — List available models per provider, enriched with cost and context-window
  metadata from models.dev. `--provider` narrows to one provider, `--refresh` forces a catalog
  re-fetch past the cache TTL.
- **`gth history`** — Search and list locally-recorded sessions. `history list`, `history search`
  (SQLite FTS5 full-text), and `history show <id>` for a whole thread. Recording is **opt-in and
  local only** — nothing here touches the network, and sessions are stored only when
  `history.enabled: true` is set. The store defaults to `~/.gsloth/history.db`, overridable with
  `history.dbPath` or `--db`.
- **`gth insights`** — Local analytics over that recorded history, same opt-in and same store.

## Agent Client Protocol Server

`@gaunt-sloth/agent` ships a `gaunt-sloth-acp` binary: a first-party ACP server built on
`@agentclientprotocol/sdk`, serving **protocol v2 with v1 negotiation**. The v1 half is what makes
it reachable from Zed. The `acp.mode` config block selects the agent mode the editor session runs
under; it defaults to `code`, and `chat` opts back into a read-mostly posture.

## Interactive Terminal Interface

`gth chat` and `gth code` open a full-screen alternate-screen interface by default.

- Scrollable transcript with width-aware rendering, collapsible reasoning/thinking blocks, docked
  debug panes, and live thinking across the Anthropic, Google Gemini, OpenRouter and DeepSeek
  reasoning formats.
- Multi-line prompt editor with bracketed paste, readline-style word motions, history recall and
  slash-command completion on `/`.
- The plain readline surface is still available with `--no-tui`, the `GTH_NO_TUI` environment
  variable, or `tui: false` in config, and **both surfaces now share one slash-command registry**.

## Approvals and the Safety Rater

Shell execution and other state-changing tool calls run behind one ordered ladder of five modes,
replacing the previous ad-hoc `yolo` / `judge` / `allowlist` flags:

`manual` · `write` · `assisted` · `auto` · `bypass`

`manual` and `write` never consult a model; `assisted` and `auto` escalate anything not rated safe.
The rater classifies a proposed operation into four outcomes — `safe`, `destructive`,
`catastrophic`, `attack` — with abstention as a distinct action, a configurable timeout, and a
hardline command floor that fires before any model is consulted. Untrusted text in an approval
prompt is rendered neutralised, so a command string or a third-party MCP tool name cannot inject
escape sequences or forge framing. `/approvals` shows the current mode, the rater and the allow/deny
counts, and switches between the five; with no argument on a terminal it offers a picker.

## Workspace Packages

2.0 ships as a monorepo of seven published packages: `gaunt-sloth` (the CLI and interface),
`@gaunt-sloth/core`, `@gaunt-sloth/agent`, `@gaunt-sloth/review`, `@gaunt-sloth/batch`,
`@gaunt-sloth/eval-reporter-junit` and `@gaunt-sloth/eval-reporter-teamcity`. Embedders import from
the scoped packages; the `gaunt-sloth` app package no longer exports modules.

## Breaking Changes

Every deprecated config shape is now a hard error — 2.0 has no back-compat coercion, and each
message names its replacement. [docs/MIGRATION.md](../docs/MIGRATION.md) carries the full before/after
for each.

1. **Package renamed.** `gaunt-sloth-assistant` → `gaunt-sloth`. Remove the old global install
   first (see above). The `gaunt-sloth-assistant` bin is retired; `gth`, `gsloth` and `gaunt-sloth`
   remain.
2. **Mouse reporting is on by default in the interactive interface.** `gth chat` and `gth code` now
   enable terminal mouse reporting, so parts of the interface respond to clicks and the wheel
   scrolls a focused panel. While it is on, your terminal hands drag events to Gaunt Sloth instead
   of using them for its own text selection: hold Shift (Option in some macOS terminals) to select
   and copy as usual. To turn it off, run `/mouse off` in a session, set `useMouse: false` in your
   config, or start with `GTH_NO_MOUSE=1`. A piped or redirected run never enables tracking.
3. **Approvals became one ladder of five modes.** `yolo`, `judge`, `allowlist` and
   `persistAllowlist` on `builtInTools.run_shell_command`, and `approvals.strictness`, `.escalate`,
   `.allowlist`, `.persistAllowlist` and an object-form `rater`, are all validation aborts. The
   retired mode values rename: `read-only` → `manual`, `auto-safe` → `assisted`, `full-auto` →
   `auto`; `ask` becomes `write` if you want file edits in the working folder granted, or `manual`
   if you want to be asked about those too. `approvals.allow` / `.deny` carry the lists.
4. **`output.header` changed type, then changed default.** It was a boolean; it is now the enum
   `none` | `compact` | `debug`, and a boolean fails validation. `false` → `"none"`, `true` →
   `"debug"`. The default is now `"compact"`, so **a config that never set the key gets different
   output**: a non-interactive text run opens with one attribution line naming the command and the
   model instead of the Workdir/Model/Tools/Middleware preamble. Set `"debug"` to restore the
   preamble, `"none"` for byte-clean captured stdout.
5. **`agent.backend: "deep"` is removed.** It is a validation abort:
   `Agent backend "deep" is no longer supported: Gaunt Sloth ships one agent backend.` Remove the
   `agent` block or set `"backend": "lean"`, which has been the default at every non-ACP entry point
   for some time. The `GthDeepAgent` / `gthDeepAgentFactory` exports and the
   `@gaunt-sloth/agent/core/GthDeepAgent.js`, `deepAgentPermissions.js`, `gthAcpServer.js` and
   `modules/acpModule.js` deep paths go with it; `extractDebugRequestExtras` moved to
   `@gaunt-sloth/agent/core/debugCapture.js`, and `startAcpServer` is still a root export, now
   starting Gaunt Sloth's own server.
6. **Command configs nest under `commands.*`.** A top-level `pr`, `review`, `ask`, `chat`, `code`,
   `exec` or `api` key aborts the run. An unrelated unknown top-level key still only warns.
7. **`rating` is an object.** `rating: false` / `true` aborts; use `rating: { enabled: false }`.
8. **`*Provider*` renamed to `*Source*`, in every form.** Config keys (`contentProvider` →
   `contentSource`, `requirementsProvider` → `requirementSource`, and the `*Config` companions), CLI
   flags (`--content-provider` → `--content-source`, `--requirements-provider` →
   `--requirements-source`; `-p` still aliases the latter), and the `ContentProviderType` /
   `RequirementsProviderType` type exports, which are removed.
9. **Per-command `devTools` folded into `builtInTools`.** `commands.<cmd>.devTools` aborts; move
   `run_*` entries to `{ "command": … }` and `shell` to the `run_shell_command` entry. Note that a
   `builtInTools` object **replaces** the set it would otherwise inherit rather than extending it,
   and a per-command registry inherits nothing from the root.
10. **`projectGuidelines` and `projectReviewInstructions` folded into `prompts`.** Use
    `prompts.guidelines` and `prompts.review`.
11. **Eval suite `actions` enum strictness.** A suite declaring a partial or unrecognised `actions`
    enum list is now rejected at schema parse time. It previously filed the unmatched action under
    `(unrecognized)` and kept grading, so a typo scored instead of failing.
12. **The `gaunt-sloth` app package no longer exports modules.** Its `exports` map keeps only
    `./package.json`, so `import … from 'gaunt-sloth/<path>'` fails with
    `ERR_PACKAGE_PATH_NOT_EXPORTED`. Import from `@gaunt-sloth/core`, `@gaunt-sloth/agent` or
    `@gaunt-sloth/review` instead. The CLI binaries are unaffected.
13. **Slash command renames.** `/tools` → `/verbose` (no alias). `/mode` removed, folded into
    `/status`. `/yolo`, `/auto-approve` and `/bypass-approve` removed with no aliases.
    `/approvals <mode>` replaces all three, and there is no toggle, because with five ordered modes a flip has
    no unambiguous meaning. `/quit` added as an alias of `/exit`.

### Behaviour changes that raise no validation error

Nothing tells you at load time that these moved.

- **`writeOutputToFile` now defaults to `false`.** If you relied on the auto-saved
  `gth_<timestamp>_<COMMAND>.md` report files, set it to `true` or to a path.
- **Array merge policy across config layers changed.** Re-check any arrays in a config split across
  global and project layers.
- **The `output.header` default** (entry 4 above).

## Improvements

- **`gth review` and `gth pr` output opens with an attribution heading.** A fixed
  `## Gaunt Sloth: Code Review` line and one dynamic line naming the review mode and the model that
  served it. It is emitted from the product rather than from a workflow, so a third-party CI job
  posting the output to a pull request gets the attribution with no extra wiring, and it survives
  `output.header: "none"`.
- **`gth_gh_read_file` takes a size cap.** The GitHub file-read tool used during reviews now accepts
  `maxBytes` (default `614400`, 600 KiB) on its `builtInTools` entry. A file over the ceiling comes
  back cut at it, carrying a marker naming the tool and the cap, so the model knows it is reading an
  incomplete file. An out-of-range or non-numeric value falls back to the default.
- **Structured `gth eval` failure output.** A failing cell now takes its own `FAIL <id>` row with its
  reasons in a framed gutter beneath it, instead of one joined line. PASS lines are unchanged. This
  is formatting, distinct from the parse break in breaking change 11.
- **Hosted config schema.** The config JSON Schema is published at `gauntsloth.app/schema/v2/`, and a
  `$schema` key in a JSON config gives editors autocomplete and validation. The key is allowed by the
  schema and never read at runtime.
- **`-g/--global`.** Run against global user configuration only, bypassing the project's
  `.gsloth.config.*`. It conflicts with `--config`, which selects a config source explicitly, and the
  two together are rejected rather than silently ordered.
- **Up-tree project-config discovery.** Gaunt Sloth walks up from the current directory to find the
  project config, stopping at the git root, your home directory or the filesystem root — you can run
  it from a subdirectory.
- **TypeScript config.** A `configure()`-exporting `.gsloth.config.ts` is supported, loaded via jiti,
  alongside `.json`, `.js` and `.mjs`.
- **`--allow-dir` on `gth exec` has no effect in this release.** It widened filesystem access beyond
  the working directory for the removed `deep` backend. The flag still parses and warns; the agent
  reads and writes within the working directory only.
