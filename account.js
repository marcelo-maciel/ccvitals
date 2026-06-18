'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { C, SEP, logError } = require('./utils');

const HOME = os.homedir();
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
// CC writes oauthAccount to $CLAUDE_CONFIG_DIR/.claude.json when CLAUDE_CONFIG_DIR is set
// (e.g., a second profile dir for a team account). Fall back to ~/.claude.json for legacy installs.
const CLAUDE_JSON_CANDIDATES = [
  path.join(CONFIG_DIR, '.claude.json'),
  path.join(HOME, '.claude.json'),
];
const CREDS_JSON = path.join(CONFIG_DIR, '.credentials.json');

let _cache = null;
let _cacheKey = '';

function _pickClaudeJson() {
  for (const p of CLAUDE_JSON_CANDIDATES) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.oauthAccount && (j.oauthAccount.displayName || j.oauthAccount.emailAddress)) {
        return { path: p, json: j };
      }
    } catch {}
  }
  // Nothing populated — return the first readable file (or null) so we still build a cache key.
  for (const p of CLAUDE_JSON_CANDIDATES) {
    try { return { path: p, json: JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch {}
  }
  return null;
}

function _mtimeKey(claudeJsonPath) {
  try {
    const a = claudeJsonPath ? fs.statSync(claudeJsonPath).mtimeMs : 0;
    const b = fs.statSync(CREDS_JSON).mtimeMs;
    return `${claudeJsonPath || ''}|${a}|${b}`;
  } catch { return ''; }
}

function readAccount() {
  const picked = _pickClaudeJson();
  const key = _mtimeKey(picked?.path);
  if (key && key === _cacheKey) return _cache;
  try {
    if (!picked) throw new Error('no .claude.json');
    const cj = picked.json;
    const oa = cj.oauthAccount || {};
    let subscriptionType = null;
    try {
      const creds = JSON.parse(fs.readFileSync(CREDS_JSON, 'utf8'));
      subscriptionType = creds.claudeAiOauth?.subscriptionType || null;
    } catch {}
    _cache = {
      displayName: oa.displayName || null,
      email: oa.emailAddress || null,
      organizationRole: oa.organizationRole || null,
      subscriptionType,
    };
    _cacheKey = key;
    return _cache;
  } catch (e) {
    logError('account', e);
    _cache = null;
    _cacheKey = key;
    return null;
  }
}

const TEAM_PLANS = new Set(['team', 'enterprise']);

function classifyAccount(sub) {
  const s = (sub || '').toLowerCase();
  const isTeam = TEAM_PLANS.has(s);
  // \u25CF = ● (BLACK CIRCLE) — simple, ANSI-colorable (emoji aren't tinted by ANSI on most terminals).
  const icon = '\u25CF';
  const iconColor = isTeam ? C.teamColor : C.personalColor;
  let planLabel;
  if (!s) planLabel = '';
  else planLabel = s.charAt(0).toUpperCase() + s.slice(1);
  return { icon, iconColor, planLabel, isTeam };
}

function buildAccountStr(data) {
  if (!data || (!data.displayName && !data.subscriptionType)) return '';
  const { icon, iconColor, planLabel } = classifyAccount(data.subscriptionType);
  const name = data.displayName || '?';
  const plan = planLabel ? ` ${C.gray}\u00b7 ${planLabel}${C.reset}` : '';
  return `${SEP}${iconColor}${icon}${C.reset} ${C.accent}${name}${C.reset}${plan}`;
}

module.exports = { readAccount, classifyAccount, buildAccountStr };
