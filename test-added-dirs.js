'use strict';
// Added-directory chip test suite. Run: node --test
// Covers: buildAddedDirsStr shape/overflow/garbage input, and buildLine1 integration
// (chip present only when /add-dir contributed directories).
const { test } = require('node:test');
const assert = require('node:assert');
const { buildAddedDirsStr, buildLine1 } = require('./display');

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── ausência: qualquer payload sem diretórios adicionados não renderiza chip
for (const [name, input] of [
  ['undefined', undefined],
  ['null', null],
  ['array vazio', []],
  ['string em vez de array', 'C:/cfpr'],
  ['objeto', { 0: 'C:/cfpr' }],
  ['número', 2],
  ['só entradas não-string', [null, 42, {}, []]],
  ['só whitespace', ['   ', '\t']],
  ['separador puro', ['/', '\\\\']],
]) {
  test(`sem chip: ${name}`, () => {
    assert.strictEqual(buildAddedDirsStr(input), '');
  });
}

// ── presença: contador + basenames
test('um diretório', () => {
  assert.match(strip(buildAddedDirsStr(['C:/cfpr'])), /\+1 cfpr$/);
});

test('dois diretórios em ordem', () => {
  assert.match(strip(buildAddedDirsStr(['C:/cfpr', 'C:/influx/zapcomando'])), /\+2 cfpr,zapcomando$/);
});

test('separadores win32 e posix no mesmo payload', () => {
  const out = strip(buildAddedDirsStr(['C:\\influx\\renov-home', '/c/tmp/aviario']));
  assert.match(out, /\+2 renov-home,aviario$/);
});

test('trailing separator não vira nome vazio', () => {
  assert.match(strip(buildAddedDirsStr(['C:/cfpr/', 'C:\\zap\\\\'])), /\+2 cfpr,zap$/);
});

test('raiz de volume cai no próprio path', () => {
  assert.match(strip(buildAddedDirsStr(['C:/'])), /\+1 C:$/);
});

test('entradas inválidas são descartadas, válidas sobrevivem', () => {
  assert.match(strip(buildAddedDirsStr([null, 'C:/cfpr', 42, '  ', 'C:/zap'])), /\+2 cfpr,zap$/);
});

// ── overflow: contador conta tudo, lista mostra 3 + resto agregado
test('acima de 3 diretórios agrega o resto', () => {
  const out = strip(buildAddedDirsStr(['C:/a', 'C:/b', 'C:/c', 'C:/d', 'C:/e']));
  assert.match(out, /\+5 a,b,c,\+2$/);
});

test('nomes longos truncam em 40 chars', () => {
  const long = ['C:/' + 'x'.repeat(30), 'C:/' + 'y'.repeat(30), 'C:/' + 'z'.repeat(30)];
  const out = strip(buildAddedDirsStr(long));
  const list = out.split('+3 ')[1];
  assert.ok(list.length <= 40, `lista tem ${list.length} chars: ${list}`);
});

// ── integração: linha 1 ganha o chip só quando há diretórios adicionados
const line1Base = {
  updateStr: '', errStr: '', model: 'Opus', effortStr: '', ccVerStr: '', fastStr: '',
  accountStr: '', dir: 'C:/influx/renov-home', cwd: 'C:/influx/renov-home',
  branch: 'develop', gitStatus: '', taskStr: '',
};

test('buildLine1 sem added_dirs não muda a linha', () => {
  const withUndef = strip(buildLine1({ ...line1Base, addedDirs: undefined }));
  const withEmpty = strip(buildLine1({ ...line1Base, addedDirs: [] }));
  assert.strictEqual(withUndef, withEmpty);
  assert.ok(!withUndef.includes('+0'), withUndef);
});

test('buildLine1 com added_dirs insere chip antes do branch', () => {
  const out = strip(buildLine1({ ...line1Base, addedDirs: ['C:/cfpr', 'C:/zapcomando'] }));
  assert.match(out, /\+2 cfpr,zapcomando/);
  assert.ok(out.indexOf('cfpr') < out.indexOf('develop'), out);
});
