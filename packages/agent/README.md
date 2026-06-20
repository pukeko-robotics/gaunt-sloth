# @gaunt-sloth/agent

The deep-agent runtime for Gaunt Sloth. Consolidates what were previously
`@gaunt-sloth/tools` and `@gaunt-sloth/api`:

- Built-in tools and toolkits (filesystem, dev, custom, web fetch, status update)
- Middleware registry (summarization, prompt caching, binary content injection)
- MCP client + OAuth provider
- A2A client and tools
- The AG-UI server (`startAgUiServer`) and interactive session module
- The `createResolvers` tool/middleware resolver wiring

It builds on `@gaunt-sloth/core` (config, provider factory, lean langchain runtime).

> `@gaunt-sloth/tools` and `@gaunt-sloth/api` are deprecated and now re-export
> from this package.
