'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Create an isolated temp directory for a test and return it. */
function tmpDir(prefix = '35xw-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const user = (id, username = `user${id}`) => ({ id: String(id), username });

module.exports = { tmpDir, rm, user };
