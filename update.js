'use strict';
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execFile, spawn } = require('child_process');
const { atomicWrite, C } = require('./utils');

const CACHE_TTL_MS = 6 * 3600000;
const WORKER_PATH = path.join(__dirname, 'update-worker.js');

// Stale-While-Revalidate: always return the cached verdict (even when stale) so the
// statusline tick never blocks on claude --version + HTTPS. When stale, kick off a
// DETACHED background worker that writes the fresh verdict for the next tick.
function checkClaudeUpdate(cachePath) {
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}

  const age = cache?.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age >= CACHE_TTL_MS) {
    // In-flight guard: sem isso, toda tick com cache stale dá spawn de um worker
    // novo enquanto o anterior ainda busca (claude --version + HTTPS ~1.5s),
    // empilhando processos. O lock (mtime) suprime spawns por LOCK_TTL_MS; se um
    // worker morrer sem escrever, o lock fica stale e o próximo tick refaz.
    const LOCK_TTL_MS = 30000;
    const lockPath = `${cachePath}.lock`;
    let locked = false;
    try { locked = Date.now() - fs.statSync(lockPath).mtimeMs < LOCK_TTL_MS; } catch {}
    if (!locked) {
      try { fs.writeFileSync(lockPath, String(Date.now())); } catch {}
      try {
        const child = spawn(process.execPath, [WORKER_PATH, cachePath], {
          detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.unref();
      } catch {}
    }
  }

  if (cache) {
    return Promise.resolve({
      latest: cache.latest || null,
      current: cache.current || null,
      update_available: !!cache.update_available,
      error: cache.error || null,
    });
  }
  // First-ever run: don't block. Next tick (once the worker finishes) surfaces update info.
  return Promise.resolve({ latest: null, current: null, update_available: false, error: null });
}

// True when version `a` is strictly newer than `b` (numeric dotted compare).
// Unparseable segments fall back to inequality — better a false chip than a missed update.
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return a !== b;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function _refresh(cachePath) {
  const isWin = process.platform === 'win32';
  const write = (data) => {
    try { atomicWrite(cachePath, JSON.stringify({ ...data, timestamp: Date.now() })); } catch {}
  };
  try {
    // Windows needs shell:true so PATHEXT resolves the CLI regardless of install
    // channel — claude.exe (native installer) or claude.cmd (npm). Hardcoding
    // 'claude.cmd' broke native installs with a permanent no-cli verdict.
    // Args are hardcoded, no injection risk.
    execFile('claude', ['--version'], { timeout: 1500, encoding: 'utf8', shell: isWin }, (err, stdout) => {
      if (err) return write({ update_available: false, error: 'no-cli' });
      const current = stdout.trim().split(/\s+/)[0];
      const req = https.get('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', { timeout: 1500 }, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const latest = JSON.parse(body).version;
            const hasUpdate = latest && latest !== current;
            write({ current, latest, update_available: hasUpdate, error: null });
          } catch { write({ update_available: false, error: 'parse' }); }
        });
      });
      req.on('error', () => write({ update_available: false, error: 'network' }));
      req.on('timeout', () => { req.destroy(); write({ update_available: false, error: 'timeout' }); });
    });
  } catch {
    write({ update_available: false, error: 'no-cli' });
  }
}

function formatUpdateStr(result, outdated) {
  if (outdated && result.latest) return `${C.green}\u2193${result.latest}${C.reset} `;
  if (result.error && result.error !== 'no-cli') return `${C.soft}\u2193(${result.error})${C.reset} `;
  return '';
}

module.exports = { checkClaudeUpdate, formatUpdateStr, isNewer, _refresh };
