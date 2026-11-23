# Identity profiles and runtime

A **named identity profile** is a config directory — `.gsloth/.gsloth-settings/<name>/` — that
carries its own `llm` block, prompt files, and tool selection. Selecting one with `-i <name>` swaps
the entire project-file config layer for that directory, so one team, one task, or one model can be
a single-flag switch with nothing to edit between runs. This page is the reference for profiles, for
handing a sub-task to a subagent running under a **different** profile (`subagents`), and for the two
runtime knobs that sit alongside them — the AG-UI server config and the `agent.backend` selector.

For the model-switching recipe (a cheap profile for questions, a strong one for review), see
[Choose and switch models](../guides/choose-and-switch-models.md); this page is the deep reference
it points to.

## The main use case: a DevOps identity with its own model, guidelines, and review prompt

Goal: your DevOps team reviews PRs against infra/security concerns with their own model and their own
review checklist, while developers keep the default project config — no shared config to fight over.

Scaffold a profile, seeding it with the model DevOps wants:

```bash
gth config profile create devops --model claude-sonnet-5-5
```

That writes `.gsloth/.gsloth-settings/devops/.gsloth.config.json`. Drop the DevOps-specific prompt
files next to it in the same directory — an infra/security `.gsloth.guidelines.md` and a
`.gsloth.review.md` review checklist:

```
.gsloth/.gsloth-settings/devops/.gsloth.config.json
.gsloth/.gsloth-settings/devops/.gsloth.guidelines.md
.gsloth/.gsloth-settings/devops/.gsloth.review.md
```

Now review a PR under that identity:

```bash
gth -i devops pr 42
```

The config, guidelines, and review prompt all come from the `devops/` directory instead of the
project defaults. Any prompt file you didn't create in the profile falls back to the installation
default, so you only author the ones DevOps needs to differ on. Run `gth pr 42` without `-i` and the
config resolves from the default `.gsloth/.gsloth-settings/` directory as usual — developers are
unaffected.

## Identity profiles

Sometimes two different teams have different perspectives of a project. For example, developers may
want to review the code for code quality; DevOps may want to be notified when some configuration
files or docker image change. Their configurations of Gaunt Sloth may be so different that it is
better to keep them in complete separation. Identity profiles define different Gaunt Sloth identities
for different purposes.

Identity profiles can only be activated in directory-based configuration. When
`gth -i devops pr PR_NO` is invoked, the configuration is pulled from the
`.gsloth/.gsloth-settings/devops/` directory, which may contain a full set of config files:

```
.gsloth.backstory.md
.gsloth.config.json
.gsloth.guidelines.md
.gsloth.review.md
```

When no identity profile is specified in the command, for example `gth pr PR_NO`, the configuration
is pulled from the `.gsloth/.gsloth-settings/` directory.

`-i` / `--identity-profile` (or its alias `--profile`) overrides the entire configuration directory,
which means it should contain a configuration file and prompt files. In the case where some prompt
files are missing, they will be fetched from the installation directory. (The individual
[prompt files](./prompts.md) — backstory, guidelines, system, review, and the per-mode prompts — are
resolved from the selected profile directory first.)

**Precedence.** A selected profile replaces the *project-file* layer of the config cascade with the
profile directory's config; everything else stacks as usual:

```
explicit CLI flags (-c, --model, --verbose, -w)  >  profile-dir config  >  global ~/.gsloth config  >  built-in defaults
```

So a profile is the highest-precedence *file* layer, still overridable by explicit command-line
flags, and still sitting on top of your global `~/.gsloth` config and the built-in defaults. Naming a
profile that has no config file of its own is an error: the run stops rather than silently falling
back to some other config — not to your global `~/.gsloth` config, and not to the project's own
plain `.gsloth.config.*` either, which is the fallback you would otherwise get and the surprising
one. A mistyped `-i` therefore tells you so, instead of running under a model you did not choose.

**Where a profile is looked up.** By default, in the project: `.gsloth/.gsloth-settings/<name>/`,
searched from the working directory up to the repository root. Add
[`-g`/`--global`](index.md#run-under-the-global-config-only) and the same name is looked up in
`~/.gsloth/.gsloth-settings/<name>/` instead — your own profiles, in a repository that knows nothing
about them. The two are separate namespaces: a profile that exists only in the project is not found
under `-g`, and vice versa. A global profile's prompt files are read from its own directory first,
so a relative `prompts` path in its config is resolved next to that config.

### Creating a profile

Two ways to create a profile, depending on how you want it seeded:

- **`gth init -i <name>`** walks the same CFG-2 provider/model dialog as a plain `gth init`, then
  writes into the named profile instead of the unscoped config. Use this when you want to pick the
  provider and model interactively (from the live catalog, preferred models starred) rather than
  seed from something that already exists. Add `-g` to create the profile under
  `~/.gsloth/.gsloth-settings/<name>/` instead of the project:

  ```bash
  gth init -i test2          # .gsloth/.gsloth-settings/test2/.gsloth.config.json
  gth init -g -i test2       # ~/.gsloth/.gsloth-settings/test2/.gsloth.config.json
  ```

  `gth init -i <name> <provider>` (the scriptable path, e.g. `gth init -i test2 anthropic`) skips
  the dialog and writes the project profile directly; add `-g` to target the global profile instead.

- **`gth config profile create <name>`** scaffolds a new profile directory
  (`.gsloth/.gsloth-settings/<name>/.gsloth.config.json`), seeded from your *current effective
  config* (or a minimal template when none resolves) and schema-validated before it is written.
  Pass `--model <id>` to set the profile's model (one your seeded config's provider serves), and `--force` to overwrite an existing profile.
  Use this when the new profile should start as a copy of what you already have.

  For example, on a Gemini setup, to add a cheap flash profile alongside it and then run under it:

  ```bash
  gth config profile create cheap --model gemini-3.8-flash
  gth --profile cheap ask "summarise the open TODOs in this repo"
  ```

Either way you end up with an ordinary config file at `.gsloth/.gsloth-settings/<name>/.gsloth.config.json`
(or its global counterpart) that you can go on to edit — adjust its tools, prompts, or provider as needed.

## Run-level tool coverage (evalToolCoverage)

A directory of eval suites over one MCP server shares one tool surface, and the coverage figure that
describes it is the union across the run, not any suite's own fraction — each suite is graded against
the whole surface, so a `min` it could clear gates nothing. `evalToolCoverage` is the floor over that
union. It is a top-level key, and a profile is the intended place for it: the same profile that
declares the server under test in `mcpServers` declares the floor over that server's surface, and one
CI step per profile grades one server.

```json
{
  "mcpServers": { "unimarket": { "command": "unimarket-mcp" } },
  "evalToolCoverage": { "min": 13, "waive": ["read_file", "write_file"] }
}
```

```bash
gth -i mcp-eval-root eval evals/
```

| Field | Meaning |
|---|---|
| `min` | Minimum percentage (0–100) of the run's denominator that must have been exercised. Graded against the run's aggregate, independently of any suite's own `tool_coverage.min` — neither is promoted into the other, and a failure names the floor that breached. |
| `waive` | Tool-name patterns (the same globs `must_call` uses) removed from the run's denominator, even when no suite waives them. A suite's own waiver does not shrink the run denominator. |

The denominator the floor grades is the aggregate's reconciled one — a tool waived in one suite but
counted in another stays counted, and a tool waived in every suite is already out — minus this key's
`waive`. A tool the run waives leaves the denominator even if some suite covered it. A `waive` entry
that matches nothing advertised warns, naming the pattern: a renamed tool is back in the denominator
under its new name while the config still claims it is waived.

The floor is resolved once, before any suite runs, from the config the run was started with. With
`-i` that is the named profile; with `-c`, that file; otherwise the project config, or the global
config when there is no project config. A value set in both the project and the global config merges
the way any other key does. It is never taken from an identity's config or from a sweep cell's
`config` — a suite that declares `identities:` builds one config per identity, and the floor must not
depend on which of them ran first. With no base config the run has no floor, and the output says so.
The output names the source either way, for a run of one suite as well as for a directory. A
malformed value stops the run before anything runs (exit `2`). A `min` set over a run where no
suite produced a coverage report fails rather than passing: a floor quietly skipped reports green
forever over a run it never measured.

Absent, the run has no floor. There is no default, and the key does not appear in a config that never
set it. See [Tool coverage](../COMMANDS.md#tool-coverage) for what the figure counts.

## Named-profile subagents (subagents)

`subagents` lets the agent delegate a sub-task to a subagent that runs under a **different
[named profile](#identity-profiles)** — its own model, tools, and prompt — instead of the parent's.
The typical use: keep the parent on a strong (expensive) model but hand routine search/recall work to
a cheap one, so the bulk of the tokens are spent on the cheap model.

Each entry names a subagent (the name the model selects it by) and the profile the child resolves:

```json
{
  "llm": { "type": "anthropic", "model": "claude-opus-5-5" },
  "subagents": [
    { "name": "recall", "description": "Cheap read-only search/recall.", "profile": "cheap" }
  ]
}
```

To make the example above run, create the `cheap` profile it references, then start a coding session —
when the model delegates a recall task, that subagent runs on `claude-haiku-5-5`, not on the
parent's `claude-opus-5-5`:

```bash
gth config profile create cheap --model claude-haiku-5-5
gth code
```

The child resolves the named profile through the same config cascade a top-level `--profile` run does,
so it picks up that profile's model, tool selection, and prompt files. A subagent whose `profile` has
no config directory is an error, exactly as selecting a missing profile with `--profile` is.

> **Not dispatched yet.** No agent backend spawns subagents at present, so a declared `subagents`
> block has no effect on a run. It stays a valid config key rather than an error, and a run that
> declares one prints a warning naming the subagents it did not use — so the setting is announced,
> never quietly ignored. Write the block now if you want it in place; expect no delegation until
> subagent dispatch ships.

## AG-UI Server Configuration

The `api ag-ui` command reads its settings from `commands.api` in your config file.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `commands.api.port` | `number` | `3000` | Port the AG-UI server listens on |
| `commands.api.host` | `string` | `"127.0.0.1"` | Interface the AG-UI server binds. The default is loopback, so only clients on the same machine can reach it; `"0.0.0.0"` (or `"::"` for IPv6 as well) accepts connections from the network, which — since the endpoint has no authentication — exposes the agent to anything that can route to it |
| `commands.api.cors.allowOrigin` | `string` | `"http://localhost:3000"` | `Access-Control-Allow-Origin` header value |
| `commands.api.cors.allowMethods` | `string` | `"POST, GET, OPTIONS"` | `Access-Control-Allow-Methods` header value |
| `commands.api.cors.allowHeaders` | `string` | `"Content-Type, Accept"` | `Access-Control-Allow-Headers` header value |

**Example config for the Galvanized Pukeko web client on port 5555:**

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-5-5"
  },
  "commands": {
    "api": {
      "port": 3000,
      "cors": {
        "allowOrigin": "http://localhost:5555",
        "allowMethods": "POST, GET, OPTIONS",
        "allowHeaders": "Content-Type, Accept"
      }
    }
  }
}
```

> **Note:** The CLI flags override the config file — `--port` over `commands.api.port`, `--host`
> over `commands.api.host`, `--cors-origin` over `commands.api.cors.allowOrigin`. The origin has a
> flag because it is the other half of the port: whatever moves the web client changes its origin at
> the same moment, and the thing that moved it cannot rewrite this file.

## Agent Backend (`agent.backend`)

Gaunt Sloth ships one agent backend, `lean` — a plain LangChain agent carrying Gaunt Sloth's own
toolset: filesystem, hardened dev/shell, and the `gth_checklist` planning tool. It is what every
command runs, and what runs when the key is absent, so setting it changes nothing:

```json
{
  "llm": { "type": "anthropic", "model": "claude-sonnet-5-5" },
  "agent": { "backend": "lean" }
}
```

`"lean"` is the only accepted value. The key is kept so a config can state what it runs on, and so
a second backend has a name to be selected by; a value that is not `"lean"` is a config error
rather than a silently ignored key.

A config carrying the retired `"backend": "deep"` **fails to load**, with a message naming the
replacement — see [Migrating to 2.0](../MIGRATION.md) for what to change and what it costs you.
