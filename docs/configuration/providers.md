# Providers

Gaunt Sloth talks to your LLM through a **provider** — Anthropic, Google GenAI, Google Vertex AI,
Groq, DeepSeek, OpenAI, Open Router, Hugging Face, xAI, a local Ollama / LM Studio server, or any
OpenAI-compatible endpoint. Selecting one and wiring in a key is the one piece of configuration every
project needs, so it's where a new setup starts.

## Pick and configure your first provider

Goal: get `gth` talking to Claude in a fresh project.

```bash
cd ./your-project
gth init anthropic
export ANTHROPIC_API_KEY="sk-ant-..."
gth ask "who are you?"
```

`gth init anthropic` writes a `.gsloth.config.json` (by default under `.gsloth/.gsloth-settings/`)
with the Anthropic provider selected:

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  }
}
```

Export `ANTHROPIC_API_KEY` (or set `apiKey` in the config), and `gth ask` runs. Every other provider
follows the same shape — `gth init <vendor>`, provide the key, adjust `model`. The per-provider
reference below gives each one's `type`, its key environment variable, and a working snippet.

## Config initialization

Configuration can be created with the `gth init` command. When called without arguments, it detects
available API keys in the environment and prompts you to select a provider. You can also specify a
provider directly: `gth init [vendor]`. Currently, `anthropic`, `groq`, `deepseek`, `openai`,
`google-genai`, `vertexai`, `openrouter`, `huggingface` and `xai` can be configured with
`gth init [vendor]`. For providers using OpenAI format (like Inception), use `gth init openai` and
then modify the configuration.

By default, `gth init` creates a `.gsloth` directory in the project root and places configuration
files in `.gsloth/.gsloth-settings/`. Project root configuration is still supported for backward
compatibility.

### Google GenAI (AI Studio)

```bash
cd ./your-project
gth init google-genai
```

### Google Vertex AI

```bash
cd ./your-project
gth init vertexai
gcloud auth login
gcloud auth application-default login
```

### Anthropic

```bash
cd ./your-project
gth init anthropic
```

Make sure you either define `ANTHROPIC_API_KEY` environment variable or edit your configuration file and set up your key.

### Groq

```bash
cd ./your-project
gth init groq
```

Make sure you either define `GROQ_API_KEY` environment variable or edit your configuration file and set up your key.

### DeepSeek

```bash
cd ./your-project
gth init deepseek
```

Make sure you either define `DEEPSEEK_API_KEY` environment variable or edit your configuration file and set up your key.
(note this meant to be an API key from deepseek.com, rather than from a distributor like TogetherAI)

### OpenAI

```bash
cd ./your-project
gth init openai
```

Make sure you either define `OPENAI_API_KEY` environment variable or edit your configuration file and set up your key.

### Open Router

```bash
cd ./your-project
gth init openrouter
```

Make sure you either define `OPEN_ROUTER_API_KEY` environment variable or edit your configuration file and set up your key.

### Hugging Face (Inference Providers)

Hugging Face exposes a single **OpenAI-compatible router** at
`https://router.huggingface.co/v1` that fans requests out to the underlying
inference providers (Cerebras, Groq, Together, SambaNova, hf-inference, …) with
full tool/function calling, streaming and structured output. Gaunt Sloth talks
to it directly via the built-in `huggingface` provider, with no extra dependency.

```bash
cd ./your-project
gth init huggingface
```

Make sure you either define an `HF_TOKEN` environment variable (a Hugging Face
[user access token](https://huggingface.co/settings/tokens) with the **"Inference
Providers"** permission) or edit your configuration file and set up your key.
`HUGGINGFACEHUB_API_TOKEN` and `HF_API_KEY` are accepted as aliases.

```json
{
  "llm": {
    "type": "huggingface",
    "model": "openai/gpt-oss-120b"
  }
}
```

**Configuration notes:**

- The `model` is the **Hub repo id**, e.g. `openai/gpt-oss-120b` or
  `Qwen/Qwen3-Coder-480B-A35B-Instruct`.
- You may append a routing suffix that the router understands to pin or
  auto-select the backend provider / cost policy: `:groq`, `:cheapest`,
  `:fastest` (e.g. `"openai/gpt-oss-120b:groq"`). The suffix is part of the model
  id and passes straight through.
- Tool-calling quality is model-dependent; `openai/gpt-oss-120b` is a strong
  tool-calling pick.
- Any extra field under `configuration` is passed straight to the underlying
  `ChatOpenAI` client, so provider-routing preferences can go there too.

#### Local Hugging Face models

To run a Hugging Face model **locally** you do not need a dedicated provider:
every mainstream local runtime exposes an OpenAI-compatible endpoint, and Gaunt
Sloth already speaks to those via the `openai` provider + `configuration.baseURL`
(see [LM Studio](#lm-studio) below). The only "bridge" is pulling the HF model
into one of those runtimes (for example, Google's `gemma-4-12B` QAT `Q4_0` quant,
pulled from the Hub, is verified working in Gaunt Sloth via Ollama):

**llama.cpp (`llama-server`)** downloads GGUF straight from the Hub with `-hf`:

```bash
llama-server -hf ggml-org/gemma-3-1b-it-GGUF        # downloads + serves on :8080
# or a specific quant:
llama-server -hf bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M
```

```json
{
  "llm": {
    "type": "openai",
    "apiKey": "none",
    "model": "gpt-oss",
    "configuration": {
      "baseURL": "http://127.0.0.1:8080/v1"
    }
  }
}
```

**Ollama** pulls any GGUF on the Hub via the `hf.co/` namespace and serves an
OpenAI-compatible API on `:11434/v1`. Gaunt Sloth ships a first-class `ollama`
provider, so you can point at it directly. Pull the model once (the Ollama daemon
then serves it on demand); the example below is verified working in Gaunt Sloth:

```bash
ollama pull hf.co/google/gemma-4-12B-it-qat-q4_0-gguf:Q4_0
```

```json
{
  "llm": {
    "type": "ollama",
    "model": "hf.co/google/gemma-4-12B-it-qat-q4_0-gguf:Q4_0"
  }
}
```

**LM Studio** lets you search and download the HF model in-app; start its server
and point `baseURL` at `http://127.0.0.1:1234/v1` (see the LM Studio section below).

**Note:** tool-calling reliability is model- and runtime-dependent for small
local models. Prefer tool-tuned models (e.g. Qwen2.5-Coder/-Instruct, gpt-oss)
for agent work.

### LM Studio

LM Studio provides a local OpenAI-compatible server for running models on your machine.

```bash
cd ./your-project
gth init openai
```

Then edit your configuration file to point to your LM Studio server:

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

**Configuration notes:**

- LM Studio uses OpenAI format, so set `type` to `"openai"`
- The `apiKey` can be any random string (e.g., `"none"`) - LM Studio doesn't validate it
- The default `baseURL` is `http://127.0.0.1:1234/v1`, but adjust the port if you've configured LM Studio differently
- The `model` should match the model identifier shown in LM Studio
- **Important:** The model must support tool calling. Tested models include:
  gpt-oss, granite, nemotron, seed, qwen3

For a complete example, see [examples/lmstudio/.gsloth.config.json](../../examples/lmstudio/.gsloth.config.json).

### Other OpenAI-compatible providers (Inception, etc.)

For providers that use OpenAI-compatible APIs:

```bash
cd ./your-project
gth init openai
```

Then edit your configuration file to add the custom base URL and API key. For example, for Inception:

```json
{
  "llm": {
    "type": "openai",
    "model": "mercury-coder",
    "apiKeyEnvironmentVariable": "INCEPTION_API_KEY",
    "configuration": {
      "baseURL": "https://api.inceptionlabs.ai/v1"
    }
  }
}
```

- apiKeyEnvironmentVariable property can be used to point to the correct API key environment variable.

### xAI

```bash
cd ./your-project
gth init xai
```

Make sure you either define `XAI_API_KEY` environment variable or edit your configuration file and set up your key.

## Examples of configuration for different providers

### JSON Configuration (.gsloth.config.json)

JSON configuration is simpler but less flexible than JavaScript configuration. It should directly contain the configuration object.

**Example of .gsloth.config.json for Anthropic**

```json
{
  "llm": {
    "type": "anthropic",
    "apiKey": "your-api-key-here",
    "model": "claude-sonnet-4-5"
  }
}
```

You can use the `ANTHROPIC_API_KEY` environment variable instead of specifying `apiKey` in the config.

**Example of .gsloth.config.json for Groq**

```json
{
  "llm": {
    "type": "groq",
    "model": "deepseek-r1-distill-llama-70b",
    "apiKey": "your-api-key-here"
  }
}
```

You can use the `GROQ_API_KEY` environment variable instead of specifying `apiKey` in the config.

**Example of .gsloth.config.json for DeepSeek**

```json
{
  "llm": {
    "type": "deepseek",
    "model": "deepseek-reasoner",
    "apiKey": "your-api-key-here"
  }
}
```

You can use the `DEEPSEEK_API_KEY` environment variable instead of specifying `apiKey` in the config.

**Example of .gsloth.config.json for OpenAI**

```json
{
  "llm": {
    "type": "openai",
    "model": "gpt-4o",
    "apiKey": "your-api-key-here"
  }
}
```

You can use the `OPENAI_API_KEY` environment variable instead of specifying `apiKey` in the config.

**Example of .gsloth.config.json for LM Studio (OpenAI-compatible)**

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

LM Studio runs locally and doesn't require a real API key. Use any string for `apiKey`.
**Note:** The model must support tool calling. Tested models include gpt-oss, granite, nemotron, seed, and qwen3.

**Example of .gsloth.config.json for Inception (OpenAI-compatible)**

```json
{
  "llm": {
    "type": "openai",
    "model": "mercury-coder",
    "apiKeyEnvironmentVariable": "INCEPTION_API_KEY",
    "configuration": {
      "baseURL": "https://api.inceptionlabs.ai/v1"
    }
  }
}
```

You can use the `INCEPTION_API_KEY` environment variable as specified in `apiKeyEnvironmentVariable`.

**Example of .gsloth.config.json for Google GenAI**

```json
{
  "llm": {
    "type": "google-genai",
    "model": "gemini-2.5-pro",
    "apiKey": "your-api-key-here"
  }
}
```

You can use the `GOOGLE_API_KEY` environment variable instead of specifying `apiKey` in the config.

**Example of .gsloth.config.json for VertexAI**

```json
{
  "llm": {
    "type": "vertexai",
    "model": "gemini-2.5-pro"
  }
}
```

VertexAI typically uses gcloud authentication; no `apiKey` is needed in the config. 
It will give you 401 error if you have `GOOGLE_API_KEY` with AI Studio API key,
you may need to remove `GOOGLE_API_KEY` from environment variables and authenticate with ADC `gcloud auth application-default login`
or to use API key issued by Vertex AI.

**Example of .gsloth.config.json for Open Router**

```json
{
  "llm": {
    "type": "openrouter",
    "model": "moonshotai/kimi-k2"
  }
}
```

Make sure you either define `OPEN_ROUTER_API_KEY` environment variable or edit your configuration file and set up your key.
When changing a model, make sure you're using a model which supports tools.

**Example of .gsloth.config.json for xAI**

```json
{
  "llm": {
    "type": "xai",
    "model": "grok-4-0709",
    "apiKey": "your-api-key-here"
  }
}
```

You can use the `XAI_API_KEY` environment variable instead of specifying `apiKey` in the config.

### JavaScript Configuration

(.gsloth.config.js or .gsloth.config.mjs)

JavaScript configuration provides more flexibility than JSON configuration, allowing you to use dynamic imports and include custom tools.

**For a complete working example** demonstrating custom middleware and custom tools, see:

- [JavaScript Config Example README](../../examples/js-config/README.md) - Full documentation and usage guide
- [Example Config File](../../examples/js-config/.gsloth.config.js) - Complete working example with custom logging middleware and custom logger tool

The example demonstrates:

- Custom middleware with all lifecycle hooks (`beforeAgent`, `beforeModel`, `afterModel`, `afterAgent`)
- Custom tool creation using LangChain's `tool()` API
- Combining built-in and custom middleware
- Practical patterns for extending Gaunt Sloth functionality

For a more realistic custom tool (zod schema, config-dependent availability, external API call),
see the worked [Jira work-log tool example](../custom-tool-example-jira-log-work.md).

**Example with Custom Tools**

```javascript
// .gsloth.config.mjs
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const parrotTool = tool(
  (s) => {
    console.log(s);
  },
  {
    name: 'parrot_tool',
    description: `This tool will simply print the string`,
    schema: z.string(),
  }
);

export async function configure() {
  const google = await import('@langchain/google/node');
  return {
    llm: new google.ChatGoogle({
      model: 'gemini-2.5-pro',
      vertexai: true,
    }),
    tools: [parrotTool],
  };
}
```

**Example of .gsloth.config.mjs for Anthropic**

```javascript
export async function configure() {
  const anthropic = await import('@langchain/anthropic');
  return {
    llm: new anthropic.ChatAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY, // Default value, but you can provide the key in many different ways, even as literal
      model: 'claude-sonnet-4-5',
    }),
  };
}
```

**Example of .gsloth.config.mjs for Groq**

```javascript
export async function configure() {
  const groq = await import('@langchain/groq');
  return {
    llm: new groq.ChatGroq({
      model: 'deepseek-r1-distill-llama-70b', // Check other models available
      apiKey: process.env.GROQ_API_KEY, // Default value, but you can provide the key in many different ways, even as literal
    }),
  };
}
```

**Example of .gsloth.config.mjs for DeepSeek**

```javascript
export async function configure() {
  const deepseek = await import('@langchain/deepseek');
  return {
    llm: new deepseek.ChatDeepSeek({
      model: 'deepseek-reasoner',
      apiKey: process.env.DEEPSEEK_API_KEY, // Default value, but you can provide the key in many different ways, even as literal
    }),
  };
}
```

**Example of .gsloth.config.mjs for OpenAI**

```javascript
export async function configure() {
  const openai = await import('@langchain/openai');
  return {
    llm: new openai.ChatOpenAI({
      model: 'gpt-4o',
      apiKey: process.env.OPENAI_API_KEY, // Default value, but you can provide the key in many different ways, even as literal
    }),
  };
}
```

**Example of .gsloth.config.mjs for LM Studio (OpenAI-compatible)**

```javascript
export async function configure() {
  const openai = await import('@langchain/openai');
  return {
    llm: new openai.ChatOpenAI({
      model: 'openai/gpt-oss-20b',
      apiKey: 'none', // LM Studio doesn't validate API keys
      configuration: {
        baseURL: 'http://127.0.0.1:1234/v1',
      },
    }),
  };
}
```

**Note:** The model must support tool calling. Tested models include gpt-oss, granite, nemotron, seed, and qwen3.

**Example of .gsloth.config.mjs for Inception (OpenAI-compatible)**

```javascript
export async function configure() {
  const openai = await import('@langchain/openai');
  return {
    llm: new openai.ChatOpenAI({
      model: 'mercury-coder',
      apiKey: process.env.INCEPTION_API_KEY, // Default value, but you can provide the key in many different ways, even as literal
      configuration: {
        baseURL: 'https://api.inceptionlabs.ai/v1',
      },
    }),
  };
}
```

**Example of .gsloth.config.mjs for Google GenAI**

```javascript
export async function configure() {
  const google = await import('@langchain/google/node');
  return {
    llm: new google.ChatGoogle({
      model: 'gemini-2.5-pro',
      apiKey: process.env.GOOGLE_API_KEY, // Default value, but you can provide the key in many different ways, even as literal
      platformType: 'gai',
    }),
  };
}
```

**Example of .gsloth.config.mjs for VertexAI**
VertexAI usually needs `gcloud auth application-default login`
(or both `gcloud auth login` and `gcloud auth application-default login`) and does not need any separate API keys.

```javascript
export async function configure() {
  const google = await import('@langchain/google/node');
  return {
    llm: new google.ChatGoogle({
      model: 'gemini-2.5-pro', // Consider checking for latest recommended model versions
      vertexai: true,
      // API Key from AI Studio should also work
      //// Other parameters might be relevant depending on Vertex AI API updates.
      //// The project is not in the interface, but it is in documentation and it seems to work.
      // project: 'your-cool-google-cloud-project',
    }),
  };
}
```

**Example of .gsloth.config.mjs for xAI**

```javascript
export async function configure() {
  const xai = await import('@langchain/xai');
  return {
    llm: new xai.ChatXAI({
      model: 'grok-4-0709',
      apiKey: process.env.XAI_API_KEY, // Default value, but you can provide the key in many different ways, even as literal
    }),
  };
}
```

## Using other AI providers

The configure function should simply return instance of langchain [chat model](https://v03.api.js.langchain.com/classes/_langchain_core.language_models_chat_models.BaseChatModel.html).
See [Langchain documentation](https://js.langchain.com/docs/tutorials/llm_chain/) for more details.

## Model Identity in the Prompt (injectModelContext)

So the agent can answer "which model are you?" and reason about its own limits, Gaunt Sloth injects
one line naming the active `provider:model` into the system prompt. It is **on by default** and
applies in **every mode** (`chat`, `ask`, `code`, `exec`).

Turn it off with the top-level `injectModelContext: false`. This suits reproducible or
model-agnostic runs — e.g. a `review` you want kept blind to which model served it — where the
assembled prompt is then exactly what it would be without the feature.

```json
{
  "injectModelContext": false
}
```

For the OpenAI-compatible providers (`openrouter`, `deepseek`, `xai`) the identity is tagged with
the configured `type` — e.g. `openrouter:<model>` — not the underlying `openai` transport they share.

## Related

- Back to the configuration overview: [Configuration](./index.md).
- Configure tools, MCP servers, and prompts once your provider works:
  [Tools](./tools.md), [MCP](./mcp.md), [Prompts](./prompts.md).
- Every command flag: [Commands](../COMMANDS.md).
