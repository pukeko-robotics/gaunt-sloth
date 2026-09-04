/**
 * CFG-62 — **the `gaunt-sloth-api` bin's flags, proved at the door.**
 *
 * ## Why this spawns, and why it connects
 *
 * `--port` and `--config` were accepted and dropped: `cli.js` read `argv[0]` and called
 * `initConfig({})`, so the port came only from `commands.api.port` and a `--config` naming a file
 * that does not exist was replaced by whatever discovery found in the working directory. Neither
 * failure is visible from inside the process — an assertion that an options object was built the
 * way the code builds it would have passed against the broken bin — so every cell here runs the
 * real file, through the real `bin` entry an installed user has on PATH.
 *
 * And the port cell **connects to the port**. The banner is not evidence: `startAgUiServer` prints
 * the number it was handed, so a run that printed `listening at http://localhost:3123` while
 * binding 3000 is exactly the defect being fixed. `GET /health` answering on the flag's port is
 * the only thing that distinguishes them.
 *
 * ## Why the ports come from the OS rather than a fixed number
 *
 * A committed spec cannot hardcode a port: it runs on the Windows and macOS CI cells and beside
 * whatever else is live on a developer's box, and takahē's per-worktree allocator (OPS-8) writes a
 * gitignored `.env` that exists on no CI runner. Binding `:0` and reading back the assigned port
 * asks the OS for one that is free right now, which is stronger than any static reservation and
 * needs no coordination. Two distinct ports are drawn per precedence cell so that "the flag won"
 * and "the config file won" cannot be confused with each other or with the 3000 default.
 *
 * ## Hermetic and key-free
 *
 * The `fake` provider replays a canned answer, `allowedTools: []` skips tool resolution entirely
 * (so no MCP server is contacted), and the child's `HOME`/`USERPROFILE` point at an empty temp dir
 * so an ambient `~/.gsloth` global config cannot decide the outcome. `INIT_CWD` is dropped because
 * pnpm sets it to wherever `pnpm test` was invoked and `getCurrentWorkDir()` prefers it, which
 * would aim the run's config discovery at the repository instead of the temp dir under test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, '..', 'cli.js'); // packages/agent/cli.js — the `gaunt-sloth-api` bin

/** How long a spawned server gets to answer /health before a cell gives up. */
const BOOT_TIMEOUT_MS = 25000;
/** Per-cell timeout, above BOOT_TIMEOUT_MS so a slow boot fails on the poll's own message. */
const CELL_TIMEOUT_MS = 40000;

/** A port nothing is listening on, straight from the OS. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.on('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolvePort(port) : rejectPort(new Error('no port assigned'))));
    });
  });
}

/** The child's environment: no ambient home, no inherited cwd, no tracing. */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.INIT_CWD;
  // LangSmith tracing would turn a hermetic run into a networked one.
  delete env.LANGCHAIN_TRACING_V2;
  delete env.LANGCHAIN_TRACING;
  delete env.LANGSMITH_TRACING;
  return env;
}

/** A config the fake provider can serve with no key and no network. */
function writeFixtureConfig(path: string, port?: number): void {
  writeFileSync(
    path,
    JSON.stringify({
      llm: { type: 'fake', responses: ['CFG-62 fake answer'] },
      // An empty allow-list disables tool resolution outright, so no MCP/A2A server is contacted
      // just to have the result discarded — see GthLangChainAgent.init.
      allowedTools: [],
      ...(port === undefined ? {} : { commands: { api: { port } } }),
    })
  );
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Poll `GET /health` until it answers or the deadline passes.
 *
 * Asynchronous on purpose: a busy `while` loop cannot be interrupted by vitest's timeout, so a
 * server that never binds would hang the run instead of failing this cell.
 */
async function waitForHealth(
  port: number,
  child: ChildProcess,
  transcript: () => string
): Promise<number> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the server exited with code ${child.exitCode} before binding ${port}; it said:\n${transcript()}`
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return response.status;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(200);
  }
  throw new Error(
    `nothing answered on ${port} within ${BOOT_TIMEOUT_MS}ms (last: ${lastError}); the server said:\n${transcript()}`
  );
}

describe('the gaunt-sloth-api bin reads the flags it accepts', () => {
  const children: ChildProcess[] = [];
  const tempDirs: string[] = [];

  /** Spawn the bin and collect both streams; the child is killed in afterEach either way. */
  function startServer(
    args: string[],
    cwd: string,
    home: string
  ): { child: ChildProcess; transcript: () => string } {
    const child = spawn('node', [cliEntry, ...args], { cwd, env: childEnv(home) });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (chunk) => (output += String(chunk)));
    child.stderr?.on('data', (chunk) => (output += String(chunk)));
    return { child, transcript: () => output };
  }

  /** A pair of temp dirs — an empty project dir to run in, and an empty home. */
  function makeDirs(label: string): { dir: string; home: string } {
    const dir = mkdtempSync(join(tmpdir(), `gsloth-cfg62-${label}-`));
    const home = mkdtempSync(join(tmpdir(), `gsloth-cfg62-${label}-home-`));
    tempDirs.push(dir, home);
    return { dir, home };
  }

  afterEach(() => {
    // Unconditionally, including on the failure path: an orphan holding a port makes the NEXT
    // cell fail in a way that reads like a defect in the code under test.
    for (const child of children.splice(0)) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'binds the port named by --port, over the one in the config file',
    async () => {
      const flagPort = await freePort();
      const configPort = await freePort();
      expect(flagPort).not.toBe(configPort);

      const { dir, home } = makeDirs('flag');
      const configPath = join(dir, 'gth-fake.json');
      writeFixtureConfig(configPath, configPort);

      const { child, transcript } = startServer(
        ['ag-ui', '--port', String(flagPort), '--config', configPath],
        dir,
        home
      );

      // Connecting is the assertion. The banner prints whatever number it was handed, so it
      // cannot tell a bound port from a dropped flag.
      expect(await waitForHealth(flagPort, child, transcript)).toBe(200);
    },
    CELL_TIMEOUT_MS
  );

  it(
    'binds the port from the file named by --config when no --port is given',
    async () => {
      const configPort = await freePort();
      const { dir, home } = makeDirs('config');
      // The config lives OUTSIDE the working directory, and both the working directory and the
      // home are empty. So there is nothing for discovery to find: reaching a bound port at all
      // proves this file was read, rather than a config that happened to be lying around.
      const elsewhere = mkdtempSync(join(tmpdir(), 'gsloth-cfg62-elsewhere-'));
      tempDirs.push(elsewhere);
      const configPath = join(elsewhere, 'gth-fake.json');
      writeFixtureConfig(configPath, configPort);

      const { child, transcript } = startServer(['ag-ui', '--config', configPath], dir, home);

      expect(await waitForHealth(configPort, child, transcript)).toBe(200);
    },
    CELL_TIMEOUT_MS
  );

  it('exits non-zero and names the path when --config points at a file that is not there', () => {
    const { dir, home } = makeDirs('missing');
    // A config that IS discoverable from the working directory, so a fallback to discovery would
    // produce a running server rather than an error — which is exactly the reported failure.
    writeFixtureConfig(join(dir, '.gsloth.config.json'));
    const missing = join(dir, 'no-such-config.json');

    const result = spawnSync('node', [cliEntry, 'ag-ui', '--config', missing], {
      cwd: dir,
      env: childEnv(home),
      encoding: 'utf8',
      timeout: BOOT_TIMEOUT_MS,
    });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status, `expected a non-zero exit; the CLI said:\n${output}`).not.toBe(0);
    expect(output).toContain(missing);
  });

  it('exits non-zero and names the value when --port is not a port', () => {
    const { dir, home } = makeDirs('badport');
    writeFixtureConfig(join(dir, '.gsloth.config.json'));

    const result = spawnSync('node', [cliEntry, 'ag-ui', '--port', 'not-a-port'], {
      cwd: dir,
      env: childEnv(home),
      encoding: 'utf8',
      timeout: BOOT_TIMEOUT_MS,
    });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status, `expected a non-zero exit; the CLI said:\n${output}`).not.toBe(0);
    expect(output).toContain('not-a-port');
    // Not started, rather than started on a port nobody asked for: `listen(NaN)` would bind an
    // arbitrary free port, which is the same class of silent wrong answer this node removes.
    expect(output).not.toContain('AG-UI server listening');
  });

  it('prints usage naming both flags, and exits 0, for --help', () => {
    const { dir, home } = makeDirs('help');

    const result = spawnSync('node', [cliEntry, '--help'], {
      cwd: dir,
      env: childEnv(home),
      encoding: 'utf8',
      timeout: BOOT_TIMEOUT_MS,
    });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
    expect(output).toContain('--port');
    expect(output).toContain('--config');
    // The precedence the docs state, stated at the door too, so the two cannot drift apart.
    expect(output).toContain('Port precedence: --port, then commands.api.port');
  });

  it('refuses an unrecognised flag instead of ignoring it', () => {
    const { dir, home } = makeDirs('unknown');
    writeFixtureConfig(join(dir, '.gsloth.config.json'));

    const result = spawnSync('node', [cliEntry, 'ag-ui', '--porrt', '4000'], {
      cwd: dir,
      env: childEnv(home),
      encoding: 'utf8',
      timeout: BOOT_TIMEOUT_MS,
    });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status, `expected a non-zero exit; the CLI said:\n${output}`).not.toBe(0);
    expect(output).toContain('porrt');
    expect(output).not.toContain('AG-UI server listening');
  });
});
