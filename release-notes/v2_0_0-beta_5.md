# v2.0.0-beta.5

- Session history now records by default. Every run writes a row to `~/.gsloth/history.db` on your
  own machine — the store `gth history list` / `search` / `show` and `gth insights` read — and
  interactive `chat` / `code` sessions additionally keep their conversation state there, so a
  session can later be picked up where it left off. Nothing leaves the machine and there is no
  telemetry; the file is a plain SQLite database you can inspect or delete. Set
  `history.enabled: false` in your config to turn it all off, or `history.dbPath` to move the file.
  See [Migrating to 2.0 → section L](../docs/MIGRATION.md).
