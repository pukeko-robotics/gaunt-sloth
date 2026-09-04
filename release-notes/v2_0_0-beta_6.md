# v2.0.0-beta.6

- Session history now records by default. Every run writes a row to `~/.gsloth/history.db` on your
  own machine — the store `gth history list` / `search` / `show` and `gth insights` read — and
  interactive `chat` / `code` sessions additionally keep their conversation state there, so a
  session can later be picked up where it left off. Nothing leaves the machine and there is no
  telemetry; the file is a plain SQLite database you can inspect or delete. Set
  `history.enabled: false` in your config to turn it all off, or `history.dbPath` to move the file.
  See [Migrating to 2.0 → section L](../docs/MIGRATION.md).
- `/compact [focus]` in interactive `chat` / `code` sessions folds the older conversation into a
  summary and keeps the last few messages word for word, so a session that has grown too long can
  keep going without starting over. The summary is written into the conversation's saved state, so
  a resumed session stays compacted; the transcript on screen is left as it is. Free text after the
  command says what the summary should concentrate on. See
  [Interactive sessions → Slash commands](../docs/guides/interactive-sessions.md#slash-commands).
- A conversation that outgrows the model's context window no longer ends the turn. When a provider
  rejects a turn for size, the session compacts and sends it again, once; a second overflow ends the
  turn and says why. On Ollama the check runs *before* the request, because Ollama does not reject
  an oversized conversation — it silently drops the oldest messages and answers from the rest. See
  [Interactive sessions → When the session compacts without being asked](../docs/guides/interactive-sessions.md#when-the-session-compacts-without-being-asked).
