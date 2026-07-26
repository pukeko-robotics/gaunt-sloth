import type { EvalSuite } from '#src/evalTypes.js';

/**
 * BATCH-25 — the blind export and its round trip.
 *
 * A corpus labelled by one person is a corpus with one person's blind spots in it. The approvals
 * corpus plan requires a **blind relabel by a second person** before any number from it gates a
 * decision, and this module is what makes that structurally possible rather than aspirational: the
 * export carries the case id, the input, and the family tags, and NOTHING else — no expected label,
 * no expected action, no rationale, no judge rubric, no per-identity expectation blocks.
 *
 * The diff then compares the second labeller's file against the corpus BY ID, and — this is the
 * part that is easy to get wrong — reports ids present in only one of the two. A relabel that
 * silently omitted ten cases would otherwise read as 100% agreement on the sixty-eight it did
 * cover, which is the same "a number that looks better than it earned" failure the metric layer
 * exists to prevent.
 */

/** One exported case. `inputs` carries every round in order, so a multi-round negotiation case is
 * relabellable rather than silently dropped — dropping it would be a silent cap on the export. */
export interface BlindExportCase {
  id: string;
  inputs: string[];
  tags: string[];
}

/** The blind export document. `note` is written into the file itself so a labeller opening it
 * out of context knows what is being asked and that the labels were deliberately withheld. */
export interface BlindExport {
  note: string;
  /** The suite's declared label enum — the labeller needs the vocabulary; that is not a leak of the
   * answers. Empty when the suite declares no `classification:` block. */
  labels: string[];
  /** The suite's declared action enum, when it has one. */
  actions: string[];
  cases: BlindExportCase[];
}

const BLIND_NOTE =
  'Blind relabel export. Each case carries only its id, its input(s) and its family tags — the ' +
  'authored expected label/action and every rationale are deliberately withheld. Add a `label` ' +
  '(and, where you have a view, an `action`) to each case and return the file; `gth eval ' +
  '--relabel-diff` compares it to the corpus by id.';

/**
 * Build the blind export for a suite.
 *
 * Note what is NOT here: `expectLabel`, `expectAction`, `judgeRubric`, every content assertion, and
 * the pass threshold. An expectation block leaks the answer as surely as the label does — a
 * `must_contain: ["refused"]` tells the labeller what was expected — so the export is built from an
 * allow-list of three fields rather than by deleting fields from the case.
 */
export function buildBlindExport(suite: EvalSuite): BlindExport {
  return {
    note: BLIND_NOTE,
    labels: suite.classification?.labels ?? [],
    actions: suite.classification?.actions ?? [],
    cases: suite.cases.map((evalCase) => ({
      id: evalCase.id,
      inputs: evalCase.turns.map((turn) => turn.user),
      tags: evalCase.tags ?? [],
    })),
  };
}

/** One case as returned by the second labeller. */
export interface RelabelEntry {
  id: string;
  label?: string;
  action?: string;
  note?: string;
}

/** One case where the two labellings differ. */
export interface RelabelDisagreement {
  id: string;
  tags: string[];
  corpusLabel?: string;
  relabelLabel?: string;
  corpusAction?: string;
  relabelAction?: string;
  note?: string;
}

/** The result of a blind relabel diff. */
export interface RelabelDiff {
  /** Cases present in BOTH files — the only ones agreement can be computed over. */
  compared: number;
  agreed: number;
  disagreements: RelabelDisagreement[];
  /** Ids in the corpus that the relabel file never mentions. Reported explicitly: without this a
   * partial relabel reads as full agreement on the part it covered. */
  missingFromRelabel: string[];
  /** Ids in the relabel file that the corpus does not contain (a typo, or a stale export). */
  unknownInRelabel: string[];
  /** Everything that bounds what the agreement figure covers. Empty is the good case. */
  warnings: string[];
}

/**
 * Diff a second labeller's file against the corpus, by id.
 *
 * Agreement is computed ONLY over ids present in both files, and the ids present in only one are
 * reported separately and warned about. A relabel that covers half the corpus produces an
 * agreement figure over half the corpus and says so — it never produces a figure that looks like it
 * covers all of it.
 *
 * A relabel entry with no `label` is treated as "not relabelled": it counts as missing rather than
 * as a disagreement with `undefined`, because an unanswered case is not a dissent.
 */
export function diffRelabel(suite: EvalSuite, entries: RelabelEntry[]): RelabelDiff {
  // The corpus's own view of each case: the first expected label/action any expectation declares.
  const corpus = new Map<string, { tags: string[]; label?: string; action?: string }>();
  for (const evalCase of suite.cases) {
    const blocks = evalCase.turns.flatMap((turn) => turn.expectations);
    corpus.set(evalCase.id, {
      tags: evalCase.tags ?? [],
      label: blocks.find((block) => block.expectLabel !== undefined)?.expectLabel,
      action: blocks.find((block) => block.expectAction !== undefined)?.expectAction,
    });
  }

  const relabelled = new Map<string, RelabelEntry>();
  const unknownInRelabel: string[] = [];
  const duplicateIds: string[] = [];
  for (const entry of entries) {
    if (!corpus.has(entry.id)) {
      unknownInRelabel.push(entry.id);
      continue;
    }
    if (relabelled.has(entry.id)) duplicateIds.push(entry.id);
    // A blank label means "not relabelled" — it belongs in `missingFromRelabel`, not in the
    // agreement denominator.
    if (entry.label === undefined || entry.label.trim().length === 0) continue;
    relabelled.set(entry.id, entry);
  }

  const disagreements: RelabelDisagreement[] = [];
  const missingFromRelabel: string[] = [];
  let compared = 0;
  let agreed = 0;

  for (const [id, corpusCase] of corpus) {
    const entry = relabelled.get(id);
    if (!entry) {
      missingFromRelabel.push(id);
      continue;
    }
    compared += 1;
    const labelAgrees = corpusCase.label === entry.label;
    // An action is only compared when the relabeller expressed one — silence is not dissent.
    const actionAgrees =
      entry.action === undefined || entry.action.trim().length === 0
        ? true
        : corpusCase.action === entry.action;
    if (labelAgrees && actionAgrees) {
      agreed += 1;
      continue;
    }
    disagreements.push({
      id,
      tags: corpusCase.tags,
      corpusLabel: corpusCase.label,
      relabelLabel: entry.label,
      corpusAction: corpusCase.action,
      relabelAction: entry.action,
      note: entry.note,
    });
  }

  const warnings: string[] = [];
  if (missingFromRelabel.length > 0) {
    warnings.push(
      `${missingFromRelabel.length}/${corpus.size} corpus case(s) were NOT relabelled, so the ` +
        `agreement figure covers ${compared}/${corpus.size} cases, not the whole corpus ` +
        `(missing: ${missingFromRelabel.join(', ')}).`
    );
  }
  if (unknownInRelabel.length > 0) {
    warnings.push(
      `${unknownInRelabel.length} relabel entr(ies) name ids the corpus does not contain — a typo, ` +
        `or a stale export (${unknownInRelabel.join(', ')}).`
    );
  }
  if (duplicateIds.length > 0) {
    warnings.push(
      `${duplicateIds.length} id(s) appear more than once in the relabel file; the LAST entry won ` +
        `(${[...new Set(duplicateIds)].join(', ')}).`
    );
  }

  return { compared, agreed, disagreements, missingFromRelabel, unknownInRelabel, warnings };
}

/** Render a {@link RelabelDiff} as plain lines for the console. */
export function renderRelabelDiff(diff: RelabelDiff): string[] {
  const lines: string[] = ['', 'BLIND RELABEL DIFF'];
  const percent =
    diff.compared === 0 ? 'n/a (0 cases)' : `${((diff.agreed / diff.compared) * 100).toFixed(1)}%`;
  lines.push(`  agreement: ${diff.agreed}/${diff.compared} compared case(s) (${percent})`);
  for (const warning of diff.warnings) lines.push(`  ! ${warning}`);

  if (diff.disagreements.length > 0) {
    lines.push('');
    lines.push(`  disagreements (${diff.disagreements.length}):`);
    for (const item of diff.disagreements) {
      const tags = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
      lines.push(
        `    ${item.id}${tags}: corpus=${item.corpusLabel ?? '(none)'}` +
          `/${item.corpusAction ?? '(none)'} vs relabel=${item.relabelLabel ?? '(none)'}` +
          `/${item.relabelAction ?? '(none)'}` +
          (item.note ? ` — ${item.note}` : '')
      );
    }
  }
  return lines;
}
