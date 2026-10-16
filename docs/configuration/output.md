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

`review` and `pr` keep the promise even when the run fails: if the content cannot be fetched — a
pull request over GitHub's 300-file diff limit, no `gh` on the path, an unreadable file — the report
is still written at that path with the error in place of a verdict, so a script that reads it back
finds an explanation rather than nothing. The run still exits `1`.

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

Gaunt Sloth can process binary formats (images, files, audio) when your LLM model
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

These three are the whole vocabulary, and any other value is a config error naming the entry that
carries it. An attachment reaches a model as an image, an audio or a file block; there is no
provider that accepts anything else, so a format type outside this set could only fail once the
file had been read and the request built. Whether a given model then *understands* the attachment
is a separate question — check your provider's documentation for the formats it supports.

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

The approval prompt is not filtered by this. It is a question rather than a status message, and a
filter that applied to it line by line would leave you a severity heading with no command under it.
See [the shell tool and approvals](../guides/shell-tool-and-approvals.md#where-the-prompt-is-written).

The notice that says why a run ended is not filtered either. It carries the
reason code you would quote in a bug report, and the session log that would otherwise hold it is off
by default.

Every other notice — the short block a slash command prints as its feedback — is filtered as a
whole, never line by line, so quieting the console drops a notice's title and its body together
rather than leaving you a heading with nothing under it. An informational notice is shown at `debug`
and `info`; a warning notice from `debug` through `warning`. From `display` onwards, then, a slash
command whose feedback is informational prints nothing at all. An enabled session log records every
notice in full either way, whatever the level.

A tool call quietens in two steps rather than one. At `info` you get all three of its lines: the
`Requested tools:` announcement, the `Thinking...` line while the model works, and the status row
the call finishes with — `✓ 📁 read_file(path=README.md)`, carrying the arguments it was called
with. At `display` the two announcements go and the row stays, along with as much of the tool's
output as the preview depth allows; pairing it with
[`toolOutputPreviewLines: 0`](#tool-output-preview-depth-tooloutputpreviewlines) is what leaves
exactly one line per tool call. From `warning` onwards the successful row goes too, and a tool call
shows up only when something was wrong with it — a failure keeps its row and enough of the error to
explain itself, and an auto-rater clarification keeps its own.

The progress line quietens at the same step. While a command waits — on the model, on `gh`, on
`git` — it prints a label and then a dot per second: `Thinking.`, `Reviewing.`,
`Fetching GitHub PR #445 diff`. That whole line belongs to `info`, so you see it at `debug` and
`info` and it is gone from `display` onwards — label, dots, and the line break that closes them, so
a quieted run has no blank line left where the dots used to be. That includes the `reading STDIN`
notice a piped run prints while it waits for the pipe to close: it is written before the command
line is parsed, so Gaunt Sloth reads `consoleLevel` out of your config first, before it starts
waiting.

## Tool output preview depth (toolOutputPreviewLines)

Reviewing a large pull request, the agent reads a dozen files, and each read prints ten greyed lines
of that file before the review text you actually came for. To leave every tool call as a single
summary line instead:

```json
{ "toolOutputPreviewLines": 0 }
```

A finished tool call is drawn as one summary row — `✓ 📁 read_file(path=README.md)` — followed by a
preview of what the tool returned. `toolOutputPreviewLines` sets how many lines of that preview you
get, on both the TUI and the plain `--no-tui` surface. The default is `10`, and anything cut is
accounted for by a `… (+N more lines)` marker. `0` drops the preview entirely, marker included:
you asked for one line, so a second line reporting how much was hidden would defeat the setting.

To quieten the noisiest tool while leaving the rest alone, set `previewLines` on that tool's entry in
[`builtInTools`](tools.md#built-in-tools-builtintools) instead. It outranks the root key, so the two
combine — a shallow default with one tool collapsed completely:

```json
{
  "toolOutputPreviewLines": 3,
  "builtInTools": {
    "gth_gh_read_file": { "previewLines": 0 },
    "gth_checklist": true,
    "gth_grep": true
  }
}
```

Highest first, the depth for a given tool is: that tool's `previewLines`, then
`toolOutputPreviewLines`, then the built-in `10`. A per-tool entry can be set per command as well,
under `commands.<command>.builtInTools` — and there, as everywhere, a per-command `builtInTools`
object replaces the inherited set rather than extending it.

**This is a display setting, and it changes nothing the model sees.** The tool's full result goes to
the model whatever depth you choose, so turning the preview down saves you screen space, never
tokens. The settings that cap what a tool actually returns are separate and per-tool —
[`gth_gh_read_file`'s `maxBytes`](tools.md#github-file-reads-during-a-pr-review-gth_gh_read_file)
and [`run_shell_command`'s `maxOutputBytes`](tools.md#general-purpose-shell-tool-run_shell_command).
Reaching for one expecting the other is the mistake to avoid: `maxBytes` set to quieten the terminal
truncates the file the model is reasoning about, and `previewLines` set to save tokens saves none.

A fractional depth is rounded down. A negative or non-numeric one falls back to the next level.

## Recorded tool-result size (toolResultCaptureMaxBytes)

A search tool returns a payload several times larger than you expected, and a `tool_result_json_path`
assertion on it fails — not because the server answered in prose, but because the recorded copy was
cut off. The reason names `toolResultCaptureMaxBytes` and the number of bytes the tool returned.
Raise the cap to that, or past it:

```json
{ "toolResultCaptureMaxBytes": 65536 }
```

This is the third of three stages, and it caps a different thing from the other two. What the model
receives is capped per tool, by
[`maxOutputBytes`](tools.md#general-purpose-shell-tool-run_shell_command) and
[`maxBytes`](tools.md#github-file-reads-during-a-pr-review-gth_gh_read_file). What you see drawn
under a tool's summary is capped by
[`toolOutputPreviewLines`](#tool-output-preview-depth-tooloutputpreviewlines) above. This key caps
what is **recorded** — the copy that lands in run stats and that `gth eval` grades — and the model
has already seen the whole result by then. Setting it does not change the model's context, and it
does not change the preview.

The unit is UTF-8 bytes. The default is 8192, applied when the value is read, so a config that never
sets the key records exactly what it recorded before and prints no new key. A longer payload is cut
on a character boundary, so the recorded prefix is always valid text and can land a few bytes under
the cap; the record carries the original size, which is the number the failure reason quotes. An MCP
error body over the cap is dropped whole rather than recovered half-cut, because a cut JSON document
does not parse — that threshold is this key, so raising it recovers error bodies the default would
have dropped.

`0` is rejected, not "no cap". [`toolOutputPreviewLines`](#tool-output-preview-depth-tooloutputpreviewlines)
uses `0` to mean the minimum, and the same number meaning the opposite here would be a trap; someone
who wants no practical cap sets a large number, and the cost stays visible in the config. Negatives
and fractions are rejected too — a byte budget is a positive whole number. The key is top level,
because the cap applies to every recorded result, MCP ones included, rather than to one built-in tool.
The same cap applies to tool-call arguments recorded with
[`evalToolCallArgs`](#recorded-tool-call-arguments-evaltoolcallargs).

## Recorded tool-call arguments (evalToolCallArgs)

A `gth eval` suite needs to check what the agent asked a tool for, not only that it called it — the
filter it passed to a search, the id it asked for. Set the key in the config the run is started with
(the `-i` profile, the `-c` file or the project config):

```json
{ "evalToolCallArgs": true }
```

`gth eval` always writes a `toolCalls` list for each case: one entry per tool call, in the order the
model made them, with the tool's `name` and, when the provider sent one, the call's `id`. That list is what
[`tool_trajectory`](../COMMANDS.md#tool-call-order-assertions) checks. The setting decides only
whether each entry also carries the call's arguments as `args`.

With it on, every entry carries `args`, and suites can assert on them with
[`tool_call_json_path`](../COMMANDS.md#tool-call-argument-assertions). Off (the default), no
argument text is written, and a suite using `tool_call_json_path` is refused.

The arguments are written to `<case>.json` and `results.json`, and handed to every reporter, exactly
as the model sent them, with nothing redacted. Keep evals away from production data and real credentials: anything the
model puts in a tool call ends up in the eval output.

The setting belongs to the run, like [`reporters`](#custom-eval-reporters-reporters): in a suite with an
`identities:` matrix it is read from the config the run was started with, never from an identity's
profile. Recorded arguments are capped by
[`toolResultCaptureMaxBytes`](#recorded-tool-result-size-toolresultcapturemaxbytes) on the `gth-agent`
target.

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
piped output (e.g. in CI) — open with a run header. `output.header` grades how much of it you get,
across three rungs:

| rung | what the run opens with |
| --- | --- |
| `compact` (default) | One line naming the command you ran and the model that served it: `Gaunt Sloth · ask · gemini-3.1-pro (google-genai)`. On `review` and `pr`, that same line is the [review header](../guides/review-code-and-prs.md#what-a-review-is-labelled-with), emitted with the review document instead of with the preamble, so it never appears twice. |
| `debug` | The Workdir/Model/Tools/Middleware status lines, plus — in interactive terminal runs — the `Press Escape or Q to interrupt Agent` hint box. |
| `none` | Nothing — including, on `review` and `pr`, the review header. |

The default keeps the one thing a reader of the output cannot recover for themselves — which
command ran and which model answered — and drops the rest. A `gth ask` piped into a review thread
reads as an unattributed answer without that line.

Set `debug` when you want to see what the run actually loaded — the workdir it resolved, the tools
and middleware it registered — which is what you need when a tool is missing or a config is not
taking effect:

```json
{
  "output": {
    "header": "debug"
  }
}
```

`none` is for a byte-clean stream you post-process yourself — piping `gth review` into your own
comment template, or diffing captured stdout between runs. It is the only rung that removes the
review attribution, so a workflow that posts the output to a pull request should set `compact`
rather than `none`: an unlabelled AI review gets credited to whichever AI reviewer the reader
already knows.

Whatever the rung, model and tool output, errors, and config-validation warnings always print, and
Esc/Q interruption stays armed in interactive terminal runs even when the hint box is hidden.
Piped/non-TTY runs never arm Esc/Q regardless of this setting. The interactive TUI ignores the
setting and always shows the full header.

A boolean fails config validation, with a message naming the rung that replaces it — see
[Migrating to 2.0](../MIGRATION.md).

## Resume hint (output.resumeHint)

A recorded `gth ask` or `gth exec` run ends with one line on stderr naming the command that
continues the conversation:

```
To continue this conversation: gth ask --resume 3f2a9c1e-5b7d-4e8a-9c0f-1d2e3f4a5b6c "…"
```

Replace the `…` with your follow-up and run it. `exec` names `gth exec --resume <run id> -m "…"`.
The line goes to stderr, so `gth ask … > answer.txt` still writes only the answer. See
[Resuming a conversation](../COMMANDS.md#resuming-a-conversation) for what a resume carries over —
and that it does not bring back approvals granted in an interactive session: an
`ask`/`exec --resume` turn runs only with what your config allows.

`output.resumeHint` takes the same three rungs as `output.header`:

| rung | what the run ends with |
| --- | --- |
| `compact` (default) | The one line above. |
| `debug` | The line, then the conversation's number and the history file it is stored in. When a run gets no line, `debug` prints why instead — history is off, the checkpoint could not be written, or the run stopped at an approval with a tool call nobody answered, which a resume would refuse. |
| `none` | Nothing. |

```json
{
  "output": {
    "resumeHint": "none"
  }
}
```

The line appears only when pasting it would work, so a run that was not recorded, or that no
resume would accept, ends without it. A conversation recorded before run ids existed is named by
its number instead, which is valid only in that history file; `debug` says so. `batch`, `eval` and
`workflow` runs never print the line.

## End of run recap (recap)

A long `gth code` session finishes, the last thing on screen is a paragraph of prose, and you want
to know what it actually did and whether anything is still open — without scrolling back through
forty tool calls. Turn the recap on:

```json
{ "recap": "outstanding" }
```

Then run the session as usual:

```bash
gth code "migrate the config loader to zod 4 and update the specs"
```

When the turn ends, a short block follows the answer:

```
Run recap: the run reports work still outstanding
  Goal: Migrate the config loader to zod 4 and update the specs.
  What happened: Rewrote the loader against the zod 4 API and updated eleven specs; the suite passes.
  Still outstanding: The migration guide still describes the zod 3 error shape.
  Checklist: 1 of 4 items not marked completed (counted by the runtime, not by the model).
  Model-written summary of this run, produced by the gth runtime after the turn ended — not a message from the user, and not a claim the runtime verified.
```

**A run that ends cleanly is not the same as a run that finished the job.** Every other way a run
can end already announces itself — the provider rate-limited it, the connection failed, you
cancelled it — so the one ending that says nothing is the one that *looks* like success. That is
what this fills in.

### The three rungs

| rung | when a recap is written |
| --- | --- |
| `off` (default) | Never. |
| `outstanding` | Only when the run's own checklist still lists work. |
| `always` | Every run that ends without an error, including the ones that left nothing behind. |

`outstanding` is the one to start with: it speaks where the silence was costing you something and
leaves a clean run clean. `always` is the fuller feature — a recap of a run that went well is worth
reading too — at the price of a paragraph every turn.

The default is `off` because **a recap costs an extra model call**, made after your answer is
already on screen. Nothing spends your tokens on it until you ask. A boolean fails config
validation with a message naming the rungs.

### What it does and does not touch

The recap is written to **stderr**, like every other notice, so `gth exec` piped into a script
produces byte-for-byte the same stdout with the recap on. It is honoured by `gth chat`, `gth code`
(both the terminal UI and `--no-tui`), `gth ask` and `gth exec`. `gth batch`, `gth eval`,
`gth workflow`, `gth review` and `gth pr` never write one, whatever the rung — the first three drive
runs by the hundred, and the last two already end with a written verdict.

**It reports; it never continues the run.** Finding outstanding work is something the recap tells
you about, not something it acts on: nothing is retried, and no message is sent on your behalf.

The `Checklist:` line is counted by the runtime from the agent's own `gth_checklist` calls, and it
is the same count you get without a recap — with `recap` off, a run that ends with its checklist
unfinished says so on its own. When a recap is written it carries that line instead, so you get one
block about the ending rather than two.

Everything else in the block is the model's summary of its own run, which is what the last line
says. Read it as a report from the agent, not as a verified statement of what happened on disk.

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

A **package specifier** (`@scope/name` or `name`) is resolved by Node module resolution, honoring
the package's `exports`: first from the **project directory** (the folder holding `.gsloth`), then,
if it is not found there, from the **directory you started `gth` in** — so an eval project in a
subfolder with its own `node_modules` finds the reporter it installed. A value starting with `.`,
`/`, or `file:` is a **module path** resolved relative to the project directory. Either way it loads
through the same seam the built-ins use, so a name here can also override a built-in of the same
name. It runs as trusted code — it is your own config, which already executes arbitrary JS.

**Only the reporters you select are loaded.** A reporter registered here but not named in
`--reporter` is never imported, so registering a CI-only reporter does not break a local
`--reporter text` run where it isn't installed. For a **selected** reporter, an unresolvable package
(not installed), a missing file, a failed import, or a default export that isn't a function is a
harness error (`gth eval` exits 2).

**`reporters` is a run-level setting.** `gth eval` reads it once, from the config the run was started
with — the `-i` profile, the `-c` file, or the discovered project config, with the global config
underneath — and uses it for every suite. A suite with an `identities:` matrix uses the same
reporters: an identity's own profile is never read for them, so register reporters in the `-i`
profile (or the project config), not in the identity profiles.

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
