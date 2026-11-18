'use strict';
// Prompt-cache expiry test suite. Run: node --test
// Covers: buildCacheStr reading CC's stdin `prompt_cache` (minute countdown rounded up),
// TTL-proportional colors on 1h and 5m, unknown TTL, and cold/expired/malformed payloads.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildCacheStr } = require('./display');
const { C } = require('./utils');

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
// Fixed instant: expires_at is relative to it, so the countdown is exact in any runner.
const NOW_MS = Date.UTC(2026, 10, 18, 15, 0, 0);
const at = secs => Math.ceil((NOW_MS + secs * 1000) / 1000);
const warm = (expiresAt, ttl) => ({ warm: true, caching_observed: true, ttl, expires_at: expiresAt });
const render = pc => {
  const realNow = Date.now;
  Date.now = () => NOW_MS;
  try { return buildCacheStr(pc); } finally { Date.now = realNow; }
};

// ── contador em minutos inteiros, arredondado para cima
for (const [name, secs, ttl, text] of [
  ['1h cheio', 3600, '1h', '60m'],
  ['1h com 50min', 50 * 60, '1h', '50m'],
  ['49min01s arredonda para 50m', 49 * 60 + 1, '1h', '50m'],
  ['5m cheio', 300, '5m', '5m'],
  ['1s mostra 1m', 1, '5m', '1m'],
]) {
  test(`contador: ${name}`, () => {
    assert.strictEqual(strip(render(warm(at(secs), ttl))), ` | cache ${text}`);
  });
}

// ── cor proporcional ao TTL: ok acima de 1/3, warn até 1/3, danger até 10%
for (const [name, secs, ttl, color] of [
  ['1h 21min ok', 21 * 60, '1h', C.ok],
  ['1h 20min warn', 20 * 60, '1h', C.warn],
  ['1h 7min warn', 7 * 60, '1h', C.warn],
  ['1h 6min danger', 6 * 60, '1h', C.danger],
  ['1h 10s danger', 10, '1h', C.danger],
  ['5m 101s ok', 101, '5m', C.ok],
  ['5m 100s warn', 100, '5m', C.warn],
  ['5m 31s warn', 31, '5m', C.warn],
  ['5m 30s danger', 30, '5m', C.danger],
]) {
  test(`cor: ${name}`, () => {
    assert.ok(render(warm(at(secs), ttl)).includes(`cache ${color}`));
  });
}

// ── TTL desconhecido: contador sem cor de status, nunca herda membro do protótipo
for (const [name, ttl] of [
  ['ausente', undefined], ['null', null], ['2h', '2h'], ['constructor', 'constructor'], ['__proto__', '__proto__'],
]) {
  test(`ttl ${name} usa soft`, () => {
    const s = render(warm(at(60), ttl));
    assert.ok(s.includes(`cache ${C.soft}1m`), JSON.stringify(s));
  });
}

// ── sem segmento: frio, expirado, ausente ou malformado nunca lança exceção
for (const [name, pc] of [
  ['warm false', { warm: false, ttl: '1h', expires_at: at(600) }],
  ['expirado como o CC manda (warm false, expires_at no passado)',
    { warm: false, caching_observed: true, ttl: '1h', expires_at: at(-60) }],
  ['warm "true" (não booleano)', { warm: 'true', ttl: '1h', expires_at: at(600) }],
  ['expires_at null', warm(null, '1h')],
  ['expires_at no passado', warm(at(-60), '1h')],
  ['expires_at igual a agora', warm(at(0), '1h')],
  ['expires_at string numérica', warm(String(at(600)), '1h')],
  ['expires_at NaN', warm(NaN, '1h')],
  ['expires_at Infinity', warm(Infinity, '1h')],
  ['prompt_cache undefined', undefined],
  ['prompt_cache null', null],
  ['prompt_cache string', 'x'],
  ['prompt_cache array', []],
]) {
  test(`sem segmento: ${name}`, () => {
    assert.strictEqual(render(pc), '');
  });
}

test('percentual de hit não volta', () => {
  assert.ok(!render(warm(at(600), '1h')).includes('%'));
});
