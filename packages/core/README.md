# @gaunt-sloth/core

> ℹ️ **Moved.** The Gaunt Sloth project now lives at
> [`pukeko-robotics/gaunt-sloth`](https://github.com/pukeko-robotics/gaunt-sloth) and
> [gauntsloth.app](https://gauntsloth.app). The `0.1.x` releases belong to the
> `gaunt-sloth-assistant` 1.x line; `@gaunt-sloth/core` continues in v2 as part of the
> [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) line.

Core utilities and types for Gaunt Sloth.

## Contents

- Configuration system (`GthConfig`, `RawGthConfig`, config loading and post-processing)
- Agent infrastructure: `GthLangChainAgent`, `GthAgentRunner`
- LLM provider wrappers: anthropic, deepseek, google-genai, groq, openai, openrouter, vertexai, xai, fake
- Utility modules: `consoleUtils`, `debugUtils`, `fileUtils`, `llmUtils`, `systemUtils`, `stringUtils`, `aiignoreUtils`, `binaryOutputUtils`, `vertexaiUtils`, `globalConfigUtils`, `ProgressIndicator`
- State and artifact storage: `artifactStore`
- Shared constants and types

AI vendor packages are not direct dependencies. Each vendor package is an optional peer dependency, resolved at runtime by whichever consumer (e.g. `gaunt-sloth-assistant`) pulls them in.

## Dependencies

No other `@gaunt-sloth/*` packages.

## Exports

All modules are exported via the `./` export map pattern (`./*.js`), e.g.:

```js
import { GthAgentRunner } from '@gaunt-sloth/core/agentRunner.js';
import { display } from '@gaunt-sloth/core/utils/consoleUtils.js';
```

## Related packages

- [`@gaunt-sloth/core`](../core) — Core utilities, config, and agent infrastructure (this package)
- [`@gaunt-sloth/tools`](../tools) — Built-in tools, filesystem toolkit, and middleware registry
- [`@gaunt-sloth/api`](../api) — API server, AG-UI, MCP, and A2A integration
- [`@gaunt-sloth/review`](../review) — Review and Q&A modules with standalone CLI
- [`gaunt-sloth-assistant`](../assistant) — Main CLI application
