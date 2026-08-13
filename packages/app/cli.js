#!/usr/bin/env node

// Suppress deprecation warnings programmatically
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' || warning.name === 'ExperimentalWarning') {
    return;
  }
  console.warn(warning);
});

// --- ACP server ------------------------------------------------------------
// `gaunt-sloth --acp-agent` is the ACP (Agent Client Protocol) door into the fat
// `gaunt-sloth` package. It serves ACP v2 over stdio through the SAME startup as
// the standalone `gaunt-sloth-acp` bin, so the two doors cannot behave
// differently — including the redirect that keeps stdout free for JSON-RPC.
//
// The switch is handled here rather than left to fall through to the normal CLI,
// which would answer an ACP host with a chat session on stdout and hang it.
//
// A startup failure goes to stderr: to an ACP host stdout is the JSON-RPC framing
// channel, so prose written there is a protocol error, not a message.
if (process.argv.includes('--acp-agent')) {
  const { setEntryPoint } = await import('@gaunt-sloth/core/utils/systemUtils.js');
  setEntryPoint(import.meta.url);
  const { startAcpServer } = await import('@gaunt-sloth/agent/modules/acp/acpStdio.js');
  try {
    await startAcpServer();
  } catch (err) {
    process.stderr.write(
      `Gaunt Sloth ACP agent failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  }
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
