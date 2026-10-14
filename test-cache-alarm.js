'use strict';
// Prompt-cache alarm test suite. Run: node --test
// Covers: isCacheAlarmDue (window bounds, TTL guard, malformed payload/config),
// claimCacheAlarm (once per window, cross-process race, cleanup, path safety)
// and playSound's no-op paths. The sound itself is exercised live, not in CI.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { isCacheAlarmDue, claimCacheAlarm, playSound } = require('./io');

const MIN = 60000;
const EXP = 1792000000; // epoch seconds
const EXP_MS = EXP * 1000;
const cfg = { leadMinutes: 20, sound: 'C:/Windows/Media/Alarm01.wav' };
const pc = (over) => ({ warm: true, caching_observed: true, ttl: '1h', expires_at: EXP, ...over });
const tmpDirs = [];
const tmpClaudeDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ccvitals-alarm-'));
  tmpDirs.push(d);
  return d;
};
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const SID = 'e314deb9-f031-4436-a3de-a9b34ec14234';

// ── janela: [expires_at - lead, expires_at)
test('dentro da janela toca', () => {
  assert.strictEqual(isCacheAlarmDue(pc(), cfg, EXP_MS - 19 * MIN), true);
});
test('antes da janela não toca', () => {
  assert.strictEqual(isCacheAlarmDue(pc(), cfg, EXP_MS - 21 * MIN), false);
});
test('limite inferior exato toca', () => {
  assert.strictEqual(isCacheAlarmDue(pc(), cfg, EXP_MS - 20 * MIN), true);
});
test('limite superior exato não toca', () => {
  assert.strictEqual(isCacheAlarmDue(pc(), cfg, EXP_MS), false);
});
test('já expirado não toca', () => {
  assert.strictEqual(isCacheAlarmDue(pc(), cfg, EXP_MS + MIN), false);
});

// ── trava de janela do TTL: antecedência maior que o TTL tocaria após cada request
test('TTL 5m com antecedência 20 nunca toca', () => {
  for (const before of [4, 2, 1, 0.5]) {
    assert.strictEqual(isCacheAlarmDue(pc({ ttl: '5m' }), cfg, EXP_MS - before * MIN), false);
  }
});
test('TTL 5m com antecedência 2 toca a 1 minuto do fim', () => {
  assert.strictEqual(isCacheAlarmDue(pc({ ttl: '5m' }), { ...cfg, leadMinutes: 2 }, EXP_MS - MIN), true);
});
test('antecedência igual ao TTL não toca', () => {
  assert.strictEqual(isCacheAlarmDue(pc(), { ...cfg, leadMinutes: 60 }, EXP_MS - 30 * MIN), false);
});

// ── payload malformado
for (const [name, p] of [
  ['warm false', pc({ warm: false })],
  ['warm "true"', pc({ warm: 'true' })],
  ['expires_at null', pc({ expires_at: null })],
  ['expires_at string', pc({ expires_at: String(EXP) })],
  ['expires_at NaN', pc({ expires_at: NaN })],
  ['expires_at Infinity', pc({ expires_at: Infinity })],
  ['ttl ausente', pc({ ttl: undefined })],
  ['ttl 2h', pc({ ttl: '2h' })],
  ['prompt_cache null', null],
  ['prompt_cache undefined', undefined],
  ['prompt_cache string', 'x'],
  ['prompt_cache array', []],
]) {
  test(`payload inválido não toca: ${name}`, () => {
    assert.strictEqual(isCacheAlarmDue(p, cfg, EXP_MS - 10 * MIN), false);
  });
}

// ── config inválida = alarme desligado
for (const [name, c] of [
  ['ausente', undefined],
  ['null', null],
  ['leadMinutes 0', { ...cfg, leadMinutes: 0 }],
  ['leadMinutes negativo', { ...cfg, leadMinutes: -5 }],
  ['leadMinutes string', { ...cfg, leadMinutes: '20' }],
  ['leadMinutes NaN', { ...cfg, leadMinutes: NaN }],
  ['sound ausente', { leadMinutes: 20 }],
  ['sound numérico', { leadMinutes: 20, sound: 42 }],
]) {
  test(`config inválida não toca: ${name}`, () => {
    assert.strictEqual(isCacheAlarmDue(pc(), c, EXP_MS - 10 * MIN), false);
  });
}

// ── claimCacheAlarm: uma vez por janela
test('primeira trava vence, segunda perde', () => {
  const dir = tmpClaudeDir();
  assert.strictEqual(claimCacheAlarm(SID, EXP, dir), true);
  assert.ok(fs.existsSync(path.join(dir, 'cache', `cache-alarm-${SID}-${EXP}.json`)));
  assert.strictEqual(claimCacheAlarm(SID, EXP, dir), false);
});

test('janela nova vence e apaga a anterior da mesma sessão, sem tocar outra sessão', () => {
  const dir = tmpClaudeDir();
  const other = 'aaaaaaaa-0000-0000-0000-000000000000';
  assert.strictEqual(claimCacheAlarm(SID, EXP, dir), true);
  assert.strictEqual(claimCacheAlarm(other, EXP, dir), true);
  assert.strictEqual(claimCacheAlarm(SID, EXP + 3600, dir), true);
  const files = fs.readdirSync(path.join(dir, 'cache')).sort();
  assert.deepStrictEqual(files, [`cache-alarm-${other}-${EXP}.json`, `cache-alarm-${SID}-${EXP + 3600}.json`].sort());
});

test('render atrasado com janela antiga não toca nem apaga a trava nova', () => {
  const dir = tmpClaudeDir();
  assert.strictEqual(claimCacheAlarm(SID, EXP + 3600, dir), true);
  assert.strictEqual(claimCacheAlarm(SID, EXP, dir), false);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'cache')), [`cache-alarm-${SID}-${EXP + 3600}.json`]);
  assert.strictEqual(claimCacheAlarm(SID, EXP + 3600, dir), false);
});

test('pasta cache ausente é criada', () => {
  const dir = tmpClaudeDir();
  assert.ok(!fs.existsSync(path.join(dir, 'cache')));
  assert.strictEqual(claimCacheAlarm(SID, EXP, dir), true);
});

for (const bad of ['../x', '..\\x', 'a/b', '', 'x.json', null, 42]) {
  test(`sessionId inválido é rejeitado: ${JSON.stringify(bad)}`, () => {
    const dir = tmpClaudeDir();
    assert.strictEqual(claimCacheAlarm(bad, EXP, dir), false);
    assert.ok(!fs.existsSync(path.join(dir, 'cache')) || fs.readdirSync(path.join(dir, 'cache')).length === 0);
    assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f !== 'cache'), []);
  });
}

test('20 processos concorrentes: exatamente uma trava vence', async () => {
  const dir = tmpClaudeDir();
  const io = JSON.stringify(path.join(__dirname, 'io.js'));
  const code = `process.stdout.write(String(require(${io}).claimCacheAlarm(${JSON.stringify(SID)}, ${EXP}, ${JSON.stringify(dir)})))`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code]);
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', status => (status === 0 ? resolve(out) : reject(new Error(`exit ${status}`))));
  });
  const results = await Promise.all(Array.from({ length: 20 }, run));
  assert.strictEqual(results.filter(r => r === 'true').length, 1, results.join(','));
  assert.strictEqual(results.filter(r => r === 'false').length, 19, results.join(','));
});

// ── playSound: caminhos que não disparam nada
test('arquivo inexistente não toca', () => {
  assert.strictEqual(playSound(path.join(os.tmpdir(), 'nao-existe-ccvitals.wav')), false);
});
test('fora do Windows não toca', { skip: process.platform === 'win32' }, () => {
  assert.strictEqual(playSound(__filename), false);
});
