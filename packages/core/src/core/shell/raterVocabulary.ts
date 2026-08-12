/**
 * @module core/shell/raterVocabulary
 *
 * **The approvals gate's closed vocabularies, and nothing else.** Three lists: the outcomes a rater
 * may return, the actions the gate may resolve to, and the deterministic preflights that can floor a
 * command. Each is the SINGLE place its members are written down.
 *
 * ## Why they live apart from {@link ./rater.js}, which owns their meaning
 *
 * A vocabulary has two kinds of consumer. The gate itself needs the words *and* the machinery around
 * them. A **checker** — a schema, a report axis, a compile-time guard in another package — needs only
 * the words, and must be able to read them without loading a rating prompt, a structured-output
 * boundary and a chat-model client. `rater.js` imports LangChain and Zod; a suite parser that had to
 * import it to learn which actions exist would pull the whole model layer into a parse.
 *
 * So this module has **no imports at all**, and it must stay that way. `rater.js` re-exports every
 * symbol here, so the gate's own callers are unaffected and there is exactly one spelling of each
 * word in the codebase.
 *
 * **A checker that RESTATES one of these lists is the failure this module exists to prevent.** A
 * restated list does not grow when the gate grows: the new member is simply never recognised, and
 * the checker keeps reporting success over a vocabulary it no longer covers. Derive from these
 * arrays — ideally as a total `Record` keyed on the type, so a new member is a compile error rather
 * than a silence.
 */

/**
 * (Spec §4.1) — the **four** outcomes the rater may return. There is no ordering knob and no
 * threshold: each outcome's consequence is fixed by the rung
 * ({@link import('./rater.js').mapVerdictToAction}).
 *
 * - `safe` — no harmful effect.
 * - `destructive` — **the catch-all**: harmful, but recoverable from inside the session, and not
 *   an attack — **and anything the rater cannot assess**. The rating prompt defines it *by
 *   exclusion* ("not safe, not catastrophic and not an attack") precisely so no command can fall
 *   outside the four.
 * - `catastrophic` — *can this be undone from inside the session?* Irreversible without something
 *   OUTSIDE the session: rescue media, a backup, a re-provision, a restore from a third party.
 *   Escalates at both rated rungs; never negotiable and never sticky (§4.2).
 * - `attack` — *is something hostile acting here?* The command's own **structure** evidences
 *   compromise (§4.1.1: credential targeting, privilege escalation / permission weakening,
 *   persistence, deception, obfuscation). It is the only outcome that HALTS the run.
 *
 * **`catastrophic` and `attack` are not ranked against each other** — they ask different
 * questions, and the spec says so explicitly. A command can be both; `attack` wins the
 * *consequence* (a manipulated session cannot be trusted to continue) but MUST NOT swallow the
 * finding — see the §6.1 clause in {@link import('./rater.js').buildRaterSystemPrompt}. Nothing
 * here may be written as a severity comparison between the two.
 */
export const RATER_OUTCOMES = ['safe', 'destructive', 'catastrophic', 'attack'] as const;

/** One outcome of {@link RATER_OUTCOMES}. */
export type RaterOutcome = (typeof RATER_OUTCOMES)[number];

/**
 * The actions the approvals gate can resolve to for a single gated call, BEFORE the human prompt.
 * {@link import('./rater.js').mapVerdictToAction} is the whole mapping from an outcome and a rung
 * onto one of these, and its docblock carries the table.
 *
 * - `approve` — approve ONCE; do not touch the human or the allow-list.
 * - `escalate` — fall through to the human approval callback, carrying the verdict when one
 *   exists. Where there is no human, §6.2 turns this into an immediate non-zero exit — that
 *   translation belongs to the runner, not to the mapping.
 * - `halt` — **end the agent loop** (§4.2). Reserved for `attack`. It is not a rejection the
 *   model can respond to and offers it no moves; no rung except `bypass` can turn it into
 *   anything else.
 * - `reject` — (§5): hand the rater's explanation back to the **agent** as the refused call's tool
 *   result (§7), opening a round of the negotiation. Returned for `destructive` at `auto` and
 *   nowhere else.
 *
 * **`reject` says the outcome is negotiable, NOT that the negotiation may continue.** The mapping is
 * keyed on the rung and knows nothing about how many rounds have been spent; §5.3's consecutive cap
 * and the reachability bound live with the state they count, in the runner, which turns a `reject`
 * into an escalation once either is spent. Putting the counters into the mapping would make a pure
 * rung-keyed table depend on session history, and would give the eval target
 * (`@gaunt-sloth/batch`'s `raterTarget`) an action that varies with something it does not model.
 *
 * There is deliberately **no `abstain` arm.** A command whose target the gate cannot statically
 * resolve is rated like any other, under §6.1's rule — *deterministic checks fire only where we are
 * confident something is a threat; where we cannot tell, the model decides*. A parser reporting that
 * it could not resolve a string is not a detection, so it earns no action of its own; what it earns
 * is a neutral note in the rating prompt
 * ({@link import('./abstention.js').buildParserPreflightNote}) and a real rating. That is also what
 * keeps the ceiling reachable: an action of its own would make `catastrophic` and `attack`
 * unreachable for every composed, substituting or redirecting command, so `pwd && rm -rf ~` could
 * only ever be floored at `destructive`.
 *
 * There is deliberately **no `refuse` arm for `catastrophic`** (§4.2). The deterministic members of
 * that class — fork bomb, `mkfs`, `rm -rf /`, `dd` to a block device — are already refused
 * unappealably by the §8 hardline floor under every rung including `bypass`, so a refusing
 * `catastrophic` would add nothing for the commands that motivate the idea. What it would newly
 * refuse is the remainder the floor cannot reach, every member of which has routine legitimate use
 * (a staging database, an ephemeral `terraform destroy`, a preview namespace). An unmeasured
 * classifier belongs behind a human who can correct it; a refusal has no correction path.
 *
 * **This list is exhaustive by construction, and downstream must treat it that way.** Anything that
 * enumerates actions — a report axis, an eval suite's declared enum, a rendering table — has to
 * derive from here. The failure mode of a restatement is silent rather than loud: an action the
 * enumerator does not know is not an error it can raise, it is a row it quietly files under
 * "unrecognized", and the thing that was being measured simply stops being measured.
 */
export const RATER_ACTIONS = ['approve', 'escalate', 'halt', 'reject'] as const;

/** One action of {@link RATER_ACTIONS}. */
export type RaterAction = (typeof RATER_ACTIONS)[number];

/**
 * The deterministic preflights that can floor a command at `destructive`, in the FIXED order
 * {@link import('./rater.js').preflightFloorFinding} evaluates them.
 *
 * - `script-env-leak` — an interpreter invocation expanding an ALL_CAPS environment variable into
 *   its arguments. §11.1b's narrowing of the `attack` clause rests on this arm firing.
 * - `open-world` — (§4.6) a host literal in a fetch/transfer position. Its reason NAMES THE HOST,
 *   so, unlike the other arm's, its text varies per command: identify this arm by its `kind`, never
 *   by matching its prose.
 *
 * They are arms of a single decision rather than independent checks, and the outcome is identical
 * whichever fires — the order is the order of the *explanation* a human reads. Anything that
 * attributes a floored decision to a mechanism must key on this list, so that a preflight added to
 * the gate cannot go unattributed.
 */
export const PREFLIGHT_FLOOR_KINDS = ['script-env-leak', 'open-world'] as const;

/** One preflight of {@link PREFLIGHT_FLOOR_KINDS}. */
export type PreflightFloorKind = (typeof PREFLIGHT_FLOOR_KINDS)[number];
