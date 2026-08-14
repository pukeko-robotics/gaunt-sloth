# @gaunt-sloth/core

The foundation layer of Gaunt Sloth: the configuration system (`GthConfig`, config discovery and
loading, the JSON schema), the LLM provider factory (anthropic, deepseek, google-genai, groq,
huggingface, ollama, openai, openrouter, vertexai, xai, fake), the lean LangChain agent runtime
(`GthAgentRunner`), session history, and the shared utility modules (`consoleUtils`,
`systemUtils`, `fileUtils`, `llmUtils`, …).

**When to depend on this package** — you are embedding a piece of Gaunt Sloth (or building your
own front-end on its infrastructure) and need its config resolution and provider wiring without
the CLI. Every other `@gaunt-sloth/*` package builds on it. If you just want to use Gaunt Sloth
from the terminal, install the [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) app
instead.

## Installation

AI vendor packages are optional peer dependencies — install the provider(s) your configuration
uses alongside core:

```bash
npm install @gaunt-sloth/core @langchain/anthropic
```

## Embedding: resolve config into a live model

I want my script to honour the user's `.gsloth.config.*` (provider, model, API keys) instead of
hard-coding a vendor SDK. With a `.gsloth.config.json` such as
`{ "llm": { "type": "anthropic", "model": "claude-sonnet-4-5" } }` in the working directory:

```js
import { initConfig } from '@gaunt-sloth/core';

const config = await initConfig({}); // discovers .gsloth.config.* up-tree from cwd
// config.llm is a live LangChain chat model built from that config
const response = await config.llm.invoke('Say hello');
console.log(response.text);
```

When the configured provider has no API key anywhere — not in `llm.apiKey`, not in
`llm.apiKeyEnvironmentVariable`, not in any variable that provider accepts — `initConfig` rejects
with a `MissingProviderKeyError` carrying `provider` and `envVars`, so a caller running several
configs can report which one lacked a secret and carry on with the rest. Use
`isMissingProviderKeyError(error)` to recognise it.

All config keys (providers, prompts, tools, per-command settings) are documented in
[the configuration guide](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/configuration/index.md).

## Exports

- `@gaunt-sloth/core` (the root export) is the public API: config
  (`initConfig`, `GthConfig`, defaults), constants, core types, the lean agent factory, model
  discovery, and session history.
- **A type the Zod schema declares is re-exported, so a value you can set is a value you can name.**
  Some types in this package's public surface are declared by the schema rather than beside the
  interface that uses them; those are re-exported from the root and from
  `@gaunt-sloth/core/config.js` — `GthOutputHeaderRung`, the type of `GthConfig`'s `output.header`,
  and `RawConfigValidationResult`, the interface `ConfigLayerValidationReport` extends. The schema's
  runtime surface (`rawGthConfigSchema`, `generateConfigJsonSchema`, `validateRawGthConfig`,
  `KNOWN_TOP_LEVEL_KEYS`, the deprecation scanners) is validator internals and is not part of the
  root export; reach it through the deep path below if you need it.
- **The approval and shell types are not covered by that yet.** The types reached through
  `PendingToolInterrupt` and `GthAgentInterface` — the approval subject and its variants, the rater's
  safety verdict and outcome, the negotiation round, the declared tool annotations — are declared
  under `core/approvals/` and `core/shell/` and are **not** re-exported from the root. Writing a
  typed `ToolApprovalCallback` therefore still needs the deep path each is declared in.
- `@gaunt-sloth/core/<path>.js` deep paths (e.g. `@gaunt-sloth/core/config.js`,
  `@gaunt-sloth/core/utils/consoleUtils.js`) mirror the internal `dist/` layout 1:1 and are a
  deliberate part of the contract — the other `@gaunt-sloth/*` packages and downstream consumers
  import them directly. They are supported at your own risk: internal files can move between
  alpha/minor versions without a deprecation cycle. Prefer the root export where it suffices.

This package ships no binaries.

## Related packages

- [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent) — Agent runtime: built-in tools, filesystem toolkit, middleware registry, API server, AG-UI, MCP, and A2A integration ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/agent))
- [`@gaunt-sloth/review`](https://www.npmjs.com/package/@gaunt-sloth/review) — Review engine with content/requirement sources (GitHub, Jira, file, text) and standalone CLI ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/review))
- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — Batch / eval / workflow runtime ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
