const { SqliteSink } = require('./sqlite');
const { JsonlSink } = require('./jsonl');
const { HttpSink } = require('./http');

const OUTPUTS = ['sqlite', 'jsonl', 'http'];

/** Build every sink selected by config.outputs (multiple allowed, e.g. ['sqlite', 'jsonl']). */
function createSinks(config, deps = {}) {
  return config.outputs.map(output => {
    switch (output) {
      case 'sqlite':
        return new SqliteSink(config.dbPath);
      case 'jsonl':
        return new JsonlSink(config.jsonlPath, { stdout: deps.stdout });
      case 'http':
        return new HttpSink({
          url: config.sink.url,
          token: config.sink.token,
          batchSize: config.sink.batchSize,
          timeoutMs: config.http.timeoutMs,
          maxRetries: config.http.maxRetries,
          fetch: deps.fetch
        });
      default:
        throw new Error(`Unknown output '${output}' (available: ${OUTPUTS.join(', ')})`);
    }
  });
}

module.exports = { createSinks, OUTPUTS };
