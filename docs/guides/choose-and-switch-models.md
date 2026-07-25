# Choose and switch models

A **named profile** is a config directory — `.gsloth/.gsloth-settings/<name>/` — that carries its
own `llm` block. Because the model lives in the profile, choosing which model a run uses is a
one-flag switch (`-i <name>`), with no config editing between runs and nothing to remember to put
back afterwards.

## The main use case: a cheap model for questions, a strong one for review

Goal: everyday `gth ask` runs on a fast, cheap model; `gth review` runs on a stronger model — and
you pick which one per run.

First, scaffold the two profiles. `config profile create` seeds each one from your current config
and swaps in the model you name:

```bash
gth config profile create ask --model claude-haiku-4-5
gth config profile create review --model claude-sonnet-4-5
```

Each command writes `.gsloth/.gsloth-settings/<name>/.gsloth.config.json` and prints where it landed
and what it uses, e.g.:

```
Created profile "ask" at /your/project/.gsloth/.gsloth-settings/ask/.gsloth.config.json
It uses anthropic / claude-haiku-4-5. Edit that file, then run with --profile ask.
```

The file it wrote is an ordinary, standalone config — just the provider and model:

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-haiku-4-5"
  }
}
```

`--model` overrides only the model, not the provider `type` (seeded from your current config, or
`anthropic` when none resolves). Both models above are Anthropic, so the scaffolds are correct as
written; if you point a profile at a different provider's model, open that file and fix `type` too.

Now run each command under its profile:

```bash
gth ask "why is my TypeScript build slow?" -i ask
gth review origin/main...feature-branch --content-source git -i review
```

`-i` (`--identity-profile`) selects the profile directory; `--profile` is the same flag under a
friendlier name. The selected profile replaces the *project-file* layer of the config, so `ask`
resolves `claude-haiku-4-5` and `review` resolves `claude-sonnet-4-5`. Naming a profile that has no
directory is an error — the run stops rather than silently falling back to your default config.

## See what you can pick from

`gth models` lists the providers detected on this machine and their callable models, annotated with
context limits and per-1M-token cost so you can tell the cheap tier from the expensive one before
you commit a model to a profile:

```bash
gth models --provider anthropic
```

## Examples

```bash
# Create a cheap everyday profile and a strong review profile
gth config profile create ask --model claude-haiku-4-5
gth config profile create review --model claude-sonnet-4-5

# Everyday question on the cheap model
gth ask "what does the retry backoff in api/client.ts do?" -i ask

# Code review on the strong model (--profile is the same flag as -i)
git --no-pager diff | gth review --profile review

# Change a profile's model later: overwrite it in place
gth config profile create ask --model claude-haiku-4-5 --force
```

## Related

- What a profile directory holds, precedence, and reusing one as a subagent identity:
  [Identity profiles](../configuration/profiles.md).
- Set up the provider and key each model runs under: [Providers](../configuration/providers.md).
- Every flag on the model catalog command: [Commands](../COMMANDS.md#models).
