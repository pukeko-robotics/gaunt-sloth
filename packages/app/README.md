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
  tools, and the AG-UI server
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

**Not available.** `gaunt-sloth --acp-agent` — and the standalone `gaunt-sloth-acp` binary — print
an explanation and exit non-zero. The [Agent Client Protocol](https://agentclientprotocol.com/)
server was built on a third-party agent runtime Gaunt Sloth no longer depends on; it returns
rebuilt on Gaunt Sloth's own agent.

The switch and the binary are kept rather than removed so an editor that already has the command
configured reports a retired feature rather than a missing executable.

Until then: `gth api` runs the AG-UI server for a programmatic front door, and `gth chat` / `gth
code` run an interactive session in a terminal.

## Related packages

- [`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) — Core utilities, config, and agent infrastructure ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/core))
- [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent) — Agent runtime, built-in tools, API/AG-UI server ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/agent))
- [`@gaunt-sloth/review`](https://www.npmjs.com/package/@gaunt-sloth/review) — Review engine with content/requirement sources (GitHub, Jira, file, text) and standalone CLI ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/review))
- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — Batch / eval / workflow runtime ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application (this package) ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
