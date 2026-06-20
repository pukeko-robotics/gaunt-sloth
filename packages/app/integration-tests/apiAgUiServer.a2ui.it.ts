import { describe, expect, it, afterEach } from 'vitest';
import path from 'path';
import type { ChildProcess } from 'node:child_process';
import { startChildProcess } from './support/commandRunner.ts';

const SERVER_PORT = 3098; // Dedicated port to avoid conflicts with apiAgUiServer.it.ts
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

  const events = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
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

describe('AG-UI Server Integration Tests (OpenAI)', () => {
  let serverProc: ChildProcess | null = null;

  afterEach(() => {
    if (serverProc) {
      serverProc.kill('SIGTERM');
      serverProc = null;
    }
  });

  it('should emit tool call events for show_a2ui_surface', async () => {
    serverProc = startChildProcess(
      'npx',
      ['gth', 'api', 'ag-ui', '--port', String(SERVER_PORT)],
      'ignore',
      WORKDIR
    );
    await waitForHealth(serverProc!);

    const { events } = await postRun({
      threadId: 'it-thread-a2ui',
      messages: [
        {
          role: 'user',
          content:
            'You MUST call the show_a2ui_surface tool right now. Pass this exact surfaceJsonl value: {"surfaceUpdate":{"surfaceId":"f1","components":[{"id":"t1","component":{"Text":{"text":{"literalString":"Name"}}}},{"id":"r","component":{"Column":{"children":{"explicitList":["t1"]}}}}]}}\n{"beginRendering":{"surfaceId":"f1","root":"r"}}',
          id: '1',
        },
      ],
    });

    const types = events.map((e) => e.type);
    expect(types).toContain('TOOL_CALL_START');
    expect(types).toContain('TOOL_CALL_ARGS');
    expect(types).toContain('TOOL_CALL_END');
    expect(types).toContain('RUN_FINISHED');

    // Verify the tool call is for show_a2ui_surface
    const toolStart = events.find(
      (e) => e.type === 'TOOL_CALL_START' && e.toolCallName === 'show_a2ui_surface'
    );
    expect(toolStart).toBeDefined();
  });
});
