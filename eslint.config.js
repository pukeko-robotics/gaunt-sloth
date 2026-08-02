import jsConfig from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory path of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// OPS-39 — what `warn` means here, decided per rule rather than left ambient.
//
// `pnpm run lint` carries `--max-warnings 0`, so a warning fails the gate exactly like an error.
// Severity is therefore a *display* distinction — yellow in an editor, red in CI — and no longer
// an enforcement one. That is the whole point: before the flag, a warn-severity rule printed and
// blocked nobody, so it was decorative.
//
// The three rules currently at `warn` were each kept deliberately, none deleted:
//   - `@typescript-eslint/no-explicit-any` (below, and off in the test block) — discouraging `any`
//     in package sources was always the intent; it now holds.
//   - `react-hooks/incompatible-library` and `react-hooks/unsupported-syntax` (shipped at `warn` by
//     the plugin's recommended set) — both say the React Compiler could not analyse something,
//     which is worth stopping for. Neither reports anything today.
//
// Adding a rule at `warn` from here on is a decision to block on it. If it is not worth blocking
// on, do not add it — that is the state this node removed.
//
// Shared TypeScript rules
const tsRules = {
  ...tseslint.configs.recommended.rules,
  ...prettierConfig.rules,
  semi: 'error',
  'eol-last': 'error',
  'prettier/prettier': 'error',
  '@typescript-eslint/explicit-function-return-type': 'off',
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],
};

// Helper to create a package source config.
// `files` is overridable so a variant (the app's .tsx sources) reuses this exact shape —
// parser, tsconfig project and tsRules — instead of near-copying the object.
function pkgSourceConfig(pkg, files = [`packages/${pkg}/src/**/*.ts`]) {
  return {
    files,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: path.resolve(__dirname, `packages/${pkg}/tsconfig.json`),
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettierPlugin,
    },
    rules: tsRules,
  };
}

// Global ignores applied to all configurations
const globalIgnores = [
  '**/node_modules/**',
  '**/dist/**',
  'packages/app/integration-tests/workdir',
  'packages/app/integration-tests/workdir-with-profiles',
  'packages/*/tui-e2e/.tui-test/**',
  'docs-generated/**',
  'readonly/**',
  'coverage/**',
  '.git/**',
  'vitest-it.config.js',
  'vitest-it.config.d.ts',
  // BATCH-13: eval-it is a standalone on-demand harness; its generated run output is not linted.
  'eval-it/workdir/out/**',
  'eval-it/workdir/.gsloth/gth_*/**',
];

export default defineConfig([
  // Ignore files config - applies first
  {
    ignores: globalIgnores,
  },
  // Repo-wide linter options. A stale `eslint-disable` is indistinguishable from a live one, so
  // suppressions rot silently and a rule can be switched on later with its own markers already
  // dead. Reported as an error, an unused directive has to be deleted rather than accumulate.
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  // Base configuration for all JavaScript files. `.mjs` is included because scripts, release
  // tooling and spec fixtures use it; without it those files land in the lint report with no
  // config block matched, so zero rules apply and they are checked by nothing.
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      ...jsConfig.configs.recommended.rules,
      ...prettierConfig.rules,
      semi: 'error',
      'eol-last': 'error',
      'prettier/prettier': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // Workspace package TypeScript files
  pkgSourceConfig('core'),
  pkgSourceConfig('agent'),
  pkgSourceConfig('review'),
  pkgSourceConfig('batch'),
  pkgSourceConfig('app'),
  // The Ink terminal UI is written in .tsx. It gets the same rule set as the app's .ts sources,
  // via the same helper — the app tsconfig already has `jsx: react-jsx` and includes `src/**/*`,
  // and @typescript-eslint/parser enables JSX from the .tsx extension.
  pkgSourceConfig('app', ['packages/app/src/**/*.tsx']),
  // BATCH-19: the standalone JUnit eval reporter package.
  pkgSourceConfig('eval-reporter-junit'),
  // BATCH-20: the standalone live TeamCity eval reporter package.
  pkgSourceConfig('eval-reporter-teamcity'),
  // BATCH-13: eval-it standalone harness TypeScript. It lives outside packages/, so it matches none
  // of the pkgSourceConfig globs; give it a type-agnostic block (tsParser, no `project`) mirroring
  // the test block so `pnpm run lint` genuinely lints it rather than skipping it. Both extensions,
  // for the same reason the harness globs below carry both.
  {
    files: ['eval-it/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettierPlugin,
    },
    rules: tsRules,
  },
  // Test TypeScript files with separate project reference
  {
    files: [
      // Both extensions everywhere: a .tsx added under any of these harnesses would otherwise
      // reach the lint report with no block matched, which is the hole this list exists to close.
      'packages/*/spec/**/*.{ts,tsx}',
      'packages/*/integration-tests/**/*.{ts,tsx}',
      'packages/*/embed-e2e/**/*.{ts,tsx}',
      'packages/*/tui-e2e/**/*.{ts,tsx}',
      'packages/*/vitest.setup.ts',
      'vitest.config.ts',
      'vitest-it.config.ts',
      'vitest-embed.config.ts',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        // No project needed for tests to avoid parser errors
      },
      globals: {
        ...globals.node,
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettierPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...prettierConfig.rules,
      semi: 'error',
      'eol-last': 'error',
      'prettier/prettier': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off', // Allow any in test files
      // Unused vars are caught by the TypeScript-aware rule only. The base `no-unused-vars` is
      // not TypeScript-aware: it reads the parameter names inside a function *type* annotation as
      // unused bindings, so it reports names that document the type and nothing else. Every glob
      // above is TypeScript, so the base rule has no file here it could correctly serve.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ], // Error for unused vars in tests
    },
  },
  // React hooks, layered on top of whichever rule set above already matched the .tsx file.
  // Scoped to the two places hooks are actually written — a strict subset of the globs above that
  // match .tsx — so this block can never be the *only* rule a .tsx picks up. A `**/*.tsx` overlay
  // would hand a file in an unconfigured directory exactly one rule, which is enough to hide it
  // from the coverage guard in packages/core/spec/noUnlintedFiles.spec.ts. Keep it a subset.
  {
    files: ['packages/app/src/**/*.tsx', 'packages/*/spec/**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The recommended set ships exhaustive-deps as a warning. `pnpm run lint` has no
      // --max-warnings, so a warning here would be advice nobody is obliged to act on; every
      // other rule in this config is an error, and this one carries markers that
      // reportUnusedDisableDirectives must keep honest.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
]);
