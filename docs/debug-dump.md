# Debug Dump (`/debug-dump`)

`/debug-dump` is a slash command available inside interactive [`chat` and `code`](COMMANDS.md)
sessions. I hit a bug in a `gth chat` or `gth code` session and want to attach a debug dump to the
issue I'm about to file. Here's how:

1. Reproduce the bug in the session (or get as close to it as you can — the dump captures
   everything *so far*, not what happens after).
2. Type `/debug-dump` and press enter:

   ```
   /debug-dump
   ```

3. Gaunt Sloth writes the archive and prints its path:

   ```
   ⚠️  Debug dump written — UNSANITIZED, review before sharing

   Archive: /Users/you/.gsloth/debug-dumps/2026-07-18T22-24-37-118Z

   This archive contains the full transcript, resolved config, env info, debug log and git
   state AS-IS — it may include secrets: API keys, tokens, file contents, env vars.
   Review it carefully before sending it anywhere.
   ```

   That warning is not boilerplate: the archive is written **as-is**, with no redaction of API
   keys, tokens, file contents, or environment variables. Open the files and strip anything
   sensitive **before** you attach them to a public issue.
4. Attach the reviewed file(s) — or the whole reviewed directory — to your [GitHub
   issue](https://github.com/pukeko-robotics/gaunt-sloth/issues) (see
   [CONTRIBUTING.md](../CONTRIBUTING.md) for the issue/PR process).

## What's in the archive

Each run creates one new, timestamped directory under the **global** `~/.gsloth/debug-dumps/`
(not the project's `.gsloth/`), so successive dumps never collide or overwrite each other:

```
~/.gsloth/debug-dumps/<timestamp>/
```

| File | Contents |
|------|----------|
| `transcript.json` | The full session transcript so far — every turn, tool call, and tool result. |
| `config.json` | The resolved effective configuration (the live `GthConfig`) for the session. |
| `env.json` | `gthVersion`, `nodeVersion`, `platform`, and the model display name. |
| `debug-log.txt` | The in-memory debug-log ring buffer for this session. |
| `git-state.json` | `branch`, `remote`, and `dirty` — only written when the session's working directory is inside a git repository; omitted entirely otherwise. |

Values that aren't directly JSON-safe (functions, `bigint`s, circular references — e.g. the live
LLM client object embedded in the resolved config) are stringified or broken rather than causing
the dump to fail partway through; source: `packages/core/src/utils/debugDump.ts`, verified by
`packages/core/spec/debugDump.spec.ts`.

## Where it works

`/debug-dump` is one entry in the Ink TUI's slash-command registry
(`packages/app/src/tui/slashCommands.ts`), dispatched only inside the `<App>` component that the
Ink TUI renders. Tracing where that renders:

- `gth chat` and `gth code` (`packages/app/src/commands/chatCommand.ts` /
  `codeCommand.ts`) both call `startSession()`
  (`packages/app/src/modules/startSession.ts`), which mounts the Ink TUI when the environment
  favors it (`shouldUseTui()`, `packages/app/src/tui/shouldUseTui.ts`): both stdin and stdout must
  be a real TTY, `TERM` must not be `dumb`, `--no-tui`/`GTH_NO_TUI` must not be set, and — unless
  `--tui` is passed explicitly — `CI` must not be set.
- Outside those conditions, `chat`/`code` fall back to the plain readline session
  (`packages/agent/src/modules/interactiveSessionModule.ts`), which only recognizes `exit`/`/exit`
  and `/auto-approve` — not the full slash-command registry. `/debug-dump` is not reachable there.
- `ask`, `exec`, `review`, and `pr` run one-shot through `runSingleShot()` / `review()`
  (`packages/app/src/commands/askCommand.ts`, `execCommand.ts`, `reviewCommand.ts`,
  `prCommand.ts`) — there is no rendered session and no slash-command dispatch at all, so there is
  nowhere to type `/debug-dump` into.

So: **`/debug-dump` is available in interactive `gth chat` / `gth code` sessions running the Ink
TUI on a real terminal, and only there.** It is not available in `ask`, `exec`, `review`, `pr`, or
in a `chat`/`code` run that has fallen back to the readline session.

If a `dumpDebugSession` writer isn't wired into the session at all (only happens in the
fixture/demo agent used for internal testing, never a real `chat`/`code` run), the command reports
itself unavailable instead of writing anything:

```
Debug dump unavailable

No debug-dump writer is available in this session.
This is only available in a real session (not the fixture/demo agent).
```

## Failure behavior

Writing the archive never aborts your session:

- Not inside a git repository (or `git` isn't installed) → `git-state.json` is simply omitted.
- Installed version can't be determined → `env.json` reports `"unknown"` for `gthVersion`.
- Non-JSON-safe or circular data in the transcript/config → handled per "What's in the archive"
  above, rather than throwing.

## Notes

- There is no option to change the output location or to sanitize the archive before it's
  written — the command always writes the full, raw session state. Because the archive lives
  under your home directory, it is never covered by a project's `.gitignore`.
- Old archives are not cleaned up automatically; clear out `~/.gsloth/debug-dumps/` yourself once
  you no longer need old dumps.
