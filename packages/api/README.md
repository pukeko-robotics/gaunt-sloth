# @gaunt-sloth/api

> ⚠️ **Deprecated.** This package belongs to the `gaunt-sloth` 1.x line. In v2 it is superseded by
> [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent); it will receive no
> further updates.
> Site & docs: <https://gauntsloth.app> · Source: <https://github.com/pukeko-robotics/gaunt-sloth>

API server and agent integration layer for Gaunt Sloth.

## Contents

- AG-UI server module (`apiAgUiModule`) — starts an HTTP server implementing the AG-UI protocol
- Interactive session module (`interactiveSessionModule`)
- A2A client wrapper (`A2AClientWrapper`) and agent tool (`A2AAgentTool`) — Agent-to-Agent protocol support
- MCP utilities (`mcpUtils`) — Model Context Protocol server connection helpers
- OAuth client provider (`OAuthClientProviderImpl`)
- `show_a2ui_surface` tool
- Resolvers (`createResolvers`) — wires built-in tools, MCP servers, and A2A agents into the tool registry

## CLI

The package ships a standalone binary `gaunt-sloth-api` that starts an AG-UI server.

## Dependencies

- `@gaunt-sloth/core`
- `@gaunt-sloth/tools`
- `express`
- `@ag-ui/core`, `@ag-ui/encoder`
- `@langchain/mcp-adapters`, `@modelcontextprotocol/sdk`
- `@a2a-js/sdk`

## Exports

```js
import { apiAgUiModule } from '@gaunt-sloth/api/apiAgUiModule.js';
import { interactiveSessionModule } from '@gaunt-sloth/api/interactiveSessionModule.js';
import { A2AClientWrapper, A2AAgentTool } from '@gaunt-sloth/api/a2a.js';
import { OAuthClientProviderImpl } from '@gaunt-sloth/api/OAuthClientProviderImpl.js';
import { mcpUtils } from '@gaunt-sloth/api/mcpUtils.js';
import { createResolvers } from '@gaunt-sloth/api/resolvers.js';
```

## Frontend-fulfilled tools (AG-UI)

Tools whose execution belongs in the client (e.g. capturing a webcam frame, prompting the user, querying the browser DOM) are declared in `RunAgentInput.tools` and registered server-side with `metadata.client === true`. The agent then suspends instead of executing them, the client fulfills the call, and the run is resumed.

### Server-side declaration

Add the tool to your `GthConfig.tools` and tag it with `metadata: { client: true }`:

```ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const captureImageTool = tool(
  async () => 'client-fulfilled',
  {
    name: 'capture_image',
    description: 'Capture a frame from the client webcam.',
    schema: z.object({}),
  }
);
(captureImageTool as unknown as { metadata: Record<string, unknown> }).metadata = {
  client: true,
};
```

`GthLangChainAgent` wraps any tool with `metadata.client === true` so its body calls `interrupt({ name })` from `@langchain/langgraph`. The graph suspends; `streamWithEvents` catches the resulting `GraphInterrupt` and ends the stream cleanly. The AG-UI run finishes with `TOOL_CALL_START/ARGS/END` but no `TOOL_CALL_RESULT`. State persists in the configured checkpointer keyed by `thread_id`.

### Client-side resume

To resume, the client posts a new run on the same thread carrying the tool result via `forwardedProps`:

```ts
forwardedProps: {
  command: {
    resume: '<string returned by the client tool>',
    interruptEvent: { toolCallId, runId }
  }
}
```

`apiAgUiModule.ts` detects `forwardedProps.command.resume` and routes to `agent.streamWithEventsResume(resumeValue, runConfig)`, which calls the underlying graph with `new Command({ resume })`. The interrupt returns the resume value, the wrapped tool returns it (stringified if non-string), and a `ToolMessage` is appended to graph state.

### Returning binary content

`ToolMessage.content` is `string` only across AG-UI and most LangChain providers. To pass an image back, serialize a JSON envelope (e.g. `{ mimeType, data }` for base64) as the resume value, then add a `beforeModel` middleware that detects the `ToolMessage` for your tool and appends a `HumanMessage` with multimodal content blocks before the next model call. The `binary-content-injection` middleware (in `@gaunt-sloth/tools`) is a working reference for the same pattern keyed on `gth_read_binary` with a different envelope format.

### Body limit

The AG-UI server uses `express.json({ limit: '5mb' })` to accommodate base64 envelopes that round-trip through `forwardedProps`.

## Related packages

- [`@gaunt-sloth/core`](../core) — Core utilities, config, and agent infrastructure
- [`@gaunt-sloth/tools`](../tools) — Built-in tools, filesystem toolkit, and middleware registry
- [`@gaunt-sloth/api`](../api) — API server, AG-UI, MCP, and A2A integration (this package)
- [`@gaunt-sloth/review`](../review) — Review and Q&A modules with standalone CLI
- [`gaunt-sloth`](../assistant) — Main CLI application
