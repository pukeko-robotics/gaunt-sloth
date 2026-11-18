# v2.4.1

- Installing Gaunt Sloth no longer brings in zod 3 through the AG-UI encoder, so `npm audit` stops reporting the zod advisory GHSA-mrhx-c7xc-m3w5 against it.
- `gth eval` can grade a command-line agent such as Claude Code: a `command` target starts it once per case and grades its tool calls and results from the transcript it prints. Running such a suite runs its command. See [The command target](https://github.com/pukeko-robotics/gaunt-sloth/blob/v2.4.1/docs/COMMANDS.md#the-command-target).
- Behaviour change: refusing one tool call no longer cancels the other calls the agent made in the same step. The calls that need no approval, or that you approved, now run, and only the one you refused is skipped.
