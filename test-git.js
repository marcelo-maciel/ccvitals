'use strict';
// Git test suite. Run: node --test
// Covers: porcelain path extraction (porcelainPath) and the single-dirty-file
// label produced by collectGit against a real throwaway repository.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { collectGit, porcelainPath } = require('./git');

// helper: each case is one raw porcelain line and the path it must yield
function pathCase(name, line, expected) {
  test(name, () => {
    assert.strictEqual(porcelainPath(line), expected);
  });
}

// Unstaged edits are the regression: `git status --porcelain` emits " M file",
// stdout.trim() eats the leading blank index column, and a fixed 3-char slice
// then swallowed the first character of the filename.
pathCase('unstaged edit, leading blank column trimmed away', 'M settings.json', 'settings.json');
pathCase('unstaged edit, leading blank column intact', ' M settings.json', 'settings.json');
pathCase('staged edit', 'M  settings.json', 'settings.json');
pathCase('staged and then edited again', 'MM settings.json', 'settings.json');
pathCase('untracked file', '?? notes.md', 'notes.md');
pathCase('ignored file', '!! cache.json', 'cache.json');
pathCase('staged addition', 'A  src/new.js', 'src/new.js');
pathCase('deletion', ' D old.js', 'old.js');
pathCase('typechange', ' T link.js', 'link.js');
pathCase('path containing spaces', 'M my notes.md', 'my notes.md');
pathCase('filename starting with a status letter', 'M Makefile', 'Makefile');
pathCase('filename starting with a question mark', '?? ?weird.txt', '?weird.txt');

// Real repository: the only path that proves the label the user actually reads.
const repos = [];
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccvitals-git-'));
  repos.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}\n');
  git('add', 'settings.json');
  git('commit', '-m', 'init');
  return { dir, git };
}

after(() => {
  for (const dir of repos) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('single unstaged file keeps its full name in the status label', async () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"a":1}\n');
  const { branch, gitStatus } = await collectGit(dir, [3, 10]);
  assert.strictEqual(branch, 'main');
  assert.strictEqual(gitStatus, '(settings.json uncommitted, no upstream)');
});

test('clean tree reports zero files', async () => {
  const { dir } = makeRepo();
  const { gitStatus } = await collectGit(dir, [3, 10]);
  assert.strictEqual(gitStatus, '(0 files uncommitted, no upstream)');
});

test('two or more dirty files report a count, not a name', async () => {
  const { dir } = makeRepo();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(dir, 'extra.json'), '{}\n');
  const { gitStatus } = await collectGit(dir, [3, 10]);
  assert.strictEqual(gitStatus, '(2 files uncommitted, no upstream)');
});
