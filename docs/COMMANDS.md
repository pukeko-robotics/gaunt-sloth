# Commands

This document provides detailed information about all available commands in Gaunt Sloth.

## Overview

Gaunt Sloth provides several commands to help with code review, analysis, and interaction. All commands can be executed using either `gsloth` or `gth`.

## Global Options

Every command supports these shared flags:

- `--config <path>` – load a specific configuration file (without changing directories); accepts any supported config format (`.json`, `.jsonc`, `.js`, `.mjs`)
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

## exec

Run a markdown prompt-executable reliably and near-deterministically — the non-interactive, prompt-as-script sibling of `ask`.

```bash
gsloth exec [script]
```

`exec` streams its result to stdout (so it pipes cleanly) and is **non-interactive** — there is no ESC-to-interrupt and nothing is written to a report file unless you pass `-w`. A non-zero exit code signals failure.

### Arguments
- `[script]` - Path to the `.md` prompt-executable to run. Optional: the script can instead be supplied inline with `-m` or piped on stdin.

### Options
- `-m, --message <text>` - Inline prompt text to execute instead of a script file path. Cannot be combined with `[script]`.
- `-f, --file [files...]` - Additional context files. Their content is added BEFORE the script.
- `-t, --temperature <number>` - LLM sampling temperature for this run (`0` = most deterministic).
- `--allow-dir <path>` - Allow filesystem access to an extra directory beyond the cwd for this run (repeatable). Removes the default cwd sandbox guardrail — use with care.

### Description
The script is resolved in precedence order: `-m/--message` inline text, then the `[script]` path argument, then stdin. Extra `-f` files are prepended as context. `exec` runs the same single-shot agent runtime as `ask`, tuned for reproducible "do-the-job" runs.

### Examples
```bash
# Run a prompt-executable script
gsloth exec scripts/release-notes.md

# Inline prompt, most deterministic
gsloth exec -m "Summarize CHANGELOG.md in three bullets" -t 0

# Pipe a script on stdin
cat scripts/lint-summary.md | gsloth exec

# Add context files before the script
gsloth exec scripts/build-fix.md -f error.log package.json
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
gsloth eval <suites...>
```

`eval` is **non-interactive**: it reads the suite(s) from the file/directory arguments, never from stdin, and never prompts for approval. Its exit code is the pass/fail gate, so it drops straight into CI.

### Arguments
- `<suites...>` - One or more eval suite YAML **files** and/or **directories** (required). A directory runs its direct-child `*.yaml`/`*.yml` suites (non-recursive, sorted). See [Running many suites](#running-many-suites).

### Options
- `-j, --concurrency <n>` - Maximum cases run in parallel (default: the shared batch runner pool size)
- `-o, --output <dir>` - Directory to write structured per-case JSON plus a `results.json` summary to (default: a timestamped `gth_<date>_EVAL` directory alongside other reports)
- `--judge <profile>` - Identity profile whose model grades `judge:` rubrics. Overrides the suite's `judge_profile`; omit both to judge with the SUT's own model.
- `-r, --reporter <names>` - Reporter(s) to render the run through (repeatable, or comma-separated). Built-in: `text` (the default console summary) and `junit` (writes a JUnit `results.xml`); names from the config [`reporters`](CONFIGURATION.md#custom-eval-reporters-reporters) map work too. **Replaces the default set rather than adding to it** — `--reporter junit` drops the console summary, so pass `--reporter text,junit` to keep both. The always-on `results.json` + per-case JSON are written regardless.

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
| `target` | yes | The system under test. `type` is `gth-agent` (the in-process agent, the default choice; `profile` is optional and, if set, must be `default`), `adk-agent` (an external Google ADK agent over A2A; requires `url`), or `ag-ui` (an external agent over the AG-UI protocol; requires `url` and `agent_id`). |
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
| `must_error` | string[] | For **each** pattern, at least one called tool matching it **returned an error** (the tool result's real error status, not text sniffing). Globs supported, same matcher as `must_call`. |
| `tool_result_json_path` | list | Each entry is `{ tool, path }` plus optionally `equals` **or** `contains`. At least one result from a tool matching `tool` (glob) parses as JSON and `path` resolves in it (and matches `equals`/`contains` when set; neither = existence check). A non-JSON payload fails the entry. |
| `judge` | string | A rubric graded 0–10 by the judge model; passes when the score is ≥ the case's `pass_threshold`. |

#### Tool-result assertions

`must_call` proves a tool was *called*; `must_error` and `tool_result_json_path` prove what it *returned*. That closes the authorization-suite gap: a restricted identity that called the tool and got real data back looks identical to one that got denied, unless you check the result — and without these keys only the judge could tell them apart. Assert "called **and** denied" structurally:

```yaml
- id: restricted-module-denied
  prompt: "Fetch the contracts report."
  expect:
    - identities: [limited]
      must_call: ["mcp__contracts__report"]        # it tried the tool…
      must_error: ["mcp__contracts__report"]       # …and the call came back as an error
      tool_result_json_path:
        - { tool: "mcp__contracts__report", path: "error.code", equals: "MODULE_DISABLED" }
```

Tool-result assertions read the in-process tool trace, so they require `target.type: gth-agent`; a suite using them with an `ag-ui` or `adk-agent` target is rejected before anything runs (exit `2`). Result payloads are captured up to 8 KB — a longer payload is truncated and then fails `tool_result_json_path` as non-JSON.

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

A matrix suite runs from its `identities:` list alone — you do **not** need to pass a base `-i` on the CLI (the cases run under the listed profiles, and rubric `judge:` grading falls back to the first identity's model unless a `judge_profile`/`--judge` is set). A project with only per-identity configs (and no base config) still works.

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

### Running many suites

Pass several files, a directory, or a mix — `eval` runs them all under **one** aggregate exit code, so a CI step can gate on a whole tree of suites at once. A directory expands to its **direct-child** `*.yaml`/`*.yml` files (non-recursive, sorted); the same file named twice runs once.

```bash
gsloth eval eval/js-basics.yaml eval/authz-matrix.yaml   # two files
gsloth eval eval/ -o eval/out --reporter junit           # every suite in a directory
```

- **One suite** → output is written directly into the `-o` dir, exactly as before.
- **Many suites** → each writes into its own `<output>/<suite-name>/` subdir (`results.json`, per-cell JSON, and `results.xml` if `--reporter junit`), so a CI glob like `eval/out/**/*.xml` collects them and suites never clobber each other. On a name clash the later suite gets a `-2`/`-3` suffix and a warning.
- The **aggregate exit** is `0` only if every cell of every suite passed, `1` if any gradeable cell failed, and `2` if **any** suite hit a harness error (a bad suite doesn't stop the good ones — they still run and write output, but the run as a whole reports `2`). A final `EVAL TOTAL:` line summarizes the combined pass/fail count.

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

## batch

Run one prompt-executable across a matrix of models and/or content-bound inputs — "xargs for prompts", the way `exec` runs a single one.

```bash
gsloth batch <script> --over <csv|jsonl> [--models a,b,c] [-j 8] [--retry 2] [-o out/]
```

`batch` exits `0` as long as the cells *ran* — a poor-quality answer is **not** a harness failure (grading answers is [`eval`](#eval)'s job). Only a harness-level error (a malformed `--over` file, a missing script) sets a non-zero exit code; each cell's outcome is recorded in that cell's structured JSON output.

### Arguments
- `<script>` - Path to the `.md` prompt-executable script to run over the matrix (required).

### Options
- `--over <path>` - CSV or JSONL file whose rows/records bind into the script via `{{field}}` placeholders — one matrix cell per row (content binding only; a glob-of-files path binding is not supported by this command).
- `--models <list>` - Comma-separated list of models to fan out over. Omit to use the configured model (no fan-out).
- `-j, --concurrency <n>` - Maximum in-flight cells.
- `--retry <n>` - Retry a failed cell up to `n` times (default: `0`, no retry).
- `-o, --output <dir>` - Directory to write structured per-cell JSON plus a `results.json` summary to (default: a timestamped dir alongside other gth reports).

### Description
The matrix is the cross-product of the model axis (`--models`) and the input axis (`--over` rows). Each cell is an isolated single-shot run; results and a pass/fail tally are written to the output directory. Use `batch` to *produce* answers at scale and `eval` to *grade* them.

### Examples
```bash
# Run one script across three models
gsloth batch prompts/classify.md --models claude-sonnet-4-5,gpt-4o,gemini-2.5-pro

# Bind CSV rows into the script via {{field}} placeholders, 8 cells in parallel
gsloth batch prompts/triage.md --over data/tickets.csv -j 8

# Fan out over models AND rows, retry failed cells, write to a named dir
gsloth batch prompts/triage.md --over data/tickets.jsonl \
  --models claude-sonnet-4-5,gpt-4o --retry 2 -o out/triage
```

## workflow

Run a local JS orchestration script that drives one or more agent calls.

```bash
gsloth workflow <script> [--args <json>]
```

> **Runs with full Node privileges.** The script is arbitrary local ESM — it can read files and spawn processes. Run only scripts you trust, as you would any local script.

### Arguments
- `<script>` - Path to the `.mjs`/`.js` workflow script. Its default export is `async (ctx) => result`.

### Options
- `--args <json>` - A JSON value passed to the script as `ctx.args`.

### Description
The workflow's return value is its output: a string is printed as-is, anything else is printed as pretty-printed JSON. A malformed `--args` value or an error thrown by the script fails the command with a clean message and a non-zero exit code.

### Examples
```bash
# Run a workflow script
gsloth workflow workflows/summarize-prs.mjs

# Pass a JSON argument the script reads as ctx.args
gsloth workflow workflows/triage.mjs --args '{"label":"bug","limit":20}'
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

## config

Inspect and validate the resolved Gaunt Sloth configuration, without building the LLM.

```bash
gsloth config print [--json]
gsloth config validate
```

Both subcommands resolve the config exactly as a real run would — up-tree discovery, the global base, and the defaults merge — and honour the global `--config` / `-i, --identity-profile` overrides.

### Subcommands
- `config print` - Print the fully-resolved configuration with secrets redacted. By default it prints a source header followed by the JSON; `--json` emits only the JSON object (machine-readable, no header) so it pipes cleanly.
- `config validate` - Validate the effective configuration against the schema. Unknown keys warn; a schema violation prints a path-scoped message and exits non-zero. Every layer (project + global) is reported, so you fix all offending files at once.

### Options
- `--json` - (`config print` only) Emit only the JSON object, no header.

### Examples
```bash
# Print the resolved config (secrets redacted)
gsloth config print

# Emit just the JSON object and pull one field out with jq
gsloth config print --json | jq '.llm'

# Validate the config; exits non-zero when invalid
gsloth config validate
```

## history

Search and list locally-recorded session history.

```bash
gsloth history list [--limit <n>] [--db <path>]
gsloth history search <query...> [--limit <n>] [--db <path>]
gsloth history show <id> [--db <path>]
```

Recording is **opt-in and local only** — nothing here touches the network. Sessions are stored only when `history.enabled: true` is set in your config; with no store present these commands report that there is no history yet rather than creating one. The store defaults to `~/.gsloth/history.db` (overridable via the `history.dbPath` config key or the `--db` flag).

### Subcommands
- `history list` - List the most recent conversations, grouped with a turn count and timespan.
- `history search` - Full-text search across past turns (SQLite FTS5); each hit shows the conversation it belongs to.
- `history show` - Print a whole conversation thread, all turns in order.

### Arguments
- `<query...>` - (`history search`) One or more search terms.
- `<id>` - (`history show`) Conversation id, as printed by `history list` / `history search`.

### Options
- `--db <path>` - Path to the history DB (defaults to `~/.gsloth/history.db`).
- `--limit <n>` - (`history list` / `history search`) Maximum results (default: `20`).

### Examples
```bash
# List recent conversations
gsloth history list

# Full-text search past sessions
gsloth history search vertexai timeout

# Print one conversation thread by id (from `history list`)
gsloth history show 42
```

## insights

Show local analytics over recorded session history.

```bash
gsloth insights [--db <path>]
```

Read-only analytics over the same opt-in [`history`](#history) store — token and cost totals, a top-tool tally, and a per-command breakdown. Local only: nothing leaves the machine, and with no store present it reports that there is no history yet rather than creating one. Enable recording with `history.enabled: true` in your config.

### Options
- `--db <path>` - Path to the history DB (defaults to `~/.gsloth/history.db`).

### Examples
```bash
# Show local usage analytics
gsloth insights

# Point at a specific history DB
gsloth insights --db ./project-history.db
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
