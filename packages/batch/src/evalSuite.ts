import { parse as parseYaml } from 'yaml';
import * as z from 'zod';

import { DEFAULT_EVAL_PASS_THRESHOLD } from '#src/evalTypes.js';
import type { EvalCase, EvalSuite } from '#src/evalTypes.js';

/**
 * Raw suite-file shape (snake_case, as authored) — see the BATCH-2 Task 2 brief and
 * `docs/batch-eval-user-requirements.md`'s YAML sketch, trimmed to the single-`prompt`,
 * no-identities, no-fixtures subset this task implements:
 *
 * ```yaml
 * target: { type: gth-agent, profile: default }
 * defaults: { pass_threshold: 6 }
 * cases:
 *   - id: some-case-id
 *     prompt: "the user message to send"
 *     must_contain: [ "foo", "bar" ]
 *     must_not_contain: [ "baz" ]
 *     should_contain_any: [ "x", "y" ]
 *     must_call: [ "mcp__unimarket__*" ]      # BATCH-10: tool-trace assertions (glob supported)
 *     must_not_call: [ "read_file" ]
 *     must_match: [ "\\bRPP-\\d+\\b" ]         # BATCH-10: regex over the answer (author owns flags)
 *     must_not_match: [ "\\bERROR\\b" ]
 *     json_path:                                # BATCH-10: over the answer parsed as JSON
 *       - { path: "$.items[0].scope", equals: "caller" }
 *       - { path: "data.status", contains: "ok" }
 *     judge: "Answers with a ranked summary and correctly formatted values."
 *     pass_threshold: 7
 * ```
 */
const RawJsonPathCheckSchema = z.object({
  path: z.string().min(1, 'json_path entry must have a non-empty path'),
  equals: z.unknown().optional(),
  contains: z.string().optional(),
});

const RawCaseSchema = z.object({
  id: z
    .string()
    .min(1, 'case id must be a non-empty string')
    .regex(
      /^[\w.-]+$/,
      'case id must be a valid filename (alphanumeric, dashes, underscores, dots) — case ids ' +
        'double as output filenames, so path separators and other special characters are rejected'
    ),
  prompt: z.string().min(1, 'case prompt must be a non-empty string'),
  must_contain: z.array(z.string()).optional(),
  must_not_contain: z.array(z.string()).optional(),
  should_contain_any: z.array(z.string()).optional(),
  must_call: z.array(z.string()).optional(),
  must_not_call: z.array(z.string()).optional(),
  must_match: z.array(z.string()).optional(),
  must_not_match: z.array(z.string()).optional(),
  json_path: z.array(RawJsonPathCheckSchema).optional(),
  judge: z.string().optional(),
  pass_threshold: z.number().min(0).max(10).optional(),
});

const RawSuiteSchema = z.object({
  target: z.object({
    type: z.string(),
    profile: z.string().optional(),
  }),
  defaults: z
    .object({
      pass_threshold: z.number().min(0).max(10).optional(),
    })
    .optional(),
  cases: z.array(RawCaseSchema).min(1, 'suite must declare at least one case'),
});

/**
 * Parse and validate an eval suite YAML document into a normalized {@link EvalSuite}.
 *
 * Rejects, with a clear message, at parse time (never silently no-ops or defers to run time):
 * - Malformed YAML.
 * - A suite shape that doesn't match {@link RawSuiteSchema} (missing/wrong-typed fields).
 * - `target.type` other than `"gth-agent"` — pluggable CLI/HTTP targets are out of scope for this
 *   task (see the CLI surface doc's future `target: {type: cli|http}` sketch).
 * - `target.profile` set to anything other than `"default"`/absent — a single suite-wide profile
 *   switch is the same `--identities` direction the brief scopes out; this task's target is always
 *   whatever profile `gth eval` itself was invoked under (`-i/--identity-profile`, if any).
 * - A case `id` containing anything other than alphanumerics, dashes, underscores, or dots (case
 *   ids double as output filenames — see `#src/evalOutput.js` — so a path separator or traversal
 *   sequence like `../../etc/passwd` is rejected here, not sanitized).
 * - A duplicate case `id` (case ids double as output filenames — see `#src/evalOutput.js`).
 * - A case with **no** checks of any kind (`must_contain`/`must_not_contain`/`should_contain_any`/
 *   `must_call`/`must_not_call`/`must_match`/`must_not_match`/`json_path` all absent/empty) **and
 *   no** `judge` rubric: nothing would ever grade it, which is a suite-authoring bug, not a case
 *   that trivially passes.
 * - A `must_match`/`must_not_match` pattern that is not a valid regex (compiled here, at parse
 *   time, so a bad pattern is a suite error rather than a run-time crash mid-suite).
 * - A `json_path` entry that does not set exactly one of `equals`/`contains`.
 *
 * @param yamlText Raw suite file content.
 * @param sourcePath Optional path, only used to make error messages more actionable.
 */
export function parseEvalSuite(yamlText: string, sourcePath?: string): EvalSuite {
  const suffix = sourcePath ? ` (${sourcePath})` : '';

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new Error(
      `Failed to parse eval suite YAML${suffix}: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }

  const parsed = RawSuiteSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid eval suite${suffix}: ${issues}`);
  }
  const data = parsed.data;

  if (data.target.type !== 'gth-agent') {
    throw new Error(
      `Invalid eval suite${suffix}: unsupported target.type "${data.target.type}" — this version ` +
        'of `gth eval` only supports "gth-agent" (pluggable CLI/HTTP targets are future scope).'
    );
  }
  if (data.target.profile !== undefined && data.target.profile !== 'default') {
    throw new Error(
      `Invalid eval suite${suffix}: unsupported target.profile "${data.target.profile}" — ` +
        'per-profile/identity targets are not supported yet (see --identities in ' +
        'docs/batch-eval-cli-surface.md); omit target.profile or set it to "default".'
    );
  }

  const suiteDefaultThreshold = data.defaults?.pass_threshold ?? DEFAULT_EVAL_PASS_THRESHOLD;

  const seenIds = new Set<string>();
  const cases: EvalCase[] = data.cases.map((rawCase, index) => {
    if (seenIds.has(rawCase.id)) {
      throw new Error(`Invalid eval suite${suffix}: duplicate case id "${rawCase.id}".`);
    }
    seenIds.add(rawCase.id);

    const mustContain = rawCase.must_contain ?? [];
    const mustNotContain = rawCase.must_not_contain ?? [];
    const shouldContainAny = rawCase.should_contain_any ?? [];
    const mustCall = rawCase.must_call ?? [];
    const mustNotCall = rawCase.must_not_call ?? [];

    // Compile regex assertions here so an invalid pattern is a parse-time suite error, never a
    // crash partway through a run. The compiled RegExp is stored on the case and reused as-is.
    const compileRegexes = (patterns: string[] | undefined, field: string): RegExp[] =>
      (patterns ?? []).map((pattern) => {
        try {
          return new RegExp(pattern);
        } catch (error) {
          throw new Error(
            `Invalid eval suite${suffix}: case "${rawCase.id}" (index ${index}) has an invalid ` +
              `${field} pattern ${JSON.stringify(pattern)}: ` +
              (error instanceof Error ? error.message : String(error))
          );
        }
      });
    const mustMatch = compileRegexes(rawCase.must_match, 'must_match');
    const mustNotMatch = compileRegexes(rawCase.must_not_match, 'must_not_match');

    // Each json_path entry must set exactly one of equals/contains. `equals` may legitimately be
    // any JSON value including `null`, so presence is `!== undefined` (an explicit null counts).
    const jsonPath = (rawCase.json_path ?? []).map((entry) => {
      const hasEquals = entry.equals !== undefined;
      const hasContains = entry.contains !== undefined;
      if (hasEquals === hasContains) {
        throw new Error(
          `Invalid eval suite${suffix}: case "${rawCase.id}" (index ${index}) json_path entry for ` +
            `"${entry.path}" must set exactly one of "equals" or "contains".`
        );
      }
      return hasContains
        ? { path: entry.path, contains: entry.contains }
        : { path: entry.path, equals: entry.equals };
    });

    const hasChecks =
      mustContain.length > 0 ||
      mustNotContain.length > 0 ||
      shouldContainAny.length > 0 ||
      mustCall.length > 0 ||
      mustNotCall.length > 0 ||
      mustMatch.length > 0 ||
      mustNotMatch.length > 0 ||
      jsonPath.length > 0;
    const judgeRubric = rawCase.judge?.trim();
    const hasJudge = !!judgeRubric;

    if (!hasChecks && !hasJudge) {
      throw new Error(
        `Invalid eval suite${suffix}: case "${rawCase.id}" (index ${index}) has no checks and no ` +
          'judge rubric — a case must declare at least one of must_contain / must_not_contain / ' +
          'should_contain_any / must_call / must_not_call / must_match / must_not_match / ' +
          'json_path, or a judge rubric.'
      );
    }

    return {
      id: rawCase.id,
      prompt: rawCase.prompt,
      mustContain,
      mustNotContain,
      shouldContainAny,
      mustCall,
      mustNotCall,
      mustMatch,
      mustNotMatch,
      jsonPath,
      judgeRubric: hasJudge ? judgeRubric : undefined,
      passThreshold: rawCase.pass_threshold ?? suiteDefaultThreshold,
    };
  });

  return {
    target: { type: 'gth-agent', profile: data.target.profile },
    cases,
  };
}
