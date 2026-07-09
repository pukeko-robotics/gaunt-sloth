export const GSLOTH_DIR = '.gsloth';
export const GSLOTH_SETTINGS_DIR = '.gsloth-settings';
export const GSLOTH_AUTH = '.gsloth-auth';
export const USER_PROJECT_CONFIG_JS = '.gsloth.config.js';
export const USER_PROJECT_CONFIG_JSON = '.gsloth.config.json';
export const USER_PROJECT_CONFIG_MJS = '.gsloth.config.mjs';
export const USER_PROJECT_CONFIG_TS = '.gsloth.config.ts';
export const GSLOTH_BACKSTORY = '.gsloth.backstory.md';
export const PROJECT_GUIDELINES = '.gsloth.guidelines.md';
export const PROJECT_REVIEW_INSTRUCTIONS = '.gsloth.review.md';
export const GSLOTH_SYSTEM_PROMPT = '.gsloth.system.md';
export const GSLOTH_CHAT_PROMPT = '.gsloth.chat.md';
export const GSLOTH_CODE_PROMPT = '.gsloth.code.md';
export const GSLOTH_EXEC_PROMPT = '.gsloth.exec.md';
export const AIIGNORE_FILE = '.aiignore';
/**
 * `$schema` pointer written into a generated `.gsloth.config.json` (GS2-1) so editors offer
 * autocomplete + validation. The **hosted, major-pinned** URL is used rather than a relative
 * `node_modules` path because the relative path only resolves when `@gaunt-sloth/core` sits in a
 * `node_modules` beside the config, which is NOT the case for a globally-installed CLI
 * (`npm i -g`): the schema lands in the global prefix, not next to the user's project config, so
 * a relative pointer would silently fail to resolve. A hosted URL resolves for every install mode
 * (global, npx, local, or a hand-written config with nothing installed) and is the standard
 * convention editors fetch + cache.
 *
 * The channel is **major-pinned** (`/schema/v2/…`, not `latest` or `alpha`) so a config never
 * revalidates against a future major it was not written for. The hosted copy is kept in sync with
 * this package's generated schema by the deploy runbook in
 * `websites/gauntsloth.app/schema/README.md` (interim, hand-run) and, in time, PLAT-9's automated
 * release step. The schema still ships inside the package (`files: ["./schema/*"]`) as an offline
 * artifact and golden-snapshot source of truth; it is just no longer what the pointer references.
 */
export const CONFIG_SCHEMA_POINTER = 'https://gauntsloth.app/schema/v2/gsloth-config.schema.json';
/**
 * EXT-9 Tier-2: project-scoped persisted shell allow-list (`always` approvals).
 * Lives under `.gsloth/.gsloth-settings/` like other project settings.
 */
export const SHELL_ALLOWLIST_FILE = 'shell-allowlist.json';
