# Tools

Which tools the agent may use — the built-in toolset, the dev-command and general-purpose shell
tools, and your own custom shell commands — is configured here. This page is part of the
[configuration reference](./index.md); for the interactive approval flow behind the shell tool see
the [shell tool and approvals guide](../guides/shell-tool-and-approvals.md), and for writing your own
tools see the [custom tools guide](../guides/custom-tools.md).

## Turning on the tools the agent may use

Say you want `gth code` to run your test suite when it needs to, and to have a ready-made
`deploy_staging` command it can call. Two knobs cover both: `builtInTools` (the built-in and
dev-command tools) and `customTools` (your own shell commands).

`.gsloth.config.json`:

```json
{
  "llm": { "type": "anthropic", "model": "claude-sonnet-4-5" },
  "customTools": {
    "deploy_staging": {
      "command": "npm run deploy:staging",
      "description": "Deploy the application to staging environment"
    }
  },
  "commands": {
    "code": {
      "filesystem": "all",
      "builtInTools": {
        "gth_checklist": true,
        "run_tests": { "command": "npm test" },
        "run_shell_command": { "timeout": 300000 }
      }
    }
  }
}
```

Then start a coding session:

```bash
gth code
```

The agent now has `run_tests` (runs `npm test`), the general-purpose `run_shell_command` (arbitrary
commands, each behind a human-approval prompt — **on by default in `code` mode**, tuned here with a
longer timeout), and the `deploy_staging` custom tool. Note the explicit `"gth_checklist": true`:
because a `builtInTools` object **replaces** the default set rather than extending it, any default
you still want must be re-listed.

The rest of this page is the reference for those knobs.

## Built-in Tools (`builtInTools`)

`builtInTools` selects **and configures** which built-in tools the agent loads. It can be set at the
top level or per command (`commands.<command>.builtInTools`); a per-command value replaces the
top-level one. Available tools:

| Tool | Description |
|------|-------------|
| `gth_checklist` | Planning / todo checklist for multi-step work (the lean agent's `write_todos` equivalent). Renders as a live checkbox panel in the TUI. **Enabled by default.** |
| `gth_grep` | Regex search over file **contents** (ripgrep-backed, with an in-process fallback) — finds where a symbol or string appears, complementing `search_files`, which matches file **names**. Available in every mode; needs no shell approval. **Enabled by default.** Honors `.aiignore` and takes a `fileSet` option — see [Content search (`gth_grep`)](#content-search-gth_grep) below. |
| `gth_web_fetch` | Fetch content from an HTTP/HTTPS URL. |
| `gth_status_update` | Print a short status line to the console. |
| `show_a2ui_surface` | (AG-UI) render an A2UI surface in the web client. |
| `run_tests` / `run_lint` / `run_build` / `run_single_test` | Dev-command tools — run the configured shell command. Only active in `code` / `exec` (and `ask --write`). See [Development Tools](#development-tools-configuration). |
| `run_shell_command` | Opt-in general-purpose shell tool (arbitrary commands, human-approved). **On by default in `code` mode.** See [Shell tool](#development-tools-configuration). |

`builtInTools` accepts **two shapes**:

- a **string array** — each named tool is enabled: `["gth_checklist", "gth_web_fetch"]`;
- an **object registry** keyed by tool name, whose values **enable** (`true`), **force-disable**
  (`false`), or **configure** (an object) each tool.

The default is `["gth_checklist", "gth_grep"]`. Setting your own `builtInTools` **replaces** this set
entirely, so re-list any default you want to keep (e.g. `"gth_checklist": true`, `"gth_grep": true`).
Example — add web fetch while keeping the checklist:

```json
{
  "builtInTools": ["gth_checklist", "gth_web_fetch"]
}
```

The object form also carries the dev/shell tool configuration (in 1.x this lived in a separate
per-command `devTools` key, now removed — see [Migration](../MIGRATION.md)). Example — keep the
checklist, add web fetch, configure the test/build commands, and tune the shell:

```json
{
  "builtInTools": {
    "gth_checklist": true,
    "gth_web_fetch": true,
    "run_tests": { "command": "npm test" },
    "run_build": { "command": "npm run build" },
    "run_shell_command": { "timeout": 300000, "judge": { "enabled": true } }
  }
}
```

Turn the (code-mode default-on) shell OFF with `{ "run_shell_command": false }`.

> **Note:** because the object form (like the array form) **replaces** the default set, disabling one
> tool (e.g. `{ "run_shell_command": false }`) also drops the defaults (`gth_checklist`, `gth_grep`)
> unless you list them too. To keep them, add `"gth_checklist": true` / `"gth_grep": true` to the
> registry.

### Content search (`gth_grep`)

`gth_grep` is enabled by default. Its `fileSet` option, set through the `builtInTools` registry,
chooses which files it searches:

| `fileSet` | Corpus searched |
|-----------|-----------------|
| `gitignore` (**default**) | Respects `.gitignore` / `.ignore` and skips hidden dot-files (ripgrep's native behavior). |
| `all` | Everything except the noise directories `.git`, `node_modules`, `dist`, `.idea`. |

```json
{
  "builtInTools": {
    "gth_checklist": true,
    "gth_grep": { "fileSet": "all" }
  }
}
```

Disable it with `{ "gth_grep": { "enabled": false } }` (or `{ "gth_grep": false }`).

**Whatever the `fileSet`, `gth_grep` honors [`.aiignore`](./content-sources.md#ai-ignore-aiignore).**
It reads file contents through its own search path, so it enforces the same `.aiignore` privacy
boundary as the filesystem tools: a file hidden by `.aiignore` is never searched or returned, even
under `fileSet: "all"`. (`.gitignore` decides what stays out of version control; `.aiignore` decides
what the AI may read at all — so a tracked, non-ignored file can still be kept out of `gth_grep` by
`.aiignore`.)

## Development Tools Configuration

The `code` / `exec` commands (and `ask --write`) can run development tools, configured under the
unified [`builtInTools`](#built-in-tools-builtintools) registry (in 1.x this was a separate
per-command `devTools` key, now removed — see [Migration](../MIGRATION.md)).

The dev-command tools are defined in `packages/agent/src/tools/GthDevToolkit.ts`; each is configured
with a `{ "command": "…" }` object:

- **run_tests**: Executes the full test suite.
- **run_single_test**: Runs a single test file. The test path must be relative.
- **run_lint**: Runs the linter, potentially with auto-fix.
- **run_build**: Builds the project.

These tools execute the configured shell commands and capture their output.

**Note:** a per-command `builtInTools` object (like the root one) **replaces** the root set entirely,
including the default `gth_checklist` planning tool. List `"gth_checklist": true` explicitly in the
command's registry to keep it (as the examples below do).

Example configuration including dev tools (from .gsloth.config.json):

```json
{
  "llm": {
    "type": "xai",
    "model": "grok-4-0709"
  },
  "commands": {
    "code": {
      "filesystem": "all",
      "builtInTools": {
        "gth_checklist": true,
        "run_build": { "command": "npm build" },
        "run_tests": { "command": "npm test" },
        "run_lint": { "command": "npm run lint-n-fix" },
        "run_single_test": { "command": "npm test" }
      }
    }
  }
}
```

Note: For `run_single_test`, the command can include a placeholder like `${testPath}` for the test file path.
Security validations are in place to prevent path traversal or injection.

### General-purpose shell tool (`run_shell_command`)

`run_shell_command` lets the agent run arbitrary shell commands it composes itself. It is **ON by
default in `code` mode** (each invocation still gated behind a per-command human-approval prompt),
and OFF in `exec` / `ask --write` unless enabled. Configure it via its `builtInTools` entry:

- `true` / `false` — enable / force-disable (an object without `enabled` also defaults ON in `code`).
- `timeout` — per-command wall-clock limit in **milliseconds** (default `120000`).
- `maxOutputBytes` — byte budget for the captured output returned to the model (default `100000`).
- `allowlist` — master switch for the scoped approval allow-list (default `true`).
- `persistAllowlist` — persist `always`-scoped approvals to `.gsloth/.gsloth-settings/shell-allowlist.json` (default `true`).
- `judge` — the LLM-as-judge safety gate (default OFF): `true`, or `{ "enabled": true, "autoApproveLow": true, "blockHigh": false, "model": { … } }`.
- `yolo` — opt out of the per-command approval prompt (dangerous; off by default).

A hardcoded blocklist of catastrophic commands is always refused, even under `yolo`.

```json
{
  "commands": {
    "code": {
      "filesystem": "all",
      "builtInTools": {
        "gth_checklist": true,
        "run_shell_command": {
          "timeout": 300000,
          "maxOutputBytes": 200000,
          "judge": { "enabled": true, "blockHigh": true }
        }
      }
    }
  }
}
```

For how the approval prompt, scoped allow-list, and judge gate behave at runtime, see the
[shell tool and approvals guide](../guides/shell-tool-and-approvals.md).

## Custom Tools Configuration

Custom tools allow you to define custom shell commands that the AI can execute across all commands or specific commands. Unlike development tools (which are predefined and code-specific), custom tools are fully user-defined and can be used for any purpose: deployment, migration, testing, automation, or any other shell command you need. For a worked, realistic example see the [custom tools guide](../guides/custom-tools.md).

### Key Features

- **Available Globally**: Custom tools work in ALL commands (`pr`, `review`, `code`, `ask`, `chat`) by default
- **Per-Command Control**: Each command can override or disable custom tools
- **Parameter Support**: Commands can accept dynamic parameters with security validation
- **Security**: Built-in validation prevents shell injection, directory traversal, and other attacks

### Basic Configuration

Define custom tools at the root level to make them available across all commands:

```json
{
  "llm": {
    "type": "vertexai",
    "model": "gemini-2.5-pro"
  },
  "customTools": {
    "deploy_staging": {
      "command": "npm run deploy:staging",
      "description": "Deploy the application to staging environment"
    },
    "run_e2e_tests": {
      "command": "npm run test:e2e",
      "description": "Run end-to-end tests"
    }
  }
}
```

### Custom Tools with Parameters

Custom tools can accept parameters that are validated for security:

```json
{
  "customTools": {
    "run_migration": {
      "command": "npm run migrate -- ${migrationName}",
      "description": "Run a specific database migration",
      "parameters": {
        "migrationName": {
          "description": "Name of the migration to run"
        }
      }
    },
    "docker_build": {
      "command": "docker build -t ${imageName}:${tag} .",
      "description": "Build Docker image with specified name and tag",
      "parameters": {
        "imageName": {
          "description": "Name of the Docker image"
        },
        "tag": {
          "description": "Tag for the Docker image"
        }
      }
    }
  }
}
```

### Custom Tools with Timeout

Custom tools can have an optional timeout (in seconds). If the command exceeds this duration it is killed:

```json
{
  "customTools": {
    "deploy_staging": {
      "command": "npm run deploy:staging",
      "description": "Deploy to staging environment",
      "timeout": 120
    }
  }
}
```

When omitted, no timeout is applied.

**Parameter Interpolation:**

- Use `${parameterName}` placeholders in commands
- If no placeholders exist, parameters are appended in definition order
- All parameters are validated to prevent security issues

### Per-Command Configuration

You can override or disable custom tools for specific commands:

**Override for specific command:**

```json
{
  "customTools": {
    "deploy": {
      "command": "npm run deploy:prod",
      "description": "Deploy to production"
    }
  },
  "commands": {
    "pr": {
      "customTools": {
        "deploy": {
          "command": "npm run deploy:staging",
          "description": "Deploy to staging for PR review"
        }
      }
    }
  }
}
```

**Disable for specific command:**

```json
{
  "customTools": {
    "deploy": {
      "command": "npm run deploy",
      "description": "Deploy application"
    }
  },
  "commands": {
    "review": {
      "customTools": false
    }
  }
}
```

**Note:** When a command defines its own `customTools`, it completely replaces the root-level tools for that command (no merging).

### Custom Tools vs Development Tools

| Feature          | Custom Tools                | Dev Tools                                 |
| ---------------- | --------------------------- | ----------------------------------------- |
| **Location**     | Root-level `customTools`    | `builtInTools` registry (root or command) |
| **Availability** | All commands                | `code` / `exec` (and `ask --write`)       |
| **Purpose**      | User-defined shell commands | Predefined build/test/lint + shell tools  |
| **Per-Command**  | Yes                         | Yes (via `commands.<cmd>.builtInTools`)   |
| **Parameters**   | Yes                         | Limited (run_single_test only)            |

Both can be used together:

```json
{
  "customTools": {
    "deploy": {
      "command": "npm run deploy",
      "description": "Deploy application"
    }
  },
  "commands": {
    "code": {
      "filesystem": "all",
      "builtInTools": {
        "gth_checklist": true,
        "run_tests": { "command": "npm test" },
        "run_lint": { "command": "npm run lint-n-fix" }
      }
    }
  }
}
```

### Security Validation

All custom tool parameters are automatically validated to prevent:

- **Shell injection**: Blocks `|`, `&`, `;`, `` ` ``, `$`, `$(`, newlines
- **Directory traversal**: Blocks `..`, `/../`, `\..\\`
- **Absolute paths**: Only relative paths allowed
- **Null bytes**: Blocks `\0` characters

Example of a secure custom tool that accepts a file path:

```json
{
  "customTools": {
    "process_file": {
      "command": "node scripts/process.js ${filePath}",
      "description": "Process a file in the project",
      "parameters": {
        "filePath": {
          "description": "Relative path to the file to process"
        }
      }
    }
  }
}
```

### Complete Example

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "customTools": {
    "deploy_staging": {
      "command": "npm run deploy:staging",
      "description": "Deploy to staging environment"
    },
    "run_migration": {
      "command": "npm run migrate -- ${name}",
      "description": "Run a database migration",
      "parameters": {
        "name": {
          "description": "Migration name"
        }
      }
    }
  },
  "commands": {
    "pr": {
      "customTools": {
        "validate_pr": {
          "command": "npm run validate:pr",
          "description": "Run PR validation checks"
        }
      }
    },
    "review": {
      "customTools": false
    },
    "code": {
      "filesystem": "all",
      "builtInTools": {
        "gth_checklist": true,
        "run_tests": { "command": "npm test" },
        "run_lint": { "command": "npm run lint-n-fix" }
      }
    }
  }
}
```

#### Skipping Validation Checks with `allow`

Some parameters legitimately require values that would normally be blocked by validation.
For example, deploying to a hardware device via `/dev/ttyUSB0` requires an absolute path.
The `allow` property on individual parameters lets you specify which checks to skip:

```json
{
  "customTools": {
    "deploy_lesson": {
      "command": "mpremote connect ${usbDevice} fs cp ${lesson} :main.py",
      "description": "Deploy lesson to the robot.",
      "parameters": {
        "usbDevice": {
          "description": "USB device of robot. Use `/dev/ttyUSB0` unless advised to use other device.",
          "allow": ["absolute-paths"]
        },
        "lesson": {
          "description": "Lesson to deploy, for example `fixed/lesson2/Move_Forward.py`"
        }
      }
    }
  }
}
```

In this example, only the `usbDevice` parameter allows absolute paths, while `lesson` is still validated normally.

Available `allow` values:

| Value                 | What it permits                                      |
| --------------------- | ---------------------------------------------------- |
| `absolute-paths`      | Absolute paths like `/dev/ttyUSB0` or `/usr/bin/env` |
| `directory-traversal` | Path components containing `..`                      |
| `shell-injection`     | Shell metacharacters (`\|`, `&`, `;`, etc.)          |
| `null-bytes`          | Null byte characters                                 |

Checks **not** listed in `allow` remain enforced. Each parameter can have its own `allow` list, providing fine-grained control over validation.

## Allowed tools

`allowedTools` restricts an agent to an explicit allow-list of tool names. It is applied after
every tool source (filesystem, built-in, custom, MCP, A2A and `tools`) has been resolved, so it is
the only knob that can gate individual MCP and A2A tools (e.g. `mcp__jira__getJiraIssue`), which
have no per-source override of their own.

- **omitted or `undefined`**: no filtering, all resolved tools remain available
- **non-empty array**: only tools whose name matches an entry remain available. Entries are exact
  tool names, or **glob patterns** using `*` as a wildcard — e.g. `mcp__jira__*` allows every tool
  from the `jira` MCP server without listing each one by name
- **empty array `[]`**: every tool is disabled; MCP servers are not even contacted (no OAuth),
  which suits agents that only need to reason over the provided prompt, such as review agents

> **Important:** `allowedTools: []` is not the same as omitting `allowedTools`. Use `[]` only
> when you intentionally want a tool-free agent and want to skip MCP/A2A tool discovery. Remove
> the property, or leave it `undefined` in JavaScript config, when you want all configured tools
> to remain available.

It can be set at the top level or per command via `commands.<command>.allowedTools` (the command
value takes precedence):

```json
{
  "commands": {
    "review": { "allowedTools": [] },
    "pr": { "allowedTools": [] }
  }
}
```

## Middleware

Gaunt Sloth supports middleware to intercept and control agent execution at critical points. Middleware provides hooks for cost optimization, conversation management, and custom logic.

### Predefined Middleware

The following predefined middleware are available (reference by name in `middleware`):

#### Anthropic Prompt Caching Middleware

Reduces API costs by caching prompts (Anthropic models only):

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "middleware": ["anthropic-prompt-caching"]
}
```

With custom TTL configuration:

```json
{
  "middleware": [
    {
      "name": "anthropic-prompt-caching",
      "ttl": "5m"
    }
  ]
}
```

TTL options: `"5m"` (5 minutes) or `"1h"` (1 hour)

#### Summarization Middleware

Automatically condenses conversation history when approaching token limits:

```json
{
  "middleware": ["summarization"]
}
```

With custom configuration:

```json
{
  "middleware": [
    {
      "name": "summarization",
      "maxTokensBeforeSummary": 8000,
      "messagesToKeep": 5
    }
  ]
}
```

Configuration options:

- `maxTokensBeforeSummary`: Maximum tokens before triggering summarization (default: 10000)
- `messagesToKeep`: Number of recent messages to keep after summarization
- `summaryPrompt`: Custom prompt template for summarization
- `model`: Custom model for summarization (defaults to main LLM)

#### Frontend Image Injection Middleware

For AG-UI web clients that let the model request a photo through a frontend "capture image" tool.
Such a tool runs in the browser and returns its result to the server as a `tool` message whose
content is a JSON string `{"mimeType":"image/...","data":"<base64>"}`. Without this middleware the
model receives that as plain text and cannot see the image. Enabling it converts the capture result
into a vision message (in the shape the active provider decodes) before the next model call:

```json
{
  "middleware": ["frontend-image-injection"]
}
```

It is opt-in — it only runs when listed in `middleware`. The tool name it watches for defaults to
`capture_image`; set `toolName` if your frontend tool is named differently:

```json
{
  "middleware": [
    {
      "name": "frontend-image-injection",
      "toolName": "take_photo"
    }
  ]
}
```

The provider-specific vision-block shape is chosen automatically from the configured model provider,
so the same config works across Anthropic, OpenAI-compatible, Ollama, and Google providers.

### Multiple Middleware

You can combine multiple middleware:

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "middleware": [
    "anthropic-prompt-caching",
    {
      "name": "summarization",
      "maxTokensBeforeSummary": 12000
    }
  ]
}
```

### Custom Middleware (JavaScript Config Only)

Custom middleware objects are only available in JavaScript configurations. Always wrap them with LangChain's `createMiddleware` to include the required `MIDDLEWARE_BRAND` marker—plain objects/functions will be rejected by the registry.

```javascript
// .gsloth.config.mjs
import { createMiddleware } from 'langchain';

const requestLogger = createMiddleware({
  name: 'request-logger',
  beforeModel: (state) => {
    // Custom logic before model execution
    console.log('Processing request...');
    return state;
  },
  afterModel: (state) => {
    // Custom logic after model execution
    console.log('Model completed');
    return state;
  },
});

export async function configure() {
  const anthropic = await import('@langchain/anthropic');

  return {
    llm: new anthropic.ChatAnthropic({
      model: 'claude-sonnet-4-5',
    }),
    middleware: ['summarization', requestLogger],
  };
}
```

## Server tools

Some AI providers provide integrated server tools, such as web search.

**.gsloth.config.json for OpenAI Web Search**

```json
{
  "llm": {
    "type": "openai",
    "model": "gpt-4o"
  },
  "tools": [{ "type": "web_search_preview" }]
}
```

**.gsloth.config.json for Anthropic Web Search**

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "tools": [
    {
      "type": "web_search_20250305",
      "name": "web_search",
      "max_uses": 10
    }
  ]
}
```
