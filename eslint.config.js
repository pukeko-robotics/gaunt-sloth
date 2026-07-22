import jsConfig from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory path of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Helper to create a package source config
function pkgSourceConfig(pkg) {
  return {
    files: [`packages/${pkg}/src/**/*.ts`],
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
  // Base configuration for all JavaScript files
  {
    files: ['**/*.js'],
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
  // BATCH-19: the standalone JUnit eval reporter package.
  pkgSourceConfig('eval-reporter-junit'),
  // BATCH-20: the standalone live TeamCity eval reporter package.
  pkgSourceConfig('eval-reporter-teamcity'),
  // BATCH-13: eval-it standalone harness TypeScript. It lives outside packages/, so it matches none
  // of the pkgSourceConfig globs; give it a type-agnostic block (tsParser, no `project`) mirroring
  // the test block so `pnpm run lint` genuinely lints it rather than skipping it.
  {
    files: ['eval-it/**/*.ts'],
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
      'packages/*/spec/**/*.ts',
      'packages/*/integration-tests/**/*.ts',
      'packages/*/tui-e2e/**/*.ts',
      'vitest.config.ts',
      'vitest-it.config.ts',
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
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ], // Error for unused vars in tests
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }], // For .js test files
    },
  },
]);
