# Configuration

> **Upgrading from 1.x?** 2.0 is a breaking config release. See
> [Migrating to 2.0](MIGRATION.md) for the HARD vs SOFT change list and before/after
> snippets, then run `gth config validate` to check your migrated config.

Populate `.gsloth.guidelines.md` with your project details and quality requirements.
A proper preamble is paramount for good inference.
Check [.gsloth.guidelines.md](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/.gsloth.guidelines.md) for example.

Your project should have the following files in order for gsloth to function:

- Configuration file (one of):
  - `.gsloth.config.js` (JavaScript module)
  - `.gsloth.config.json` (JSON file)
  - `.gsloth.config.mjs` (JavaScript module with explicit module extension)
- `.gsloth.guidelines.md`

> Gaunt Sloth currently only functions from the directory which has one of the configuration files and `.gsloth.guidelines.md`. Configuration files can be located in the project root or in the `.gsloth/.gsloth-settings/` directory.
>
> You can also specify a path to a configuration file directly using the `-c` or `--config` global flag, for example `gth -c /path/to/your/config.json ask "who are you?"`

## Using .gsloth Directory

For a tidier project structure, you can create a `.gsloth` directory in your project root. When this directory exists, gsloth will:

1. Write all output files (like responses from commands) to the `.gsloth` directory instead of the project root
2. Look for configuration files in `.gsloth/.gsloth-settings/` subdirectory

Example directory structure when using the `.gsloth` directory:

```
.gsloth/.gsloth-settings/.gsloth.config.json
.gsloth/.gsloth-settings/.gsloth.guidelines.md
.gsloth/.gsloth-settings/.gsloth.review.md
.gsloth/gth_2025-05-18_09-34-38_ASK.md
.gsloth/gth_2025-05-18_22-09-00_PR-22.md
```

If the `.gsloth` directory doesn't exist, gsloth will continue writing all files to the project root directory as it did previously.

**Note:** When initializing a project with an existing `.gsloth` directory, the configuration files will be created in the `.gsloth/.gsloth-settings` directory automatically. There is no automated migration for existing configurations - if you create a `.gsloth` directory after initialization, you'll need to manually move your configuration files into the `.gsloth/.gsloth-settings` directory.

### Identity profiles

Sometimes two different teams have different perspectives of a project.
For example, developers may want to review the code for code quality.
DevOps may want to be notified when some configuration files or docker image their configurations of Gaunt Sloth
may be so different that this is better to keep them in complete separation.

Identity profiles may be used to define different Gaunt Sloth identities for different purposes.

Identity profiles can only be activated in directory-based configuration.
`gth -i devops pr PR_NO` is invoked, the configuration is pulled from `.gsloth/.gsloth-settings/devops/` directory,
which may contain a full set of config files:

```
.gsloth.backstory.md
.gsloth.config.json
.gsloth.guidelines.md
.gsloth.review.md
```

When no identity profile is specified in the command, for example `gth pr PR_NO`,
the configuration is pulled from the `.gsloth/.gsloth-settings/` directory.

`-i` or `-identity-profile` overrides entire configuration directory, which means it should contain
a configuration file and prompt files. In the case if some prompt files are missing, they will be
fetched from the installation directory.

### Controlling Output Files

By default, Gaunt Sloth does **not** write responses to disk. Set `writeOutputToFile` in your
config to opt in:

- `false` (default) to skip writing files,
- `true` to write each response to `gth_<timestamp>_<COMMAND>.md` under `.gsloth/` (or the project root),
- a string for a custom path (behavior depends on the format):
  - **Bare filenames** (e.g. `"review.md"`) are placed in `.gsloth/` when it exists, otherwise project root
  - **Paths with separators** (e.g. `"./review.md"` or `"reviews/last.md"`) are always relative to project root

**Examples:**

- `"review.md"` → `.gsloth/review.md` (when `.gsloth` exists) or `review.md` (otherwise)
- `"./review.md"` → `review.md` (always project root)
- `"reviews/last.md"` → `reviews/last.md` (always relative to project root)

Override the setting per run with `-w/--write-output-to-file true|false|<filename>`. Shortcuts `-wn` or `-w0` map to `false`.

### Binary Model Outputs (Image Generation)

Some models (e.g. Gemini with image generation) return inline binary content such as images. By default, Gaunt Sloth saves these as local files instead of printing raw base64 to the terminal.

Output files are named `gth_<timestamp>_<COMMAND>.<ext>` and placed in the same location as text output files. The extension is derived from the MIME type (e.g. `image/png` → `.png`).

Set `writeBinaryOutputsToFile` in your config to control this behavior:

- `true` (default) — binary outputs are saved to files and a confirmation message is displayed
- `false` — binary content is not saved; raw content blocks are printed as JSON

```json
{
  "llm": {"type": "vertexai", "model": "gemini-3.1-flash-image-preview", "location": "global"},
  "writeBinaryOutputsToFile": true
}
```

## AG-UI Server Configuration

The `api ag-ui` command reads its settings from `commands.api` in your config file.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `commands.api.port` | `number` | `3000` | Port the AG-UI server listens on |
| `commands.api.cors.allowOrigin` | `string` | `"http://localhost:3000"` | `Access-Control-Allow-Origin` header value |
| `commands.api.cors.allowMethods` | `string` | `"POST, GET, OPTIONS"` | `Access-Control-Allow-Methods` header value |
| `commands.api.cors.allowHeaders` | `string` | `"Content-Type, Accept"` | `Access-Control-Allow-Headers` header value |

**Example config for the Galvanized Pukeko web client on port 5555:**

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "commands": {
    "api": {
      "port": 3000,
      "cors": {
        "allowOrigin": "http://localhost:5555",
        "allowMethods": "POST, GET, OPTIONS",
        "allowHeaders": "Content-Type, Accept"
      }
    }
  }
}
```

> **Note:** The port flag `--port` on the CLI overrides `commands.api.port`.

## Agent Backend (`agent.backend`)

Gaunt Sloth ships two agent backends. Select one with the top-level `agent.backend` field.

| Value | Backend | Notes |
|-------|---------|-------|
| `lean` (**default**) | Plain LangChain agent | Recommended. Gaunt Sloth's own toolset — filesystem, hardened dev/shell, and the `gth_checklist` planning tool. Used for the CLI (`code`/`chat`), single-shot (`ask`/`exec`), and the AG-UI/`api` server. |
| `deep` | deepagents runtime | **Experimental, opt-in.** Adds subagents, `write_todos`, summarization, and large-tool-result offload, but can exhibit path divergence and sporadic failures. Selecting it prints a warning. |

```json
{
  "llm": { "type": "anthropic", "model": "claude-sonnet-4-5" },
  "agent": { "backend": "lean" }
}
```

When `agent.backend` is omitted, the lean backend is used everywhere. Set `"backend": "deep"` only
to opt into the experimental deepagents runtime. The ACP server is structurally deepagents-based and
always runs the deep backend regardless of this setting.

## Built-in Tools (`builtInTools`)

`builtInTools` selects **and configures** which built-in tools the agent loads. It can be set at the
top level or per command (`commands.<command>.builtInTools`); a per-command value replaces the
top-level one. Available tools:

| Tool | Description |
|------|-------------|
| `gth_checklist` | Planning / todo checklist for multi-step work (the lean agent's `write_todos` equivalent). Renders as a live checkbox panel in the TUI. **Enabled by default.** |
| `gth_web_fetch` | Fetch content from an HTTP/HTTPS URL. |
| `gth_status_update` | Print a short status line to the console. |
| `show_a2ui_surface` | (AG-UI) render an A2UI surface in the web client. |
| `run_tests` / `run_lint` / `run_build` / `run_single_test` | Dev-command tools — run the configured shell command. Only active in `code` / `exec` (and `ask --write`). See [Development Tools](#development-tools-configuration). |
| `run_shell_command` | Opt-in general-purpose shell tool (arbitrary commands, human-approved). **On by default in `code` mode.** See [Shell tool](#development-tools-configuration). |

`builtInTools` accepts **two shapes**:

- a **string array** — each named tool is enabled: `["gth_checklist", "gth_web_fetch"]`;
- an **object registry** keyed by tool name, whose values **enable** (`true`), **force-disable**
  (`false`), or **configure** (an object) each tool.

The default is `["gth_checklist"]`. Setting your own `builtInTools` **replaces** this set entirely, so
include `gth_checklist` in your list (or `"gth_checklist": true`) if you want to keep it. Example — add
web fetch while keeping the checklist:

```json
{
  "builtInTools": ["gth_checklist", "gth_web_fetch"]
}
```

The object form also carries the dev/shell tool configuration (in 1.x this lived in a separate
per-command `devTools` key, now removed — see [Migration](MIGRATION.md)). Example — keep the
checklist, add web fetch, configure the test/build commands, and tune the shell:

```json
{
  "builtInTools": {
    "gth_checklist": true,
    "gth_web_fetch": true,
    "run_tests": { "command": "npm test" },
    "run_build": { "command": "npm run build" },
    "run_shell_command": { "timeout": 300000, "judge": { "enabled": true } }
  }
}
```

Turn the (code-mode default-on) shell OFF with `{ "run_shell_command": false }`.

> **Note:** because the object form (like the array form) **replaces** the default set, disabling one
> tool (e.g. `{ "run_shell_command": false }`) also drops `gth_checklist` unless you list it too. To
> keep it, add `"gth_checklist": true` to the registry.

## AI Ignore (.aiignore)

Gaunt Sloth can hide files and directories from filesystem tools using a `.aiignore` file in your project root.
Patterns use minimatch rules (similar to `.gitignore`), and lines starting with `#` are treated as comments.

**Example `.aiignore`:**

```
node_modules/
dist/
*.log
```

You can control this behavior in config:

- `aiignore.enabled` (boolean, default `true`) to enable/disable `.aiignore` support.
- `aiignore.patterns` (array of strings) to supply patterns directly instead of reading `.aiignore`.

**Example config:**

```json
{
  "aiignore": {
    "enabled": true,
    "patterns": ["node_modules/", "dist/", "*.log"]
  }
}
```

When `.aiignore` is missing, Gaunt Sloth logs the message at debug level only.

## Binary Format Configuration

Gaunt Sloth can process binary formats (images, files, audio, video) when your LLM model
supports multimodal inputs.

Important notes:

- Binary formats are disabled by default
- You must explicitly configure which extensions to allow
- Check your LLM provider documentation for supported formats

Enable binary formats by adding the `binaryFormats` array to your config:

```json
{
  "binaryFormats": [
    { "type": "image", "extensions": ["png", "jpg", "jpeg", "webp", "gif"] },
    { "type": "file", "extensions": ["pdf"] }
  ]
}
```

Presence of `binaryFormats` in the config auto-injects `binary-content-injection` middleware.

Format types:

| Type    | Description                           |
| ------- | ------------------------------------- |
| `image` | Image files for vision-capable models |
| `file`  | Other files (e.g., PDFs)              |
| `audio` | Audio files for speech-capable models |
| `video` | Video files for video-capable models  |

Each format type supports:

- `type` (required): The format type category
- `extensions` (required): Array of allowed file extensions (without dots)
- `maxSize` (optional): Maximum file size in bytes (default: 10MB)
- `mimeTypes` (optional): Custom MIME type mappings for unusual extensions

Binary formats can also be configured per command:

```json
{
  "commands": {
    "review": {
      "binaryFormats": [{ "type": "image", "extensions": ["png", "jpg"] }]
    },
    "code": {
      "binaryFormats": false
    }
  }
}
```

## Console Logging Level

Console output can be filtered using `consoleLevel`. The default is `info`, which hides debug-level output.
Lower levels are more verbose. Valid values for JSON configs:
`debug`, `info`, `display`, `success`, `warning`, `error`, `stream`.

**Example config:**

```json
{
  "consoleLevel": "warning"
}
```

## No Default Prompts

By default, Gaunt Sloth falls back to its bundled `.gsloth.*.md` prompt files when no user-provided files are found. Setting `noDefaultPrompts` to `true` disables this fallback, so only user-provided prompt files are used. This applies to all `.gsloth.*.md` files including backstory, system, chat, code, guidelines, and review instructions.

**Example config:**

```json
{
  "noDefaultPrompts": true
}
```

## Configuration Object

Refer to documentation site for [Configuration Interface](https://gauntsloth.app/docs/interfaces/config.GthConfig.html)

Refer to documentation site for [Default Config Values](https://gauntsloth.app/docs/variables/config.DEFAULT_CONFIG.html)

It is always worth checking sourcecode in [config.ts](../src/config.ts) for more insightful information.

## Config initialization

Configuration can be created with `gsloth init` command. When called without arguments, it detects available API keys in the environment and prompts you to select a provider.
You can also specify a provider directly: `gsloth init [vendor]`.
Currently, anthropic, groq, deepseek, openai, google-genai, vertexai, openrouter, huggingface and xai can be configured with `gsloth init [vendor]`.
For providers using OpenAI format (like Inception), use `gsloth init openai` and then modify the configuration.

By default, `gsloth init` creates a `.gsloth` directory in the project root and places configuration files in `.gsloth/.gsloth-settings/`. Project root configuration is still supported for backward compatibility.

### Google GenAI (AI Studio)

```bash
cd ./your-project
gsloth init google-genai
```

### Google Vertex AI

```bash
cd ./your-project
gsloth init vertexai
gcloud auth login
gcloud auth application-default login
```

### Anthropic

```bash
cd ./your-project
gsloth init anthropic
```

Make sure you either define `ANTHROPIC_API_KEY` environment variable or edit your configuration file and set up your key.

### Groq

```bash
cd ./your-project
gsloth init groq
```

Make sure you either define `GROQ_API_KEY` environment variable or edit your configuration file and set up your key.

### DeepSeek

```bash
cd ./your-project
gsloth init deepseek
```

Make sure you either define `DEEPSEEK_API_KEY` environment variable or edit your configuration file and set up your key.
(note this meant to be an API key from deepseek.com, rather than from a distributor like TogetherAI)

### OpenAI

```bash
cd ./your-project
gsloth init openai
```

Make sure you either define `OPENAI_API_KEY` environment variable or edit your configuration file and set up your key.

### Open Router

```bash
cd ./your-project
gsloth init openrouter
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
gsloth init huggingface
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
into one of those runtimes:

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
provider, so you can point at it directly:

```bash
ollama run hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M
```

```json
{
  "llm": {
    "type": "ollama",
    "model": "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M"
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
gsloth init openai
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

For a complete example, see [examples/lmstudio/.gsloth.config.json](../examples/lmstudio/.gsloth.config.json).

### Other OpenAI-compatible providers (Inception, etc.)

For providers that use OpenAI-compatible APIs:

```bash
cd ./your-project
gsloth init openai
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
gsloth init xai
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

- [JavaScript Config Example README](../examples/js-config/README.md) - Full documentation and usage guide
- [Example Config File](../examples/js-config/.gsloth.config.js) - Complete working example with custom logging middleware and custom logger tool

The example demonstrates:

- Custom middleware with all lifecycle hooks (`beforeAgent`, `beforeModel`, `afterModel`, `afterAgent`)
- Custom tool creation using LangChain's `tool()` API
- Combining built-in and custom middleware
- Practical patterns for extending Gaunt Sloth functionality

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

## Integration with GitHub Workflows / Actions

Example GitHub workflows integration can be found in [.github/workflows/review.yml](.github/workflows/review.yml)
this example workflow performs AI review on any pushes to Pull Request, resulting in a comment left by,
GitHub actions bot.

## Model Context Protocol (MCP)

Gaunt Sloth supports the Model Context Protocol (MCP), which provides enhanced context management. You can connect to various MCP servers, including those requiring OAuth authentication.

### OAuth-enabled MCP Servers

Gaunt Sloth now supports OAuth authentication for MCP servers. This has been tested with the Atlassian Jira MCP server.

#### Example: Atlassian Jira MCP Server

To connect to the Atlassian Jira MCP server using OAuth, add the following to your `.gsloth.config.json`:

```json
{
  "llm": {
    "type": "vertexai",
    "model": "gemini-2.5-pro",
    "temperature": 0
  },
  "mcpServers": {
    "jira": {
      "url": "https://mcp.atlassian.com/v1/sse",
      "authProvider": "OAuth",
      "transport": "sse"
    }
  }
}
```

For a complete working example, see [examples/jira-mcp](../examples/jira-mcp).

**OAuth Authentication Flow:**

1. When you first use a command that requires the MCP server, your browser will open automatically
2. Complete the OAuth authentication in your browser
3. The authentication tokens are stored securely in `~/.gsloth/.gsloth-auth/`
4. Future sessions will use the stored tokens automatically

**Token Storage:**

- OAuth tokens are stored in JSON files under `~/.gsloth/.gsloth-auth/`
- Each server's tokens are stored in a separate file named after the server URL
- The storage location is cross-platform (Windows, macOS, Linux)

### MCP stdio Server Configuration

To configure local MCP server, add the `mcpServers` section to your configuration file,
for example, configuration for reference sequential thinking MCP follows:

```json
{
  "llm": {
    "type": "vertexai",
    "model": "gemini-2.5-pro"
  },
  "mcpServers": {
    "sequential-thinking": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

This configuration launches the MCP filesystem server using npx, providing the LLM with access to the specified directory. The server uses stdio for communication with the LLM.

## Content sources

### GitHub Issues

Gaunt Sloth supports GitHub issues as a requirement source using the GitHub CLI. This integration is simple to use and requires minimal setup.

**Prerequisites:**

1. **GitHub CLI**: Make sure the official [GitHub CLI (gh)](https://cli.github.com/) is installed and authenticated
2. **Repository Access**: Ensure you have access to the repository's issues

**Usage:**

The command syntax is `gsloth pr <prId> [githubIssueId]`. For example:

```bash
gsloth pr 42 23
```

This will review PR #42 and include GitHub issue #23 as requirements.

To explicitly specify the GitHub issue provider:

```bash
gsloth pr 42 23 -p github
```

**Configuration:**

To set GitHub as your default requirement source, add this to your configuration file:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-2.5-pro" },
  "commands": {
    "pr": {
      "requirementSource": "github"
    }
  }
}
```

### JIRA

Gaunt Sloth supports three methods to integrate with JIRA:

#### Atlassian MCP

MCP can be used in `chat` and `code` commands.

Gaunt Sloth has OAuth client for MCP and is confirmed to work with public Jira MCP.

```json
{
  "llm": {
    "type": "vertexai",
    "model": "gemini-2.5-pro",
    "temperature": 0
  },
  "mcpServers": {
    "jira": {
      "url": "https://mcp.atlassian.com/v1/sse",
      "authProvider": "OAuth",
      "transport": "sse"
    }
  }
}
```

#### 1. Modern Jira REST API (Scoped Token)

Jira API is used with `pr` and `review` commands.

This method uses the Atlassian REST API v3 with a Personal Access Token (PAT). It requires your Atlassian Cloud ID.

**Prerequisites:**

1. **Cloud ID**: You can find your Cloud ID by visiting `https://yourcompany.atlassian.net/_edge/tenant_info` while authenticated.

2. **Personal Access Token (PAT)**: Create a PAT with the appropriate permissions from `Atlassian Account Settings -> Security -> Create and manage API tokens -> [Create API token with scopes]`.
   - For issue access, the recommended permission is `read:jira-work` (classic)
   - Alternatively granular access would require: `read:issue-meta:jira`, `read:issue-security-level:jira`, `read:issue.vote:jira`, `read:issue.changelog:jira`, `read:avatar:jira`, `read:issue:jira`, `read:status:jira`, `read:user:jira`, `read:field-configuration:jira`

Refer to JIRA API documentation for more details [https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get)

**Environment Variables Support:**

For better security, you can set Jira credentials using environment variables instead of placing them in the configuration file:

- `JIRA_FULL_BASE64_TOKEN`: Full pre-encoded Basic auth payload. When present, Gaunt Sloth uses it as-is and does not require `JIRA_USERNAME` or `JIRA_API_PAT_TOKEN`.
- `JIRA_USERNAME`: Your JIRA username (e.g., `user@yourcompany.com`).
- `JIRA_API_PAT_TOKEN`: Your JIRA Personal Access Token with scopes.
- `JIRA_CLOUD_ID`: Your Atlassian Cloud ID.

If these environment variables are set, they will take precedence over the values in the configuration file.

JSON:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-2.5-pro" },
  "requirementSource": "jira",
  "requirementSourceConfig": {
    "jira": {
      "username": "username@yourcompany.com",
      "token": "YOUR_JIRA_PAT_TOKEN",
      "cloudId": "YOUR_ATLASSIAN_CLOUD_ID"
    }
  }
}
```

Optionally displayUrl can be defined to have a clickable link in the output:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-2.5-pro" },
  "requirementSource": "jira",
  "requirementSourceConfig": {
    "jira": {
      "displayUrl": "https://yourcompany.atlassian.net/browse/"
    }
  }
}
```

If your environment already contains a full Base64-encoded Basic token, you can configure only the Cloud ID and optional display URL:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-2.5-pro" },
  "requirementSource": "jira",
  "requirementSourceConfig": {
    "jira": {
      "cloudId": "YOUR_ATLASSIAN_CLOUD_ID",
      "displayUrl": "https://yourcompany.atlassian.net/browse/"
    }
  }
}
```

With this setup, export `JIRA_FULL_BASE64_TOKEN` in the environment and Gaunt Sloth will send `Authorization: Basic <token>` directly.

JavaScript:

```javascript
export async function configure() {
  const google = await import('@langchain/google/node');
  return {
    llm: new google.ChatGoogle({
      model: 'gemini-2.5-pro',
      vertexai: true,
    }),
    requirementSource: 'jira',
    requirementSourceConfig: {
      jira: {
        username: 'username@yourcompany.com', // Your Jira username/email
        token: 'YOUR_JIRA_PAT_TOKEN', // Your Personal Access Token
        cloudId: 'YOUR_ATLASSIAN_CLOUD_ID', // Your Atlassian Cloud ID
      },
    },
  };
}
```

##### Automatic work logging for Jira reviews

When you pass a Jira issue ID to `gsloth pr` and use the modern Jira provider (`requirementSource: "jira"`),
you can ask Gaunt Sloth to log review time back to that issue automatically by setting
`commands.pr.logWorkForReviewInSeconds`. The value is recorded as worklog seconds after each PR review.

```json
{
  "commands": {
    "pr": {
      "requirementSource": "jira",
      "logWorkForReviewInSeconds": 600
    }
  }
}
```

This automation only runs when a `requirementsId` is supplied on the command line and the provider resolves to `jira`. It therefore does **not** apply when running `gsloth pr` with no arguments (change requirements discovery): the Jira key discovered automatically is used for the review but is not passed to the worklog path, so no time is logged. Pass the issue id explicitly (`gsloth pr <prId> <requirementsId>`) if you need work logging.

#### 2. Legacy Jira REST API (Unscoped Token)

Jira API is used with `pr` and `review` commands.

This uses the Unscoped API token (Aka Legacy API token) method with REST API v2.

A legacy token can be acquired from `Atlassian Account Settings -> Security -> Create and manage API tokens -> [Create API token without scopes]`.

Example configuration setting up JIRA integration using a legacy API token for both `review` and `pr` commands.
Make sure you use your actual company domain in `baseUrl` and your personal legacy `token`.

**Environment Variables Support:**

For better security, you can set the JIRA username and token using environment variables instead of placing them in the configuration file:

- `JIRA_USERNAME`: Your JIRA username (e.g., `user@yourcompany.com`).
- `JIRA_LEGACY_API_TOKEN`: Your JIRA legacy API token.

If these environment variables are set, they will take precedence over the values in the configuration file.

JSON:

```json
{
  "llm": { "type": "vertexai", "model": "gemini-2.5-pro" },
  "requirementSource": "jira-legacy",
  "requirementSourceConfig": {
    "jira-legacy": {
      "username": "username@yourcompany.com",
      "token": "YOUR_JIRA_LEGACY_TOKEN",
      "baseUrl": "https://yourcompany.atlassian.net/rest/api/2/issue/"
    }
  }
}
```

JavaScript:

```javascript
export async function configure() {
  const google = await import('@langchain/google/node');
  return {
    llm: new google.ChatGoogle({
      model: 'gemini-2.5-pro',
      vertexai: true,
    }),
    requirementSource: 'jira-legacy',
    requirementSourceConfig: {
      'jira-legacy': {
        username: 'username@yourcompany.com', // Your Jira username/email
        token: 'YOUR_JIRA_LEGACY_TOKEN', // Replace with your real Jira API token
        baseUrl: 'https://yourcompany.atlassian.net/rest/api/2/issue/', // Your Jira instance base URL
      },
    },
  };
}
```

## Development Tools Configuration

The `code` / `exec` commands (and `ask --write`) can run development tools, configured under the
unified [`builtInTools`](#built-in-tools-builtintools) registry (in 1.x this was a separate
per-command `devTools` key, now removed — see [Migration](MIGRATION.md)).

The dev-command tools are defined in `src/tools/GthDevToolkit.ts`; each is configured with a
`{ "command": "…" }` object:

- **run_tests**: Executes the full test suite.
- **run_single_test**: Runs a single test file. The test path must be relative.
- **run_lint**: Runs the linter, potentially with auto-fix.
- **run_build**: Builds the project.

These tools execute the configured shell commands and capture their output.

Example configuration including dev tools (from .gsloth.config.json):

```json
{
  "llm": {
    "type": "xai",
    "model": "grok-4-0709"
  },
  "commands": {
    "code": {
      "filesystem": "all",
      "builtInTools": {
        "run_build": { "command": "npm build" },
        "run_tests": { "command": "npm test" },
        "run_lint": { "command": "npm run lint-n-fix" },
        "run_single_test": { "command": "npm test" }
      }
    }
  }
}
```

Note: For `run_single_test`, the command can include a placeholder like `${testPath}` for the test file path.
Security validations are in place to prevent path traversal or injection.

### General-purpose shell tool (`run_shell_command`)

`run_shell_command` lets the agent run arbitrary shell commands it composes itself. It is **ON by
default in `code` mode** (each invocation still gated behind a per-command human-approval prompt),
and OFF in `exec` / `ask --write` unless enabled. Configure it via its `builtInTools` entry:

- `true` / `false` — enable / force-disable (an object without `enabled` also defaults ON in `code`).
- `timeout` — per-command wall-clock limit in **milliseconds** (default `120000`).
- `maxOutputBytes` — byte budget for the captured output returned to the model (default `100000`).
- `allowlist` — master switch for the scoped approval allow-list (default `true`).
- `persistAllowlist` — persist `always`-scoped approvals to `.gsloth/.gsloth-settings/shell-allowlist.json` (default `true`).
- `judge` — the LLM-as-judge safety gate (default OFF): `true`, or `{ "enabled": true, "autoApproveLow": true, "blockHigh": false, "model": { … } }`.
- `yolo` — opt out of the per-command approval prompt (dangerous; off by default).

A hardcoded blocklist of catastrophic commands is always refused, even under `yolo`.

```json
{
  "commands": {
    "code": {
      "filesystem": "all",
      "builtInTools": {
        "gth_checklist": true,
        "run_shell_command": {
          "timeout": 300000,
          "maxOutputBytes": 200000,
          "judge": { "enabled": true, "blockHigh": true }
        }
      }
    }
  }
}
```

## Custom Tools Configuration

Custom tools allow you to define custom shell commands that the AI can execute across all commands or specific commands. Unlike development tools (which are predefined and code-specific), custom tools are fully user-defined and can be used for any purpose: deployment, migration, testing, automation, or any other shell command you need.

### Key Features

- **Available Globally**: Custom tools work in ALL commands (`pr`, `review`, `code`, `ask`, `chat`) by default
- **Per-Command Control**: Each command can override or disable custom tools
- **Parameter Support**: Commands can accept dynamic parameters with security validation
- **Security**: Built-in validation prevents shell injection, directory traversal, and other attacks

### Basic Configuration

Define custom tools at the root level to make them available across all commands:

```json
{
  "llm": {
    "type": "vertexai",
    "model": "gemini-2.5-pro"
  },
  "customTools": {
    "deploy_staging": {
      "command": "npm run deploy:staging",
      "description": "Deploy the application to staging environment"
    },
    "run_e2e_tests": {
      "command": "npm run test:e2e",
      "description": "Run end-to-end tests"
    }
  }
}
```

### Custom Tools with Parameters

Custom tools can accept parameters that are validated for security:

```json
{
  "customTools": {
    "run_migration": {
      "command": "npm run migrate -- ${migrationName}",
      "description": "Run a specific database migration",
      "parameters": {
        "migrationName": {
          "description": "Name of the migration to run"
        }
      }
    },
    "docker_build": {
      "command": "docker build -t ${imageName}:${tag} .",
      "description": "Build Docker image with specified name and tag",
      "parameters": {
        "imageName": {
          "description": "Name of the Docker image"
        },
        "tag": {
          "description": "Tag for the Docker image"
        }
      }
    }
  }
}
```

### Custom Tools with Timeout

Custom tools can have an optional timeout (in seconds). If the command exceeds this duration it is killed:

```json
{
  "customTools": {
    "deploy_staging": {
      "command": "npm run deploy:staging",
      "description": "Deploy to staging environment",
      "timeout": 120
    }
  }
}
```

When omitted, no timeout is applied.

**Parameter Interpolation:**

- Use `${parameterName}` placeholders in commands
- If no placeholders exist, parameters are appended in definition order
- All parameters are validated to prevent security issues

### Per-Command Configuration

You can override or disable custom tools for specific commands:

**Override for specific command:**

```json
{
  "customTools": {
    "deploy": {
      "command": "npm run deploy:prod",
      "description": "Deploy to production"
    }
  },
  "commands": {
    "pr": {
      "customTools": {
        "deploy": {
          "command": "npm run deploy:staging",
          "description": "Deploy to staging for PR review"
        }
      }
    }
  }
}
```

**Disable for specific command:**

```json
{
  "customTools": {
    "deploy": {
      "command": "npm run deploy",
      "description": "Deploy application"
    }
  },
  "commands": {
    "review": {
      "customTools": false
    }
  }
}
```

**Note:** When a command defines its own `customTools`, it completely replaces the root-level tools for that command (no merging).

### Custom Tools vs Development Tools

| Feature          | Custom Tools                | Dev Tools                                 |
| ---------------- | --------------------------- | ----------------------------------------- |
| **Location**     | Root-level `customTools`    | `builtInTools` registry (root or command) |
| **Availability** | All commands                | `code` / `exec` (and `ask --write`)       |
| **Purpose**      | User-defined shell commands | Predefined build/test/lint + shell tools  |
| **Per-Command**  | Yes                         | Yes (via `commands.<cmd>.builtInTools`)   |
| **Parameters**   | Yes                         | Limited (run_single_test only)            |

Both can be used together:

```json
{
  "customTools": {
    "deploy": {
      "command": "npm run deploy",
      "description": "Deploy application"
    }
  },
  "commands": {
    "code": {
      "filesystem": "all",
      "builtInTools": {
        "run_tests": { "command": "npm test" },
        "run_lint": { "command": "npm run lint-n-fix" }
      }
    }
  }
}
```

### Security Validation

All custom tool parameters are automatically validated to prevent:

- **Shell injection**: Blocks `|`, `&`, `;`, `` ` ``, `$`, `$(`, newlines
- **Directory traversal**: Blocks `..`, `/../`, `\..\\`
- **Absolute paths**: Only relative paths allowed
- **Null bytes**: Blocks `\0` characters

Example of a secure custom tool that accepts a file path:

```json
{
  "customTools": {
    "process_file": {
      "command": "node scripts/process.js ${filePath}",
      "description": "Process a file in the project",
      "parameters": {
        "filePath": {
          "description": "Relative path to the file to process"
        }
      }
    }
  }
}
```

### Complete Example

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "customTools": {
    "deploy_staging": {
      "command": "npm run deploy:staging",
      "description": "Deploy to staging environment"
    },
    "run_migration": {
      "command": "npm run migrate -- ${name}",
      "description": "Run a database migration",
      "parameters": {
        "name": {
          "description": "Migration name"
        }
      }
    }
  },
  "commands": {
    "pr": {
      "customTools": {
        "validate_pr": {
          "command": "npm run validate:pr",
          "description": "Run PR validation checks"
        }
      }
    },
    "review": {
      "customTools": false
    },
    "code": {
      "filesystem": "all",
      "builtInTools": {
        "run_tests": { "command": "npm test" },
        "run_lint": { "command": "npm run lint-n-fix" }
      }
    }
  }
}
```

#### Skipping Validation Checks with `allow`

Some parameters legitimately require values that would normally be blocked by validation.
For example, deploying to a hardware device via `/dev/ttyUSB0` requires an absolute path.
The `allow` property on individual parameters lets you specify which checks to skip:

```json
{
  "customTools": {
    "deploy_lesson": {
      "command": "mpremote connect ${usbDevice} fs cp ${lesson} :main.py",
      "description": "Deploy lesson to the robot.",
      "parameters": {
        "usbDevice": {
          "description": "USB device of robot. Use `/dev/ttyUSB0` unless advised to use other device.",
          "allow": ["absolute-paths"]
        },
        "lesson": {
          "description": "Lesson to deploy, for example `fixed/lesson2/Move_Forward.py`"
        }
      }
    }
  }
}
```

In this example, only the `usbDevice` parameter allows absolute paths, while `lesson` is still validated normally.

Available `allow` values:

| Value                 | What it permits                                      |
| --------------------- | ---------------------------------------------------- |
| `absolute-paths`      | Absolute paths like `/dev/ttyUSB0` or `/usr/bin/env` |
| `directory-traversal` | Path components containing `..`                      |
| `shell-injection`     | Shell metacharacters (`\|`, `&`, `;`, etc.)          |
| `null-bytes`          | Null byte characters                                 |

Checks **not** listed in `allow` remain enforced. Each parameter can have its own `allow` list, providing fine-grained control over validation.

## Middleware Configuration

Gaunt Sloth supports middleware to intercept and control agent execution at critical points. Middleware provides hooks for cost optimization, conversation management, and custom logic.

### Predefined Middleware

There are two predefined middleware types available:

#### Anthropic Prompt Caching Middleware

Reduces API costs by caching prompts (Anthropic models only):

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "middleware": ["anthropic-prompt-caching"]
}
```

With custom TTL configuration:

```json
{
  "middleware": [
    {
      "name": "anthropic-prompt-caching",
      "ttl": "5m"
    }
  ]
}
```

TTL options: `"5m"` (5 minutes) or `"1h"` (1 hour)

#### Summarization Middleware

Automatically condenses conversation history when approaching token limits:

```json
{
  "middleware": ["summarization"]
}
```

With custom configuration:

```json
{
  "middleware": [
    {
      "name": "summarization",
      "maxTokensBeforeSummary": 8000,
      "messagesToKeep": 5
    }
  ]
}
```

Configuration options:

- `maxTokensBeforeSummary`: Maximum tokens before triggering summarization (default: 10000)
- `messagesToKeep`: Number of recent messages to keep after summarization
- `summaryPrompt`: Custom prompt template for summarization
- `model`: Custom model for summarization (defaults to main LLM)

### Multiple Middleware

You can combine multiple middleware:

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "middleware": [
    "anthropic-prompt-caching",
    {
      "name": "summarization",
      "maxTokensBeforeSummary": 12000
    }
  ]
}
```

### Custom Middleware (JavaScript Config Only)

Custom middleware objects are only available in JavaScript configurations. Always wrap them with LangChain's `createMiddleware` to include the required `MIDDLEWARE_BRAND` marker—plain objects/functions will be rejected by the registry.

```javascript
// .gsloth.config.mjs
import { createMiddleware } from 'langchain';

const requestLogger = createMiddleware({
  name: 'request-logger',
  beforeModel: (state) => {
    // Custom logic before model execution
    console.log('Processing request...');
    return state;
  },
  afterModel: (state) => {
    // Custom logic after model execution
    console.log('Model completed');
    return state;
  },
});

export async function configure() {
  const anthropic = await import('@langchain/anthropic');

  return {
    llm: new anthropic.ChatAnthropic({
      model: 'claude-sonnet-4-5',
    }),
    middleware: ['summarization', requestLogger],
  };
}
```

## Tool Allow-List (allowedTools)

`allowedTools` restricts an agent to an explicit allow-list of tool names. It is applied after
every tool source (filesystem, built-in, custom, MCP, A2A and `tools`) has been resolved, so it is
the only knob that can gate individual MCP and A2A tools (e.g. `mcp__jira__getJiraIssue`), which
have no per-source override of their own.

- **omitted or `undefined`**: no filtering, all resolved tools remain available
- **non-empty array**: only tools whose name is in the list remain available
- **empty array `[]`**: every tool is disabled; MCP servers are not even contacted (no OAuth),
  which suits agents that only need to reason over the provided prompt, such as review agents

> **Important:** `allowedTools: []` is not the same as omitting `allowedTools`. Use `[]` only
> when you intentionally want a tool-free agent and want to skip MCP/A2A tool discovery. Remove
> the property, or leave it `undefined` in JavaScript config, when you want all configured tools
> to remain available.

It can be set at the top level or per command via `commands.<command>.allowedTools` (the command
value takes precedence):

```json
{
  "commands": {
    "review": { "allowedTools": [] },
    "pr": { "allowedTools": [] }
  }
}
```

## Change Requirements Discovery Configuration

Running `gth pr` without positional arguments triggers change requirements discovery (see [COMMANDS.md](COMMANDS.md#change-requirements-discovery)).
Discovery only runs when neither `prId` nor `requirementsId` is provided; requirements-only syntax
such as `gth pr PROJ-123` is unsupported. It is configured under `commands.pr.discovery`:

- **`enabled`** (boolean, default: `true`): Allow `gth pr` without arguments to trigger change requirements discovery
- **`deterministicDiff`** (boolean, default: `true`): Fetch the current-branch PR diff with
  `gh pr diff` before invoking the discovery agent
- **`filesystem`**, **`builtInTools`**, **`customTools`**, **`tools`**: Tool overrides applied
  only while the discovery agent runs; when omitted, the discovery agent falls back to the
  **top-level** values for these settings, not the `commands.pr.*` ones. The `commands.pr.*` tool
  overrides apply to the review agent only — the discovery agent does not inherit them, so set its
  tools here under `commands.pr.discovery` (or top-level) if it needs anything beyond the defaults
- **`allowedTools`** (string[]): Allow-list of tool names for the discovery agent, applied after
  all tools are resolved. `set_requirements` is always retained so the agent can record what it
  found; an empty array keeps only `set_requirements`, filtering out every other tool. Note that
  because `set_requirements` is always retained, this allow-list never disables tool resolution
  itself — unlike the top-level `allowedTools: []`, configured MCP/A2A servers are still contacted
  (potentially triggering OAuth) before their tools are filtered out. Omit the property for no
  filtering. The discovery agent never inherits the top-level `allowedTools`; this property is its
  only allow-list.

The discovery agent always has the discovery helper tools `gh_pr`, `gh_diff`, `gh_issue`,
`set_diff` and `set_requirements` available (subject to `allowedTools`). `gh_diff` stores the
fetched diff directly as the review diff; `set_diff` exists for diffs assembled some other way.

A minimal, tight configuration for GitHub-issue-based requirements:

```json
{
  "commands": {
    "pr": {
      "allowedTools": [],
      "discovery": {
        "allowedTools": ["gh_pr", "gh_diff", "gh_issue"]
      }
    }
  }
}
```

The discovery agent's prompt can be replaced by placing a `.gsloth.pr-discovery.md` file in
`.gsloth/.gsloth-settings/` (or the project root when not using the `.gsloth` directory), or in an
identity profile directory, the same way as other prompts.

## Review Rating Configuration

The `review` and `pr` commands **automatically provide** automated review scoring with configurable pass/fail thresholds. **Rating is enabled by default** - the AI concludes every review with a numerical rating (0-10) and a comment explaining the rating.

### Rating Scale

- **0-2**: Bad code with syntax errors or critical issues (equivalent to REJECT)
- **3-5**: Code needs significant changes (equivalent to REQUEST_CHANGES)
- **6-10**: Code is acceptable (equivalent to APPROVE)

### Default Behavior

**Out of the box, without any configuration:**

- ✅ Rating is **enabled**
- ✅ Pass threshold is **6/10**
- ✅ Failed reviews (< 6) **exit with code 1** for CI/CD integration

### Configuration Options

You can customize rating behavior for `review` and `pr` commands under `commands.review.rating` or `commands.pr.rating`:

- **`enabled`** (boolean, default: `true`): Enable or disable review rating
- **`passThreshold`** (number 0-10, default: `6`): Minimum score required to pass the review
- **`minRating`** (number, default: `0`): Lower bound for the rating scale
- **`maxRating`** (number, default: `10`): Upper bound for the rating scale
- **`errorOnReviewFail`** (boolean, default: `true`): Exit with error code 1 when review fails (below threshold)

### Example Configurations

**Default configuration (no config needed):**

Rating works out of the box with no configuration required! The defaults provide sensible CI/CD integration.

**Disable rating:**

```json
{
  "commands": {
    "review": {
      "rating": {
        "enabled": false
      }
    }
  }
}
```

**Custom threshold:**

```json
{
  "commands": {
    "review": {
      "rating": {
        "passThreshold": 8
      }
    }
  }
}
```

**Different thresholds for review and PR:**

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "commands": {
    "review": {
      "rating": {
        "enabled": true,
        "passThreshold": 6,
        "errorOnReviewFail": true
      }
    },
    "pr": {
      "rating": {
        "enabled": true,
        "passThreshold": 7,
        "errorOnReviewFail": true
      }
    }
  }
}
```

**Rating without failing the build:**

```json
{
  "commands": {
    "review": {
      "rating": {
        "enabled": true,
        "passThreshold": 6,
        "errorOnReviewFail": false
      }
    }
  }
}
```

### Output Format

When rating is enabled, the review will conclude with a clearly formatted rating section:

```
============================================================
REVIEW RATING
============================================================
PASS 8/10 (threshold: 6)

Comment: Code quality is good with minor improvements needed.
Well-structured and follows best practices.
============================================================
```

For failing reviews:

```
============================================================
REVIEW RATING
============================================================
FAIL 4/10 (threshold: 6)

Comment: Significant issues found requiring refactoring
before this code can be merged.
============================================================
```

### CI/CD Integration

When `errorOnReviewFail` is set to `true` (default), failed reviews will exit with code 1, which will fail CI/CD pipeline steps. This is useful for enforcing code quality standards in automated workflows.

Example usage in GitHub Actions:

```yaml
- name: Run code review
  run: gsloth review -f changed-files.diff
  # This step will fail if rating is below threshold
```

## A2A (Agent-to-Agent) Protocol Support (Experimental)

> **Note:** A2A support is an experimental feature and may change in future releases.

Gaunt Sloth supports the [A2A protocol](https://google.github.io/A2A/) for connecting to external AI agents. This allows delegating tasks to specialized agents.

### Configuration

Add `a2aAgents` to your configuration file:

```json
{
  "llm": {
    "type": "YOUR_PROVIDER",
    "model": "MODEL_OF_YOUR_CHOICE"
  },
  "a2aAgents": {
    "myAgent": {
      "agentId": "my-agent-id",
      "agentUrl": "http://localhost:8080/a2a"
    }
  }
}
```

Each agent becomes available as a tool named `a2a_agent_<agentId>` in `chat` and `code` commands.

See [examples/a2a](../examples/a2a) for a working example.

## Server Tools Configuration

Some AI providers provide integrated server tools, such as web search.

**.gsloth.config.json for OpenAI Web Search**

```json
{
  "llm": {
    "type": "openai",
    "model": "gpt-4o"
  },
  "tools": [{ "type": "web_search_preview" }]
}
```

**.gsloth.config.json for Anthropic Web Search**

```json
{
  "llm": {
    "type": "anthropic",
    "model": "claude-sonnet-4-5"
  },
  "tools": [
    {
      "type": "web_search_20250305",
      "name": "web_search",
      "max_uses": 10
    }
  ]
}
```
