# Quickstart

Get from nothing to a real answer and a real code review in about five minutes.

You need [Node.js](https://nodejs.org) 24+ and an API key from one AI provider (or a local
[Ollama](https://ollama.com) — see [Local & free models](guides/local-and-free-models.md) if you
don't want to pay for one).

## 1. Install

```bash
npm install -g gaunt-sloth@alpha
```

This gives you the `gth` command (with `gsloth` and `gaunt-sloth` as aliases — use whichever you
like; this guide uses `gth`).

## 2. Set your provider key

Export the key for the provider you have. For Anthropic:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Other providers read their own variable — `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`,
`OPENROUTER_API_KEY`, and so on. The full list is in [Providers](configuration/providers.md).

## 3. Initialize the project

From your project's root:

```bash
gth init anthropic
```

This writes a `.gsloth.config.json` you can commit and tune later. The provider name is one of
`vertexai`, `anthropic`, `groq`, `deepseek`, `openai`, `google-genai`, `xai`, `openrouter`,
`huggingface`, `ollama`.

Prefer to be walked through it? Run `gth init` with no argument — it detects which providers have a
key set, lets you pick a provider and model, and offers to store the config for this project or
globally.

## 4. Ask your first question

```bash
gth ask "what does this project do?" -f README.md
```

`ask` is a one-shot question. `-f` adds files as context (repeat it for more), and you can pipe
input in:

```bash
cat error.log | gth ask "what is causing these errors?"
```

## 5. Review your changes

Reviews are stateless — nothing carries over between runs — so a review can't be argued down, and a
failing one exits non-zero, which is what makes it a CI gate.

```bash
git --no-pager diff | gth review
```

Working on a pull request? `gth pr 42` reviews PR #42 and pulls its linked issue in as the
requirements to check against.

## Where to go next

- **Do a specific job** — [Guides & Recipes](guides/review-code-and-prs.md): review PRs in CI, code
  against your own project rules, run a local model, script it non-interactively.
- **Tune the setup** — [Configuration](configuration/index.md): providers, tools, MCP servers,
  identity profiles.
- **Every command and flag** — [Commands](COMMANDS.md).
