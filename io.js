'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite, logError, C, safeSlice, redact, CACHE_TTL_MS } = require('./utils');

// ─── Settings (mtime-cached) ──────────────────────────────
const _settingsPath = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json',
);
let _settingsCache = null;
let _settingsMtime = 0;

// statusline-local config (sibling to this file) — kept separate from CC settings.json
// because CC's schema rejects unknown top-level keys. aggWindowDays lives here.
const _localCfgPath = path.join(__dirname, 'config.json');
let _localCfgCache = null;
let _localCfgMtime = 0;
function _readLocalCfg() {
  try {
    const st = fs.statSync(_localCfgPath);
    if (_localCfgCache && st.mtimeMs === _localCfgMtime) return _localCfgCache;
    const raw = JSON.parse(fs.readFileSync(_localCfgPath, 'utf8'));
    _localCfgCache = raw && typeof raw === 'object' ? raw : {};
    _localCfgMtime = st.mtimeMs;
    return _localCfgCache;
  } catch { return _localCfgCache || {}; }
}

// aggWindowDays: integer days of per-session cache retention. 0 = all-time, no filter.
// Read from statusline-local config.json so it lives next to the code that uses it
// (CC's settings.json schema rejects unknown top-level keys, so we can't put it there).
// Overlaid on every readSettings() call — has its own mtime cache, so it's cheap.
function _aggWindowDaysFromCfg() {
  const aw = _readLocalCfg().aggWindowDays;
  return Number.isFinite(aw) && aw >= 0 ? Math.floor(aw) : 30;
}

function readSettings() {
  const defaults = {
    effort: '', modelEfforts: {}, fastMode: false, aggWindowDays: 30,
    thresholds: { rateLimit: [10, 20], push: [3, 10] },
  };
  try {
    const st = fs.statSync(_settingsPath);
    if (_settingsCache && st.mtimeMs === _settingsMtime) {
      return { ..._settingsCache, aggWindowDays: _aggWindowDaysFromCfg() };
    }
    const s = JSON.parse(fs.readFileSync(_settingsPath, 'utf8'));
    const out = { ...defaults };
    out.effort = s.effortLevel || '';
    // CC 2.1.251+: /effort persists per model under modelSettings[<canonical name>].effortLevel,
    // which outranks the top-level effortLevel for that model. Kept as a flat name→level map.
    const ms = s.modelSettings;
    out.modelEfforts = {};
    if (ms && typeof ms === 'object' && !Array.isArray(ms)) {
      for (const [name, v] of Object.entries(ms)) {
        if (typeof v?.effortLevel === 'string') out.modelEfforts[name] = v.effortLevel;
      }
    }
    out.fastMode = s.fastMode === true;
    const th = s.statusline?.thresholds;
    if (th && typeof th === 'object') {
      for (const k of ['rateLimit', 'push']) {
        const v = th[k];
        if (Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && v[0] <= v[1]) {
          out.thresholds[k] = v;
        } else if (v !== undefined) {
          logError('settings-threshold', new Error(`invalid ${k}`));
        }
      }
    }
    _settingsCache = out;
    _settingsMtime = st.mtimeMs;
    return { ...out, aggWindowDays: _aggWindowDaysFromCfg() };
  } catch (e) {
    if (e.code !== 'ENOENT') logError('settings', e);
    const base = _settingsCache || defaults;
    return { ...base, aggWindowDays: _aggWindowDaysFromCfg() };
  }
}

// Persisted default effort for the model on stdin. CC keys modelSettings by the
// canonical name (claude-fable-5-1) and matches its [1m] and date-suffixed forms
// to that entry — mirror that exactly (claude-opus-5-20260101[1m] → claude-opus-5);
// a looser prefix match would let claude-fable-5 claim claude-fable-5-1.
// No match → effortLevel.
function resolveDefaultEffort(settings, modelId) {
  const id = String(modelId || '').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  const map = settings.modelEfforts || {};
  return (id && map[id]) || settings.effort;
}

// ─── Cross-session rate-limit aggregation ─────────────────
// CC payload reflects only this session's last API observation. With multiple
// parallel sessions, each terminal sees its own % and they diverge. We snapshot
// every session's reading and aggregate MAX(used_percentage) across the snapshots
// whose resets_at matches the most-recent observation — converging all terminals
// onto the same number that actually matches the account-wide quota.
function trackRateLimitSnapshot(rateLimits, sessionId, quotaKey, claudeDir) {
  if (!rateLimits || !sessionId) return null;
  const file = path.join(claudeDir, 'cache', 'rate-limit-snapshots.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  try {
    let cache = read();
    if (!cache.sessions) cache.sessions = {};
    const now = Date.now();
    const ttl = 24 * 3600000; // drop snapshots older than 24h
    const mine = {
      observed_at: now,
      account: quotaKey,
      five_hour: rateLimits.five_hour
        ? { used_percentage: rateLimits.five_hour.used_percentage, resets_at: rateLimits.five_hour.resets_at }
        : null,
      seven_day: rateLimits.seven_day
        ? { used_percentage: rateLimits.seven_day.used_percentage, resets_at: rateLimits.seven_day.resets_at }
        : null,
    };
    const prev = cache.sessions[sessionId];
    const same = prev && JSON.stringify({ ...prev, observed_at: 0 }) === JSON.stringify({ ...mine, observed_at: 0 });
    if (!same) {
      cache = read(); // re-read antes do write; janela TOCTOU residual auto-corrige (cada sessão regrava)
      if (!cache.sessions) cache.sessions = {};
      cache.sessions[sessionId] = mine;
      for (const [id, s] of Object.entries(cache.sessions)) {
        if (!s.observed_at || now - s.observed_at > ttl) delete cache.sessions[id];
      }
      atomicWrite(file, JSON.stringify(cache));
    }
    // Aggregate: pick the live window (max future resets_at — isolates week-turnover,
    // old-window snapshots carry a different resets_at and never leak in), then take
    // MAX used_percentage among snapshots observed in the last 2h. The 2h window drops
    // pre-reset peaks after an admin balance reset (pct drops, resets_at stays) so they
    // stop poisoning the number via MAX. When nothing is recent, fall back to the freshest
    // snapshot — avoids under-reporting from an idle session still carrying a stale-low pct.
    const RECENT_MS = 2 * 3600000; // ponytail: convergence window; admin reset auto-corrects in <=2h instead of the 24h TTL
    // Quota is per account+org: after a login switch the previous account's snapshots
    // (often a later resets_at and a higher pct) would otherwise win both picks below.
    // quotaKey alone can't tell CLAUDE_CODE_OAUTH_TOKEN sessions from /login ones (same
    // ~/.claude.json, different quota), so a live 7d resets_at fingerprints the actual quota.
    // ponytail: two accounts sharing a 7d reset (600s granularity) still merge; upgrade = token hash from CC.
    const nowSec = Math.floor(now / 1000);
    const myWeek = mine.seven_day?.resets_at;
    const fingerprint = myWeek && myWeek >= nowSec ? myWeek : null;
    const peers = Object.values(cache.sessions).filter(s => (s.account ?? null) === (quotaKey ?? null)
      && (fingerprint == null || s.seven_day?.resets_at === fingerprint));
    const agg = (window) => {
      let bestReset = 0;
      for (const s of peers) {
        const w = s[window];
        if (!w || w.used_percentage == null || !w.resets_at) continue;
        if (w.resets_at >= nowSec && w.resets_at > bestReset) bestReset = w.resets_at;
      }
      if (!bestReset) return null;
      let recentPct = null, freshPct = null, freshAt = 0;
      for (const s of peers) {
        const w = s[window];
        if (!w || w.used_percentage == null || w.resets_at !== bestReset) continue;
        const obs = s.observed_at || 0;
        if (now - obs <= RECENT_MS && (recentPct == null || w.used_percentage > recentPct)) recentPct = w.used_percentage;
        if (obs > freshAt) { freshAt = obs; freshPct = w.used_percentage; }
      }
      const pct = recentPct != null ? recentPct : freshPct;
      return pct != null ? { used_percentage: pct, resets_at: bestReset } : null;
    };
    return { five_hour: agg('five_hour'), seven_day: agg('seven_day') };
  } catch (e) { logError('rl-snapshot', e); return null; }
}

// ─── Active session time (hook-driven) ────────────────────
// Reads the file maintained by hooks/active-time-tracker.js. Returns ms or null.
function readActiveTime(transcriptPath, sessionId, claudeDir) {
  const key = transcriptPath ? path.basename(transcriptPath, '.jsonl') : sessionId;
  if (!key) return null;
  const file = path.join(claudeDir, 'cache', `active-time-${key}.json`);
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    let total = s.totalMs || 0;
    if (s.turnStart && Date.now() > s.turnStart) {
      // Mesmo cap anti-crash do hook (active-time-tracker.js): um turnStart órfão
      // (Stop perdido) não deve inflar o tempo ativo exibido sem limite.
      const delta = Date.now() - s.turnStart;
      if (delta <= 6 * 3600000) total += delta;
    }
    return total;
  } catch { return null; }
}

// ─── Compact counter (hook-driven) ────────────────────────
// Reads the file maintained by hooks/compact-monitor.js (PreCompact event).
// Caller MAXes this with the JSONL-derived counter so a schema drift on either
// side never silently zeros the number.
function readCompactCount(transcriptPath, sessionId, claudeDir) {
  const key = transcriptPath ? path.basename(transcriptPath, '.jsonl') : sessionId;
  if (!key) return 0;
  const file = path.join(claudeDir, 'cache', `compact-${key}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).count || 0; } catch { return 0; }
}

function writeBridgeFile(sessionId, pct, pctEstimated, remainingPct) {
  if (!sessionId) return;
  const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
  try {
    try {
      const prev = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
      if (prev.used_pct === pct && prev.remaining_percentage === (remainingPct ?? null) && prev.estimated === pctEstimated) return;
    } catch {}
    atomicWrite(bridgePath, JSON.stringify({
      session_id: sessionId, remaining_percentage: remainingPct ?? null,
      used_pct: pct, estimated: pctEstimated, timestamp: Math.floor(Date.now() / 1000),
    }));
  } catch (e) { logError('bridge-write', e); }
}

function lookupTask(sessionId, claudeDir) {
  const todosDir = path.join(claudeDir, 'todos');
  if (!sessionId || !fs.existsSync(todosDir)) return '';
  try {
    const all = fs.readdirSync(todosDir)
      .filter(f => f.startsWith(sessionId) && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime, agent: f.includes('-agent-') }))
      .sort((a, b) => b.mtime - a.mtime);
    // Prefer root task (no -agent- in filename). Subagent todos are fallback only.
    const ordered = [...all.filter(f => !f.agent), ...all.filter(f => f.agent)];
    for (const file of ordered) {
      try {
        const todos = JSON.parse(fs.readFileSync(path.join(todosDir, file.name), 'utf8'));
        const ip = todos.find(t => t.status === 'in_progress');
        if (ip?.activeForm) return ` ${C.gray}| ${C.bold}${safeSlice(redact(ip.activeForm), 40)}${C.reset}`;
      } catch {}
    }
  } catch (e) { logError('todos', e); }
  return '';
}

// ─── Prompt-cache expiry alarm ────────────────────────────
// Opt-in via config.json `cacheAlarm: { leadMinutes, sound }`. Fires once per cache
// window, `leadMinutes` before CC's prompt_cache.expires_at. Needs statusLine
// `refreshInterval` in settings.json: without it an idle session never re-renders.
const SESSION_ID_RE = /^[A-Za-z0-9-]+$/;

function readCacheAlarmConfig() {
  return _readLocalCfg().cacheAlarm;
}

function isCacheAlarmDue(promptCache, cacheAlarm, nowMs) {
  if (!promptCache || promptCache.warm !== true) return false;
  if (!Number.isFinite(promptCache.expires_at)) return false;
  const ttlMs = CACHE_TTL_MS[promptCache.ttl];
  if (!ttlMs) return false;
  if (!cacheAlarm || typeof cacheAlarm.sound !== 'string') return false;
  const lead = cacheAlarm.leadMinutes;
  if (!Number.isFinite(lead) || lead <= 0) return false;
  const leadMs = lead * 60000;
  // A lead longer than the TTL window would fire right after every request.
  if (leadMs >= ttlMs) return false;
  const expMs = promptCache.expires_at * 1000;
  return nowMs >= expMs - leadMs && nowMs < expMs;
}

// Session's alarm locks as { file, expiresAt } (expiresAt parsed from the name).
function _cacheAlarmLocks(cacheDir, prefix) {
  if (!fs.existsSync(cacheDir)) return [];
  return fs.readdirSync(cacheDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => ({ file: f, expiresAt: Number(f.slice(prefix.length, -'.json'.length)) }));
}

// Exclusive create ('wx') is the cross-process lock: concurrent renders of one
// session (refresh tick + event) race on the same file and only one wins. A render
// holding an older expires_at than an existing lock is stale and must not fire, and
// cleanup removes only older windows so a stale render can't free a newer lock.
function claimCacheAlarm(sessionId, expiresAt, claudeDir) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false;
  const cacheDir = path.join(claudeDir, 'cache');
  const prefix = `cache-alarm-${sessionId}-`;
  const file = `${prefix}${expiresAt}.json`;
  try {
    if (_cacheAlarmLocks(cacheDir, prefix).some(l => l.expiresAt > expiresAt)) return false;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.closeSync(fs.openSync(path.join(cacheDir, file), 'wx'));
  } catch (e) {
    if (e.code !== 'EEXIST') logError('cache-alarm-claim', e);
    return false;
  }
  try {
    for (const l of _cacheAlarmLocks(cacheDir, prefix)) {
      if (l.expiresAt < expiresAt) fs.unlinkSync(path.join(cacheDir, l.file));
    }
  } catch (e) { logError('cache-alarm-cleanup', e); }
  return true;
}

// Synchronous on purpose: a detached player dies with the statusline process (measured:
// the child never ran its first statement once its node parent exited). The alarm fires
// on an idle session, so no event cancels this render while the clip plays; the cost is
// a statusline update held for the clip's length, once per cache window.
// Windows only: the statusline has no portable audio path, other platforms stay silent.
// The path travels in an env var, so no PowerShell quoting can break out of it.
function playSound(file) {
  if (process.platform !== 'win32') return false;
  if (!fs.existsSync(file)) {
    logError('cache-alarm-sound', new Error(`sound file not found: ${file}`));
    return false;
  }
  const r = require('child_process').spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(New-Object Media.SoundPlayer $env:CCVITALS_ALARM_SOUND).PlaySync()',
  ], {
    stdio: 'ignore', windowsHide: true, timeout: 15000,
    env: { ...process.env, CCVITALS_ALARM_SOUND: file },
  });
  if (r.error || r.status !== 0) {
    logError('cache-alarm-sound', r.error || new Error(`player exited ${r.status}`));
    return false;
  }
  return true;
}

module.exports = {
  readSettings, resolveDefaultEffort, trackRateLimitSnapshot,
  readActiveTime, readCompactCount,
  writeBridgeFile, lookupTask,
  readCacheAlarmConfig, isCacheAlarmDue, claimCacheAlarm, playSound,
};
