import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vitest plugin that resolves #src/ and @gaunt-sloth/ imports to actual
 * source files in the workspace packages. This ensures that vi.mock() and
 * dynamic imports all resolve to the same module identity.
 *
 * Packages are scanned in dependency order: core → agent → tools → review → api → assistant.
 * The review package has re-export stubs that delegate to core; those are
 * detected and skipped so the canonical core module is always used.
 */
function resolveWorkspaceImports() {
  return {
    name: 'resolve-workspace-imports',
    enforce: 'pre' as const,

    resolveId(id: string, _importer: string | undefined): any {
      // Handle #src/ imports -> find the actual source in packages
      if (id.startsWith('#src/')) {
        const relative = id.replace('#src/', '').replace(/\.js$/, '.ts');

        // Try each package in dependency order
        for (const pkg of ['core', 'agent', 'review', 'assistant']) {
          const tsPath = resolve(__dirname, `packages/${pkg}/src/${relative}`);
          if (existsSync(tsPath)) {
            // Skip re-export stubs (files that just re-export from @gaunt-sloth/)
            // by checking if the file is a re-export stub in review
            if (pkg === 'review') {
              const corePath = resolve(__dirname, `packages/core/src/${relative}`);
              if (existsSync(corePath)) {
                return corePath;
              }
            }
            return tsPath;
          }
        }
      }

      // Handle @gaunt-sloth/X/path.js -> packages/X/src/path.ts
      const scopedMatch = id.match(/^@gaunt-sloth\/(core|agent|review)\/(.+)\.js$/);
      if (scopedMatch) {
        const [, pkg, path] = scopedMatch;
        const tsPath = resolve(__dirname, `packages/${pkg}/src/${path}.ts`);
        if (existsSync(tsPath)) return tsPath;
      }
    },
  };
}

export default defineConfig({
  plugins: [resolveWorkspaceImports()],
  test: {
    include: ['packages/*/spec/**/*.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    globals: true,
    testTimeout: 10000,
  },
});
