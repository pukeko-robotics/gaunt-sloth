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
gth config profile create devops --model claude-sonnet-4-5
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
profile that has no config directory is an error (the run stops rather than silently falling back to
the global config).

### Creating a profile

`gth config profile create <name>` scaffolds a new profile directory
(`.gsloth/.gsloth-settings/<name>/.gsloth.config.json`), seeded from your current effective config
(or a minimal template when none resolves) and schema-validated before it is written. Pass
`--model <id>` to set the profile's model, and `--force` to overwrite an existing profile.

For example, to add a cheap flash-lite profile alongside your normal setup and then run under it:

```bash
gth config profile create cheap --model gemini-2.0-flash-lite
gth --profile cheap ask "summarise the open TODOs in this repo"
```

Then edit `.gsloth/.gsloth-settings/cheap/.gsloth.config.json` to adjust its tools, prompts, or
provider as needed — it is an ordinary config file.

## Named-profile subagents (subagents)

`subagents` lets the agent delegate a sub-task to a subagent that runs under a **different
[named profile](#identity-profiles)** — its own model, tools, and prompt — instead of the parent's.
The typical use: keep the parent on a strong (expensive) model but hand routine search/recall work to
a cheap one, so the bulk of the tokens are spent on the cheap model.

Each entry names a subagent (the name the model selects it by) and the profile the child resolves:

```json
{
  "llm": { "type": "anthropic", "model": "claude-opus-4-1" },
  "agent": { "backend": "deep" },
  "subagents": [
    { "name": "recall", "description": "Cheap read-only search/recall.", "profile": "cheap" }
  ]
}
```

To make the example above run, create the `cheap` profile it references, then start a coding session —
when the model delegates a recall task, that subagent runs on `gemini-2.0-flash-lite`, not on the
parent's `claude-opus-4-1`:

```bash
gth config profile create cheap --model gemini-2.0-flash-lite
gth code
```

The child resolves the named profile through the same config cascade a top-level `--profile` run does,
so it picks up that profile's model, tool selection, and prompt files. A subagent whose `profile` has
no config directory is an error, exactly as selecting a missing profile with `--profile` is.

> **Deep backend only.** Subagents are dispatched through the deepagents `task` tool, which the
> experimental `deep` backend provides — set `agent.backend: "deep"` (see the **Agent Backend**
> section below). The default `lean` backend does not spawn subagents yet, so `subagents` has no
> effect there.

## AG-UI Server Configuration

The `api ag-ui` command reads its settings from `commands.api` in your config file.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `commands.api.port` | `number` | `3000` | Port the AG-UI server listens on |
| `commands.api.cors.allowOrigin` | `string` | `"http://localhost:3000"` | `Access-Control-Allow-Origin` header value |
| `commands.api.cors.allowMethods` | `string` | `"POST, GET, OPTIONS"` | `Access-Control-Allow-Methods` header value |
| `commands.api.cors.allowHeaders` | `string` | `"Content-Type, Accept"` | `Access-Control-Allow-Headers` header value |

**Example config for the Galvanized Pukeko web client on port 5555:**

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
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

> **Note:** The port flag `--port` on the CLI overrides `commands.api.port`.

## Agent Backend (`agent.backend`)

Gaunt Sloth ships two agent backends. Select one with the top-level `agent.backend` field.

| Value | Backend | Notes |
|-------|---------|-------|
| `lean` (**default**) | Plain LangChain agent | Recommended. Gaunt Sloth's own toolset — filesystem, hardened dev/shell, and the `gth_checklist` planning tool. Used for the CLI (`code`/`chat`), single-shot (`ask`/`exec`), and the AG-UI/`api` server. |
| `deep` | deepagents runtime | **Experimental, opt-in.** Adds subagents, `write_todos`, summarization, and large-tool-result offload, but can exhibit path divergence and sporadic failures. Selecting it prints a warning. |

```json
{
  "llm": { "type": "anthropic", "model": "claude-sonnet-4-5" },
  "agent": { "backend": "lean" }
}
```

When `agent.backend` is omitted, the lean backend is used everywhere. Set `"backend": "deep"` only
to opt into the experimental deepagents runtime (required for [subagents](#named-profile-subagents-subagents)).
The ACP server is structurally deepagents-based and always runs the deep backend regardless of this
setting.
