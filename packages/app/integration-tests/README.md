# Gaunt Sloth Integration Tests

This directory contains integration tests for the Gaunt Sloth CLI tool.

## Directory Structure

```
integration-tests/
├── workdir/                      # Test working directory (all tests run here)
│   ├── .gsloth.config.json      # Config copied by setup-config.js
│   ├── .gsloth.guidelines.md    # Test guidelines
│   ├── .gsloth.review.md        # Test review config
│   ├── .aiignore                 # Aiignore patterns for tests
│   ├── glob-aiignore/            # Fixture pair for the .aiignore glob case; both files asserted
│   ├── filewithgoodcode.js      # Test data: good code example
│   ├── filewithbadcode.js       # Test data: bad code example
│   ├── image.png, image2.png    # Test data: binary images
│   └── gth_*.md                  # Session files (created during tests)
├── workdir-with-profiles/       # Profile tests working directory
├── configs/                      # Config templates for different providers
├── support/                      # Test helper utilities
│   ├── commandRunner.ts         # Helper to run CLI commands
│   ├── outputChecker.ts         # Helper to verify output content
│   └── reviewScoreExtractor.ts  # Helper to extract review scores
├── setup-config.js              # Setup script (copies config to workdir)
└── *.it.ts                       # Integration test files
```

**Important**: All integration tests (except profile tests) run from `workdir/` as their working directory. Test data and configuration files should only be placed in `workdir/`, not in the integration-tests root.

## Test tiers (model-size floor)

A test's filename carries a **tier** — the *smallest model class expected to pass it*, i.e. its
complexity floor. The tier is **orthogonal to the model you run it against**: it only selects *which*
tests run; the *model* is chosen by the provider config. Any provider can run any tier — a frontier
model trivially passes the easy tiers.

- **`*.xx-small.it.ts`** — passes on a small local model (gemma via ollama). The fast, free iteration
  loop; also the local pre-merge gate. Cheap, few tokens, CI-matrix-able.
- **`*.small.it.ts`** — needs a stronger cheap model (gpt-oss-120b, e.g. the `groq` config).
  *Reserved — no existing test carries it yet.*
- **untagged `*.it.ts`** — frontier tests that need a full cloud model.

Selection is a plain vitest filename-substring filter, and the tier names nest (`xx-small` is a
substring of `small`), so a filter runs *that tier and everything cheaper*:

```bash
pnpm run it ollama xx-small     # the local-gemma fast loop (see "Local ollama" below)
pnpm run it groq small          # runs small + xx-small on gpt-oss-120b
pnpm run it anthropic           # no filter → everything, including frontier
```

An `x-small` tier (a mid model such as gemma-31b) can be reintroduced the day a test needs a floor
*between* xx-small and small — nothing does today, so the scale stays at two named tiers.

### Config names are file names, not provider types

The argument after `pnpm run it` names a file in `configs/`, so one provider can have several
entries pinning different models — `xai` and `xai-build`, `google-genai` and
`google-genai-flash-lite`. Any new name must be added to `setup-config.js`'s `validConfigs`, which
exits 1 on an unknown name before vitest starts.

### The `openai` config pins minimal reasoning effort

`configs/openai.gsloth.config.json` sets `llm.reasoning.effort` to `minimal`, and it must keep it.
On `gpt-5-mini` a strict `json_schema` request whose schema has a nullable inside an array item can
enter an unterminated constrained decode: the model emits closing punctuation for ever, no HTTP
response is ever produced, and the call dies at whatever budget the caller set. It is probabilistic
— roughly four attempts in five on that shape at default effort — so it reads as provider flakiness
rather than as anything reproducible. `minimal` is the only setting measured to remove it.

Reasoning effort is a generation setting: it cannot change the schema that is sent, so it does not
weaken what `structuredOutput.xx-small.it.ts` guards on this provider (a request the API rejects for
leaving an optional key out of `required`). It does apply to **every** openai case, because a config
here is per provider and the openai leg runs unfiltered as `BIG_TEST_PROVIDER`.

### Two kinds of test live here

Most tests **spawn the real CLI** through `support/commandRunner.ts` and assert on its output and
exit code. A few instead **call a runtime function directly** against the configured provider, for
code that has no CLI entry point or that a verb only reaches indirectly:

- `providerContract.it.ts` **pins** one vendor's config, because it targets that vendor's contract.
- `structuredOutput.xx-small.it.ts` uses the **ambient** provider — whichever
  `pnpm run it <provider>` selected — so one file exercises every model in every matrix. It skips
  cleanly when the ambient provider's key is absent, and prints a line saying which provider it
  resolved and whether it ran, because a silent skip exits 0 and reads exactly like a pass.

### Local ollama (free, no API key)

`pnpm run it ollama <tier>` drives a **local ollama** model — no API key, runs anywhere ollama is up.
The model is an independent axis via `OLLAMA_IT_MODEL` (default `gemma4:12b`):

```bash
pnpm run it ollama xx-small                              # gemma4:12b
OLLAMA_IT_MODEL=gemma4:31b pnpm run it ollama xx-small   # same tests, a bigger local model
```

If the ollama daemon (or the requested model tag) isn't present, the ollama run **SKIPs and exits 0**
— so it is safe to run on any box, including one without a GPU.

## Running the Tests

To run the integration tests:

1. Make sure you have an Anthropic, VertexAI or Groq API key set in your environment:
   ```
   export ANTHROPIC_API_KEY=your-api-key
   ```

2. Build

  ```
  pnpm run build
  ```

3. Navigate to the project root directory and run:
   ```
   pnpm run it anthropic
   ```

Or `pnpm run it vertexai` or `pnpm run it groq small`, or — free and key-less —
`pnpm run it ollama xx-small` against a local gemma (see "Test tiers" above).

please note if you are on free tier of Groq review and PR tests are likely to fail,
because tokens limit has been hit.

   Or run a specific test file:
   ```
   pnpm run it anthropic askCommand.it.ts
   pnpm run it anthropic reviewCommand.it.ts
   pnpm run it anthropic prCommand.it.ts
   ```

## Working Directory

All integration tests run from the `workdir/` subdirectory as their current working directory. This means:

- Configuration files are loaded from `workdir/.gsloth.config.json`
- Test data files are read from `workdir/`
- Session files (`gth_*.md`) are created in `workdir/`
- File operations in tests are relative to `workdir/`

The `setup-config.js` script automatically copies the selected provider config to `workdir/.gsloth.config.json` before running tests.

## Adding New Tests

When adding new integration tests:

1. **Test code** (`.it.ts` files) goes in the `integration-tests/` root
2. **Test data** files go in `integration-tests/workdir/`
3. Use `runCommandWithArgs()` or `runCommandExpectingExitCode()` from `support/commandRunner.ts` without specifying a workdir parameter (it defaults to `workdir/`)
4. For profile-specific tests, use `PROFILES_WORKDIR` constant pointing to `workdir-with-profiles/`

## Notes

- PR tests require the GitHub CLI to be installed and authenticated
- Some tests use real GitHub PRs and issues for testing
- The tests expect specific responses from the AI based on the content
- Test data files in `workdir/` are used for code review and file operation tests
- Session files created during tests are automatically cleaned up by the next test run
