/**
 * EXT-46 — **the ACP bins, at the door.**
 *
 * ## This file replaces `acpStub.spec.ts`, deliberately
 *
 * That spec pinned the [[EXT-114]] stub: both ACP entry points had to resolve, exit non-zero, and
 * print an explanation naming this node. Every one of those assertions is now FALSE by design —
 * this node is what un-stubs the command — so the spec had to go red and be replaced rather than
 * relaxed. Nothing here is a loosened version of what was there: the properties are strictly
 * stronger. The old spec proved the door existed and refused; this one proves the door exists,
 * speaks ACP in both dialects it serves, and reports the version this build actually is. The one assertion carried over
 * unchanged is the one that was never about the stub — **stdout must carry protocol and nothing
 * else** — and it is now the load-bearing one, because there is finally a protocol on it.
 *
 * ## Why this spawns instead of importing
 *
 * A unit test proves a function exists. It cannot prove the `gaunt-sloth-acp` BIN resolves — it is
 * declared in `package.json`'s `bin` map, so anyone who wired the command into an editor has it on
 * PATH, and an unresolvable import there is a broken install to the host. These cells run the real
 * files, over real stdin/stdout, through the real newline-delimited JSON transport.
 *
 * ## Why stdout purity can only be tested here
 *
 * The in-process suite never touches a process's streams, so it cannot see the failure an editor
 * hits first: this codebase prints to stdout constantly (`displayInfo` reaches `console.info`), and
 * one such line corrupts the JSON-RPC framing. `startAcpServer` redirects `process.stdout` to
 * stderr and keeps the captured writer for the protocol. The agent announces itself on startup
 * BY DESIGN so that redirect is exercised on every real run — and these cells check both halves:
 * the announcement really was printed, it landed on stderr, and stdout parsed as exactly one
 * JSON-RPC message with nothing around it.
 *
 * Both doors are covered — the standalone bin and `gaunt-sloth --acp-agent` — for the reason the
 * stub spec gave and which did not change: a promise kept by one of two doors is not a promise.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.resolve(agentDir, '..', 'app');

/** The version the packages are locked to, read from the manifest the handshake should report. */
const packageVersion = JSON.parse(readFileSync(path.join(agentDir, 'package.json'), 'utf8'))
  .version as string;

/** A single `initialize` request — the one exchange that needs no config and no model. */
const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 2, info: { name: 'ext-46-bin-spec', version: '0.0.0' } },
})}\n`;

/** Run one ACP entry point with a single request on stdin and collect both streams. */
function speak(argv: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', argv, {
    input: INITIALIZE,
    encoding: 'utf8',
    timeout: 60000,
  });
  expect(result.error).toBeUndefined();
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * The v1 `initialize` — the shape every shipping ACP editor sends, Zed included.
 *
 * [[EXT-116]]. The distinguishing field is `clientInfo`, which v2 renamed to a required `info`;
 * a v2-only server rejects this exact request as `-32602 Invalid params` and no session opens.
 * The captured handshake and the in-process cases live in `acpServerV1.spec.ts`; what only a spawn
 * can prove is that the BIN — the thing an editor's agent configuration points at — answers it.
 */
const INITIALIZE_V1 = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientInfo: { name: 'ext-116-bin-spec', version: '0.0.0' },
  },
})}\n`;

/** The same, driven with a v1 handshake instead of a v2 one. */
function speakV1(argv: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', argv, {
    input: INITIALIZE_V1,
    encoding: 'utf8',
    timeout: 60000,
  });
  expect(result.error).toBeUndefined();
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** Every non-empty stdout line, parsed. Throws — loudly — if anything there is not JSON-RPC. */
function jsonRpcLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const doors: Array<[string, string[]]> = [
  ['gaunt-sloth-acp', [path.join(agentDir, 'cli-acp.js')]],
  ['gaunt-sloth --acp-agent', [path.join(appDir, 'cli.js'), '--acp-agent']],
];

describe.each(doors)('the ACP entry point %s', (_name, argv) => {
  it('serves ACP v2 on stdout and exits cleanly when the client disconnects', () => {
    const { stdout, status } = speak(argv);
    const lines = jsonRpcLines(stdout);

    // Exactly one message: the response to the one request. Anything else on this channel is a
    // framing error to a host, not a message someone reads.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(lines[0].result).toMatchObject({
      protocolVersion: 2,
      info: { name: 'gaunt-sloth', version: packageVersion },
    });
    // Reporting the real version proves the handshake read the manifest rather than falling back,
    // so the fallback cannot quietly become the normal answer.
    expect((lines[0].result as { info: { version: string } }).info.version).not.toBe('unknown');
    // Closing stdin ends the transport, and the agent stops rather than hanging on a dead pipe.
    expect(status).toBe(0);
  });

  it('prints its startup notice on stderr, where it cannot corrupt the protocol', () => {
    const { stdout, stderr } = speak(argv);

    // The notice goes through the ordinary console utilities, which write to stdout unless
    // something redirects them. That it appears at all is what makes the next assertion evidence:
    // a run that printed nothing would satisfy "stdout is clean" without proving anything.
    expect(stderr).toContain('ACP agent');
    expect(stderr).toContain('protocol v2');
    expect(stdout).not.toContain('ACP agent');
  });

  it('serves ACP v1 to a v1 host, and says so in its startup notice', () => {
    const { stdout, stderr, status } = speakV1(argv);
    const lines = jsonRpcLines(stdout);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ jsonrpc: '2.0', id: 1 });
    // v1's response shape: the version the host asked for, and the implementation under
    // `agentInfo` rather than v2's `info`.
    expect(lines[0].result).toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: 'gaunt-sloth', version: packageVersion },
    });
    // The notice names both dialects, because both are served and the host picks.
    expect(stderr).toContain('protocol v1');
    expect(status).toBe(0);
  });

  it('no longer prints the EXT-114 stub message', () => {
    const { stdout, stderr } = speak(argv);
    // The exact phrase the stub wrote. It must appear on neither stream: the command works now.
    expect(stderr).not.toContain('ACP (Agent Client Protocol) server is not available');
    expect(stdout).not.toContain('ACP (Agent Client Protocol) server is not available');
  });
});
