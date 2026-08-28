# Configuration

> **Upgrading from 1.x?** 2.0 is a breaking config release. See [Migrating to 2.0](../MIGRATION.md)
> for the HARD vs SOFT change list and before/after snippets, then run `gth config validate` to
> check your migrated config.

Gaunt Sloth runs from a directory tree that contains a config file. The fastest way to create one is
the interactive walkthrough:

```bash
gth init
```

It detects which providers are already usable (an API key set, or a local Ollama running) and lists
those first, asks you to pick a provider and then a model from that provider's live catalog
(preferred models are starred), and asks whether to store the config for this project
(`.gsloth/.gsloth-settings/`) or globally for all projects (`~/.gsloth/`). If a config already
exists at the chosen location, it asks before overwriting.

Pass `-g`/`--global` to skip that question and write straight to the global config, and
`-i, --identity-profile <name>`/`--profile <name>` to create a named profile instead of the
unscoped config — the folder labels in the dialog change to spell out the profile subdirectory
(`.gsloth/.gsloth-settings/<name>` / `~/.gsloth/.gsloth-settings/<name>`). See
[Creating a profile](profiles.md#creating-a-profile) for the profile walkthrough.

Already know the provider? Pass it directly and skip the dialog:

```bash
gth init anthropic
```

Either way you get a `.gsloth.config.json` — the project-scoped one lands in
`.gsloth/.gsloth-settings/` (the `.gsloth` directory is created if needed) — that you can commit
and tune. From there, follow the page for whatever you want to set up:

| Page | What it covers |
|---|---|
| [Providers](providers.md) | Per-provider setup (Anthropic, Vertex AI, OpenAI, Groq, Ollama, …) and the model-identity prompt. |
| [Tools](tools.md) | Built-in tools, the shell tool, content search, custom tools, middleware, and the allow-list. |
| [MCP servers](mcp.md) | Connecting MCP servers, including remote OAuth and TLS trust. |
| [Content sources](content-sources.md) | Pulling review requirements from GitHub issues or Jira, and change-requirements discovery. |
| [Prompts](prompts.md) | The `prompts` object — guidelines, review, system, and the other prompt segments. |
| [Output & files](output.md) | Where and whether `gth` writes output, run headers, logging, colour, and redaction. |
| [Profiles & runtime](profiles.md) | Named identity profiles, subagents, the AG-UI server, and the agent backend. |

## Config file names and discovery

A config file is one of these, in the project root or under `.gsloth/.gsloth-settings/`:

- `.gsloth.config.json` (JSON)
- `.gsloth.config.jsonc` (JSON with comments)
- `.gsloth.config.js` (JavaScript module)
- `.gsloth.config.mjs` (JavaScript module, explicit extension)

When more than one exists in the same location, the first match wins in the order
`.json` → `.jsonc` → `.js` → `.mjs`. The same order applies to the global `~/.gsloth/` config.
Gaunt Sloth walks up the directory tree to find the nearest config, so it works from a subdirectory
of a monorepo — see [Work in a monorepo](../guides/monorepo.md).

Both JSON names get lenient JSONC parsing — comments and trailing commas work in either. Use the
`.jsonc` name when you want comments without editors flagging them as invalid JSON. You can also
point at a config directly with the `-c`/`--config` flag:

```bash
gth -c /path/to/config.json ask "who are you?"
```

Use a JavaScript config (`.gsloth.config.js`/`.mjs`) when you need custom middleware or tools that
JSON can't express — see [Providers → JavaScript configuration](providers.md#javascript-configuration).

## The global config and your project config

Your project config wins, but it does not replace the global one — it overrides only the keys it
sets, and the global's other keys stand. The global `~/.gsloth/.gsloth.config.*` loads first and
your project config merges on top of it, on every run. So settings you want everywhere (your
provider and model, `tui`, `writeOutputToFile`) belong in the global config, and a project config
only has to state what it changes. With no project config anywhere up-tree, the global config is
used on its own.

Arrays are the exception to the merge: most replace across layers instead of combining, and a few
accumulate — see
[Array merge policy across config layers](../MIGRATION.md#d-array-merge-policy-across-config-layers-behaviour-change).

The global layer cannot be turned off: there is no flag, environment variable or config key for it,
and neither `-c`/`--config` nor `-i`/`--identity-profile` (`--profile`) bypasses it — each chooses the
*project*-layer config that merges over the global one. See
[Identity profiles](profiles.md#identity-profiles) for where a profile sits in the full precedence
chain.

### Run under the global config only

`-g`/`--global` drops the project layer instead: config discovery does not walk up from the working
directory, and configuration resolves from `~/.gsloth/` alone. Use it when you want a run to use
your own configuration — provider, model, tools, approvals — rather than whatever the repository
you are standing in configures:

```bash
gth -g review
```

With `-i`/`--profile`, the named profile's config is resolved globally too, from
`~/.gsloth/.gsloth-settings/<name>/` — so this reads your own `devops` config and never the
project's, and fails if you have no global `devops` profile:

```bash
gth -g -i devops pr 42
```

`-g` scopes **configuration** only; it is not a boundary around the project directory. Prompt files
([guidelines, review checklist and the rest](prompts.md)) still resolve from the working directory
as usual, falling back to the built-in defaults — so a project's own guidelines or review prompt are
read into the prompt under `-g` just as they are without it.

`-g` and `-c` cannot be combined: both choose where configuration comes from, so passing the pair
is rejected rather than silently honouring one of them.

To see what a run actually resolves to, print the effective merged config; to find which file to fix
when a key is wrong, validate each layer on its own:

```bash
gth config print
gth config validate
```

## Using the `.gsloth` directory

Create a `.gsloth` directory in your project root for a tidier layout. When it exists, Gaunt Sloth:

1. writes output files (command responses) into `.gsloth/` instead of the project root, and
2. looks for config in `.gsloth/.gsloth-settings/`.

```
.gsloth/.gsloth-settings/.gsloth.config.json
.gsloth/.gsloth-settings/.gsloth.guidelines.md
.gsloth/.gsloth-settings/.gsloth.review.md
.gsloth/gth_2025-05-18_09-34-38_ASK.md
```

Without a `.gsloth` directory, everything stays in the project root. `gth init` creates the
directory and writes config into `.gsloth/.gsloth-settings/` by default; there is no automatic
migration, so if you add a `.gsloth` directory after initializing, move your existing config files
into `.gsloth/.gsloth-settings/` by hand.

## AI ignore (`.aiignore`)

Hide files and directories from the filesystem tools with a `.aiignore` file in the project root.
Lines starting with `#` are comments.

```
node_modules/
dist/
*.log
```

Control it in config with `aiignore.enabled` (boolean, default `true`) and `aiignore.patterns` (an
array supplied directly instead of reading `.aiignore`):

```json
{
  "aiignore": {
    "enabled": true,
    "patterns": ["node_modules/", "dist/", "*.log"]
  }
}
```

When `.aiignore` is missing, Gaunt Sloth logs that at debug level only.

### Pattern rules

Patterns follow `.gitignore` rules, with the exceptions noted below. Paths are matched relative to
the working directory.

| Pattern | Hides |
|---|---|
| `*.log` | every `.log` file at any depth — `app.log` and `sub/app.log` alike |
| `secrets.txt` | any file or directory of that name, at any depth |
| `dist/` | the `dist` directory and everything inside it |
| `build/out` | only `build/out` and its contents — not `src/build/out` |
| `/dist` | only a `dist` at the project root, not one nested deeper |

Two rules carry most of the weight:

- **A pattern without a `/` applies at every depth.** `*.log` reaches into subdirectories; you do
  not need to write `**/*.log`.
- **A pattern that names a directory hides its name and its whole subtree.** One line is enough:
  `secretdir` removes the directory from every listing *and* withholds every file beneath it. You
  do not need a second `secretdir/**` line.

A pattern containing a `/` is anchored to the working directory instead of applying at every depth,
which is what makes `build/out` above miss `src/build/out`. A leading `/` anchors an otherwise-bare
pattern the same way.

Two deliberate differences from `.gitignore`:

- **A trailing `/` does not restrict the match to directories.** `dist/` and `dist` behave
  identically, so a *file* named `dist` is hidden too. Matching directories only would require
  knowing each entry's type, and `.aiignore` errs toward hiding: a file wrongly hidden is visible
  to you and easy to rename around, whereas the opposite mistake silently exposes something you
  asked to be hidden.
- **Re-inclusion (`!pattern`) is not supported.** A leading `!` is matched literally rather than
  un-hiding anything, so you cannot carve an exception out of a broader pattern. Narrow the
  pattern instead.

`.aiignore` keeps matching files out of what the filesystem and search tools disclose — directory
listings, file searches, and `gth_grep` results and the file contents behind them. It is a privacy
boundary rather than a tidiness setting, which is why the rules above resolve every ambiguity by
hiding more rather than less.

## The full config object

The pages above cover each area in depth. For the exhaustive, type-checked surface — every key and
its default — see the generated reference:

- [`GthConfig` interface](https://gauntsloth.app/docs/interfaces/config.GthConfig.html)
- [`DEFAULT_CONFIG` values](https://gauntsloth.app/docs/variables/config.DEFAULT_CONFIG.html)
- Source of truth: [`packages/core/src/config/schema.ts`](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/packages/core/src/config/schema.ts)
