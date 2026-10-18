/**
 * CLI flags + environment -> validated config. Throws ConfigError with a clear message on bad input.
 */
const path = require('node:path');
const { OUTPUTS } = require('./sinks');

const ROOT_DIR = path.join(__dirname, '..');
const CATEGORIES = ['buy', 'rent'];
const MODES = ['recent', 'full'];

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readInt(raw, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`Invalid ${name}=${raw}: expected integer in [${min}, ${max}]`);
  }
  return value;
}

function readList(raw, name, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const items = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  if (!items.length) throw new ConfigError(`Invalid ${name}: empty list`);
  return items;
}

function readUrl(raw, name) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`Invalid ${name}: not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError(`Invalid ${name}: must be http(s)`);
  return url.toString();
}

const BOOLEAN_FLAGS = new Set(['help', 'no-details']);
const VALUE_FLAGS = new Set(['category', 'mode', 'pages', 'stop-after', 'output', 'db', 'jsonl']);

/** Parse `--key=value` / `--key value` / boolean flags. Unknown flags are errors. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new ConfigError(`Unexpected argument '${arg}' (see --help)`);
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) throw new ConfigError(`Flag --${key} takes no value`);
      out[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      let value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value === '') throw new ConfigError(`Flag --${key} needs a value`);
      out[key] = value;
    } else {
      throw new ConfigError(`Unknown flag --${key} (see --help)`);
    }
  }
  return out;
}

function loadConfig(argv = [], env = process.env) {
  const args = parseArgs(argv);

  const category = args.category || 'all';
  if (category !== 'all' && !CATEGORIES.includes(category)) {
    throw new ConfigError(`Invalid --category=${category}: expected buy|rent|all`);
  }
  const mode = args.mode || 'recent';
  if (!MODES.includes(mode)) throw new ConfigError(`Invalid --mode=${mode}: expected recent|full`);

  const outputs = [...new Set(readList(args.output, '--output', ['sqlite']))];
  for (const o of outputs) {
    if (!OUTPUTS.includes(o)) throw new ConfigError(`Invalid --output=${o}: expected ${OUTPUTS.join('|')}`);
  }

  const cityIds = readList(env.DIVAR_CITY_IDS, 'DIVAR_CITY_IDS', ['1']);
  for (const id of cityIds) {
    if (!/^\d+$/.test(id)) throw new ConfigError(`Invalid DIVAR_CITY_IDS: '${id}' is not numeric`);
  }

  const sinkUrl = readUrl(env.SINK_URL, 'SINK_URL');
  const sinkToken = env.SINK_TOKEN || null;
  if (outputs.includes('http')) {
    if (!sinkUrl) throw new ConfigError('SINK_URL is required when --output includes http');
    if (!sinkToken) throw new ConfigError('SINK_TOKEN is required when --output includes http');
  }

  const dbRaw = args.db || env.DIVAR_DB_PATH;
  return {
    help: args.help === true,
    categories: category === 'all' ? [...CATEGORIES] : [category],
    mode,
    maxPages: readInt(args.pages, '--pages', mode === 'full' ? 50 : 3, { min: 1, max: 10000 }),
    stopAfterExisting: readInt(args['stop-after'], '--stop-after', 30, { min: 1 }),
    fetchDetails: args['no-details'] !== true,
    outputs,
    dbPath: dbRaw ? path.resolve(dbRaw) : path.join(ROOT_DIR, 'data/divar.sqlite'),
    jsonlPath: args.jsonl || '-',
    http: {
      timeoutMs: readInt(env.HTTP_TIMEOUT_MS, 'HTTP_TIMEOUT_MS', 20000, { min: 1000 }),
      maxRetries: readInt(env.HTTP_MAX_RETRIES, 'HTTP_MAX_RETRIES', 4, { min: 1, max: 10 }),
      rateLimitBackoffMs: readInt(env.HTTP_RATE_LIMIT_BACKOFF_MS, 'HTTP_RATE_LIMIT_BACKOFF_MS', 15000, { min: 1000 })
    },
    divar: {
      delayMs: readInt(env.DIVAR_DELAY_MS, 'DIVAR_DELAY_MS', 1500),
      cityIds
    },
    sink: {
      url: sinkUrl,
      token: sinkToken,
      batchSize: readInt(env.SINK_BATCH_SIZE, 'SINK_BATCH_SIZE', 25, { min: 1, max: 100 })
    }
  };
}

const HELP = `divar-crawler - crawl Divar residential listings (buy/rent) into contract v1 records

Usage: divar-crawler [options]

  --category=buy|rent|all   category to crawl (default: all)
  --mode=recent|full        recent stops after --stop-after consecutive known listings (default: recent)
  --pages=N                 max search pages per category (default: 3, full: 50)
  --stop-after=N            consecutive known listings that end a recent crawl (default: 30)
  --no-details              only list summaries, skip detail pages
  --output=LIST             comma list of sqlite,jsonl,http (default: sqlite)
  --db=PATH                 SQLite file for state and sqlite output (default: data/divar.sqlite)
  --jsonl=-|PATH            JSONL target, '-' = stdout (default: -)
  --help                    show this help

Environment: DIVAR_DB_PATH, DIVAR_CITY_IDS (default 1 = Tehran), DIVAR_DELAY_MS (default 1500),
HTTP_TIMEOUT_MS, HTTP_MAX_RETRIES, HTTP_RATE_LIMIT_BACKOFF_MS, SINK_URL, SINK_TOKEN, SINK_BATCH_SIZE,
LOG_LEVEL (debug|info|warn|error|silent). Logs are JSON lines on stderr.
`;

module.exports = { loadConfig, parseArgs, ConfigError, HELP, ROOT_DIR };
