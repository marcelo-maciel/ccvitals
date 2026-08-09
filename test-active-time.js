'use strict';
// Active-time tracker test suite. Run: node --test
// Covers: prompt-humano vs resultado de tool (a confusão que descartava o tempo de tool),
// teto de ociosidade no bootstrap, e o acúmulo ao vivo com prompt no meio do turno.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  bootstrapFromTranscript, isHumanPrompt, run, MAX_GAP_MS,
} = require('./hooks/active-time-tracker');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccvitals-active-'));
const T0 = Date.parse('2026-08-09T10:00:00.000Z');
const at = (secs) => new Date(T0 + secs * 1000).toISOString();

function writeTranscript(dir, rows) {
  const p = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
const humano = (secs, text) => ({ type: 'user', timestamp: at(secs), message: { content: text } });
const assistente = (secs) => ({ type: 'assistant', timestamp: at(secs), message: { content: [{ type: 'text', text: 'ok' }] } });
// Resultado de tool como o harness grava: type user, content em array com tool_result.
const resultadoTool = (secs) => ({
  type: 'user', timestamp: at(secs), toolUseResult: { stdout: '' },
  message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'saida' }] },
});

// ── classificação: só prompt do humano conta como prompt do humano
test('string comum é prompt humano', () => {
  assert.strictEqual(isHumanPrompt(humano(0, 'Onde paramos?')), true);
});
test('string de system-reminder não é prompt humano', () => {
  assert.strictEqual(isHumanPrompt(humano(0, '<system-reminder>x</system-reminder>')), false);
});
test('resultado de tool com toolUseResult não é prompt humano', () => {
  assert.strictEqual(isHumanPrompt(resultadoTool(0)), false);
});
test('resultado de tool sem toolUseResult, só pelo bloco tool_result, não é prompt humano', () => {
  const msg = { type: 'user', timestamp: at(0), message: { content: [{ type: 'tool_result', content: 'x' }] } };
  assert.strictEqual(isHumanPrompt(msg), false);
});
test('prompt humano com anexo (array de blocos text) segue sendo prompt humano', () => {
  const msg = { type: 'user', timestamp: at(0), message: { content: [{ type: 'text', text: 'olha isso' }] } };
  assert.strictEqual(isHumanPrompt(msg), true);
});
test('linha de subagente (isSidechain) não abre turno do humano', () => {
  assert.strictEqual(isHumanPrompt({ ...humano(0, 'faça'), isSidechain: true }), false);
});
test('assistant nunca é prompt humano', () => {
  assert.strictEqual(isHumanPrompt(assistente(0)), false);
});

// ── bootstrap: o tempo de execução das tools é trabalho e tem de aparecer
test('tempo entre assistant e resultado de tool conta como trabalho', () => {
  const dir = tmp();
  // prompt em 0; assistant em 10 (pensou 10s); tool devolve em 100 (rodou 90s);
  // assistant fecha em 130 (pensou 30s). Trabalho = 10 + 90 + 30 = 130s.
  const p = writeTranscript(dir, [humano(0, 'roda a suite'), assistente(10), resultadoTool(100), assistente(130)]);
  assert.strictEqual(bootstrapFromTranscript(p), 130000);
});

test('pausa do humano antes do próximo prompt não conta', () => {
  const dir = tmp();
  // turno 1 gasta 20s; humano volta 30 min depois e o turno 2 gasta 15s.
  const p = writeTranscript(dir, [
    humano(0, 'primeiro'), assistente(20),
    humano(20 + 1800, 'segundo'), assistente(20 + 1800 + 15),
  ]);
  assert.strictEqual(bootstrapFromTranscript(p), 35000);
});

test('intervalo acima do teto de ociosidade é cortado, mesmo dentro do turno', () => {
  const dir = tmp();
  const acimaDoTeto = MAX_GAP_MS / 1000 + 60;
  // sessão deixada aberta no meio do turno: o intervalo gigante não é trabalho.
  const p = writeTranscript(dir, [
    humano(0, 'analisa'), assistente(5),
    assistente(5 + acimaDoTeto), assistente(5 + acimaDoTeto + 7),
  ]);
  assert.strictEqual(bootstrapFromTranscript(p), 12000);
});

test('transcript ausente devolve 0 em vez de explodir', () => {
  assert.strictEqual(bootstrapFromTranscript(path.join(tmp(), 'nao-existe.jsonl')), 0);
});

test('linha corrompida e linha sem timestamp são puladas, não fatais', () => {
  const dir = tmp();
  const p = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(p, [
    JSON.stringify(humano(0, 'vai')),
    '{ isto nao e json',
    JSON.stringify({ type: 'assistant', message: { content: [] } }),
    JSON.stringify({ type: 'assistant', timestamp: 'data-invalida' }),
    JSON.stringify(assistente(8)),
  ].join('\n') + '\n');
  assert.strictEqual(bootstrapFromTranscript(p), 8000);
});

test('eventos fora de ordem no arquivo são ordenados antes de somar', () => {
  const dir = tmp();
  const p = writeTranscript(dir, [assistente(9), humano(0, 'oi'), assistente(3)]);
  assert.strictEqual(bootstrapFromTranscript(p), 9000);
});

// ── caminho ao vivo: UserPromptSubmit / Stop
function comCache(estado) {
  const claudeDir = tmp();
  const transcriptPath = path.join(claudeDir, 'sess.jsonl');
  fs.writeFileSync(transcriptPath, '');
  const cache = path.join(claudeDir, 'cache', 'active-time-sess.json');
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ bootstrapped: true, ...estado }));
  return { claudeDir, transcriptPath, cache, ler: () => JSON.parse(fs.readFileSync(cache, 'utf8')) };
}

test('Stop soma o trecho aberto e zera o turnStart', () => {
  const c = comCache({ totalMs: 1000, turnStart: Date.now() - 2000 });
  process.env.CLAUDE_CONFIG_DIR = c.claudeDir;
  run({ transcript_path: c.transcriptPath, hook_event_name: 'Stop' });
  const s = c.ler();
  assert.ok(s.totalMs >= 2900 && s.totalMs <= 3500, `totalMs=${s.totalMs}`);
  assert.strictEqual(s.turnStart, 0);
});

test('prompt no meio do turno fecha o trecho aberto em vez de descartá-lo', () => {
  const c = comCache({ totalMs: 0, turnStart: Date.now() - 3000 });
  process.env.CLAUDE_CONFIG_DIR = c.claudeDir;
  run({ transcript_path: c.transcriptPath, hook_event_name: 'UserPromptSubmit' });
  const s = c.ler();
  assert.ok(s.totalMs >= 2900, `os 3s do turno em curso foram perdidos: totalMs=${s.totalMs}`);
  assert.ok(s.turnStart > 0, 'o turno novo tem de ficar aberto');
});

test('primeiro UserPromptSubmit da sessão não inventa tempo', () => {
  const c = comCache({ totalMs: 0, turnStart: 0 });
  process.env.CLAUDE_CONFIG_DIR = c.claudeDir;
  run({ transcript_path: c.transcriptPath, hook_event_name: 'UserPromptSubmit' });
  assert.strictEqual(c.ler().totalMs, 0);
});
