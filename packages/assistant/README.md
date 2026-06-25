# gaunt-sloth-assistant

> ⚠️ **`gaunt-sloth-assistant` has been renamed to [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth).**
> The `1.5.x` series is the final release under the old name — active development continues under
> the new package. To switch:
>
> ```bash
> npm uninstall -g gaunt-sloth-assistant
> npm install -g gaunt-sloth
> ```
>
> The `gth`, `gsloth`, and `gaunt-sloth` commands are unchanged.
> Site & docs: <https://gauntsloth.app> · Source: <https://github.com/pukeko-robotics/gaunt-sloth>

The main CLI application for Gaunt Sloth.

## Contents

- CLI entry point and commander-based command registration
- Commands: `ask`, `review`, `pr`, `chat`, `code`, `init`, `get`, `api`
- Command utilities and config setup
- Vendor package wiring (all LangChain provider packages)
- Integration tests

## CLI Binaries

The package registers four equivalent binary aliases:

- `gaunt-sloth-assistant`
- `gaunt-sloth`
- `gsloth`
- `gth`

## Dependencies

- `@gaunt-sloth/core`
- `@gaunt-sloth/tools`
- `@gaunt-sloth/api`
- `@gaunt-sloth/review`
- `commander`
- All LangChain vendor packages (anthropic, google-genai, groq, openai, vertexai, xai, etc.)

This is the only package in the workspace that pulls in AI vendor dependencies directly. All other packages treat vendors as optional peers.

## Re-exports

`gaunt-sloth-assistant` re-exports public APIs from the sub-packages for backward compatibility. Consumers that previously imported directly from `gaunt-sloth-assistant` continue to work without changes.

## Installation

```bash
npm install -g gaunt-sloth-assistant
```

For full usage documentation see the [root README](../../README.md) and [docs/COMMANDS.md](../../docs/COMMANDS.md).

## Related packages

- [`@gaunt-sloth/core`](../core) — Core utilities, config, and agent infrastructure
- [`@gaunt-sloth/tools`](../tools) — Built-in tools, filesystem toolkit, and middleware registry
- [`@gaunt-sloth/api`](../api) — API server, AG-UI, MCP, and A2A integration
- [`@gaunt-sloth/review`](../review) — Review and Q&A modules with standalone CLI
- [`gaunt-sloth-assistant`](../assistant) — Main CLI application (this package)
