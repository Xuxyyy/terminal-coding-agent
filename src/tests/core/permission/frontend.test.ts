import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {classifyCommand, type Tier, type CheckCause} from '../../../core/permission/classify.js';
import {decide} from '../../../core/permission/decide.js';

const cases: [string, Tier | CheckCause][] = [
  ['pwd', 'observe'],
  ['ls -la', 'observe'],
  ['cat package.json', 'observe'],
  ['head -n 80 src/App.tsx', 'observe'],
  ['tail -n 20 src/App.tsx', 'observe'],
  ['rg --files -g "*.tsx"', 'observe'],
  ['find src -name "*.tsx"', 'observe'],
  ['rg -n useState src', 'observe'],
  ["sed -n '1,200p' src/App.tsx", 'unknown'],
  ['jq .scripts package.json', 'unknown'],
  ['ls src/*.tsx', 'unknown'],
  ['node --version', 'observe'],
  ['npm --version', 'observe'],
  ['pnpm --version', 'observe'],
  ['yarn --version', 'observe'],
  ['bun --version', 'observe'],
  ['command -v npm', 'observe'],
  ['which node', 'observe'],
  ['npm install', 'unknown'],
  ['npm ci', 'unknown'],
  ['pnpm add react', 'unknown'],
  ['npm create vite@latest', 'unknown'],
  ['npx create-next-app@latest', 'unknown'],
  ['npm run dev', 'recoverable'],
  ['npm run dev -- --port 5173', 'recoverable'],
  ['npm run dev > dev.log 2>&1 &', 'recoverable'],
  ['npm start', 'unknown'],
  ['pnpm dev', 'unknown'],
  ['yarn dev', 'unknown'],
  ['bun run dev', 'unknown'],
  ['npm run build', 'recoverable'],
  ['npm test', 'recoverable'],
  ['npm run lint', 'recoverable'],
  ['npm run typecheck', 'recoverable'],
  ['pnpm run build', 'recoverable'],
  ['yarn run build', 'recoverable'],
  ['npx tsc --noEmit', 'unknown'],
  ['npx eslint src', 'unknown'],
  ['npx playwright test', 'unknown'],
  ['npx prettier --write src', 'unknown'],
  ['node scripts/build.mjs', 'unknown'],
  ['mkdir -p src/new', 'recoverable'],
  ['touch src/new.tsx', 'recoverable'],
  ['cp src/App.tsx src/Copy.tsx', 'recoverable'],
  ['mv src/App.tsx src/Moved.tsx', 'recoverable'],
  ['rm -rf dist', 'destroy'],
  ['touch .npmrc', 'protected'],
  ['git status --short', 'observe'],
  ['git diff --check', 'observe'],
  ['git log --oneline -5', 'observe'],
  ['git branch --show-current', 'observe'],
  ['git add src/App.tsx', 'unknown'],
  ['git commit -m "update app"', 'unknown'],
  ['git push', 'escape'],
  ['curl -I http://localhost:5173', 'unknown'],
  ['lsof -i :5173', 'unknown'],
  ['kill 12345', 'unknown'],
  ['git status && git diff --stat', 'observe'],
  ['cd apps/web && npm run build', 'recoverable'],
  ['npm run lint && npm run build', 'unknown'],
  ['npm run build && npm test', 'unknown'],
  ['mkdir -p src/new && cp src/App.tsx src/new/App.tsx', 'unknown'],
  ['CI=1 npm test', 'unknown'],
  ['npm run deploy', 'recoverable'],
  ['npm run build --prefix ../outside', 'recoverable'],
  ['cat src/App.tsx > copy.txt', 'recoverable'],
  ['cat src/App.tsx > ../copy.txt', 'escape'],
  ['node scripts/build.mjs > build.log', 'unknown'],
  ['npm run build > ../build.log', 'escape'],
];

test('frontend command findings and default routing survive the tier refactor', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-cli-frontend-'));
  t.after(() => fs.rmSync(project, {recursive: true, force: true}));
  fs.mkdirSync(path.join(project, 'src'));
  fs.mkdirSync(path.join(project, 'apps/web'), {recursive: true});
  fs.writeFileSync(path.join(project, 'src/App.tsx'), 'export const App = () => null;');
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  assert.equal(cases.length, 69);
  for (const [command, expected] of cases) {
    const classification = classifyCommand(command, project);
    const automatic = expected === 'observe' || expected === 'recoverable';
    assert.equal(classification.tier, automatic ? expected : 'needs-checking', command);
    assert.equal(classification.cause, automatic ? null : expected, command);
    assert.equal(decide({kind: 'command', command}, project).decision,
      expected === 'observe' || expected === 'recoverable' ? 'allow' : 'judge', command);
  }
});

test('saved Bash rules still apply independently of automatic classification', () => {
  const command = 'npm run lint && npm run build';
  assert.equal(classifyCommand(command, process.cwd()).cause, 'unknown');
  assert.equal(decide({kind: 'command', command}, process.cwd(), {
    allow: [{tag: 'bash', pattern: 'npm run *'}], ask: [], deny: [],
  }).decision, 'allow');
  assert.equal(decide({kind: 'command', command}, process.cwd(), {
    allow: [{tag: 'bash', pattern: 'npm run *'}], ask: [],
    deny: [{tag: 'bash', pattern: 'npm run build'}],
  }).decision, 'deny');
});
