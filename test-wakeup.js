'use strict';
// Pending ScheduleWakeup of the session (the ⏰ on the last statusline line). Run: node --test
// Record shapes copied from a real transcript (2026-11-08): the tool_result text carries "(in Ns)",
// and the firing is a system record with subtype scheduled_task_fire.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseTranscript } = require('./transcript');
const { buildWakeupStr } = require('./display');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-wakeup-test-'));
const claudeDir = path.join(root, 'claude');
fs.mkdirSync(path.join(claudeDir, 'cache'), { recursive: true });
after(() => fs.rmSync(root, { recursive: true, force: true }));

const L = (o) => JSON.stringify(o) + '\n';
const use = (id, input, ts) => L({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'ScheduleWakeup', input }] } });
const result = (id, content, ts, isError) => L({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });
const scheduled = (secs) => `Next wakeup scheduled for 22:15:00 (in ${secs}s). If you owe the user a status update this tick, write it now as ordinary response text; then end the turn.`;
const fire = (ts) => L({ type: 'system', subtype: 'scheduled_task_fire', content: 'Claude resuming /loop wakeup (Nov 8 1:49am)', isMeta: false, timestamp: ts });
const at = (iso, secs) => new Date(iso).getTime() + secs * 1000;

let n = 0;
function parse(content) {
  const p = path.join(root, `s${++n}.jsonl`);
  fs.writeFileSync(p, content);
  return parseTranscript(p, `s${n}`, claudeDir).wakeupAt;
}

test('scheduled: result time plus the seconds', () => {
  assert.strictEqual(parse(
    use('toolu_a', { delaySeconds: 3600, prompt: 'x' }, '2026-11-09T00:15:44.690Z')
    + result('toolu_a', scheduled(3555), '2026-11-09T00:15:45.089Z')), at('2026-11-09T00:15:45.089Z', 3555));
});

test('result as a list of text blocks', () => {
  assert.strictEqual(parse(
    use('toolu_a', { delaySeconds: 600 }, '2026-11-09T00:00:00Z')
    + result('toolu_a', [{ type: 'text', text: scheduled(610) }], '2026-11-09T00:00:01Z')), at('2026-11-09T00:00:01Z', 610));
});

test('a new schedule replaces the previous one', () => {
  assert.strictEqual(parse(
    use('toolu_a', { delaySeconds: 1200 }, '2026-11-08T04:22:55Z') + result('toolu_a', scheduled(1205), '2026-11-08T04:22:55.5Z')
    + use('toolu_b', { delaySeconds: 1200 }, '2026-11-08T04:28:11Z') + result('toolu_b', scheduled(1248), '2026-11-08T04:28:11.8Z')),
  at('2026-11-08T04:28:11.8Z', 1248));
});

test('firing clears it', () => {
  assert.strictEqual(parse(
    use('toolu_a', { delaySeconds: 1200 }, '2026-11-08T04:28:11Z') + result('toolu_a', scheduled(1248), '2026-11-08T04:28:11.8Z')
    + fire('2026-11-08T04:49:00.559Z')), null);
});

test('stop clears it', () => {
  assert.strictEqual(parse(
    use('toolu_a', { delaySeconds: 1200 }, '2026-11-08T04:28:11Z') + result('toolu_a', scheduled(1248), '2026-11-08T04:28:11.8Z')
    + use('toolu_b', { stop: true }, '2026-11-08T04:30:00Z') + result('toolu_b', 'Loop stopped.', '2026-11-08T04:30:00.4Z')), null);
});

test('a failed call keeps the previous schedule', () => {
  assert.strictEqual(parse(
    use('toolu_a', { delaySeconds: 1200 }, '2026-11-08T04:28:11Z') + result('toolu_a', scheduled(1248), '2026-11-08T04:28:11.8Z')
    + use('toolu_b', { delaySeconds: 99 }, '2026-11-08T04:30:00Z') + result('toolu_b', 'InputValidationError: prompt required', '2026-11-08T04:30:00.4Z', true)),
  at('2026-11-08T04:28:11.8Z', 1248));
});

test('use and result in different incremental reads', () => {
  const p = path.join(root, 'incremental.jsonl');
  fs.writeFileSync(p, use('toolu_a', { delaySeconds: 1200 }, '2026-11-09T00:12:46Z'));
  assert.strictEqual(parseTranscript(p, 'incremental', claudeDir).wakeupAt, null);
  fs.appendFileSync(p, result('toolu_a', scheduled(1214), '2026-11-09T00:12:46.5Z'));
  assert.strictEqual(parseTranscript(p, 'incremental', claudeDir).wakeupAt, at('2026-11-09T00:12:46.5Z', 1214));
  fs.appendFileSync(p, fire('2026-11-09T00:33:00Z'));
  assert.strictEqual(parseTranscript(p, 'incremental', claudeDir).wakeupAt, null);
});

test('no schedule', () => {
  assert.strictEqual(parse(L({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-11-09T00:00:00Z' })), null);
});

test('text: local wakeup time, empty when past or absent', () => {
  const now = new Date(2026, 10, 8, 21, 30, 0).getTime();
  const str = buildWakeupStr(new Date(2026, 10, 8, 22, 15, 0).getTime(), now);
  assert.match(str.replace(/\x1b\[[0-9;]*m/g, ''), /^⏰ 22:15$/);
  assert.strictEqual(buildWakeupStr(now - 1, now), '');
  assert.strictEqual(buildWakeupStr(null, now), '');
});
