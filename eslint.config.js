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
  'packages/assistant/integration-tests/workdir',
  'packages/assistant/integration-tests/workdir-with-profiles',
  'docs-generated/**',
  'readonly/**',
  'coverage/**',
  '.git/**',
  'vitest-it.config.js',
  'vitest-it.config.d.ts',
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
  pkgSourceConfig('assistant'),
  // Test TypeScript files with separate project reference
  {
    files: [
      'packages/*/spec/**/*.ts',
      'packages/*/integration-tests/**/*.ts',
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
