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

## ACP server (editor integration)

Gaunt Sloth can run as an [Agent Client Protocol](https://agentclientprotocol.com/) (ACP)
server, so an ACP host — Zed, JetBrains, a future Pukeko client — can spawn it as a coding
agent. It speaks ACP JSON-RPC over **stdio** (no port, no flags beyond the switch below); the
host launches it as a subprocess.

Run it through this package:

```bash
npm install -g gaunt-sloth@alpha
gaunt-sloth --acp-agent
```

**Install the app (`gaunt-sloth`), not `@gaunt-sloth/agent`.** The agent package also ships a
standalone `gaunt-sloth-acp` binary, but the LLM providers (`@langchain/anthropic`, `openai`,
`google`, …) are `peerDependencies` of `@gaunt-sloth/core` that **only this app package
declares as real dependencies**. A bare `@gaunt-sloth/agent` install leaves those peers unmet,
so its ACP server has no provider to build a model from. `gaunt-sloth --acp-agent` runs the
exact same ACP server but resolves providers out of the app's dependency tree, so every
configured provider works. (`stdout` is the protocol channel and is kept clean — gsloth's
status/config output is redirected to `stderr`.)

Provider credentials and model selection come from your usual gsloth config
(`.gsloth.config.*` / env vars such as `ANTHROPIC_API_KEY`); the ACP server reads them via the
same `initConfig` path as the CLI. Run the host from your project directory (or set its `cwd`)
so config and the per-session workspace resolve correctly.

### Zed

Add to Zed `settings.json`:

```json
{
  "agent_servers": {
    "Gaunt Sloth": {
      "command": "gaunt-sloth",
      "args": ["--acp-agent"],
      "env": {}
    }
  }
}
```

Point `command` at the global `gaunt-sloth` binary (after `npm install -g gaunt-sloth@alpha`),
or at an absolute path to `cli.js` for a local build. Other ACP hosts (JetBrains, etc.) take
the same `command` + `args` pair.

## Related packages

- [`@gaunt-sloth/core`](../core) — Core utilities, config, and agent infrastructure
- [`@gaunt-sloth/agent`](../agent) — Agent runtime, built-in tools, API/AG-UI/ACP server
- [`@gaunt-sloth/review`](../review) — Review and Q&A modules with standalone CLI
- [`gaunt-sloth`](../app) — Main CLI application (this package)
