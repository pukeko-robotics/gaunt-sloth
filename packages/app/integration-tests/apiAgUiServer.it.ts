import { describe, expect, it, afterEach } from 'vitest';
import path from 'path';
import type { ChildProcess } from 'node:child_process';
import { startChildProcess } from './support/commandRunner.ts';

const SERVER_PORT = 3099; // Dedicated port to avoid conflicts
const HEALTH_URL = `http://localhost:${SERVER_PORT}/health`;
const RUN_URL = `http://localhost:${SERVER_PORT}/agents/default/run`;
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
const WORKDIR = path.resolve('./packages/app/integration-tests/workdir');

async function waitForHealth(proc: ChildProcess, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (d) => (stdout += d));
  proc.stderr?.on('data', (d) => (stderr += d));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `AG-UI server did not become ready within ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`
  );
}

async function postRun(
  body: Record<string, unknown>
): Promise<{ events: Record<string, unknown>[]; raw: string }> {
  const res = await fetch(RUN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });

  const raw = await res.text();

  // Parse newline-delimited JSON events
  const events = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // EventEncoder emits either raw JSON or SSE "data: <json>" lines
      const dataLine = line.startsWith('data: ') ? line.slice(6) : line;
      try {
        return JSON.parse(dataLine) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null);

  return { events, raw };
}

describe('AG-UI Server Integration Tests', () => {
  let serverProc: ChildProcess | null = null;

  afterEach(() => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      serverProc = null;
    }
  });

  it('should start, respond to health check, and accept a run request', async () => {
    serverProc = startChildProcess(
      'npx',
      ['gth', 'api', 'ag-ui', '--port', String(SERVER_PORT)],
      'ignore',
      WORKDIR
    );

    await waitForHealth(serverProc!);

    const healthRes = await fetch(HEALTH_URL);
    expect(healthRes.ok).toBe(true);
    const health = await healthRes.json();
    expect(health).toEqual({ status: 'ok' });

    const { events } = await postRun({
      threadId: 'it-thread-1',
      runId: 'it-run-1',
      messages: [{ role: 'user', content: 'Say one word.', id: '1' }],
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('RUN_STARTED');
    expect(types).toContain('TEXT_MESSAGE_START');
    expect(types).toContain('TEXT_MESSAGE_END');
    expect(types).toContain('RUN_FINISHED');

    // threadId should echo back correctly
    const runStarted = events.find((e) => e.type === 'RUN_STARTED');
    expect(runStarted?.threadId).toBe('it-thread-1');
  });

  it('should include text content in the response', async () => {
    serverProc = startChildProcess(
      'npx',
      ['gth', 'api', 'ag-ui', '--port', String(SERVER_PORT)],
      'ignore',
      WORKDIR
    );
    await waitForHealth(serverProc!);

    const { events } = await postRun({
      threadId: 'it-thread-2',
      messages: [{ role: 'user', content: 'What is 2 + 2?', id: '1' }],
    });

    const contentEvents = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT');
    const fullText = contentEvents.map((e) => e.delta).join('');
    expect(fullText.length).toBeGreaterThan(0);
  });

  it('should emit tool call events when tools are used', async () => {
    serverProc = startChildProcess(
      'npx',
      ['gth', 'api', 'ag-ui', '--port', String(SERVER_PORT)],
      'ignore',
      WORKDIR
    );
    await waitForHealth(serverProc!);

    const { events } = await postRun({
      threadId: 'it-thread-tools',
      messages: [
        {
          role: 'user',
          content: 'List the files in the current directory using your tools.',
          id: '1',
        },
      ],
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('TOOL_CALL_START');
    expect(types).toContain('TOOL_CALL_END');
    expect(types).toContain('RUN_FINISHED');
  });

  it('should use system prompt on first request and not on second for same thread', async () => {
    serverProc = startChildProcess(
      'npx',
      ['gth', 'api', 'ag-ui', '--port', String(SERVER_PORT)],
      'ignore',
      WORKDIR
    );
    await waitForHealth(serverProc!);

    const threadId = 'it-thread-identity';

    // First request — ask for identity to confirm system prompt is active
    const { events: events1 } = await postRun({
      threadId,
      messages: [{ role: 'user', content: 'What is your name?', id: '1' }],
    });
    const text1 = events1
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => e.delta)
      .join('');

    // Gaunt Sloth's backstory names it "Gaunt Sloth"
    expect(text1.toLowerCase()).toMatch(/gaunt\s+sloth/i);

    // Second request on same thread — the server should not re-inject system messages
    const { events: events2 } = await postRun({
      threadId,
      messages: [
        { role: 'user', content: 'What is your name?', id: '1' },
        { role: 'assistant', content: text1, id: '2' },
        { role: 'user', content: 'Say your name again.', id: '3' },
      ],
    });

    const runFinished2 = events2.find((e) => e.type === 'RUN_FINISHED');
    expect(runFinished2).toBeDefined();
  });
});
