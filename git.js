'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { C } = require('./utils');

const GIT_TTL_MS = 2500;
// In-process cache (statusline respawns every tick on CC, so this is effectively per-tick today;
// kept for future long-lived invocations and to make the invalidation path explicit).
const _gitCache = new Map(); // cwd -> { value, expires, indexMtime }

function runAsync(args, cwd) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: 2000, encoding: 'utf8' }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

function _indexMtime(cwd) {
  // Fast-path: .git/index; worktree case resolved later, but the cheap stat is good enough for invalidation.
  try { return fs.statSync(path.join(cwd, '.git', 'index')).mtimeMs; } catch {}
  try {
    const gd = fs.readFileSync(path.join(cwd, '.git'), 'utf8').trim();
    if (gd.startsWith('gitdir: ')) {
      return fs.statSync(path.join(cwd, gd.slice(8), 'index')).mtimeMs;
    }
  } catch {}
  return 0;
}

async function collectGit(cwd, pushThresholds) {
  const pt = Array.isArray(pushThresholds) && pushThresholds.length === 2 ? pushThresholds : [3, 10];
  let branch = '';
  let gitStatus = '';
  if (!cwd || !fs.existsSync(cwd)) return { branch, gitStatus };

  const now = Date.now();
  const cached = _gitCache.get(cwd);
  const curMtime = _indexMtime(cwd);
  if (cached && cached.expires > now && cached.indexMtime === curMtime && cached.pt0 === pt[0] && cached.pt1 === pt[1]) {
    return cached.value;
  }

  const [branchResult, porcelain, upstream, counts, gitDir, shortHead] = await Promise.all([
    runAsync(['branch', '--show-current'], cwd),
    runAsync(['--no-optional-locks', 'status', '--porcelain', '-unormal'], cwd),
    runAsync(['rev-parse', '--abbrev-ref', '@{upstream}'], cwd),
    runAsync(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], cwd),
    runAsync(['rev-parse', '--git-dir'], cwd),
    runAsync(['rev-parse', '--short', 'HEAD'], cwd),
  ]);

  // Detached HEAD: show short SHA with * suffix
  branch = branchResult || (shortHead ? `${shortHead}*` : '');
  if (!branch) return { branch, gitStatus };

  const fileCount = porcelain ? porcelain.split('\n').length : 0;
  let syncStatus = '';
  if (upstream) {
    let fetchAgo = '';
    try {
      // Resolve git dir for worktree support (git rev-parse returns relative or absolute)
      const resolvedGitDir = gitDir ? path.resolve(cwd, gitDir) : path.join(cwd, '.git');
      const fetchHeadPath = path.join(resolvedGitDir, 'FETCH_HEAD');
      if (fs.existsSync(fetchHeadPath)) {
        const fetchTime = fs.statSync(fetchHeadPath).mtimeMs;
        const diff = Math.floor((Date.now() - fetchTime) / 1000);
        if (diff < 60) fetchAgo = '<1m ago';
        else if (diff < 3600) fetchAgo = `${Math.floor(diff / 60)}m ago`;
        else if (diff < 86400) fetchAgo = `${Math.floor(diff / 3600)}h ago`;
        else fetchAgo = `${Math.floor(diff / 86400)}d ago`;
      } else {
        fetchAgo = 'never';
      }
    } catch {}

    if (counts) {
      const parts = counts.split(/\s+/).map(Number);
      const ahead = Number.isFinite(parts[0]) ? parts[0] : 0;
      const behind = Number.isFinite(parts[1]) ? parts[1] : 0;
      // Color ahead when it crosses warn/critical push thresholds.
      const aheadFmt = (n) => {
        if (n >= pt[1]) return `${C.danger}${n} ahead push!${C.reset}`;
        if (n >= pt[0]) return `${C.warn}${n} ahead${C.reset}`;
        return `${n} ahead`;
      };
      if (ahead === 0 && behind === 0) syncStatus = fetchAgo ? `synced ${fetchAgo}` : 'synced';
      else if (ahead > 0 && behind === 0) syncStatus = aheadFmt(ahead);
      else if (ahead === 0 && behind > 0) syncStatus = `${behind} behind`;
      else syncStatus = `${aheadFmt(ahead)}, ${behind} behind`;
    }
  } else {
    syncStatus = 'no upstream';
  }

  if (fileCount === 0) {
    gitStatus = `(0 files uncommitted, ${syncStatus})`;
  } else if (fileCount === 1) {
    gitStatus = `(${porcelain.replace(/^.../, '')} uncommitted, ${syncStatus})`;
  } else {
    gitStatus = `(${fileCount} files uncommitted, ${syncStatus})`;
  }
  const value = { branch, gitStatus };
  _gitCache.set(cwd, { value, expires: now + GIT_TTL_MS, indexMtime: curMtime, pt0: pt[0], pt1: pt[1] });
  return value;
}

module.exports = { collectGit };
