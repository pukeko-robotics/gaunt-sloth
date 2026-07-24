# Local & free models

You don't need a paid API key to run `gth`. Point it at a model running locally on your own machine
with [Ollama](https://ollama.com) and every request stays on the box — no key, no bill, no data
leaving your network. Ollama is a first-class provider in Gaunt Sloth, so this is the shortest path.

## The main use case: ask a question with a local Ollama model

Goal: run `gth ask` against a free model on your own machine, with no provider key.

1. Install [Ollama](https://ollama.com), then pull a model. `qwen3-coder` is tool-tuned and is the
   model Gaunt Sloth defaults to for Ollama:

   ```bash
   ollama pull qwen3-coder
   ```

2. In your project root, scaffold an Ollama config:

   ```bash
   gth init ollama
   ```

   This writes a `.gsloth.config.json`. Set the model you just pulled:

   ```json
   {
     "llm": {
       "type": "ollama",
       "model": "qwen3-coder"
     }
   }
   ```

   That's the whole config — Ollama runs locally and needs no `apiKey`.

3. Ask:

   ```bash
   gth ask "what does this project do?" -f README.md
   ```

Gaunt Sloth talks to the Ollama daemon on `http://127.0.0.1:11434`. If your daemon runs elsewhere,
set `OLLAMA_HOST` (the same variable the Ollama CLI uses) rather than putting a URL in the config.

**Pick a tool-capable model.** Agent work (`code`, `exec`, the dev tools) needs a model that
supports tool calling; small models often don't do it reliably. `qwen3-coder`, `qwen3`, and
`gemma3` are known-good local picks. Plain `ask` questions work with almost any model.

If a large thinking model answers with empty content after running a tool, its context window is
starved — raise it with `numCtx` in the `llm` block (the default is `16384`):

```json
{
  "llm": {
    "type": "ollama",
    "model": "qwen3-coder",
    "numCtx": 32768
  }
}
```

## Any OpenAI-compatible server (LM Studio, llama.cpp)

Runtimes like [LM Studio](https://lmstudio.ai) expose an OpenAI-compatible endpoint. Use the
`openai` provider and point `baseURL` at it — the `apiKey` is required by the client but not
validated, so any string works:

```bash
gth init openai
```

```json
{
  "llm": {
    "type": "openai",
    "model": "openai/gpt-oss-20b",
    "apiKey": "none",
    "configuration": {
      "baseURL": "http://127.0.0.1:1234/v1"
    }
  }
}
```

Set `model` to the identifier the server reports and adjust the port if you changed it. The same
shape covers llama.cpp's `llama-server` (`http://127.0.0.1:8080/v1`) and any other local
OpenAI-compatible endpoint.

## Hugging Face inference

To use a hosted model through your Hugging Face account instead of running one locally, scaffold the
`huggingface` provider and set an `HF_TOKEN` (a [user access token](https://huggingface.co/settings/tokens)
with the **Inference Providers** permission):

```bash
gth init huggingface
```

```json
{
  "llm": {
    "type": "huggingface",
    "model": "openai/gpt-oss-120b"
  }
}
```

The `model` is the Hub repo id. `openai/gpt-oss-120b` is a strong tool-calling pick.

## Examples

```bash
# Pull a local model, then ask about the codebase
ollama pull qwen3-coder
gth ask "summarise what this module does" -f src/index.ts

# Point at an Ollama daemon on another host
OLLAMA_HOST=http://192.168.1.10:11434 gth ask "what does this project do?" -f README.md

# Review a local diff with a local model (no key, offline)
git --no-pager diff | gth review
```

## Related

- Full provider reference and every config key: [Providers](../configuration/providers.md).
- Get to a first answer end-to-end: [Quickstart](../quickstart.md).
- Every `ask` flag: [Commands](../COMMANDS.md#ask).
- Run different models for different commands: [Choose & switch models](choose-and-switch-models.md).
