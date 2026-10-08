import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {analyzeStage} from '../../../core/permission/analyze.js';

test('analysis keeps mixed reads, writes, deletion, and uncertain execution distinct', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-effects-'));
  t.after(() => fs.rmSync(project, {recursive: true, force: true}));
  fs.writeFileSync(path.join(project, 'input.txt'), 'input');
  const analyze = (command: string) => {
    const effects = analyzeStage(command, project, project);
    assert.ok(effects, command);
    return effects;
  };

  for (const command of ['cat input.txt > output.txt', 'cp input.txt output.txt', 'sort -o output.txt input.txt']) {
    const effects = analyze(command);
    assert.equal(effects.known, true, command);
    assert.ok(effects.reads.includes('input.txt'), command);
    assert.ok(effects.writes.some((target) => target.path === 'output.txt'), command);
    assert.ok(effects.changes.includes(path.join(project, 'output.txt')), command);
  }

  const deletion = analyze('rm input.txt');
  assert.ok(deletion.writes.some((target) => target.path === 'input.txt' && target.destroys));
  const unknown = analyze('python3 build.py > output.txt');
  assert.equal(unknown.known, false);
  assert.ok(unknown.writes.some((target) => target.path === 'output.txt'));
  assert.equal(unknown.runnerSyntaxKnown, false);

  const runner = analyze('npm run build');
  assert.equal(runner.known, false, 'a supported runner does not reveal script effects');
  assert.equal(runner.projectRunner, 'npm run');
  assert.equal(runner.runnerSyntaxKnown, true);
  assert.ok(runner.changes.includes(fs.realpathSync(project)));
  assert.equal(analyze('npm run build << input.txt').runnerSyntaxKnown, false);

  assert.equal(analyze('CI=1 npm test').known, false);
  assert.equal(analyze('CI=1 npm test').projectRunner, null);
  const directory = analyze('cd source');
  assert.equal(directory.changesDirectory, true);
  assert.equal(directory.directory, 'source');
  assert.equal(analyze('cd source > output.txt').directory, undefined);
  assert.equal(analyzeStage('cat "unfinished', project, project), null);
});

test('analysis preserves quoted redirect symbols and identifies writes that invalidate inputs', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-effects-'));
  t.after(() => fs.rmSync(project, {recursive: true, force: true}));
  fs.mkdirSync(path.join(project, 'source'));
  fs.writeFileSync(path.join(project, 'source/input.txt'), 'input');
  const literal = analyzeStage('echo "> output.txt"', project, project)!;
  assert.equal(literal.known, true);
  assert.deepEqual(literal.writes, []);
  const copy = analyzeStage('cp -R source destination > source/input.txt', project, project)!;
  assert.equal(copy.selfAffected, true);
});
