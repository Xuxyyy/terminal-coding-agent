import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  appendCommandHistory,
  loadCommandHistory,
  parseCommandHistory,
} from '../../ui/command-history.js';

test('parseCommandHistory reads prompt_toolkit history files', () => {
  const content = [
    '',
    '# 2026-01-01',
    '+first task',
    '',
    '# 2026-01-02',
    '+second',
    '+task',
    '',
  ].join('\n');

  assert.deepEqual(parseCommandHistory(content), [
    'first task',
    'second\ntask',
  ]);
});

test('loadCommandHistory returns nothing when the file is missing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-coding-cli-'));

  try {
    assert.deepEqual(loadCommandHistory(path.join(directory, 'absent')), []);
  } finally {
    fs.rmSync(directory, {recursive: true});
  }
});

test('appendCommandHistory creates the folder it writes into', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-coding-cli-'));
  const historyPath = path.join(directory, '.acc', 'prompt-history');

  try {
    appendCommandHistory('first task', historyPath);
    appendCommandHistory('second task', historyPath);
    assert.deepEqual(loadCommandHistory(historyPath), [
      'first task',
      'second task',
    ]);
  } finally {
    fs.rmSync(directory, {recursive: true});
  }
});

test('appendCommandHistory keeps the history private', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-coding-cli-'));
  const home = path.join(directory, '.acc');
  const historyPath = path.join(home, 'prompt-history');

  try {
    fs.mkdirSync(home, {mode: 0o755});
    fs.writeFileSync(historyPath, '', {mode: 0o644});
    appendCommandHistory('first task', historyPath);

    assert.equal(fs.statSync(historyPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(directory, {recursive: true});
  }
});
