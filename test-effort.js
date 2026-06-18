'use strict';
// Effort capture/inheritance test suite. Run: node test-effort.js
// Covers: picker stdout capture, typed args, invalid-arg whitelist, clear-born
// inheritance (incl. chained /clear), cache schema/stickiness, turn-count hygiene.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseTranscript } = require('./transcript');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-effort-test-'));
const proj = path.join(root, 'projects', 'test-proj');
const claudeDir = path.join(root, 'claude');
fs.mkdirSync(proj, { recursive: true });
fs.mkdirSync(path.join(claudeDir, 'cache'), { recursive: true });

const L = (o) => JSON.stringify(o) + '\n';
const userCmd = (name, args, ts) => L({ type: 'user', message: { role: 'user', content: `<command-name>${name}</command-name>\n            <command-message>${name.slice(1)}</command-message>\n            <command-args>${args}</command-args>` }, timestamp: ts });
const userStdout = (text, ts) => L({ type: 'user', message: { role: 'user', content: `<local-command-stdout>${text}</local-command-stdout>` }, timestamp: ts });
const userMsg = (text, ts) => L({ type: 'user', message: { role: 'user', content: text }, timestamp: ts });
const hookClear = () => L({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:clear' } });

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log(`PASS ${name}: '${got}'`); }
  else { fail++; console.log(`FAIL ${name}: got '${got}', want '${want}'`); }
}

// helper: write file with controlled mtime ordering (sleep-free: utimesSync)
function writeT(name, content, mtimeOffsetSec) {
  const p = path.join(proj, name);
  fs.writeFileSync(p, content);
  const t = new Date(Date.now() - mtimeOffsetSec * 1000);
  fs.utimesSync(p, t, t);
  return p;
}

// ── Case 1: picker selects ultracode (empty args + confirmation stdout)
const t1 = writeT('s1.jsonl',
  userMsg('hello', '2026-06-03T10:00:00Z')
  + userCmd('/effort', '', '2026-06-03T10:01:00Z')
  + userStdout('Set effort level to ultracode (this session only): blah', '2026-06-03T10:01:01Z'),
  500);
check('picker-ultracode', parseTranscript(t1, 's1', claudeDir).lastEffort, 'ultracode');

// ── Case 2: typed /effort xhigh (regression)
const t2 = writeT('s2.jsonl',
  userMsg('hello', '2026-06-03T10:02:00Z')
  + userCmd('/effort', 'xhigh', '2026-06-03T10:03:00Z'),
  400);
check('typed-xhigh', parseTranscript(t2, 's2', claudeDir).lastEffort, 'xhigh');

// ── Case 3: invalid typed arg ignored, previous kept
const t3 = writeT('s3.jsonl',
  userCmd('/effort', 'max', '2026-06-03T10:04:00Z')
  + userCmd('/effort', 'xyz', '2026-06-03T10:05:00Z'),
  300);
check('invalid-arg-ignored', parseTranscript(t3, 's3', claudeDir).lastEffort, 'max');

// ── Case 4: fresh session, no effort, NOT clear-born → '' (falls to settings upstream)
const t4 = writeT('s4.jsonl', userMsg('hello', '2026-06-03T10:06:00Z'), 250);
check('fresh-no-effort', parseTranscript(t4, 's4', claudeDir).lastEffort, '');

// ── Case 5: chained /clear inheritance
// A: has /effort max (oldest mtime)
const tA = writeT('sA.jsonl',
  userMsg('work', '2026-06-03T11:00:00Z')
  + userCmd('/effort', 'max', '2026-06-03T11:01:00Z'),
  200);
// B: clear-born, no own effort. Born (birthtime=now) after A's mtime.
const tB = writeT('sB.jsonl',
  hookClear()
  + userCmd('/clear', '', '2026-06-03T11:02:00Z')
  + userMsg('continuing', '2026-06-03T11:02:30Z'),
  150);
// Hide other candidates from B's predecessor scan by mtime: A(-200s) < B(-150s).
// But t1..t4 have mtimes -500..-250 → A (-200) is the most recent ≤ B's birth. Good.
const rB = parseTranscript(tB, 'sB', claudeDir);
check('clear-born-inherits', rB.lastEffort, 'max');
// state cache persisted for sB?
const stB = JSON.parse(fs.readFileSync(path.join(claudeDir, 'cache', 'statusline-state-sB.json'), 'utf8'));
check('cache-schema-v2', String(stB.v), '2');
check('cache-clearBorn-sticky', String(stB.state.clearBorn), 'true');
check('cache-effort-persisted', stB.state.lastEffort, 'max');

// C: clear-born after B. B has no /effort line → must fall back to B's state cache.
const tC = writeT('sC.jsonl',
  hookClear()
  + userCmd('/clear', '', '2026-06-03T11:05:00Z')
  + userMsg('still going', '2026-06-03T11:05:30Z'),
  100);
// Make B the most recent predecessor: bump B mtime above A
const tBnow = new Date(Date.now() - 120 * 1000);
fs.utimesSync(tB, tBnow, tBnow);
check('chained-clear-inherits', parseTranscript(tC, 'sC', claudeDir).lastEffort, 'max');

// ── Case 6: incremental render — second parse of sB uses cache, effort stays
check('second-render-cached', parseTranscript(tB, 'sB', claudeDir).lastEffort, 'max');

// ── Case 7: clear-born then user changes effort → own /effort wins over inheritance
const tD = writeT('sD.jsonl',
  hookClear()
  + userCmd('/clear', '', '2026-06-03T11:06:00Z')
  + userCmd('/effort', '', '2026-06-03T11:07:00Z')
  + userStdout('Set effort level to low (this session only)', '2026-06-03T11:07:01Z'),
  50);
check('own-effort-beats-inherited', parseTranscript(tD, 'sD', claudeDir).lastEffort, 'low');

// ── Case 8: turn counting skips command/meta lines
const t8 = writeT('s8.jsonl',
  L({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat...</local-command-caveat>' }, timestamp: '2026-06-03T12:00:00Z' })
  + userCmd('/effort', 'high', '2026-06-03T12:00:01Z')
  + userStdout('Set effort level to high', '2026-06-03T12:00:02Z')
  + userMsg('real question', '2026-06-03T12:00:10Z'),
  10);
const r8 = parseTranscript(t8, 's8', claudeDir);
check('turns-skip-commands', String(r8.turnCount), '1');
check('lastmsg-no-xml', r8.lastUserMessage, 'real question');

// ── Case 9: pid-chain beats mtime heuristic (parallel-session ambiguity)
// Process pid 999 hosted sE then (after /clear) sF. A decoy parallel session
// has the most recent mtime — mtime heuristic would pick it; pid chain must win.
const sessDir = path.join(claudeDir, 'sessions');
fs.mkdirSync(sessDir, { recursive: true });
const setLive = (sid) => fs.writeFileSync(path.join(sessDir, '999.json'), JSON.stringify({ pid: 999, sessionId: sid }));
const tE = writeT('sE.jsonl',
  userMsg('work', '2026-06-03T13:00:00Z')
  + userCmd('/effort', 'ultracode', '2026-06-03T13:01:00Z'),
  40);
setLive('sE');
parseTranscript(tE, 'sE', claudeDir); // render during predecessor → chain [sE]
const tDecoy = writeT('decoy.jsonl',
  userMsg('parallel session', '2026-06-03T13:02:00Z')
  + userCmd('/effort', 'low', '2026-06-03T13:02:30Z'),
  5); // most recent mtime — would win the heuristic
const tF = writeT('sF.jsonl',
  hookClear()
  + userCmd('/clear', '', '2026-06-03T13:03:00Z')
  + userMsg('post clear', '2026-06-03T13:03:30Z'),
  2);
setLive('sF'); // CC swapped the live sessionId on /clear
check('pid-chain-beats-mtime', parseTranscript(tF, 'sF', claudeDir).lastEffort, 'ultracode');

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
