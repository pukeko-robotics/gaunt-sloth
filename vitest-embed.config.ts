import { defineConfig } from 'vitest/config';

// Embed e2e: packs the published tarballs and installs them into a temp-dir consumer
// OUTSIDE the workspace, then exercises the documented embed surface (see
// packages/review/embed-e2e/). Run via `pnpm run test:embed`. Kept out of the unit run
// because pack + npm install takes well over the unit suite's timeout budget.
export default defineConfig({
  test: {
    include: ['packages/*/embed-e2e/**/*.e2e.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 1000 * 60 * 5,
    hookTimeout: 1000 * 60 * 5,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
