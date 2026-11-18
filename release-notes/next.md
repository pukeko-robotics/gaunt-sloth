# v2.4.1

- Installing Gaunt Sloth no longer brings in zod 3 through the AG-UI encoder, so `npm audit` stops reporting the zod advisory GHSA-mrhx-c7xc-m3w5 against it.
- Behaviour change: refusing one tool call no longer cancels the other calls the agent made in the same step. The calls that need no approval, or that you approved, now run, and only the one you refused is skipped.
