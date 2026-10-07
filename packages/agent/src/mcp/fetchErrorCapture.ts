/**
 * @packageDocumentation
 * Records the network errors behind failed `fetch` calls, by origin, so a failed MCP connection can
 * name its cause.
 *
 * `@langchain/mcp-adapters` reports a failed connect as a new error built from the text of the
 * original, so all that reaches `onConnectionError` is `TypeError: fetch failed`; the TLS or socket
 * error that undici attached as its `cause` is gone. undici publishes every request error on a
 * diagnostics channel, which holds the same error and works with Node's built-in `fetch` and with
 * the dispatcher `tlsTrust.ts` installs. Subscribing to a channel does not load undici.
 */

import { subscribe, unsubscribe } from 'node:diagnostics_channel';

const REQUEST_ERROR_CHANNEL = 'undici:request:error';

/** The request errors published while the capture is active. */
export interface FetchErrorCapture {
  /** The most recent error for the origin of `url`, if there was one while capturing. */
  errorFor(url: string | undefined): Error | undefined;
  /** Stop recording. */
  stop(): void;
}

/**
 * Start recording request errors by origin. The channel is process-wide, so agents running in the
 * same process against the same origin see each other's errors, which describe the same server.
 */
export function captureFetchErrors(): FetchErrorCapture {
  const errors = new Map<string, Error>();
  const onRequestError = (message: unknown): void => {
    const { request, error } = message as { request?: { origin?: unknown }; error?: unknown };
    const origin = originOf(request?.origin);
    if (origin && error instanceof Error) {
      errors.set(origin, error);
    }
  };
  subscribe(REQUEST_ERROR_CHANNEL, onRequestError);
  return {
    errorFor: (url) => {
      const origin = originOf(url);
      return origin ? errors.get(origin) : undefined;
    },
    stop: () => {
      unsubscribe(REQUEST_ERROR_CHANNEL, onRequestError);
    },
  };
}

function originOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return new URL(String(value)).origin;
  } catch {
    return undefined;
  }
}
