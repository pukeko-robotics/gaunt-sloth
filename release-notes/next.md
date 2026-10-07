# v2.2.2

- `tls.extraCaCerts` is now in place before any MCP server connects when several agents run in one process, as in `gth eval -j`. Before, all but the first agent could connect without the custom CA and lose their MCP tools with `fetch failed`.
- A failed MCP connection now names the network error behind it, such as `SELF_SIGNED_CERT_IN_CHAIN` or `ECONNREFUSED`, instead of only `fetch failed`.
