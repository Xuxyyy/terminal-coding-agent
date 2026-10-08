import type {ToolContext} from '../tools/registry.js';
import {runCommand} from './run.js';

type Operation =
  | {kind: 'snapshot'; target: string}
  | {kind: 'read'; target: string; maxBytes: number; display: string}
  | {kind: 'write'; target: string; content: string}
  | {kind: 'edit'; target: string; old: string; replacement: string; display: string};

const WORKER = `
import * as fs from 'node:fs';
import * as path from 'node:path';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const op = JSON.parse(input);
  if (op.kind === 'snapshot') {
    let bytes = null;
    try { bytes = fs.readFileSync(op.target).toString('base64'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log(JSON.stringify({bytes}));
  } else if (op.kind === 'read') {
    const stat = fs.statSync(op.target);
    if (stat.isDirectory()) throw new Error(op.display + ' is a directory, not a file');
    if (stat.size > op.maxBytes) throw new Error(op.display + ' is ' + stat.size + ' bytes, larger than the ' + op.maxBytes + ' byte limit');
    console.log(JSON.stringify({content: fs.readFileSync(op.target, 'utf8')}));
  } else {
    if (op.kind === 'edit' && !fs.existsSync(op.target)) throw new Error('no such file: ' + op.display);
    const before = fs.existsSync(op.target) ? fs.readFileSync(op.target, 'utf8') : '';
    let after = op.content;
    if (op.kind === 'edit') {
      if (!op.old) throw new Error('old_string is empty; use write_file to create a file');
      let count = 0, offset = 0;
      while ((offset = before.indexOf(op.old, offset)) !== -1) { count++; offset += op.old.length; }
      if (!count) throw new Error('old_string not found in ' + op.display);
      if (count > 1) throw new Error('old_string appears ' + count + ' times in ' + op.display + '; include more surrounding text so it matches once');
      after = before.replace(op.old, () => op.replacement);
    }
    fs.mkdirSync(path.dirname(op.target), {recursive: true});
    fs.writeFileSync(op.target, after, 'utf8');
    console.log(JSON.stringify({before, after}));
  }
} catch (error) {
  console.log(JSON.stringify({error: error.message}));
}
`;

export async function fileOperation(operation: Operation, ctx: ToolContext): Promise<{content: string; before: string; after: string; bytes: string | null}> {
  const result = await runCommand({
    root: ctx.root,
    sandbox: ctx.sandbox,
    program: process.execPath,
    args: ['--input-type=module', '--eval', WORKER],
    input: JSON.stringify(operation),
    signal: ctx.host.signal,
    access: ctx.sandboxAccess,
  });
  if (result.interrupted) throw new Error('stopped by the user');
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`file operation failed: ${result.stderr.trim() || 'worker did not return a result'}`);
  }
  const output = JSON.parse(result.stdout);
  if (output.error) {
    if (ctx.sandbox === 'on' && /EPERM|EACCES/.test(output.error)) throw new Error(`sandbox blocked file access: ${output.error}`);
    throw new Error(output.error);
  }
  return output;
}
