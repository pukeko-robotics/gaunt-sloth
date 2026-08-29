# Release notes howto

One file per released version, in this directory: `v` + the version with **every dot replaced by an
underscore** + `.md`. So `1.1.0` is `v1_1_0.md` and the prerelease `2.0.0-beta.3` is
`v2_0_0-beta_3.md`. Notes for the 0.x line are archived under `v0/`.

**The release pipeline reads the file for the version being shipped.** Its `#` heading becomes the
GitHub Release title and the rest becomes the Release body. A version with no file here gets a
Release with a blank body — nothing is synthesised to fill it, and no error says the notes were
missed. So the notes are written before a release is dispatched.

## Conventions

- **The H1 is normally just the version**, as in `# v2.0.0-beta.3`. A descriptive suffix — as in
  `# v2.0.0-beta.2 The Alignment Check` — is earned by a release carrying a new feature, or a change
  that is big **to someone using the tool**. Work that was significant to the project and is a
  non-event for a user keeps the flat heading.
- **Most files are three to seven lines of text.** Concision is the default, not a fallback for a
  release with little in it.
- **Release notes are documentation.** When something genuinely important ships, one or two
  paragraphs for that feature is enough.

A file that is nothing but its H1 is a valid release note: the Release page then shows that title
and nothing under it.

- **While `latest` points at a prerelease, say what that does to a library consumer.** A known-good
  prerelease is deliberately promoted to `latest`, so `npm i @gaunt-sloth/<pkg>` writes a
  `^2.0.0-beta.N` range that admits every later prerelease of the same version — the user is
  subscribed to a line where breaking changes are still permitted, and nothing they typed said so.
  It is not a breaking change and does not belong under that heading; it is a consequence of the
  channel and is worth one bullet on the release that introduces it. Installing the CLI globally is
  unaffected, since that writes no manifest.

## Style

Dry and factual, not excited or marketing-oriented. `v2_0_0-beta_3.md` is the shape to follow.
Write what a user can now do, or what changed under them. Leave out unit tests, integration tests
and other development-specific detail.

## Writing them

1. Review the changes from the latest tag to HEAD.
2. List this directory and read a few recent files.
3. Write the file for the version in `packages/core/package.json` — the release ships the version
   the repository is on now, and bumps to the next one afterwards
   ([maintenance/RELEASE-HOWTO.md](../maintenance/RELEASE-HOWTO.md)).
4. Present the notes to the user and ask for confirmation.

## Structure

A short file needs no headings at all — bullets under the H1 are enough, and most releases end
there. A release large enough to sort uses the sections that apply, and only those:

- **New Features**: major functionality additions
- **Potentially Breaking Changes**: changes that require the user to do something
- **Bug Fixes**: resolved issues
- **Improvements**: refactoring, performance, architecture
- **Maintenance**: dependency updates, minor fixes

For a breaking change, say what the user has to do about it.
