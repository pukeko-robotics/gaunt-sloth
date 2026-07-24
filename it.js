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

const provider = process.argv[2];

// QA-8 — run-level, OLLAMA-SCOPED skip preflight, ported from the QA-7 ollama bash smoke's
// ollama_ready() probe. ONLY when the selected provider is `ollama`: if the daemon is unreachable or the
// resolved OLLAMA_IT_MODEL tag is absent, print a loud SKIPPED line (saying which — daemon vs model)
// and exit 0 WITHOUT running vitest — so `it ollama …` is runnable anywhere and green where it can't
// run (local-GPU-only, like the bash smoke). Every other provider is UNCHANGED: a missing API key
// must still fail loudly, so there is deliberately no generic provider-skip here.
if (provider === 'ollama') {
  const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  // Same default as setup-config.js so the probe and the SUT agree on which model tag to require.
  const model = process.env.OLLAMA_IT_MODEL || 'gemma4:12b';
  let modelNames = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const json = await res.json();
    modelNames = (json.models || []).map((m) => m.name);
  } catch {
    console.log(
      `SKIPPED: ollama daemon not reachable at ${host} — this is a local-GPU-only gate (start ollama to enable).`
    );
    process.exit(0);
  }
  if (!modelNames.includes(model)) {
    console.log(
      `SKIPPED: model '${model}' not present in ollama at ${host} — this is a local-GPU-only gate ` +
        `(\`ollama pull ${model}\` to enable).`
    );
    process.exit(0);
  }
  console.log(`==> ollama OK: daemon ${host}, model ${model}`);

  // OPS-24 — the local GPU is one non-partitionable card; two ollama runs at once thrash VRAM and
  // time out (looks like a capability failure). Serialize ollama runs behind a machine-local lock,
  // keyed by the already-computed `host`. Acquired ONLY on this ollama path, only after the skip
  // preflight confirmed ollama is present; every other provider path is untouched. The blocking
  // execSync(vitest…) holds the lock for the whole run; a single sync release on 'exit' fires on
  // normal exit, on the catch-block process.exit(1), and on a throw.
  const { createOllamaLock, defaultLockPath } =
    await import('./packages/app/integration-tests/support/ollamaLock.mjs');
  const _lock = createOllamaLock({ lockPath: defaultLockPath(host) });
  const _release = await _lock.acquire(); // async wait-loop; blocks until acquired or throws loud
  process.on('exit', _release); // single sync release path
  console.log(`==> ollama GPU lock acquired (${_lock.lockPath})`);
}

execSync('node packages/app/integration-tests/setup-config.js ' + provider, {
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
