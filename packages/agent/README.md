# @gaunt-sloth/agent

The agent runtime for Gaunt Sloth: built-in tools and toolkits (filesystem, dev/shell, web
fetch, custom), the middleware registry, MCP client + OAuth provider, A2A client and tools, the
AG-UI server (`startAgUiServer`), the ACP server (`startAcpServer`), the interactive session
module, and the `createResolvers` tool/middleware resolver wiring. It builds on
[`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) (config, provider
factory, lean agent runtime).

**When to depend on this package** — you are embedding the running agent: serving it to a web
client over AG-UI, wiring its tools/middleware into your own host, or talking to MCP/A2A
services. The fat [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) CLI wires this same
runtime into `gth chat` / `gth code` / `gth api`; install that instead if you want the terminal
experience rather than a library.

## Installation

```bash
npm install @gaunt-sloth/agent @langchain/anthropic
```

AI providers are optional peer dependencies of `@gaunt-sloth/core` — install the one(s) your
config uses (see the core README's provider list).

## Embedding: serve the agent over AG-UI

I want a local web client to talk to the configured Gaunt Sloth agent over the
[AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui). With a `.gsloth.config.*` in the
working directory:

```js
import { initConfig } from '@gaunt-sloth/core';
import { startAgUiServer } from '@gaunt-sloth/agent';

const config = await initConfig({});
await startAgUiServer(config, config.commands?.api?.port ?? 3000);
// POST /agents/:agentId/run now streams typed AG-UI SSE events
```

The server is intended for **local clients only** (a local web UI talking to a local agent); do
not expose it to public networks. Port and CORS come from `commands.api.*` in the config — see
[the configuration guide](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/configuration/index.md).

## Binaries

- **`gaunt-sloth-api`** — starts the AG-UI server standalone (the code above as a command):
  `gaunt-sloth-api` (defaults to the `ag-ui` server on `commands.api.port`, 3000 by default).
- **`gaunt-sloth-acp`** — runs the [Agent Client Protocol](https://agentclientprotocol.com/)
  server over stdio, for ACP hosts (Zed, JetBrains). Prefer `gaunt-sloth --acp-agent` from the
  [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) app instead: the LLM providers are
  `peerDependencies` of `@gaunt-sloth/core` that only the app declares, so a bare
  `@gaunt-sloth/agent` install has no providers to construct a model from. See the
  [app README → ACP server](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/packages/app/README.md#acp-server-editor-integration)
  for setup and a Zed `settings.json` example.

## Exports

- `@gaunt-sloth/agent` (the root export) is the public API: the AG-UI/ACP/interactive-session
  modules, A2A client and tool, MCP utilities and OAuth provider, built-in tools config, the
  middleware registry, the deep-agent factory, and `createResolvers`.
- `@gaunt-sloth/agent/<path>.js` deep paths mirror the internal `dist/` layout 1:1 and are
  deliberately kept open for reach-in (the fat CLI imports e.g.
  `@gaunt-sloth/agent/resolvers.js`). They are supported at your own risk: internal files can
  move between alpha/minor versions without a deprecation cycle. Prefer the root export where it
  suffices.

> `@gaunt-sloth/tools` and `@gaunt-sloth/api` are deprecated and now re-export from this
> package.

## Related packages

- [`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) — Core utilities, config, and agent infrastructure ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/core))
- [`@gaunt-sloth/review`](https://www.npmjs.com/package/@gaunt-sloth/review) — Review engine with content/requirement sources (GitHub, Jira, file, text) and standalone CLI ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/review))
- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — Batch / eval / workflow runtime ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
