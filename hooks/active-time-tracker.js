#!/usr/bin/env node
'use strict';
// Active session time tracker.
// UserPromptSubmit → records turnStart. Stop → adds (now - turnStart) to totalMs.
// First run on a session bootstraps from transcript by replaying user→assistant pairs.
// Persistence: <claudeDir>/cache/active-time-<transcriptBasename>.json
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_TURN_MS = 6 * 3600000; // cap anti-crash por turno (sync com io.js readActiveTime)

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => input += c);
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => { try { run(JSON.parse(input)); } catch { process.exit(0); } });
setTimeout(() => process.exit(0), 4000).unref();

function atomicWrite(file, content) {
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch {} }
}

function bootstrapFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;
  let total = 0, userTs = null, lastAsstTs = null;
  const flush = () => {
    if (userTs && lastAsstTs && lastAsstTs >= userTs) total += lastAsstTs - userTs;
    userTs = null; lastAsstTs = null;
  };
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (!msg.timestamp) continue;
      const ts = new Date(msg.timestamp).getTime();
      if (!Number.isFinite(ts)) continue;
      if (msg.type === 'user') {
        const c = msg.message?.content;
        const isRealUser = typeof c === 'string' ? !c.startsWith('<') : Array.isArray(c);
        if (isRealUser) { flush(); userTs = ts; }
      } else if (msg.type === 'assistant' && userTs) {
        lastAsstTs = ts;
      }
    }
    flush();
  } catch {}
  return total;
}

function run(payload) {
  const transcriptPath = payload.transcript_path || '';
  const sessionId = payload.session_id || '';
  const event = payload.hook_event_name || process.env.CLAUDE_HOOK_EVENT_NAME || '';
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const key = transcriptPath ? path.basename(transcriptPath, '.jsonl') : sessionId;
  if (!key) return;
  const file = path.join(claudeDir, 'cache', `active-time-${key}.json`);
  let state = { totalMs: 0, turnStart: 0, bootstrapped: false };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  if (!state.bootstrapped) {
    state.totalMs = bootstrapFromTranscript(transcriptPath);
    state.bootstrapped = true;
  }
  const now = Date.now();
  if (event === 'UserPromptSubmit') {
    state.turnStart = now;
  } else if (event === 'Stop') {
    if (state.turnStart && now > state.turnStart) {
      // ponytail: cap por turno. Um Stop perdido (crash) deixaria turnStart antigo
      // e somaria um delta absurdo. 6h cobre turnos longos de agente legítimos.
      // Mantenha em sync com o cap em io.js readActiveTime.
      const delta = now - state.turnStart;
      if (delta <= MAX_TURN_MS) state.totalMs += delta;
    }
    state.turnStart = 0;
  }
  atomicWrite(file, JSON.stringify(state));
}
