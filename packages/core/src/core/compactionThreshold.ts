/**
 * @packageDocumentation
 * EXT-161 — **the preventive compaction threshold: one number, one place it is decided.**
 *
 * `contextWindow.ts` answers "how big is the window". This module answers the question that
 * actually gates a compaction: **at what prompt size do we fold the conversation, and who said
 * so.** Three things can say so, in this order:
 *
 * 1. **the running session** — `/autocompact 300K`, which wins for the rest of the session;
 * 2. **the user's config** — the `autocompact` key;
 * 3. **the default** — derived from the resolved window by the guard, which is the only place that
 *    knows how many tokens are being held back for the answer.
 *
 * **Compaction is ON BY DEFAULT.** That is a ruling, and it is a deliberate exception to the rule
 * that a default-on middleware must not touch `state.messages` — compaction changes what the model
 * sees by construction, which is the whole feature. The exception is paid for the way the rule
 * demands: the shape of the history a compaction leaves behind is pinned per provider by
 * `compaction.ts`'s invariants (a)–(d), a compaction announces itself in the transcript, the
 * resolved number and its provenance are readable with `/status`, and the off switch is one key —
 * `autocompact: false`.
 *
 * **Why the provenance is carried rather than recomputed.** A threshold that is wrong is diagnosed
 * by knowing where the number came from; a `/status` that reports a models.dev-derived number after
 * a human typed `/autocompact 50000` would send the next diagnosis to the wrong place entirely. So
 * a session override re-labels the provenance, and {@link AutocompactController} is the single
 * object both the guard and `/status` read, over one memoised window resolution.
 */
import { parseTokenBudget, resolveTokenBudget, type TokenBudget } from '#src/config/tokenBudget.js';
import type {
  ContextWindowOrigin,
  ContextWindowReading,
  ResolvedContextWindow,
} from '#src/core/contextWindow.js';

/**
 * The share of a model's context window that `gth init` seeds as an explicit threshold.
 *
 * Init writes an **absolute number** derived from this rather than the percentage itself, because
 * the point of seeding is that the user opens their config and sees the number that will actually
 * be enforced. A percentage would leave them one lookup away from it.
 *
 * 0.8 leaves a fifth of the window for the answer and the tool round that follows it — comfortably
 * more than the flat answer reserve on any real cloud window, which is what makes the seeded number
 * the binding one rather than a decoration.
 */
export const DEFAULT_AUTOCOMPACT_SEED_FRACTION = 0.8;

/**
 * The `autocompact` config value, in every form the key accepts.
 *
 * `false` disables it; `true` (and an absent key) is on with the derived default; a bare count or
 * suffixed string is on with that threshold; the object form spells both out. The shorthand union
 * mirrors `toolLoopGuard`, which is the shape a reader of this config already knows.
 */
export type AutocompactConfig =
  boolean | number | string | { enabled?: boolean; threshold?: number | string };

/** The `autocompact` key as the read site sees it, after defaulting and parsing. */
export interface ResolvedAutocompactConfig {
  /** Whether preventive compaction may fire at all. On by default — ruled. */
  enabled: boolean;
  /** The configured budget, or `null` when the user named none and the default applies. */
  budget: TokenBudget | null;
}

/**
 * Read the `autocompact` config key.
 *
 * Defaulting happens **here, at the read site**, not in `DEFAULT_CONFIG`, so an absent key stays
 * absent in the effective-config snapshot and the snapshot does not churn — the same placement
 * `injectModelContext` and `toolLoopGuard` use.
 *
 * A malformed threshold raises the `TokenBudgetError` from the shared parser, which config
 * validation turns into a field-scoped issue naming the offending text. It must never resolve to a
 * number: `NaN`, `0` and 4097 are all thresholds the user cannot see and did not choose.
 */
export function resolveAutocompactConfig(raw: unknown): ResolvedAutocompactConfig {
  if (raw === undefined || raw === null) return { enabled: true, budget: null };
  if (typeof raw === 'boolean') return { enabled: raw, budget: null };
  if (typeof raw === 'number' || typeof raw === 'string') {
    return { enabled: true, budget: parseTokenBudget(raw) };
  }
  if (typeof raw === 'object') {
    const value = raw as { enabled?: unknown; threshold?: unknown };
    const enabled = value.enabled !== false;
    const budget =
      value.threshold === undefined || value.threshold === null
        ? null
        : parseTokenBudget(value.threshold);
    return { enabled, budget };
  }
  return { enabled: true, budget: null };
}

/** Where the threshold number in force came from — what `/status` names. */
export type AutocompactThresholdOrigin =
  /** A `/autocompact` typed in this session; outranks the config for the rest of it. */
  | 'session'
  /** The `autocompact` key in the user's config. */
  | 'config'
  /** Derived from the resolved window, holding back room for the answer. */
  | 'default'
  /** Nothing will fire: switched off, or no window and no absolute threshold to fall back on. */
  | 'none';

/** The whole picture, as `/status` prints it and the guard enforces it. */
export interface AutocompactStatus {
  /** Whether preventive compaction may fire at all (the config off switch). */
  enabled: boolean;
  /**
   * The prompt size, in tokens, at which the conversation is folded — or `null` when nothing will
   * fire preventively, which is what an unknown window with no absolute threshold must produce.
   */
  thresholdTokens: number | null;
  /** Where that number came from. */
  thresholdOrigin: AutocompactThresholdOrigin;
  /** The resolved context window, or `null` when no source knew it. */
  window: number | null;
  /** Which source the window came from. */
  windowOrigin: ContextWindowOrigin;
  /** The budget exactly as written, when one was written — so `/status` can echo `80%` as `80%`. */
  budget: TokenBudget | null;
}

/** What {@link AutocompactController} needs to build a status. */
export interface AutocompactControllerOptions {
  /** The `autocompact` key, already read through {@link resolveAutocompactConfig}. */
  config: ResolvedAutocompactConfig;
  /** The one memoised window resolution this session uses — shared with the guard. */
  window: Pick<ResolvedContextWindow, 'read'>;
  /**
   * The threshold to use when the user named none, given a known window: the guard's
   * `window − reserve`. Supplied as a callback because only the guard knows the reserve, and
   * duplicating that arithmetic here is how the two would come to disagree about what "full" means.
   */
  defaultThreshold: (_window: number) => number;
}

/**
 * **The single object the guard and `/status` both read.**
 *
 * Holds the session override — the write half of `/autocompact` — and resolves it against the
 * config and the window on demand. It is mutable by design and the guard reads it through a
 * closure rather than capturing a value, because `createContextGuardMiddleware` runs its factory
 * once per session and its hook holds no state: a captured threshold could never be changed by a
 * command typed later, which is precisely what `/autocompact` has to do.
 */
export class AutocompactController {
  private readonly options: AutocompactControllerOptions;
  private sessionBudget: TokenBudget | null = null;

  constructor(options: AutocompactControllerOptions) {
    this.options = options;
  }

  /**
   * Set the threshold for the rest of this session, overriding the config.
   *
   * Deliberately takes an already-parsed {@link TokenBudget} rather than raw text: parsing is the
   * shared parser's job, and a second entry point that took a string would be a second place the
   * grammar could drift.
   */
  setSessionBudget(budget: TokenBudget): void {
    this.sessionBudget = budget;
  }

  /** The session override in force, or `null`. Read by `/autocompact` with no argument. */
  get sessionOverride(): TokenBudget | null {
    return this.sessionBudget;
  }

  /** Whether the config off switch leaves anything to do at all. */
  get enabled(): boolean {
    return this.options.config.enabled;
  }

  /** The full picture — the one call `/status` makes. */
  async status(): Promise<AutocompactStatus> {
    const reading: ContextWindowReading = await this.options.window.read();
    const budget = this.sessionBudget ?? this.options.config.budget;
    const budgetOrigin: AutocompactThresholdOrigin = this.sessionBudget
      ? 'session'
      : this.options.config.budget
        ? 'config'
        : 'default';

    if (!this.options.config.enabled) {
      return {
        enabled: false,
        thresholdTokens: null,
        thresholdOrigin: 'none',
        window: reading.tokens,
        windowOrigin: reading.origin,
        budget,
      };
    }

    // A named budget resolves against the window — which an absolute count does not need, so an
    // explicit `300K` still fires on a model nothing knows the window of. A PERCENTAGE without a
    // window cannot resolve, and falls through to the same "nothing fires" answer as no threshold
    // at all rather than to a guess.
    const named = budget ? resolveTokenBudget(budget, reading.tokens) : null;
    if (named !== null) {
      return {
        enabled: true,
        thresholdTokens: named,
        thresholdOrigin: budgetOrigin === 'default' ? 'config' : budgetOrigin,
        window: reading.tokens,
        windowOrigin: reading.origin,
        budget,
      };
    }

    if (reading.tokens === null) {
      return {
        enabled: true,
        thresholdTokens: null,
        thresholdOrigin: 'none',
        window: null,
        windowOrigin: reading.origin,
        budget,
      };
    }

    return {
      enabled: true,
      thresholdTokens: this.options.defaultThreshold(reading.tokens),
      thresholdOrigin: 'default',
      window: reading.tokens,
      windowOrigin: reading.origin,
      budget,
    };
  }

  /** The number the guard compares against, or `null` for "never fire". */
  async threshold(): Promise<number | null> {
    return (await this.status()).thresholdTokens;
  }
}

/**
 * The absolute threshold `gth init` writes for a model whose window it resolved — a plain number,
 * because the point of seeding is that the user can read the enforced value straight out of their
 * config.
 *
 * Returns `null` when the window is unknown, and the caller then writes **no key at all**: seeding
 * a guess would put a number in the user's config that looks chosen and was not, which is worse
 * than the absent key that leaves the runtime default in charge.
 */
export function seedAutocompactThreshold(window: number | null): number | null {
  if (window === null || !Number.isFinite(window) || window <= 0) return null;
  return Math.max(1, Math.floor(window * DEFAULT_AUTOCOMPACT_SEED_FRACTION));
}
