'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite, logError, redact, AGENT_ZOMBIE_SECS, EFFORT_CONFIG } = require('./utils');

// Bump when the persisted state shape or parsing rules change — old caches are
// discarded and the transcript fully reparsed (incremental reads would otherwise
// never re-scan bytes consumed under the old rules).
const CACHE_SCHEMA = 2;

// Extracts an effort level from one transcript line (parsed text or raw JSONL).
// Two sources, later transcript lines win at the call site:
// 1. Typed args: <command-args>LEVEL</command-args> — whitelisted against
//    EFFORT_CONFIG because CC records invalid args (e.g. /effort xyz) even
//    though it rejects them.
// 2. Confirmation stdout: "Set effort level to LEVEL" — covers picker selections
//    (bare /effort leaves command-args empty) and is trusted as-is: CC only
//    confirms valid levels, so unknown future levels still render (gray fallback).
function matchEffort(txt) {
  const out = txt.match(/<local-command-stdout>Set effort level to ([A-Za-z]+)/);
  if (out) return out[1].toLowerCase();
  const m = txt.match(/<command-name>\/effort<\/command-name>[\s\S]*?<command-args>\s*([A-Za-z]+)\s*<\/command-args>/);
  if (m) {
    const lvl = m[1].toLowerCase();
    if (EFFORT_CONFIG[lvl]) return lvl;
  }
  return '';
}

function parseTranscript(transcriptPath, sessionId, claudeDir) {
  const empty = {
    toolCallCount: 0, compactCount: 0, turnCount: 0, activeAgents: 0,
    lastUsage: null, lastUserMessage: '',
    firstTimestamp: null, lastToolUsed: '', agentMap: new Map(),
    lastApiTimestamp: null, lastEffort: '', lastTodos: null, ccVersion: '',
    lastCompactBoundaryTs: null, compactSummaryTokens: 0, sessionBaselineTokens: 0,
  };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return empty;

  let toolCallCount = 0, compactCount = 0, turnCount = 0, activeAgents = 0;
  let lastUsage = null, lastUserMessage = '';
  let firstTimestamp = null, lastToolUsed = '', userSeen = false;
  let lastApiTimestamp = null;
  let ccVersion = '';
  // Track post-compact transient state — CC's stdin remaining_percentage briefly
  // reports near-fresh (100%) right after /compact, until the next API turn fills in
  // realistic numbers. We estimate the post-compact context size from
  // (sessionBaselineTokens + compactSummaryTokens) so the statusline doesn't flash 0%.
  // sessionBaselineTokens = cache_read+cache_creation of the first observed assistant
  // usage in the session, which approximates system prompt + tool definitions +
  // CLAUDE.md re-injected on every fresh start.
  let lastCompactBoundaryTs = null;
  let compactSummaryTokens = 0;
  let sessionBaselineTokens = 0;
  // Captured from the /effort command record (typed args) or its confirmation
  // stdout (picker selections) — CC 2.1.112+ stopped shipping effortLevel in the
  // statusline stdin payload. See matchEffort().
  let lastEffort = '';
  // /clear spawns a NEW session id + transcript file (the /clear record and
  // SessionStart:clear hooks land at the top of the new file). The session-scoped
  // effort survives in the CC process but leaves no trace in the new transcript,
  // so clear-born sessions inherit it from the predecessor transcript.
  let clearBorn = false;
  let lastTodos = null;
  const agentMap = new Map();
  const completedAgents = new Set();
  const stateCachePath = sessionId
    ? path.join(claudeDir, 'cache', `statusline-state-${sessionId}.json`)
    : null;

  try {
    const stat = fs.statSync(transcriptPath);
    let headFp = '';
    let cached = null;
    if (stateCachePath) {
      // ENOENT is the normal first render of a session — not an error.
      try { cached = JSON.parse(fs.readFileSync(stateCachePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') logError('cache-load', e); }
      if (cached && cached.v !== CACHE_SCHEMA) cached = null; // stale schema → full reparse
    }
    const mtimeMs = stat.mtimeMs || 0;
    if (cached && cached.path === transcriptPath && cached.mtimeMs === mtimeMs && cached.size === stat.size) {
      headFp = cached.headFp || '';
    } else {
      try {
        const fd0 = fs.openSync(transcriptPath, 'r');
        try {
          const buf = Buffer.alloc(Math.min(1024, stat.size));
          fs.readSync(fd0, buf, 0, buf.length, 0);
          headFp = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
        } finally { fs.closeSync(fd0); }
      } catch {}
    }
    let readStart = 0;
    if (cached) {
      try {
        if (cached.path === transcriptPath && cached.headFp === headFp && cached.size <= stat.size) {
          readStart = cached.size;
          const s = cached.state || {};
          toolCallCount = s.toolCallCount || 0;
          compactCount = s.compactCount || 0;
          turnCount = s.turnCount || 0;
          lastUserMessage = s.lastUserMessage || '';
          lastUsage = s.lastUsage || null;
          firstTimestamp = s.firstTimestamp || null;
          lastToolUsed = s.lastToolUsed || '';
          userSeen = s.userSeen || false;
          lastApiTimestamp = s.lastApiTimestamp || null;
          lastEffort = s.lastEffort || '';
          clearBorn = s.clearBorn || false;
          lastTodos = Array.isArray(s.lastTodos) ? s.lastTodos : null;
          ccVersion = s.ccVersion || '';
          lastCompactBoundaryTs = s.lastCompactBoundaryTs || null;
          compactSummaryTokens = s.compactSummaryTokens || 0;
          sessionBaselineTokens = s.sessionBaselineTokens || 0;
          for (const [id, data] of (s.agentMapEntries || [])) agentMap.set(id, data);
          for (const id of (s.completedAgentsList || [])) completedAgents.add(id);
        }
      } catch (e) { logError('cache-load', e); }
    }

    let content = '';
    if (stat.size > readStart) {
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(stat.size - readStart);
        fs.readSync(fd, buf, 0, stat.size - readStart, readStart);
        content = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    }

    for (const line of content.split('\n').filter(Boolean)) {
      try {
        const msg = JSON.parse(line);
        // .trim() strips a trailing \r if a transcript ever lands with CRLF line
        // endings (CC writes \n, but be robust across OSes) so the command-equality
        // checks below don't silently miss a '/clear\r' record.
        const contentStr = (typeof msg.message?.content === 'string' ? msg.message.content : '').trim();
        if (msg.isClearRequest || msg.type === 'clear' ||
            (msg.type === 'user' && (contentStr === '/clear' || contentStr.includes('<command-name>/clear</command-name>')))) {
          // A /clear record before any real user message means this file was BORN
          // from /clear (modern CC writes the record into the new file) — mark it
          // so the effort can be inherited from the predecessor transcript.
          if (!userSeen) clearBorn = true;
          // Reset conversation-scoped counters only.
          // firstTimestamp and lastApiTimestamp span the full session
          // (session duration shouldn't reset; rate-limit staleness is account-wide).
          compactCount = 0; toolCallCount = 0; turnCount = 0;
          lastUserMessage = ''; lastUsage = null; userSeen = false;
          lastToolUsed = ''; lastTodos = null;
          lastCompactBoundaryTs = null; compactSummaryTokens = 0; sessionBaselineTokens = 0;
          agentMap.clear(); completedAgents.clear();
          continue;
        }
        // Secondary clear-born signal — survives even if CC stops logging the
        // /clear command record itself.
        if (!userSeen && msg.attachment?.hookName === 'SessionStart:clear') clearBorn = true;
        if (!firstTimestamp && msg.timestamp) firstTimestamp = msg.timestamp;
        if (msg.version) ccVersion = msg.version;
        if (msg.type === 'user') {
          let txt = '';
          const raw = msg.message?.content;
          if (typeof raw === 'string') txt = raw;
          else if (Array.isArray(raw)) {
            txt = raw.filter(c => c.type === 'text').map(c => c.text).join(' ');
            for (const c of raw) {
              if (c.type === 'tool_result' && agentMap.has(c.tool_use_id)) completedAgents.add(c.tool_use_id);
            }
          }
          // Session effort: last /effort record (typed args or picker confirmation stdout) wins.
          const eff = matchEffort(txt);
          if (eff) lastEffort = eff;
          if (/<task-notification[\s>]/.test(txt)) {
            for (const m of txt.matchAll(/tool-use-id>(toolu_[^<]+)</g)) completedAgents.add(m[1]);
          } else if (!msg.isMeta && !/^<(?:command-|local-command-)/.test(txt)) {
            // Skip meta lines and slash-command records/stdout — they aren't real
            // user turns (previously inflated turnCount and leaked command XML
            // into the 💬 last-message line).
            const clean = txt.replace(/\n/g, ' ').replace(/  +/g, ' ').trim();
            if (clean) {
              userSeen = true; turnCount++;
              if (!clean.startsWith('[Request interrupted') && !clean.startsWith('[Request cancelled')) {
                lastUserMessage = redact(clean);
              }
            }
          }
        }
        // CC marks compaction boundaries via multiple flags across versions.
        // OR them so a schema tweak on one side doesn't silently zero the counter.
        const isCompactBoundary =
          (msg.isSnapshotUpdate && msg.type !== 'file-history-snapshot') ||
          msg.isCompactBoundary === true ||
          msg.subtype === 'compact_boundary' ||
          msg.type === 'compact_boundary';
        if (isCompactBoundary && userSeen) {
          compactCount++;
          if (msg.timestamp) lastCompactBoundaryTs = msg.timestamp;
        }
        // Compact summary is a synthetic user message injected post-compact.
        // Estimate its token cost (~4 chars/token) so we can show realistic % until
        // the next API turn produces real usage.
        if (msg.type === 'user' && msg.isCompactSummary) {
          const c = msg.message?.content;
          let chars = 0;
          if (typeof c === 'string') chars = c.length;
          else if (Array.isArray(c)) {
            for (const part of c) if (part.type === 'text' && typeof part.text === 'string') chars += part.text.length;
          }
          compactSummaryTokens = Math.round(chars / 4);
        }
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const c of msg.message.content) {
            if (c.type === 'tool_use') {
              toolCallCount++; lastToolUsed = c.name || lastToolUsed;
              if (c.name === 'Agent') agentMap.set(c.id, {
                desc: c.input?.description || '?', type: c.input?.subagent_type || '',
                model: c.input?.model || '', effort: c.input?.effort || '',
                isolation: c.input?.isolation || '',
                bg: c.input?.run_in_background || false, name: c.input?.name || '',
                startTime: msg.timestamp || null,
              });
              // Latest TodoWrite wins — transcript order == chronological.
              // Redact content/activeForm here so a secret pasted into a todo never
              // persists raw to the state cache on disk (or renders raw in the bar).
              if (c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
                lastTodos = c.input.todos.map(td => (td && typeof td === 'object') ? {
                  ...td,
                  content: typeof td.content === 'string' ? redact(td.content) : td.content,
                  activeForm: typeof td.activeForm === 'string' ? redact(td.activeForm) : td.activeForm,
                } : td);
              }
            }
          }
        }
        if (msg.message?.usage && !msg.isSidechain && !msg.isApiErrorMessage) {
          lastUsage = msg.message.usage;
          lastApiTimestamp = msg.timestamp || lastApiTimestamp;
          if (!sessionBaselineTokens) {
            const u = msg.message.usage;
            sessionBaselineTokens = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          }
        }
      } catch {}
    }

    // Track pid → sessionId history on every render so clear-born sessions can
    // find their exact same-process predecessor later.
    const pidChain = trackPidChain(sessionId, claudeDir);
    // Clear-born session with no /effort of its own → inherit from predecessor.
    // Retries every render while empty (clearBorn is sticky in the state cache;
    // the /clear marker bytes are consumed by the first incremental read).
    if (clearBorn && !lastEffort) lastEffort = inheritEffort(transcriptPath, claudeDir, sessionId, pidChain);

    for (const id of completedAgents) agentMap.delete(id);
    // Collect zombies before deleting — mutating a Map during its own iteration is fragile across engines.
    const zombies = [];
    for (const [id, a] of agentMap) {
      if (a.startTime && Math.floor((Date.now() - new Date(a.startTime).getTime()) / 1000) > AGENT_ZOMBIE_SECS) {
        zombies.push(id);
      }
    }
    for (const id of zombies) agentMap.delete(id);
    activeAgents = agentMap.size;

    if (stateCachePath) {
      try {
        atomicWrite(stateCachePath, JSON.stringify({
          v: CACHE_SCHEMA,
          path: transcriptPath, size: stat.size, mtimeMs, headFp,
          state: {
            toolCallCount, compactCount, turnCount, lastUserMessage, lastUsage,
            firstTimestamp, lastToolUsed, userSeen, lastApiTimestamp, lastEffort, clearBorn,
            lastTodos, ccVersion,
            lastCompactBoundaryTs, compactSummaryTokens, sessionBaselineTokens,
            agentMapEntries: [...agentMap.entries()],
            completedAgentsList: [...completedAgents],
          },
        }));
      } catch (e) { logError('cache-save', e); }
    }

    enrichSubagents(agentMap, transcriptPath);

  } catch (e) { logError('transcript', e); }

  return {
    toolCallCount, compactCount, turnCount, activeAgents,
    lastUsage, lastUserMessage, firstTimestamp, lastToolUsed, agentMap,
    lastApiTimestamp, lastEffort, lastTodos, ccVersion,
    lastCompactBoundaryTs, compactSummaryTokens, sessionBaselineTokens,
  };
}

// Tracks which sessionIds this CC process has hosted, across renders.
// CC writes sessions/<pid>.json (pid → live sessionId); /clear swaps the
// sessionId in place while the process — and its session-scoped effort —
// survives. Appending each observed sessionId to cache/statusline-pid-<pid>.json
// gives clear-born sessions an EXACT predecessor link, immune to the parallel-
// session ambiguity of the mtime heuristic below. Returns the chain or null.
function trackPidChain(sessionId, claudeDir) {
  if (!sessionId) return null;
  try {
    const sessDir = path.join(claudeDir, 'sessions');
    let pid = 0;
    for (const f of fs.readdirSync(sessDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
        if (s.sessionId === sessionId) { pid = s.pid || parseInt(f, 10) || 0; break; }
      } catch {}
    }
    if (!pid) return null;
    const chainPath = path.join(claudeDir, 'cache', `statusline-pid-${pid}.json`);
    let chain = [];
    try { chain = JSON.parse(fs.readFileSync(chainPath, 'utf8')).sessions || []; } catch {}
    if (chain[chain.length - 1] !== sessionId) {
      chain.push(sessionId);
      if (chain.length > 20) chain = chain.slice(-20);
      atomicWrite(chainPath, JSON.stringify({ sessions: chain, ts: Date.now() }));
    }
    return chain;
  } catch { return null; }
}

// Resolves the effort a clear-born session inherited from its CC process.
// Primary: exact predecessor from the pid chain (same process, previous sessionId).
// Fallback: the most recently modified sibling .jsonl that stopped being written
// before this file was born (mtime ≤ birth + 5s slack) — the parentUuid chain
// restarts on /clear, so there is no in-transcript cross-file link; this
// heuristic's only failure mode is a parallel session in the same project dir.
function inheritEffort(transcriptPath, claudeDir, sessionId, pidChain) {
  try {
    const dir = path.dirname(transcriptPath);
    const self = path.basename(transcriptPath);
    let best = '';
    if (pidChain && sessionId) {
      const i = pidChain.lastIndexOf(sessionId);
      if (i > 0 && fs.existsSync(path.join(dir, `${pidChain[i - 1]}.jsonl`))) {
        best = `${pidChain[i - 1]}.jsonl`;
      }
    }
    if (!best) {
      const st = fs.statSync(transcriptPath);
      const birth = st.birthtimeMs || st.mtimeMs;
      let bestM = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl') || f === self) continue;
        let m = 0;
        try { m = fs.statSync(path.join(dir, f)).mtimeMs; } catch { continue; }
        if (m <= birth + 5000 && m > bestM) { bestM = m; best = f; }
      }
    }
    if (!best) return '';
    // Authoritative: last /effort record in the predecessor transcript tail.
    // Re-scanned here (not trusted from its state cache first) because older
    // statusline versions missed picker-selected efforts entirely.
    const eff = readTailEffort(path.join(dir, best));
    if (eff) return eff;
    // Fallback: predecessor's persisted state — covers chained /clear, where the
    // inherited value was cached but no /effort line exists in that transcript.
    try {
      const predState = JSON.parse(fs.readFileSync(
        path.join(claudeDir, 'cache', `statusline-state-${path.basename(best, '.jsonl')}.json`), 'utf8'));
      return predState?.state?.lastEffort || '';
    } catch { return ''; }
  } catch (e) { logError('inherit-effort', e); return ''; }
}

// Scans the last 256KB of a transcript for the latest /effort record.
// Each line is JSON-parsed and only genuine command records count
// (type:user with string content) — raw substring matching would false-positive
// on echoes, e.g. a tool_result that dumped another transcript's /effort line.
function readTailEffort(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.size) return '';
    const readSize = Math.min(stat.size, 262144);
    const fd = fs.openSync(filePath, 'r');
    let buf;
    try {
      buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    } finally { fs.closeSync(fd); }
    let eff = '';
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('/effort') && !line.includes('Set effort level to')) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type !== 'user' || typeof msg.message?.content !== 'string') continue;
        const e = matchEffort(msg.message.content);
        if (e) eff = e;
      } catch {}
    }
    return eff;
  } catch { return ''; }
}

// For each active agent, find its subagent transcript and attach lastUsage + actual model.
// Subagent files live at <transcriptDir>/<sessionId>/subagents/agent-<id>.{jsonl,meta.json}.
// Match by (agentType + description) since the parent's tool_use id isn't echoed in the meta.
function enrichSubagents(agentMap, transcriptPath) {
  if (!agentMap.size) return;
  try {
    const dir = path.dirname(transcriptPath);
    const sess = path.basename(transcriptPath, '.jsonl');
    const subDir = path.join(dir, sess, 'subagents');
    if (!fs.existsSync(subDir)) return;
    const files = fs.readdirSync(subDir);
    const metas = [];
    for (const f of files) {
      const m = f.match(/^agent-([0-9a-f]+)\.meta\.json$/i);
      if (!m) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(subDir, f), 'utf8'));
        metas.push({ id: m[1], type: meta.agentType || '', desc: meta.description || '' });
      } catch {}
    }
    if (!metas.length) return;
    const claimed = new Set();
    for (const [, a] of agentMap) {
      const match = metas.find(m => !claimed.has(m.id)
        && (m.type || '') === (a.type || '')
        && (m.desc || '') === (a.desc || ''));
      if (!match) continue;
      claimed.add(match.id);
      const jsonlPath = path.join(subDir, `agent-${match.id}.jsonl`);
      const tail = readTailUsage(jsonlPath);
      if (tail) {
        a.lastUsage = tail.usage;
        if (tail.model) a.runtimeModel = tail.model;
      }
    }
  } catch (e) { logError('subagent-enrich', e); }
}

function readTailUsage(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.size) return null;
    // Read last 64KB — enough to contain the latest assistant message with usage.
    const readSize = Math.min(stat.size, 65536);
    const fd = fs.openSync(filePath, 'r');
    let buf;
    try {
      buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i].trim();
      if (!ln) continue;
      try {
        const d = JSON.parse(ln);
        const u = d.message?.usage;
        if (u) return { usage: u, model: d.message?.model || '' };
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = { parseTranscript };
