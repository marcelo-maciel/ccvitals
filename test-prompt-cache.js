'use strict';
// Prompt-cache expiry test suite. Run: node --test
// Covers: buildCacheStr reading CC's stdin `prompt_cache` (expiry + TTL label),
// cold/absent/malformed payloads, and the expiry color thresholds.
const { test } = require('node:test');
const assert = require('node:assert');
const { buildCacheStr } = require('./display');
const { C } = require('./utils');

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const nowSec = () => Math.floor(Date.now() / 1000);
// Expected clock derived from the same expires_at, so it holds in any runner timezone.
const clock = expiresAt => {
  const d = new Date(expiresAt * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
};
const warm = (expiresAt, ttl) => ({ warm: true, caching_observed: true, ttl, expires_at: expiresAt });

// ── cache quente: horário local de expires_at + rótulo do TTL
test('ttl 1h exibe expiração e rótulo', () => {
  const exp = nowSec() + 50 * 60;
  assert.strictEqual(strip(buildCacheStr(warm(exp, '1h'))), ` | cache exp ${clock(exp)} 1h`);
});

test('ttl 5m exibe rótulo 5m', () => {
  const exp = nowSec() + 4 * 60;
  assert.strictEqual(strip(buildCacheStr(warm(exp, '5m'))), ` | cache exp ${clock(exp)} 5m`);
});

// ── ttl desconhecido: horário sem rótulo
for (const [name, ttl] of [['ausente', undefined], ['null', null], ['2h', '2h']]) {
  test(`ttl ${name} exibe horário sem rótulo`, () => {
    const exp = nowSec() + 30 * 60;
    assert.strictEqual(strip(buildCacheStr(warm(exp, ttl))), ` | cache exp ${clock(exp)}`);
  });
}

// ── sem segmento: frio, vencido, ausente ou malformado nunca lança exceção
for (const [name, pc] of [
  ['warm false', { warm: false, ttl: '1h', expires_at: nowSec() + 600 }],
  ['warm "true" (não booleano)', { warm: 'true', ttl: '1h', expires_at: nowSec() + 600 }],
  ['expires_at null', warm(null, '1h')],
  ['expires_at no passado', warm(nowSec() - 60, '1h')],
  ['expires_at igual a agora', warm(nowSec(), '1h')],
  ['expires_at string numérica', warm(String(nowSec() + 600), '1h')],
  ['expires_at NaN', warm(NaN, '1h')],
  ['expires_at Infinity', warm(Infinity, '1h')],
  ['prompt_cache undefined', undefined],
  ['prompt_cache null', null],
  ['prompt_cache string', 'x'],
  ['prompt_cache array', []],
]) {
  test(`sem segmento: ${name}`, () => {
    assert.strictEqual(buildCacheStr(pc), '');
  });
}

// ── cores pelo tempo restante
for (const [name, secs, color] of [
  ['20s usa danger', 20, C.danger],
  ['90s usa warn', 90, C.warn],
  ['10min usa soft', 600, C.soft],
]) {
  test(`cor: ${name}`, () => {
    assert.ok(buildCacheStr(warm(nowSec() + secs, '5m')).includes(`${color}exp `));
  });
}

test('percentual de hit não volta', () => {
  assert.ok(!buildCacheStr(warm(nowSec() + 600, '1h')).includes('%'));
});
