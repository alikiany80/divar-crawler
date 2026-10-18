const { loadConfig, ConfigError, HELP } = require('./config');
const { createLogger } = require('./logger');
const { DivarAdapter } = require('./divar/adapter');
const { StateStore } = require('./state');
const { createSinks } = require('./sinks');
const { CrawlRunner } = require('./runner');

const log = createLogger('cli');

/**
 * Run the crawler. Returns a process exit code (0 ok, 1 crawl failure, 2 bad config).
 * deps lets tests inject an adapter / stdout / fetch.
 */
async function main(argv, env = process.env, deps = {}) {
  let config;
  try {
    config = loadConfig(argv, env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`divar-crawler: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  if (config.help) {
    (deps.stdout || process.stdout).write(HELP);
    return 0;
  }

  const adapter = deps.adapter || new DivarAdapter({
    http: config.http, delayMs: config.divar.delayMs, cityIds: config.divar.cityIds
  });
  const state = new StateStore(config.dbPath);
  const sinks = createSinks(config, deps);
  const runner = new CrawlRunner(adapter, state, sinks, { fetchDetails: config.fetchDetails });

  const results = {};
  let exitCode = 0;
  try {
    for (const category of config.categories) {
      try {
        results[category] = await runner.crawl({
          category, mode: config.mode, maxPages: config.maxPages, stopAfterExisting: config.stopAfterExisting
        });
      } catch (err) {
        exitCode = 1;
        results[category] = { error: err.message };
        log.error('crawl failed', { category, error: err.message });
      }
    }
  } finally {
    for (const sink of sinks) {
      try {
        await sink.close();
      } catch (err) {
        exitCode = 1;
        log.error('sink close failed', { sink: sink.name, error: err.message });
      }
    }
    state.close();
  }

  log.info('run summary', { results, http: adapter.client?.stats ?? null });
  return exitCode;
}

module.exports = { main };
