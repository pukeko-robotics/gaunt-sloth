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

3. Gaunt Sloth redacts secrets, writes the archive, and prints its path:

   ```
   Debug dump written — secrets redacted

   Archive: /Users/you/.gsloth/debug-dumps/2026-07-18T22-24-37-118Z

   Secrets were redacted (API keys, tokens and auth headers replaced with <redacted>).
   Redaction is best-effort and pattern-based — review before sharing.

   To write a raw, unredacted archive: set `debugDump.redact: false` in your gsloth config,
   or run `/debug-dump --unsafe-no-redact`.
   ```

   Redaction is **on by default** (see [Redaction](#redaction)). It masks known secret shapes and
   values — it does **not** sanitize general file contents or transcript text the session captured —
   so still review the archive before you attach it to a public issue.
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

## Redaction

`/debug-dump` runs a secret-redaction pass over every file above before it is written. It is **on by
default** — the config toggle is `debugDump.redact` (see
[Configuration → Debug Dump Redaction](CONFIGURATION.md#debug-dump-redaction-debugdumpredact)).

**What it removes.** Each match is replaced with the literal marker `<redacted>`:

- The values of secret-named environment variables (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_KEY`,
  anything containing `PASSWORD`) and inline config secrets — substituted wherever they appear,
  across every file in the archive.
- Well-known provider key shapes: OpenAI / Anthropic (`sk-…`, `sk-ant-…`), Google (`AIza…`), xAI
  (`xai-…`), Groq (`gsk_…`), and GitHub tokens (classic `ghp_`/`gho_`/… and fine-grained
  `github_pat_…`).
- `Authorization` and `Bearer` header values (any scheme, including non-standard ones and AWS SigV4
  `Credential=` / `Signature=`), and credentials embedded in a URL (`scheme://user:pass@host` — the
  `user:pass` is masked, the host kept).
- In `config.json`: the value of any secret-named field (`apiKey`, `token`, `secret`, …) is masked
  while the key is kept, and the live model object is reduced to a `{ type, model }` descriptor so
  its internals never reach disk.

**What it does not do.** Redaction is **best-effort and pattern-based** — it targets known secret
shapes and values, not arbitrary sensitive data. It does **not** scrub general file contents, source
code, or prose the transcript captured, and it deliberately does not redact high-entropy strings (to
avoid gutting the dump with false positives). It is a safety net, not a guarantee: **review a dump
before you share it.**

**Opting out.** To write a raw, unredacted archive, either set it persistently in config:

```json
{
  "debugDump": {
    "redact": false
  }
}
```

or opt out for a single dump by passing the flag when you type the command in a session:

```
/debug-dump --unsafe-no-redact
```

With redaction off, the archive is written as-is and the command prints a loud "UNSANITIZED — may
contain secrets" warning in place of the redacted-by-default notice.

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

- Secrets are redacted by default; opt out per [Redaction](#redaction) above. There is no option to
  change the output location. Because the archive lives under your home directory, it is never
  covered by a project's `.gitignore`.
- Old archives are not cleaned up automatically; clear out `~/.gsloth/debug-dumps/` yourself once
  you no longer need old dumps.
