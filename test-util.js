'use strict';
// Util test suite. Run: node --test
// Covers: secret redaction (redact), version comparison (isNewer).
const { test } = require('node:test');
const assert = require('node:assert');
const { redact } = require('./utils');
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

// ── isNewer(): compare dotted numeric, fallback em segmento não-numérico
test('isnewer-patch', () => assert.strictEqual(isNewer('2.1.113', '2.1.112'), true));
test('isnewer-older', () => assert.strictEqual(isNewer('2.1.112', '2.1.113'), false));
test('isnewer-minor', () => assert.strictEqual(isNewer('2.2.0', '2.1.99'), true));
test('isnewer-equal', () => assert.strictEqual(isNewer('1.0.0', '1.0.0'), false));
test('isnewer-shorter', () => assert.strictEqual(isNewer('2.0', '2.0.1'), false));
