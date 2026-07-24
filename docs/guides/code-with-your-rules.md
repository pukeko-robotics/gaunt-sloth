# Code with your own project rules

Gaunt Sloth reads a **guidelines** prompt segment into every run — `code` included — so your
project's coding conventions become part of the agent's system prompt automatically, without you
restating them on each `gth code`. The default-named file is picked up with no config at all.

## The main use case: make `gth code` follow your conventions on every run

Goal: your project has coding rules (naming, error handling, what to never touch) and you want
`gth code` to honour them without pasting them into the prompt each time.

Put the rules in a file named `.gsloth.guidelines.md` at your project root:

```markdown
# Project coding guidelines

- TypeScript strict mode: never introduce `any`; prefer `unknown` + narrowing.
- All new HTTP handlers validate their input with the shared `zod` schemas in `src/schemas/`.
- Throw `AppError` (from `src/errors.ts`) for expected failures — never a bare `Error`.
- Do not edit files under `src/generated/`; they are produced by `npm run codegen`.
- Every new endpoint gets a Vitest test alongside it (`*.test.ts`).
```

Then start a coding session as usual:

```bash
gth code "add a DELETE /users/:id endpoint"
```

The agent now works with those rules already in context — it will reach for `zod` validation,
throw `AppError`, and leave `src/generated/` alone, without you mentioning any of it. Because
`.gsloth.guidelines.md` is the default-named guidelines file, no config entry or flag is needed:
Gaunt Sloth reads it from the config dir (`.gsloth/.gsloth-settings/`) or the project root on every
command.

## Reuse an existing conventions file

If your rules already live somewhere — an `AGENTS.md` at the repo root, say — point the guidelines
segment at it instead of duplicating them into `.gsloth.guidelines.md`. In `.gsloth.config.json`:

```json
{
  "prompts": {
    "guidelines": "AGENTS.md"
  }
}
```

The string is shorthand for `{ "path": "AGENTS.md" }` and **replaces** the default guidelines with
that file. To keep both — your `.gsloth.guidelines.md` and an appended `AGENTS.md` — use the object
form with `"mode": "append"`.

## Examples

```bash
# Rules in the default file, no config — just run code
gth code "refactor the auth middleware to use AppError"

# Rules sourced from an existing AGENTS.md via .gsloth.config.json prompts.guidelines
gth code "add pagination to the /orders list endpoint"
```

## Related

- Every prompt segment, the `{ path, enabled, mode }` object form, and how files resolve:
  [Prompt files](../configuration/prompts.md).
- All `code` flags and behaviour: [Commands](../COMMANDS.md#code).
