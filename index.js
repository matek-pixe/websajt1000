'use strict';

// Entry-point shim. Some hosts (e.g. bot-hosting.net) run `node index.js` from the project root
// by default. The real bot lives in src/index.js — this just loads it so the default startup works.
require('./src/index.js');
