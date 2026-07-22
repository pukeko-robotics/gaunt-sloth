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
// `gaunt-sloth --acp-agent` runs the Agent Client Protocol (ACP) server instead
// of the normal CLI, so an ACP host (Zed, JetBrains, a future Pukeko client) can
// spawn the fat `gaunt-sloth` package as a coding-agent subprocess.
//
// Why route ACP through the app rather than the standalone `gaunt-sloth-acp`
// binary in @gaunt-sloth/agent: the LLM providers (@langchain/anthropic, openai,
// google, …) are peerDependencies of @gaunt-sloth/core, and only this app package
// declares them as real dependencies. A bare `@gaunt-sloth/agent` install leaves
// those peers unmet, so its ACP server has no providers to construct a model from.
// Starting the same ACP server from here resolves providers out of the app's tree.
//
// ACP speaks JSON-RPC over stdio, so stdout MUST stay a clean protocol channel:
// redirect console.log/info (used by initConfig/status output) to stderr BEFORE
// touching config, exactly as the standalone `gaunt-sloth-acp` entry does.
if (process.argv.includes('--acp-agent')) {
  for (const method of ['log', 'info']) {
    console[method] = (...args) => process.stderr.write(args.join(' ') + '\n');
  }
  const [{ initConfig }, { displayError }, { startAcpServer }] = await Promise.all([
    import('@gaunt-sloth/core/config.js'),
    import('@gaunt-sloth/core/utils/consoleUtils.js'),
    import('@gaunt-sloth/agent'),
  ]);
  try {
    const config = await initConfig({});
    await startAcpServer(config);
  } catch (err) {
    displayError(`ACP server failed: ${err instanceof Error ? err.message : String(err)}`);
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
