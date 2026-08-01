/**
 * @module core/approvals/toolHost
 *
 * EXT-70 (spec §4.7.4) — **the host a tool call reaches**, read off the call's own arguments.
 *
 * §4.7.4's bound on a sticky tool grant needs one thing the tool name does not carry: *which
 * counterparty this call talks to*. A grant that recorded only the tool would be every host,
 * forever — the hole §4.6 spent a whole preflight closing, reached through a tool instead of
 * `curl`. A host is not "the full argument signature"; it is the one argument both
 * security-relevant and stable enough across calls for the grant to stay useful.
 *
 * ## Why this is not a second implementation of §4.6's scanner
 *
 * `core/shell/openWorld.ts` answers a different question over a different input: *"does this shell
 * word name a counterparty at all"*, over a tokenized command line, returning a boolean plus the
 * literals it found for a human-readable reason. This answers *"which host, exactly"* over a
 * **structured tool argument**, because the answer here is stored in a config entry and later
 * compared for equality — so it must be a single normalized string or nothing.
 *
 * Structured arguments admit the precise instrument the shell path cannot use: `URL` parsing. A
 * value either parses as a URL with a host or it does not, with no tokenization, no quoting and no
 * heuristics about operand position.
 *
 * ## The COUNT is the answer, which is why nothing here returns a single host
 *
 * A grant's `host` is one exact string, so only a call naming **exactly one** host has a host to
 * record — but the decision needs the count and not just that one host, because the two ways of
 * having no single host are opposite outcomes: a call naming **no** host gets a tool-only grant
 * (§6's *always approve `mcp__jira__create_issue`*, where no host is involved), while a call naming
 * **several** gets no grant at all, since the menu may not display one bound and store another.
 * A convenience that collapsed both to "no host" would hand a caller the one distinction this
 * module exists to preserve, already discarded — so {@link toolCallHosts} is the whole surface, and
 * a caller that wants *the* host reads `hosts.length === 1 ? hosts[0] : …` at the point where it
 * also decides what the other two cases mean.
 *
 * A value this module fails to recognize as a host costs a re-prompt or a broader grant than the
 * call deserved, never a narrower one that silently fails to match.
 */

/**
 * How deep into a nested argument object a host may hide. Tool arguments are shallow by
 * construction (a JSON Schema the model fills in), so this is a budget rather than a limit anyone
 * should expect to reach.
 */
const MAX_DEPTH = 4;

/** How many values are examined in total, so a pathological argument object cannot spin. */
const MAX_VALUES = 256;

/**
 * Values longer than this are not candidate URLs. A URL that reaches this length is not something a
 * grant should be keyed on, and the cap bounds the work regardless of what a model emitted.
 */
const MAX_VALUE_LENGTH = 4096;

/**
 * The host a single string names, or `undefined`.
 *
 * **A non-empty `hostname` is the whole test**, and it is what makes the schemes that name no
 * counterparty drop out without a list to maintain: `file:///etc/passwd`, `data:text/plain,x` and
 * `mailto:someone@example.com` all parse, and all have an empty hostname. Lower-cased because host
 * names are case-insensitive and the stored value is compared for equality; the port is
 * deliberately left out, since §3.1's example is a bare host and a grant that dissolved when a
 * server moved port would be a grant on the wrong thing.
 */
function hostOf(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  return parsed.hostname.length > 0 ? parsed.hostname.toLowerCase() : undefined;
}

/**
 * Every distinct host named anywhere in a tool call's arguments, in the order first seen.
 *
 * Own enumerable properties only, so nothing inherited can contribute a host, and arrays are walked
 * as their elements. This is what the approvals decision reads, because it needs the COUNT: a call
 * naming no host and a call naming several are the same absent host and not the same grant.
 */
export function toolCallHosts(args: unknown): string[] {
  const hosts: string[] = [];
  let budget = MAX_VALUES;

  const walk = (value: unknown, depth: number): void => {
    if (budget <= 0 || depth > MAX_DEPTH) return;
    budget -= 1;
    if (typeof value === 'string') {
      const host = hostOf(value);
      if (host !== undefined && !hosts.includes(host)) hosts.push(host);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        walk((value as Record<string, unknown>)[key], depth + 1);
      }
    }
  };

  walk(args, 0);
  return hosts;
}
