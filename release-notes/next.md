# v2.3.2

- Long file paths in tool-call summaries (the tool row and the `Requested tools:` line) are now shortened from the start, so the file name stays visible: `…/providers/geminiSchemaSanitizer.ts` instead of `packages/core/src/providers/geminiSchemaSanitiz...`.
- Security: the `undici` HTTP client dependency moves to 8.12.3, which fixes two denial-of-service advisories and a Subresource Integrity bypass.
- ACP: the `session/prompt` response to a v2 client now carries the `messageId` of the user message it inserted, matching the `user_message` update, as the current v2 draft requires. v1 clients such as Zed see no change.
- ACP v2: a prompt closed or cancelled before its turn starts now still echoes its user message and ends with an idle `cancelled` update, sent before the `session/close` response; a prompt that arrives while its session is closing gets `-32800` (Request Cancelled); and a second prompt sent before the first one's turn starts is refused instead of running alongside it.
- Library: `@gaunt-sloth/agent` now uses `@agentclientprotocol/sdk` 2.0.2, so `createAcpAgentApp`, `createAcpV1AgentApp` and `createAcpAgentRouter` return that SDK's app types. If you connect them in-process to your own ACP client, build that client on SDK 2.0 as well.
