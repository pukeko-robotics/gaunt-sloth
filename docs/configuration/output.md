# Output and files

How Gaunt Sloth writes what a run produces: the response report file, binary/image outputs, the
console log level and run header, debug-dump redaction, eval reporters, and the Git commit
co-author trailer. Part of the [configuration reference](./index.md).

## Save a run's output to a file

By default Gaunt Sloth prints to the terminal and writes **nothing** to disk. Say you want a PR
review captured as a file you can attach to a ticket. Two ways to turn that on:

**Just this run** — pass a path with `-w`:

```bash
gth -w reviews/pr-42.md pr 42
```

That path has a separator, so the review lands at `reviews/pr-42.md` relative to the project root.

**Every run** — set `writeOutputToFile` in your config:

```json
{ "writeOutputToFile": true }
```

Now each command writes `gth_<timestamp>_<COMMAND>.md` under `.gsloth/` (or the project root when you
have no `.gsloth` directory). The full rules for both the flag and the config field follow.

`exec` is the exception to the config field: its result streams to stdout so a scripted run stays
pipeable, and only `-w` on the invocation itself makes it write a report file.

## Controlling Output Files

By default, Gaunt Sloth does **not** write responses to disk. Set `writeOutputToFile` in your
config to opt in:

- `false` (default) to skip writing files,
- `true` to write each response to `gth_<timestamp>_<COMMAND>.md` under `.gsloth/` (or the project root),
- a string for a custom path (behavior depends on the format):
  - **Bare filenames** (e.g. `"review.md"`) are placed in `.gsloth/` when it exists, otherwise project root
  - **Paths with separators** (e.g. `"./review.md"` or `"reviews/last.md"`) are always relative to project root

**Examples:**

- `"review.md"` → `.gsloth/review.md` (when `.gsloth` exists) or `review.md` (otherwise)
- `"./review.md"` → `review.md` (always project root)
- `"reviews/last.md"` → `reviews/last.md` (always relative to project root)

Override the setting per run with `-w/--write-output-to-file true|false|<filename>`. Shortcuts `-wn` or `-w0` map to `false`.

## Binary Model Outputs (Image Generation)

Some models (e.g. Gemini with image generation) return inline binary content such as images. By default, Gaunt Sloth saves these as local files instead of printing raw base64 to the terminal.

Output files are named `gth_<timestamp>_<COMMAND>.<ext>` and placed in the same location as text output files. The extension is derived from the MIME type (e.g. `image/png` → `.png`).

Set `writeBinaryOutputsToFile` in your config to control this behavior:

- `true` (default) — binary outputs are saved to files and a confirmation message is displayed
- `false` — binary content is not saved; raw content blocks are printed as JSON

```json
{
  "llm": {"type": "vertexai", "model": "gemini-3.1-flash-image-preview", "location": "global"},
  "writeBinaryOutputsToFile": true
}
```

## Binary Format Configuration

Gaunt Sloth can process binary formats (images, files, audio, video) when your LLM model
supports multimodal inputs.

Important notes:

- Binary formats are disabled by default
- You must explicitly configure which extensions to allow
- Check your LLM provider documentation for supported formats

Enable binary formats by adding the `binaryFormats` array to your config:

```json
{
  "binaryFormats": [
    { "type": "image", "extensions": ["png", "jpg", "jpeg", "webp", "gif"] },
    { "type": "file", "extensions": ["pdf"] }
  ]
}
```

Presence of `binaryFormats` in the config auto-injects `binary-content-injection` middleware.

Format types:

| Type    | Description                           |
| ------- | ------------------------------------- |
| `image` | Image files for vision-capable models |
| `file`  | Other files (e.g., PDFs)              |
| `audio` | Audio files for speech-capable models |
| `video` | Video files for video-capable models  |

Each format type supports:

- `type` (required): The format type category
- `extensions` (required): Array of allowed file extensions (without dots)
- `maxSize` (optional): Maximum file size in bytes (default: 10MB)
- `mimeTypes` (optional): Custom MIME type mappings for unusual extensions

Binary formats can also be configured per command:

```json
{
  "commands": {
    "review": {
      "binaryFormats": [{ "type": "image", "extensions": ["png", "jpg"] }]
    },
    "code": {
      "binaryFormats": false
    }
  }
}
```

## Console Logging Level

Console output can be filtered using `consoleLevel`. The default is `info`, which hides debug-level output.
Lower levels are more verbose. Valid values for JSON configs:
`debug`, `info`, `display`, `success`, `warning`, `error`, `stream`.

**Example config:**

```json
{
  "consoleLevel": "warning"
}
```

## Colour (useColour, NO_COLOR, FORCE_COLOR)

Turn colour off for a single run, without touching your config:

```bash
NO_COLOR=1 gth review > review.txt
```

Gaunt Sloth honours [`NO_COLOR`](https://no-color.org) and `FORCE_COLOR`, the same variables chalk,
ripgrep, fd and delta use, so it behaves like the rest of your toolchain. Four things decide whether
colour is emitted, **highest first** — the first one that applies wins:

| | Condition | Result |
|---|---|---|
| 1 | `FORCE_COLOR` is set to `0` or `false` | off |
| 2 | `FORCE_COLOR` is set to anything else — including empty | on |
| 3 | `NO_COLOR` is set to any non-empty value | off |
| 4 | `useColour` is set in your config | that value |
| 5 | otherwise | on when stdout is a terminal, off when it is piped or redirected |

Rows 1 and 2 are the same rung: `FORCE_COLOR` outranks everything below it, so it re-enables colour
over a `NO_COLOR` inherited from your shell profile or a CI image (`FORCE_COLOR=1 gth review`), and
`FORCE_COLOR=0` disables colour even where `NO_COLOR` is absent. For `NO_COLOR` the *presence* of
the variable is the signal, not its value — `NO_COLOR=0` still turns colour off, and only an empty
`NO_COLOR=` is ignored.

The last row means captured output is clean by default: redirect or pipe a run and you get no escape
sequences without configuring anything. Set `useColour` when you want to override that — `false` to
stay monochrome in a terminal, `true` to keep colour in output you are piping into a pager:

```json
{ "useColour": false }
```

**The interactive TUI follows the same ladder.** `gth chat` and `gth code` render through Ink, whose
colour support is decided by chalk — and chalk reads `FORCE_COLOR` but **not** `NO_COLOR`, so the TUI
used to stay coloured under `NO_COLOR=1`. It no longer does: the TUI now applies the resolved answer
to chalk at startup, so `NO_COLOR=1 gth chat` gives you a monochrome TUI and every row of the table
above means the same thing on both surfaces.

Colour is only ever turned **down**, never up. With colour on, the TUI keeps whatever colour depth
your terminal reports rather than forcing 24-bit escapes into a terminal that cannot show them; the
one exception is `FORCE_COLOR` where no colour support was detected at all, which gets basic
16-colour output.

## Mouse (useMouse, GTH_NO_MOUSE)

Get your terminal's normal click-and-drag text selection back for one run:

```bash
GTH_NO_MOUSE=1 gth chat
```

The TUI enables terminal mouse reporting on launch, which is what makes its clickable parts respond
and lets the wheel scroll the conversation. The trade is that while reporting is on, your terminal
hands the button press to Gaunt Sloth instead of using it to start its own selection — so selecting
text to copy needs a modifier: **hold Shift (Option in some macOS terminals) while dragging**.

Four things decide whether mouse reporting is enabled, **highest first**:

| | Condition | Result |
|---|---|---|
| 1 | `GTH_NO_MOUSE` is set to any non-empty value | off |
| 2 | `useMouse` is set in your config | that value |
| 3 | `TERM` is unset, empty, or `dumb` | off |
| 4 | otherwise | on when both stdin and stdout are terminals |

Row 4 is the default, so a piped or redirected run never emits mouse escape sequences and captured
output stays clean without configuring anything. To turn it off permanently:

```json
{ "useMouse": false }
```

Row 1 exists because row 2 needs a config file: if a terminal mishandles reporting, `GTH_NO_MOUSE=1`
gets you a working session immediately. Within a session, `/mouse off` does the same thing without
restarting — see [interactive sessions](../guides/interactive-sessions.md#mouse-and-text-selection).

## Run Header (output.header)

Non-TUI text runs — `ask`, `exec`, `eval`, `pr`, `review`, and `chat`/`code` with `--no-tui` or
piped output (e.g. in CI) — open with a technical run-header preamble: the
Workdir/Model/Tools/Middleware status lines, plus (in interactive terminal runs only) the
`Press Escape or Q to interrupt Agent` hint box. This is **on by default**. Set
`output.header: false` to suppress the preamble when captured stdout should stay clean — a CI
job or script that diffs, logs, or post-processes the output.

```json
{
  "output": {
    "header": false
  }
}
```

Only the preamble is suppressed — model/tool output, errors, config-validation warnings, and the
[review heading](../guides/review-code-and-prs.md#what-a-review-is-labelled-with) that `review` and
`pr` runs open with always print; that heading belongs to the review document, not to the run
header. In interactive terminal runs Esc/Q interruption stays armed even though the hint box is
hidden; piped/non-TTY runs never arm Esc/Q regardless of this setting. The interactive TUI
ignores the setting and always shows the header.

## Debug Dump Redaction (debugDump.redact)

The [`/debug-dump`](../debug-dump.md) slash command scrubs secrets from its archive before writing it.
This is **on by default**. Set `debugDump.redact: false` to write a raw, unredacted archive instead
(the command then prints a loud "may contain secrets" warning).

```json
{
  "debugDump": {
    "redact": false
  }
}
```

Redaction is a best-effort, pattern-based safety net — review a dump before sharing it regardless of
this setting. See [Debug Dump → Redaction](../debug-dump.md#redaction) for exactly what it does and does
not cover, and the [`/debug-dump`](../debug-dump.md) page for the command itself.

## Custom Eval Reporters (reporters)

`gth eval` renders a run through one or more reporters, selected with `--reporter <names>`. Two are
built in: `text` (the default console summary) and `junit` (which writes a JUnit `results.xml`).
Selecting **replaces** the default set rather than adding to it — pass `--reporter text,junit` if you
want the console summary alongside another reporter. The always-on `results.json` + per-cell JSON are
written regardless of which reporters are selected.

`reporters` registers additional reporters — your own, or ones installed from npm. Each entry maps a
name (the one you then pass to `--reporter`) to either an **installed package** or a **local module
path**, whose **default export** is a reporter factory (`() => EvalReporter`):

```json
{
  "reporters": {
    "teamcity": "@gaunt-sloth/eval-reporter-teamcity",
    "my-report": "./eval/my-report-reporter.mjs"
  }
}
```

```bash
npm i -D @gaunt-sloth/eval-reporter-teamcity
gth eval eval/js-basics.yaml --reporter text,teamcity
```

A **package specifier** (`@scope/name` or `name`) is resolved by Node module resolution against your
**project's** `node_modules`, honoring the package's `exports`; a value starting with `.`, `/`, or
`file:` is a **module path** resolved relative to the project directory. Either way it loads through
the same seam the built-ins use, so a name here can also override a built-in of the same name. An
unresolvable package (not installed), a missing file, a failed import, or a default export that isn't
a function is a harness error (`gth eval` exits 2). It runs as trusted code — it is your own config,
which already executes arbitrary JS.

**Example external reporter — live TeamCity.**
[`@gaunt-sloth/eval-reporter-teamcity`](https://www.npmjs.com/package/@gaunt-sloth/eval-reporter-teamcity)
streams live TeamCity `##teamcity[...]` service messages to stdout (per-case pass/fail live, no
artifact wiring). It is no longer bundled with the CLI — install and register it as shown above.

**Writing a custom reporter.** Implement the `EvalReporter` contract from
[`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) (the optional
`onSuiteStart` / `onCellResult` / `onSuiteEnd` hooks), default-export a factory, and register it
under `reporters`. The teamcity package is the worked example — see its
[README](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/eval-reporter-teamcity#readme)
and small [source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/eval-reporter-teamcity/src).

## Commit Co-Author (commit.coAuthor)

When the agent makes a Git commit in `code` mode — it does this by running `git commit` through
`run_shell_command`, as there is no dedicated commit tool — it is instructed to add exactly one
`Co-Authored-By` trailer crediting Gaunt Sloth. The default name **also carries the model that
served the session**, so your git history records which model wrote the commit while the authorship
and the address stay Gaunt Sloth's:

```
Co-Authored-By: Gaunt Sloth (anthropic:claude-sonnet-5) <code@gauntsloth.app>
```

| Field | Default |
|-------|---------|
| `commit.coAuthor.name` | `Gaunt Sloth (provider:model)`, using the [resolved active model](providers.md#model-identity-in-the-prompt-injectmodelcontext) — or `Gaunt Sloth (model)`, the bare model name, when no provider half resolves |
| `commit.coAuthor.email` | `code@gauntsloth.app` |

The name falls back to a plain `Gaunt Sloth` whenever no model can be resolved. **To keep the model
name out of your git history deliberately,** either set your own `commit.coAuthor.name` — a
configured name is emitted verbatim, with no model spliced into it — or set
`injectModelContext: false`, which removes the model identity from the whole prompt, this trailer
included.

Set `commit.coAuthor` to use your own identity instead. Each field defaults **independently**, so
you can override just one:

```json
{
  "commit": {
    "coAuthor": {
      "name": "Acme Bot",
      "email": "bot@acme.example"
    }
  }
}
```

The agent then emits `Co-Authored-By: Acme Bot <bot@acme.example>`. This is first-party prompt
guidance the model follows when it composes the commit message, not an enforced post-processing step.

### How the message itself is written

The same guidance tells the agent to write the commit message in plain English — what changed and
why, with code, shell commands, backticks and markup kept out — into a file, and to pass that file
to `git commit -F`, never inline with `git commit -m`.

That is a safety rule, not a style preference. Inside double quotes a POSIX shell expands backtick
and `$(…)` constructs **before git ever runs**, so a message that quotes code the way ordinary
technical prose does is executed as a command. A file path carries no shell metacharacters, so the
file form removes the hazard rather than asking the model to avoid it.

Which tool writes that file follows your [`filesystem`](tools.md) setting. Where the setting
registers `write_file`, the guidance names it. Where it does not — `"read"`, `"none"`, or an
allow-list without it — the guidance names no tool and tells the agent that if it cannot write the
message file it must leave the commit to you. Naming a tool the session does not have would corner
the model into the inline form the rule exists to prevent.

The guidance also covers **staging**: the agent stages by naming the paths it changed, rather than
reaching for `git add -A`, `git add .` or `git commit -a`. The message file it has just written is
untracked at that moment, so an unscoped add would sweep it — along with anything else untracked in
your tree — into the commit and on to the pull request. For a change that genuinely touches too many
files to name, the unscoped form is still allowed, but only once the agent has moved that message
file out of the tree or deleted it, and checked what else `git status` reports.
