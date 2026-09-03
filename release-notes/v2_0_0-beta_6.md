# v2.0.0-beta.6

- Session history now records by default. Every run writes a row to `~/.gsloth/history.db` on your
  own machine — the store `gth history list` / `search` / `show` and `gth insights` read — and
  interactive `chat` / `code` sessions additionally keep their conversation state there, so a
  session can later be picked up where it left off. Nothing leaves the machine and there is no
  telemetry; the file is a plain SQLite database you can inspect or delete. Set
  `history.enabled: false` in your config to turn it all off, or `history.dbPath` to move the file.
  See [Migrating to 2.0 → section L](../docs/MIGRATION.md).
- A recorded `chat` / `code` conversation can be picked up where it left off: `gth chat --resume
  <id>`, `gth code --resume <id>` (or bare `gth --resume <id>`), `gth history resume <id>` — which
  chooses the mode the conversation was recorded under — and `/resume <id>` inside a running
  session, with `/resume` alone listing what can be resumed. A resumed session shows the
  conversation's banner and recorded turns and the model continues with the state it had. The
  approvals granted in that conversation from the escalation menu are kept with it and are in
  force again, so a grant's lifetime is now the conversation rather than the process that made it
  (nothing in the project allow-list or deny-list is affected). A resume is refused with a reason
  when history is off, the conversation is unknown, it has no state to re-enter, or it was recorded
  in a different directory. `/status` now names the conversation id. See
  [Resuming a conversation](../docs/COMMANDS.md#resuming-a-conversation).
- `/compact [focus]` in interactive `chat` / `code` sessions folds the older conversation into a
  summary and keeps the last few messages word for word, so a session that has grown too long can
  keep going without starting over. The summary is written into the conversation's saved state, so
  a resumed session stays compacted; the transcript on screen is left as it is. Free text after the
  command says what the summary should concentrate on. See
  [Interactive sessions → Slash commands](../docs/guides/interactive-sessions.md#slash-commands).
