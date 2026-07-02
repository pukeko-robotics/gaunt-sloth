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
 * autocomplete + validation. A relative `node_modules` path is used rather than a published
 * URL because it is the least speculative option: the JSON Schema ships inside the published
 * `@gaunt-sloth/core` package (`files: ["./schema/*"]`), so this resolves offline right after
 * `npm i` and never 404s / drifts against a hand-stamped hosted copy (PLAT-9 would be needed to
 * make a stable hosted URL authoritative).
 */
export const CONFIG_SCHEMA_POINTER =
  './node_modules/@gaunt-sloth/core/schema/gsloth-config.schema.json';
/**
 * EXT-9 Tier-2: project-scoped persisted shell allow-list (`always` approvals).
 * Lives under `.gsloth/.gsloth-settings/` like other project settings.
 */
export const SHELL_ALLOWLIST_FILE = 'shell-allowlist.json';
