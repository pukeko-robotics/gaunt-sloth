# Configuration

> **Upgrading from 1.x?** 2.0 is a breaking config release. See [Migrating to 2.0](../MIGRATION.md)
> for the HARD vs SOFT change list and before/after snippets, then run `gth config validate` to
> check your migrated config.

Gaunt Sloth runs from a directory tree that contains a config file. The fastest way to create one is
`gth init` — with a provider name it writes a ready config, and with no argument it detects which
providers have a key set and walks you through the choice:

```bash
gth init anthropic
```

That writes a `.gsloth.config.json` (under `.gsloth/.gsloth-settings/` if a `.gsloth` directory
exists, otherwise in the project root) that you can commit and tune. From there, follow the page for
whatever you want to set up:

| Page | What it covers |
|---|---|
| [Providers](providers.md) | Per-provider setup (Anthropic, Vertex AI, OpenAI, Groq, Ollama, …) and the model-identity prompt. |
| [Tools](tools.md) | Built-in tools, the shell tool, content search, custom tools, middleware, and the allow-list. |
| [MCP servers](mcp.md) | Connecting MCP servers, including remote OAuth and TLS trust. |
| [Content sources](content-sources.md) | Pulling review requirements from GitHub issues or Jira, and change-requirements discovery. |
| [Prompts](prompts.md) | The `prompts` object — guidelines, review, system, and the other prompt segments. |
| [Output & files](output.md) | Where and whether `gth` writes output, run headers, logging, and redaction. |
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
Patterns use minimatch rules (like `.gitignore`); lines starting with `#` are comments.

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

## The full config object

The pages above cover each area in depth. For the exhaustive, type-checked surface — every key and
its default — see the generated reference:

- [`GthConfig` interface](https://gauntsloth.app/docs/interfaces/config.GthConfig.html)
- [`DEFAULT_CONFIG` values](https://gauntsloth.app/docs/variables/config.DEFAULT_CONFIG.html)
- Source of truth: [`packages/core/src/config/schema.ts`](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/packages/core/src/config/schema.ts)
