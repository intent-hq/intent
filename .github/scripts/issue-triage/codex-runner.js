'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Pin the CLI because its tool configuration is part of the security boundary.
// Keep the workflow's codex-version input in sync with this constant.
const CODEX_VERSION = '0.156.1';
const CODEX_MODEL = 'gpt-5.4-mini';
const MAX_OUTPUT_BYTES = 1024 * 1024;

const nullableEnum = (values) => ({ type: ['string', 'null'], enum: [...values, null] });
const object = (properties) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const RESPONSE_SCHEMA = object({
  duplicates: {
    type: 'array', items: object({
      number: { type: 'integer', minimum: 1 },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string' },
    }),
  },
  component: nullableEnum(['intentd', 'fe', 'ios']),
  type: nullableEnum(['bug', 'enhancement', 'question']),
  priority: nullableEnum(['Urgent', 'High', 'Medium', 'Low']),
  effort: nullableEnum(['Low', 'Medium', 'High']),
  security: { type: 'boolean' },
  reasons: object(Object.fromEntries(
    ['component', 'type', 'priority', 'effort'].map((key) => [key, { type: 'string' }])
  )),
});

// No command execution, integrations, delegation or inherited instructions.
// apply_patch is still registered by this CLI version, but read-only + never
// rejects its writes. Do not replace the disabled shell tools with a prompt rule.
// The official Action appends its trusted Responses proxy configuration here.
const CODEX_CONFIG = [
  'approval_policy = "never"',
  'sandbox_mode = "read-only"',
  'project_doc_max_bytes = 0',
  'project_root_markers = [".triage-root"]',
  'web_search = "disabled"',
  'cli_auth_credentials_store = "ephemeral"',
  'check_for_update_on_startup = false',
  'model_reasoning_effort = "low"',
  '[history]',
  'persistence = "none"',
  '[features]',
  ...[
    'shell_tool', 'unified_exec', 'shell_snapshot', 'code_mode', 'code_mode_host',
    'code_mode_only', 'apps', 'plugins', 'remote_plugin', 'skill_search',
    'skill_mcp_dependency_install', 'hooks', 'multi_agent', 'multi_agent_v2',
    'browser_use', 'computer_use', 'image_generation', 'view_image', 'goals',
    'memories', 'sleep_tool',
  ].map((name) => `${name} = false`),
  '',
].join('\n');

// Validate the small, fixed schema locally as well as requesting structured
// output. A successful process exit, arbitrary JSON, or JSONL progress is not a
// classification. The existing parser then sanitizes text and gates all writes.
function matchesSchema(value, schema) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const allowedTypes = [].concat(schema.type);
  if (!allowedTypes.includes(type) && !(schema.type === 'integer' && Number.isSafeInteger(value))) {
    return false;
  }
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.minimum !== undefined && value < schema.minimum) return false;
  if (type === 'array') return value.every((item) => matchesSchema(item, schema.items));
  if (type === 'object') {
    return schema.required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => Object.hasOwn(schema.properties, key) &&
        matchesSchema(value[key], schema.properties[key]));
  }
  return true;
}

function validateResponse(text) {
  let value;
  try { value = JSON.parse(text); } catch { /* Rejected below. */ }
  if (!value || !matchesSchema(value, RESPONSE_SCHEMA)) {
    throw new Error('Codex output is not a valid structured triage response');
  }
  return text;
}

function readResponse(file) {
  if (fs.statSync(file).size > MAX_OUTPUT_BYTES) throw new Error('Codex output is too large');
  return validateResponse(fs.readFileSync(file, 'utf8'));
}

function initializeWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'home'));
  fs.mkdirSync(path.join(dir, 'codex-home'));
  fs.mkdirSync(path.join(dir, 'work'));
  fs.writeFileSync(path.join(dir, 'work', '.triage-root'), '');
  fs.writeFileSync(path.join(dir, 'codex-home', 'config.toml'), CODEX_CONFIG);
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(RESPONSE_SCHEMA));
}

function codexArgs(dir) {
  return [
    'exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    '--sandbox', 'read-only', '--model', CODEX_MODEL,
    '--output-schema', path.join(dir, 'schema.json'),
    '--output-last-message', path.join(dir, 'response.json'), '-',
  ];
}

function runCodex(instruction, { timeout = 300000, env = process.env } = {}) {
  if (!env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY is required for Codex classification');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-triage-codex-'));
  try {
    initializeWorkspace(dir);
    // Allowlist rather than scrub: no GitHub/Actions credentials, NODE_OPTIONS,
    // proxy overrides, personal auth, MCP settings or agent-session variables.
    const childEnv = {
      PATH: env.PATH,
      HOME: path.join(dir, 'home'),
      XDG_CONFIG_HOME: path.join(dir, 'home', '.config'),
      XDG_DATA_HOME: path.join(dir, 'home', '.local', 'share'),
      CODEX_HOME: path.join(dir, 'codex-home'),
      CODEX_API_KEY: env.OPENAI_API_KEY,
    };
    const options = {
      encoding: 'utf8', cwd: path.join(dir, 'work'), env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
      timeout, killSignal: 'SIGKILL',
    };
    const version = execFileSync('codex', ['--version'], {
      ...options, timeout: Math.min(timeout, 10000),
    }).trim();
    if (version !== `codex-cli ${CODEX_VERSION}`) {
      throw new Error(`Codex CLI ${CODEX_VERSION} is required`);
    }
    // Never put issue text in argv or a shell. Read only the final-message file;
    // stdout/stderr can contain progress, diagnostics and untrusted issue text.
    execFileSync('codex', codexArgs(dir), { ...options, input: instruction });
    return readResponse(path.join(dir, 'response.json'));
  } catch (error) {
    if (error.code === 'ETIMEDOUT') throw new Error('Codex classification timed out');
    if (error.code === 'ENOENT') throw new Error('Codex executable or response file is missing');
    if (error.status != null || error.signal) throw new Error('Codex classification process failed');
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const digest = (text) => createHash('sha256').update(text).digest('hex');

// The prepare/apply contract keeps GitHub credentials in the Node/gh steps and
// the API key in the official Action's proxy. Prepare is always read-only.
// Apply re-runs the existing preflight gates and checks the prompt digest so a
// response cannot be replayed against changed issue data or another CLI mode.
function prepareClassifier(dir, request) {
  fs.mkdirSync(dir, { mode: 0o700 }); // Refuse stale/reused output directories.
  initializeWorkspace(dir);
  const manifest = { version: 1, ...request, needsModel: false, promptSha256: null };
  const save = () => fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(manifest));
  save();
  return (instruction) => {
    fs.writeFileSync(path.join(dir, 'prompt.txt'), instruction);
    manifest.needsModel = true;
    manifest.promptSha256 = digest(instruction);
    save();
    console.log(`Codex prompt prepared in ${dir}`);
    return null;
  };
}

function appliedClassifier(dir, request) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
  if (manifest.version !== 1 || Object.keys(request).some((key) => manifest[key] !== request[key])) {
    throw new Error('Prepared Codex request does not match this issue, repository or CLI mode');
  }
  return (instruction) => {
    if (!manifest.needsModel || manifest.promptSha256 !== digest(instruction)) {
      throw new Error('Issue or candidates changed since preparation; prepare classification again');
    }
    return readResponse(path.join(dir, 'response.json'));
  };
}

module.exports = {
  CODEX_VERSION, CODEX_MODEL, CODEX_CONFIG, RESPONSE_SCHEMA,
  codexArgs, runCodex, validateResponse, prepareClassifier, appliedClassifier,
};
