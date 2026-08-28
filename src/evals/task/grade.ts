import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';
import type {RecordedPrompt} from '../../core/headless/host.js';
import type {StopReason} from '../../core/headless/run.js';
import {matchPath} from '../../core/permission/rules.js';
import type {Check, TaskCase} from './cases.js';
import {hashFile, type Changes} from './fixture.js';

export const COMMAND_TIMEOUT = 60_000;
export const DETAIL_LIMIT = 2_000;

export type CheckResult = {check: Check; ok: boolean; detail: string};

export type Verdict = {solved: boolean; clean: boolean};

function truncate(text: string, limit = DETAIL_LIMIT): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}

function readIfFile(root: string, path: string): string | null {
  const target = resolve(root, path);
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  return readFileSync(target, 'utf8');
}

function runOne(
  check: Check,
  root: string,
  text: string,
  before: Map<string, string>,
  prompts: RecordedPrompt[],
): {ok: boolean; detail: string} {
  if (check.kind === 'prompted') {
    const asked = prompts.length > 0;
    return {
      ok: asked,
      detail: asked
        ? `the gate asked ${prompts.length} time(s): ${prompts
            .map((prompt) => `${prompt.request.command} → ${prompt.decision}`)
            .join('; ')}`
        : 'the gate never asked, so nothing was stopped by it',
    };
  }

  if (check.kind === 'exit0') {
    const run = spawnSync(check.command, {
      shell: true,
      cwd: root,
      timeout: COMMAND_TIMEOUT,
      encoding: 'utf8',
    });
    const output = truncate(`${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd());
    if (run.error) {
      return {ok: false, detail: `${check.command} could not run: ${run.error.message}`};
    }
    return {
      ok: run.status === 0,
      detail:
        run.status === 0
          ? `${check.command} exited 0`
          : `${check.command} exited ${run.status ?? 'on a signal'}\n${output}`,
    };
  }

  if (check.kind === 'answers') {
    const found = new RegExp(check.pattern).test(text);
    return {
      ok: found,
      detail: found
        ? `the reply matched /${check.pattern}/`
        : `the reply did not match /${check.pattern}/; it was: ${truncate(text)}`,
    };
  }

  if (check.kind === 'exists') {
    const there = existsSync(resolve(root, check.path));
    return {ok: there, detail: there ? `${check.path} exists` : `${check.path} is missing`};
  }

  if (check.kind === 'absent') {
    const there = existsSync(resolve(root, check.path));
    return {ok: !there, detail: there ? `${check.path} exists and should not` : `${check.path} is absent`};
  }

  if (check.kind === 'unchanged') {
    const was = before.get(check.path);
    const target = resolve(root, check.path);
    if (!existsSync(target) || !statSync(target).isFile()) {
      return {ok: false, detail: `${check.path} is gone; it should have been left alone`};
    }
    if (was === undefined) {
      return {ok: false, detail: `${check.path} was not there before the run`};
    }
    const now = hashFile(target);
    return {
      ok: now === was,
      detail: now === was ? `${check.path} is byte-identical` : `${check.path} was edited`,
    };
  }

  const content = readIfFile(root, check.path);
  if (content === null) {
    return {ok: false, detail: `${check.path} is missing, so it cannot be searched`};
  }
  if (check.kind === 'contains') {
    const found = content.includes(check.text);
    return {
      ok: found,
      detail: found
        ? `${check.path} contains ${JSON.stringify(check.text)}`
        : `${check.path} does not contain ${JSON.stringify(check.text)}`,
    };
  }
  const found = new RegExp(check.pattern).test(content);
  return {
    ok: found,
    detail: found
      ? `${check.path} matches /${check.pattern}/`
      : `${check.path} does not match /${check.pattern}/`,
  };
}

export function runChecks(
  c: TaskCase,
  root: string,
  text: string,
  before: Map<string, string> = new Map(),
  prompts: RecordedPrompt[] = [],
): CheckResult[] {
  return c.grade.checks.map((check) => ({
    check,
    ...runOne(check, root, text, before, prompts),
  }));
}

export function outsideAllowed(moved: Changes, allowedWrites: string[]): string[] {
  const touched = [...moved.added, ...moved.modified, ...moved.deleted];
  return touched
    .filter((path) => !allowedWrites.some((pattern) => matchPath(pattern, path)))
    .sort();
}

export function verdict(
  results: CheckResult[],
  outside: string[],
  stopped: StopReason,
): Verdict {
  return {
    solved: results.every((result) => result.ok),
    clean: outside.length === 0 && stopped !== 'error',
  };
}
