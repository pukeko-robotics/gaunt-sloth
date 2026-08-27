# v2.0.0-beta.2 The Alignment Check

## New Features
- At `auto`, a command the auto-rater declines now gets a second model call asking whether it is what *you* asked for. It can clear a **destructive** rating and the host-naming network floor, never **attack**, **catastrophic** or a deterministic refusal, and where it lets a command run you are told rather than asked. `approvals.alignmentChecker` gives it its own profile; unset, it uses `approvals.rater`. See [Shell tool and approvals](../docs/guides/shell-tool-and-approvals.md#at-auto-a-second-check-asks-whether-you-asked-for-it).
- At `auto`, a fetch to a host you named yourself, verbatim, is a warning instead of a question.
- **deny always** is now saved to `.gsloth/.gsloth-settings/shell-denylist.json` and holds in later sessions. A saved refusal outranks a saved approval, at every mode including `bypass`; `/approvals undeny <number>` lifts one.
- The negotiation between the agent and the rater renders as it happens, and a negotiated approval is held 800 ms before it acts.
- `gth init` accepts `-g` and `-i <name>`, to write the global config or a named profile.
- Generated images and other inline binary output are written to disk in `gth chat` and `gth code`, not only on the non-streaming path.

## Potentially Breaking Changes
- The alpha-era mode spellings `read-only`, `auto-safe` and `full-auto` are now rejected as unrecognised values — use `manual`, `assisted`, `auto`.
- The shutdown family (`shutdown`/`reboot`/`halt`/`poweroff`, `init 0|6`, the `systemctl` forms, `telinit`) is destructive rather than catastrophic, so it leaves the unappealable floor and the rater decides it at every rung but `bypass`.

## Bug Fixes
- `gth_grep` no longer returns contents of files inside a directory that `.aiignore` hides.
- `gth pr` discovery no longer dies on its first tool call.
- `--global` together with `--config` is refused in the config loader, not only at the CLI.
- The `vertexai` preset authenticates through ADC even when `GOOGLE_API_KEY` is exported, instead of failing with a 401.

## Improvements
- Three consecutive failed rating calls raise one notice naming the rater model, so a rater whose provider rejects the call reads as broken rather than as a noisy gate.
- Review scoring is one bounded call instead of an agent loop, with `commands.<review|pr>.rating.timeoutMs` (default `120000`) as the backstop.
- The approval prompt keeps the host on screen instead of pushing it out of the pinned block, and a gated tool or MCP call is labelled as one.
- LangChain dependencies updated — `@langchain/core` `1.2.9`, `langchain` `1.5.10`, `@langchain/langgraph` `1.4.12` and the provider packages alongside them.
