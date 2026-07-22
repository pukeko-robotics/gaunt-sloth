# Gaunt Sloth
[![Tests and Lint](https://github.com/pukeko-robotics/gaunt-sloth/actions/workflows/unit-tests.yml/badge.svg)](https://github.com/pukeko-robotics/gaunt-sloth/actions/workflows/unit-tests.yml) [![Integration Tests](https://github.com/pukeko-robotics/gaunt-sloth/actions/workflows/integration-tests.yml/badge.svg?event=push)](https://github.com/pukeko-robotics/gaunt-sloth/actions/workflows/integration-tests.yml)

Gaunt Sloth is a command-line AI assistant for CI/CD workflows, code reviews, and DIY projects. It supports PR and diff reviews with requirements context, code and diff Q&A, interactive chat and coding sessions, and controlled automation through predefined tools and JSON or JavaScript configuration.

![GSloth Banner](assets/gaunt-sloth-logo.png)

Based on [LangChain.js](https://github.com/langchain-ai/langchainjs)

[Documentation](https://gauntsloth.app/docs/) | [Official Site](https://gauntsloth.app/) | [NPM](https://www.npmjs.com/package/gaunt-sloth) | [GitHub](https://github.com/pukeko-robotics/gaunt-sloth)

## Why?

Gaunt Sloth's promise is that it is small, extendable, cross-platform and can itself be a dependency in your project.

The GSloth was initially built as a code review tool, fetching PR contents and Jira contents before feeding them to
the LLM, but we ourselves found many more use cases which we initially did not anticipate; for example,
we may have it as a dependency in an MCP project, allowing us to quickly spin it up to simulate or test some use cases.

The promise of Gaunt Sloth:

- **Minimum dependencies**. Ideally, we aim to only have CommanderJS and some packages from LangChainJS and LangGraphJS.
- **Extensibility**. Feel free to write some JS and create your Tool, Provider or connect to the MCP server of your choice.
- **No vendor lock-in**. Just BYO API keys.
- **Easy installation via NPM**.
- **All prompts are editable** via markdown files, you are in full control.
- **Stateless code reviews** — developers can't argue it into changing its mind.
- **Run on premises** with local models on your terms.

## Workspace Packages

This repository is an NPM workspace monorepo. The dependency chain is:

`@gaunt-sloth/core` <- `@gaunt-sloth/agent` <- `gaunt-sloth`

`@gaunt-sloth/review` depends only on `@gaunt-sloth/core`, and the `gaunt-sloth` app depends on all three libraries (`@gaunt-sloth/agent`, `@gaunt-sloth/core`, `@gaunt-sloth/review`).

| Package | Description |
|---|---|
| `gaunt-sloth` | Main CLI application (`packages/app`). Installs the `gsloth`/`gth` binaries. Most users only need this package. |
| `@gaunt-sloth/agent` | Agent runtime (`packages/agent`): AG-UI server, A2A client, MCP utilities, filesystem and custom tools, and middleware registry — bundles the former tools and api packages. |
| `@gaunt-sloth/review` | Review and Q&A modules (`packages/review`) with content sources (GitHub, Jira). Includes the `gaunt-sloth-review` binary for lightweight CI pipelines. |
| `@gaunt-sloth/core` | Config system, agent infrastructure, LLM provider wrappers, and shared utilities (`packages/core`). |

Most users install `gaunt-sloth` globally and do not interact with the sub-packages directly. `@gaunt-sloth/review` can be used standalone in CI pipelines — it has no dependency on `commander`, MCP, or A2A, making it a lighter option when only review functionality is needed.

## What GSloth does

Unlike autonomous coding agents or hosted review services, GSloth is a **configuration-driven CLI tool** that you wire into your own workflows and pipelines. You choose the model, the provider, the prompts, and the tools — GSloth orchestrates them.

**Controlled automation**
- Define custom shell tools (deployments, migrations, test runs) in JSON config with parameter validation
- Connect to MCP servers, including remote servers with OAuth
- Communicate with external AI agents via the A2A protocol

**Model experimentation**
- Swap models and providers through config — no code changes needed
- Works with Anthropic, Google (Vertex AI, AI Studio), OpenAI, Groq, DeepSeek, xAI, OpenRouter, local models (LM Studio, Ollama), and any LangChain-compatible provider
- Customizable middleware pipeline (prompt caching, summarization, or your own)
- All system prompts are editable markdown files

**Code reviews and PR workflows**
- Review PRs with requirement context pulled from GitHub issues or Jira (`gsloth pr 42 12`)
- Review local diffs before committing (`git --no-pager diff | gsloth review`)
- Run automated reviews in CI/CD — post results as PR comments via GitHub Actions

**Q&A, chat, and coding sessions**
- Ask questions about specific files (`gsloth ask "explain this" -f utils.js`)
- Interactive chat and coding sessions with filesystem access

**Output handling**
- Optionally saves responses to timestamped files (off by default; enable with `-w/--write-output-to-file`)
- Materializes binary model outputs (e.g. generated images) as local files

### To make GSloth work, you need an **API key** from some AI provider, such as:

- OpenRouter
- Groq;
- DeepSeek;
- Google AI Studio and Google Vertex AI;
- Anthropic;
- OpenAI (and other providers using OpenAI format, such as Inception);
- Local AI: LM Studio, Ollama, llama.cpp, vllm (Via OpenAI endpoint)
- xAI;

`*` Any other provider supported by LangChain.JS should also work with [JS config](./docs/CONFIGURATION.md#javascript-configuration).

## Commands Overview

`gth` and `gsloth` commands are used interchangeably, both `gsloth pr 42` and `gth pr 42` do the same thing.

For detailed information about all commands, see [docs/COMMANDS.md](./docs/COMMANDS.md).

### Global Flags

These apply to every command:
- `--config <path>` – load a specific config file without moving directories
- `-i, --identity-profile <name>` – switch to another profile under `.gsloth/.gsloth-settings/<name>/`
- `-w, --write-output-to-file <value>` – control response files (`false` by default, pass `true` for standard names, `-wn`/`-w0` for false, or a filename)
- `--verbose` – enable verbose LangChain/LangGraph logs (useful when debugging prompts)

### Available Commands:

- **`init`** - Initialize Gaunt Sloth in your project (auto-detects API keys when called without arguments)
- **`get`** - Inspect the effective prompt or provider-backed input used by another command
- **`pr`** - ⚠️ This feature requires GitHub CLI to be installed. Review pull requests with optional requirement integration (GitHub issues or Jira). For CI pipelines, consider the lightweight [`@gaunt-sloth/review`](./packages/review#readme) package.
- **`review`** - Review any diff or content from various sources
- **`ask`** - Ask questions about code or programming topics
- **`chat`** - Start an interactive chat session
- **`code`** - Write code interactively with full project context

### Quick Examples:

**Initialize project:**
```bash
gsloth init              # Auto-detect API keys and select provider
gsloth init anthropic    # Or specify provider directly
```

**Review PR with requirements:**
```bash
gsloth pr 42 23  # Review PR #42 with GitHub issue #23
```

Requirements-only PR mode is not supported: `gsloth pr PROJ-123` is interpreted as a PR ID, not as requirements. Use `gsloth pr` with no positional arguments for change requirements discovery, or provide both the PR ID and requirements ID.

**Inspect command inputs:**
```bash
gsloth get pr prompt
gsloth get pr content 42
gsloth get review requirements PROJ-123
```

**Review local changes:**
```bash
git --no-pager diff | gsloth review
```

**Review changes between a specific tag and the HEAD:**
```bash
git --no-pager diff v0.8.3..HEAD | gth review
```

**Review diff between head and previous release and head using a specific requirement source (GitHub issue 38), not the one which is configured by default:
```bash
git --no-pager diff v0.8.10 HEAD | npx gth review --requirements-source github -r 38
```

**Ask questions:**
```bash
gsloth ask "What does this function do?" -f utils.js
```

**Write release notes:**
```bash
git --no-pager diff v0.8.3..HEAD | gth ask "inspect existing release notes in release-notes/v0_8_2.md; inspect provided diff and write release notes to v0_8_4.md"
```

To write this to filesystem, you'd need to add filesystem access to the *ask* command in `.gsloth.config.json`.

```json
{"llm": {"type": "vertexai", "model": "gemini-2.5-pro"}, "commands": {"ask": {"filesystem": "all"}}}
```

*You can improve this significantly by modifying project guidelines in `.gsloth.guidelines.md` or maybe with keeping instructions in file and feeding it in with `-f`.


**Interactive sessions:**
```bash
gsloth chat  # Start chat session
gsloth code  # Start coding session
```
Running `gsloth` with no subcommand also drops you into `chat`.

## Installation

Tested with Node 22 LTS.

### NPM
```bash
npm install gaunt-sloth -g
```

The 2.0 line is still prerelease, published under `@alpha`/`@beta`/`@rc` tags rather than
`@latest` — a bare `npm install gaunt-sloth -g` currently installs the 1.x bridge release.
Use `npm install gaunt-sloth@alpha -g` (or `@beta`/`@rc`) to get 2.0. Upgrading from the old
`gaunt-sloth-assistant` package? See
[Upgrading from `gaunt-sloth-assistant` (1.x)?](docs/MIGRATION.md#upgrading-from-gaunt-sloth-assistant-1x)
in `docs/MIGRATION.md` first.

## Configuration

> Gaunt Sloth currently only functions from a directory tree which has a configuration file (`.gsloth.config.js`, `.gsloth.config.json`, or `.gsloth.config.mjs`). Configuration files can be located in the project root or in the `.gsloth/.gsloth-settings/` directory.
>
> You can also specify a path to a configuration file directly using the `-c` or `--config` global flag, for example `gth -c /path/to/your/config.json ask "who are you?"`
> Note, however, is that project guidelines are going to be used from current directory if they exist and simple install dir prompt is going to be used if nothing found.

Configuration can be created with `gsloth init [vendor]` command.
Currently, openrouter, anthropic, groq, deepseek, openai, google-genai, vertexai and xai can be configured with `gsloth init [vendor]`.
For OpenAI-compatible providers like Inception, use `gsloth init openai` and modify the configuration.

More detailed information on configuration can be found in [CONFIGURATION.md](./docs/CONFIGURATION.md)

Gaunt Sloth also supports `.aiignore` for excluding files from filesystem tools, with overrides via config.

### Custom Tools

Gaunt Sloth supports defining custom shell commands that the AI can execute. These custom tools:
- Work across all commands (`pr`, `review`, `code`, `ask`, `chat`)
- Can be configured globally or per-command
- Support parameters with security validation
- Are useful for deployments, migrations, automation, and more

**Example configuration:**
```json
{
  "llm": {"type": "vertexai", "model": "gemini-2.5-pro"},
  "customTools": {
    "deploy": {
      "command": "npm run deploy",
      "description": "Deploy the application"
    },
    "run_migration": {
      "command": "npm run migrate -- ${name}",
      "description": "Run a database migration",
      "parameters": {
        "name": {"description": "Migration name"}
      }
    }
  }
}
```

See [Custom Tools Configuration](./docs/CONFIGURATION.md#custom-tools-configuration) for complete documentation.

### Google GenAI (AI Studio)

```bash
cd ./your-project
gsloth init google-genai
```
Make sure you either define `GOOGLE_API_KEY` environment variable or edit your configuration file and set up your key.
It is recommended to obtain API key from Google AI Studio official website rather than from a reseller.

### Google Vertex AI

```bash
cd ./your-project
gsloth init vertexai
gcloud auth login
gcloud auth application-default login
```

As of 19 Nov 2025, Gemini 3 on Vertex AI works with `global` and `us-central1` locations when using the default `aiplatform.googleapis.com` endpoint.
However, regional endpoints (e.g., `us-central-aiplatform.googleapis.com`) currently return 404 for Gemini 3.
Example config:
```json
{
  "llm": {
    "type": "vertexai",
    "model": "gemini-3-pro-preview",
    "location": "global"
  }
}
```

### Open Router

```bash
cd ./your-project
gsloth init openrouter
```

Make sure you either define `OPEN_ROUTER_API_KEY` environment variable or edit your configuration file and set up your key.

### Anthropic

```bash
cd ./your-project
gsloth init anthropic
```

Make sure you either define `ANTHROPIC_API_KEY` environment variable or edit your configuration file and set up your key.

### Groq
```bash
cd ./your-project
gsloth init groq
```
Make sure you either define `GROQ_API_KEY` environment variable or edit your configuration file and set up your key.

### DeepSeek
```bash
cd ./your-project
gsloth init deepseek
```
Make sure you either define `DEEPSEEK_API_KEY` environment variable or edit your configuration file and set up your key.
It is recommended to obtain API key from DeepSeek official website rather than from a reseller.

### OpenAI
```bash
cd ./your-project
gsloth init openai
```
Make sure you either define `OPENAI_API_KEY` environment variable or edit your configuration file and set up your key.

### LM Studio
LM Studio provides a local OpenAI-compatible server for running models on your machine:
```bash
cd ./your-project
gsloth init openai
```
Then edit your configuration file to point to LM Studio (default: `http://127.0.0.1:1234/v1`).
Use any string for the API key (e.g., `"none"`) - LM Studio doesn't validate it.

**Important:** The model must support tool calling. Tested models include gpt-oss, granite, nemotron, seed, and qwen3.

See [CONFIGURATION.md](./docs/CONFIGURATION.md#lm-studio) for detailed setup.

### OpenAI-compatible providers (Inception, etc.)
For providers using OpenAI-compatible APIs:
```bash
cd ./your-project
gsloth init openai
```
Then edit your configuration to add custom base URL and API key. See [CONFIGURATION.md](./docs/CONFIGURATION.md) for examples.

### xAI
```bash
cd ./your-project
gsloth init xai
```
Make sure you either define `XAI_API_KEY` environment variable or edit your configuration file and set up your key.

### Other AI providers
Any other AI provider supported by Langchain.js can be configured with js [Config](./docs/CONFIGURATION.md).
For example, Ollama can be set up with JS config (some of the models, see https://github.com/pukeko-robotics/gaunt-sloth/discussions/107)

### JavaScript Configuration with Custom Middleware and Tools
JavaScript configs enable advanced customization including custom middleware and tools that aren't available in JSON configs. See the [JavaScript config example](./examples/js-config/README.md) for a complete demonstration of creating custom logging middleware and custom tools.

## Integration with GitHub Workflows / Actions

Example GitHub workflows integration can be found in [.github/workflows/review.yml;](.github/workflows/review.yml)
this example workflow performs AI review on any pushes to Pull Request, resulting in a comment left by,
GitHub actions bot.

## MCP (Model Context Protocol) Servers

Gaunt Sloth supports connecting to MCP servers, including those requiring OAuth authentication.

This has been tested with the Atlassian Jira MCP server.
See the [MCP configuration section](./docs/CONFIGURATION.md#model-context-protocol-mcp) for detailed setup instructions, or the [Jira MCP example](./examples/jira-mcp) for a working configuration.

If you experience issues with the MCP auth try finding `.gsloth` dir in your home directory,
and delete JSON file matching the server you are trying to connect to,
for example for atlassian MCP the file would be `~/.gsloth/.gsloth-auth/mcp.atlassian.com_v1_sse.json`

## A2A (Agent-to-Agent) Protocol Support (Experimental)

Gaunt Sloth supports the [A2A protocol](https://a2a-protocol.org/) for connecting to external AI agents. See [CONFIGURATION.md](./docs/CONFIGURATION.md#a2a-agent-to-agent-protocol-support-experimental) for setup instructions.

## Uninstall
Uninstall global NPM package:
```bash
npm uninstall -g gaunt-sloth
```

Remove global config (if any)
```bash
rm -r ~/.gsloth
```

Remove configs from project (if necessary)
```bash
rm -r ./.gsloth*
```

## Contributing
Contributions are welcome through GitHub Issues and pull requests.
For contributor workflow, local setup, testing expectations, and PR guidance, see [CONTRIBUTING.md](./CONTRIBUTING.md).
Project participation is also covered by the [Code of Conduct](./CODE_OF_CONDUCT.md).

Filing a bug? Run `/debug-dump` in your `chat`/`code` session to attach a diagnostic archive to
the issue — see [docs/debug-dump.md](./docs/debug-dump.md).

## License
License is [MIT](https://opensource.org/license/mit). See [LICENSE](LICENSE)
