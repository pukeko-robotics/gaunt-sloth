# gaunt-sloth

The main CLI application for Gaunt Sloth — the fat package that turns the `@gaunt-sloth/*`
libraries into the `gth` command.

## Contents

- CLI entry point, commander-based command registration, and the Ink TUI
- Commands: `ask`, `review`, `pr`, `chat`, `code`, `exec`, `init`, `config`, `get`, `api`,
  `batch`, `eval`, `workflow`, `history`, `insights`, `models` — see
  [docs/COMMANDS.md](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/COMMANDS.md)
- Vendor package wiring (all LangChain provider packages)

## CLI Binaries

The package registers three equivalent binary aliases:

- `gth` (primary)
- `gsloth` (long-form alias)
- `gaunt-sloth` (package-name alias)

## Dependencies

- `@gaunt-sloth/core`
- `@gaunt-sloth/agent`
- `@gaunt-sloth/review`
- `@gaunt-sloth/batch`
- `@gaunt-sloth/eval-reporter-junit`
- `commander`
- All LangChain vendor packages (anthropic, google, groq, openai, xai, etc.)

This is the only package in the workspace that pulls in AI vendor dependencies directly. All other packages treat vendors as optional peers.

## Not a library

This package deliberately exports **no importable modules** — its `exports` map exposes only
`./package.json`. It is the CLI product: install it globally and run `gth`. To embed Gaunt Sloth
functionality in your own code, depend on the scoped packages instead — they are the supported
embeddable surface:

- [`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) — config resolution and
  the provider factory
- [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent) — the agent runtime,
  tools, and the AG-UI/ACP servers
- [`@gaunt-sloth/review`](https://www.npmjs.com/package/@gaunt-sloth/review) — programmatic code
  review (see its README for a worked embed example)

(Until 2.0 the app exposed a `./*` deep-path wildcard over a tree of re-export shims; the shims
are gone and the wildcard with them.)

## Installation

```bash
npm install -g gaunt-sloth
```

For full usage documentation see the [root README](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/README.md) and [docs/COMMANDS.md](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/COMMANDS.md).

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

Add to Zed `settings.json` (or Settings -> External Agents -> Add Agent -> Custom Agent):

```json
{
  "agent_servers": {
    "Gaunt Sloth": {
      "type": "custom",
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

- [`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) — Core utilities, config, and agent infrastructure ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/core))
- [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent) — Agent runtime, built-in tools, API/AG-UI/ACP server ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/agent))
- [`@gaunt-sloth/review`](https://www.npmjs.com/package/@gaunt-sloth/review) — Review and Q&A modules with standalone CLI ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/review))
- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — Batch / eval / workflow runtime ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application (this package) ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
