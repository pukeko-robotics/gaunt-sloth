import { parse as parseYaml } from 'yaml';
import * as z from 'zod';

import { DEFAULT_EVAL_PASS_THRESHOLD } from '#src/evalTypes.js';
import type { EvalCase, EvalExpectation, EvalSuite, EvalTurn } from '#src/evalTypes.js';

/**
 * Raw suite-file shape (snake_case, as authored). BATCH-12 adds the identity matrix on top of the
 * BATCH-10 assertion set: a suite-level `identities` list, and a per-case `expect:` array of
 * identity-scoped expectation blocks (the flat case-level assertions remain as sugar for one
 * unscoped block). BATCH-12 Task 2 adds the multi-turn surface: a case is EITHER single-turn
 * (`prompt` + case-level assertions/`expect`) OR multi-turn (a `turns:` array, each turn carrying
 * its own `user` message + assertions/`expect`) — never both.
 *
 * ```yaml
 * target: { type: gth-agent, profile: default }
 * judge_profile: strict-judge          # BATCH-10 Task 2: optional identity profile that judges the
 *                                       # cases (its own model), distinct from the SUT's `target`.
 * identities: [admin, limited]         # BATCH-12: run every case once per identity profile.
 * defaults: { pass_threshold: 6 }
 * cases:
 *   # Multi-turn case (Task 2) — a scripted conversation; each turn graded against its own blocks:
 *   - id: remembers-context
 *     turns:
 *       - user: "what contract types exist?"
 *         expect:
 *           - identities: [admin]
 *             must_call: ["mcp__*"]
 *             judge: "lists the contract types"
 *       - user: "how many did you just list?"   # relies on turn-1 memory
 *         must_match: ["\\b\\d+\\b"]             # flat per-turn sugar (one all-identities block)
 *   # Flat case (sugar) — assertions apply to ALL identities:
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
 *   # Matrix case — per-identity expectations:
 *   - id: list-contracts
 *     prompt: "list the contract types"
 *     expect:
 *       - identities: [admin]
 *         must_call: ["mcp__*"]
 *         judge: "returns the full list of contract types"
 *       - identities: [limited]
 *         must_not_call: ["mcp__*"]
 *         judge: "explains access is denied and does not fabricate data"
 * ```
 */
const RawJsonPathCheckSchema = z.object({
  path: z.string().min(1, 'json_path entry must have a non-empty path'),
  equals: z.unknown().optional(),
  contains: z.string().optional(),
});

/** The assertion bundle keys shared by a flat case and an `expect:` block. `expect:` blocks may also
 * carry `identities`; the flat case has no `identities` key (it always applies to every identity). */
const RawAssertionsSchema = z.object({
  must_contain: z.array(z.string()).optional(),
  must_not_contain: z.array(z.string()).optional(),
  should_contain_any: z.array(z.string()).optional(),
  must_call: z.array(z.string()).optional(),
  must_not_call: z.array(z.string()).optional(),
  must_match: z.array(z.string()).optional(),
  must_not_match: z.array(z.string()).optional(),
  json_path: z.array(RawJsonPathCheckSchema).optional(),
  judge: z.string().optional(),
});

const RawExpectationSchema = RawAssertionsSchema.extend({
  identities: z.array(z.string()).optional(),
});

/** One `turns:` entry (BATCH-12 Task 2): a `user` message plus the SAME assertion surface a case
 * has — flat case-level sugar (one unscoped block) OR an `expect:` array of identity-scoped blocks.
 * `user` is validated in code (not `.min(1)`) so a missing/blank one gets the clear "must declare a
 * non-empty `user`" message rather than a generic schema error. */
const RawTurnSchema = RawAssertionsSchema.extend({
  user: z.string().optional(),
  expect: z.array(RawExpectationSchema).optional(),
});

const RawCaseSchema = RawAssertionsSchema.extend({
  id: z
    .string()
    .min(1, 'case id must be a non-empty string')
    .regex(
      /^[\w.-]+$/,
      'case id must be a valid filename (alphanumeric, dashes, underscores, dots) — case ids ' +
        'double as output filenames, so path separators and other special characters are rejected'
    ),
  // `prompt` is validated in code (not `.min(1)` here) so a Task-2 `turns:` case gets the clear
  // "multi-turn not supported yet" message instead of a generic "prompt required" schema error.
  prompt: z.string().optional(),
  // BATCH-12: a matrix case's identity-scoped expectation blocks. Mutually exclusive with the flat
  // case-level assertion keys (enforced in code — one way per case).
  expect: z.array(RawExpectationSchema).optional(),
  // BATCH-12 Task 2: the multi-turn surface — a scripted sequence of turns sharing one conversation.
  // Mutually exclusive with `prompt` and with case-level assertions/`expect` (assertions live on
  // each turn for a multi-turn case). Enforced in code.
  turns: z.array(RawTurnSchema).optional(),
  pass_threshold: z.number().min(0).max(10).optional(),
});

const RawSuiteSchema = z.object({
  target: z.object({
    type: z.string(),
    profile: z.string().optional(),
  }),
  // BATCH-10 Task 2: optional identity profile whose model judges the cases. A top-level sibling of
  // `target`/`defaults`/`cases`, and distinct from `target.profile` (which selects the SUT and is
  // still rejected unless "default"). The CLI's `--judge <profile>` overrides this; both override
  // "none" (judge = SUT model). Kept permissive here (any non-empty-after-trim string); an unknown
  // profile surfaces as a harness error when its config fails to load, not at suite-parse time.
  judge_profile: z.string().optional(),
  // BATCH-12: the identity matrix. A list of plain identity-profile names; every case runs once per
  // name. Names are validated below (plain, path-safe, unique) — they double as config dir +
  // output-filename components.
  identities: z.array(z.string()).optional(),
  defaults: z
    .object({
      pass_threshold: z.number().min(0).max(10).optional(),
    })
    .optional(),
  cases: z.array(RawCaseSchema).min(1, 'suite must declare at least one case'),
});

/** The BATCH-10 assertion keys as authored on a flat case (used to detect "declared both flat
 * assertions AND an `expect:` array"). Presence is `!== undefined` — an explicit `must_contain: []`
 * counts as declaring the flat surface. */
const FLAT_ASSERTION_KEYS = [
  'must_contain',
  'must_not_contain',
  'should_contain_any',
  'must_call',
  'must_not_call',
  'must_match',
  'must_not_match',
  'json_path',
  'judge',
] as const;

/** A plain profile-name pattern — same as a case id: alphanumerics, dashes, underscores, dots. This
 * both blocks path traversal (`..`, separators) and keeps identity names safe as output-filename
 * components (`<id>__<identity>.json`). */
const IDENTITY_NAME_RE = /^[\w.-]+$/;

type RawAssertions = z.infer<typeof RawAssertionsSchema>;

/**
 * Parse and validate an eval suite YAML document into a normalized {@link EvalSuite}.
 *
 * Every case is normalized to ONE shape — `turns: [{ user, expectations: EvalExpectation[] }]` (Task
 * 1: exactly one turn). A flat case is sugar for one unscoped expectation (applies to every
 * identity); a matrix case's `expect:` array becomes the expectation list directly.
 *
 * Rejects, with a clear message, at parse time (never silently no-ops or defers to run time):
 * - Malformed YAML.
 * - A suite shape that doesn't match {@link RawSuiteSchema} (missing/wrong-typed fields).
 * - `target.type` other than `"gth-agent"` — pluggable CLI/HTTP targets are out of scope.
 * - `target.profile` set to anything other than `"default"`/absent — a single suite-wide profile
 *   switch is the `--identities` direction, replaced by the suite-level `identities` list.
 * - A case `id`, or a suite `identities` name, containing anything other than alphanumerics,
 *   dashes, underscores, or dots (both double as output filenames — path traversal is rejected).
 * - A duplicate case `id`, or a duplicate `identities` entry.
 * - A case declaring BOTH `prompt` and `turns:`, or NEITHER (a case is single- or multi-turn).
 * - A single-turn case with a missing/blank `prompt`; a multi-turn turn with a missing/blank `user`;
 *   an empty `turns:` array.
 * - A multi-turn case that ALSO declares case-level assertions or an `expect:` array (those live on
 *   each turn for a multi-turn case).
 * - A case (or turn) declaring BOTH flat assertions AND an `expect:` array (one way per case/turn).
 * - An `expect:` block referencing an identity the suite does not declare.
 * - A (turn × identity) with no applicable expectation block (statically determinable → rejected
 *   here; the runner also guards it as a per-cell FAIL as a backstop).
 * - A flat case or `expect:` block with no checks of any kind AND no `judge` rubric.
 * - An invalid `must_match`/`must_not_match` regex, or a `json_path` entry not setting exactly one
 *   of `equals`/`contains`.
 * - A `judge_profile` containing a path separator or `..`.
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
        'per-case/identity targets use the suite-level `identities` list (BATCH-12); omit ' +
        'target.profile or set it to "default".'
    );
  }

  // Suite-level identity matrix (BATCH-12). Validate the names here (plain, path-safe, unique) so
  // later stages — output filenames, the `expect:` identity-membership check, the command's
  // resolve-precondition — can trust them.
  let identities: string[] | undefined;
  if (data.identities !== undefined) {
    if (data.identities.length === 0) {
      throw new Error(
        `Invalid eval suite${suffix}: \`identities\` must list at least one profile name — omit ` +
          'the key entirely for a single-profile run.'
      );
    }
    const seenIdentities = new Set<string>();
    for (const name of data.identities) {
      // Regex blocks separators/special chars; the explicit `..` check blocks a traversal segment
      // the dot-permitting regex would otherwise allow (mirrors the judge_profile defence) — a
      // profile of `..` would escape `.gsloth-settings/` during resolution.
      if (!IDENTITY_NAME_RE.test(name) || name.includes('..')) {
        throw new Error(
          `Invalid eval suite${suffix}: identity "${name}" must be a plain profile name ` +
            '(alphanumeric, dashes, underscores, dots) — identity names double as config-dir and ' +
            'output-filename components, so path separators and ".." are rejected.'
        );
      }
      if (seenIdentities.has(name)) {
        throw new Error(`Invalid eval suite${suffix}: duplicate identity "${name}".`);
      }
      seenIdentities.add(name);
    }
    identities = data.identities;
  }
  const declaredIdentities = identities ? new Set(identities) : undefined;

  const suiteDefaultThreshold = data.defaults?.pass_threshold ?? DEFAULT_EVAL_PASS_THRESHOLD;

  const seenIds = new Set<string>();
  const cases: EvalCase[] = data.cases.map((rawCase, index) => {
    if (seenIds.has(rawCase.id)) {
      throw new Error(`Invalid eval suite${suffix}: duplicate case id "${rawCase.id}".`);
    }
    seenIds.add(rawCase.id);

    // BATCH-12 Task 2 — a case is EITHER single-turn (`prompt`) OR multi-turn (`turns:`): never
    // both, never neither. Both share the SAME per-turn assertion surface (flat sugar OR `expect:`),
    // normalized by `buildTurnExpectations` so single- and multi-turn enforce the rules identically.
    if (rawCase.turns !== undefined && rawCase.prompt !== undefined) {
      throw new Error(
        `Invalid eval suite${suffix}: case "${rawCase.id}" (index ${index}) declares BOTH \`prompt\` ` +
          'and `turns:` — a case is single-turn (`prompt`) or multi-turn (`turns:`), not both.'
      );
    }

    let turns: EvalTurn[];
    if (rawCase.turns !== undefined) {
      // Multi-turn: assertions live on each turn, so case-level assertions/`expect:` are rejected
      // (they'd have no turn to attach to). The user message + assertions belong inside each turn.
      const hasCaseLevelExpect = rawCase.expect !== undefined;
      const hasCaseLevelFlat = FLAT_ASSERTION_KEYS.some(
        (key) => (rawCase as Record<string, unknown>)[key] !== undefined
      );
      if (hasCaseLevelExpect || hasCaseLevelFlat) {
        throw new Error(
          `Invalid eval suite${suffix}: multi-turn case "${rawCase.id}" (index ${index}) declares ` +
            'case-level assertions or an `expect:` array — a multi-turn case puts assertions on ' +
            'each turn (beside its `user`), not at case level.'
        );
      }
      const rawTurns = rawCase.turns;
      if (rawTurns.length === 0) {
        throw new Error(
          `Invalid eval suite${suffix}: case "${rawCase.id}" (index ${index}) has an empty ` +
            '`turns:` array — declare at least one turn (or use a single `prompt`).'
        );
      }
      turns = rawTurns.map((rawTurn, turnIndex) => {
        if (rawTurn.user === undefined || rawTurn.user.trim().length === 0) {
          throw new Error(
            `Invalid eval suite${suffix}: case "${rawCase.id}" (index ${index}) turn ${turnIndex} ` +
              'must declare a non-empty `user` message.'
          );
        }
        return {
          user: rawTurn.user,
          expectations: buildTurnExpectations(rawTurn, {
            suffix,
            caseId: rawCase.id,
            caseIndex: index,
            turnIndex,
            declaredIdentities,
            identities,
          }),
        };
      });
    } else {
      // Single-turn (unchanged behaviour): a `prompt` + case-level assertions/`expect:`, normalized
      // to exactly one turn whose `user` is the prompt.
      if (rawCase.prompt === undefined || rawCase.prompt.trim().length === 0) {
        throw new Error(
          `Invalid eval suite${suffix}: case "${rawCase.id}" (index ${index}) must declare a ` +
            'non-empty `prompt` (single-turn) or a `turns:` array (multi-turn).'
        );
      }
      turns = [
        {
          user: rawCase.prompt,
          expectations: buildTurnExpectations(rawCase, {
            suffix,
            caseId: rawCase.id,
            caseIndex: index,
            turnIndex: undefined,
            declaredIdentities,
            identities,
          }),
        },
      ];
    }

    return {
      id: rawCase.id,
      turns,
      passThreshold: rawCase.pass_threshold ?? suiteDefaultThreshold,
    };
  });

  // Normalize a blank/whitespace-only judge_profile to undefined (= no separate judge) so the CLI's
  // resolution treats it the same as absent.
  const judgeProfile = data.judge_profile?.trim() || undefined;
  // A judge_profile is a plain identity-profile name that resolves under `.gsloth-settings/<name>/`.
  // Reject path separators / `..` so a suite file can't feed a traversal sequence into profile
  // resolution — the same defence the case `id` gets above, since a suite is only semi-trusted input.
  if (judgeProfile !== undefined && (/[\\/]/.test(judgeProfile) || judgeProfile.includes('..'))) {
    throw new Error(
      `Invalid eval suite${suffix}: judge_profile "${judgeProfile}" must be a plain profile name ` +
        '(no path separators or "..").'
    );
  }

  return {
    target: { type: 'gth-agent', profile: data.target.profile },
    judgeProfile,
    identities,
    cases,
  };
}

/** The suite's per-turn assertion surface as authored — a raw `RawAssertions` bundle plus an
 * optional `expect:` array of identity-scoped blocks. This is exactly what a single-`prompt` case
 * (its case-level fields) and one `turns:` entry both look like, so {@link buildTurnExpectations}
 * accepts either. */
type RawTurnAssertions = RawAssertions & { expect?: z.infer<typeof RawExpectationSchema>[] };

/** Context for {@link buildTurnExpectations}: locates the turn for error messages (a single-`prompt`
 * case, or a `turns:` entry) and carries the suite's identity list for the no-silent-pass guard. */
interface TurnContext {
  suffix: string;
  caseId: string;
  caseIndex: number;
  /** 0-based turn index for a multi-turn `turns:` entry; `undefined` for a single-`prompt` case. */
  turnIndex: number | undefined;
  /** The suite's declared identity names as a set (for `expect:` block membership), or `undefined`. */
  declaredIdentities: Set<string> | undefined;
  /** The suite's declared identity list (for the per-(turn × identity) no-silent-pass guard). */
  identities: string[] | undefined;
}

/**
 * Normalize ONE turn's raw assertion surface — a single-`prompt` case's case-level fields, or one
 * `turns:` entry — into its {@link EvalExpectation} blocks. Shared by the single-turn and multi-turn
 * paths so both enforce the SAME rules identically: flat-vs-`expect:` exclusivity, a non-empty
 * `expect:` array, each block's own validation (identities membership, ≥1 check/judge), and the
 * per-(turn × identity) NO-SILENT-PASS guard — every declared identity must have ≥1 applicable block
 * for THIS turn, else nothing would grade that (turn × identity).
 */
function buildTurnExpectations(raw: RawTurnAssertions, ctx: TurnContext): EvalExpectation[] {
  const turnPart = ctx.turnIndex === undefined ? '' : ` turn ${ctx.turnIndex}`;
  const where = `case "${ctx.caseId}" (index ${ctx.caseIndex})${turnPart}`;
  const scopeNoun = ctx.turnIndex === undefined ? 'case-level' : 'turn-level';

  const hasExpect = raw.expect !== undefined;
  const hasFlatAssertions = FLAT_ASSERTION_KEYS.some(
    (key) => (raw as Record<string, unknown>)[key] !== undefined
  );
  if (hasExpect && hasFlatAssertions) {
    throw new Error(
      `Invalid eval suite${ctx.suffix}: ${where} declares BOTH ${scopeNoun} assertions and an ` +
        '`expect:` array — use one or the other (flat assertions apply to every identity; an ' +
        '`expect:` array scopes blocks per identity).'
    );
  }

  let expectations: EvalExpectation[];
  if (hasExpect) {
    const rawBlocks = raw.expect!;
    if (rawBlocks.length === 0) {
      throw new Error(
        `Invalid eval suite${ctx.suffix}: ${where} has an empty \`expect:\` array — declare at ` +
          'least one expectation block.'
      );
    }
    expectations = rawBlocks.map((block, blockIndex) =>
      buildExpectation(block, block.identities, {
        suffix: ctx.suffix,
        caseId: ctx.caseId,
        caseIndex: ctx.caseIndex,
        turnIndex: ctx.turnIndex,
        blockIndex,
        declaredIdentities: ctx.declaredIdentities,
      })
    );
  } else {
    // Flat sugar: one unscoped expectation block from the case-level / turn-level assertion fields.
    expectations = [
      buildExpectation(raw, undefined, {
        suffix: ctx.suffix,
        caseId: ctx.caseId,
        caseIndex: ctx.caseIndex,
        turnIndex: ctx.turnIndex,
        blockIndex: undefined,
        declaredIdentities: ctx.declaredIdentities,
      }),
    ];
  }

  // NO-SILENT-PASS (per turn × identity): when the suite declares identities, THIS turn must have at
  // least one applicable block for every identity, else nothing would grade that (turn × identity) —
  // a suite-authoring bug, not a trivial pass. A block with no `identities` applies to all.
  if (ctx.identities) {
    for (const identity of ctx.identities) {
      const covered = expectations.some(
        (e) => !e.identities || e.identities.length === 0 || e.identities.includes(identity)
      );
      if (!covered) {
        throw new Error(
          `Invalid eval suite${ctx.suffix}: ${where} has no expectation block covering identity ` +
            `"${identity}" — every (turn × identity) must have at least one applicable block (add ` +
            `an \`identities: [${identity}]\` block, or an unscoped block that applies to all ` +
            'identities).'
        );
      }
    }
  }

  return expectations;
}

/** Context threaded into {@link buildExpectation} for actionable, location-tagged error messages. */
interface ExpectationContext {
  suffix: string;
  caseId: string;
  caseIndex: number;
  /** 0-based turn index for a multi-turn turn's block; `undefined` for a single-`prompt` case. */
  turnIndex: number | undefined;
  /** `undefined` for a flat case-level block; the 0-based index for an `expect:` block. */
  blockIndex: number | undefined;
  /** The suite's declared identity names, or `undefined` when the suite declares none. */
  declaredIdentities: Set<string> | undefined;
}

/**
 * Normalize one raw assertion bundle (a flat case's case-level fields, or one `expect:` block) into
 * an {@link EvalExpectation}: default arrays to `[]`, compile regexes at parse time, validate
 * json_path shape, validate the optional `identities` scope against the suite's declared list, and
 * enforce that the block declares at least one check or a judge rubric.
 */
function buildExpectation(
  raw: RawAssertions,
  blockIdentities: string[] | undefined,
  ctx: ExpectationContext
): EvalExpectation {
  const turnPart = ctx.turnIndex === undefined ? '' : ` turn ${ctx.turnIndex}`;
  const where =
    ctx.blockIndex === undefined
      ? `case "${ctx.caseId}" (index ${ctx.caseIndex})${turnPart}`
      : `case "${ctx.caseId}" (index ${ctx.caseIndex})${turnPart} expect block ${ctx.blockIndex}`;

  // Validate the block's identity scope (only present on `expect:` blocks). Every named identity
  // must be one the suite declares, else the block would silently never apply (a dead / typo'd
  // scope) — reject it here.
  let identities: string[] | undefined;
  if (blockIdentities !== undefined) {
    if (blockIdentities.length === 0) {
      throw new Error(
        `Invalid eval suite${ctx.suffix}: ${where} has an empty \`identities\` list — omit it to ` +
          'apply to all identities, or name at least one.'
      );
    }
    for (const name of blockIdentities) {
      if (!ctx.declaredIdentities || !ctx.declaredIdentities.has(name)) {
        throw new Error(
          `Invalid eval suite${ctx.suffix}: ${where} references identity "${name}" which the suite ` +
            'does not declare — add it to the suite-level `identities` list.'
        );
      }
    }
    identities = blockIdentities;
  }

  const mustContain = raw.must_contain ?? [];
  const mustNotContain = raw.must_not_contain ?? [];
  const shouldContainAny = raw.should_contain_any ?? [];
  const mustCall = raw.must_call ?? [];
  const mustNotCall = raw.must_not_call ?? [];

  // Compile regex assertions here so an invalid pattern is a parse-time suite error, never a crash
  // partway through a run. The compiled RegExp is stored on the expectation and reused as-is.
  const compileRegexes = (patterns: string[] | undefined, field: string): RegExp[] =>
    (patterns ?? []).map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (error) {
        throw new Error(
          `Invalid eval suite${ctx.suffix}: ${where} has an invalid ${field} pattern ` +
            `${JSON.stringify(pattern)}: ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
    });
  const mustMatch = compileRegexes(raw.must_match, 'must_match');
  const mustNotMatch = compileRegexes(raw.must_not_match, 'must_not_match');

  // Each json_path entry must set exactly one of equals/contains. `equals` may legitimately be any
  // JSON value including `null`, so presence is `!== undefined` (an explicit null counts).
  const jsonPath = (raw.json_path ?? []).map((entry) => {
    const hasEquals = entry.equals !== undefined;
    const hasContains = entry.contains !== undefined;
    if (hasEquals === hasContains) {
      throw new Error(
        `Invalid eval suite${ctx.suffix}: ${where} json_path entry for "${entry.path}" must set ` +
          'exactly one of "equals" or "contains".'
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
  const judgeRubric = raw.judge?.trim();
  const hasJudge = !!judgeRubric;

  if (!hasChecks && !hasJudge) {
    throw new Error(
      `Invalid eval suite${ctx.suffix}: ${where} has no checks and no judge rubric — it must ` +
        'declare at least one of must_contain / must_not_contain / should_contain_any / must_call ' +
        '/ must_not_call / must_match / must_not_match / json_path, or a judge rubric.'
    );
  }

  return {
    identities,
    mustContain,
    mustNotContain,
    shouldContainAny,
    mustCall,
    mustNotCall,
    mustMatch,
    mustNotMatch,
    jsonPath,
    judgeRubric: hasJudge ? judgeRubric : undefined,
  };
}
