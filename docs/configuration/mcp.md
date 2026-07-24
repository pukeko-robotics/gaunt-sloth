# Model Context Protocol (MCP)

Gaunt Sloth connects to [MCP](https://modelcontextprotocol.io/) servers and exposes their tools to
the agent in `chat` and `code`. It speaks OAuth (for hosted servers like Atlassian's), plain
`http`/`sse`, and local `stdio` servers. This page is part of the
[configuration guide](./index.md); MCP servers are declared under the top-level `mcpServers` key.

## Connect the Atlassian Jira MCP server

Goal: let `gth chat` and `gth code` read and update Jira issues by connecting Atlassian's hosted
Jira MCP server over OAuth — the tested, confirmed-working setup.

Add the server under `mcpServers` in your `.gsloth.config.json`:

```json
{
  "llm": {
    "type": "vertexai",
    "model": "gemini-2.5-pro",
    "temperature": 0
  },
  "mcpServers": {
    "jira": {
      "url": "https://mcp.atlassian.com/v1/sse",
      "authProvider": "OAuth",
      "transport": "sse"
    }
  }
}
```

Then start a session — `gth chat` — and ask it to do something in Jira. On the first run that needs
the server, your browser opens automatically; complete the Atlassian OAuth login and the tools
become available. Tokens are cached (see [Token storage](#token-storage) below), so later sessions
skip the browser step.

For a complete working example, see [examples/jira-mcp](../../examples/jira-mcp).

## OAuth-enabled MCP Servers

Gaunt Sloth has an OAuth client for MCP, confirmed to work with the public Atlassian Jira MCP
server (the [example above](#connect-the-atlassian-jira-mcp-server)). Set `authProvider: "OAuth"` on
the server entry.

**OAuth Authentication Flow:**

1. When you first use a command that requires the MCP server, your browser will open automatically
2. Complete the OAuth authentication in your browser
3. The authentication tokens are stored securely in `~/.gsloth/.gsloth-auth/`
4. Future sessions will use the stored tokens automatically

### Token storage

- OAuth tokens are stored in JSON files under `~/.gsloth/.gsloth-auth/`
- Each server's tokens are stored in a separate file named after the server URL
- The storage location is cross-platform (Windows, macOS, Linux)

**If authentication gets stuck or a token goes stale**, delete that server's token file under
`~/.gsloth/.gsloth-auth/` and run the command again — with no cached token, Gaunt Sloth reopens the
browser and runs the OAuth login from scratch.

## MCP stdio Server Configuration

To configure a local MCP server, add it to `mcpServers` with `transport: "stdio"` and the command to
launch it. For example, the reference sequential-thinking MCP:

```json
{
  "llm": {
    "type": "vertexai",
    "model": "gemini-2.5-pro"
  },
  "mcpServers": {
    "sequential-thinking": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

This launches the MCP server with `npx` and communicates with it over stdio.

## TLS trust for HTTPS MCP servers (custom CA / self-signed certs)

An `http`/`sse` MCP server behind a **private or corporate CA** (for example a dev backend with a
self-signed certificate) makes Node's `fetch` reject the connection — you'll see the server "detected"
but with **no tools**, and `gth <cmd> ask` prints `TypeError: fetch failed`
(`SELF_SIGNED_CERT_IN_CHAIN`). This is common when a team is developing a new MCP server.

Add a top-level `tls` block to trust the extra CA — no need to prepend `NODE_EXTRA_CA_CERTS` on
every invocation:

```jsonc
{
  "llm": { "type": "vertexai", "model": "gemini-3.5-flash" },
  "tls": {
    // CA cert file(s) to trust IN ADDITION to Node's built-in roots.
    // Paths resolve relative to the project dir, or use ~ / an absolute path.
    "extraCaCerts": ["support/security-material/my-dev-ca.crt"]
  },
  "mcpServers": {
    "my-server": {
      "transport": "http",
      "url": "https://my-dev-host:8443/mcp"
    }
  }
}
```

A cert path that can't be read is warned about and skipped (fail-soft), never fatal.

**Escape hatch — disabling verification (insecure):**

```jsonc
{
  "tls": {
    "rejectUnauthorized": false // DANGER — see below
  }
}
```

> ⚠️ **Security:** `rejectUnauthorized: false` disables TLS certificate verification for **all**
> outbound HTTPS this process makes — **not just MCP, but LLM provider calls too** — which exposes
> them to man-in-the-middle attacks. Gaunt Sloth prints a loud warning every session while it is
> active. Use it only against trusted dev endpoints; prefer `tls.extraCaCerts` to trust a specific
> CA. Both settings are **process-global** (the underlying trust store applies to the whole process),
> so they apply to every server and every LLM call, not one MCP entry.

## A2A (Agent-to-Agent) Protocol Support (Experimental)

> **Note:** A2A support is an experimental feature and may change in future releases.

Gaunt Sloth supports the [A2A protocol](https://google.github.io/A2A/) for connecting to external AI
agents. This allows delegating tasks to specialized agents. Add `a2aAgents` to your configuration
file:

```json
{
  "llm": {
    "type": "YOUR_PROVIDER",
    "model": "MODEL_OF_YOUR_CHOICE"
  },
  "a2aAgents": {
    "myAgent": {
      "agentId": "my-agent-id",
      "agentUrl": "http://localhost:8080/a2a"
    }
  }
}
```

Each agent becomes available as a tool named `a2a_agent_<agentId>` in `chat` and `code` commands.

See [examples/a2a](../../examples/a2a) for a working example.

---

Looking to pull Jira issues in as review requirements for `pr` / `review` instead? That is the Jira
REST API integration, documented under [content sources → JIRA](./content-sources.md#jira). To gate
which MCP tools the agent may call, see [allowed tools](./tools.md#allowed-tools).
