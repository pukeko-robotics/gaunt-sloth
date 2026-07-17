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
 * Packages are scanned in dependency order: core → agent → review → batch → app.
 * The review package has re-export stubs that delegate to core; those are
 * detected and skipped so the canonical core module is always used.
 */
function resolveWorkspaceImports() {
  return {
    name: 'resolve-workspace-imports',
    enforce: 'pre' as const,

    resolveId(id: string, _importer: string | undefined): any {
      // Resolve a base path (no extension) to a .ts or .tsx source file if present.
      // .tsx support is required for the Ink TUI components in `gaunt-sloth`.
      const resolveSource = (base: string): string | undefined => {
        for (const ext of ['.ts', '.tsx']) {
          if (existsSync(base + ext)) return base + ext;
        }
        return undefined;
      };

      // Handle #src/ imports -> find the actual source in packages
      if (id.startsWith('#src/')) {
        const relative = id.replace('#src/', '').replace(/\.js$/, '');

        // Try each package in dependency order
        for (const pkg of ['core', 'agent', 'review', 'batch', 'app']) {
          const found = resolveSource(resolve(__dirname, `packages/${pkg}/src/${relative}`));
          if (found) {
            // Skip re-export stubs (files that just re-export from @gaunt-sloth/)
            // by preferring the canonical core module when review only re-exports it.
            if (pkg === 'review') {
              const corePath = resolveSource(resolve(__dirname, `packages/core/src/${relative}`));
              if (corePath) {
                return corePath;
              }
            }
            return found;
          }
        }
      }

      // Handle @gaunt-sloth/X/path.js -> packages/X/src/path.{ts,tsx}
      const scopedMatch = id.match(/^@gaunt-sloth\/(core|agent|review|batch)\/(.+)\.js$/);
      if (scopedMatch) {
        const [, pkg, path] = scopedMatch;
        return resolveSource(resolve(__dirname, `packages/${pkg}/src/${path}`));
      }
    },
  };
}

export default defineConfig({
  plugins: [resolveWorkspaceImports()],
  // Ink .tsx components/specs compile via vitest's default transformer (oxc), which uses
  // the React 19 automatic JSX runtime out of the box; no extra jsx config needed.
  test: {
    include: ['packages/*/spec/**/*.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    globals: true,
    testTimeout: 10000,
  },
});
