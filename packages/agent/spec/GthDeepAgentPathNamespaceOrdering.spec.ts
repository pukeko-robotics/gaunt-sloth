/**
 * EXT-22 (S1) ordering regression test — the load-bearing proof that gsloth's path-namespace
 * correction is the LAST thing in the assembled system message, so the model reads it last.
 *
 * Unlike GthDeepAgent.spec.ts (which mocks `deepagents`), this drives the REAL deepagents middleware
 * stack via `createDeepAgent` + a real {@link FilesystemBackend}, exactly as the Task-1 spike did
 * (see handoff/spike-systemmessage-ordering.md). A recording `wrapModelCall` middleware captures the
 * final `request.systemMessage` at the model boundary, then short-circuits to a stub `AIMessage`, so
 * NO model / API key is needed. A fake model (never invoked) avoids pulling a provider package.
 *
 * The anchor is gsloth's OWN composed prompt (the S2 early note), not any deepagents text: since
 * deepagents 1.12 its generic system prompt is blank, and the `/`-rooted pressure the correction
 * answers now comes from the fs tools' parameter descriptions ("Absolute path … Must be absolute,
 * not relative") rather than a prompt line. What still has to hold — and what this pins — is that
 * S1's block lands after everything else in the message.
 *
 * Division of labour: this proves the MECHANISM (a custom wrapModelCall that concats a block ends up
 * last, through deepagents' real middleware nesting). GthDeepAgent.spec.ts proves init() actually
 * installs the S1 middleware as the FINAL array entry with the right gate.
 */
import { describe, expect, it } from 'vitest';
import { createDeepAgent, FilesystemBackend } from 'deepagents';
import { createMiddleware } from 'langchain';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendVirtualCwdNote,
  createPathNamespaceCorrectionMiddleware,
  PATH_NAMESPACE_GUIDANCE,
} from '#src/core/GthDeepAgent.js';

/** Stand-in for gsloth's composed systemPrompt, and markers unique to the S2 note / S1 correction. */
const COMPOSED_PROMPT = '<<<GSLOTH_COMPOSED_SYSTEM_PROMPT_MARKER>>>';
const S2_MARKER = 'Filesystem vs shell path namespaces:';
const S1_MARKER = 'IMPORTANT — path namespaces (authoritative';

/** Flatten a SystemMessage's content (string or text-block array) to one searchable string. */
function assembledText(sm: unknown): string {
  const content = (sm as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : ((b as { text?: string }).text ?? '')))
      .join('\n');
  }
  return '';
}

/**
 * A minimal fake model. It is NEVER invoked (the recording middleware short-circuits before the
 * model boundary), so it needs no provider package / API key; it only has to survive
 * `createDeepAgent` construction. Not an Anthropic model, so deepagents installs no cache
 * middleware — the assembled message is exactly what the runtime middleware stack produced.
 */
function fakeModel(): any {
  return {
    getName: () => 'FakeModel',
    bindTools() {
      return this;
    },
    async invoke() {
      return new AIMessage('never called');
    },
  };
}

/**
 * Build a real deep agent with [S1, recording] as custom middleware, invoke it once, and return the
 * assembled system-message text the model boundary would have received. `s1Active` toggles the S1
 * gate (true = code+virtualMode; false = POSIX real-path pass-through), and `systemPrompt` is what
 * gsloth would have composed in that mode.
 */
async function captureAssembledSystemMessage(
  s1Active: boolean,
  systemPrompt: string
): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'ext22-order-'));
  try {
    let captured: unknown;
    const recording = createMiddleware({
      name: 'Recording',
      wrapModelCall: async (request: any) => {
        captured = request.systemMessage;
        return new AIMessage('stub'); // short-circuit: never calls handler → no model / API key
      },
    });
    const s1 = createPathNamespaceCorrectionMiddleware(s1Active);

    const agent = createDeepAgent({
      model: fakeModel(),
      tools: [],
      systemPrompt,
      // S1 first, recording last: recording (innermost of the two) captures S1's appended block.
      middleware: [s1, recording] as any,
      backend: new FilesystemBackend({ rootDir: root, virtualMode: true }),
    });

    await agent.invoke({ messages: [new HumanMessage('hi')] });
    return assembledText(captured);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('EXT-22 S1 last-word ordering (real deepagents middleware stack)', () => {
  it('appends the path-namespace correction after the composed prompt, with nothing after it', async () => {
    // virtualMode `code` composition: gsloth's prompt + the S2 early note (block 0), then S1.
    const text = await captureAssembledSystemMessage(true, appendVirtualCwdNote(COMPOSED_PROMPT));
    const promptIdx = text.indexOf(COMPOSED_PROMPT);
    const s2Idx = text.indexOf(S2_MARKER);
    const s1Idx = text.indexOf(S1_MARKER);

    // gsloth's composed prompt genuinely survives assembly (this is the real stack, not a copy)...
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(s2Idx).toBeGreaterThan(promptIdx);
    // ...and the S1 correction lands strictly LATER than the S2 early framing it overrides...
    expect(s1Idx).toBeGreaterThan(s2Idx);
    // ...as the final block: the message ends with the guidance S1 appended, so nothing in this
    // stack gets the last word after it. (Non-Anthropic fake model on purpose, so deepagents merges
    // no cache middleware after ours — this pins OUR ordering, not the tail-middleware case.)
    expect(text.trimEnd().endsWith(PATH_NAMESPACE_GUIDANCE)).toBe(true);
  });

  it('is a transparent pass-through when inactive (POSIX real-path mode): no correction block', async () => {
    // Real-path mode composes neither note; the prompt must reach the model untouched by S1.
    const text = await captureAssembledSystemMessage(false, COMPOSED_PROMPT);
    expect(text).toContain(COMPOSED_PROMPT);
    expect(text).not.toContain(S1_MARKER);
    expect(text).not.toContain(PATH_NAMESPACE_GUIDANCE);
  });
});
