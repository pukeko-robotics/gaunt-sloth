# Documentation maintenance

## Docs update is part of the change, not a follow-up

Whenever a node/PR ships a new or changed user-facing command, flag, config key, or behavior, the
documentation update **is part of that change** — it lands in the same PR, not as a "docs
follow-up" ticket filed for later. A behavior change without its doc update is not done.

This includes:

- a new command, subcommand, or flag;
- a changed default, config key, or env var;
- a new or changed slash command (`/...`) or other interactive-session behavior;
- any change to what a command's `--help`/`/help` output says it does.

For the actual authoring rules — one page per concept, the one worked use case, tracing every
claim to source, the `--help`-example requirement, the render-verification gate — see
**[docs/DOC-STYLE.md](../docs/DOC-STYLE.md)**. This file is the trigger ("when do docs need to
change"); `DOC-STYLE.md` is the rulebook ("how to write the change").

## README.md maintenance

1. Inspect README.md
2. Inspect docs/CONFIGURATION.md
3. Perform fact-checking of contents with actual code
   - Apply fact-checking edits if necessary
4. Check grammar, punctuation and flow
   - Apply edits if necessary.