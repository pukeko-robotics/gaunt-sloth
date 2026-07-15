import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '#src/config/loader.js';

/**
 * Effective-merged acceptance gate (B2b). Runs the real example configs and the consumer-shaped
 * fixture through the SAME merge pipeline the loader uses (resolveConfig: deep-merge with
 * DEFAULT_CONFIG + per-command merge + array policy) and pins the effective output via a committed
 * snapshot. If the array merge policy (or any merge change) silently shifts how a real config
 * resolves, the snapshot breaks. The example configs use only canonical names (2.0 rejects the
 * deprecated shapes outright — see GS2-28), so no pre-map step is involved.
 *
 * `resolveConfig` is the pure merge (no LLM instantiation, no global side effects), so `llm`
 * stays the raw spec object — fine for a deterministic snapshot.
 */
const here = resolve(fileURLToPath(import.meta.url), '..');
const repoRoot = resolve(here, '..', '..', '..');

function effective(raw: Record<string, unknown>): Record<string, unknown> {
  return resolveConfig(structuredClone(raw) as never, {}) as unknown as Record<string, unknown>;
}

function readExample(relPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, relPath), 'utf8'));
}

describe('effective-merged acceptance (B2b)', () => {
  it.each([
    'examples/jira-mcp/.gsloth.config.json',
    'examples/lmstudio/.gsloth.config.json',
    'examples/a2a/.gsloth.config.json',
    'examples/simple-DIY-helper/.gsloth.config.json',
  ])('resolves %s to a stable effective config', (relPath) => {
    expect(effective(readExample(relPath))).toMatchSnapshot();
  });

  it('resolves the consumer-shaped fixture to a stable effective config', () => {
    const fixture = {
      llm: { type: 'openai', model: 'gpt-5.4', configuration: { temperature: 0.7 } },
      builtInTools: ['show_a2ui_surface'],
      streamOutput: true,
      commands: {
        api: {
          port: 3000,
          cors: {
            allowOrigin: 'http://localhost:5555',
            allowMethods: 'POST, GET, OPTIONS',
            allowHeaders: 'Content-Type, Accept',
          },
        },
      },
    };
    expect(effective(fixture)).toMatchSnapshot();
  });
});
