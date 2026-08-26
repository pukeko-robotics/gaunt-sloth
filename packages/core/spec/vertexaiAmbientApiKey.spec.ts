import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGoogle } from '@langchain/google/node';

/**
 * CFG-58 — `type: vertexai` authenticates through ADC even when a `GOOGLE_API_KEY` is exported.
 *
 * `@langchain/google` ranks an ambient `GOOGLE_API_KEY` above service-account credentials and ADC,
 * and its api-key header is set ahead of both branches, so an AI Studio key exported for a
 * `google-genai` profile turns a `vertexai` session into a Vertex express session against the
 * user's stated config. The preset demotes the ambient key by passing an empty-string `apiKey`.
 *
 * Everything here is asserted against a CONSTRUCTED client, never read off the source: each case
 * runs the real `NodeApiClient.fetch` and reads the headers that would go on the wire. There is no
 * network — `globalThis.fetch` is stubbed for the duration of a probe, and the only thing replaced
 * inside the library is the ADC CREDENTIAL SOURCE (`googleAuth.getRequestHeaders`), keeping the
 * real `GoogleAuth` instance the library itself built so the auth path under test is the real one.
 *
 * No assertion compares an API key BY VALUE. A dropped key silently falls back to `process.env`, so
 * a value comparison can print a live key into test output; presence, absence, the library's own
 * `hasApiKey()` predicate, and — where a case must tell two keys apart — their differing lengths
 * are what is asserted.
 */

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

/**
 * `systemUtils` does `export const env = process.env`, binding the object that existed at module
 * load. A write through THAT import therefore never reaches a proxy installed on `process.env`
 * afterwards — and it is the spelling the repo actually uses (`google-genai.ts`, `GthAgentRunner.ts`
 * both import `env` this way), so it is the likeliest way an env-mutation would be reintroduced.
 * Re-exporting `env` as a getter makes the import resolve to whatever `process.env` is AT CALL TIME,
 * which is what puts that spelling under the proxy below instead of around it. Outside the proxied
 * window this returns the same object the real module would, so nothing else changes.
 */
vi.mock('#src/utils/systemUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/systemUtils.js')>();
  return {
    ...actual,
    get env() {
      return process.env;
    },
  };
});

/** Fake sentinels. Deliberately different lengths so a case can tell them apart without values. */
const AMBIENT_KEY = 'ambient-env-key-not-real';
const EXPLICIT_KEY = 'explicit-config-key-not-real-and-longer';

const MODEL = 'gemini-3.7-flash';
const API_KEY_HEADER = 'x-goog-api-key';
/** Marker the stubbed ADC source returns, so "ADC was used" is observable on the wire. */
const ADC_MARKER_HEADER = 'x-gth-test-adc-marker';

/**
 * Every Google auth variable this suite takes ownership of. All four are cleared and re-set per
 * test rather than read, so nothing this machine exports can reach an assertion.
 */
const MANAGED_VARS = [
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_CREDENTIALS',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const;

/** The runtime shape of `NodeApiClient`. Its auth fields are `@protected` in the typings only. */
interface NodeApiClientShape {
  apiKey?: unknown;
  credentials?: unknown;
  googleAuth?: { getRequestHeaders: (_url?: string) => Promise<Headers> };
  hasApiKey(): boolean;
  fetch(_request: Request): Promise<Response>;
}

function clientOf(model: unknown): NodeApiClientShape {
  return (model as { apiClient: NodeApiClientShape }).apiClient;
}

/**
 * `BaseChatGoogle.isVertexExpress` — `platform === 'gcp' && apiClient.hasApiKey()`. It decides
 * whether `buildUrl` produces the express URL or the project/location one, so it is the
 * discriminator that pins the URL-shape consequence of the hijack, not just the header.
 */
function isVertexExpress(model: unknown): boolean {
  return (model as { isVertexExpress: boolean }).isVertexExpress;
}

function platformOf(model: unknown): string {
  return (model as { _platform: string })._platform;
}

interface WireProbe {
  apiKeyHeaderSent: boolean;
  adcHeaderSent: boolean;
}

/** Run the real client `fetch` against a stubbed transport and report what it authenticated with. */
async function sendProbeRequest(model: unknown): Promise<WireProbe> {
  const client = clientOf(model);
  const realFetch = globalThis.fetch;
  let captured: Request | undefined;
  globalThis.fetch = (async (request: Request) => {
    captured = request;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  if (client.googleAuth) {
    client.googleAuth.getRequestHeaders = async () => new Headers({ [ADC_MARKER_HEADER]: 'stub' });
  }
  try {
    await client.fetch(new Request('https://us-central1-aiplatform.googleapis.com/v1/probe'));
  } finally {
    globalThis.fetch = realFetch;
  }
  if (!captured) {
    throw new Error('the client never issued a request');
  }
  return {
    apiKeyHeaderSent: captured.headers.has(API_KEY_HEADER),
    adcHeaderSent: captured.headers.has(ADC_MARKER_HEADER),
  };
}

/** Whether the client is holding a real ADC handle rather than merely some object. */
function usesGoogleAuth(client: NodeApiClientShape): boolean {
  const auth = client.googleAuth;
  return (
    auth !== undefined &&
    auth.constructor?.name === 'GoogleAuth' &&
    typeof auth.getRequestHeaders === 'function'
  );
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetAllMocks();
  for (const name of MANAGED_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  // Overwrite unconditionally rather than reading what is exported: this is the ordinary state of a
  // machine that also runs a google-genai profile, and it is the state the whole node is about.
  process.env.GOOGLE_API_KEY = AMBIENT_KEY;
});

afterEach(() => {
  for (const name of MANAGED_VARS) {
    const value = savedEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('vertexai preset with an ambient GOOGLE_API_KEY (CFG-58)', () => {
  it('authenticates through GoogleAuth/ADC and sends no api-key header', async () => {
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    const model = await processJsonConfig({ type: 'vertexai', model: MODEL } as never);
    const client = clientOf(model);

    // The library's own predicate: no usable key on the client at all.
    expect(client.hasApiKey()).toBe(false);
    // ADC was actually constructed — the branch that never ran while the ambient key won.
    expect(usesGoogleAuth(client)).toBe(true);
    // Still Vertex, and NOT Vertex express: the URL keeps its project/location shape.
    expect(platformOf(model)).toBe('gcp');
    expect(isVertexExpress(model)).toBe(false);

    const probe = await sendProbeRequest(model);
    expect(probe.apiKeyHeaderSent).toBe(false);
    expect(probe.adcHeaderSent).toBe(true);
  });

  it('behaves identically when no ambient key is exported — the fix is inert on the working path', async () => {
    delete process.env.GOOGLE_API_KEY;
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    const model = await processJsonConfig({ type: 'vertexai', model: MODEL } as never);
    const client = clientOf(model);

    expect(client.hasApiKey()).toBe(false);
    expect(usesGoogleAuth(client)).toBe(true);
    expect(isVertexExpress(model)).toBe(false);

    const probe = await sendProbeRequest(model);
    expect(probe.apiKeyHeaderSent).toBe(false);
    expect(probe.adcHeaderSent).toBe(true);
  });

  it('an explicit apiKey on the llm block still takes effect', async () => {
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    const model = await processJsonConfig({
      type: 'vertexai',
      model: MODEL,
      apiKey: EXPLICIT_KEY,
    } as never);
    const client = clientOf(model);

    expect(client.hasApiKey()).toBe(true);
    // A key written in the config is how Vertex express mode is asked for on purpose.
    expect(isVertexExpress(model)).toBe(true);

    const probe = await sendProbeRequest(model);
    expect(probe.apiKeyHeaderSent).toBe(true);

    // WHICH key, told apart by length. The sentinels differ in length by construction (asserted
    // here so this can never be a vacuous check), which discriminates the config key from the
    // ambient one without ever comparing — or, on failure, printing — a key value.
    expect(EXPLICIT_KEY.length).not.toBe(AMBIENT_KEY.length);
    expect(String(client.apiKey).length).toBe(EXPLICIT_KEY.length);
  });

  it('does not mutate process.env', async () => {
    const before = { ...process.env };
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    await processJsonConfig({ type: 'vertexai', model: MODEL } as never);
    await processJsonConfig({ type: 'vertexai', model: MODEL, apiKey: EXPLICIT_KEY } as never);

    // Names may be compared directly; VALUES are reduced to a boolean first, because a failing
    // deep-equal on process.env would print every exported secret into the test output.
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort());
    expect(Object.entries(before).every(([name, value]) => process.env[name] === value)).toBe(true);
    expect('GOOGLE_API_KEY' in process.env).toBe(true);
  });

  it('does not mutate process.env even TRANSIENTLY — a careful unset-and-restore is caught too', async () => {
    // The before/after check above cannot see the rejected alternative done competently: unset the
    // variable, construct, put it back. Nothing is left behind, so nothing is left to compare. This
    // records the OPERATION instead of its residue, which is what lets the suite say that
    // env-mutation is the wrong mechanism rather than merely that this one tidied up after itself.
    // Both spellings are covered: `getEnvironmentVariable` reads `process.env` at call time, and
    // the `env` import from `systemUtils` is re-exported as a getter above so it resolves to the
    // proxy too. Without that second half a `delete env.GOOGLE_API_KEY` would pass this untouched.
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    const realEnv = process.env;
    const envWrites: string[] = [];
    // Operation and property NAME only — never a value, so a failure cannot print a key.
    process.env = new Proxy(realEnv, {
      deleteProperty(target, property) {
        envWrites.push(`delete ${String(property)}`);
        return Reflect.deleteProperty(target, property);
      },
      set(target, property, value) {
        envWrites.push(`set ${String(property)}`);
        return Reflect.set(target, property, value);
      },
      defineProperty(target, property, attributes) {
        envWrites.push(`define ${String(property)}`);
        return Reflect.defineProperty(target, property, attributes);
      },
    });
    try {
      const model = await processJsonConfig({ type: 'vertexai', model: MODEL } as never);
      // Proves the construction really ran under the proxy rather than the assertion being
      // vacuously green on a call that never happened.
      expect(clientOf(model).hasApiKey()).toBe(false);
    } finally {
      process.env = realEnv;
    }

    expect(envWrites).toEqual([]);
  });

  it('leaves the google-genai preset alone — the ambient key still reaches AI Studio', async () => {
    const { processJsonConfig } = await import('#src/providers/google-genai.js');

    const model = await processJsonConfig({ type: 'google-genai', model: MODEL } as never);
    const client = clientOf(model);

    expect(platformOf(model)).toBe('gai');
    expect(client.hasApiKey()).toBe(true);
    expect(usesGoogleAuth(client)).toBe(false);
    expect(String(client.apiKey).length).toBe(AMBIENT_KEY.length);

    const probe = await sendProbeRequest(model);
    expect(probe.apiKeyHeaderSent).toBe(true);
  });

  it('an explicit key still wins for google-genai too', async () => {
    const { processJsonConfig } = await import('#src/providers/google-genai.js');

    const model = await processJsonConfig({
      type: 'google-genai',
      model: MODEL,
      apiKey: EXPLICIT_KEY,
    } as never);

    expect(String(clientOf(model).apiKey).length).toBe(EXPLICIT_KEY.length);
    expect((await sendProbeRequest(model)).apiKeyHeaderSent).toBe(true);
  });

  it('GEMINI_API_KEY is not an ambient key source for the vertexai preset either', async () => {
    // Forward canary. `ChatGoogle` reads only GOOGLE_API_KEY today, so this passes for free — and
    // it reds the day upstream widens the env list, which it has already begun doing for the
    // sibling ChatGoogleGenerativeAI class.
    delete process.env.GOOGLE_API_KEY;
    process.env.GEMINI_API_KEY = AMBIENT_KEY;
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    const model = await processJsonConfig({ type: 'vertexai', model: MODEL } as never);

    expect(clientOf(model).hasApiKey()).toBe(false);
    expect(isVertexExpress(model)).toBe(false);
    expect((await sendProbeRequest(model)).apiKeyHeaderSent).toBe(false);
  });
});

/**
 * The preset's fix is a deliberate use of `@langchain/google`'s auth precedence, so it is only as
 * durable as that precedence. These cases construct `ChatGoogle` directly, with no gaunt-sloth code
 * involved, and pin each internal the fix leans on. If any of them moves — the empty-string
 * semantics, the nullish-coalescing lookup, the header-before-ADC ordering — one of these reds and
 * names which one, instead of the preset silently going back to shipping the wrong credential.
 */
describe('the @langchain/google auth precedence the fix depends on (drift canary)', () => {
  it('an ambient GOOGLE_API_KEY outranks ADC for a vertexai client — the behaviour being demoted', async () => {
    const model = new ChatGoogle({ model: MODEL, vertexai: true });

    expect(clientOf(model).hasApiKey()).toBe(true);
    expect(isVertexExpress(model)).toBe(true);
    expect((await sendProbeRequest(model)).apiKeyHeaderSent).toBe(true);
  });

  it('googleAuthOptions alone does NOT demote it — ADC is built and then never reached', async () => {
    const model = new ChatGoogle({
      model: MODEL,
      vertexai: true,
      googleAuthOptions: { scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
    });
    const client = clientOf(model);

    // ADC exists on the client...
    expect(usesGoogleAuth(client)).toBe(true);
    // ...and the api-key header is still what goes on the wire. This is the fix to NOT reach for.
    const probe = await sendProbeRequest(model);
    expect(probe.apiKeyHeaderSent).toBe(true);
    expect(probe.adcHeaderSent).toBe(false);
  });

  it('a nullish apiKey does NOT demote it — the lookup coalesces, so undefined and null fall through', async () => {
    for (const nullish of [undefined, null]) {
      const model = new ChatGoogle({
        model: MODEL,
        vertexai: true,
        apiKey: nullish as unknown as string,
      });
      expect(clientOf(model).hasApiKey()).toBe(true);
      expect((await sendProbeRequest(model)).apiKeyHeaderSent).toBe(true);
    }
  });

  it('an empty-string apiKey demotes it and leaves ADC in place — the mechanism the preset uses', async () => {
    const model = new ChatGoogle({ model: MODEL, vertexai: true, apiKey: '' });
    const client = clientOf(model);

    expect(client.hasApiKey()).toBe(false);
    expect(usesGoogleAuth(client)).toBe(true);
    expect(isVertexExpress(model)).toBe(false);

    const probe = await sendProbeRequest(model);
    expect(probe.apiKeyHeaderSent).toBe(false);
    expect(probe.adcHeaderSent).toBe(true);
  });
});
