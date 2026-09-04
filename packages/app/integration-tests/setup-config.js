import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configName = process.argv[2];

// A config name is a FILE name (`configs/<name>.gsloth.config.json`), not a provider type: several
// names pin a different model of a provider already listed here (`xai-build` is `xai`,
// `google-genai-flash-lite` is `google-genai`). A name missing from this list exits 1 before vitest
// ever starts, so every name used by a CI matrix leg must appear here.
const validConfigs = [
  'groq',
  'anthropic',
  'vertexai',
  'vertexai-preview',
  'vertexai-preview-beta',
  'deepseek',
  'openai',
  'inception',
  'google-genai',
  'google-genai-flash-lite',
  'xai',
  'xai-build',
  'openrouter',
  'huggingface',
  'ollama',
];

console.log(`Provided config "${configName}"`);
if (!configName) {
  console.error(`Please provide a config name: ${validConfigs.join(', ')}`);
  process.exit(1);
}

if (!validConfigs.includes(configName)) {
  console.error(`Invalid config name. Must be one of: ${validConfigs.join(', ')}`);
  process.exit(1);
}

const sourceFile = path.join(__dirname, 'configs', `${configName}.gsloth.config.json`);
const workdirTargetFile = path.join(__dirname, 'workdir', '.gsloth.config.json');

/**
 * GS2-107 — every generated config points the history store INSIDE this tree.
 *
 * The integration suite drives the real `gth` binary, and history recording is on by default, so
 * without this every run of it records into the developer's own `~/.gsloth/history.db`. That was
 * already untidy when the only effect was rows appended; it stopped being tidiable once retention
 * shipped, because an interactive `chat` / `code` cell now also reclaims unreachable conversation
 * state on the way out — a delete, against a real person's file, from a test.
 *
 * The path is under `workdir/`, which is gitignored and cleaned per run.
 */
const historyDbPath = path.join(__dirname, 'workdir', 'it-history.db');

/** Return `config` with the history store pointed at this suite's own database. */
function withIsolatedHistory(config) {
  return { ...config, history: { ...(config.history ?? {}), dbPath: historyDbPath } };
}

// Copy the selected config to workdir
try {
  fs.copyFileSync(sourceFile, workdirTargetFile);
  console.log(`Copied ${configName}.gsloth.config.json to workdir/.gsloth.config.json`);
} catch (error) {
  console.error(`Error copying config file to workdir: ${error.message}`);
  process.exit(1);
}

// Read provider LLm block for profile-specific configs
let providerLLM = undefined;
try {
  const providerConfigRaw = fs.readFileSync(sourceFile, 'utf8');
  const providerConfig = JSON.parse(providerConfigRaw);

  // Ollama uses an ENV-DRIVEN model — the independent test axis (QA-8). The config file pins
  // the provider + params (numCtx/temperature); OLLAMA_IT_MODEL selects the actual model tag.
  // This is the ONLY place the model is chosen: nothing branches the model on the tier/filter.
  // Default `gemma4:12b` MUST match the it.js ollama preflight default so the probe and the SUT
  // agree on which model tag to require/run.
  if (configName === 'ollama' && providerConfig?.llm) {
    const ollamaModel = process.env.OLLAMA_IT_MODEL || 'gemma4:12b';
    providerConfig.llm.model = ollamaModel;
    console.log(`Ollama model set to "${ollamaModel}" (OLLAMA_IT_MODEL) in workdir/.gsloth.config.json`);
  }
  // Always rewritten, never only copied: the copy carries the source file's keys, and the history
  // redirect above has to be in the file the run actually reads. temperature/numCtx and everything
  // else stay exactly as authored.
  fs.writeFileSync(
    workdirTargetFile,
    JSON.stringify(withIsolatedHistory(providerConfig), null, 2),
    'utf8'
  );
  console.log(`History store pointed at ${path.relative(__dirname, historyDbPath)} for this run`);

  providerLLM = providerConfig?.llm;
  if (!providerLLM) {
    console.warn(
      'Warning: No "llm" block found in provider config. Profile configs will not include an "llm" section.'
    );
  }
} catch (error) {
  console.error(`Error reading provider config "${sourceFile}": ${error.message}`);
  process.exit(1);
}

// Helper: recursively gather all files named "source.gsloth.config.json" under a directory
function findSourceConfigs(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findSourceConfigs(fullPath));
    } else if (entry.isFile() && entry.name === 'source.gsloth.config.json') {
      results.push(fullPath);
    }
  }
  return results;
}

// Generate .gsloth.config.json next to each source.gsloth.config.json
const settingsRoot = path.join(__dirname, 'workdir-with-profiles', '.gsloth', '.gsloth-settings');

if (fs.existsSync(settingsRoot)) {
  const sourceConfigs = findSourceConfigs(settingsRoot);
  if (sourceConfigs.length === 0) {
    console.log(`No source.gsloth.config.json files found under ${settingsRoot}`);
  } else {
    console.log(
      `Found ${sourceConfigs.length} source.gsloth.config.json file(s) under ${settingsRoot}`
    );
  }

  for (const srcPath of sourceConfigs) {
    try {
      const raw = fs.readFileSync(srcPath, 'utf8');
      const baseConfig = JSON.parse(raw);

      const merged = withIsolatedHistory({
        ...baseConfig,
        ...(providerLLM ? { llm: providerLLM } : {}),
      });

      const outPath = path.join(path.dirname(srcPath), '.gsloth.config.json');
      fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf8');
      console.log(`Created ${outPath} from ${path.relative(__dirname, srcPath)} + provider llm`);
    } catch (e) {
      console.error(`Failed to create profile config for "${srcPath}": ${e.message}`);
      process.exitCode = 1;
    }
  }
} else {
  console.warn(`Profiles settings directory not found: ${settingsRoot}`);
}

// Clean up per-run artifacts from workdir. They are gitignored, so CI never sees them; this is
// local hygiene, and it matters because the workdir is a fixture directory that tests LIST. The
// aiignore case asserts on the tool panel, which prints only the first TOOL_OUTPUT_PREVIEW_LINES
// lines of the listing, so artifacts accumulating between local runs steadily push real fixtures
// out of the previewed window.
const workdirPath = path.join(__dirname, 'workdir');
const workdirReviewPath = path.join(workdirPath, 'testreview.md');
if (fs.existsSync(workdirReviewPath)) {
  fs.unlinkSync(workdirReviewPath);
  console.log(`Removed workdir/testreview.md`);
}

// The suite's own history database, so one run never reads another's rows.
for (const suffix of ['', '-wal', '-shm']) {
  const stale = `${historyDbPath}${suffix}`;
  if (!fs.existsSync(stale)) continue;
  fs.unlinkSync(stale);
  console.log(`Removed workdir/${path.basename(stale)}`);
}

for (const name of fs.readdirSync(workdirPath)) {
  if (!name.startsWith('gth_')) continue;
  const artifactPath = path.join(workdirPath, name);
  if (!fs.statSync(artifactPath).isFile()) continue;
  fs.unlinkSync(artifactPath);
  console.log(`Removed workdir/${name}`);
}
