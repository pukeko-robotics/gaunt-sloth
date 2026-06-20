import { execSync } from 'node:child_process';

// Script to launch integration tests

// When running behind an HTTP proxy, Node's native fetch (undici) does not
// automatically respect HTTP_PROXY / HTTPS_PROXY env vars. The --use-env-proxy
// flag (available since Node 24) tells Node to route requests through the proxy.
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
  const existing = process.env.NODE_OPTIONS || '';
  if (!existing.includes('--use-env-proxy')) {
    process.env.NODE_OPTIONS = existing ? `${existing} --use-env-proxy` : '--use-env-proxy';
  }
}

execSync('node packages/app/integration-tests/setup-config.js ' + process.argv[2], {
  stdio: [process.stdin, process.stdout, process.stderr],
});
try {
  const testArgs = process.argv.slice(3);
  const test = testArgs.length > 0 ? ` ${testArgs.join(' ')}` : '';
  execSync('vitest run --config vitest-it.config.ts' + test, {
    stdio: [process.stdin, process.stdout, process.stderr],
  });
} catch {
  process.exit(1);
}
