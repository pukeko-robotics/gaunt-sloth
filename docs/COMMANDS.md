# Commands

This document provides detailed information about all available commands in Gaunt Sloth.

## Overview

Gaunt Sloth provides several commands to help with code review, analysis, and interaction. All commands can be executed using either `gsloth` or `gth`.

## Global Options

Every command supports these shared flags:

- `--config <path>` – load a specific configuration file (without changing directories)
- `-i, --identity-profile <name>` – use prompts/configs from `.gsloth/.gsloth-settings/<name>/`
- `-w, --write-output-to-file <value>` – control output files (`true` by default, use `-wn`/`-w0` for false, or pass a relative filename)
- `--verbose` – enable verbose LangChain/LangGraph logs for troubleshooting

## init

Initialize Gaunt Sloth in your project.

```bash
gsloth init [type]
```

### Arguments
- `[type]` - Configuration type (optional). Available options: `anthropic`, `groq`, `deepseek`, `openai`, `google-genai`, `vertexai`, `openrouter`, `xai`. When omitted, the command detects available API keys in the environment and prompts you to select a provider.

### Description
Creates the necessary configuration files for your project. By default, a `.gsloth` directory is created in the project root, and configuration files are placed in `.gsloth/.gsloth-settings/`. For backward compatibility, if configuration is created in a project without a `.gsloth` directory already present, it will be created automatically.
- `.gsloth.config.json` - Configuration file
- `.gsloth.guidelines.md` - Project guidelines file
- `.gsloth.review.md` - Code review instructions

### Examples
```bash
gsloth init              # Auto-detect API keys and prompt for provider
gsloth init vertexai
gsloth init anthropic
gsloth init groq
```

## get

Inspect the effective system prompt or provider-backed input used by other commands.

```bash
gsloth get <command> prompt
gsloth get <review|pr> <content|requirements> <id>
```

### Arguments
- `<command>` - Command to inspect. Supported prompt targets: `ask`, `review`, `pr`, `pr-discovery`, `chat`, `code`
- `<content|requirements>` - Provider-backed input type for `review` or `pr`
- `<id>` - Provider-backed content identifier, such as a PR number or issue key

### Description
Use this command to inspect what Gaunt Sloth would send before running a command:
- `gsloth get <command> prompt` prints the combined system prompt for that command
- `gsloth get review ...` and `gsloth get pr ...` print the wrapped provider payload exactly as it would be injected into the LLM input

### Examples
```bash
# Print the effective system prompt for review
gsloth get review prompt

# Print the discovery-agent system prompt used by change requirements discovery
gsloth get pr-discovery prompt

# Print the wrapped PR diff that `gsloth pr 42` would use
gsloth get pr content 42

# Print the wrapped Jira requirements payload for a review
gsloth get review requirements PROJ-123
```

## pr

Review a Pull Request in the current directory.

```bash
gsloth pr [prId] [requirementsId]
```

### Arguments
- `[prId]` - Pull request ID to review. Omit both `prId` and `requirementsId` to discover the change requirements from the current branch's PR (see below)
- `[requirementsId]` - Optional requirements ID to retrieve requirements from provider. This argument is only supported together with `prId`; requirements-only syntax such as `gsloth pr PROJ-123` is not supported.

### Options
- `-p, --requirements-provider <provider>` - Requirements provider for this review
- `-f, --file [files...]` - Input files to add before the diff
- `-m, --message <message>` - Additional reviewer instructions inserted before the diff

### Prerequisites
- GitHub CLI (`gh`) must be installed and authenticated
- For optimal reviews, the PR branch should be checked out locally

### Description
Reviews a pull request using GitHub as the default content provider. Can integrate with issue tracking systems to include requirements in the review.

### Change Requirements Discovery

Running `gsloth pr` with no positional arguments triggers change requirements discovery. Discovery only runs when neither
`prId` nor `requirementsId` is provided; `gsloth pr PROJ-123` is not treated as requirements-only
discovery and is unsupported. The diff for the current branch's PR is fetched
deterministically with `gh pr diff`, and the PR description is inspected for an explicit
requirements reference (a linked GitHub issue or a Jira key, depending on the configured
requirements provider). When both are found, the review starts immediately. Otherwise a discovery
agent runs first with the `gh_pr`, `gh_diff` and `gh_issue` tools (plus any configured tools, e.g.
a Jira MCP server) to locate the diff and requirements before handing over to the review agent.

The discovery agent's prompt can be customized by placing a `.gsloth.pr-discovery.md` file in the
project config directory or in an identity profile directory, the same way as other prompts.
Discovery behaviour is configured via `commands.pr.discovery` — see
[Change Requirements Discovery Configuration](CONFIGURATION.md#change-requirements-discovery-configuration).

### Examples
```bash
# Discover change requirements from the current branch's PR and review it
gsloth pr

# Review PR #42
gsloth pr 42

# Review PR #42 with GitHub issue #23 as requirements
gsloth pr 42 23

# Review PR #42 with JIRA issue PROJ-123
gsloth pr 42 PROJ-123 -p jira

# Unsupported: requirements-only mode is not available; provide a PR ID or use no arguments for change requirements discovery
# gsloth pr PROJ-123

# Review PR #42 with additional context from files
gsloth pr 42 -f architecture.md notes.txt
```

## review

Review any diff or content provided via stdin, files, or content providers.

```bash
gsloth review [contentId]
```

### Arguments
- `[contentId]` - Optional content ID to retrieve content from provider

### Options
- `-f, --file [files...]` - Input files to add before the content
- `-r, --requirements <requirements>` - Requirements for this review
- `-p, --requirements-provider <provider>` - Requirements provider
- `--content-provider <provider>` - Content provider
- `-m, --message <message>` - Extra message to provide before the content

### Description
Flexible review command that can process content from various sources including stdin, files, or configured providers.

### Examples
```bash
# Review current git changes
git --no-pager diff | gsloth review

# Review specific commit range
git --no-pager diff origin/main...feature-branch | gsloth review

# Review with requirements file
gsloth review -r requirements.md

# Review with custom message
git diff | gsloth review -m "Please focus on security implications"
```

## ask

Ask questions about code or general programming topics.

```bash
gsloth ask [message]
```

### Arguments
- `[message]` - The question or message

### Options
- `-f, --file [files...]` - Input files to include with the question

### Description
Ask questions with optional file context. At least one input source (message, file, or stdin) is required.

### Examples
```bash
# Ask a general question
gsloth ask "which types of primitives are available in JavaScript?"

# Ask about a specific file
gsloth ask "Please explain this code" -f index.js

# Ask about multiple files
gsloth ask "How do these modules interact?" -f module1.js module2.js

# Use with stdin
cat error.log | gsloth ask "What might be causing these errors?"
```

## chat

Start an interactive chat session with Gaunt Sloth.

```bash
gsloth chat [message]
```

It is possible to press Escape during inference to interrupt it.

### Arguments
- `[message]` - Initial message to start the chat

### Description
Opens an interactive chat session where you can have a conversation with the AI. The session maintains context throughout the conversation. Chat history is saved as `gth_<timestamp>_CHAT.md` (in `.gsloth/` when present, otherwise the project root). Running `gsloth` with no subcommand starts this chat mode automatically.

### Features
- Interactive conversation with context memory
- Type 'exit' or press Ctrl+C to end the session
- Chat history automatically saved

### Examples
```bash
# Start a chat session
gsloth chat

# Start with an initial message
gsloth chat "Let's discuss the architecture of this project"
```

## code

Write code interactively with full file system access within your project.

```bash
gsloth code [message]
```

It is possible to press Escape during inference to interrupt it.

### Arguments
- `[message]` - Initial message to start the code session

### Description
Opens an interactive coding session where the AI has full read access to your project files. This command is specifically designed for code writing tasks with enhanced context awareness. Code session history is saved to `gth_<timestamp>_CODE.md`.

### Features
- Full file system read access within project
- Interactive coding session with context memory
- Type 'exit' or press Ctrl+C to end the session
- Code history automatically saved
- Streaming disabled for better interactive experience

### Examples
```bash
# Start a code session
gsloth code

# Start with specific coding task
gsloth code "Help me refactor the authentication module"
```

## api ag-ui

Start an [AG-UI](https://github.com/ag-ui-protocol/ag-ui) compatible HTTP server that exposes the Gaunt Sloth agent over the standard AG-UI protocol.

> **Local use only.** The server has no authentication. Do not expose it to public networks.

```bash
gsloth api ag-ui [--port <port>]
```

### Options
- `--port <port>` – Port to listen on (default: `3000`, or the value of `commands.api.port` in config)

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agents/:agentId/run` | Run the agent; streams AG-UI SSE events |
| `GET`  | `/health`              | Health check — returns `{ "status": "ok" }` |

### AG-UI Event Sequence

A successful run emits events in this order:

```
RUN_STARTED
TEXT_MESSAGE_START
TEXT_MESSAGE_CONTENT  (one per streamed chunk)
...
TEXT_MESSAGE_END
RUN_FINISHED
```

On error, `RUN_ERROR` is emitted instead of the message/finished events.

### Thread Management

The server maintains per-thread state using LangGraph checkpointing. Pass the same `threadId` across multiple requests to continue a conversation. System prompts (backstory, guidelines, mode prompt) are injected only on the first request for each thread.

### Request Body

```json
{
  "threadId": "optional-string",
  "runId": "optional-string",
  "messages": [
    { "role": "user", "content": "Hello", "id": "msg-1" }
  ]
}
```

Both `threadId` and `runId` are auto-generated (UUID) when omitted.

### Examples

```bash
# Start on default port 3000
gsloth api ag-ui

# Start on a custom port
gsloth api ag-ui --port 4000

# Use a project-specific config
gth -c ./my-project/.gsloth.config.json api ag-ui --port 3000
```

```bash
# Test the health endpoint
curl http://localhost:3000/health

# Send a run request
curl -X POST http://localhost:3000/agents/default/run \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"threadId":"t1","messages":[{"role":"user","content":"Hello","id":"1"}]}'
```

## Command-Specific Configuration

Commands can be configured individually in your configuration file. See [CONFIGURATION.md](./CONFIGURATION.md) for detailed configuration options.

### Example Configuration
```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "commands": {
    "pr": {
      "contentProvider": "github",
      "requirementsProvider": "github"
    },
    "review": {
      "contentProvider": "file",
      "requirementsProvider": "file"
    }
  }
}
```

## Output Files

All command outputs are saved as markdown files:
- If `.gsloth` directory exists: Files are saved to `.gsloth/`
- Otherwise: Files are saved to the project root
- File naming: `gth_<timestamp>_<COMMAND>.md` for interactive sessions (same as for other commands)
- Control this behavior with `-w/--write-output-to-file` or the `writeOutputToFile` config option.

## Exit Codes

- `0` - Success
- `1` - Error occurred during command execution
