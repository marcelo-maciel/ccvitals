'use strict';
// Cor do rate limit pelo ritmo: a tolerância ao adiantamento (delta = %usado − %tempo)
// encolhe com o tempo que falta na janela. bounds = [warn, danger] em % do tempo restante.
const { test } = require('node:test');
const assert = require('node:assert');
const { C, colorByPace } = require('./utils.js');
const { buildRateLimitsStr } = require('./display.js');

const BOUNDS = [10, 20];
const TH = { rateLimit: BOUNDS };
const MIN = 60_000, H = 60 * MIN;
const FIVE_H = 5 * H, SEVEN_D = 7 * 24 * H;

test('colorByPace: tolerância proporcional ao tempo restante', async (t) => {
  const cases = [
    // [nome, delta, elapsedPct, esperado]
    ['início, +7 cabe em 10% de 95', 7, 5, C.ok],
    ['metade, delta igual ao limite warn fica ok', 5, 50, C.ok],
    ['metade, um acima do limite warn', 6, 50, C.warn],
    ['metade, delta igual ao limite danger fica warn', 10, 50, C.warn],
    ['metade, um acima do limite danger', 11, 50, C.danger],
    ['atrás do ritmo é sempre ok', -30, 90, C.ok],
    ['fim da janela, delta zero é ok', 0, 100, C.ok],
    ['fim da janela, qualquer adiantamento é danger', 1, 100, C.danger],
  ];
  for (const [name, delta, elapsed, want] of cases) {
    await t.test(name, () => assert.strictEqual(colorByPace(delta, elapsed, BOUNDS), want));
  }
});

// resets_at em segundos, a partir do tempo que falta para o reset.
const resetIn = (ms) => Math.floor((Date.now() + ms) / 1000);
const chip5h = (used, elapsedMs) => ({ five_hour: { used_percentage: used, resets_at: resetIn(FIVE_H - elapsedMs) } });
const chip7d = (used, elapsedMs) => ({ seven_day: { used_percentage: used, resets_at: resetIn(SEVEN_D - elapsedMs) } });

test('buildRateLimitsStr: uso e delta com a mesma cor de ritmo', async (t) => {
  const cases = [
    // [nome, rateLimits, texto esperado do uso, texto esperado do delta, cor]
    ['5h, 15 min, 12%', chip5h(12, 15 * MIN), '5h:12%', '(+7%)', C.ok],
    ['5h, 1 h, 45%', chip5h(45, H), '5h:45%', '(+25%)', C.danger],
    ['5h, 2h30, 58%', chip5h(58, 150 * MIN), '5h:58%', '(+8%)', C.warn],
    ['5h, faltam 30 min, 85%', chip5h(85, 270 * MIN), '5h:85%', '(-5%)', C.ok],
    ['5h, falta 1 h, 83%', chip5h(83, 240 * MIN), '5h:83%', '(+3%)', C.warn],
    ['7d, 48 h, 45%', chip7d(45, 48 * H), '7d:45%', '(+16%)', C.danger],
    ['7d, 96 h, 75%', chip7d(75, 96 * H), '7d:75%', '(+18%)', C.danger],
    ['7d, 144 h, 60%', chip7d(60, 144 * H), '7d:60%', '(-26%)', C.ok],
  ];
  for (const [name, rl, usedTxt, deltaTxt, color] of cases) {
    await t.test(name, () => {
      const s = buildRateLimitsStr(rl, TH, null, null);
      assert.ok(s.includes(`${color}${usedTxt}${C.reset}`), `uso: ${JSON.stringify(s)}`);
      assert.ok(s.includes(`${color}${deltaTxt}${C.reset}`), `delta: ${JSON.stringify(s)}`);
    });
  }
});

test('buildRateLimitsStr: sem resets_at não há ritmo, uso fica neutro e sem delta', () => {
  const s = buildRateLimitsStr({ five_hour: { used_percentage: 40, resets_at: null } }, TH, null, null);
  assert.ok(s.includes(`${C.soft}5h:40%${C.reset}`), JSON.stringify(s));
  assert.ok(!s.includes('%)'), JSON.stringify(s));
});

test('buildRateLimitsStr: janela vencida continua 5h:?', () => {
  const s = buildRateLimitsStr({ five_hour: { used_percentage: 40, resets_at: resetIn(-MIN) } }, TH, null, null);
  assert.ok(s.includes('5h:?'), JSON.stringify(s));
});

test('buildRateLimitsStr: 100% mantém o 💸', () => {
  const s = buildRateLimitsStr(chip5h(100, 270 * MIN), TH, null, null);
  assert.ok(s.includes(`${C.danger}5h:100% \u{1F4B8}${C.reset}`), JSON.stringify(s));
});

test('buildRateLimitsStr: uso nulo não renderiza nada', () => {
  assert.strictEqual(buildRateLimitsStr({ five_hour: { used_percentage: null } }, TH, null, null), '');
});

test('paleta: status só em ok/warn/danger 256 cores, sem ANSI básico', () => {
  for (const k of ['green', 'yellow', 'red']) assert.strictEqual(C[k], undefined, `C.${k} ainda existe`);
  for (const k of ['ok', 'warn', 'danger']) assert.match(C[k], /^\x1b\[38;5;\d+m$/, `C.${k}`);
});
