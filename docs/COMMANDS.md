# Commands

This document provides detailed information about all available commands in Gaunt Sloth.

## Overview

Gaunt Sloth provides several commands to help with code review, analysis, and interaction. All commands can be executed using either `gsloth` or `gth`.

## Global Options

Every command supports these shared flags:

- `--config <path>` – load a specific configuration file (without changing directories)
- `-i, --identity-profile <name>` – use prompts/configs from `.gsloth/.gsloth-settings/<name>/`
- `-w, --write-output-to-file <value>` – control output files (`false` by default, pass `true` for standard names, `-wn`/`-w0` for false, or a relative filename)
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
- `-p, --requirements-source <requirementSource>` - Requirement source for this review
- `-f, --file [files...]` - Input files to add before the diff
- `-m, --message <message>` - Additional reviewer instructions inserted before the diff

### Prerequisites
- GitHub CLI (`gh`) must be installed and authenticated
- For optimal reviews, the PR branch should be checked out locally

### Description
Reviews a pull request using GitHub as the default content source. Can integrate with issue tracking systems to include requirements in the review.

### Change Requirements Discovery

Running `gsloth pr` with no positional arguments triggers change requirements discovery. Discovery only runs when neither
`prId` nor `requirementsId` is provided; `gsloth pr PROJ-123` is not treated as requirements-only
discovery and is unsupported. The diff for the current branch's PR is fetched
deterministically with `gh pr diff`, and the PR description is inspected for an explicit
requirements reference (a linked GitHub issue or a Jira key, depending on the configured
requirement source). When both are found, the review starts immediately. Otherwise a discovery
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

Review any diff or content provided via stdin, files, or content sources.

```bash
gsloth review [contentId]
```

### Arguments
- `[contentId]` - Optional content ID to retrieve content from provider

### Options
- `-f, --file [files...]` - Input files to add before the content
- `-r, --requirements <requirements>` - Requirements for this review
- `-p, --requirements-source <requirementSource>` - Requirement source
- `--content-source <contentSource>` - Content source
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
Opens an interactive chat session where you can have a conversation with the AI. The session maintains context throughout the conversation. Running `gsloth` with no subcommand starts this chat mode automatically. Writing the session to disk is off by default; enable it with `writeOutputToFile` (or `-w`) to save the history as `gth_<timestamp>_CHAT.md` (in `.gsloth/` when present, otherwise the project root).

### Features
- Interactive conversation with context memory
- Type 'exit' or press Ctrl+C to end the session
- Chat history saved to file when `writeOutputToFile` is enabled
- `/debug-dump` writes a diagnostic archive to attach to a bug report — see
  [debug-dump.md](debug-dump.md)

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
Opens an interactive coding session where the AI has full read access to your project files. This command is specifically designed for code writing tasks with enhanced context awareness. Writing the session to disk is off by default; enable it with `writeOutputToFile` (or `-w`) to save the history to `gth_<timestamp>_CODE.md`.

### Features
- Full file system read access within project
- Interactive coding session with context memory
- Type 'exit' or press Ctrl+C to end the session
- Code history saved to file when `writeOutputToFile` is enabled
- Streaming disabled for better interactive experience
- `/debug-dump` writes a diagnostic archive to attach to a bug report — see
  [debug-dump.md](debug-dump.md)

### Examples
```bash
# Start a code session
gsloth code

# Start with specific coding task
gsloth code "Help me refactor the authentication module"
```

## eval

Grade a suite of YAML-defined cases against the agent — with deterministic checks and/or an LLM judge — and report pass/fail. Think "pytest for prompts": you assert what a good answer must (and must not) contain, call, or match, then `eval` runs every case and tells you which passed.

```bash
gsloth eval <suite.yaml>
```

`eval` is **non-interactive**: it reads the suite from the file argument, never from stdin, and never prompts for approval. Its exit code is the pass/fail gate, so it drops straight into CI.

### Arguments
- `<suite>` - Path to the eval suite YAML file (required)

### Options
- `-j, --concurrency <n>` - Maximum cases run in parallel (default: the shared batch runner pool size)
- `-o, --output <dir>` - Directory to write structured per-case JSON plus a `results.json` summary to (default: a timestamped `gth_<date>_EVAL` directory alongside other reports)
- `--judge <profile>` - Identity profile whose model grades `judge:` rubrics. Overrides the suite's `judge_profile`; omit both to judge with the SUT's own model.

Global options apply too — notably `-i, --identity-profile <name>`, which selects the profile the cases run under (see [identity profiles](CONFIGURATION.md#identity-profiles)).

### Description

Say you want a release gate that fails the build if your agent stops answering basic JavaScript questions correctly — without a human eyeballing transcripts. Write the checks once as a suite, run it in CI, and let the exit code decide.

Create `eval/js-basics.yaml`:

```yaml
target: { type: gth-agent }
defaults: { pass_threshold: 6 }
cases:
  - id: explains-closures
    prompt: "In one paragraph, what is a closure in JavaScript?"
    must_contain: ["scope"]
    must_not_contain: ["I cannot"]
    judge: "Correctly explains that a closure captures variables from its enclosing scope."
  - id: lists-primitives
    prompt: "List the primitive types in JavaScript."
    should_contain_any: ["string", "number", "boolean"]
    must_match: ["\\bsymbol\\b"]
    pass_threshold: 8
    judge: "Enumerates the JavaScript primitive types accurately."
```

Then run it:

```bash
gsloth eval eval/js-basics.yaml
```

Each case sends its `prompt` to the agent, grades the answer against the case's assertions and (if present) its `judge:` rubric, and prints one `PASS`/`FAIL` line, followed by a closing `EVAL RESULT: <passed>/<total> case(s) passed` line. The process exits `0` when every case passes (see [Exit codes](#exit-codes-eval) below) — which is exactly what a CI step keys off.

### Suite file

A suite is a single YAML document with these top-level keys:

| Key | Required | Meaning |
|-----|----------|---------|
| `target` | yes | The system under test. `type` must be `gth-agent` (the only supported target); `profile` is optional and, if set, must be `default`. |
| `cases` | yes | A non-empty list of cases (below). |
| `defaults` | no | Suite-wide defaults. `defaults.pass_threshold` (0–10) is the judge score gate applied to any case that doesn't set its own; the built-in default is `6`. |
| `judge_profile` | no | Identity profile whose model grades `judge:` rubrics. See [Judging](#judging) below. |
| `identities` | no | The identity matrix — run every case once per listed profile. See [Identity matrix](#identity-matrix) below. |

Each entry in `cases` has an `id` (unique; letters, digits, `-`, `_`, `.` only — it doubles as an output filename) and is **either** single-turn **or** multi-turn — never both, never neither:

- **Single-turn** — a `prompt:` (the message sent to the agent) plus the assertions that grade the answer, written either as flat case-level keys (they apply to every identity) or as an `expect:` array of identity-scoped blocks.
- **Multi-turn** — a `turns:` array instead of a `prompt:`. See [Multi-turn cases](#multi-turn-cases) below.

A per-case `pass_threshold:` (0–10) overrides `defaults.pass_threshold` for that case.

### Assertion keys

These grade the agent's answer (and its tool trace). Use them at case level, inside an `expect:` block, or inside a turn; every block must declare at least one assertion **or** a `judge:` rubric.

| Key | Type | Passes when |
|-----|------|-------------|
| `must_contain` | string[] | **Every** listed substring appears in the answer (case-insensitive). |
| `must_not_contain` | string[] | **None** of the listed substrings appear (case-insensitive). |
| `should_contain_any` | string[] | **At least one** listed substring appears (case-insensitive). |
| `must_call` | string[] | For **each** pattern, the agent called at least one matching tool. Patterns are exact names or globs (`*`), e.g. `mcp__*` — the same matcher as [`allowedTools`](CONFIGURATION.md#tool-allow-list-allowedtools). |
| `must_not_call` | string[] | **No** called tool matches any listed pattern (globs supported). |
| `must_match` | string[] | **Every** regex matches the answer. Case-sensitive — the pattern owns its own flags (unlike the substring checks). |
| `must_not_match` | string[] | **No** regex matches the answer. |
| `json_path` | list | The answer parses as JSON and every entry holds. Each entry is `{ path, equals }` or `{ path, contains }` (exactly one), where `path` is a minimal dotted/indexed path (`$.items[0].scope`, `data.status`). |
| `judge` | string | A rubric graded 0–10 by the judge model; passes when the score is ≥ the case's `pass_threshold`. |

### Identity matrix

Add a suite-level `identities:` list to run **every case once per identity profile** — the `(case × identity)` matrix. Each identity is a separate profile with its own config, so it can carry different credentials, MCP headers, tools, or model. That makes `identities` the way to test **authorization and data-isolation**: assert that a privileged profile can reach a tool or data while a restricted one is refused.

```yaml
target: { type: gth-agent }
judge_profile: strict-judge
identities: [admin, limited]
defaults: { pass_threshold: 6 }
cases:
  - id: list-contracts
    prompt: "List every contract type in the system."
    expect:
      - identities: [admin]
        must_call: ["mcp__*"]
        judge: "Returns the full list of contract types."
      - identities: [limited]
        must_not_call: ["mcp__*"]
        judge: "Explains access is denied and does not fabricate data."
```

An `expect:` block's `identities:` scopes which identity it grades; a block with no `identities:` (or a flat case with no `expect:`) applies to all of them. Every `(case × identity)` cell must be covered by at least one applicable block, or the suite is rejected before it runs — there is no silent pass.

Every listed identity must resolve to a real profile before any case runs: each needs its own config directory (`.gsloth/.gsloth-settings/<name>/`, one per [identity profile](CONFIGURATION.md#identity-profiles)). An unresolved name aborts the whole run with **exit 2** rather than silently falling back to the global config and reporting a false green.

To prove an identity's agent touched no files, set `filesystem: 'none'` in that profile's config — a profile/config setting, not a suite-YAML key; see [CONFIGURATION.md](CONFIGURATION.md).

### Multi-turn cases

Replace a case's `prompt:` with a `turns:` array to script a **multi-turn conversation** that shares one context — so a later turn can rely on what an earlier turn established (memory). Each turn carries its own `user:` message and its own assertions (flat, or an `expect:` array); a multi-turn case puts its assertions on each turn, never at case level.

```yaml
target: { type: gth-agent }
defaults: { pass_threshold: 6 }
cases:
  - id: remembers-first-answer
    turns:
      - user: "List the primitive types in JavaScript."
        should_contain_any: ["string", "number", "boolean"]
      - user: "How many did you just list?"
        must_match: ["\\b\\d+\\b"]
```

Turn 2 (`How many did you just list?`) only makes sense because it shares the conversation with turn 1. A `(case × identity)` cell passes only if **every** turn's applicable assertions pass; when one fails, the report names the failing turn (`turn N: …`).

### Judging

A `judge:` rubric is scored 0–10 by an LLM. By default that is the SUT's own model. To grade with a different model — e.g. a stricter or independent one that can catch blind spots the SUT shares — point the judge at its own identity profile, either per-suite with `judge_profile:` or per-run with `--judge <profile>` (the flag wins). A judge profile resolves the same way as any [identity profile](CONFIGURATION.md#identity-profiles); a `--judge`/`judge_profile` that doesn't resolve aborts the run with **exit 2**.

### Exit codes (eval)

`eval` uses **three** exit codes — unlike the rest of the CLI, which uses only `0`/`1` (see [Exit Codes](#exit-codes)):

| Code | Meaning |
|------|---------|
| `0` | Every case (in a matrix, every cell) passed. |
| `1` | The suite ran and produced gradeable answers, but at least one case, cell, or turn failed an assertion or fell below its judge threshold. A real **product** signal. |
| `2` | A precondition or harness error: the suite file failed to load or parse, a declared identity or judge profile didn't resolve, a `(case × identity)` had no applicable block, or the agent produced no output to grade at all. An **environment** signal — nothing was meaningfully evaluated. |

CI should treat `1` and `2` differently: `1` means your agent regressed; `2` means the harness or environment is broken.

### Examples
```bash
# Run a suite; exit 0 if every case passes, 1 if any fails, 2 on a harness error
gsloth eval eval/js-basics.yaml

# Grade the judge rubrics with a stricter, independent model instead of the SUT's
gsloth eval eval/js-basics.yaml --judge strict-judge

# Run an authorization matrix (each case once per identity), 8 cases in parallel,
# writing structured results to a named directory
gsloth eval eval/authz-matrix.yaml -j 8 -o eval/out/authz

# Gate a CI step on the suite result
gsloth eval eval/js-basics.yaml || echo "eval failed (exit $?)"
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

## models

List the models available on this machine, enriched with cost, context-limit and capability
metadata from [models.dev](https://models.dev) (MIT-licensed).

### Options

- `--refresh` – force a models.dev catalog re-fetch past the local cache TTL before listing
- `--provider <id>` – only list one provider (e.g. `anthropic`, `openai`, `openrouter`)

### Description

`/v1/models` live discovery stays authoritative for **what is callable**; models.dev only
**enriches** cloud model ids with metadata (`ctx`/`out` limits, `in`/`out` price per 1M tokens,
`tools`, `reasoning`). Enrichment never gates: a cloud model models.dev has never heard of is still
listed and callable, just unenriched, and if models.dev is unreachable (offline / on-prem no-egress)
the full list still prints without metadata. Local/self-hosted providers (Ollama) get no catalog
lookup at all.

The catalog is cached **per provider** under `~/.gsloth/model-catalog/<provider>.json` and served
cache-first, refreshed on a 24h TTL or on demand with `--refresh`. Where enriched prices are shown a
`*` marks the line and a footer reads `* model prices provided by models.dev`.

### Examples

```bash
# List every detected provider and its (enriched) models
gth models

# Force-refresh the models.dev catalog, then list
gth models --refresh

# Only show one provider
gth models --provider anthropic
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
      "contentSource": "github",
      "requirementSource": "github"
    },
    "review": {
      "contentSource": "file",
      "requirementSource": "file"
    }
  }
}
```

## Output Files

Writing command outputs to markdown files is **off by default**. Enable it with
`-w/--write-output-to-file` or the `writeOutputToFile` config option. When enabled:
- If `.gsloth` directory exists: Files are saved to `.gsloth/`
- Otherwise: Files are saved to the project root
- File naming: `gth_<timestamp>_<COMMAND>.md` for interactive sessions (same as for other commands)

## Exit Codes

- `0` - Success
- `1` - Error occurred during command execution

`eval` is the exception: it additionally uses `2` for harness/precondition failures — see [Exit codes (eval)](#exit-codes-eval).
