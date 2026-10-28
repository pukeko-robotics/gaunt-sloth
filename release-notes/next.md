# v2.3.2

## Potentially Breaking Changes

- **MCP tool names change from `mcp__<server>__<tool>` to `mcp__<server>_<tool>`**, with a single underscore after the server key: `mcp__jira__getJiraIssue` is now `mcp__jira_getJiraIssue`. Update every `allowedTools` entry and every `gth eval` suite pattern (`must_call`, `must_error`, `tool_result_json_path`, `tool_trajectory` and the rest) that names an MCP tool. A glob such as `mcp__github_*` now also matches the tools of a server keyed `github_enterprise`, so list exact names where one server key extends another. Approval rules and remembered approvals are unaffected: they name the server key and the tool separately. Two servers whose tools would end up with the same name can no longer be loaded together; the session then offers no MCP tools until one key is renamed.
- **One unknown key in any `mcpServers` entry now drops every MCP tool.** Server entries are checked strictly when the session starts, so a misspelt key, or an option the MCP client no longer supports such as `automaticSSEFallback` or `reconnect`, leaves the session with no MCP tools and a warning naming the key. See [MCP](https://github.com/pukeko-robotics/gaunt-sloth/blob/v2.3.2/docs/configuration/mcp.md).
- **Library: `@gaunt-sloth/agent` now uses `@agentclientprotocol/sdk` 2.0.2.** `createAcpAgentApp`, `createAcpV1AgentApp` and `createAcpAgentRouter` return that SDK's app types. If you connect them in-process to your own ACP client, move that client to `@agentclientprotocol/sdk` 2.0 as well. Using the agent over stdio (`gaunt-sloth-acp`, `gth --acp-agent`) needs nothing.

## Improvements

- A failed MCP tool call now reaches the model as the server's own error text, without the `MCP tool '…' on server '…' returned an error:` prefix, and the trace records it the same way.
- `gth eval` can grade an MCP error the server sent as `structuredContent`, including one with no text at all: `tool_result_json_path` reads the structured body when there is one. A successful result with `structuredContent` and no text is now gradable too, at `structuredContent.…` paths like any other.
- Long file paths in tool-call summaries (the tool row and the `Requested tools:` line) are now shortened from the start, so the file name stays visible: `…/providers/geminiSchemaSanitizer.ts` instead of `packages/core/src/providers/geminiSchemaSanitiz...`.
- ACP: the `session/prompt` response to a v2 client now carries the `messageId` of the user message it inserted, matching the `user_message` update, as the current v2 draft requires. v1 clients such as Zed see no change.
- ACP v2: a prompt closed or cancelled before its turn starts now still echoes its user message and ends with an idle `cancelled` update, sent before the `session/close` response; a prompt that arrives while its session is closing gets `-32800` (Request Cancelled); and a second prompt sent before the first one's turn starts is refused instead of running alongside it.

## Maintenance

- Security: the `undici` HTTP client dependency moves to 8.12.3, which fixes two denial-of-service advisories and a Subresource Integrity bypass.
- `@langchain/mcp-adapters` moves to 2.0.1, on the new MCP client packages.
