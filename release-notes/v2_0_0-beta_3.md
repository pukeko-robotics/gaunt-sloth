# v2.0.0-beta.3

- An answered approval collapses to a one-line outcome on the row of the call it concerns, with
  Ctrl+T carrying the detail, instead of a block that painted above the whole turn it interrupted.
- A gated tool call no longer reads as done before it has run, and a call that ends without producing
  a result closes as an error rather than as success.
- Tool output, call summaries, tool names and the pinned checklist are neutralised before they reach
  the terminal, so control characters and ANSI in a file, a tool result or the model's own arguments
  cannot forge framing beside an approval prompt.
- `.aiignore` matches the gitignore rules the documentation promises, and a directly-named ignored
  path is refused at the one gate every filesystem tool passes.
- The Vertex AI authentication hints name the credentials file the environment points at, and the
  variable that leaves an ADC login inert.
