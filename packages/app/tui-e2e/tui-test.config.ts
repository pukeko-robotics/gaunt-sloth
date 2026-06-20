import { defineConfig } from '@microsoft/tui-test';

/**
 * PTY end-to-end config for the Ink TUI (Phase 2a Stage D). Tests live beside this file and
 * drive the real `gth chat` binary in a pseudo-terminal, fed by the deterministic fixture
 * agent (see `src/tui/fixtureAgent.ts`) so runs are hermetic and key-free. Kept entirely
 * separate from the vitest unit suite, which only globs the `spec` directories.
 */
export default defineConfig({
  testMatch: '**/*.tui.test.ts',
  // Streaming-TUI timing varies on slow CI; give async expect-poll room and retry once there.
  timeout: 30_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
});
