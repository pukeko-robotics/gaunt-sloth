# Migrating to 2.0

Gaunt Sloth 2.0 is a **breaking config release**. The config schema is now validated
strictly (via a single Zod source of truth), and there is **no back-compat coercion** for
the old shapes. If you are coming from a 1.x config, read this page before you upgrade.

The fastest way to check a migrated config is:

```bash
gth config validate
```

It validates your effective config against the 2.0 schema **without** building an LLM or
running anything. Unknown top-level keys (likely typos) print a warning but do not fail; a
deprecated config-file shape or a real schema violation prints a path-scoped message and
exits non-zero. Use `gth config print` to see the fully-resolved config (secrets redacted)
after your edits.

## Upgrading from `gaunt-sloth-assistant` (1.x)?

The 2.0 line ships under a **renamed package**, `gaunt-sloth` — not `gaunt-sloth-assistant`,
which is the 1.x package name. Read this section before you run the install command, not
after.

**If `gaunt-sloth-assistant` is still installed globally, installing `gaunt-sloth` on top of
it can fail outright.** 2.0 no longer ships a `gaunt-sloth-assistant` bin — it declares three
bins (`gth`, `gsloth`, `gaunt-sloth`) — but the 1.x package owns those same names too, so
`npm i -g gaunt-sloth` can still hit `npm error EEXIST` on a bin shim the old package already
owns, and the **entire install aborts** — not just that one shim. The `npm rm -g` step below
is only needed by users who still have the 1.x `gaunt-sloth-assistant` package installed.

Confirmed via automated Windows CI (`windows-latest`, run
[29638001306](https://github.com/pukeko-robotics/gaunt-sloth/actions/runs/29638001306)):
after the failed install, `gth`/`gsloth`/`gaunt-sloth --version` (PowerShell *and*
`cmd.exe`) all kept silently reporting the **old 1.x version**, with no further error
surfaced — a user who doesn't notice the failed `npm i` output itself would have no other
sign they're still on 1.x. That CI run only exercised `windows-latest`; other platforms
were not separately verified either way, so treat the fix below as the safe, universal step
regardless of platform:

```bash
npm rm -g gaunt-sloth-assistant
npm i  -g gaunt-sloth@alpha
gth --version   # should now report the 2.x version, e.g. 2.0.0-alpha.18
```

Remove the old package **first**, then install the new one — do not install `gaunt-sloth`
while `gaunt-sloth-assistant` is still present.

## Severity at a glance

Every deprecated config-file shape is now a HARD error: 2.0 has no back-compat coercion, so
gth aborts on the old shape with a path-scoped message naming the replacement. Fix all of
these before you upgrade.

### HARD (gth aborts, or scripts break)

| Change | What breaks | Fix |
| --- | --- | --- |
| `rating` is now an object | `rating: false` (or any boolean) is a validation abort: `expected object, received boolean` | `rating: { enabled: false }` |
| Command configs must nest under `commands.*` | A top-level command key (e.g. `pr`) is a validation abort: `Top-level command config "pr" is no longer supported in 2.0. Move it under "commands.pr".` | Move it under `commands.<cmd>` |
| Per-command `devTools` folded into `builtInTools` | `commands.<cmd>.devTools` is a validation abort: `Config property "devTools" in commands.code is no longer supported in 2.0. Configure tools under "builtInTools" instead.` | Move the dev/shell tools into the `builtInTools` registry (see section G) |
| Approval knobs moved off `run_shell_command` | `yolo` / `judge` / `allowlist` / `persistAllowlist` on that entry are a validation abort: `Config property "yolo" in builtInTools.run_shell_command is no longer supported in 2.0. Use "approvals": "bypass" instead.` | Move them into the top-level `approvals` setting (see section I) |
| Approvals became one ladder of five modes | `approvals.strictness` / `.escalate` / `.allowlist` / `.persistAllowlist`, an object-form `rater`, and the `mode` values `ask` / `read-only` / `auto-safe` / `full-auto` are all validation aborts naming the mode that replaced them | Pick a mode: `manual` · `write` · `assisted` · `auto` · `bypass` (see section I) |
| `projectGuidelines` / `projectReviewInstructions` folded into `prompts` | Either key is a validation abort: `Config property "projectGuidelines" was renamed in 2.0. Use "prompts.guidelines" instead.` | `prompts.guidelines` / `prompts.review` (see section H) |
| Deprecated `*Provider*` config keys | `contentProvider` / `requirementsProvider` (and the `*ProviderConfig` variants) are rejected: `Config property "contentProvider" was renamed in 2.0. Use "contentSource" instead.` | Rename to `contentSource` / `requirementSource` (and `*SourceConfig`) |
| `--content-provider` / `--requirements-provider` CLI flags removed | Scripts passing those flags error out | `--content-source` / `--requirements-source` (`-p` still aliases `--requirements-source`) |
| `ContentProviderType` / `RequirementsProviderType` type exports removed, and the runtime `contentProvider` / `requirementsProvider` fields removed | TypeScript / programmatic configs that import those types or read those fields fail to compile or resolve | Use `contentSource` / `requirementSource` (and their `string` types) |
| The `gaunt-sloth` app package no longer exports modules (its `exports` map keeps only `./package.json`) | Any `import ... from 'gaunt-sloth/<path>'` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`; the CLI binaries (`gth`, `gsloth`, `gaunt-sloth`) are unaffected | Import from the scoped packages instead: `@gaunt-sloth/core`, `@gaunt-sloth/agent`, `@gaunt-sloth/review` (see each package's README for the embed surface) |
| The `deep` agent backend removed | `agent.backend: "deep"` is a validation abort: `Agent backend "deep" is no longer supported: Gaunt Sloth ships one agent backend.` | Remove the `agent` block, or set `"backend": "lean"` (see section J) |
| The ACP server stubbed | `gaunt-sloth-acp` and `gaunt-sloth --acp-agent` exit non-zero without serving; an ACP host (Zed, JetBrains) reports the agent as failing to start | Use the AG-UI server (`gth api`) or a terminal session until ACP returns (see section J) |

There is also one behaviour change (array merge across config layers) that is not a
validation error but can change results silently. It is covered in section D below.

---

## A. Command configs nest under `commands.*` (HARD)

In 2.0 the per-command settings (`pr`, `review`, `ask`, `chat`, `code`, `exec`, `api`)
live under a top-level `commands` object. A leftover top-level command key is now a hard
validation error that aborts the run, naming the fix:
`Top-level command config "pr" is no longer supported in 2.0. Move it under "commands.pr".`
(A genuinely-unrelated unknown top-level key, i.e. a real typo, still just warns; only the
known command names hard-fail.)

Before:

```json
{
  "llm": { "type": "anthropic" },
  "pr": {
    "requirementSource": "github"
  }
}
```

After:

```json
{
  "llm": { "type": "anthropic" },
  "commands": {
    "pr": {
      "requirementSource": "github"
    }
  }
}
```

## B. `rating` is now an object (HARD)

The old boolean shorthand for disabling review rating is gone. `rating` (under a command,
e.g. `commands.pr.rating` / `commands.review.rating`) is now an object:
`{ enabled?, passThreshold?, maxRating?, minRating?, errorOnReviewFail? }`. A boolean value
fails schema validation and aborts the run with `Invalid configuration ... expected object,
received boolean`.

Before:

```json
{
  "commands": {
    "pr": {
      "rating": false
    }
  }
}
```

After:

```json
{
  "commands": {
    "pr": {
      "rating": { "enabled": false }
    }
  }
}
```

If you were relying on the default (rating on), you do not need to add anything; only an
explicit `rating: false` (or `rating: true`) needs migrating.

## C. `*Provider*` names renamed to `*Source*` (HARD)

The historical `*Provider*` naming was renamed to `*Source*` across the board, and every
form of it is now a hard break: config-file keys, CLI flags, and TypeScript types.

**Config file keys (HARD).** In `.gsloth.config.*` the old keys are now rejected with a
validation error that names the replacement (e.g. `Config property "contentProvider" was
renamed in 2.0. Use "contentSource" instead.`). There is no one-way remap bridge anymore,
so rename them. The renames:

- `contentProvider` -> `contentSource`
- `requirementsProvider` -> `requirementSource`
- `contentProviderConfig` -> `contentSourceConfig` (root level)
- `requirementsProviderConfig` -> `requirementSourceConfig` (root level)

The per-command blocks accept the two source keys (`contentSource`, `requirementSource`);
the `*SourceConfig` companions live at the config root.

Before:

```json
{
  "contentProvider": "file",
  "requirementsProvider": "jira",
  "requirementsProviderConfig": {
    "cloudId": "...",
    "displayUrl": "https://your-org.atlassian.net"
  }
}
```

After:

```json
{
  "contentSource": "file",
  "requirementSource": "jira",
  "requirementSourceConfig": {
    "cloudId": "...",
    "displayUrl": "https://your-org.atlassian.net"
  }
}
```

**CLI flags (HARD).** The `--content-provider` and `--requirements-provider` flags are
removed. Update any scripts or CI to the new flags:

- `--content-provider` -> `--content-source`
- `--requirements-provider` -> `--requirements-source`

The short alias `-p` is preserved and still maps to `--requirements-source`, so
`gth pr -p github 123` keeps working.

Before:

```bash
gth pr --requirements-provider jira --content-provider file 123
```

After:

```bash
gth pr --requirements-source jira --content-source file 123
```

**TypeScript / programmatic configs (HARD).** The `ContentProviderType` and
`RequirementsProviderType` type exports are removed, and so are the runtime
`contentProvider` / `requirementsProvider` fields on the config object. Code that imports
those types or reads those fields will not compile / resolve. Use `contentSource` /
`requirementSource` (typed as `string`) instead.

Before:

```ts
import type { ContentProviderType } from '@gaunt-sloth/core';

export async function configure() {
  return {
    contentProvider: 'file' as ContentProviderType,
    requirementsProvider: 'jira',
  };
}
```

After:

```ts
export async function configure() {
  return {
    contentSource: 'file',
    requirementSource: 'jira',
  };
}
```

## D. Array merge policy across config layers (behaviour change)

When both a global config (`~/.gsloth/...`) and a project config are present, they are
deep-merged (project wins). In 2.0, arrays **replace** by default instead of merging across
layers. The only exceptions are the genuinely-cumulative lists, which still concatenate and
de-duplicate:

- `allowDirs`
- `aiignore.patterns`
- `approvals.deny` and `approvals.escalate` — wherever they appear, including under
  `commands.<cmd>.approvals`. These are the rules you forbid, and a prohibition another layer can
  quietly delete is not a prohibition, so no layer can narrow another's, only add to them.
  `approvals.allow` is **not** additive: it is the permissive list, so it keeps replace semantics
  and a layer that states its own replaces the layer below.

Every other array (`allowedTools`, `builtInTools`, `tools`, `middleware`, `binaryFormats`,
and so on) is now taken wholesale from the higher-precedence layer. So if you were leaning
on a global config to contribute, say, extra `allowedTools` that got unioned with the
project list, that no longer happens: define the full set in the layer that should own it.

This is not a validation error and `gth config validate` will not flag it. It only matters
when you split config across the global and project layers. `gth config print` shows the
final merged result, which is the quickest way to confirm the effective arrays.

## E. `writeOutputToFile` now defaults to `false` (behaviour change)

In 1.x every command wrote its response to a timestamped `gth_<timestamp>_<COMMAND>.md`
file (under `.gsloth/` or the project root) unless you turned it off. These files
accumulate quickly — especially from interactive `chat`/`code` sessions, whose transcript
you already saw live — so in 2.0 the default flips: **nothing is written to disk unless you
opt in.**

`writeOutputToFile` still accepts the same values; only the default changed:

- `false` (new default) — no output file is written
- `true` — restores the old behaviour (standard `gth_<timestamp>_<COMMAND>.md` name)
- a string — a custom path, unchanged (see [Configuration → Output files](configuration/output.md#controlling-output-files))

**If you relied on the auto-saved files** (for example, a CI job that reads back the review
output), set it explicitly:

```json
{
  "writeOutputToFile": true
}
```

**If your CI already passes an explicit value** — a string path like `"reviews/last.md"` or
`writeOutputToFile: true`, whether in config or via `-w/--write-output-to-file` — nothing
changes; those configs keep working exactly as before. This flip only affects setups that
were leaning on the implicit `true` default.

## F. New in 2.0 (additive, nothing to migrate)

These are new capabilities, not breaking changes, but they are useful while migrating:

- **Up-tree project-config discovery.** Gaunt Sloth walks up from the current directory to
  find the project config, stopping at the git root, your home directory, or the filesystem
  root (whichever comes first). You can run it from a subdirectory of your project.
- **TypeScript config (`.gsloth.config.ts`).** A `configure()`-exporting `.ts` config is
  now supported (loaded via jiti), alongside `.json`, `.js`, and `.mjs`.
- **Generated JSON Schema + `$schema` editor support.** The config shape is published as a
  JSON Schema, and you can add a `$schema` key to your JSON config for editor autocomplete
  and validation. The `$schema` key is allowed by the schema and never read at runtime.
- **`gth config validate` and `gth config print`.** Validate a migrated config against the
  2.0 schema (`validate`), or inspect the fully-resolved config with secrets redacted
  (`print`, add `--json` for machine-readable output). Both honour `--config` and
  `--identity-profile`.

## G. `devTools` folded into `builtInTools` (HARD)

In 1.x the dev/shell tools were split across two keys: `builtInTools: string[]` (which built-in
tools are on) and a per-command `commands.<cmd>.devTools` (how the `run_*` commands and the
`run_shell_command` shell tool were configured). 2.0 unifies both into a single **`builtInTools`
registry**. A leftover `commands.<cmd>.devTools` is now a hard validation error:
`Config property "devTools" in commands.code is no longer supported in 2.0. Configure tools under
"builtInTools" instead.`

`builtInTools` now accepts an **object** (keyed by tool name) in addition to the string array. The
object's values enable (`true`), force-disable (`false`), or configure (an object) each tool. The
`run_*` dev-command tools take `{ "command": "…" }`; the shell tool takes its execution knobs
(`enabled` / `timeout` / `maxOutputBytes`). Approval settings — including the former top-level
`shellYolo` — moved to the top-level `approvals` block instead (section I).

Before:

```json
{
  "builtInTools": ["gth_checklist"],
  "commands": {
    "code": {
      "devTools": {
        "run_tests": "npm test",
        "run_lint": "npm run lint-n-fix",
        "shell": { "enabled": true, "timeout": 300000 },
        "shellYolo": true
      }
    }
  }
}
```

After:

```json
{
  "commands": {
    "code": {
      "builtInTools": {
        "gth_checklist": true,
        "run_tests": { "command": "npm test" },
        "run_lint": { "command": "npm run lint-n-fix" },
        "run_shell_command": { "enabled": true, "timeout": 300000 }
      }
    }
  },
  "approvals": { "mode": "bypass" }
}
```

Notes:
- The object form (like the array form) **replaces** the default `["gth_checklist"]` set, so list
  `"gth_checklist": true` if you want to keep it.
- `run_shell_command` is **ON by default in `code` mode** (still human-gated); turn it off with
  `{ "run_shell_command": false }`.
- The string-array form still works for tools that need no configuration
  (`"builtInTools": ["gth_checklist", "gth_web_fetch"]`).

## H. Flat prompt keys folded into the `prompts` object (HARD)

The flat `projectGuidelines` and `projectReviewInstructions` keys are removed. Prompt-file
config now lives in one `prompts` object whose segments
(`backstory | guidelines | system | chat | code | exec | review`) each accept a string path or
an object `{ path?, enabled?, mode? }` — see
[Configuration → Prompts](configuration/prompts.md#prompt-files-prompts). A leftover flat key is
a hard validation error naming the replacement:
`Config property "projectGuidelines" was renamed in 2.0. Use "prompts.guidelines" instead.`

Before:

```json
{
  "projectGuidelines": "AGENTS.md",
  "projectReviewInstructions": "REVIEW.md"
}
```

After:

```json
{
  "prompts": {
    "guidelines": "AGENTS.md",
    "review": "REVIEW.md"
  }
}
```

**`gth init` no longer plants template files.** In 1.x, `init` (and the first-run dialog)
copied starter `.gsloth.guidelines.md` and `.gsloth.review.md` files into your project; the
guidelines template made the assistant nag about filling it in. 2.0 writes only
`.gsloth.config.json`: review behaviour is unchanged (the bundled review prompt is a complete
real prompt), and guidelines default to empty until you create the file — or point
`prompts.guidelines` at one you already have (e.g. `AGENTS.md`). Existing planted files keep
working; they are simply no longer created for you.

## I. Approvals and the auto-rater (HARD)

Approvals used to hang off the `run_shell_command` entry of `builtInTools` — the object shared by
**every** built-in tool, so a nonsensical `"gth_grep": { "yolo": true }` validated happily. There is
now a single top-level `approvals` setting, and every retired key is a hard validation error naming
its replacement.

`approvals` is **one ordered ladder of five modes**. Each mode fully determines behaviour: there are
no severity thresholds, no strictness levels, and no independent rater switch.

| # | Mode | Rater |
| --- | --- | --- |
| 1 | `manual` | no |
| 2 | `write` | no |
| 3 | `assisted` (the default) | yes |
| 4 | `auto` | yes |
| 5 | `bypass` | no |

`write` is a variant of `manual` rather than a step of its own: the same posture, with edits inside
your working folder granted as well as reads. The choice you are really making is
`manual` → `assisted` → `auto`, plus `bypass`.

### Old → new

| Old | New |
| --- | --- |
| `builtInTools.run_shell_command.yolo: true` | `"approvals": "bypass"` |
| `builtInTools.run_shell_command.judge: true` | `"approvals": "assisted"` |
| `judge.model` | `approvals.rater` — an **identity profile name**, not a raw model block |
| `judge.autoApproveLow: false` / `judge.blockHigh` | gone — the mode decides; there are no per-tier knobs |
| `builtInTools.run_shell_command.allowlist` | `approvals.allow` — a declared list of command prefixes |
| `builtInTools.run_shell_command.persistAllowlist` | gone — persistence is a per-decision choice at the prompt (*approve* forgets, *always approve* persists) |
| `approvals.mode: "read-only"` | `approvals.mode: "manual"` — the same mode, renamed |
| `approvals.mode: "auto-safe"` | `approvals.mode: "assisted"` — the same mode, renamed |
| `approvals.mode: "full-auto"` | `approvals.mode: "auto"` — the same mode, renamed |
| `approvals.mode: "ask"` | `approvals.mode: "write"` (the agent still edits files freely) or `"manual"` (it asks before writing too) |
| `approvals.rater: { profile: "x" }` | `approvals.rater: "x"` |
| `approvals.rater.strictness` | gone — choose a mode instead |
| `approvals.rater.escalate` | gone — both `assisted` and `auto` escalate everything not rated safe |
| `approvals.allowlist` / `approvals.persistAllowlist` | `approvals.allow` / gone (as above) |
| `run_shell_command` keeps | `enabled`, `timeout`, `maxOutputBytes` |

The rater's scale changed with it: `safe` / `caution` / `danger` / `critical` became **four
outcomes** — `safe`, `destructive`, `catastrophic` and `attack`.

| Outcome | What it means | What happens |
| --- | --- | --- |
| `safe` | no harmful effect | runs without asking |
| `destructive` | harmful, but undoable from inside the session — **the catch-all**, including anything the rater cannot assess | asks you |
| `catastrophic` | cannot be undone from inside the session (`mkfs`, `DROP DATABASE`, `terraform destroy -auto-approve`) | asks you every time; *session* and *always* do not stick |
| `attack` | the command's own structure shows something hostile — a credential targeted for its own sake, privilege escalation, persistence, an impersonated hostname, obfuscation | ends the run |

Pushing and publishing to a destination your project already configures (`git push`, `npm publish`,
`docker push`) is ordinary work: it may be rated `destructive` and asked about, but it never ends
the run. To let a halted command run anyway, declare it in `approvals.allow` — that list is checked
before the rater.

Before:

```json
{
  "commands": {
    "code": {
      "builtInTools": {
        "run_shell_command": {
          "allowlist": false,
          "judge": { "enabled": true, "autoApproveLow": false, "blockHigh": true }
        }
      }
    }
  }
}
```

After:

```json
{ "approvals": "assisted" }
```

Or, if you want to name the rater's model and declare what it may and may not run:

```json
{
  "approvals": {
    "mode": "assisted",
    "rater": "safety-rater",
    "allow": [
      { "type": "shell", "matcher": "exact", "pattern": "npm test" },
      { "type": "shell", "matcher": "glob", "pattern": "git status*" }
    ],
    "deny": [
      { "type": "shell", "matcher": "glob", "pattern": "npm publish*" },
      { "type": "shell", "matcher": "glob", "pattern": "git push --force*" }
    ]
  }
}
```

Every entry in `allow`, `deny` and `escalate` is one explicit object — `type`, `matcher` and
`pattern` are always required, and a bare string is a config error whose message shows you the
object to write instead. The fields are listed in
[Shell tool & approvals](guides/shell-tool-and-approvals.md).

**Two behaviour changes to expect.**

1. **The default is `assisted` everywhere**, interactive or not, and it does not vary with the
   configured model. Clearly-safe commands run without a prompt, and each gated command costs one
   rater model call. To keep confirming every command yourself, set `"approvals": "write"`.
2. **Where there is nobody to ask, an escalation exits non-zero** rather than handing the model a
   rejection and continuing. A CI run, a one-shot `gth exec` or a server now fails loudly — printing
   the command, its rating and the reason — instead of quietly continuing without the command.
   Declare what the pipeline may run in `approvals.allow`, which is checked before the rater and
   therefore never escalates.

See [Shell tool & approvals](guides/shell-tool-and-approvals.md).

## J. The `deep` agent backend and the ACP server (HARD)

Gaunt Sloth's optional second agent backend, `deep`, was a wrapper around a third-party agent
runtime. It is gone, and with it the only ACP (Agent Client Protocol) server implementation, which
was built on it.

### `agent.backend: "deep"`

A config still naming it **fails to load**:

```
Agent backend "deep" is no longer supported: Gaunt Sloth ships one agent backend.
Use "lean" — the only backend there is. …
```

Remove the `agent` block, or set `"backend": "lean"`. It is a hard error rather than a silent
fallback on purpose: a config asking for `deep` is asking for behaviour that no longer exists, and
running a different agent without saying so would surface later as an unexplained change in what
the agent can do.

What actually changes, if you were using it:

| What `deep` provided | Where you stand now |
| --- | --- |
| Subagent dispatch (the `task` tool) | Not available. `subagents` stays a valid config key and a run that declares one says so, but nothing spawns them. |
| Automatic history summarization | Not available. |
| Large-tool-result offload to a file | Not available; oversized tool results are truncated instead. |
| The toolset, the composed system prompt, the approvals gate, `gth_checklist`, `gth_grep` | Unchanged — these were never `deep`-only. |

### The ACP server

`gaunt-sloth-acp` and `gaunt-sloth --acp-agent` still exist and still resolve — removing them would
break an editor that has the command wired in — but they now print an explanation and exit
non-zero. If you drive Gaunt Sloth from an ACP host (Zed, JetBrains), that integration stops
working until ACP is rebuilt on Gaunt Sloth's own agent.

Meanwhile: `gth api` runs the AG-UI server for a programmatic front door, and `gth chat` / `gth
code` run in a terminal.

## Interactive slash commands (renames)

Inside `chat`/`code` sessions (both the TUI and the plain `--no-tui` readline surface, which now
share one command registry):

- `/tools` renamed to `/verbose` — same tool-detail toggle. `/tools` is removed (no alias; 2.0
  is still in alpha).
- `/mode` removed — its output is folded into `/status`.
- `/quit` added as an alias of `/exit`.
- `/yolo`, `/auto-approve` and `/bypass-approve` are **removed** (no aliases). `/approvals <mode>`
  replaces all three: `/approvals bypass` for the first two's unconditional behaviour, and
  `/approvals write` to confirm every command yourself. There is no toggle — with five ordered
  modes a flip has no unambiguous meaning, which is also why `/auto-approve off` could not survive:
  it had to mean one of two different modes.
- `/approvals` shows the current mode, the rater and the allow/deny counts, and switches with
  `/approvals manual|write|assisted|auto|bypass`; with no argument on a terminal it also offers a
  picker.

## Migration checklist

1. Move top-level command keys (`pr`, `review`, `ask`, `chat`, `code`, `exec`, `api`) under
   `commands.*` (A).
2. Convert any `rating: false` / `rating: true` to `rating: { enabled: false }` /
   `{ enabled: true }` (B).
3. Rename `*Provider*` config keys to `*Source*`, update CLI flags in scripts, and update
   any TypeScript that imported the removed provider types (C).
4. If you split config across global + project, re-check arrays that used to merge (D).
5. If you relied on the auto-saved `gth_<timestamp>_<COMMAND>.md` output files, set
   `writeOutputToFile: true` (or a string path) — the default is now `false` (E).
6. Move any `commands.<cmd>.devTools` into the `builtInTools` registry (`run_*` → `{ "command": … }`,
   `shell` → the `run_shell_command` entry) (G).
7. Replace every approvals knob — `yolo` / `judge` / `allowlist` / `persistAllowlist` on
   `run_shell_command`, and `strictness` / `escalate` / an object-form `rater` on `approvals` —
   with one of the five modes, plus `approvals.allow` / `.deny` where you need them. Rename the
   retired `mode` values: `read-only` → `manual`, `auto-safe` → `assisted`, `full-auto` → `auto`
   (all three the same mode under a new name), and `ask` → `write` if you want file edits in your
   working folder granted, or `manual` if you want to be asked about those too. Decide whether you
   want the new `assisted` default or `"write"` (I).
8. Rename `projectGuidelines` → `prompts.guidelines` and `projectReviewInstructions` →
   `prompts.review` (H).
9. Remove `agent.backend: "deep"` (or set it to `"lean"`), and move off the ACP server if you
   were driving Gaunt Sloth from an ACP host (J).
10. Run `gth config validate` (and optionally `gth config print`) to confirm the result.
