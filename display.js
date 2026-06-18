'use strict';
const fs = require('fs');
const {
  C, SEP, EFFORT_CONFIG, colorByThreshold, formatDuration, logError, safeSlice,
  ESTIMATED_STARTING_TOKENS, AGENT_WARN_SECS, AGENT_CRIT_SECS,
  MAX_RL_RESET_MINUTES, FIVE_HOURS_MS,
} = require('./utils');

// Prompt cache TTL: 5min since last API response.
const CACHE_TTL_MS = 5 * 60 * 1000;
const { detectContextSize, formatContextLabel } = require('./models');
const { VERSION } = require('./version');

const path = require('path');
const { pathToFileURL } = require('url');

// Absolute filesystem path -> file:// URL. pathToFileURL handles Windows drive
// letters (C:\ -> file:///C:/), backslashes, and percent-encoding cross-platform.
// We render this URL as PLAIN TEXT (no OSC 8): Claude Code strips OSC 8 escapes
// from the statusline, but auto-detecting terminals (Windows Terminal, iTerm2)
// linkify plain URLs and open the folder on Ctrl/Cmd+click.
function _fileUrl(absPath) {
  try { return pathToFileURL(absPath).href; } catch { return null; }
}

// Local config — `minPad` (spaces before the version chip) and `clickablePath`
// (wrap the cwd in an OSC 8 hyperlink so terminals that support it open the
// folder on Ctrl/Cmd+click). Defaults match prior behavior plus clickable on.
const _CONFIG_PATH = path.join(__dirname, 'config.json');
const _CONFIG_DEFAULTS = { minPad: 6, clickablePath: true };
let _configCache = null;
let _configMtime = 0;
function _readConfig() {
  try {
    const st = fs.statSync(_CONFIG_PATH);
    if (_configCache && st.mtimeMs === _configMtime) return _configCache;
    const raw = JSON.parse(fs.readFileSync(_CONFIG_PATH, 'utf8'));
    const out = { ..._CONFIG_DEFAULTS };
    if (Number.isFinite(raw.minPad) && raw.minPad >= 0) out.minPad = raw.minPad;
    if (typeof raw.clickablePath === 'boolean') out.clickablePath = raw.clickablePath;
    _configCache = out;
    _configMtime = st.mtimeMs;
    return out;
  } catch (e) {
    if (e.code !== 'ENOENT') logError('config', e);
    return _configCache || { ..._CONFIG_DEFAULTS };
  }
}

function buildContextBar(data, lastUsage, compactState) {
  const maxContext = detectContextSize(data.model?.id, data.context_window?.context_window_size);
  const maxDisplay = formatContextLabel(maxContext);
  let pct = 0, pctPrefix = '', pctEstimated = false;
  const remainingPct = data.context_window?.remaining_percentage;

  // Post-compact transient: CC stdin briefly reports near-fresh remaining_percentage
  // (~100) until the next API turn lands, which would flash 0%. If a compact_boundary
  // exists with no API turn after it, estimate pct from the compact summary size +
  // a small system-prompt allowance so the bar reflects reality.
  const postCompact = compactState
    && compactState.lastCompactBoundaryTs
    && compactState.compactSummaryTokens > 0
    && (!compactState.lastApiTimestamp
      || new Date(compactState.lastCompactBoundaryTs).getTime()
         > new Date(compactState.lastApiTimestamp).getTime());

  // Real token occupancy of the live context window — the exact figure /context
  // reports. CC ships context_window.current_usage (cache_read + cache_creation +
  // input of the last API turn); between turns it briefly zeroes context_window,
  // so fall back to the transcript's last observed usage (also real) before any
  // estimate. No source available only on a genuine cold start (no API turn yet).
  const cu = data.context_window?.current_usage;
  const cuTotal = cu ? (cu.input_tokens || 0) + (cu.cache_read_input_tokens || 0)
    + (cu.cache_creation_input_tokens || 0) : 0;
  const luTotal = lastUsage ? (lastUsage.input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0)
    + (lastUsage.cache_creation_input_tokens || 0) : 0;
  const realTokens = cuTotal > 0 ? cuTotal : luTotal;

  if (postCompact) {
    // Narrow window right after /compact, before the next API turn lands: no source
    // is trustworthy (transcript still holds the pre-compact size, CC's current_usage
    // is still the pre-compact turn). Estimate from session baseline + compact
    // summary. Only `~` left — takes priority since realTokens would be stale here.
    const base = compactState.sessionBaselineTokens > 0
      ? compactState.sessionBaselineTokens
      : ESTIMATED_STARTING_TOKENS;
    const estTokens = base + compactState.compactSummaryTokens;
    pct = estTokens * 100 / maxContext;
    pctPrefix = '~'; pctEstimated = true;
  } else if (realTokens > 0) {
    pct = realTokens * 100 / maxContext;
  } else {
    // Genuine cold start: no measurement exists anywhere yet (CC hasn't built the
    // prompt). Show the calibrated baseline estimate (~3.5% on 1M) until the first
    // turn lands and current_usage fills in the real number.
    pct = ESTIMATED_STARTING_TOKENS * 100 / maxContext;
    pctPrefix = '~'; pctEstimated = true;
  }
  if (pct > 100) pct = 100;
  pct = Math.round(pct * 10) / 10; // 1-decimal precision for display + bridge
  const pctStr = pct.toFixed(1);
  let bar = '';
  for (let i = 0; i < 10; i++) {
    const progress = pct - (i * 10);
    if (progress >= 8) bar += `${C.accent}\u2588${C.reset}`;
    else if (progress >= 3) bar += `${C.accent}\u2584${C.reset}`;
    else bar += `${C.barEmpty}\u2591${C.reset}`;
  }
  return { ctx: `${bar} ${C.gray}${pctPrefix}${pctStr}% of ${maxDisplay} tokens`, pct, pctEstimated, remainingPct };
}

function buildCostStr(cost, cost30d, thresholds) {
  if (cost == null) return '';
  const cc = colorByThreshold(cost, thresholds.costSession);
  const mc = colorByThreshold(cost30d, thresholds.costMonthly, [C.gray, C.warn, C.danger]);
  // ~ marca custo nocional em AMBOS: sessão e 30d vêm do mesmo total_cost_usd
  // (equivalente-API estimado pelo CC, não a fatura da assinatura).
  const m = cost30d > 0 ? `${mc}/~$${cost30d.toFixed(2)}${C.reset}` : '';
  return ` ${C.gray}| ${cc}~$${cost.toFixed(2)}${m}${C.reset}`;
}

function _renderRl(rl, label, windowMs, apiAge, now, thresholds, agg) {
  // Cross-session aggregate (from rate-limit-snapshots.json) wins when present —
  // it reflects MAX(used_percentage) across all live sessions sharing the quota.
  let used = rl?.used_percentage;
  let resets = rl?.resets_at;
  if (agg && agg.used_percentage != null && agg.resets_at) {
    used = agg.used_percentage;
    resets = agg.resets_at;
  }
  if (used == null) return '';
  const stale = (resets && resets * 1000 < now) ||
    (!resets && apiAge != null && apiAge > windowMs);
  if (stale) return ` ${C.gray}| ${C.soft}${label}:?${C.reset}`;
  const p = Math.round(used);
  // C.danger is a softer salmon red than C.red (ANSI 31), easier to read when the digits flash hot.
  const c = colorByThreshold(p, thresholds.rateLimit, [C.green, C.yellow, C.danger]);
  let s = ` ${C.gray}| ${c}${label}:${p}%${p >= 100 ? ' \u{1F4B8}' : ''}${C.reset}`;
  if (resets) {
    const resetMs = resets * 1000 - now;
    const mins = Math.max(0, Math.round(resetMs / 60000));
    // Burn rate delta: tokens%_used - time%_elapsed. >0 = ahead of pace (burning fast).
    const elapsedPct = Math.max(0, Math.min(100, (1 - resetMs / windowMs) * 100));
    const delta = Math.round(p - elapsedPct);
    const dColor = delta >= 10 ? C.danger : delta <= -10 ? C.green : C.gray;
    const sign = delta > 0 ? '+' : '';
    s += `${dColor}(${sign}${delta}%)${C.reset}`;
    if (mins > 0 && mins <= MAX_RL_RESET_MINUTES) {
      const t = mins < 60 ? `${mins}m` : mins < 1440
        ? `${Math.floor(mins / 60)}h${mins % 60}m`
        : `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h`;
      s += `${C.soft}(${t})${C.reset}`;
    }
  }
  return s;
}

function buildRateLimitsStr(rateLimits, thresholds, lastApiTimestamp, aggregated) {
  const now = Date.now();
  const apiAge = lastApiTimestamp ? now - new Date(lastApiTimestamp).getTime() : null;
  return _renderRl(rateLimits?.five_hour, '5h', FIVE_HOURS_MS, apiAge, now, thresholds, aggregated?.five_hour)
    + _renderRl(rateLimits?.seven_day, '7d', 7 * 86400000, apiAge, now, thresholds, aggregated?.seven_day);
}

function buildSubagentCtxBar(usage, modelId) {
  // Soft-gray placeholder when we have an agent but no usage data yet \u2014 makes
  // the slot visible so users notice when enrichSubagents fails to find the
  // subagent transcript (instead of the column silently being empty).
  if (!usage) return ` ${C.soft}ctx:?${C.reset}`;
  const max = detectContextSize(modelId);
  const total = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
  if (total <= 0) return ` ${C.soft}ctx:?${C.reset}`;
  let pct = Math.round(total * 100 / max);
  if (pct > 100) pct = 100;
  let bar = '';
  for (let i = 0; i < 5; i++) {
    const progress = pct - (i * 20);
    if (progress >= 16) bar += `${C.accent}\u2588${C.reset}`;
    else if (progress >= 6) bar += `${C.accent}\u2584${C.reset}`;
    else bar += `${C.barEmpty}\u2591${C.reset}`;
  }
  // Color the % by usage so high-context agents pop visually (mirrors main ctx bar).
  const pctColor = pct >= 80 ? C.danger : pct >= 50 ? C.warn : C.gray;
  return ` ${bar} ${pctColor}ctx:${pct}%${C.reset}`;
}

function buildAgentLines(agentMap, parentEffort, parentModel) {
  if (!agentMap || agentMap.size === 0) return '';
  const spin = ['\u280b','\u2819','\u2839','\u2838','\u283c','\u2834','\u2826','\u2827','\u2807','\u280f'];
  const out = [];
  for (const [, a] of agentMap) {
    const si = Math.floor(Date.now() / 200) % spin.length;
    const elapsed = a.startTime ? Math.floor((Date.now() - new Date(a.startTime).getTime()) / 1000) : 0;
    const label = a.name || a.desc;
    const typeStr = a.type ? ` ${C.gray}(${a.type})${C.reset}` : '';
    // Subagents inherit parent effort/model by default; explicit a.effort / a.model wins (future-proof).
    const effortKey = String(a.effort || parentEffort || '').toLowerCase();
    const effortLabel = EFFORT_CONFIG[effortKey]?.label || '';
    const modelLabel = a.model || parentModel || '';
    let badge = '';
    if (modelLabel && effortLabel) badge = ` ${C.accent}[${modelLabel} \u00b7 ${effortLabel}]${C.reset}`;
    else if (modelLabel) badge = ` ${C.accent}[${modelLabel}]${C.reset}`;
    else if (effortLabel) badge = ` ${C.accent}[${effortLabel}]${C.reset}`;
    const tc = elapsed >= AGENT_CRIT_SECS ? C.red : elapsed >= AGENT_WARN_SECS ? C.yellow : C.gray;
    const timeStr = a.startTime ? ` ${tc}${formatDuration(elapsed)}${C.reset}` : '';
    const stuck = elapsed >= AGENT_CRIT_SECS ? ` ${C.red}\u26a0 stuck?${C.reset}`
      : elapsed >= AGENT_WARN_SECS ? ` ${C.yellow}\u26a0 slow${C.reset}` : '';
    const wt = a.isolation ? ` ${C.yellow}\u2442worktree${C.reset}` : '';
    const sc = elapsed >= AGENT_CRIT_SECS ? C.red : elapsed >= AGENT_WARN_SECS ? C.yellow : C.cyan;
    const icon = a.bg ? `${C.soft}\u23f3${C.reset}` : `${sc}${spin[si]}${C.reset}`;
    const ctxStr = buildSubagentCtxBar(a.lastUsage, a.runtimeModel || a.model || parentModel);
    out.push(`  ${icon} ${C.cyan}${label}${C.reset}${typeStr}${badge}${timeStr}${ctxStr}${wt}${stuck}`);
  }
  return out.join('\n');
}

function buildEffortStr(effort) {
  if (!effort) return '';
  const key = String(effort).toLowerCase();
  const cfg = EFFORT_CONFIG[key];
  if (!cfg) return ` ${C.gray}[${key.slice(0, 4)}]${C.reset}`;
  const bold = cfg.bold ? C.bold : '';
  const color = C[cfg.color] || C.gray;
  return ` ${color}${bold}[${cfg.label}]${C.reset}`;
}

// Version chip rendered a fixed `minPad` spaces after the content — no terminal
// width detection (CC spawns the statusline without a real console, so detection
// was unreliable and required per-host config + a refresh hook; dropped).
function _appendVersion(text, vText) {
  return text + ' '.repeat(_readConfig().minPad) + `${C.gray}${vText}${C.reset}`;
}

function buildLine1(p) {
  let s = `${p.updateStr}${p.errStr}${C.accent}${p.model}${C.reset}${p.effortStr}${p.fastStr}${p.ccVerStr || ''}${p.accountStr || ''}`;
  s += p.costStr;
  if (p.sessionDur) s += ` ${C.gray}| ${p.sessionDur}${C.reset}`;
  // Directory chip. When clickablePath is on, render the cwd as a plain file://
  // URL so auto-detecting terminals (Windows Terminal, iTerm2) make it
  // Ctrl/Cmd+clickable and open the folder. Falls back to the friendly path
  // (worktree name when present) when disabled or cwd is unavailable.
  const dirUrl = _readConfig().clickablePath && p.cwd ? _fileUrl(p.cwd) : null;
  s += dirUrl
    ? `${SEP}\ud83d\udcc1 ${C.soft}${dirUrl}${C.reset}`
    : `${SEP}\ud83d\udcc1 ${p.dir}`;
  if (p.branch) s += `${SEP}\ud83d\udd00${p.branch} ${p.gitStatus}`;
  s += p.taskStr;
  return _appendVersion(s, `v${VERSION}`);
}

function buildCacheStr(lastUsage, lastApiTimestamp) {
  if (!lastUsage) return '';
  const read = lastUsage.cache_read_input_tokens || 0;
  const create = lastUsage.cache_creation_input_tokens || 0;
  const fresh = lastUsage.input_tokens || 0;
  const total = read + create + fresh;
  if (total <= 0) return '';
  const hitPct = Math.floor(read * 100 / total);
  let ttlStr = '';
  // Absolute expiry timestamp instead of countdown — CC re-renders the statusline only
  // on events, so a relative countdown freezes between renders. An absolute time stays correct.
  if (lastApiTimestamp) {
    const remaining = CACHE_TTL_MS - (Date.now() - new Date(lastApiTimestamp).getTime());
    if (remaining > 0) {
      const exp = new Date(new Date(lastApiTimestamp).getTime() + CACHE_TTL_MS);
      const hh = String(exp.getHours()).padStart(2, '0');
      const mm = String(exp.getMinutes()).padStart(2, '0');
      const ss = String(exp.getSeconds()).padStart(2, '0');
      const tc = remaining < 30_000 ? C.danger : remaining < 120_000 ? C.warn : C.soft;
      ttlStr = ` ${tc}(exp ${hh}:${mm}:${ss})${C.reset}`;
    }
  }
  return ` ${C.gray}| cache:${hitPct}%${C.reset}${ttlStr}`;
}

function buildTodoStr(lastTodos) {
  if (!Array.isArray(lastTodos) || lastTodos.length === 0) return '';
  const total = lastTodos.length;
  const done = lastTodos.filter(t => t?.status === 'completed').length;
  if (done === total) return ` ${C.gray}| ${C.green}▸ all done (${total}/${total})${C.reset}`;
  const active = lastTodos.find(t => t?.status === 'in_progress')
    || lastTodos.find(t => t?.status === 'pending');
  if (!active) return '';
  const label = active.activeForm || active.content || '?';
  const trimmed = safeSlice(label, 30) + (label.length > 30 ? '…' : '');
  return ` ${C.gray}| ${C.cyan}▸ ${trimmed} (${done}/${total})${C.reset}`;
}

function buildLine2(p) {
  return `${p.ctx}${p.rlStr}${p.cacheStr}${p.compactStr}${p.toolStr}${p.turnStr}${p.toolUsedStr}${p.todoStr || ''}`;
}

function computeSessionDur(firstTimestamp, transcriptPath, activeMs) {
  // Active time (sum of UserPromptSubmit→Stop deltas, hook-driven) is the
  // honest "how long was the agent actually working" number — wins when
  // present. Fallbacks below give wall-clock duration which inflates with idle.
  if (Number.isFinite(activeMs) && activeMs > 0) {
    return `${C.green}${formatDuration(Math.floor(activeMs / 1000))}${C.reset}`;
  }
  if (firstTimestamp) {
    try {
      return formatDuration(Math.floor((Date.now() - new Date(firstTimestamp).getTime()) / 1000));
    } catch {}
  } else if (transcriptPath) {
    try {
      const stat = fs.statSync(transcriptPath);
      return formatDuration(Math.floor((Date.now() - (stat.birthtimeMs || stat.ctimeMs)) / 1000));
    } catch {}
  }
  return '';
}

module.exports = {
  buildContextBar, buildCostStr, buildRateLimitsStr,
  buildAgentLines, buildEffortStr, buildLine1, buildLine2, computeSessionDur,
  buildCacheStr, buildTodoStr,
};
