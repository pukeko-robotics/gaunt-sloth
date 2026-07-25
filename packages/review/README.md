# @gaunt-sloth/review

The review engine behind `gth review` / `gth pr`, packaged for embedding: run an AI code review
programmatically from your own tool or pipeline, or via the standalone `gaunt-sloth-review`
binary. Also contains the content/requirement sources (GitHub, local git diff, Jira, file, text) that feed it.

**When to depend on this package** — you want review results inside your own process or a
minimal CI job. It has no dependency on `commander`, MCP, or A2A, so the install stays small.
If you want the interactive CLI (chat/code sessions, TUI, MCP tools), install the fat
[`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) app instead — it wires this same
module into `gth review` and `gth pr`.

## Installation

AI providers are not bundled (they are optional peer dependencies of
[`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core)); install the one your
config uses:

```bash
# OpenRouter / OpenAI
npm install @gaunt-sloth/review @langchain/openai

# Google (Vertex AI / AI Studio)
npm install @gaunt-sloth/review @langchain/google

# Anthropic
npm install @gaunt-sloth/review @langchain/anthropic

# Groq
npm install @gaunt-sloth/review @langchain/groq
```

## Embedding: review a diff programmatically

I want to run a Gaunt Sloth review over a diff from my own Node script and fail the build on a
bad rating. Create `.gsloth.config.json` next to the script:

```json
{
  "llm": { "type": "anthropic", "model": "claude-sonnet-4-5" },
  "commands": {
    "review": { "rating": { "enabled": true, "passThreshold": 6 } }
  }
}
```

Then run a review over a diff (`node review-diff.mjs change.diff`):

```js
// review-diff.mjs
import { readFileSync } from 'node:fs';
import { initConfig } from '@gaunt-sloth/core/config.js';
import {
  readBackstory,
  readGuidelines,
  readReviewInstructions,
} from '@gaunt-sloth/core/utils/llmUtils.js';
import { review } from '@gaunt-sloth/review';

const config = await initConfig({}); // loads .gsloth.config.* from the working directory
const preamble = [readBackstory(config), readGuidelines(config), readReviewInstructions(config)]
  .filter(Boolean)
  .join('\n');
const diff = readFileSync(process.argv[2], 'utf8');

await review('embedded-review', preamble, diff, config);
process.exit(process.exitCode ?? 0);
```

The review text is written to stdout. With rating enabled, `review()` sets `process.exitCode = 1`
when the rating comes back below `passThreshold` (or when the model fails to produce a rating),
so the script exits non-zero exactly when `gth review` would — that is the whole embed contract.
Configuration (provider, prompts, rating thresholds) is the standard Gaunt Sloth config, see
[the configuration guide](https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/configuration/index.md).

This exact flow is verified by the workspace embed e2e (`pnpm run test:embed`), which packs the
published tarballs and runs the snippet above from a temp-dir consumer against a stub model.

## Standalone CLI: `gaunt-sloth-review`

The package's one binary, for CI-friendly reviews with a minimal footprint:

```bash
gaunt-sloth-review 123          # review PR 123 (uses the configured content source, GitHub by default)
gaunt-sloth-review 123 45       # ...with requirements from issue 45
gaunt-sloth-review --version
```

### Identity profiles

To use a different config profile (e.g. separate provider/auth for CI vs local), set the
`GSLOTH_IDENTITY_PROFILE` environment variable:

```bash
GSLOTH_IDENTITY_PROFILE=review gaunt-sloth-review 123
```

This loads config from `.gsloth-settings/review/` instead of the default `.gsloth/` directory.
Useful when CI uses different credentials or a different LLM provider than local development.

## Exports

- `@gaunt-sloth/review` (the root export) is the public API: the review module (`review`,
  `ReviewContext`), `commandUtils`, and the `gh` read-file tool — plus, deliberately, the whole
  `@gaunt-sloth/core` config barrel (`initConfig`, `GthConfig`, `DEFAULT_CONFIG`, …), re-exported
  so an embedder can resolve config from the review root without importing core directly.
  This surface is what the embed example above and the fat CLI use.
- `@gaunt-sloth/review/<path>.js` deep paths (e.g.
  `@gaunt-sloth/review/modules/reviewModule.js`) mirror the package's internal `dist/` layout
  1:1 and are deliberately kept open for reach-in. They are supported at your own risk: internal
  files can move between alpha/minor versions without a deprecation cycle. Prefer the root
  export where it suffices.

## Related packages

- [`@gaunt-sloth/core`](https://www.npmjs.com/package/@gaunt-sloth/core) — Core utilities, config, and agent infrastructure ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/core))
- [`@gaunt-sloth/agent`](https://www.npmjs.com/package/@gaunt-sloth/agent) — Agent runtime: built-in tools, filesystem toolkit, middleware registry, API server, AG-UI, MCP, and A2A integration ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/agent))
- [`@gaunt-sloth/batch`](https://www.npmjs.com/package/@gaunt-sloth/batch) — Batch / eval / workflow runtime ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/batch))
- [`gaunt-sloth`](https://www.npmjs.com/package/gaunt-sloth) — Main CLI application ([source](https://github.com/pukeko-robotics/gaunt-sloth/tree/main/packages/app))
