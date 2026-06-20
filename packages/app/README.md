# gaunt-sloth

The main CLI application for Gaunt Sloth.

## Contents

- CLI entry point and commander-based command registration
- Commands: `ask`, `review`, `pr`, `chat`, `code`, `init`, `get`, `api`
- Command utilities and config setup
- Vendor package wiring (all LangChain provider packages)
- Integration tests

## CLI Binaries

The package registers four equivalent binary aliases:

- `gaunt-sloth` (primary)
- `gth`
- `gsloth`
- `gaunt-sloth-assistant` (back-compat alias for the former package name)

## Dependencies

- `@gaunt-sloth/core`
- `@gaunt-sloth/agent`
- `@gaunt-sloth/review`
- `commander`
- All LangChain vendor packages (anthropic, google-genai, groq, openai, vertexai, xai, etc.)

This is the only package in the workspace that pulls in AI vendor dependencies directly. All other packages treat vendors as optional peers.

## Re-exports

`gaunt-sloth` re-exports public APIs from the sub-packages for convenience, so common imports are available from a single entry point.

## Installation

```bash
npm install -g gaunt-sloth
```

For full usage documentation see the [root README](../../README.md) and [docs/COMMANDS.md](../../docs/COMMANDS.md).

## Related packages

- [`@gaunt-sloth/core`](../core) — Core utilities, config, and agent infrastructure
- [`@gaunt-sloth/agent`](../agent) — Agent runtime, built-in tools, API/AG-UI/ACP server
- [`@gaunt-sloth/review`](../review) — Review and Q&A modules with standalone CLI
- [`gaunt-sloth`](../app) — Main CLI application (this package)
