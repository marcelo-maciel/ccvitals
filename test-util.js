'use strict';
// Util test suite. Run: node --test
// Covers: secret redaction (redact), rolling-cost dedup (trackMonthlyCost),
// version comparison (isNewer).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { redact } = require('./utils');
const { trackMonthlyCost } = require('./io');
const { isNewer } = require('./update');

// helper: redaction apaga o segredo e marca REDACTED
function redactCase(name, input, secret) {
  test(name, () => {
    const out = redact(input);
    assert.ok(out.includes('REDACTED') && !out.includes(secret), out);
  });
}

// ── redact(): cada padrão sensível some, texto inócuo passa intacto
redactCase('redact-anthropic', `token sk-ant-${'a'.repeat(40)} end`, 'a'.repeat(40));
redactCase('redact-github-pat', `ghp_${'b'.repeat(36)}`, 'b'.repeat(36));
redactCase('redact-aws', 'AKIA' + 'A'.repeat(16), 'AKIA' + 'A'.repeat(16));
redactCase('redact-postgres', 'postgres://user:s3cr3tpw@host:5432/db', 's3cr3tpw');
redactCase('redact-bearer', `Authorization: Bearer ${'c'.repeat(30)}`, 'c'.repeat(30));
redactCase('redact-jwt', `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`, 'b'.repeat(12));
test('redact-passthrough', () => {
  assert.strictEqual(redact('mensagem normal sem segredo'), 'mensagem normal sem segredo');
});

// ── trackMonthlyCost(): dedup por custo+janela temporal, zeros ignorados, legacy somado
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-util-test-'));
const claudeDir = path.join(root, 'claude');
fs.mkdirSync(path.join(claudeDir, 'cache'), { recursive: true });
const seed = (sessions) => fs.writeFileSync(
  path.join(claudeDir, 'cache', 'cost-monthly.json'), JSON.stringify({ sessions }));

after(() => fs.rmSync(root, { recursive: true, force: true }));

// aggWindowDays=0 => sem eviction por data (datas do teste são arbitrárias).
test('cost-dedup-window', () => {
  seed({
    s1: { baseCost: 0, currentCost: 10, date: 1000 },
    s2: { baseCost: 0, currentCost: 10, date: 5000 },      // dup de s1 (dentro de 5min) -> ignorado
    s3: { baseCost: 0, currentCost: 10, date: 1000000 },   // mesmo custo mas longe -> contado
    s4: { baseCost: 0, currentCost: 20, date: 1000 },      // custo distinto -> contado
    s5: { baseCost: 0, currentCost: 0, date: 1000 },       // zero -> ignorado
    s6: { cost: 7, date: 1000 },                           // legacy -> contado
  });
  // Esperado: 10(s1) + 10(s3) + 20(s4) + 7(s6) = 47
  assert.strictEqual(trackMonthlyCost(null, null, claudeDir, 0).toFixed(2), '47.00');
});

// Dois custos idênticos longe no tempo NÃO colapsam (sessões triviais distintas).
test('cost-far-apart-kept', () => {
  seed({
    a: { baseCost: 0, currentCost: 3.5, date: 1000 },
    b: { baseCost: 0, currentCost: 3.5, date: 1000 + 6 * 60 * 1000 }, // +6min > janela
  });
  assert.strictEqual(trackMonthlyCost(null, null, claudeDir, 0).toFixed(2), '7.00');
});

// Custos idênticos dentro da janela colapsam.
test('cost-near-collapsed', () => {
  seed({
    a: { baseCost: 0, currentCost: 3.5, date: 1000 },
    b: { baseCost: 0, currentCost: 3.5, date: 1000 + 60 * 1000 }, // +1min < janela
  });
  assert.strictEqual(trackMonthlyCost(null, null, claudeDir, 0).toFixed(2), '3.50');
});

// ── isNewer(): compare dotted numeric, fallback em segmento não-numérico
test('isnewer-patch', () => assert.strictEqual(isNewer('2.1.113', '2.1.112'), true));
test('isnewer-older', () => assert.strictEqual(isNewer('2.1.112', '2.1.113'), false));
test('isnewer-minor', () => assert.strictEqual(isNewer('2.2.0', '2.1.99'), true));
test('isnewer-equal', () => assert.strictEqual(isNewer('1.0.0', '1.0.0'), false));
test('isnewer-shorter', () => assert.strictEqual(isNewer('2.0', '2.0.1'), false));
