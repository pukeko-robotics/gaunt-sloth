/**
 * CFG-82 — the discovery config's two declarations are held together here, at build time.
 *
 * `commands.pr.discovery` and `commands.review.discovery` are declared twice on purpose: their
 * runtime shape is in core's zod schema (`packages/core/src/config/schema.ts`), which is what
 * `gth config validate` and the published JSON Schema read, and their TypeScript types are the
 * interfaces in this package, merged into core's command config by module augmentation because
 * `tools` is typed with LangChain tool types. Two declarations drift unless something compares
 * them, and a drifted schema fails quietly: a field the interfaces gained but the schema lacks is
 * stripped before it is checked, and a field only the schema has is accepted and never read.
 *
 * So this file does not compile unless, for each of `PrDiscoveryConfig` and
 * `ReviewDiscoveryConfig`, the interface and the zod-inferred shape have the same set of keys and,
 * for every key but `tools`, the same type. `tools` is bounded rather than equated: the interface
 * names LangChain tool arrays and the schema takes an array of anything (as the root `tools` does,
 * since a JS config passes live instances), so the check there is one-directional — every value the
 * interface allows, the schema accepts. The key-set check still catches `tools` being added or
 * removed on either side.
 *
 * Nothing here exists at runtime. `pnpm run build` is the gate; `discoveryConfigSchemaAgreement
 * .spec.ts` type-checks this file directly as well, beside a probe proving the comparison can fail.
 */
import type { RawGthConfigInput } from '@gaunt-sloth/core/config/schema.js';
import type { PrDiscoveryConfig } from '#src/commands/prDiscovery.js';
import type { ReviewDiscoveryConfig } from '#src/commands/reviewDiscovery.js';

/** `true` only when `A` and `B` are the same type (not merely mutually assignable). */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compiles only when its argument is `true`. */
export type Expect<T extends true> = T;

/**
 * Same keys, same types for every key but `tools`, and the interface's `tools` accepted by the
 * schema's. Optional keys count: mutual assignability alone would miss a new optional field.
 */
export type DiscoveryShapesAgree<Interface, Schema> =
  Equal<keyof Interface, keyof Schema> extends true
    ? Equal<Omit<Interface, 'tools'>, Omit<Schema, 'tools'>> extends true
      ? 'tools' extends keyof Interface
        ? Interface['tools' & keyof Interface] extends Schema['tools' & keyof Schema]
          ? true
          : false
        : true
      : false
    : false;

/** `commands` as core's zod schema infers it. */
export type SchemaCommands = NonNullable<RawGthConfigInput['commands']>;
/** `commands.pr.discovery` as core's zod schema infers it. */
export type SchemaPrDiscovery = NonNullable<NonNullable<SchemaCommands['pr']>['discovery']>;
/** `commands.review.discovery` as core's zod schema infers it. */
export type SchemaReviewDiscovery = NonNullable<NonNullable<SchemaCommands['review']>['discovery']>;

/** Exported only so the assertions are not unused; it carries no information. */
export type DiscoveryConfigSchemaAgreement = [
  Expect<DiscoveryShapesAgree<PrDiscoveryConfig, SchemaPrDiscovery>>,
  Expect<DiscoveryShapesAgree<ReviewDiscoveryConfig, SchemaReviewDiscovery>>,
];
