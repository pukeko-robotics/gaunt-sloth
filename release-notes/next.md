# v2.2.5

- In the full-screen chat, a line containing tabs now wraps inside its box instead of running past it.
- In the full-screen chat, Ctrl+C is no longer missed when pressed right after fast typing.
- `gth eval` can check the order tools were called in with `tool_trajectory`. By default the listed calls must happen in that order, with other calls allowed around them; `strict: true` requires exactly the listed calls. See [Tool-call order assertions](https://github.com/pukeko-robotics/gaunt-sloth/blob/v2.2.5/docs/COMMANDS.md#tool-call-order-assertions).
- **Changed output:** `gth eval` result files now always carry `toolCalls`, one entry per tool call in call order. Without `evalToolCallArgs` the entries have only `name` and `id`, with no `args`. A script that read the presence of `toolCalls` as "arguments were recorded" should check for `args` instead.
