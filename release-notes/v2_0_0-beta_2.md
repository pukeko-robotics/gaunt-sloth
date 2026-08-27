# v2.0.0-beta.2 The Alignment Check

## New Features

At the `auto` rung, a command the auto-rater declines now gets a second model call asking the one
question the rater is deliberately not given the material to answer: is this command what *you*
asked for. It is shown your own messages, the command with its rating and the agent's reason, and
its earlier rounds. What its approval may do is bounded in code — it can clear a **destructive**
rating and the host-naming network floor, and nothing else; **attack**, **catastrophic** and the
deterministic refusals hold whatever it answers. Where it is what let a command run, you are told
rather than asked. It costs one extra call, only at `auto`, and only on a command the rater did not
clear; a checker that is missing, times out or answers unusably leaves the rater's decision as it
stood. See
[Shell tool and approvals](../docs/guides/shell-tool-and-approvals.md#at-auto-a-second-check-asks-whether-you-asked-for-it).

- **`approvals.alignmentChecker`:** the identity profile that second check runs on, also settable
  per command. Unset, it is whatever `approvals.rater` resolves to; `raterTimeoutMs` covers it.
- **At Auto, a host you named yourself is a warning, not a question.** Where every host a command
  names appears verbatim in one of your own messages, the fetch runs and you are told, with the host
  named. The comparison is exact: a host the agent found for itself authorises nothing, and a command
  naming two hosts where you named one still asks.
- **`deny always` is saved to your project**, in `.gsloth/.gsloth-settings/shell-denylist.json` — the
  mirror of the allowlist. It refuses that exact command in every later session.
- **A saved refusal outranks a saved approval**, and is consulted at every mode including `bypass`.
- **`/approvals undeny <number>`** lifts a saved or session refusal; `/approvals` numbers each
  refusal and says where it came from.
- **The negotiation renders while it happens** at `auto`, on both the TUI and readline surfaces,
  through the renderer the escalation prompt uses. An intermediate rejection is warn-toned as a
  clarification request rather than a red failed tool call.
- **A negotiated approval is held for 800 ms before it acts** — an abort window for something you
  have just watched. Gated on a live display, so a headless run neither draws nor waits.
- **`gth init -g` and `gth init -i <name>`** write the global config or a named profile, e.g.
  `gth init -g -i test2` → `~/.gsloth/.gsloth-settings/test2/`.
- **Binary model output in interactive sessions.** Inline binary blocks are extracted from event
  streams and written to disk when the stream finishes, naming where they landed — so generated
  images appear in `gth chat` and `gth code`, not only on the non-streaming path.

## Potentially Breaking Changes

- **The alpha-era approval mode spellings are gone.** `read-only`, `auto-safe` and `full-auto` now
  fail as unrecognised values with no replacement named; use `manual`, `assisted` and `auto`. The
  retired `ask` still names both of its replacements (`write` or `manual`).
- **Shutting the host down is no longer refused deterministically.** The shutdown family
  (`shutdown` / `reboot` / `halt` / `poweroff`, `init 0|6`, the `systemctl` forms, `telinit`) is
  destructive rather than catastrophic, so it leaves the unappealable floor and the rater stands in
  front of it at every rung but `bypass`. The floor was also refusing a usage query, a dry run, and
  the flag that cancels a pending shutdown.
- **The raw-block-device redirect floor** now discriminates on whether the redirection operator sits
  inside a single-quoted region, instead of firing on the string.

## Bug Fixes

- **`gth_grep` returned contents from inside a directory `.aiignore` hides.** It now checks every
  directory between the file and the work folder, on both the ripgrep and fallback paths.
- **`gth pr` discovery died on its first tool call** — the discovery agent had no checkpoint saver,
  so the approval suspension threw instead of pausing.
- **`--global` with `--config` was refused only at the CLI**, so building a config any other way
  loaded the global one and ignored the named file in silence. The loader now refuses the pair.
- **Vertex AI no longer fails with a 401 when `GOOGLE_API_KEY` is exported.** The `vertexai` preset
  authenticates through ADC regardless; an `apiKey` in the `llm` block still wins, which is how
  express mode is asked for. Vertex auth failures now name the credential they are about.

## Improvements

- **A rater that can never answer says so.** A rejected rating call carries the provider's status and
  message, and three consecutive failures raise one session notice naming the rater model. One
  answered rating clears the count; there is no retry. A failed rating still lands on **destructive**
  and still asks you.
- **Review scoring is one round trip** instead of an agent loop that kept re-scoring after the score
  was settled — a fifteen-minute stall became ninety-one seconds against a local model.
  `commands.<review|pr>.rating.timeoutMs` (default `120000`) is the wall-clock backstop.
- **The approval prompt fits without scrolling.** The pinned block is a constant line plus a
  category; the note and the hosts render into the conversation, hosts nearest the prompt, so a long
  URL no longer costs you the line naming the counterparty.
- **A gated tool or MCP call is labelled as one** on both run-ending approval stops, and the
  suggested `approvals.allow` entry matches the kind of call.
- **A gated web fetch names its counterparty**, read from the tool call's own arguments rather than
  only from a command string.
- **No rounds are spent on an argument that cannot be won:** at `auto` a floored command comes to you
  on the first attempt instead of being handed back to the agent to justify.
- **An approved round no longer erases the argument.** It resets the consecutive-rejection count and
  leaves the rounds in view. The third consecutive rejection still goes to a person, and so does the
  ninth however they are spread out.
- **The shell floor has a Windows arm**, gated on the host platform.
- **OpenRouter names which of two settings won** when `baseURL`, `siteUrl` or `siteName` is set both
  at the top level and inside `configuration`.

## Maintenance

- LangChain dependencies updated: `@langchain/core` `1.2.9`, `langchain` and `@langchain/openai`
  `1.5.10`, `@langchain/langgraph` `1.4.12`, `@langchain/anthropic` `1.5.8`, `@langchain/google`
  `0.2.3`, `@langchain/openrouter` `0.4.10`, `@langchain/xai` `1.4.10`, `@langchain/deepseek`
  `1.1.10`, `@langchain/mcp-adapters` `1.1.4`.
