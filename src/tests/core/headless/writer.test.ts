import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Writable} from 'node:stream';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {createLineOutput} from '../../../core/headless/writer.js';

test('large UTF-8 records stay complete and ordered through a slow writer', async () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    highWaterMark: 16,
    write(chunk: Buffer, _encoding, callback) {
      setTimeout(() => {
        chunks.push(Buffer.from(chunk));
        callback();
      }, 5);
    },
  });
  const errors: Error[] = [];
  const output = createLineOutput(stream, (error) => errors.push(error));
  const records = [
    {type: 'tool_end', result: 'A😀中\n'.repeat(40_000)},
    {type: 'model_request_start', request: 2},
    {kind: 'result', message: 'finished 😀'.repeat(20_000)},
  ];
  for (const record of records) output.write(JSON.stringify(record));
  assert.ok(stream.writableNeedDrain);
  assert.equal(chunks.length, 0);

  await output.finish();

  const expected = Buffer.from(records.map((record) => JSON.stringify(record) + '\n').join(''));
  assert.deepEqual(Buffer.concat(chunks), expected);
  assert.deepEqual(Buffer.concat(chunks).toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line)), records);
  assert.equal(stream.writableFinished, true);
  assert.deepEqual(errors, []);
});

test('a broken output pipe reports failure and interrupts the producer', async () => {
  const failure = Object.assign(new Error('broken pipe'), {code: 'EPIPE'});
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(failure));
    },
  });
  const controller = new AbortController();
  const output = createLineOutput(stream, (error) => controller.abort(error));
  output.write(JSON.stringify({type: 'tool_end', result: 'data'}));

  await assert.rejects(output.finish(), (error) => error === failure);

  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason, failure);
  const pending = stream.writableLength;
  output.write(JSON.stringify({kind: 'result', stopped: 'cancelled'}));
  assert.equal(stream.writableLength, pending);
  assert.doesNotThrow(() => stream.emit('error', failure));
});

test('Ink startup and a slow stdout pipe preserve large JSON records', {timeout: 10_000}, async (t) => {
  const writer = new URL('../../../core/headless/writer.js', import.meta.url).href;
  const payload = '😀中\n'.repeat(100_000);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import 'ink';
    import {createLineOutput} from ${JSON.stringify(writer)};
    const output = createLineOutput(process.stdout, () => { process.exitCode = 1; });
    output.write(JSON.stringify({type: 'tool_end', result: '😀中\\n'.repeat(100_000)}));
    output.write(JSON.stringify({kind: 'result', stopped: 'done'}));
    await output.finish();
  `], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    env: {PATH: process.env.PATH},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill('SIGKILL'); });
  const chunks: Buffer[] = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 2);
  });
  child.stdout.pause();
  setTimeout(() => child.stdout.resume(), 150);

  const [code] = await once(child, 'close');

  assert.equal(code, 0, stderr);
  const expected = JSON.stringify({type: 'tool_end', result: payload}) + '\n' +
    JSON.stringify({kind: 'result', stopped: 'done'}) + '\n';
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(expected));
});
