'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite, logError, C, safeSlice, redact } = require('./utils');

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

// aggWindowDays: integer days for cost / cache cleanup. 0 = all-time, no filter.
// Read from statusline-local config.json so it lives next to the code that uses it
// (CC's settings.json schema rejects unknown top-level keys, so we can't put it there).
// Overlaid on every readSettings() call — has its own mtime cache, so it's cheap.
function _aggWindowDaysFromCfg() {
  const aw = _readLocalCfg().aggWindowDays;
  return Number.isFinite(aw) && aw >= 0 ? Math.floor(aw) : 30;
}

function readSettings() {
  const defaults = {
    effort: '', fastMode: false, aggWindowDays: 30,
    thresholds: { costSession: [15, 30], costMonthly: [300, 800], rateLimit: [50, 80], push: [3, 10] },
  };
  try {
    const st = fs.statSync(_settingsPath);
    if (_settingsCache && st.mtimeMs === _settingsMtime) {
      return { ..._settingsCache, aggWindowDays: _aggWindowDaysFromCfg() };
    }
    const s = JSON.parse(fs.readFileSync(_settingsPath, 'utf8'));
    const out = { ...defaults };
    out.effort = s.effortLevel || '';
    out.fastMode = s.fastMode === true;
    const th = s.statusline?.thresholds;
    if (th && typeof th === 'object') {
      for (const k of ['costSession', 'costMonthly', 'rateLimit', 'push']) {
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

// ─── Rolling cost (configurable window, race-safe, delta-tracked) ─────
// Delta tracking: CC sometimes resets `cost.total_cost_usd` mid-session
// (compaction, auto-recovery). We split each session entry into
// { baseCost, currentCost } — when the payload value drops, we move the
// previous current into base. Total = baseCost + currentCost; never regresses.
// Legacy entries `{ cost }` are migrated transparently on first touch.
function _entryTotal(s) {
  if (!s) return 0;
  if (typeof s.cost === 'number') return s.cost; // legacy
  return (s.baseCost || 0) + (s.currentCost || 0);
}
function trackMonthlyCost(cost, sessionId, claudeDir, aggWindowDays = 30) {
  const costCachePath = path.join(claudeDir, 'cache', 'cost-monthly.json');
  const readCache = () => { try { return JSON.parse(fs.readFileSync(costCachePath, 'utf8')); } catch { return {}; } };
  try {
    let cache = readCache();
    if (!cache.sessions) cache.sessions = {};
    const cutoff = aggWindowDays > 0 ? Date.now() - aggWindowDays * 86400000 : 0;
    let needsWrite = false;
    if (sessionId && cost != null) {
      const prev = cache.sessions[sessionId];
      if (!prev) needsWrite = true;
      else if (typeof prev.cost === 'number') needsWrite = true; // legacy → migrate
      else if ((prev.currentCost || 0) !== cost) needsWrite = true;
    }
    if (cutoff > 0) {
      for (const s of Object.values(cache.sessions)) {
        if (s.date < cutoff) { needsWrite = true; break; }
      }
    }
    if (needsWrite) {
      // Re-read right before write to minimize races with concurrent sessions.
      // Residual TOCTOU remains: another process can write between this re-read
      // and atomicWrite, dropping that update. Tolerável — cada sessão regrava o
      // próprio valor na tick seguinte, então o cache é eventualmente consistente.
      cache = readCache();
      if (!cache.sessions) cache.sessions = {};
      if (sessionId && cost != null) {
        const prev = cache.sessions[sessionId];
        let baseCost = 0, currentCost = cost;
        if (prev && typeof prev.cost === 'number') {
          // Legacy migration: treat the old absolute value as currentCost only
          // if the new payload is >= old (no regression yet); otherwise promote
          // it to baseCost so we don't lose history when CC reset mid-session.
          if (cost >= prev.cost) { baseCost = 0; currentCost = cost; }
          else { baseCost = prev.cost; currentCost = cost; }
        } else if (prev) {
          baseCost = prev.baseCost || 0;
          const prevCur = prev.currentCost || 0;
          if (cost < prevCur) { baseCost += prevCur; currentCost = cost; }
          else { currentCost = cost; }
        }
        cache.sessions[sessionId] = { baseCost, currentCost, date: Date.now() };
      }
      if (cutoff > 0) {
        for (const [id, s] of Object.entries(cache.sessions)) {
          if (s.date < cutoff) delete cache.sessions[id];
        }
      }
      atomicWrite(costCachePath, JSON.stringify(cache));
    }
    // ponytail: dedup de custo herdado. Sessões resumidas/forkadas podem
    // reaparecer com o total_cost_usd de outra sessão (o CC expõe o custo do
    // "pai" antes da nova firmar o seu) → mesmo gasto contado 2x. Sinal: custo
    // float idêntico a 8 casas E escrito dentro de DEDUP_WINDOW_MS de uma
    // entrada já contada (o fork é observado quase junto com o pai). A janela
    // evita colapsar sessões triviais distintas que coincidam no custo mas
    // rodaram em horas diferentes.
    // Tetos conhecidos: (a) se o pai CONTINUA após o fork, o fantasma congela
    // num valor menor e diverge — vira entrada espúria não detectável aqui;
    // (b) duas sessões triviais idênticas dentro da janela colapsam. Upgrade:
    // lineage real se o CC expor parent session id no payload.
    const DEDUP_WINDOW_MS = 5 * 60 * 1000;
    let total = 0;
    const seenByCost = new Map(); // costKey -> [datas já contadas]
    for (const s of Object.values(cache.sessions)) {
      const v = _entryTotal(s);
      if (v === 0) continue;
      const k = v.toFixed(8);
      const when = s.date || 0;
      const dates = seenByCost.get(k);
      if (dates && dates.some(d => Math.abs(d - when) <= DEDUP_WINDOW_MS)) continue;
      total += v;
      if (dates) dates.push(when); else seenByCost.set(k, [when]);
    }
    return total;
  } catch (e) { logError('cost-cache', e); return 0; }
}

// ─── Cross-session rate-limit aggregation ─────────────────
// CC payload reflects only this session's last API observation. With multiple
// parallel sessions, each terminal sees its own % and they diverge. We snapshot
// every session's reading and aggregate MAX(used_percentage) across the snapshots
// whose resets_at matches the most-recent observation — converging all terminals
// onto the same number that actually matches the account-wide quota.
function trackRateLimitSnapshot(rateLimits, sessionId, claudeDir) {
  if (!rateLimits || !sessionId) return null;
  const file = path.join(claudeDir, 'cache', 'rate-limit-snapshots.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  try {
    let cache = read();
    if (!cache.sessions) cache.sessions = {};
    const now = Date.now();
    const ttl = 24 * 86400000; // drop snapshots older than 24h
    const mine = {
      observed_at: now,
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
    // Aggregate: pick snapshots whose resets_at == max(resets_at) per window,
    // then take MAX used_percentage. Snapshots with stale resets_at (already past)
    // are ignored — their data is no longer authoritative for the live window.
    const agg = (window) => {
      let bestReset = 0, bestPct = null;
      const nowSec = Math.floor(now / 1000);
      for (const s of Object.values(cache.sessions)) {
        const w = s[window];
        if (!w || w.used_percentage == null || !w.resets_at) continue;
        if (w.resets_at < nowSec) continue;
        if (w.resets_at > bestReset) { bestReset = w.resets_at; bestPct = w.used_percentage; }
        else if (w.resets_at === bestReset && w.used_percentage > bestPct) bestPct = w.used_percentage;
      }
      return bestReset ? { used_percentage: bestPct, resets_at: bestReset } : null;
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

module.exports = {
  readSettings, trackMonthlyCost, trackRateLimitSnapshot,
  readActiveTime, readCompactCount,
  writeBridgeFile, lookupTask,
};
