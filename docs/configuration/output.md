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

**The interactive TUI does not follow this ladder.** `gth chat` and `gth code` render through Ink,
whose colour support is decided by chalk, and chalk reads `FORCE_COLOR` but **not** `NO_COLOR`. So
`NO_COLOR=1 gth chat` still shows a coloured TUI. Use `FORCE_COLOR=0`, which both surfaces honour,
or `--no-tui` to get the plain surface.

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

Only the preamble is suppressed — model/tool output, errors, and config-validation warnings always
print. In interactive terminal runs Esc/Q interruption stays armed even though the hint box is
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
`Co-Authored-By` trailer crediting Gaunt Sloth, and never to attribute the co-author to the
underlying model or vendor (`Claude`, `GPT`, `Gemini`, …): the commit is Gaunt Sloth's work, not the
model's.

Set `commit.coAuthor` to use your own identity instead. Each field defaults **independently**, so
you can override just one:

| Field | Default |
|-------|---------|
| `commit.coAuthor.name` | `Gaunt Sloth` |
| `commit.coAuthor.email` | `code@gauntsloth.app` |

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
