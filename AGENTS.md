# Gaunt Sloth Internal Development Guidelines

This file provides guidance to any AI coding agent (Claude Code, Cursor, etc.) working with this repository.

## Technologies Used

- NodeJS 22 (LTS)
- Vitest 3 for tests
- Typescript 5
- LangChain and LangGraph 0.3

Please refer to package.json to check exact versions

## Core Development Principles

Vendor and system abstractions and wrappers should be used in most cases.

### UX / TUI guidelines

Any change to the terminal UI (`packages/app/src/tui/`) or user-facing CLI feedback must follow
the **[TUI / CLI UX Guidelines](maintenance/ux-guidelines.md)** — the code-grounded ruleset for command
notices, `/clear` behaviour, tool-call panels, markdown, layout, the keyboard model, and colour
semantics. It implements Project TAKAHĒ's cross-surface Design Language (the `DL-n` principles).
When you add or change a user-facing behaviour, cite the DL principle it serves and update that doc.

### Imports

Project uses import alias with `#src/*.js` pointing to `src/` and after build resolving to generated `dist/`.
Please abstain from using relative imports, only use them when no other choices are available
(currently the only exception is entry point cli.js)

### Architecture and Flow

- Make sure proper separation of LangChain components (LLMs, chains, agents, tools)
- Check for clear data flow between components
- Ensure proper state management in LangGraph workflows
- Validate error handling and fallback mechanisms

### Security

- Make sure API key handling and environment variables
- Make sure no personal data is present in code
- **Make sure that API keys are NOT accidentally included into diff.**
- Check for proper input sanitization
- Verify output validation and sanitization

### Output

Use [consoleUtils.ts](src/consoleUtils.ts) to output to users.
Do not use console.log directly.

### System

Use [systemUtils.ts](src/systemUtils.ts) to access system variables and functions such as
process.env, process.stdout, etc.

### LLM

Use [llmUtils.ts](src/llmUtils.ts) to access LLM.

### Middleware

Starting with v1.0.0, Gaunt Sloth uses LangChain middleware pattern instead of hooks.

Middleware provides hooks to intercept and control agent execution at critical points:
- `beforeModel`: Called before model invocation
- `afterModel`: Called after model response
- `beforeAgent`: Called before agent initialization
- `afterAgent`: Called after agent completion
- `wrapModelCall`: Wrap model calls with full control
- `wrapToolCall`: Wrap tool calls with full control

**Predefined Middleware:**
- `anthropic-prompt-caching`: Reduces API costs by caching prompts (Anthropic only)
- `summarization`: Condenses conversation history when approaching token limits

**Configuration:**
- Middleware is configured in the `middleware` array in config
- JSON configs support predefined middleware (string or config object)
- JS configs support both predefined and custom middleware objects

**Implementation:**
- Middleware registry is in [src/middleware/registry.ts](src/middleware/registry.ts)
- Middleware types are in [src/middleware/types.ts](src/middleware/types.ts)
- Provider-specific middleware can be auto-injected via `postProcessJsonConfig()` in preset files

### AG-UI Server (`@gaunt-sloth/api`)

`startAgUiServer()` ([packages/api/src/modules/apiAgUiModule.ts](packages/api/src/modules/apiAgUiModule.ts))
exposes the agent over the AG-UI protocol at `POST /agents/:agentId/run`,
streaming typed SSE events. It is intended for **local clients only** (a local
web UI talking to a local CLI agent); do not expose it to public networks.

Request handling:
- A request carrying `forwardedProps.command.resume` resumes a graph suspended
  by `interrupt()` (client-fulfilled tools); otherwise it starts a fresh run.
- The client is the source of truth for history: it sends the full message list
  every turn, and LangGraph's `add_messages` reducer dedupes by message id, so
  re-sending prior messages does not duplicate state on the checkpointer.

**Be defensive when converting client messages.** A single malformed message
must never abort a run — because it is part of the persisted history, it would
otherwise poison every subsequent turn on the thread. In particular, tool-call
`arguments` strings are parsed via `parseToolArguments()`, not raw `JSON.parse`:
local models (Ollama/Gemma) do not honor `disable_parallel_tool_use`, and their
streamed delta reassembly can concatenate sibling calls' argument buffers into
invalid JSON such as `{}{}` or `{"steps":3}{}`. The parser recovers the first
complete JSON value, warns via `displayWarning`, and falls back to `{}`. Keep
new client-message parsing on this resilient path.

## Tool Use

Precedence for your tool use:
1. Your built-in tools (e.g. Read, Edit, Write, Glob, Grep, etc.)
2. Bash commands that are documented in this file and in README.md
3. Other bash commands

**Examples of what to avoid:**
- ❌ `cat file.txt` → ✅ Use Read tool
- ❌ `grep pattern file.txt` → ✅ Use Grep tool
- ❌ `echo content > file.txt` → ✅ Use Write tool
- ❌ `find . -name "*.js"` → ✅ Use Glob tool

Abstain from using bash commands when you already have a built-in tool,
every time you use a bash command that is not in allow-list, it needs approval and slows down the process.

## Integration tests

Running all integration tests (takes ~10 minutes):

```bash
pnpm run it vertexai
```

Command accepts another argument which is a partial file name to filter tests,

for example `pnpm run it vertexai review` will run all tests that contain `review` in the file name.

Faster integration tests have `simple` suffix, which allows running a subset of tests quickly,
this also helps with less intelligent models:

```bash
pnpm run it vertexai simple
```

Run multiple integration test patterns:
```bash
pnpm run it vertexai prCommand reviewCommand
```

### Building and Testing

```bash
# Build the project
pnpm run build

# Run tests
pnpm test

# Run linting
pnpm run lint

# Auto-fix simple lint issues
pnpm run lint-n-fix

# Format code
pnpm run format

# Install globally for development
pnpm install -g ./
```

## Release Notes

Release notes are stored in `release-notes/` and follow a consistent format.

### Writing Release Notes

When creating release notes for a new version:

1. **File naming**: Use the pattern `v{major}_{minor}_{patch}.md` (e.g., `v1_1_0.md`)
2. **Title format**: `# v{major}.{minor}.{patch} {Brief Description}`
3. **Style**: Keep language dry and factual, not excited or marketing-oriented

### Structure

Release notes should include relevant sections:

- **New Features**: Major functionality additions
- **Potentially Breaking Changes**: Changes that might require user action
- **Bug Fixes**: Resolved issues
- **Improvements**: Refactoring, performance, architecture improvements
- **Maintenance**: Dependency updates, minor fixes

### Guidelines

- Focus on user-facing changes and impacts
- Omit internal implementation details like specific test counts or documentation updates unless relevant
- Use concrete examples where helpful
- For breaking changes, explain what users need to do
- Reference examples: `v1_0_0.md`, `v1_0_2.md`, `v1_0_4.md`, `v1_0_5.md`

### Example Structure

```markdown
# v1.1.0 Custom Tools

## New Features
- **Custom Tools Configuration:** Description of the feature...

## Potentially Breaking Changes
- Removed unused configuration property...

## Improvements
- Architectural changes that benefit users...
```

## Codebase Architecture

Gaunt Sloth is a command line AI assistant for software developers, primarily focused on code reviews and question answering.

### High-Level Structure

1. **Commands**: The CLI exposes dedicated commands for each workflow:
   - `askCommand`: Q&A against supplied files, diffs, or providers
   - `reviewCommand`: General diff reviews (stdin, files, providers)
   - `prCommand`: Review GitHub pull requests with optional requirements ingestion
   - `chatCommand`: Starts an interactive chat session (default command)
   - `codeCommand`: Interactive coding session with full workspace FS access
   - `initCommand`: Bootstraps `.gsloth.config.*` for a chosen provider

2. **Modules**:
   - `questionAnsweringModule`: Builds prompts and orchestrates Q&A runs
   - `reviewModule`: Handles diff/pr reviews and requirement stitching
   - `interactiveSessionModule`: Powers chat/code sessions via `createInteractiveSession`

3. **LLM Providers**: Via LangChain the tool works with:
   - Anthropic (Claude), Google Vertex AI (Gemini), Google AI Studio, Groq
   - DeepSeek, OpenAI & OpenAI-compatible (e.g., Inception, OpenRouter)
   - xAI and any other provider configured through JS configs

4. **Content Providers / Inputs**:
   - `file`: Reads local project files
   - `text`: Passes literal strings/stdin
   - `ghPrDiffProvider`: Uses GitHub CLI to fetch PR diffs
   - `ghIssueProvider`: Pulls GitHub issue descriptions
   - `jiraIssueProvider`: Jira REST API (PAT)
   - `jiraIssueLegacyProvider`: Jira REST API v2 with legacy tokens

### Configuration System

- Configurations are stored in `.gsloth.config.js`, `.gsloth.config.json`, or `.gsloth.config.mjs`
- Guidelines are in `.gsloth.guidelines.md`
- Output files are saved to project root or `.gsloth/` directory if it exists
- Environment variables can be used for API keys (e.g., `ANTHROPIC_API_KEY`, `GROQ_API_KEY`)

## Important Architectural Concepts

1. **Command Pattern**: Commands are separated into module and handler code
2. **Provider Pattern**: Abstract interfaces for fetching content
3. **Configuration-driven**: Heavy use of configuration files
4. **Output Persistence**: Outputs can be saved to local files (opt-in via `writeOutputToFile`; off by default)
5. **Integration**: GitHub CLI and Jira integration for PR reviews

## Testing (Important)

Tests are located in `spec/`. Integration tests are located in `integration-tests/`.

- In spec files never import mocked files themselves, mock them, and a tested file should import them.
- Always import the tested file dynamically within the test.
- Mocks are hoisted, so it is better to simply place them at the top of the file to avoid confusion.
- Make sure that beforeEach is always present and always calls vi.resetAllMocks(); as a first thing.
- Create variables with vi.fn() without adding implementations to them, then apply these functions with vi.mock outside
  of the describe.
- Apply mock implementations and return values to mocks within individual tests.
- When mock implementations are common for all test cases, apply them in beforeEach.
- Make sure test actually testing a function, rather than simply testing the mock.

Example test

```typescript
import {beforeEach, describe, expect, it, vi} from 'vitest';

const consoleUtilsMock = {
    display: vi.fn(),
    displayError: vi.fn(),
    displayInfo: vi.fn(),
    displayWarning: vi.fn(),
    displaySuccess: vi.fn(),
    displayDebug: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const fsUtilsMock = {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
};
vi.mock('node:fs', () => fsUtilsMock);

describe('specialUtil', () => {
    beforeEach(() => {
        vi.resetAllMocks(); // Always reset all mocks in beforeEach

        // Set up default mock values
        fsUtilsMock.existsSync.mockImplementation(() => true);
    });

    it('specialFunction should eventually write test contents to a file', async () => {
        fsUtilsMock.readFileSync.mockImplementation((path: string) => {
            if (path.includes('inputFile.txt')) return 'TEST CONTENT';
            return '';
        });

        const {specialFunction} = await import('#src/specialUtil.js'); // Always import tested file within the test

        // Function under test
        specialFunction();

        expect(fsUtilsMock.writeFileSync).toHaveBeenCalledWith('outputFile.txt', 'TEST CONTENT\nEXTRA CONTENT');
        expect(consoleUtilsMock.displayDebug).not.toHaveBeenCalled();
        expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
        expect(consoleUtilsMock.display).not.toHaveBeenCalled();
        expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
        expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
        expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith('Successfully transferred to outputFile.txt');
    });
});
```

When mocking class constructors follow this pattern:

```javascript
// With export default
const gthFileSystemToolkitGetToolsMock = vi.fn();
vi.mock('#src/tools/GthFileSystemToolkit.js', () => {
    const GthFileSystemToolkit = vi.fn();
    GthFileSystemToolkit.prototype.getTools = gthFileSystemToolkitGetToolsMock;
    return {
        default: GthFileSystemToolkit,
    };
});

// With named exports
const otherToolkitMock = vi.fn();
vi.mock('#src/tools/OtherToolkit.js', () => {
    const OtherToolkit = vi.fn();
    OtherToolkit.prototype.getTools = otherToolkitMock;
    return {
        OtherToolkit,
    };
});
```

### Configs in tests

When you create incomplete configs please cast them as Partial,
for example `Partial<RawGthConfig>`
and later cast them to RawGthConfig when providing them as argument to function
which expects full interface. Even better option is to provide all properties.

## Releasing the Packages

All FOUR packages are version-locked and released together — the scoped set
`@gaunt-sloth/{core,agent,review}` plus the fat `gaunt-sloth` CLI (dir
`packages/app`). `packages/core/package.json` is the version source of
truth and the others are kept in lockstep (the old separate `tools`/`api`
packages were merged into `agent` long ago; the assistant is no longer excluded
or published on its own).

Releases run through a single manually-dispatched GitHub Actions pipeline
(`.github/workflows/release.yml`, `workflow_dispatch`) that gates on
lint+unit → integration tests → platform integration tests before it ships.
It follows versioning Model B — **ship the version currently in
`packages/core/package.json`, then post-bump `main` to the next version** — so
the dispatch inputs (`bump`/`preid`/`explicit_version`) describe the *next*
version, not the one being published.

Don't drive the publish steps (`release:bump`, `release:publish`, etc.) by hand;
use the pipeline. For the full procedure see
[maintenance/RELEASE-HOWTO.md](./maintenance/RELEASE-HOWTO.md).

## Development Workflow

Please follow this workflow:

- Analyze requirements.
- Develop changes.
- Make sure all tests pass `pnpm run test` and fix if possible.
    - Request relevant documentation if some of the test failures are unclear.
- Once all tests are green check lint with `pnpm run lint`.
    - If any lint failures are present try fixing them with `pnpm run lint-n-fix`.
    - If autofix didn't help, try fixing them yourself.
    - Prefer testing all user outputs, including testing the absence of unexpected outputs.
