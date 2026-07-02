# Migrating to 2.0

Gaunt Sloth 2.0 is a **breaking config release**. The config schema is now validated
strictly (via a single Zod source of truth), and there is **no back-compat coercion** for
the old shapes. If you are coming from a 1.x config, read this page before you upgrade.

The fastest way to check a migrated config is:

```bash
gth config validate
```

It validates your effective config against the 2.0 schema **without** building an LLM or
running anything. Warnings (deprecated names, unknown keys) print but do not fail; a real
schema violation prints a path-scoped message and exits non-zero. Use `gth config print`
to see the fully-resolved config (secrets redacted) after your edits.

## Severity at a glance

Changes split into two buckets. Fix the HARD ones before you upgrade; the SOFT ones keep
working but you should migrate them (the deprecation bridges are temporary).

### HARD (gth aborts, or scripts break)

| Change | What breaks | Fix |
| --- | --- | --- |
| `rating` is now an object | `rating: false` (or any boolean) is a validation abort: `expected object, received boolean` | `rating: { enabled: false }` |
| `--content-provider` / `--requirements-provider` CLI flags removed | Scripts passing those flags error out | `--content-source` / `--requirements-source` (`-p` still aliases `--requirements-source`) |
| `ContentProviderType` / `RequirementsProviderType` type exports removed, and the runtime `contentProvider` / `requirementsProvider` fields removed | TypeScript / programmatic configs that import those types or read those fields fail to compile or resolve | Use `contentSource` / `requirementSource` (and their `string` types) |

### SOFT (still loads, prints a warning)

| Change | Behaviour | Fix |
| --- | --- | --- |
| Command configs must nest under `commands.*` | A top-level command key (e.g. `pr`) is preserved but warns as an unknown top-level key | Move it under `commands.<cmd>` |
| Deprecated `*Provider*` config keys | `contentProvider` / `requirementsProvider` (and the `*ProviderConfig` variants) still load, remapped with a deprecation warning | Rename to `contentSource` / `requirementSource` (and `*SourceConfig`) |

There is also one behaviour change (array merge across config layers) that is not a
validation error but can change results silently. It is covered in section D below.

---

## A. Command configs nest under `commands.*` (SOFT)

In 2.0 the per-command settings (`pr`, `review`, `ask`, `chat`, `code`, `exec`, `api`)
live under a top-level `commands` object. The config root is a loose schema, so a leftover
top-level command key is not a hard error: it is kept as-is but ignored, and you get an
"Unknown top-level config key" warning (which usually means a typo). Since the key is
ignored, your settings silently stop taking effect, so migrate it.

Before:

```json
{
  "llm": { "type": "anthropic" },
  "pr": {
    "requirementSource": "github"
  }
}
```

After:

```json
{
  "llm": { "type": "anthropic" },
  "commands": {
    "pr": {
      "requirementSource": "github"
    }
  }
}
```

## B. `rating` is now an object (HARD)

The old boolean shorthand for disabling review rating is gone. `rating` (under a command,
e.g. `commands.pr.rating` / `commands.review.rating`) is now an object:
`{ enabled?, passThreshold?, maxRating?, minRating?, errorOnReviewFail? }`. A boolean value
fails schema validation and aborts the run with `Invalid configuration ... expected object,
received boolean`.

Before:

```json
{
  "commands": {
    "pr": {
      "rating": false
    }
  }
}
```

After:

```json
{
  "commands": {
    "pr": {
      "rating": { "enabled": false }
    }
  }
}
```

If you were relying on the default (rating on), you do not need to add anything; only an
explicit `rating: false` (or `rating: true`) needs migrating.

## C. `*Provider*` names renamed to `*Source*` (mixed)

The historical `*Provider*` naming was renamed to `*Source*` across the board. This one is
part SOFT, part HARD depending on how you configured it.

**Config file keys (SOFT).** In `.gsloth.config.*` the old keys still load, remapped
one-way to the canonical names with a deprecation warning. This bridge is temporary, so
rename them now. The renames:

- `contentProvider` -> `contentSource`
- `requirementsProvider` -> `requirementSource`
- `contentProviderConfig` -> `contentSourceConfig` (root level)
- `requirementsProviderConfig` -> `requirementSourceConfig` (root level)

The per-command blocks accept the two source keys (`contentSource`, `requirementSource`);
the `*SourceConfig` companions live at the config root.

Before:

```json
{
  "contentProvider": "file",
  "requirementsProvider": "jira",
  "requirementsProviderConfig": {
    "cloudId": "...",
    "displayUrl": "https://your-org.atlassian.net"
  }
}
```

After:

```json
{
  "contentSource": "file",
  "requirementSource": "jira",
  "requirementSourceConfig": {
    "cloudId": "...",
    "displayUrl": "https://your-org.atlassian.net"
  }
}
```

**CLI flags (HARD).** The `--content-provider` and `--requirements-provider` flags are
removed. Update any scripts or CI to the new flags:

- `--content-provider` -> `--content-source`
- `--requirements-provider` -> `--requirements-source`

The short alias `-p` is preserved and still maps to `--requirements-source`, so
`gth pr -p github 123` keeps working.

Before:

```bash
gth pr --requirements-provider jira --content-provider file 123
```

After:

```bash
gth pr --requirements-source jira --content-source file 123
```

**TypeScript / programmatic configs (HARD).** The `ContentProviderType` and
`RequirementsProviderType` type exports are removed, and so are the runtime
`contentProvider` / `requirementsProvider` fields on the config object. Code that imports
those types or reads those fields will not compile / resolve. Use `contentSource` /
`requirementSource` (typed as `string`) instead.

Before:

```ts
import type { ContentProviderType } from '@gaunt-sloth/core';

export async function configure() {
  return {
    contentProvider: 'file' as ContentProviderType,
    requirementsProvider: 'jira',
  };
}
```

After:

```ts
export async function configure() {
  return {
    contentSource: 'file',
    requirementSource: 'jira',
  };
}
```

## D. Array merge policy across config layers (behaviour change)

When both a global config (`~/.gsloth/...`) and a project config are present, they are
deep-merged (project wins). In 2.0, arrays **replace** by default instead of merging across
layers. The only exceptions are two genuinely-cumulative lists, which still concatenate and
de-duplicate:

- `allowDirs`
- `aiignore.patterns`

Every other array (`allowedTools`, `builtInTools`, `tools`, `middleware`, `binaryFormats`,
and so on) is now taken wholesale from the higher-precedence layer. So if you were leaning
on a global config to contribute, say, extra `allowedTools` that got unioned with the
project list, that no longer happens: define the full set in the layer that should own it.

This is not a validation error and `gth config validate` will not flag it. It only matters
when you split config across the global and project layers. `gth config print` shows the
final merged result, which is the quickest way to confirm the effective arrays.

## E. New in 2.0 (additive, nothing to migrate)

These are new capabilities, not breaking changes, but they are useful while migrating:

- **Up-tree project-config discovery.** Gaunt Sloth walks up from the current directory to
  find the project config, stopping at the git root, your home directory, or the filesystem
  root (whichever comes first). You can run it from a subdirectory of your project.
- **TypeScript config (`.gsloth.config.ts`).** A `configure()`-exporting `.ts` config is
  now supported (loaded via jiti), alongside `.json`, `.js`, and `.mjs`.
- **Generated JSON Schema + `$schema` editor support.** The config shape is published as a
  JSON Schema, and you can add a `$schema` key to your JSON config for editor autocomplete
  and validation. The `$schema` key is allowed by the schema and never read at runtime.
- **`gth config validate` and `gth config print`.** Validate a migrated config against the
  2.0 schema (`validate`), or inspect the fully-resolved config with secrets redacted
  (`print`, add `--json` for machine-readable output). Both honour `--config` and
  `--identity-profile`.

## Migration checklist

1. Move top-level command keys (`pr`, `review`, `ask`, `chat`, `code`, `exec`, `api`) under
   `commands.*` (A).
2. Convert any `rating: false` / `rating: true` to `rating: { enabled: false }` /
   `{ enabled: true }` (B).
3. Rename `*Provider*` config keys to `*Source*`, update CLI flags in scripts, and update
   any TypeScript that imported the removed provider types (C).
4. If you split config across global + project, re-check arrays that used to merge (D).
5. Run `gth config validate` (and optionally `gth config print`) to confirm the result.
