#!/usr/bin/env node

// Suppress deprecation warnings programmatically
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' || warning.name === 'ExperimentalWarning') {
    return;
  }
  console.warn(warning);
});

// --- ACP server bypass -----------------------------------------------------
// `gaunt-sloth --acp-agent` is the ACP (Agent Client Protocol) door into the fat
// `gaunt-sloth` package, and it is currently a stub: it exits non-zero with an
// explanation. The switch is still recognised here rather than left to fall
// through to the normal CLI, which would answer an ACP host with a chat session
// on stdout and hang it. See @gaunt-sloth/agent's src/core/acpStub.ts.
//
// The message goes to stderr: to an ACP host stdout is the JSON-RPC framing
// channel, so prose written there is a protocol error, not a message.
if (process.argv.includes('--acp-agent')) {
  const { ACP_STUB_MESSAGE } = await import('@gaunt-sloth/agent/core/acpStub.js');
  process.stderr.write(`${ACP_STUB_MESSAGE}\n`);
  process.exit(1);
} else {
  // This is a minimalistic entry point that sets the installDir in systemUtils
  // and delegates to the compiled TypeScript code in dist/cli.js.
  // systemUtils lives in @gaunt-sloth/core (the app-side re-export shim died in
  // GS2-2 B4); importing it from core directly binds the same module instance
  // the rest of the app reads, so setEntryPoint state is shared as before.
  const { setEntryPoint } = await import('@gaunt-sloth/core/utils/systemUtils.js');

  // Set the installation directory in systemUtils
  setEntryPoint(import.meta.url);

  // Import and run the compiled TypeScript code
  import('./dist/cli.js').catch((err) => {
    console.error('Failed to load application:', err);
    process.exit(1);
  });
}
