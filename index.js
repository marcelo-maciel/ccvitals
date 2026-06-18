#!/usr/bin/env node
// ccvitals — operational HUD statusline for Claude Code (see version.js)
// Line 1: [alerts] Model [effort][fast] | Cost | Session | Dir | Branch (uncommitted, sync) | Task · vX.Y.Z
// Line 2: Context bar | Rate limits | Cache (+TTL) | Compact | Tools | Turns | Todo progress
// Env: STATUSLINE_DISABLE=1 skip; STATUSLINE_STDIN_TIMEOUT=ms; DEBUG_STATUSLINE=1 log errors
'use strict';
const path = require('path');
const os = require('os');
const { C, getErrors, safeSlice, logError, sweepOrphans } = require('./utils');
const { collectGit } = require('./git');
const { parseTranscript } = require('./transcript');
const {
  buildContextBar, buildCostStr, buildRateLimitsStr,
  buildAgentLines, buildEffortStr, buildLine1, buildLine2, computeSessionDur,
  buildCacheStr, buildTodoStr,
} = require('./display');
const { readSettings, trackMonthlyCost, trackRateLimitSnapshot, readActiveTime, readCompactCount, writeBridgeFile, lookupTask } = require('./io');
const { checkClaudeUpdate, formatUpdateStr, isNewer } = require('./update');
const { readAccount, buildAccountStr } = require('./account');

if (process.env.STATUSLINE_DISABLE === '1') process.exit(0);

let input = '';
const STDIN_TIMEOUT = Math.max(500, Math.min(30000, Number(process.env.STATUSLINE_STDIN_TIMEOUT) || 5000));
const timeout = setTimeout(() => process.exit(0), STDIN_TIMEOUT);
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(timeout);
  try {
    main(JSON.parse(input)).catch(e => {
      try { process.stdout.write(`\x1b[31m! statusline crash: ${(e?.message || String(e)).substring(0, 80)}\x1b[0m\n`); } catch {}
    });
  } catch (e) {
    try { process.stdout.write(`\x1b[31m! stdin parse: ${(e?.message || String(e)).substring(0, 80)}\x1b[0m\n`); } catch {}
  }
});

async function main(data) {
  const tickStart = Date.now();
  const timings = {};
  const model = data.model?.display_name || data.model?.id || '?';
  const cwd = data.cwd || process.cwd();
  const sessionId = data.session_id || '';
  const transcriptPath = data.transcript_path || '';
  const dir = data.worktree?.name || cwd;
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settings = readSettings();
  // Priority: transcript /effort (typed, picker, or inherited across /clear) > stdin payload > persisted settings.
  // CC 2.1.112+ stopped shipping effortLevel via stdin; transcript is authoritative for session-only modes.
  // settings.effortLevel is the persisted DEFAULT — it can legitimately diverge from the live session effort.
  let effort = data.effortLevel || settings.effort;
  const { thresholds } = settings;
  // Prefer live signal from CC stdin; fall back to settings.json for backwards compat.
  const fastMode = (data.fastMode ?? data.model?.fast ?? settings.fastMode) === true;

  const t0 = Date.now();
  const updateResult = await checkClaudeUpdate(path.join(claudeDir, 'cache', 'claude-update-check.json'));
  timings.claudeUpdate = Date.now() - t0;

  const t1 = Date.now();
  const { branch, gitStatus } = await collectGit(cwd, thresholds.push);
  timings.git = Date.now() - t1;

  const t2 = Date.now();
  const t = parseTranscript(transcriptPath, sessionId, claudeDir);
  timings.transcript = Date.now() - t2;
  if (t.lastEffort) effort = t.lastEffort;

  sweepOrphans(claudeDir, settings.aggWindowDays);
  const activeMs = readActiveTime(transcriptPath, sessionId, claudeDir);
  const sessionDur = computeSessionDur(t.firstTimestamp, transcriptPath, activeMs);
  const { ctx, pct, pctEstimated, remainingPct } = buildContextBar(data, t.lastUsage, {
    lastCompactBoundaryTs: t.lastCompactBoundaryTs,
    lastApiTimestamp: t.lastApiTimestamp,
    compactSummaryTokens: t.compactSummaryTokens,
    sessionBaselineTokens: t.sessionBaselineTokens,
  });
  writeBridgeFile(sessionId, pct, pctEstimated, remainingPct);

  const cost = data.cost?.total_cost_usd;
  const cost30d = trackMonthlyCost(cost, sessionId, claudeDir, settings.aggWindowDays);
  const costStr = buildCostStr(cost, cost30d, thresholds);
  const rlAgg = trackRateLimitSnapshot(data.rate_limits, sessionId, claudeDir);
  const rlStr = buildRateLimitsStr(data.rate_limits, thresholds, t.lastApiTimestamp, rlAgg);
  const taskStr = lookupTask(sessionId, claudeDir);
  const effortStr = buildEffortStr(effort);
  const fastStr = fastMode ? `${C.yellow}\u26A1${C.reset}` : '';
  const accountStr = buildAccountStr(readAccount());
  // CC version is captured per session from transcript `version` field — refreshes naturally on new sessions.
  // Green = up-to-date, bright red = update available, soft gray = undetermined (first run / network err).
  // "Outdated" compares npm latest against the RUNNING session's version — a replaced
  // binary on disk doesn't help until this session restarts. Falls back to the
  // PATH-CLI comparison (worker's `claude --version`) when the session doesn't report one.
  const ccVer = data.version || t.ccVersion;
  const outdated = updateResult.latest && ccVer
    ? isNewer(updateResult.latest, ccVer)
    : updateResult.update_available;
  const updateStr = formatUpdateStr(updateResult, outdated);
  let ccVerStr = '';
  if (ccVer) {
    const undetermined = !outdated && updateResult.error && updateResult.error !== 'no-cli';
    const color = outdated ? '\x1b[91m' : undetermined ? C.soft : C.green;
    ccVerStr = ` ${color}(${ccVer})${C.reset}`;
  }

  const toolStr = t.toolCallCount > 0 ? ` ${C.gray}| ${t.toolCallCount} tools${C.reset}` : '';
  const turnStr = t.turnCount > 0 ? ` ${C.gray}| ${t.turnCount} turns${C.reset}` : '';
  // Prefer MAX(JSONL-derived, PreCompact-hook count) — protects the counter
  // against schema drift on either side; whichever observes more wins.
  const compactCount = Math.max(t.compactCount, readCompactCount(transcriptPath, sessionId, claudeDir));
  const compactStr = compactCount > 0 ? ` ${C.gray}| ${C.orange}${compactCount}x compact${C.reset}` : '';
  const toolUsedStr = t.lastToolUsed ? ` ${C.gray}| ${C.soft}${t.lastToolUsed}${C.reset}` : '';
  const cacheStr = buildCacheStr(t.lastUsage, t.lastApiTimestamp);
  const todoStr = buildTodoStr(t.lastTodos);
  const errs = getErrors();
  const errStr = errs.length
    ? ` ${C.red}!${errs.length > 2 ? errs.length + ':' : ''}${errs.slice(-2).join(',')}${C.reset}` : '';

  process.stdout.write(buildLine1({ updateStr, errStr, model, effortStr, ccVerStr, fastStr, accountStr, costStr, sessionDur, dir, cwd, branch, gitStatus, taskStr }) + '\n');
  process.stdout.write(buildLine2({ ctx, rlStr, cacheStr, compactStr, toolStr, turnStr, toolUsedStr, todoStr }) + '\n');

  const agentLines = buildAgentLines(t.agentMap, effort, model);
  if (agentLines) process.stdout.write(agentLines + '\n');

  if (t.lastUserMessage) {
    const display = t.lastUserMessage.length > 100 ? safeSlice(t.lastUserMessage, 97) + '...' : t.lastUserMessage;
    process.stdout.write(`\ud83d\udcac ${display}\n`);
  }

  const elapsed = Date.now() - tickStart;
  if (elapsed > 500) {
    logError('slow', new Error(`${elapsed}ms (${Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(',')})`));
  }
}
