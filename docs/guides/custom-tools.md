# Add a custom tool

The agent can call tools you define. A custom tool is a plain LangChain tool you build in a
JavaScript config and hand to the agent through the top-level `tools` array — your own schema, your
own code, whatever API you want behind it.

## The main use case: let the agent log work to Jira

Goal: give the agent a `jira_log_work` tool so a coding session can log time against a Jira issue
for you.

A tool that runs your own code lives in a JavaScript config (`.gsloth.config.mjs`) — the `tools`
array carries live tool instances, which a JSON config can't express. Build the tool with
LangChain's `tool()` and a zod schema, then return it from `configure()`:

```javascript
// .gsloth.config.mjs
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const jiraLogWork = tool(
  async ({ jiraId, timeInSeconds, comment }) => {
    const auth = Buffer.from(
      `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
    ).toString('base64');
    const res = await fetch(
      `${process.env.JIRA_BASE_URL}/rest/api/2/issue/${jiraId}/worklog`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeSpentSeconds: timeInSeconds, comment }),
      }
    );
    if (!res.ok) {
      return `Failed to log work to ${jiraId}: ${res.status} ${await res.text()}`;
    }
    return `Logged ${timeInSeconds}s against ${jiraId}`;
  },
  {
    name: 'jira_log_work',
    description:
      'Log work time to a Jira issue. Example: jira_log_work({ jiraId: "PROJ-42", timeInSeconds: 3600, comment: "Implemented feature X" })',
    schema: z.object({
      jiraId: z.string().describe('The Jira issue ID (e.g. "PROJ-42")'),
      timeInSeconds: z.number().describe('Time spent in seconds'),
      comment: z.string().optional().describe('Work log comment'),
    }),
  }
);

export async function configure() {
  const anthropic = await import('@langchain/anthropic');
  return {
    llm: new anthropic.ChatAnthropic({ model: 'claude-sonnet-4-5' }),
    tools: [jiraLogWork],
  };
}
```

Three parts make this a tool the agent can actually call:

- **`name`** — how the model refers to the tool, and what shows up in the run's tool list. Keep it
  stable.
- **`schema`** — a zod object; each `.describe()` tells the model what to pass. The agent fills
  these arguments from the conversation.
- the **function body** — arbitrary JS. Return a string, and that string goes back to the model as
  the tool result. Read secrets from the environment as above — don't hardcode them in a config file
  the agent can read.

Then point the agent at it:

```bash
export JIRA_BASE_URL="https://your-org.atlassian.net"
export JIRA_EMAIL="you@your-org.com"
export JIRA_API_TOKEN="…"
gth code "Log 1 hour against PROJ-42 with the comment 'pairing on the auth bug'"
```

The agent sees `jira_log_work` in its toolset, calls it with
`{ jiraId: "PROJ-42", timeInSeconds: 3600, comment: "pairing on the auth bug" }`, and reports the
result string back to you.

A tool in the top-level `tools` array is available to every command that runs the agent (`ask`,
`chat`, `code`, `exec`, `pr`, `review`). To restrict a run to specific tools by name, list them in
`allowedTools`.

## Wrap a shell command instead — no code

If your "tool" is really just a command line, you don't need JavaScript. The `customTools` config
key wraps a shell command as a tool and works in a plain JSON config. Each entry is a name →
`{ command, description }`, with optional `${...}` parameters:

```json
{
  "llm": { "type": "anthropic", "model": "claude-sonnet-4-5" },
  "customTools": {
    "run_migration": {
      "command": "npm run migrate -- ${migrationName}",
      "description": "Run a specific database migration",
      "parameters": {
        "migrationName": { "description": "Name of the migration to run" }
      }
    }
  }
}
```

Parameter values are validated before the command runs: absolute paths, `..`, and shell
metacharacters (`|`, `&`, `;`, backticks, `$`, …) are rejected unless you opt out per parameter with
`"allow": ["shell-injection"]` (also `"absolute-paths"`, `"directory-traversal"`, `"null-bytes"`).
Add `"timeout": <seconds>` to kill a command that runs too long. `customTools` works across commands
by default; set `commands.<cmd>.customTools` to override it for one command, or `false` to disable it
there.

## Examples

```bash
# Log work through the agent during a coding session
gth code "Log 1 hour against PROJ-42, comment 'pairing on the auth bug'"

# Reach the same jira_log_work tool from a one-shot question
gth ask "Log 15 minutes against PROJ-42 for the standup"

# Drive a wrapped shell-command tool (customTools)
gth code "run the add_users_table migration"
```

## Related

- Every tool knob — built-in tools, `customTools`, `allowedTools`, filesystem access:
  [Tools configuration](../configuration/tools.md).
- Connecting an external service that already speaks the Model Context Protocol, instead of writing
  a tool yourself: [MCP servers](../configuration/mcp.md).
- The JavaScript config format (`configure()`, providers, middleware):
  [Configuration](../configuration/index.md).
