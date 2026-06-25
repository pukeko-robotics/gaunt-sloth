# @gaunt-sloth/agent

The deep-agent runtime for Gaunt Sloth. Consolidates what were previously
`@gaunt-sloth/tools` and `@gaunt-sloth/api`:

- Built-in tools and toolkits (filesystem, dev, custom, web fetch, status update)
- Middleware registry (summarization, prompt caching, binary content injection)
- MCP client + OAuth provider
- A2A client and tools
- The AG-UI server (`startAgUiServer`) and interactive session module
- The ACP (Agent Client Protocol) server (`startAcpServer`), exposed as the
  `gaunt-sloth-acp` binary
- The `createResolvers` tool/middleware resolver wiring

It builds on `@gaunt-sloth/core` (config, provider factory, lean langchain runtime).

> **Running the ACP server:** prefer `gaunt-sloth --acp-agent` from the
> [`gaunt-sloth`](../app) app, not the standalone `gaunt-sloth-acp` binary. The LLM
> providers are `peerDependencies` of `@gaunt-sloth/core` that only the app declares, so a
> bare `@gaunt-sloth/agent` install has no providers to construct a model from. See the
> [app README → ACP server](../app/README.md#acp-server-editor-integration) for setup and a
> Zed `settings.json` example.

> `@gaunt-sloth/tools` and `@gaunt-sloth/api` are deprecated and now re-export
> from this package.
