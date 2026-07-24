# Prompt Files (prompts)

Gaunt Sloth composes its system prompt from seven segments, each backed by a prompt file. The
`prompts` config object retargets, disables, or composes any segment — most commonly to feed the
agent your project's coding guidelines.

## Lead use case: give the agent your project guidelines

Goal: your coding rules already live in an `AGENTS.md` at the repo root, and you want every `gth`
run to load them as guidelines instead of maintaining a second copy in `.gsloth.guidelines.md`.

Point the `guidelines` segment at that file in `.gsloth.config.json`:

```json
{
  "prompts": {
    "guidelines": "AGENTS.md"
  }
}
```

The string `"AGENTS.md"` is shorthand for `{ "path": "AGENTS.md" }`: the file **replaces** the
built-in guidelines segment, so `AGENTS.md` is now read into the system prompt on every command.
No flag, no per-run pasting. To keep both your `.gsloth.guidelines.md` and an appended `AGENTS.md`,
use the object form with `"mode": "append"` (below).

For the coding-workflow walkthrough of this — including the default-file path that needs no config
at all — see the [Code with your own project rules](../guides/code-with-your-rules.md) guide. This
page is the full segment reference it points to.

## The seven segments

Each segment is backed by a prompt file with a well-known default name:

| Segment | Default file | Used |
| --- | --- | --- |
| `backstory` | `.gsloth.backstory.md` | every command (identity) |
| `guidelines` | `.gsloth.guidelines.md` | every command (project guidelines) |
| `system` | `.gsloth.system.md` | every command (appended last) |
| `chat` | `.gsloth.chat.md` | `chat` mode prompt |
| `code` | `.gsloth.code.md` | `code` mode prompt |
| `exec` | `.gsloth.exec.md` | `exec` mode prompt |
| `review` | `.gsloth.review.md` | `review` / `pr` instructions |

With no config, each segment reads its default-named file from the config dir
(`.gsloth/.gsloth-settings/`, honouring [identity profiles](./profiles.md)) or the project root,
falling back to the bundled default shipped with the installation.

`gth init` scaffolds only `.gsloth.config.json` — no template prompt files are planted; the bundled
defaults apply until you add your own files or `prompts` config.

## The `prompts` object

The `prompts` config object retargets, disables, or extends any segment. Each segment accepts a
string (a file path — the common case) or an object `{ path?, enabled?, mode? }`:

```json
{
  "prompts": {
    "guidelines": "AGENTS.md",
    "review": { "path": "docs/review-checklist.md", "mode": "append" },
    "backstory": { "enabled": false }
  }
}
```

- A **string** is shorthand for `{ "path": … }`: the file replaces the segment's built-in content.
  Pointing `guidelines` at an existing `AGENTS.md` is the typical use.
- **`path`** resolves like every prompt file: the config dir (and identity profile) first, then
  relative to the project root.
- **`enabled: false`** drops the segment entirely — even its bundled default. Use it to run without
  a segment rather than shadowing it with an empty file.
- **`mode`** controls composition when `path` is set: `"replace"` (default) substitutes the
  built-in segment content; `"append"` keeps the built-in content (your default-named file, or the
  bundled default) and appends the file after it — use it to add project rules on top of the stock
  review prompt instead of rewriting it.

## Turning off the bundled defaults (noDefaultPrompts)

By default, Gaunt Sloth falls back to its bundled `.gsloth.*.md` prompt files when no user-provided
files are found. Setting `noDefaultPrompts` to `true` disables this fallback, so only user-provided
prompt files are used. This applies to all `.gsloth.*.md` files including backstory, system, chat,
code, guidelines, and review instructions.

```json
{
  "noDefaultPrompts": true
}
```

To drop a **single** segment (including its bundled default), use `prompts.<segment>.enabled: false`
instead — `noDefaultPrompts` is the all-segments switch.
