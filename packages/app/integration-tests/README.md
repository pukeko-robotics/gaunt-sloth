# Gaunt Sloth Assistant Integration Tests

This directory contains integration tests for the Gaunt Sloth Assistant CLI tool.

## Directory Structure

```
integration-tests/
├── workdir/                      # Test working directory (all tests run here)
│   ├── .gsloth.config.json      # Config copied by setup-config.js
│   ├── .gsloth.guidelines.md    # Test guidelines
│   ├── .gsloth.review.md        # Test review config
│   ├── .aiignore                 # Aiignore patterns for tests
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

## Test Structure

Some tests intentionally contain `simple` in their name to indicate that fast models with lower intelligence, such as mercury, can run them without failing. Moreover, they take fewer tokens, which means they may be run in CI matrix.

```bash
npm run it inception simple
```

```bash
npm run it groq simple
```

## Running the Tests

To run the integration tests:

1. Make sure you have an Anthropic, VertexAI or Groq API key set in your environment:
   ```
   export ANTHROPIC_API_KEY=your-api-key
   ```

2. Build

  ```
  npm run build
  ```

3. Navigate to the project root directory and run:
   ```
   npm run it anthropic
   ```

Or `npm run it vertexai` or `npm run it groq simple`,

please note if you are on free tier of Groq review and PR tests are likely to fail,
because tokens limit has been hit.

   Or run a specific test file:
   ```
   npm run it anthropic askCommand.it.ts
   npm run it anthropic reviewCommand.it.ts
   npm run it anthropic prCommand.it.ts
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
