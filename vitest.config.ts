import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Workspace packages that expose a `src/` tree, listed in dependency order
 * (core → agent → review → batch → app), with the eval-reporter-* packages
 * last. This order is only the *fallback* scan order now (see
 * {@link resolveWorkspaceImports}); a real `#src/…` self-import resolves within
 * the importer's own package first, so the order no longer decides which of two
 * same-relative-path files a package under test sees.
 */
const WORKSPACE_PACKAGES = [
  'core',
  'agent',
  'review',
  'batch',
  'app',
  'eval-reporter-junit',
  'eval-reporter-teamcity',
] as const;

/**
 * Map an importer's absolute path to the workspace package it belongs to (the
 * `<pkg>` in `packages/<pkg>/…`), or `undefined` when the importer is not a
 * workspace-package file (a `node_modules` dep, the config itself, an unknown
 * caller). This is what makes `#src/…` resolution importer-aware: a self-import
 * is resolved within its OWN package first.
 */
export function packageOfImporter(importer: string | undefined): string | undefined {
  if (!importer) return undefined;
  const packagesRoot = resolve(__dirname, 'packages') + sep;
  if (!importer.startsWith(packagesRoot)) return undefined;
  const pkg = importer.slice(packagesRoot.length).split(sep)[0];
  return (WORKSPACE_PACKAGES as readonly string[]).includes(pkg) ? pkg : undefined;
}

/**
 * Vitest plugin that resolves #src/ and @gaunt-sloth/ imports to actual
 * source files in the workspace packages. This ensures that vi.mock() and
 * dynamic imports all resolve to the same module identity.
 *
 * A `#src/…` import is resolved **importer-aware**: it points at the importing
 * file's OWN workspace package first, then falls back to the fixed dependency-
 * order scan ({@link WORKSPACE_PACKAGES}) only when the importer can't be mapped
 * to a package. This matches how `tsc` resolves each package's own `#src/*`
 * `imports` map at build time. Before this, the resolver ignored the importer
 * and always returned the first package (in scan order) that happened to ship a
 * file at the same relative path — so when two packages own an independent file
 * at the same path (e.g. `packages/app/src/commands/commandUtils.ts` vs
 * `packages/review/src/commands/commandUtils.ts`), an `app` importer silently
 * got `review`'s file under test: a false green (GS2-45).
 *
 * The review package also ships re-export stubs that just delegate to core
 * (e.g. `utils/fileUtils.ts`); when a match came from `review` but core owns the
 * same relative path, core's canonical module is preferred so every consumer
 * shares one module identity.
 */
export function resolveWorkspaceImports() {
  return {
    name: 'resolve-workspace-imports',
    enforce: 'pre' as const,

    resolveId(id: string, importer: string | undefined): any {
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

        // Importer-aware: try the importing file's OWN package first, so a file
        // sharing a relative path with another package can never shadow it. Fall
        // back to the fixed dependency-order scan only when the importer isn't a
        // workspace-package file (a non-package caller); a genuine in-package
        // `#src` self-import always resolves within its own package.
        const importerPkg = packageOfImporter(importer);
        const searchOrder = importerPkg
          ? [importerPkg, ...WORKSPACE_PACKAGES.filter((pkg) => pkg !== importerPkg)]
          : WORKSPACE_PACKAGES;

        for (const pkg of searchOrder) {
          const found = resolveSource(resolve(__dirname, `packages/${pkg}/src/${relative}`));
          if (found) {
            // Skip re-export stubs (files that just re-export from @gaunt-sloth/)
            // by preferring the canonical core module when review only re-exports
            // it. review ships such stubs (e.g. utils/fileUtils.ts); when review
            // and core own the same relative path, core is the canonical one.
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
      const scopedMatch = id.match(
        /^@gaunt-sloth\/(core|agent|review|batch|eval-reporter-junit|eval-reporter-teamcity)\/(.+)\.js$/
      );
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
    // OPS-33 — clamp chalk to level 0 before any spec loads, so no test depends on ambient
    // terminal capability. Six Ink-rendering specs compare frames to un-escaped strings and go
    // red for anyone who exports FORCE_COLOR (the one thing that overrides chalk's non-TTY early
    // return, and now a documented knob since TUI-C35). Under vitest chalk is already at level 0,
    // so this is an identity operation everywhere the suite passes today. The setup file explains
    // why it clamps via the shipped hook instead of pinning FORCE_COLOR=0 in `env` — those are
    // NOT equivalent; FORCE_COLOR=0 is rung 1 of the CFG-30 ladder several specs exercise.
    // Relative, not an absolute path literal, so the Windows cell resolves it too.
    setupFiles: ['./packages/app/vitest.setup.ts'],
    server: {
      deps: {
        // Import the repo-root CLI helpers the way Node does, not through Vitest's inline
        // transform. Both are Node CLI scripts (`node scripts/<name>.mjs`) carrying a
        // `#!/usr/bin/env node` shebang. Vitest inlines every non-node_modules `.mjs` by default
        // and evaluates it inside an AsyncFunction wrapper, where a surviving shebang is a hard
        // `SyntaxError: Invalid or unexpected token`. Vite strips the shebang on the way out of
        // `fetchModule`, but that strip did not survive the `/@id/`-prefixed request path Vitest
        // takes for absolute Windows paths — so all of distTag.spec.ts failed on windows-latest
        // and only there (OPS-26). Externalized, Node imports the file natively and handles the
        // shebang per spec on every platform. Any spec importing a shebang'd script under
        // scripts/ needs an entry here. distTag.spec.ts, evalGate.spec.ts and
        // releaseNotesFor.spec.ts each assert their own entry is in effect, so dropping one fails
        // loudly everywhere rather than on the Windows cell alone.
        // The `(\?|$)` tail keeps the match alive when the resolved id carries a query suffix
        // (e.g. `?v=…`, or vitest's `_vitest_original` on an importActual path).
        external: [
          /[\\/]scripts[\\/]dist-tag\.mjs(\?|$)/,
          /[\\/]scripts[\\/]eval-gate\.mjs(\?|$)/,
          /[\\/]scripts[\\/]release-notes-for\.mjs(\?|$)/,
        ],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    globals: true,
    testTimeout: 10000,
  },
});
