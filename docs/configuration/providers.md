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
`google-genai`, `vertexai`, `openrouter`, `huggingface`, `ollama` and `xai` can be configured with
`gth init [vendor]`. For providers using OpenAI format (like Inception), use `gth init openai` and
then modify the configuration.

By default, `gth init` creates a `.gsloth` directory in the project root and places configuration
files in `.gsloth/.gsloth-settings/`. Project root configuration is still supported for backward
compatibility.

`gth init` also accepts the global `-g`/`--global` and `-i, --identity-profile <name>` flags to
target `~/.gsloth/` or a named profile (`.gsloth/.gsloth-settings/<name>/`, or its global
counterpart) instead of the plain project config — see [init](../COMMANDS.md#init) and
[Creating a profile](profiles.md#creating-a-profile).

### Google GenAI (AI Studio)

```bash
cd ./your-project
gth init google-genai
```

**`configuration` is not a passthrough here.** Gaunt Sloth talks to the Gemini API through its own
client rather than an OpenAI one, so nothing in a `configuration` block reaches it, and anything you
put there is reported as ignored when the provider starts. Set `customHeaders`, `endpoint` or
`apiVersion` as top-level fields of the `llm` block instead, beside `model`.

### Google Vertex AI

```bash
cd ./your-project
gth init vertexai
gcloud auth login
gcloud auth application-default login
```

**`configuration` is not a passthrough here.** Vertex AI serves the same Gemini models through the
same native client, so a `configuration` block reaches nothing here either and is reported as
ignored when the provider starts. Set `customHeaders`, `endpoint`, `apiVersion` or `location` as
top-level fields of the `llm` block instead, beside `model`.

#### Application Default Credentials from the environment

`gcloud auth application-default login` is inert for a session whose credentials come from
`GOOGLE_APPLICATION_CREDENTIALS` — typically a CI runner or a container, wherever a service-account
key file has been provisioned and the variable points at it. That variable is resolved *before* the
well-known credentials file, so the command writes a file this session never reads, reports success,
and leaves the failure exactly where it was.

Repair or replace the credentials in the file the variable points at, or unset the variable so the
well-known Application Default Credentials file is used instead. `google-auth-library` reads the
lower-case `google_application_credentials` as well, with the upper-case spelling winning when both
are set — so unset whichever one your environment exports.

### Anthropic

```bash
cd ./your-project
gth init anthropic
```

Make sure you either define `ANTHROPIC_API_KEY` environment variable or edit your configuration file and set up your key.

**`configuration` is not a passthrough here.** Gaunt Sloth builds an Anthropic SDK client, which
takes its client options from `clientOptions`, so a `configuration` block reaches nothing and is
reported as ignored when the provider starts. Put a custom base URL, a timeout or extra headers
under `clientOptions` in the `llm` block, or set `anthropicApiUrl` there for the base URL alone.

### Groq

```bash
cd ./your-project
gth init groq
```

Make sure you either define `GROQ_API_KEY` environment variable or edit your configuration file and set up your key.

**`configuration` is not a passthrough here.** Gaunt Sloth builds a Groq SDK client from top-level
fields of the `llm` block, so a `configuration` block reaches nothing and is reported as ignored when
the provider starts. Set `baseUrl` (note the lower-case `url`), `timeout`, `defaultHeaders`,
`defaultQuery`, `httpAgent` or `fetch` beside `model`.

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

**OpenRouter's own options are top-level fields of the `llm` block**, written beside `model`. The
useful ones are `provider` (routing preferences), `models` (a fallback list), `route`, `plugins`,
`transforms`, `trace`, `sessionId`, and the sampling knobs `minP`, `topA`, `repetitionPenalty`,
`seed`, `logitBias`, `topLogprobs`. This example pins routing to a provider that will not train on
your data, forbids fallbacks to anyone else, and gives a second model to fall back to:

```json
{
  "llm": {
    "type": "openrouter",
    "model": "moonshotai/kimi-k2",
    "provider": {
      "order": ["together", "fireworks"],
      "allow_fallbacks": false,
      "data_collection": "deny"
    },
    "models": ["moonshotai/kimi-k2", "anthropic/claude-sonnet-5"],
    "route": "fallback"
  }
}
```

**`configuration` is not a passthrough here.** Gaunt Sloth talks to OpenRouter through a native
client rather than an OpenAI one, so the only things read out of a `configuration` block are
`baseURL` and the `HTTP-Referer` / `X-Title` attribution headers (`siteUrl` and `siteName` at the
top level are the direct way to set those). Anything else you put there is reported as ignored when
the provider starts — move OpenRouter's own options (the fields listed above) to the top level.
Transport settings are the exception: they have no top-level field either, so moving one up only
makes it ignored quietly instead of loudly — see the next paragraph for what to do with those.

**Two of these settings can be written in two places, and the winner differs.** `baseURL` set under
`configuration` beats a top-level `baseURL`; a top-level `siteUrl` / `siteName` beats the matching
`HTTP-Referer` / `X-Title` inside `configuration`. Rather than ask you to remember which way round
each one goes, Gaunt Sloth names the losing setting and the winning one when you set both, so the
two never disagree in silence. Set only one of each pair and the message goes away.

Transport settings have no per-provider hook at all: there is no `fetch`, `timeout`, `maxRetries`
or custom-header option on this client. To send OpenRouter traffic through a **corporate proxy**,
set one process-wide — run node with `--use-env-proxy` (or set `NODE_USE_ENV_PROXY=1`) together
with `HTTP_PROXY` / `HTTPS_PROXY`, which the global `fetch` this provider uses honours:

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://proxy.corp:3128 gth chat
```

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
  `ChatOpenAI` client (the router base URL is composed in front of your block, so
  the rest of it — `timeout`, `defaultHeaders`, … — applies as written). Backend
  routing itself is chosen by the model-id suffix above, not by this block.

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

### Ollama

Ollama is a first-class provider — no API key, everything local:

```bash
cd ./your-project
gth init ollama
```

```json
{
  "llm": {
    "type": "ollama",
    "model": "qwen3-coder"
  }
}
```

Gaunt Sloth talks to the Ollama daemon on `http://127.0.0.1:11434`; set `OLLAMA_HOST` (the same
variable the Ollama CLI uses) if yours runs elsewhere. Raise the context window with `numCtx` in the
`llm` block (default `16384`). The full walkthrough — model choice, context sizing, and other local
runtimes — is the [Local & free models](../guides/local-and-free-models.md) guide.

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

A complete LM Studio config:

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

**`configuration` is not a passthrough here.** `ChatXAI` does build an OpenAI client, but it
replaces the `configuration` block with one of its own first, so nothing you put there survives —
not a timeout, not headers, not even a base URL — and it is reported as ignored when the provider
starts. Set `baseURL` or `timeout` as top-level fields of the `llm` block instead, beside `model`.
Extra headers have no home on this provider at all: to send them, use the `openai` provider with
`configuration.baseURL` set to `https://api.x.ai/v1`, which takes a full `configuration` block — and
point `apiKeyEnvironmentVariable` at `XAI_API_KEY` there, since that provider otherwise reads
`OPENAI_API_KEY`.

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

See [LM Studio](#lm-studio) above for the API-key and tool-calling notes.

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

VertexAI uses gcloud authentication; no `apiKey` is needed in the config, so authenticate with
`gcloud auth application-default login`.

If `GOOGLE_APPLICATION_CREDENTIALS` is set in your environment, that command is inert — see
[Application Default Credentials from the environment](#application-default-credentials-from-the-environment).

**A `GOOGLE_API_KEY` in your environment does not change this.** The provider is chosen by your
config, so a `vertexai` block keeps using Application Default Credentials even when an AI Studio
key is exported for a `google-genai` profile. To use a Vertex AI express-mode key instead, put it
in the `llm` block as `apiKey` — that is a deliberate choice and it is honoured.

**Gemini thinking (both `google-genai` and `vertexai`)**

Gemini thinks by default, and Gaunt Sloth asks for the summaries of that thinking, so it appears in
the `/reasoning` panel of an interactive session. You are billed for those reasoning tokens either
way, so there is no separate switch for displaying them — the knob is how much thinking to buy.

Set `thinkingLevel` to `minimal`, `low`, `medium` or `high`, or give an explicit token budget with
`thinkingBudget`. Both `"thinkingLevel": "minimal"` and `"thinkingBudget": 0` empty the `/reasoning`
panel, but they only stop the model thinking on flash models — a pro model floors them instead
(`gemini-2.5-pro` to a 128-token budget, `gemini-3-pro` to `low`), so on those you keep paying for
thinking you can no longer see. An explicit `thinkingBudget` reaches the API verbatim on 2.5 models;
3.x models take a level instead, so a budget is coarsened to one (8192 becomes `medium`, or `low` on
`gemini-3-pro`, which is floored the same way it is above).

Summaries are not requested for a model whose name marks it as an image or speech model: the
provider library withholds thinking configuration from some of those on purpose, and an image or
speech generation has no reasoning panel to fill.

```json
{
  "llm": {
    "type": "google-genai",
    "model": "gemini-3.6-flash",
    "thinkingLevel": "low"
  }
}
```

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

What a JavaScript config can do that a JSON one cannot:

| | JSON (`.gsloth.config.json`) | JavaScript (`.gsloth.config.js`) |
|---|---|---|
| Middleware | predefined only (strings or config objects) | custom, built with `createMiddleware` |
| Tools | built-ins only | custom, built with LangChain's `tool()` |
| Control | declarative | full programmatic control |

#### Custom middleware

Middleware gives you hooks at four points in agent execution. **Always wrap custom middleware with
`createMiddleware`** — that is what adds the `MIDDLEWARE_BRAND` marker LangChain and Gaunt Sloth
expect, and an unwrapped object is not recognised as middleware.

```javascript
import { createMiddleware } from 'langchain';

const customMiddleware = createMiddleware({
  name: 'my-middleware',

  beforeAgent(state) {
    // Called once, before the agent starts. Modify state if needed.
    return state;
  },

  beforeModel(state) {
    // Called before each LLM call.
    return state;
  },

  afterModel(state) {
    // Called after each LLM response.
    return state;
  },

  afterAgent(state) {
    // Called once, after the agent completes.
    return state;
  },
});
```

#### Custom tools

```javascript
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const myTool = tool(
  (input) => {
    return `Result: ${input.param}`;
  },
  {
    name: 'my_tool',
    description: 'What the tool does',
    schema: z.object({
      param: z.string().describe('Parameter description'),
    }),
  }
);
```

#### A complete config using both

Custom middleware sits alongside built-in middleware in the same array, and `commands` can scope
filesystem access and built-in tools per command:

```javascript
import { createMiddleware } from 'langchain';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { ChatVertexAI } from '@langchain/google-vertexai';

const loggingMiddleware = createMiddleware({
  name: 'custom-logging',
  beforeAgent(state) {
    console.log('🚀 beforeAgent - agent execution starting');
    return state;
  },
  beforeModel(state) {
    console.log(`🤖 beforeModel - messages: ${state.messages?.length || 0}`);
    return state;
  },
  afterModel(state) {
    console.log('✅ afterModel - LLM responded');
    return state;
  },
  afterAgent(state) {
    console.log('🏁 afterAgent - agent execution complete');
    return state;
  },
});

const customLoggerTool = tool(
  ({ message, level = 'info' }) => {
    const icon = { info: 'ℹ️', warning: '⚠️', success: '✅' }[level] ?? 'ℹ️';
    console.log(`${icon} [Custom Tool] ${message}`);
    return `Logged: ${message}`;
  },
  {
    name: 'custom_logger',
    description:
      'Custom Logger Tool. Use this tool to log important information during execution.',
    schema: z.object({
      message: z.string().describe('The message to log'),
      level: z.enum(['info', 'warning', 'success']).optional().describe('Log level (default: info)'),
    }),
  }
);

export async function configure() {
  return {
    llm: new ChatVertexAI({ model: 'gemini-2.5-pro', temperature: 0 }),

    middleware: [
      'anthropic-prompt-caching', // built-in
      loggingMiddleware, // custom
    ],

    tools: [customLoggerTool],

    commands: {
      chat: { filesystem: 'read', builtInTools: ['gth_status_update'] },
      code: { filesystem: 'all', builtInTools: ['gth_status_update'] },
    },
  };
}
```

Running `gth chat` with that config prints the lifecycle log around the model call, and the tool line
whenever the agent calls it:

```
🚀 beforeAgent - agent execution starting
🤖 beforeModel - messages: 2
✅ afterModel - LLM responded
🏁 afterAgent - agent execution complete
ℹ️ [Custom Tool] Processing data...
```

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
With `GOOGLE_APPLICATION_CREDENTIALS` set, those commands are inert — see
[Application Default Credentials from the environment](#application-default-credentials-from-the-environment).

**This example builds the client itself, so it does not get the `type: vertexai` behaviour above.**
A `GOOGLE_API_KEY` exported in your environment takes over the request here, ahead of ADC — and an
AI Studio key is not valid for Vertex AI endpoints, so it fails with a 401. Either unset it, or set
`apiKey` explicitly to a Vertex AI express-mode key.

```javascript
export async function configure() {
  const google = await import('@langchain/google/node');
  return {
    llm: new google.ChatGoogle({
      model: 'gemini-2.5-pro', // Consider checking for latest recommended model versions
      vertexai: true,
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

This setting governs the model identity **everywhere in the prompt**, not just that line. In `code`
mode the same resolved identity also decorates the default git
[commit co-author](output.md#commit-co-author-commitcoauthor) name, as
`Gaunt Sloth (provider:model)` — or `Gaunt Sloth (model)` when no provider half resolves.

Turn it off with the top-level `injectModelContext: false`. This suits reproducible or
model-agnostic runs — e.g. a `review` you want kept blind to which model served it. With it off the
identity line is gone and the commit trailer degrades to the plain `Gaunt Sloth`, so the assembled
prompt names no model anywhere.

```json
{
  "injectModelContext": false
}
```

The identity is tagged with the configured `type` — e.g. `openrouter:<model>` — rather than with
whatever the model class calls itself, so a provider is never labelled as the client it happens to
be built on (`huggingface` would otherwise appear as `openai:<model>`, and both Gemini providers as
`google:<model>`).

## Related

- Back to the configuration overview: [Configuration](./index.md).
- Configure tools, MCP servers, and prompts once your provider works:
  [Tools](./tools.md), [MCP](./mcp.md), [Prompts](./prompts.md).
- Every command flag: [Commands](../COMMANDS.md).
