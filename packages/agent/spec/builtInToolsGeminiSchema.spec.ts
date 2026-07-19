import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toJsonSchema as langchainToJsonSchema } from '@langchain/core/utils/json_schema';
import { getDefaultTools, AVAILABLE_BUILT_IN_TOOLS } from '#src/builtInToolsConfig.js';
import { DEFAULT_CONFIG } from '#src/config.js';
import type { GthConfig } from '#src/config.js';

/**
 * GS2-56 — regression guard: no built-in default tool's JSON-Schema may contain a keyword that
 * Google Gemini's function-declaration schema (an OpenAPI-3.0 subset) rejects.
 *
 * The bug this guards against: `gth_grep`'s `limit` arg was `z.number().int().positive()`, and
 * zod-4 serialises `.positive()` as JSON-Schema `exclusiveMinimum: 0`. Gemini only accepts
 * `minimum`/`maximum` — it 400s on `exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`
 * (`Invalid JSON payload received. Unknown name "exclusiveMinimum" ... Cannot find field.`), and
 * langchain `@langchain/google` passes those keywords straight through, so EVERY google-genai tool
 * turn crashed at tool-declaration send time (before any tool ran).
 *
 * This is a DENYLIST of exactly that keyword class — NOT an allowlist of supported keywords (that
 * would be the deferred systemic schema sanitizer, out of scope here). It enumerates the real
 * default toolset (filesystem + dev/shell + custom + built-in) via {@link getDefaultTools} so a
 * future offender in ANY built-in tool is caught, not just gth_grep.
 */

/** JSON-Schema keywords in Gemini's OpenAPI-3.0 subset blocklist (it accepts only minimum/maximum). */
const GEMINI_HOSTILE_KEYWORDS = ['exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'] as const;

/** A langchain tool exposes its arg schema (a zod schema here, or a raw JSON schema) as `.schema`. */
interface ToolLike {
  name: string;
  schema?: unknown;
}

/** True for a zod schema (JSON-schema plain objects have no `.safeParse`). */
function isZodSchema(schema: unknown): boolean {
  return !!schema && typeof (schema as { safeParse?: unknown }).safeParse === 'function';
}

/**
 * Serialize a tool's `.schema` to a JSON-Schema object, scanning-ready. A raw JSON schema is used
 * as-is. A zod schema is converted with zod-4's own `z.toJSONSchema` — the exact path the guarded
 * bug travels (gth_grep's `.positive()` → `exclusiveMinimum`). Two fallbacks keep EVERY tool
 * covered rather than silently skipped:
 *  - `z.toJSONSchema` throws on unrepresentable types by default; the three numeric keywords we scan
 *    for are always representable, so `{ unrepresentable: 'any' }` sidesteps an out-of-scope abort
 *    without hiding an offender.
 *  - langchain wraps a non-object tool schema (e.g. a bare `z.string()`, as gth_web_fetch /
 *    gth_status_update use) into a zod-v3 interop schema that zod-4's `z.toJSONSchema` can't read;
 *    convert those with langchain's OWN `toJsonSchema` — the same converter that builds the Gemini
 *    wire schema — so those tools are still checked.
 */
function toJsonSchema(schema: unknown): unknown {
  if (!isZodSchema(schema)) return schema;
  const zodSchema = schema as Parameters<typeof z.toJSONSchema>[0];
  try {
    return z.toJSONSchema(zodSchema);
  } catch {
    try {
      return z.toJSONSchema(zodSchema, { unrepresentable: 'any' });
    } catch {
      // zod-v3 interop schema (langchain-wrapped non-object schema) — use langchain's converter.
      return langchainToJsonSchema(schema as Parameters<typeof langchainToJsonSchema>[0]);
    }
  }
}

/**
 * Recursively collect the paths of any denylisted keyword that appears as an OBJECT KEY (not as a
 * substring of a description string — a `.describe('… multipleOf …')` must not false-positive).
 */
function findHostileKeywordPaths(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findHostileKeywordPaths(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if ((GEMINI_HOSTILE_KEYWORDS as readonly string[]).includes(key)) {
        out.push(childPath);
      }
      findHostileKeywordPaths(value, childPath, out);
    }
  }
}

/**
 * The real default toolset with maximum coverage: filesystem `all`, `code` command (adds the
 * dev/shell toolkit), and every entry in {@link AVAILABLE_BUILT_IN_TOOLS} enabled (so gth_grep AND
 * gth_checklist and the rest are all present). Based on DEFAULT_CONFIG so the shell-policy / code
 * path doesn't trip on a missing field.
 */
async function getEnumeratedTools(): Promise<ToolLike[]> {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: 'all',
    builtInTools: Object.keys(AVAILABLE_BUILT_IN_TOOLS),
  } as unknown as GthConfig;
  return (await getDefaultTools(config, 'code')) as unknown as ToolLike[];
}

describe('built-in tool schemas are Gemini-compatible (GS2-56 regression guard)', () => {
  it('covers the target tools (gth_grep + gth_checklist are in the enumerated set)', async () => {
    const names = (await getEnumeratedTools()).map((t) => t.name);
    expect(names).toContain('gth_grep');
    expect(names).toContain('gth_checklist');
  });

  it('emits no exclusiveMinimum/exclusiveMaximum/multipleOf in any default tool schema', async () => {
    const tools = await getEnumeratedTools();
    expect(tools.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const tool of tools) {
      const jsonSchema = toJsonSchema(tool.schema);
      const paths: string[] = [];
      findHostileKeywordPaths(jsonSchema, '', paths);
      if (paths.length > 0) {
        offenders.push(`${tool.name}: ${paths.join(', ')}`);
      }
    }

    // A named offender here means a built-in tool ships a Gemini-hostile keyword — e.g. gth_grep's
    // `limit` before GS2-56 (`.positive()` → exclusiveMinimum). Use `.min(1)` / `.max(n)` instead
    // of `.positive()` / `.gt()` / `.lt()`, and avoid `.multipleOf()`, in any default tool schema.
    expect(
      offenders,
      `Gemini-hostile JSON-Schema keyword(s) in default tool schema(s):\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });
});
