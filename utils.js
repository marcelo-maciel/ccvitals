'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Constants ────────────────────────────────────────────
const AGENT_WARN_SECS = 300;
const AGENT_CRIT_SECS = 600;
const AGENT_ZOMBIE_SECS = 1800;
// Baseline observado do setup atual (system prompt + tools + skills + memória),
// calibrado contra /context (~35k = 4% em janela de 1M). Usado só como estimativa
// de cold-start / fallback de post-compact, antes da primeira usage real. Revisar
// se a carga de plugins/MCP/skills mudar bastante.
const ESTIMATED_STARTING_TOKENS = 35000;
const MAX_RL_RESET_MINUTES = 7 * 24 * 60;
const FIVE_HOURS_MS = 5 * 3600000;

// ─── Color theme ──────────────────────────────────────────
const C = {
  reset: '\x1b[0m', gray: '\x1b[38;5;245m', soft: '\x1b[38;5;250m',
  barEmpty: '\x1b[38;5;238m', green: '\x1b[32m', yellow: '\x1b[33m',
  warn: '\x1b[38;5;221m', orange: '\x1b[38;5;208m', danger: '\x1b[38;5;203m',
  red: '\x1b[31m', bold: '\x1b[1m', cyan: '\x1b[36m',
  personalColor: '\x1b[38;5;39m', teamColor: '\x1b[38;5;42m',
};
const accentMap = {
  orange: '\x1b[38;5;173m', blue: '\x1b[38;5;74m', teal: '\x1b[38;5;66m',
  green: '\x1b[38;5;71m', lavender: '\x1b[38;5;139m', rose: '\x1b[38;5;132m',
  gold: '\x1b[38;5;136m', slate: '\x1b[38;5;60m', cyan: '\x1b[38;5;37m',
};
let _accent = 'blue';
try {
  const sp = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  const sj = JSON.parse(fs.readFileSync(sp, 'utf8'));
  if (sj.statusline?.accent && accentMap[sj.statusline.accent]) _accent = sj.statusline.accent;
} catch {}
C.accent = accentMap[_accent] || C.gray;
const SEP = `${C.gray} | ${C.reset}`;

// ─── Effort levels ────────────────────────────────────────
// Single source of truth for effort rendering. Add new CC efforts here.
const EFFORT_CONFIG = {
  auto:   { label: 'auto', color: 'soft',   bold: false },
  low:    { label: 'lo',   color: 'soft',   bold: false },
  medium: { label: 'mid',  color: 'gray',   bold: false },
  high:   { label: 'hi',   color: 'accent', bold: false },
  xhigh:  { label: 'xh',   color: 'accent', bold: true  },
  max:    { label: 'MAX',  color: 'accent', bold: true  },
  // CC 2.1.x: "xhigh effort plus standing dynamic-workflow orchestration".
  ultracode: { label: 'ULTRA', color: 'orange', bold: true },
};

// ─── Error tracking (opt-in via DEBUG_STATUSLINE=1) ───────
const DEBUG = process.env.DEBUG_STATUSLINE === '1';
const _errors = [];
const _errorCounts = new Map();

function logError(ctx, err) {
  const n = (_errorCounts.get(ctx) || 0) + 1;
  _errorCounts.set(ctx, n);
  if (n === 1) _errors.push(ctx);
  if (!DEBUG) return;
  if (n > 5) return;
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const logPath = path.join(dir, 'cache', 'statusline-errors.log');
    try {
      const st = fs.statSync(logPath);
      if (st.size > 1024 * 1024) {
        const tail = fs.readFileSync(logPath, 'utf8').slice(-512 * 1024);
        fs.writeFileSync(logPath, tail);
      }
    } catch {}
    fs.appendFileSync(logPath, `${new Date().toISOString()} [${ctx}] ${err?.message || err}\n`);
  } catch {}
}

function getErrors() { return _errors; }

// ─── Atomic write (prevents concurrent corruption) ────────
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // mode 0600: caches hold cost / rate-limit / account-adjacent data — keep them
    // owner-only on shared *nix hosts. renameSync preserves the tmp file's perms.
    // No-op on Windows (POSIX mode bits ignored), harmless.
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ─── Secret redaction ─────────────────────────────────────
function redact(text) {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, 'sk-ant-[REDACTED]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-[REDACTED]')
    .replace(/sk_live_[A-Za-z0-9]{20,}/g, 'sk_live_[REDACTED]')
    .replace(/rk_live_[A-Za-z0-9]{20,}/g, 'rk_live_[REDACTED]')
    .replace(/ghp_[A-Za-z0-9]{30,}/g, 'ghp_[REDACTED]')
    .replace(/gho_[A-Za-z0-9]{30,}/g, 'gho_[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{22,}/g, 'github_pat_[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA[REDACTED]')
    .replace(/AIza[A-Za-z0-9_-]{35}/g, 'AIza[REDACTED]')
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'xox[REDACTED]')
    .replace(/SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}/g, 'SG.[REDACTED]')
    .replace(/dapi[a-f0-9]{32}/gi, 'dapi[REDACTED]')
    .replace(/postgres(?:ql)?:\/\/[^:]+:[^@\s]+@[^\s]+/gi, 'postgres://[REDACTED]')
    .replace(/mysql:\/\/[^:]+:[^@\s]+@[^\s]+/gi, 'mysql://[REDACTED]')
    .replace(/mongodb(?:\+srv)?:\/\/[^:]+:[^@\s]+@[^\s]+/gi, 'mongodb://[REDACTED]')
    .replace(/(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'",}]{6,}/gi, 'password=[REDACTED]')
    .replace(/x-api-key\s*[:=]\s*['"]?[A-Za-z0-9_-]{10,}/gi, 'x-api-key=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[JWT-REDACTED]');
}

// ─── Formatting helpers ───────────────────────────────────
function formatDuration(seconds) {
  if (seconds < 0) seconds = 0;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function safeSlice(s, n) {
  if (!s) return '';
  const arr = Array.from(s);
  return arr.length <= n ? s : arr.slice(0, n).join('');
}

function colorByThreshold(value, bounds, palette) {
  const [low, mid] = bounds;
  const p = palette || [C.green, C.warn, C.danger];
  return value < low ? p[0] : value < mid ? p[1] : p[2];
}

// ─── Orphan sweep (~1% of ticks) ─────────────────────────
// aggWindowDays controls retention for per-session statusline caches
// (state, active-time, compact). 0 = never sweep. Defaults to 30 to match
// the cost rolling window. Tmp bridge files always sweep at 7d (short-lived).
function sweepOrphans(claudeDir, aggWindowDays = 30) {
  if (Math.random() >= 0.01) return;
  try {
    if (aggWindowDays > 0) {
      const cacheDir = path.join(claudeDir, 'cache');
      const cutoff = Date.now() - aggWindowDays * 86400000;
      const prefixes = ['statusline-state-', 'statusline-pid-', 'active-time-', 'compact-'];
      for (const f of fs.readdirSync(cacheDir)) {
        if (!f.endsWith('.json')) continue;
        if (!prefixes.some(p => f.startsWith(p))) continue;
        try {
          const fp = path.join(cacheDir, f);
          if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
        } catch {}
      }
    }
  } catch {}
  try {
    const tmp = os.tmpdir();
    const cutoff = Date.now() - 7 * 86400000;
    for (const f of fs.readdirSync(tmp)) {
      if (!f.startsWith('claude-ctx-') || !f.endsWith('.json')) continue;
      try {
        const fp = path.join(tmp, f);
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}

module.exports = {
  C, SEP, EFFORT_CONFIG,
  AGENT_WARN_SECS, AGENT_CRIT_SECS, AGENT_ZOMBIE_SECS,
  ESTIMATED_STARTING_TOKENS, MAX_RL_RESET_MINUTES, FIVE_HOURS_MS,
  atomicWrite, logError, getErrors, redact,
  formatDuration, safeSlice, colorByThreshold, sweepOrphans,
};
