# @gaunt-sloth/review

Review and question-answering functionality for Gaunt Sloth.

## Installation

This package does not include any AI provider packages. This is by design to
keep the install minimal and avoid pulling in providers you don't use. Install
the review package together with the provider required by your configuration:

```bash
# OpenRouter / OpenAI
npm install -g @gaunt-sloth/review @langchain/openai

# Google (Vertex AI / AI Studio)
npm install -g @gaunt-sloth/review @langchain/google

# Anthropic
npm install -g @gaunt-sloth/review @langchain/anthropic

# Groq
npm install -g @gaunt-sloth/review @langchain/groq
```

See [`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) for the full list of supported providers.

## Contents

- Review module (`reviewModule`) — diff and content review orchestration
- Question answering module (`questionAnsweringModule`)
- Command utilities (`commandUtils`)
- Content and requirement sources: `file`, `text`, `ghPrDiff`, `ghIssue`, `jiraIssue`, `jiraIssueLegacy`
- Jira client
- Review rate middleware

## CLI

The package ships a standalone binary `gaunt-sloth-review` for CI-friendly reviews that does not depend on `commander`. This makes it suitable for embedding in pipelines where a minimal footprint is preferred.

```bash
gaunt-sloth-review <pr-number> [requirement-ids...]
gaunt-sloth-review --version
```

### Identity profiles

To use a different config profile (e.g. separate provider/auth for CI vs local),
set the `GSLOTH_IDENTITY_PROFILE` environment variable:

```bash
GSLOTH_IDENTITY_PROFILE=review gaunt-sloth-review 123
```

This loads config from `.gsloth-settings/review/` instead of the default
`.gsloth/` directory. Useful when CI uses different credentials or a different
LLM provider than local development.

## Dependencies

- `@gaunt-sloth/core` (required)

No MCP, no A2A, no commander. This is intentional to keep the package lightweight for CI use.

## Exports

```js
import { reviewModule } from '@gaunt-sloth/review/reviewModule.js';
import { questionAnsweringModule } from '@gaunt-sloth/review/questionAnsweringModule.js';
import { commandUtils } from '@gaunt-sloth/review/commandUtils.js';
```

## Related packages

- [`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) — Core utilities, config, and agent infrastructure ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/core))
- [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent) — Agent runtime: built-in tools, filesystem toolkit, middleware registry, API server, AG-UI, MCP, and A2A integration ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/agent))
- [`@gaunt-sloth/review`](https://www.npmjs.com/package/@gaunt-sloth/review) — Review and Q&A modules with standalone CLI (this package) ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/review))
- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — Batch / eval / workflow runtime ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
