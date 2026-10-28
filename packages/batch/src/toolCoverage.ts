/**
 * @packageDocumentation
 * BATCH-32 — **tool coverage**: which of the tools the agent actually advertised to the model a
 * suite exercised, and which it never touched.
 *
 * The numerator has existed since GS2-16 (`runStats.tools`, per cell, already in every
 * `<case>.json`). What was missing is the DENOMINATOR: a run that calls 3 of 41 advertised tools
 * prints the same all-green summary as one that calls all 41, so "every cell passed" reads as
 * reassurance it has not earned, and coverage decays silently as the server grows a 42nd tool
 * nobody wrote a case for.
 *
 * Pure and dependency-free on purpose (the `classificationReport.ts` precedent): every input is
 * handed in, so the whole facility is unit-testable without an agent, an MCP server or a model.
 *
 * ## The denominator is the FULL advertised list, and that is the design decision here
 *
 * The list the agent binds is narrowed by `allowedTools` before it is bound. Taking the denominator
 * from the narrowed list would let any suite reach 100% by narrowing the allow-list to the tools it
 * already calls — the tools nobody exercises would leave the bottom of the fraction instead of being
 * named. So the denominator is the pre-filter inventory, and the removed tools are reported as their
 * own {@link ToolCoverageReport.filteredOut} category.
 *
 * ## What "covered" means, stated in the output rather than assumed
 *
 * A tool counts as covered when it was **called**. A call whose result came back an error still
 * counts: the tool was reached, which is what a coverage figure measures. Grading what a tool
 * RETURNED is what `must_error` / `tool_result_json_path` assertions are for, and they are a
 * different question asked per case.
 */
import { toolNameMatchesPattern } from '@gaunt-sloth/core/utils/toolMatching.js';

/**
 * One advertised tool, as the batch layer carries it — a structural mirror of core's
 * `GthAdvertisedTool`, kept local for the same reason `ToolResultRecord` (`#src/types.js`) is: this
 * package's outcome shapes stay independent of the runner/LLM types.
 */
export interface AdvertisedToolRecord {
  /** The registered tool name, exactly as the model would call it. */
  name: string;
  /**
   * The `mcpServers` key the tool was loaded under, from the bindings recorded at tool load.
   * Absent for a tool outside the MCP namespace (a built-in or a user-configured one); the empty
   * string for an MCP-namespaced name with no binding.
   */
  server?: string;
}

/**
 * One run's advertised-tool inventory, as captured by the agent at `init` — a structural mirror of
 * core's `GthAdvertisedTools`.
 */
export interface AdvertisedToolInventory {
  /** Every named tool the agent loaded, BEFORE any `allowedTools` narrowing. */
  tools: AdvertisedToolRecord[];
  /** The subset an `allowedTools` allow-list removed. Empty when no allow-list is configured. */
  filteredOut: AdvertisedToolRecord[];
  /** How many loaded tools carry no name — counted in neither half of the fraction. */
  unnamed: number;
}

/**
 * A suite's `tool_coverage:` declaration: which tools are deliberately not covered, and what would
 * make the run fail.
 */
export interface ToolCoverageSpec {
  /**
   * Globs (the `must_call` matcher) whose matching advertised tools LEAVE the denominator.
   *
   * Load-bearing, not a nicety: a read-only suite must not be shamed for never calling the mutating
   * tools, and without waivers any real server's coverage starts red and is then ignored — which is
   * the same failure as a metric nobody reads. A deliberate decision not to cover something belongs
   * in the suite, where it is reviewable, rather than in a comment.
   */
  waive: string[];
  /**
   * Optional floor: the minimum percentage (0-100) of the post-waiver denominator that must have
   * been exercised. Breaching it is a product signal, graded like a declared metric gate.
   */
  min?: number;
  /**
   * Globs that must EACH match at least one exercised tool, whatever the percentage says. A floor
   * answers "is enough of the surface covered"; this answers "was this specific tool reached", which
   * a percentage can always satisfy by covering something else.
   */
  require: string[];
}

/** One bucket of the per-server breakdown. */
export interface ToolCoverageServerReport {
  /**
   * Which kind of bucket this is — explicit rather than encoded in {@link server}, so a JSON reader
   * never has to tell "no server" from "a server named empty", and so a configured key cannot
   * collide with a label this file made up.
   */
  kind: 'mcp' | 'builtin' | 'unresolved';
  /** The `mcpServers` key, for a `mcp` bucket only. */
  server?: string;
  /** Exercised tool names in this bucket (post-waiver). */
  covered: string[];
  /** Advertised-but-never-called names in this bucket (post-waiver). */
  uncovered: string[];
}

/**
 * The coverage block written to `results.json` and rendered on the console.
 *
 * Name LISTS rather than counts, deliberately: a directory run's aggregate is a set union across
 * suites (the same 41-tool server advertised to every suite must be counted once, not once per
 * suite), and counts cannot be unioned. `n/N` is `covered.length` over `covered.length +
 * uncovered.length`.
 */
export interface ToolCoverageReport {
  /** Advertised AND exercised, after waivers — the numerator. */
  covered: string[];
  /** Advertised, not waived, never called — the names the report exists to print. */
  uncovered: string[];
  /**
   * Advertised names a `waive:` glob removed from the denominator, reported BESIDE the fraction.
   *
   * A waived tool leaves the denominator, so a suite waiving 38 of 41 reports 100% while covering
   * three. Printing the waived count next to the number is what stops that reading as full coverage
   * — the blind-denominator shape a metric facility cannot afford, because its whole value is being
   * trusted.
   */
  waived: string[];
  /** Advertised names an `allowedTools` allow-list removed before the agent bound them. */
  filteredOut: string[];
  /** Nameless provider-native tools, counted in neither half (there is no name to count). */
  unnamed: number;
  /** Per-server breakdown — a single percentage hides which server is uncovered. */
  byServer: ToolCoverageServerReport[];
  /** Everything that makes the figure mean less than it appears to. Never silently dropped. */
  warnings: string[];
  /**
   * Breached `min` / unmet `require:` entries. Non-empty forces the run's exit code to 1 through the
   * same contract a breached metric gate uses — a product signal, never a harness one.
   */
  gateFailures: string[];
}

/**
 * The waived share at which the fraction stops describing the surface and starts describing the
 * exemptions. Half is the point where the tools NOT being measured outnumber the tools that are, so
 * a reader who takes the percentage at face value is wrong more often than right.
 *
 * A threshold rather than a hard failure because a high waiver share is legitimate — a read-only
 * suite against a mostly-mutating server is exactly that — and failing it would push authors to
 * delete the waivers, which is how the denominator goes blind in the first place.
 */
export const WAIVER_SHARE_WARN_THRESHOLD = 0.5;

/** Percentage of `total` that `part` represents, to one decimal place. `total` of 0 yields 0. */
function percent(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/** Bucket key for the per-server breakdown — one stable string per bucket identity. */
function bucketKeyFor(record: AdvertisedToolRecord): string {
  if (record.server === undefined) return 'builtin';
  if (record.server === '') return 'unresolved';
  return `mcp:${record.server}`;
}

/**
 * Fold the per-cell inventories into one, and say so when they disagreed.
 *
 * **The union is the denominator, not the first cell's list.** Each cell resolves its own tools (a
 * fresh MCP client per cell), so a cell whose server failed to connect advertises a shorter list. A
 * denominator taken from that cell would quietly shrink, and coverage would IMPROVE because a server
 * broke — the most misleading direction a coverage number can move. The union keeps the tool in the
 * denominator, where it shows up as uncovered.
 *
 * Disagreement is still a warning, because a varying inventory means the cells did not all see the
 * same surface and no single fraction describes the run exactly.
 */
function unionInventories(inventories: readonly AdvertisedToolInventory[]): {
  tools: AdvertisedToolRecord[];
  filteredOut: AdvertisedToolRecord[];
  unnamed: number;
  disagreed: boolean;
} {
  const tools = new Map<string, AdvertisedToolRecord>();
  const filteredOut = new Map<string, AdvertisedToolRecord>();
  let unnamed = 0;
  let disagreed = false;
  let firstSignature: string | undefined;

  for (const inventory of inventories) {
    for (const record of inventory.tools) {
      if (!tools.has(record.name)) tools.set(record.name, record);
    }
    for (const record of inventory.filteredOut) {
      if (!filteredOut.has(record.name)) filteredOut.set(record.name, record);
    }
    // The same session's inventory repeated per cell must not multiply, so take the largest count
    // rather than the sum — `unnamed` describes one agent's surface, like every other field here.
    unnamed = Math.max(unnamed, inventory.unnamed);

    // Compared as JSON rather than as a joined string: any separator character that could itself
    // occur in a tool name would make two different inventories compare equal.
    const signature = JSON.stringify(inventory.tools.map((record) => record.name).sort());
    if (firstSignature === undefined) firstSignature = signature;
    else if (signature !== firstSignature) disagreed = true;
  }

  return {
    tools: [...tools.values()],
    filteredOut: [...filteredOut.values()],
    unnamed,
    disagreed,
  };
}

/** Inputs to {@link computeToolCoverage}. */
export interface ToolCoverageInput {
  /**
   * One entry per cell that reported an inventory. **Empty means no cell reported one**, which is
   * not the same as a cell reporting an empty inventory: the first cannot supply a denominator at
   * all (an external target, or a run whose SUT never initialised) and yields no report; the second
   * is a real denominator of zero and does.
   */
  inventories: readonly AdvertisedToolInventory[];
  /** Every tool name any cell invoked, in any order, deduplicated or not. */
  exercised: readonly string[];
  /** The suite's `tool_coverage:` declaration, when it made one. */
  spec?: ToolCoverageSpec;
}

/**
 * Compute the coverage report, or `undefined` when no inventory was observed at all.
 *
 * `undefined` is the honest answer for a target that cannot supply a denominator, and is why this
 * returns a value rather than a zeroed report: **`0/0` printed as a coverage figure is the "metric
 * nobody can trust" failure in its purest form** — it looks like a measurement, it is green, and it
 * measured nothing. A caller that declared gates on a target that cannot be measured is rejected at
 * parse time instead (`evalSuite.ts`), so a silent pass is unreachable from both ends.
 */
export function computeToolCoverage(input: ToolCoverageInput): ToolCoverageReport | undefined {
  if (input.inventories.length === 0) return undefined;

  const { tools, filteredOut, unnamed, disagreed } = unionInventories(input.inventories);
  const spec = input.spec;
  const waivePatterns = spec?.waive ?? [];
  const exercised = new Set(input.exercised);
  const warnings: string[] = [];
  const gateFailures: string[] = [];

  const waived: AdvertisedToolRecord[] = [];
  const counted: AdvertisedToolRecord[] = [];
  for (const record of tools) {
    if (waivePatterns.some((pattern) => toolNameMatchesPattern(record.name, pattern))) {
      waived.push(record);
    } else {
      counted.push(record);
    }
  }

  const covered = counted.filter((record) => exercised.has(record.name));
  const uncovered = counted.filter((record) => !exercised.has(record.name));
  const total = counted.length;

  // Per-server buckets over the counted (post-waiver) tools — the same population the headline
  // fraction describes, so the buckets sum to it.
  const buckets = new Map<string, ToolCoverageServerReport>();
  for (const record of counted) {
    const key = bucketKeyFor(record);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket =
        record.server === undefined
          ? { kind: 'builtin', covered: [], uncovered: [] }
          : record.server === ''
            ? { kind: 'unresolved', covered: [], uncovered: [] }
            : { kind: 'mcp', server: record.server, covered: [], uncovered: [] };
      buckets.set(key, bucket);
    }
    if (exercised.has(record.name)) bucket.covered.push(record.name);
    else bucket.uncovered.push(record.name);
  }

  if (disagreed) {
    warnings.push(
      'the cells did not all advertise the same tools — the denominator is their union, so a ' +
        'tool missing from some cells still counts (check for an MCP server that failed to connect)'
    );
  }

  // A waiver that matches nothing is dead config, and the likely cause is the dangerous one: the
  // tool was renamed, so it is back in the denominator under its new name while the author believes
  // it is still waived. Cheap to say, and it is the decay this whole feature exists to catch.
  for (const pattern of waivePatterns) {
    if (!tools.some((record) => toolNameMatchesPattern(record.name, pattern))) {
      warnings.push(`waive "${pattern}" matched no advertised tool — stale waiver, or a typo`);
    }
  }

  if (waived.length > 0 && waived.length / tools.length >= WAIVER_SHARE_WARN_THRESHOLD) {
    warnings.push(
      `${waived.length} of ${tools.length} advertised tool(s) are waived ` +
        `(${percent(waived.length, tools.length)}%) — the figure describes the exemptions more ` +
        'than the surface'
    );
  }

  if (filteredOut.length > 0) {
    warnings.push(
      `${filteredOut.length} advertised tool(s) were removed by allowedTools and never reached ` +
        'the model — they are in the denominator, so they can only ever read as uncovered'
    );
  }

  // Exercised names the inventory never listed. Not folded into the numerator (that would let a
  // fraction exceed 1 and would credit coverage of a tool nobody advertised), and not dropped
  // either — a name that ran but was never advertised means the two halves are measuring different
  // populations, which is exactly the kind of quiet mismatch this report must surface.
  const advertisedNames = new Set(tools.map((record) => record.name));
  const unexpected = [...exercised].filter((name) => !advertisedNames.has(name)).sort();
  if (unexpected.length > 0) {
    warnings.push(
      `${unexpected.length} exercised tool(s) were not in the advertised inventory ` +
        `(${unexpected.join(', ')}) — they are not counted in the numerator`
    );
  }

  if (spec) {
    // Deliberately asymmetric with `waive`, which warns when a pattern matches nothing. A `require`
    // pattern that matches nothing — the mistyped or stale entry — lands in the first branch and
    // fails the gate, which already stops the run and names the pattern, so a stale-config warning
    // beside it would only be quieter duplication. The warning below is the narrower case the gate
    // cannot state: the pattern WAS satisfied by an exercised tool, but no advertised tool matches
    // it, so the run passes while the two halves disagree about what exists.
    for (const pattern of spec.require) {
      if (![...exercised].some((name) => toolNameMatchesPattern(name, pattern))) {
        gateFailures.push(`require "${pattern}": no case exercised a tool matching it`);
      } else if (!tools.some((record) => toolNameMatchesPattern(record.name, pattern))) {
        warnings.push(
          `require "${pattern}" matched no ADVERTISED tool — it was satisfied by a tool the ` +
            'inventory does not list'
        );
      }
    }

    if (spec.min !== undefined) {
      if (total === 0) {
        // A floor over an empty denominator cannot be met, and must not be treated as met. This is
        // the case where every tool went missing (an MCP server that never connected, or a waiver
        // list that swallowed the whole surface) — the one run where a vacuous pass would be most
        // misleading, because it is indistinguishable from perfect coverage.
        gateFailures.push(
          `min ${spec.min}%: no tools remain in the denominator — ` +
            (tools.length === 0
              ? 'the agent advertised none'
              : `all ${tools.length} advertised tool(s) are waived`)
        );
      } else if (percent(covered.length, total) < spec.min) {
        gateFailures.push(
          `min ${spec.min}%: covered ${covered.length}/${total} ` +
            `(${percent(covered.length, total)}%)`
        );
      }
    }
  }

  return {
    covered: covered.map((record) => record.name),
    uncovered: uncovered.map((record) => record.name),
    waived: waived.map((record) => record.name),
    filteredOut: filteredOut.map((record) => record.name),
    unnamed,
    byServer: [...buckets.values()],
    warnings,
    gateFailures,
  };
}

/**
 * Union several suites' reports into the run-level figure, or `undefined` when none was produced.
 *
 * **A set union, never a sum.** A directory run points every suite at the same agent, so the same 41
 * advertised tools appear in each report; summing would report 123 tools and make one suite's
 * coverage of a tool count three times. Coverage is a directory-level figure precisely because one
 * suite covering 3 tools is fine if its sibling covers the other 38 — which only reads correctly
 * when a tool covered anywhere is covered once.
 *
 * **Carries no warnings and no gate failures, deliberately.** A gate is declared in a suite and
 * graded against that suite (the `metrics:` precedent), and the run's exit is the OR of those. If a
 * declared floor were re-applied to the aggregate, the same suite would pass when run alone and fail
 * when run as part of a directory, with nothing in either output saying the threshold had moved.
 * This function stays reporting only.
 *
 * **A run-level floor is a different declaration, graded elsewhere.** BATCH-48 adds one —
 * `evalToolCoverage` in gth config, resolved once per run from the base config and never from an
 * identity's — and {@link gradeRunToolCoverage} is what grades it, against the report this function
 * returns. Keeping the two apart is what preserves the argument above: a suite's `min:` is never
 * promoted to the aggregate, and the run's floor is never read back as a suite's.
 */
export function aggregateToolCoverage(
  reports: readonly ToolCoverageReport[]
): ToolCoverageReport | undefined {
  if (reports.length === 0) return undefined;

  const covered = new Set<string>();
  const uncovered = new Set<string>();
  const waived = new Set<string>();
  const filteredOut = new Set<string>();
  const buckets = new Map<string, ToolCoverageServerReport>();
  let unnamed = 0;

  for (const report of reports) {
    for (const name of report.covered) covered.add(name);
    for (const name of report.uncovered) uncovered.add(name);
    for (const name of report.waived) waived.add(name);
    for (const name of report.filteredOut) filteredOut.add(name);
    unnamed = Math.max(unnamed, report.unnamed);
    for (const bucket of report.byServer) {
      const key = bucket.kind === 'mcp' ? `mcp:${bucket.server}` : bucket.kind;
      let merged = buckets.get(key);
      if (!merged) {
        merged = {
          kind: bucket.kind,
          ...(bucket.server !== undefined ? { server: bucket.server } : {}),
          covered: [],
          uncovered: [],
        };
        buckets.set(key, merged);
      }
      merged.covered.push(...bucket.covered);
      merged.uncovered.push(...bucket.uncovered);
    }
  }

  // A tool covered by ANY suite is covered: that is what makes the aggregate the interesting
  // number. Without this, a tool one suite exercised would still be listed as uncovered because a
  // sibling suite never touched it.
  for (const name of covered) uncovered.delete(name);
  // Likewise a tool that is waived in one suite but counted in another stays counted — a waiver is
  // one suite's statement about its own scope, and the run as a whole did measure that tool.
  for (const name of [...covered, ...uncovered]) waived.delete(name);

  return {
    covered: [...covered],
    uncovered: [...uncovered],
    waived: [...waived],
    filteredOut: [...filteredOut],
    unnamed,
    byServer: [...buckets.values()].map((bucket) => {
      const bucketCovered = [...new Set(bucket.covered)];
      const coveredSet = new Set(bucketCovered);
      return {
        ...bucket,
        covered: bucketCovered,
        uncovered: [...new Set(bucket.uncovered)].filter((name) => !coveredSet.has(name)),
      };
    }),
    warnings: [],
    gateFailures: [],
  };
}

/**
 * BATCH-48 — the run-level coverage spec, as `gth eval` resolved it from the base config.
 *
 * A structural mirror of the config key rather than a dependency on core's config types: the batch
 * package owns the grading, and the command owns where the value came from. `min` is the same
 * percentage a suite's `tool_coverage.min` is; `waive` is the same glob vocabulary.
 */
export interface RunToolCoverageSpec {
  /** Minimum percentage (0–100) of the run's post-waiver denominator. Absent means no floor. */
  min?: number;
  /** Tool-name globs removed from the run denominator, whatever any suite waived. */
  waive: string[];
}

/**
 * Where the run-level spec was read from, so the output can name it.
 *
 * Naming the source is what keeps a threshold from silently moving scope: a reader can see that the
 * number was graded against the run's floor and where that floor was declared, rather than having to
 * infer it from which suites happened to run.
 */
export interface RunToolCoverageSource {
  /**
   * `profile` — the base `-i` profile the run was started with. `project` — the plain project
   * config found by discovery. `config-file` — an explicit `-c` file. `global` — the global config
   * in `~/.gsloth`, when no project config exists or `-g` was given. The command decides which;
   * this layer only prints what it is told.
   */
  kind: 'profile' | 'project' | 'config-file' | 'global';
  /** The profile name, when {@link kind} is `profile`. */
  profile?: string;
  /** The file path, when {@link kind} is `config-file`. */
  path?: string;
}

/** One run graded against its run-level spec. */
export interface RunToolCoverageGrade {
  /**
   * The aggregate after the run-level `waive` has been applied — the figure the floor was graded
   * against. `undefined` when no suite produced a report, which is a different outcome from an
   * aggregate that exists and is below the floor: there is nothing to grade.
   */
  report: ToolCoverageReport | undefined;
  /**
   * Breached `min`, or a floor that could not be graded because no suite produced a report. Empty
   * when the floor holds, and when no floor was declared — a spec with only `waive` still narrows
   * the denominator and warns, but it gates nothing.
   */
  gateFailures: string[];
  /**
   * A run-level waiver that matched nothing advertised. The same stale-waiver warning a suite gets,
   * because a renamed tool is back in the denominator under its new name while the author believes
   * it is still waived — and at run scope that is the decay a duplicated per-suite list hides.
   */
  warnings: string[];
  /** The line that says which threshold this run was graded against and where it came from. */
  sourceLine: string;
}

/** The human name of a {@link RunToolCoverageSource}, shared by the source line and the gate text. */
function describeRunCoverageSource(source: RunToolCoverageSource): string {
  switch (source.kind) {
    case 'profile':
      return `profile ${source.profile ?? '(unnamed)'}`;
    case 'config-file':
      return `config file ${source.path ?? '(unnamed)'}`;
    case 'global':
      return 'the global config';
    default:
      return 'the project config';
  }
}

/**
 * Whether a run-level spec declares anything to grade or apply.
 *
 * An absent config key and an empty object are the same thing to a caller: no floor, no exemption.
 * Distinguishing them would make "the run has no floor" depend on which spelling the config used.
 */
export function hasRunToolCoverageSpec(spec: RunToolCoverageSpec | undefined): boolean {
  return spec !== undefined && (spec.min !== undefined || spec.waive.length > 0);
}

/**
 * Grade a run-level coverage spec against the run's aggregate.
 *
 * **Separate from {@link aggregateToolCoverage} on purpose.** That function reports the union and
 * carries no gate, because re-applying a SUITE's declared floor to a different denominator would
 * make the same suite pass alone and fail inside a directory. This function grades a floor that was
 * declared for the run, against the aggregate it names, so the two thresholds stay independent: a
 * suite's `min:` is never promoted here, and this floor is never written back onto a suite.
 *
 * **The denominator is the aggregate's reconciled one, minus this spec's `waive`.** The aggregate
 * has already applied the reconciliation — a tool waived in one suite but counted in another stays
 * counted, and a tool waived in every suite is already out. A suite's own waiver therefore does not
 * shrink the run denominator further; only the run-level list does. A tool the run-level list waives
 * leaves the denominator even when it was covered, the same way a suite-level waiver does inside
 * {@link computeToolCoverage}.
 *
 * **A floor with nothing to grade fails.** `min` set and no report at all — every suite targeted
 * something that cannot supply a denominator — must not pass: a floor quietly skipped reports green
 * forever over a run it never measured.
 */
export function gradeRunToolCoverage(
  aggregate: ToolCoverageReport | undefined,
  spec: RunToolCoverageSpec,
  source: RunToolCoverageSource
): RunToolCoverageGrade {
  const sourceText = describeRunCoverageSource(source);
  const sourceLine =
    spec.min !== undefined
      ? `graded against evalToolCoverage.min ${spec.min}% from ${sourceText}`
      : `evalToolCoverage applied from ${sourceText}`;

  if (!aggregate) {
    // Nothing was measured. A waiver list has nothing to match against either, so it neither warns
    // nor silently passes a floor: the floor is the thing that was declared, and it could not be
    // graded.
    const gateFailures =
      spec.min !== undefined
        ? [
            `evalToolCoverage.min ${spec.min}% from ${sourceText} could not be graded: no suite ` +
              'produced a coverage report',
          ]
        : [];
    return { report: undefined, gateFailures, warnings: [], sourceLine };
  }

  const warnings: string[] = [];
  const names = [...aggregate.covered, ...aggregate.uncovered, ...aggregate.waived];
  const waivedByRun = new Set<string>();
  for (const pattern of spec.waive) {
    const matched = names.filter((name) => toolNameMatchesPattern(name, pattern));
    if (matched.length === 0) {
      warnings.push(
        `evalToolCoverage.waive "${pattern}" matched no advertised tool — stale waiver, or a typo`
      );
    }
    for (const name of matched) waivedByRun.add(name);
  }

  // A covered tool the run waives leaves the numerator, exactly as a suite-level waiver of a
  // covered tool leaves it. Keeping it covered would let the run exempt a tool and still be
  // credited for exercising it, which is the opposite of what a waiver means.
  const covered = aggregate.covered.filter((name) => !waivedByRun.has(name));
  const uncovered = aggregate.uncovered.filter((name) => !waivedByRun.has(name));
  const waived = [...new Set([...aggregate.waived, ...waivedByRun])];

  const gateFailures: string[] = [];
  if (spec.min !== undefined) {
    const total = covered.length + uncovered.length;
    if (total === 0) {
      gateFailures.push(
        `evalToolCoverage.min ${spec.min}% from ${sourceText}: no tools remain in the ` +
          `denominator — all ${names.length} advertised tool(s) are waived`
      );
    } else if (percent(covered.length, total) < spec.min) {
      gateFailures.push(
        `evalToolCoverage.min ${spec.min}% from ${sourceText}: covered ${covered.length}/${total} ` +
          `(${percent(covered.length, total)}%)`
      );
    }
  }

  // The per-server buckets describe the same post-waiver population as the headline, so they sum
  // to it; a run-waived tool leaves its bucket too, and a bucket left empty is dropped.
  const byServer = aggregate.byServer
    .map((bucket) => ({
      ...bucket,
      covered: bucket.covered.filter((name) => !waivedByRun.has(name)),
      uncovered: bucket.uncovered.filter((name) => !waivedByRun.has(name)),
    }))
    .filter((bucket) => bucket.covered.length + bucket.uncovered.length > 0);

  return {
    report: { ...aggregate, covered, uncovered, waived, byServer, gateFailures: [], warnings: [] },
    gateFailures,
    warnings,
    sourceLine,
  };
}
