# v2.0.0-beta.2 The Alignment Check

The second beta of the 2.0 line. The approvals gate gains a second model check at Auto, a refusal
you save now outlives the session, and the argument between the agent and the auto-rater is visible
while it happens instead of only when it fails.

## New Features

### A second check at Auto asks whether you asked for it

At the `auto` rung a command the auto-rater declines now gets one more model call, which asks the
question the rater is deliberately not given the material to answer: is this command what *you*
asked for. It is shown your own messages from this session, the command with its rating and the
reason the agent gave for wanting it, and its own earlier rounds.

- What its approval may do is bounded in code: it can clear a **destructive** rating, and it can
  clear the host-naming network floor. It cannot clear **attack**, **catastrophic**, or any
  deterministic refusal, whatever it answers.
- Where it is what let a command run, you are told rather than asked, in a notice naming the command
  and saying the alignment check cleared it.
- `approvals.alignmentChecker` names the identity profile it runs on (settable per command as
  `commands.<cmd>.approvals.alignmentChecker`). Unset, it is whatever `approvals.rater` resolves to.
  It has no timeout of its own — `raterTimeoutMs` covers the whole check.
- A checker that is missing, runs out of time, or answers with something unusable leaves the rater's
  own decision exactly as it stood.
- It costs one extra model call, only at `auto`, and only on a command the rater did not clear.

See [Shell tool and approvals](../docs/guides/shell-tool-and-approvals.md#at-auto-a-second-check-asks-whether-you-asked-for-it).

### At Auto, a host you named yourself is a warning instead of a question

Where every host a command names appears verbatim in one of your own messages in the conversation,
the network floor — which otherwise never lets such a command be rated safe — does not fire at
`auto`. The fetch runs and you are told it happened, with the host named so you can check it is the
one you meant.

The comparison is exact and word-for-word: a URL you pasted authorises that URL and nothing that
merely starts with it, a host the agent found for itself authorises nothing, and a command naming
two hosts where you named one still asks. A file you fed the command (an `exec` prompt file,
`ask -f`, piped stdin) counts as your input; what `review` and `pr` fetch for the agent to read
never does. Over ACP, a file or link the editor composes into your message reads as one you named —
treat an attachment as something you have vouched for.

The rater still rates the command, and `deny` and `escalate` still decide first.

### `deny always` is saved to your project

The **deny always** choice at an approval prompt now writes its entry to
`.gsloth/.gsloth-settings/shell-denylist.json`, the mirror of the allowlist, in the same folder and
the same entry grammar. It is refused in every later session, not just this one.

- **A refusal outranks an approval.** Where a call matches both a saved approval and a saved
  refusal, it is refused. The denylist is consulted at every mode, `bypass` included.
- `/approvals` numbers each refusal and says where it came from — your config's `approvals.deny`, a
  **deny always** saved to this project, or one held for this session only.
  `/approvals undeny <number>` lifts either of the latter two.
- A saved entry refuses that exact command, not a family of them: `git reset --hard` does not cover
  `git reset --hard HEAD`. For a family, write a `glob` or `regexp` entry in `approvals.deny`.
- A store file that cannot be read is reported, naming the file — or, for a single bad entry, its
  position — and nothing in it is in force. Nothing is written over an unreadable file, so what it
  holds is recoverable; an answer given meanwhile applies to that session only and says so.
- A write that fails is reported rather than swallowed, and `/approvals` lists that answer as a
  session one rather than as saved.
- Top-level keys in those files that the store does not use are written back untouched.

### The negotiation is visible while it happens

At `auto` the rounds between the agent and the rater now render as the gate decides them, on both
the TUI and the readline surface, through the same renderer the escalation prompt uses — so the
exchange you watched and the one you are later asked to rule on are one account of one argument.

- An intermediate rejection is warn-toned and named as a clarification request, instead of arriving
  in the red vocabulary of a failed tool call.
- The live panel is bounded to the same three-round screen the escalation prompt draws.
- A negotiated approval is held for 800 ms before it takes effect. This is an abort window for
  something you have just watched, not a reading window; it is gated on a live display, so a
  headless run neither draws nor waits.
- Reaching a person ends the exchange on screen as well as in the gate, so the escalation prompt is
  no longer drawn underneath a copy of the same rounds.

### `gth init -g` and `gth init -i <name>`

`init` now honours the same global and profile flags as every other command.

```bash
gth init -g              # create/overwrite the global config, skipping the scope question
gth init -i test2        # a named profile via the dialog (.gsloth/.gsloth-settings/test2)
gth init -g -i test2     # a named profile under ~/.gsloth/.gsloth-settings/test2
gth init -i test2 anthropic   # scriptable path: writes the project profile directly
```

This is the interactive way to create a profile — provider and model picked from the live catalog —
alongside `gth config profile create <name>`, which seeds one from your current effective config.
See [Creating a profile](../docs/configuration/profiles.md#creating-a-profile).

### Binary model output in interactive sessions

Inline binary blocks returned by a model are now extracted from event streams as chunks arrive and
written to disk when the stream finishes, with a message naming where they landed — so generated
images appear in `gth chat` and `gth code`, not only on the non-streaming path. Extraction now
recognises camelCase and snake_case `inlineData`, data URLs in `image_url` strings and objects,
Anthropic base64 `source` blocks, flat media properties, and single non-array responses.

## Potentially Breaking Changes

- **The alpha-era approval mode spellings are gone from the product.** `read-only`, `auto-safe` and
  `full-auto` were renamed eleven days into the 2.0 alpha, and a value born during an alpha is owed
  no back compatibility: one of them in a config now fails as an unrecognised value, with no message
  offering the new name. Use `manual`, `assisted` and `auto`. The retired `ask` value stays in the
  migration table and still names both of its replacements (`write` or `manual`), because it maps
  across two different modes rather than being a rename.
- **Shutting the host down is no longer refused deterministically.** The shutdown family —
  `shutdown` / `reboot` / `halt` / `poweroff`, `init 0` and `init 6`, the `systemctl` forms, and
  `telinit` — is destructive rather than catastrophic, so it leaves the unappealable floor and the
  rater now stands in front of it at every rung but `bypass`. The floor was also refusing the
  remediation it exists to protect: a usage query, a dry run, and the flag that calls off a pending
  shutdown.
- **The raw-block-device redirect arm is anchored on the operation.** It fired on the string with no
  anchor of any kind; it now discriminates on whether the redirection operator sits inside a
  single-quoted region.

## Bug Fixes

- **`gth_grep` returned contents from inside a directory `.aiignore` hides.** The tool runs its own
  traversal and only asked whether the matched file itself was ignored, so a directory pattern hid
  nothing beneath it. It now asks about every directory between the file and the work folder, on both
  the ripgrep and the fallback path.
- **`gth pr` discovery died on its first tool call.** The discovery agent's tools are gated, so the
  first call suspends the graph; with no checkpoint saver it threw instead, killing every discovery
  run.
- **`--global` with `--config` was refused only at the CLI.** Building a config any other way loaded
  the global config and ignored the named file in silence. The loader now refuses the pair itself,
  ahead of the existence check that would otherwise blame a file nobody was going to read.

## Improvements

- **A rater that can never answer says so.** A rejected rating call now carries the provider's
  status and message, and three consecutive failures with none answered in between raise one session
  notice naming the rater model — so a model whose provider refuses the structured verdict outright
  reads as a broken rater rather than as a gate that has become unbearably noisy. One answered rating
  clears the count. There is no retry, since a rejection never clears. Nothing else changes while it
  is broken: a failed rating still lands on **destructive** and still asks you.
- **Review scoring is one round trip.** The rating behind `gth review` and `gth pr` is a single
  bounded call instead of an agent loop that fed each tool result back and scored again long after
  the score was settled. Against a local model this took the same review from a fifteen-minute stall
  to ninety-one seconds and a pass. `commands.<review|pr>.rating.timeoutMs` (default `120000`) is
  the wall-clock backstop, and a cancelled call now reads differently from a provider error.
- **The approval prompt fits the screen you answer it on.** The pinned block is now a constant line
  plus a category from a closed vocabulary; the gate's note and the hosts render into the
  conversation, hosts last and nearest the prompt, where nothing needs a length cap. A long URL no
  longer costs you the one line naming the counterparty.
- **A gated tool or MCP call is labelled as one** on both run-ending approval stops, and the
  suggested `approvals.allow` entry now matches the kind of call — a shell entry could never have
  matched a tool call.
- **A gated web fetch names its counterparty.** Hosts are read from a tool call's own arguments, not
  only from a command string, so a fetch is no longer described as a generic tool with no host.
- **No rounds are spent on an argument that cannot be won.** At `auto`, a command one of the
  deterministic preflights floors is re-checked from the raw text every round and can never be
  approved, so it now goes to you on the first attempt (or ends an unattended run, printing the
  `approvals.allow` entry where it can name the command precisely enough to write one) instead of
  being handed back to the agent to justify.
- **An approved round no longer erases the argument.** It resets the consecutive-rejection count and
  leaves the rounds in view, so a retry after the agent did what a rejection asked for is rated with
  the earlier attempt and your messages in front of the rater. The third consecutive rejection still
  goes to a person, and so does the ninth however they are spread out.
- **The shell floor has a Windows arm**, gated on the host platform.
- **OpenRouter says which of two settings won.** `baseURL` under `configuration` beats a top-level
  `baseURL`; a top-level `siteUrl` / `siteName` beats the matching `HTTP-Referer` / `X-Title` inside
  `configuration`. Rather than expect you to remember which way round each goes, both the losing and
  the winning setting are named when you set both.
- **Vertex AI authenticates through ADC even when `GOOGLE_API_KEY` is exported.** The `vertexai`
  preset no longer picks up an AI Studio key from the environment and fails with a 401; the provider
  is chosen by your config. An `apiKey` in the `llm` block still wins, which is how a Vertex AI
  express-mode key is asked for on purpose. A Vertex auth failure now names the credential it is
  actually about. A hand-built `configure()` client is not covered by this — see
  [Providers](../docs/configuration/providers.md).

## Maintenance

- LangChain dependencies updated: `@langchain/core` `1.2.9`, `langchain` / `@langchain/openai`
  `1.5.10`, `@langchain/langgraph` `1.4.12`, `@langchain/anthropic` `1.5.8`, `@langchain/google`
  `0.2.3`, `@langchain/openrouter` `0.4.10`, `@langchain/xai` `1.4.10`, `@langchain/deepseek`
  `1.1.10`, `@langchain/mcp-adapters` `1.1.4`.
