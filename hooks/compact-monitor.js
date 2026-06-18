#!/usr/bin/env node
'use strict';
// PreCompact hook — increments compact counter for the session.
// Persisted at <claudeDir>/cache/compact-<transcriptBasename>.json (shape: { count, updatedAt }).
// transcript.js prefers MAX(this.count, jsonl-derived) so the counter survives schema drift.
const fs = require('fs');
const path = require('path');
const os = require('os');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => input += c);
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => { try { run(JSON.parse(input)); } catch { process.exit(0); } });
setTimeout(() => process.exit(0), 3000).unref();

function atomicWrite(file, content) {
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch { try { fs.unlinkSync(tmp); } catch {} }
}

function run(payload) {
  const transcriptPath = payload.transcript_path || '';
  const sessionId = payload.session_id || '';
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const key = transcriptPath ? path.basename(transcriptPath, '.jsonl') : sessionId;
  if (!key) return;
  const file = path.join(claudeDir, 'cache', `compact-${key}.json`);
  let state = { count: 0 };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  state.count = (state.count || 0) + 1;
  state.updatedAt = Date.now();
  atomicWrite(file, JSON.stringify(state));
}
