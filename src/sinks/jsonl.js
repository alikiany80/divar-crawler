/**
 * JsonlSink: one contract listing per line to a file (appended) or '-' (stdout).
 */
const fs = require('node:fs');
const path = require('node:path');

class JsonlSink {
  constructor(target, { stdout = process.stdout } = {}) {
    if (!target) throw new Error('JsonlSink requires a target path or "-"');
    this.name = 'jsonl';
    this.target = target;
    this.written = 0;
    if (target === '-') {
      this.stream = stdout;
      this.ownsStream = false;
    } else {
      fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      this.stream = fs.createWriteStream(target, { flags: 'a', encoding: 'utf8' });
      this.ownsStream = true;
    }
  }

  async write(listing) {
    const line = JSON.stringify(listing) + '\n';
    if (!this.stream.write(line)) {
      await new Promise(resolve => this.stream.once('drain', resolve));
    }
    this.written++;
  }

  async flush() {}

  async close() {
    if (!this.ownsStream) return;
    await new Promise((resolve, reject) => {
      this.stream.end(err => (err ? reject(err) : resolve()));
    });
  }
}

module.exports = { JsonlSink };
