#!/usr/bin/env node

// Suppress deprecation warnings programmatically
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' || warning.name === 'ExperimentalWarning') {
    return;
  }
  console.warn(warning);
});

// This is a minimalistic entry point that sets the installDir in systemUtils
// and delegates to the compiled TypeScript code in dist/cli.js
import { setEntryPoint } from './dist/utils/systemUtils.js';

// Set the installation directory in systemUtils
setEntryPoint(import.meta.url);

// Import and run the compiled TypeScript code
import('./dist/cli.js').catch((err) => {
  console.error('Failed to load application:', err);
  process.exit(1);
});
