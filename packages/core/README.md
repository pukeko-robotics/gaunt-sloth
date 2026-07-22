# @gaunt-sloth/core

The foundation layer of Gaunt Sloth: the configuration system (`GthConfig`, config discovery and
loading, the JSON schema), the LLM provider factory (anthropic, deepseek, google-genai, groq,
ollama, openai, openrouter, vertexai, xai, fake), the lean LangChain agent runtime
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

All config keys (providers, prompts, tools, per-command settings) are documented in
[docs/CONFIGURATION.md](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/CONFIGURATION.md).

## Exports

- `@gaunt-sloth/core` (the root export) is the public API: config
  (`initConfig`, `GthConfig`, defaults), constants, core types, the lean agent factory, model
  discovery, and session history.
- `@gaunt-sloth/core/<path>.js` deep paths (e.g. `@gaunt-sloth/core/config.js`,
  `@gaunt-sloth/core/utils/consoleUtils.js`) mirror the internal `dist/` layout 1:1 and are a
  deliberate part of the contract — the other `@gaunt-sloth/*` packages and downstream consumers
  import them directly. They are supported at your own risk: internal files can move between
  alpha/minor versions without a deprecation cycle. Prefer the root export where it suffices.

This package ships no binaries.

## Related packages

- [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent) — Agent runtime: built-in tools, filesystem toolkit, middleware registry, API server, AG-UI, MCP, and A2A integration ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/agent))
- [`@gaunt-sloth/review`](https://www.npmjs.com/package/@gaunt-sloth/review) — Review and Q&A modules with standalone CLI ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/review))
- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — Batch / eval / workflow runtime ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
