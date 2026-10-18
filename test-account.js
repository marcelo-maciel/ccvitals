'use strict';
// Account badge suite. Run: node --test
// Covers: STATUSLINE_ACCOUNT override (sessions on CLAUDE_CODE_OAUTH_TOKEN, which Claude Code
// strips from the statusline env, so the /login identity in ~/.claude.json is the wrong account).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// readAccount reads env and CLAUDE_CONFIG_DIR at require time: run each case in a fresh process.
function readWith(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { displayName: 'Login User', accountUuid: 'acct-A', organizationUuid: 'org-team' },
  }));
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { subscriptionType: 'team' } }));
  const code = `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(__dirname, 'account.js'))}).readAccount()))`;
  const r = spawnSync(process.execPath, ['-e', code], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, STATUSLINE_ACCOUNT: '', ...env },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('sem STATUSLINE_ACCOUNT: identidade do /login', () => {
  const a = readWith({});
  assert.strictEqual(a.displayName, 'Login User');
  assert.strictEqual(a.subscriptionType, 'team');
  assert.strictEqual(a.quotaKey, 'acct-A:org-team');
});

test('STATUSLINE_ACCOUNT=nome:plano substitui nome, plano e quotaKey', () => {
  const a = readWith({ STATUSLINE_ACCOUNT: 'Marcelo:pro' });
  assert.strictEqual(a.displayName, 'Marcelo');
  assert.strictEqual(a.subscriptionType, 'pro');
  assert.strictEqual(a.quotaKey, 'env:Marcelo:pro', 'cota do token de env não se mistura com a do /login');
});

test('nome com espaço e dois-pontos: o plano é o que vem depois do último ":"', () => {
  const a = readWith({ STATUSLINE_ACCOUNT: 'Ana Maria: Dev:team' });
  assert.strictEqual(a.displayName, 'Ana Maria: Dev');
  assert.strictEqual(a.subscriptionType, 'team');
});

test('valor malformado é ignorado (cai no /login)', () => {
  for (const bad of ['Marcelo', ':pro', 'Marcelo:', '   ']) {
    const a = readWith({ STATUSLINE_ACCOUNT: bad });
    assert.strictEqual(a.displayName, 'Login User', `"${bad}"`);
    assert.strictEqual(a.subscriptionType, 'team', `"${bad}"`);
  }
});
