# Gaunt Sloth
[![Tests and Lint](https://github.com/pukeko-robotics/gaunt-sloth/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/pukeko-robotics/gaunt-sloth/actions/workflows/unit-tests.yml) [![Integration Tests](https://github.com/pukeko-robotics/gaunt-sloth/actions/workflows/integration-tests.yml/badge.svg?event=push)](https://github.com/pukeko-robotics/gaunt-sloth/actions/workflows/integration-tests.yml)

Gaunt Sloth (`gth`) is a command-line AI assistant for code review, PR analysis, Q&A, and
interactive coding sessions. It runs on your machine against whatever model you point it at, with
every prompt in plain markdown and no vendor lock-in.

![GSloth Banner](assets/gaunt-sloth-logo.png)

Based on [LangChain.js](https://github.com/langchain-ai/langchainjs).

**[Documentation](https://gauntsloth.app/docs/) · [Quickstart](docs/quickstart.md) · [Official Site](https://gauntsloth.app/) · [NPM](https://www.npmjs.com/package/gaunt-sloth)**

## Why?

Gaunt Sloth is small, extendable, cross-platform, and can itself be a dependency in your project.
It started as a code-review tool that fed PR and Jira contents to an LLM; we kept finding more uses
(spinning it up inside an MCP project to simulate cases, for instance), so it grew into a general
configuration-driven CLI.

- **Minimum dependencies** — CommanderJS plus LangChain/LangGraph.
- **Extensibility** — write a little JS to add a tool or provider, or connect an MCP server.
- **No vendor lock-in** — bring your own API keys.
- **All prompts are editable markdown** — you are in full control.
- **Stateless code reviews** — developers can't argue it into changing its mind.
- **Runs on-premises** with local models on your terms.

## Get started

```bash
npm install -g gaunt-sloth@alpha
gth init anthropic        # scaffold .gsloth.config.json and pick a provider
export ANTHROPIC_API_KEY="sk-ant-..."
gth ask "what does this project do?" -f README.md
```

The [Quickstart](docs/quickstart.md) walks through this end to end, and
[Guides & Recipes](docs/guides/review-code-and-prs.md) covers real jobs — reviewing PRs in CI,
coding against your own project rules, running a free local model, scripting it non-interactively.

## What it does

A **configuration-driven CLI** you wire into your own workflows — you choose the model, provider,
prompts, and tools, and `gth` orchestrates them.

- **Code review & PRs** — review a PR against its linked GitHub/Jira issue (`gth pr 42 23`), or a
  local diff before committing (`git --no-pager diff | gth review`). Stateless, non-zero on failure,
  so it drops into CI.
- **Q&A, chat & coding** — one-shot questions (`gth ask "explain this" -f utils.js`), interactive
  `chat`, and full `code` sessions with filesystem access.
- **Model experimentation** — swap models and providers from config, no code changes; a customizable
  middleware pipeline; every system prompt an editable markdown file.
- **Controlled automation** — define custom shell tools with parameter validation, connect to MCP
  servers (including remote OAuth), and talk to external agents over A2A.

## Providers

Bring an API key from any one of: Anthropic, Google (Vertex AI & AI Studio), OpenAI, Groq, DeepSeek,
xAI, OpenRouter, Hugging Face, or a local Ollama / LM Studio endpoint — plus any other
LangChain.js-compatible provider via [JavaScript config](docs/configuration/providers.md#javascript-configuration).
Scaffold one with `gth init <provider>`; per-provider setup lives in
[Configuration → Providers](docs/configuration/providers.md#config-initialization).

## Commands

`gth` and `gsloth` are interchangeable. The main verbs are `init`, `ask`, `review`, `pr`, `chat`,
`code`, `exec`, `eval`, `batch`, `workflow`, `models`, `config`, and `history`. Running `gth` with
no subcommand drops you into `chat`.

See [docs/COMMANDS.md](docs/COMMANDS.md) for every command, argument, and flag.

## Workspace Packages

This repository is an NPM workspace monorepo. Most users only need the `gaunt-sloth` app; the
libraries are published for embedding.

| Package | Description |
|---|---|
| `gaunt-sloth` | Main CLI application (`packages/app`). Installs the `gsloth`/`gth` binaries. Most users only need this. |
| `@gaunt-sloth/agent` | Agent runtime (`packages/agent`): AG-UI server, A2A client, MCP utilities, filesystem and custom tools, middleware registry. |
| `@gaunt-sloth/review` | Review and Q&A modules (`packages/review`) with content sources (GitHub, Jira). Ships the `gaunt-sloth-review` binary for lightweight CI — no dependency on `commander`, MCP, or A2A. |
| `@gaunt-sloth/core` | Config system, agent infrastructure, LLM provider wrappers, and shared utilities (`packages/core`). |

The dependency chain is `@gaunt-sloth/core` ← `@gaunt-sloth/agent` ← `gaunt-sloth`;
`@gaunt-sloth/review` depends only on `@gaunt-sloth/core`.

## Installation

Requires Node.js 24+ (see the `engines` field in `package.json`).

```bash
npm install -g gaunt-sloth@alpha
```

The 2.0 line is still prerelease, published under `@alpha`/`@beta`/`@rc` tags rather than `@latest`
— a bare `npm install -g gaunt-sloth` currently installs the 1.x bridge release, so use
`gaunt-sloth@alpha` (or `@beta`/`@rc`) to get 2.0. Upgrading from the old `gaunt-sloth-assistant`
package? See
[Upgrading from `gaunt-sloth-assistant` (1.x)?](docs/MIGRATION.md#upgrading-from-gaunt-sloth-assistant-1x)
first.

## Configuration

Gaunt Sloth runs from a directory tree containing a config file (`.gsloth.config.json`,
`.gsloth.config.jsonc`, `.gsloth.config.js`, or `.gsloth.config.mjs`), in the project root or under
`.gsloth/.gsloth-settings/`. Create one with `gth init`, or point at one with `-c /path/to/config.json`.

The full surface — providers, tools, MCP servers, content sources, prompts, and identity profiles —
is documented in [the Configuration guide](docs/configuration/index.md).

## Uninstall

```bash
npm uninstall -g gaunt-sloth
rm -r ~/.gsloth        # global config, if any
rm -r ./.gsloth*       # project configs, if any
```

## Contributing

Contributions are welcome through GitHub Issues and pull requests. For contributor workflow, local
setup, and testing expectations, see [CONTRIBUTING.md](./CONTRIBUTING.md); participation is covered
by the [Code of Conduct](./CODE_OF_CONDUCT.md).

Filing a bug? Run `/debug-dump` in a `chat`/`code` session to attach a diagnostic archive to the
issue — see [docs/debug-dump.md](./docs/debug-dump.md).

## License

[MIT](https://opensource.org/license/mit). See [LICENSE](LICENSE).
