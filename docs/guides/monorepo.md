# Work in a monorepo

Config discovery walks **up** from the directory you run `gth` in, so you don't have to sit in the
repo root or pass a path. From any package subdirectory, `gth` finds the nearest `.gsloth.config.*`
above you — up to, and including, your repo root.

## The main use case: one shared config at the repo root

Goal: keep a single `.gsloth.config.json` at the monorepo root and have every package use it,
whatever subdirectory you invoke `gth` from.

```
acme-platform/
├── .git/
├── .gsloth.config.json
└── packages/
    └── api/
        └── src/server.ts
```

Run `gth` from inside the package:

```bash
cd packages/api
gth ask "summarise src/server.ts"
```

Discovery walks up `packages/api` → `packages` → `acme-platform`, finds `.gsloth.config.json` at
the root, and uses it. The walk **searches each directory from the current one upward and stops at
(and including) the first directory that contains `.git`, your home directory, or the filesystem
root** — whichever comes first. So a config at or below the git root is found; one *above* it is
not. In a monorepo the `.git` sits at the root, which is exactly where the shared config lives, so
the walk lands there and no per-package setup is needed.

Two details that decide *which* file wins:

- **Nearest directory wins** — discovery returns the first match and stops; it does not merge
  configs from several directories. Within one directory the format order is
  `.gsloth.config.json` → `.jsonc` → `.js` → `.mjs`.
- The root config may live either at `acme-platform/.gsloth.config.json` or, for a tidier root, at
  `acme-platform/.gsloth/.gsloth-settings/.gsloth.config.json`; both are discovered by the same
  walk.

If a package is itself a git submodule (its own `.git`), the walk stops at that submodule's root
and never reaches the monorepo root — put a config there, or pass one with `-c`.

## When a package needs its own config

Drop a `.gsloth.config.json` into the package directory. Because the nearest match wins, runs
inside that package use it:

```
acme-platform/
├── .gsloth.config.json           # used everywhere else
└── packages/
    └── ml/
        └── .gsloth.config.json    # used for runs inside packages/ml
```

The package config **replaces** the root config for those runs — it is not merged with it — so it
must be complete on its own (at minimum a valid `llm` spec). The only layer that merges *underneath*
a discovered project config is the global `~/.gsloth` config, so genuinely cross-cutting settings
belong there rather than being duplicated into each package.

## Examples

```bash
# From any package subdir — finds the repo-root .gsloth.config.json by walking up
cd packages/api && gth ask "summarise src/server.ts"

# Skip discovery entirely and point gth at a specific config file
gth -c ./.gsloth.config.json ask "who are you?"

# Package-local config: runs inside packages/ml use packages/ml/.gsloth.config.json
cd packages/ml && gth ask "which model is configured here?"
```

## Related

- Config file formats, the `.gsloth/.gsloth-settings/` directory, and the full load cascade
  (global → project → CLI flags): [Configuration](../configuration/index.md).
- Give a team its own config block under `.gsloth/.gsloth-settings/<name>/`:
  [Identity profiles](../configuration/profiles.md).
- Settings shared across every repo go in the global config:
  [Providers & global config](../configuration/providers.md).
