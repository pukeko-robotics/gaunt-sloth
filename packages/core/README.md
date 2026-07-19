# @gaunt-sloth/core

Core utilities and types for Gaunt Sloth.

## Contents

- Configuration system (`GthConfig`, `RawGthConfig`, config loading and post-processing)
- Agent infrastructure: `GthLangChainAgent`, `GthAgentRunner`
- LLM provider wrappers: anthropic, deepseek, google-genai, groq, openai, openrouter, vertexai, xai, fake
- Utility modules: `consoleUtils`, `debugUtils`, `fileUtils`, `llmUtils`, `systemUtils`, `stringUtils`, `aiignoreUtils`, `binaryOutputUtils`, `vertexaiUtils`, `globalConfigUtils`, `ProgressIndicator`
- State and artifact storage: `artifactStore`
- Shared constants and types

AI vendor packages are not direct dependencies. Each vendor package is an optional peer dependency, resolved at runtime by whichever consumer (e.g. `gaunt-sloth`) pulls them in.

## Dependencies

No other `@gaunt-sloth/*` packages.

## Exports

All modules are exported via the `./` export map pattern (`./*.js`), e.g.:

```js
import { GthAgentRunner } from '@gaunt-sloth/core/agentRunner.js';
import { display } from '@gaunt-sloth/core/utils/consoleUtils.js';
```

## Related packages

- [`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) — Core utilities, config, and agent infrastructure (this package) ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/core))
- [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent) — Agent runtime: built-in tools, filesystem toolkit, middleware registry, API server, AG-UI, MCP, and A2A integration ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/agent))
- [`@gaunt-sloth/review`](https://www.npmjs.com/package/@gaunt-sloth/review) — Review and Q&A modules with standalone CLI ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/review))
- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — Batch / eval / workflow runtime ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
