'use strict';
// Detached worker: refreshes the Claude update check cache without blocking the statusline tick.
// Invoked by update.js via child_process.spawn({ detached: true, stdio: 'ignore' }).
const cachePath = process.argv[2];
if (!cachePath) process.exit(0);
const { _refresh } = require('./update');
_refresh(cachePath);
