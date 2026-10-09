'use strict';
// Testa a agregação cross-sessão do rate-limit (io.js trackRateLimitSnapshot):
// MAX na janela de 2h, fallback pro mais fresco, isolamento por resets_at (virada de semana),
// e imunidade a reset administrativo (pct cai, resets_at intacto).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { trackRateLimitSnapshot } = require('./io.js');

const NOW = Date.now();
const S = 1000, H = 3600 * S;
const nowSec = Math.floor(NOW / 1000);
const R = nowSec + 4 * 86400;      // janela vigente: reset em 4 dias
const R_NEXT = R + 7 * 86400;      // próxima janela (virada)
const R_PAST = nowSec - 3600;      // janela já expirada
const ACC = 'acct-A:org-1';        // conta logada nesta sessão

// Cria um claudeDir isolado com um cache pré-semeado e devolve o path.
function seed(sessions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-agg-'));
  fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cache', 'rate-limit-snapshots.json'),
    JSON.stringify({ sessions })
  );
  return dir;
}
const snap = (ageMs, sevenPct, sevenReset, fivePct, fiveReset) => ({
  observed_at: NOW - ageMs,
  account: ACC,
  five_hour: fivePct == null ? null : { used_percentage: fivePct, resets_at: fiveReset },
  seven_day: sevenPct == null ? null : { used_percentage: sevenPct, resets_at: sevenReset },
});
const mine = (sevenPct, sevenReset, fivePct, fiveReset) => ({
  five_hour: fivePct == null ? null : { used_percentage: fivePct, resets_at: fiveReset },
  seven_day: sevenPct == null ? null : { used_percentage: sevenPct, resets_at: sevenReset },
});

test('reset administrativo: pico pré-reset (>2h) sai fora, mostra valor atual', () => {
  const dir = seed({
    old1: snap(9 * H, 51, R, 40, nowSec + 3600),  // pré-reset, 9h atrás
    old2: snap(8 * H, 46, R, 30, nowSec + 3600),
  });
  const out = trackRateLimitSnapshot(mine(7, R, 22, nowSec + 3600), 'sess-fresh', ACC, dir);
  assert.strictEqual(out.seven_day.used_percentage, 7, 'deve ignorar 51/46 velhos e mostrar 7');
  assert.strictEqual(out.seven_day.resets_at, R);
});

test('sessões paralelas: MAX na janela de 2h (convergência preservada)', () => {
  const dir = seed({
    a: snap(30 * 60 * S, 10, R),   // 30min
    b: snap(10 * 60 * S, 30, R),   // 10min — real account-wide
    idle: snap(5 * 60 * S, 5, R),  // ociosa carregando pct stale-low, recente
  });
  const out = trackRateLimitSnapshot(mine(22, R), 'sess-me', ACC, dir);
  assert.strictEqual(out.seven_day.used_percentage, 30, 'MAX das recentes, stale-low não derruba');
});

test('fallback: nada na janela de 2h → snapshot mais fresco da janela vigente', () => {
  const dir = seed({
    stale3h: snap(3 * H, 40, R),  // única na janela vigente R, mas >2h
    older:   snap(5 * H, 38, R),
  });
  // mine reporta janela JÁ EXPIRADA → não entra em bestReset nem casa com R
  const out = trackRateLimitSnapshot(mine(2, R_PAST), 'sess-me', ACC, dir);
  assert.strictEqual(out.seven_day.resets_at, R);
  assert.strictEqual(out.seven_day.used_percentage, 40, 'fallback pega o mais fresco (40, 3h) não o de 5h');
});

test('virada de semana A→B: janela nova vence, janela velha não vaza', () => {
  const dir = seed({
    oldWin: snap(1 * H, 55, R),  // janela A quase fechando, acumulado alto, recente
  });
  // mine já rolou pra janela B (resets_at maior), pct baixo
  const out = trackRateLimitSnapshot(mine(3, R_NEXT), 'sess-rolled', ACC, dir);
  assert.strictEqual(out.seven_day.resets_at, R_NEXT, 'seleciona a janela nova');
  assert.strictEqual(out.seven_day.used_percentage, 3, '55 da janela velha (outro resets_at) não vaza');
});

test('cache vazio: usa a própria leitura da sessão', () => {
  const dir = seed({});
  const out = trackRateLimitSnapshot(mine(9, R, 12, nowSec + 3600), 'sess-solo', ACC, dir);
  assert.strictEqual(out.seven_day.used_percentage, 9);
  assert.strictEqual(out.seven_day.resets_at, R);
});

test('nenhuma janela válida (todas expiradas): retorna null por janela', () => {
  const dir = seed({ dead: snap(1 * H, 80, R_PAST) });
  const out = trackRateLimitSnapshot(mine(80, R_PAST), 'sess-me', ACC, dir);
  assert.strictEqual(out.seven_day, null, 'resets_at no passado → sem janela vigente');
});

test('five_hour agregado pelo mesmo caminho (janela independente)', () => {
  const f = nowSec + 2 * 3600;
  const dir = seed({
    peakOld: snap(9 * H, 3, R, 66, f),   // pico 5h velho (>2h) some
    recent:  snap(10 * 60 * S, 3, R, 20, f),
  });
  const out = trackRateLimitSnapshot(mine(3, R, 23, f), 'sess-me', ACC, dir);
  assert.strictEqual(out.five_hour.used_percentage, 23, 'MAX-2h também vale pra five_hour, 66 velho fora');
});

test('troca de conta: snapshot de outra conta (reset mais tarde, pct maior) não vaza', () => {
  const dir = seed({
    otherAcc: { ...snap(1 * H, 89, R_NEXT), account: 'acct-B:org-1' },
    otherOrg: { ...snap(10 * 60 * S, 70, R), account: 'acct-A:org-2' },
  });
  const out = trackRateLimitSnapshot(mine(11, R), 'sess-new', ACC, dir);
  assert.strictEqual(out.seven_day.resets_at, R, 'janela da conta logada, não a R_NEXT da outra');
  assert.strictEqual(out.seven_day.used_percentage, 11, '89/70 de outra conta ou org não entram no MAX');
});

test('snapshot legado sem account não vaza para conta logada', () => {
  const legacy = snap(10 * 60 * S, 95, R);
  delete legacy.account;
  const dir = seed({ legacy });
  const out = trackRateLimitSnapshot(mine(4, R), 'sess-me', ACC, dir);
  assert.strictEqual(out.seven_day.used_percentage, 4);
});

test('sem conta OAuth (quotaKey null): agrega entre sessões sem conta', () => {
  const legacy = snap(10 * 60 * S, 30, R);
  delete legacy.account;
  const dir = seed({ legacy, acc: snap(5 * 60 * S, 80, R) });
  const out = trackRateLimitSnapshot(mine(12, R), 'sess-me', null, dir);
  assert.strictEqual(out.seven_day.used_percentage, 30, 'MAX entre legado e própria; 80 da conta ACC fora');
});
