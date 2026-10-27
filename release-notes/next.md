# v2.3.2

- Long file paths in tool-call summaries (the tool row and the `Requested tools:` line) are now shortened from the start, so the file name stays visible: `…/providers/geminiSchemaSanitizer.ts` instead of `packages/core/src/providers/geminiSchemaSanitiz...`.
- Security: the bundled `undici` HTTP client moves to 8.12.3, which fixes two denial-of-service advisories and a Subresource Integrity bypass. LangChain, the LLM providers and the MCP SDK also take their latest patch and minor releases.
