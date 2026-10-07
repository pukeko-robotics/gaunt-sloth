import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { captureFetchErrors, type FetchErrorCapture } from '#src/mcp/fetchErrorCapture.js';

const requestErrors = channel('undici:request:error');

function publish(origin: unknown, error: unknown): void {
  requestErrors.publish({ request: { origin }, error });
}

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('captureFetchErrors', () => {
  let capture: FetchErrorCapture | undefined;

  afterEach(() => {
    capture?.stop();
    capture = undefined;
  });

  it('returns the error published for the origin of a server URL', () => {
    capture = captureFetchErrors();
    const error = new Error('self-signed certificate in certificate chain');
    publish('https://localhost:34809', error);
    expect(capture.errorFor('https://localhost:34809/mcp')).toBe(error);
    expect(capture.errorFor('https://localhost:34810/mcp')).toBeUndefined();
  });

  it('keeps the most recent error for an origin', () => {
    capture = captureFetchErrors();
    const latest = new Error('second');
    publish('https://localhost:34809', new Error('first'));
    publish('https://localhost:34809', latest);
    expect(capture.errorFor('https://localhost:34809/mcp')).toBe(latest);
  });

  it('ignores a malformed message and an undefined URL', () => {
    capture = captureFetchErrors();
    publish(undefined, new Error('no origin'));
    publish('https://localhost:34809', 'not an error');
    expect(capture.errorFor('https://localhost:34809/mcp')).toBeUndefined();
    expect(capture.errorFor(undefined)).toBeUndefined();
  });

  it('records nothing after it is stopped', () => {
    capture = captureFetchErrors();
    capture.stop();
    publish('https://localhost:34809', new Error('late'));
    expect(capture.errorFor('https://localhost:34809/mcp')).toBeUndefined();
  });

  it("captures the cause of a real failed fetch, which fetch's own error only wraps", async () => {
    capture = captureFetchErrors();
    const url = `https://127.0.0.1:${await closedPort()}/mcp`;
    await expect(fetch(url)).rejects.toThrow('fetch failed');
    expect((capture.errorFor(url) as NodeJS.ErrnoException | undefined)?.code).toBe('ECONNREFUSED');
  });
});
