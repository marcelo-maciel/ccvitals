'use strict';
// Util test suite. Run: node test-util.js
// Covers: secret redaction (redact), rolling-cost dedup (trackMonthlyCost),
// version comparison (isNewer).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { redact } = require('./utils');
const { trackMonthlyCost } = require('./io');
const { isNewer } = require('./update');

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log(`PASS ${name}: '${got}'`); }
  else { fail++; console.log(`FAIL ${name}: got '${got}', want '${want}'`); }
}
function checkRedacted(name, input, secret) {
  const out = redact(input);
  const ok = out.includes('REDACTED') && !out.includes(secret);
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}: got '${out}'`); }
}

// ── redact(): cada padrão sensível some, texto inócuo passa intacto
checkRedacted('redact-anthropic', `token sk-ant-${'a'.repeat(40)} end`, 'a'.repeat(40));
checkRedacted('redact-github-pat', `ghp_${'b'.repeat(36)}`, 'b'.repeat(36));
checkRedacted('redact-aws', 'AKIA' + 'A'.repeat(16), 'AKIA' + 'A'.repeat(16));
checkRedacted('redact-postgres', 'postgres://user:s3cr3tpw@host:5432/db', 's3cr3tpw');
checkRedacted('redact-bearer', `Authorization: Bearer ${'c'.repeat(30)}`, 'c'.repeat(30));
checkRedacted('redact-jwt', `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`, 'b'.repeat(12));
check('redact-passthrough', redact('mensagem normal sem segredo'), 'mensagem normal sem segredo');

// ── trackMonthlyCost(): dedup por custo+janela temporal, zeros ignorados, legacy somado
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-util-test-'));
const claudeDir = path.join(root, 'claude');
fs.mkdirSync(path.join(claudeDir, 'cache'), { recursive: true });
const seed = (sessions) => fs.writeFileSync(
  path.join(claudeDir, 'cache', 'cost-monthly.json'), JSON.stringify({ sessions }));

// aggWindowDays=0 => sem eviction por data (datas do teste são arbitrárias).
seed({
  s1: { baseCost: 0, currentCost: 10, date: 1000 },
  s2: { baseCost: 0, currentCost: 10, date: 5000 },      // dup de s1 (dentro de 5min) -> ignorado
  s3: { baseCost: 0, currentCost: 10, date: 1000000 },   // mesmo custo mas longe -> contado
  s4: { baseCost: 0, currentCost: 20, date: 1000 },      // custo distinto -> contado
  s5: { baseCost: 0, currentCost: 0, date: 1000 },       // zero -> ignorado
  s6: { cost: 7, date: 1000 },                           // legacy -> contado
});
// Esperado: 10(s1) + 10(s3) + 20(s4) + 7(s6) = 47
check('cost-dedup-window', trackMonthlyCost(null, null, claudeDir, 0).toFixed(2), '47.00');

// Dois custos idênticos longe no tempo NÃO colapsam (sessões triviais distintas).
seed({
  a: { baseCost: 0, currentCost: 3.5, date: 1000 },
  b: { baseCost: 0, currentCost: 3.5, date: 1000 + 6 * 60 * 1000 }, // +6min > janela
});
check('cost-far-apart-kept', trackMonthlyCost(null, null, claudeDir, 0).toFixed(2), '7.00');

// Custos idênticos dentro da janela colapsam.
seed({
  a: { baseCost: 0, currentCost: 3.5, date: 1000 },
  b: { baseCost: 0, currentCost: 3.5, date: 1000 + 60 * 1000 }, // +1min < janela
});
check('cost-near-collapsed', trackMonthlyCost(null, null, claudeDir, 0).toFixed(2), '3.50');

fs.rmSync(root, { recursive: true, force: true });

// ── isNewer(): compare dotted numeric, fallback em segmento não-numérico
check('isnewer-patch', String(isNewer('2.1.113', '2.1.112')), 'true');
check('isnewer-older', String(isNewer('2.1.112', '2.1.113')), 'false');
check('isnewer-minor', String(isNewer('2.2.0', '2.1.99')), 'true');
check('isnewer-equal', String(isNewer('1.0.0', '1.0.0')), 'false');
check('isnewer-shorter', String(isNewer('2.0', '2.0.1')), 'false');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
