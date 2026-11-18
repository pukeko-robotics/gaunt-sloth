/**
 * BATCH-57 — the transcript-decoder registry, modelled on the reporter registry
 * (`reporters/registry.ts`): built-ins keyed by name, with a `custom` overlay through one path.
 *
 * A suite's `target.transcript` is either a built-in name or a path to a module whose default export
 * is a {@link TranscriptDecoder}. The path form is the custom-decoder seam. It is deliberately the
 * whole seam: a decoder belongs to the suite that runs the command it decodes, so it is named where
 * the command is, rather than registered in a config file that every suite would share.
 *
 * @module
 */
import { CLAUDE_STREAM_JSON, decodeClaudeStreamJson } from '#src/transcripts/claudeStreamJson.js';
import type { TranscriptDecoder } from '#src/transcripts/transcriptTypes.js';

const BUILTIN_DECODERS: Record<string, TranscriptDecoder> = {
  [CLAUDE_STREAM_JSON]: decodeClaudeStreamJson,
};

/** The built-in decoder names, for help text and error messages. */
export function builtInTranscriptDecoderNames(): string[] {
  return Object.keys(BUILTIN_DECODERS);
}

/**
 * Whether `spec` names a decoder MODULE rather than a built-in: a relative or absolute path (the
 * same test the reporter loader applies to a module string), or a file with a JavaScript extension.
 */
export function isTranscriptDecoderModulePath(spec: string): boolean {
  return (
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    spec.startsWith('file:') ||
    /^[a-zA-Z]:[\\/]/.test(spec) ||
    /\.(?:m|c)?js$/.test(spec)
  );
}

/**
 * Resolve a decoder by name. `custom` overlays the built-ins (a custom entry wins on a collision);
 * a name found in neither throws with the available list.
 */
export function resolveTranscriptDecoder(
  name: string,
  custom: Record<string, TranscriptDecoder> = {}
): TranscriptDecoder {
  const registry: Record<string, TranscriptDecoder> = { ...BUILTIN_DECODERS, ...custom };
  const decoder = registry[name];
  if (!decoder) {
    throw new Error(
      `unknown transcript decoder "${name}". Available decoders: ` +
        `${Object.keys(registry).join(', ')}, or a path to a decoder module (./my-decoder.mjs).`
    );
  }
  return decoder;
}
