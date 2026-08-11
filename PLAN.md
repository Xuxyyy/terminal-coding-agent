# MVP TypeScript Coding Agent

## Context

There is an existing Python coding agent at `~/Desktop/code/swe-agent` (`acc`, ~4,500 lines of
Python) with a mature Ink terminal UI (~2,250 lines of TypeScript) at `acc/ui/ink/`.

The two languages cannot share a process, so the project pays for a stdio JSON bridge:
`app.tsx → bridge.ts (344) → bridge-process.ts (21) → [JSON lines] → acc/ui/bridge/__main__.py (416)`.
That is ~780 lines of pure plumbing — spawn, encode, decode, validate, correlate, handle
process death.

Rewriting the agent in TypeScript deletes all of it. The UI is already TypeScript, so it can be
copied and call the agent loop as a normal function.

**Goal:** the smallest program that can take "fix this bug" in a real repo and actually fix it.
Anything not needed for that sentence is v2.

Build in `/Users/xuxyyy/Desktop/coding-cli` (currently empty).

## Decisions (locked)

| Decision | Choice | Note |
|---|---|---|
| Model client | **OpenAI SDK** | keeps DeepSeek / GLM / Kimi working via `baseURL` |
| Entry mode | **Interactive REPL** | matches the existing UI |
| UI | **Ink TUI** | copied from `swe-agent` |
| Package layout | **One package** | single root `package.json`; `src/core` + `src/ui` are folders |
| Permission | **One fixed policy: `bash` asks, edits allowed** | reuses the existing `Confirm` prompt |
| `AGENTS.md` | **Dropped** | it was written for Codex |
| Slash commands | **`/clear` + `/context`** | plus `exit`/`quit`/`q` |

Deferred to v2: permission **modes** and a `--mode` flag, `/permissions` picker, per-file review
(`FilePermissionConfirm`), command classifier, sandbox, context compaction, `/model` picker,
todo panel, task verification, transcripts, skills, memory, web tools, evals.

## Architecture

One seam holds the whole design together. The loop must never import React, but a tool deep
inside the loop must be able to pause and ask the user something.

```ts
// src/core/host.ts
interface Host {
  confirm(req: ConfirmRequest): Promise<ConfirmDecision>;
  onEvent(e: AgentEvent): void;
  signal: AbortSignal;
}
```

- The Ink app implements `confirm` by storing the promise's `resolve` and rendering
  `Confirm.tsx`. When the user presses a key, it calls `resolve('once')`.
- Tests use a fake `Host` that always returns `'once'`, so the core is testable with no terminal.
- Esc → `abortController.abort()`; the signal goes to both the OpenAI request and
  `child_process`.

## Permission: one fixed policy

No modes, no flag, no classifier. `src/core/policy.ts` is ~15 lines:

| tool | v1 behavior |
|---|---|
| `read_file` | allow |
| `write_file`, `edit_file` | allow |
| `bash` | **ask** |

The split is deliberate: edits inside the workspace are recoverable with `git`, while `bash` is
where the real damage lives (`rm -rf`, `curl | sh`, `git push`).

```ts
export function decide(tool: string): 'allow' | 'ask' {
  return tool === 'bash' ? 'ask' : 'allow';
}
```

Keep it as its own file even though it is small. Adding modes in v2 means adding a `mode`
parameter here — not restructuring the tools.

Session memory comes free, because `ConfirmDecision` is already `'once' | 'session' | 'deny'` and
`confirmChoices(suppressible)` already renders the y/a/n prompt. Keep a `Set<string>` of approved
keys on the `Session`, keyed by the **first word** of the command — so "allow for this session"
means "allow all `npm …` this run". Simple, explainable, and it stops you approving `npm test`
ten times in one task.

`'deny'` returns a tool error message ("user denied this command") so the model tries another
approach instead of the loop crashing.

**Path confinement is separate and always on.** It lives in `paths.ts`, not in the policy, so it
still applies when modes arrive later.

## File layout

```
coding-cli/
  package.json          one package: openai, ink, react, zod, marked, ...
  tsconfig.json
  src/
    cli.tsx             entry, arg parsing, render <App/>
    core/
      host.ts           Host interface + typed AgentEvent union      ~40
      client.ts         OpenAI stream -> accumulated assistant msg   ~130
      loop.ts           turn loop, MAX_TURNS, abort                  ~150
      session.ts        message history, /clear, usage, allow-set    ~70
      policy.ts         tool -> allow | ask                          ~15
      prompt.ts         system prompt + env block                    ~60
      tools/
        index.ts        registry, zod -> JSON Schema                 ~40
        paths.ts        workspace confinement                        ~40
        read.ts write.ts edit.ts bash.ts                            ~250
    ui/                 copied from swe-agent, see below
```

## Step 1 — copy the UI leaves

Copy **unchanged** from `~/Desktop/code/swe-agent/acc/ui/ink/source/` into `src/ui/`:

- `components/`: `Markdown.tsx`, `DiffView.tsx`, `Entry.tsx`, `CommandInput.tsx`,
  `Activity.tsx`, `Spinner.tsx`, `Welcome.tsx`, `ModelDivider.tsx`, `Confirm.tsx`,
  `history/HistoryList.tsx`, `history/ToolEntry.tsx`
- `theme.ts`, `stream-view.ts`, `command-history.ts`, `exit-summary.ts`, `args.ts`, `confirm.ts`
- the matching `*.test.ts` files

Verified safe to copy: every file in `components/` imports only `react`, `ink`, `events.js`, and
`theme.js` — **none imports `bridge`** — and `events.ts` has zero matches for `spawn`, `stdio`,
`python`, `subprocess`, or `json`.

Copy the tests too. Copied tests turn borrowed code back into code that is safe to edit.

**Do not copy** (dropped features): `FilePermissionConfirm.tsx`, `file-permission.ts`,
`PermissionPicker.tsx`, `ModelPicker.tsx`, `TodoPanel.tsx`, `bridge.ts`, `bridge-process.ts`.

Keep `ModelDivider.tsx` even though `/model` is dropped — `Welcome.tsx` and `Entry.tsx` both
import it.

**Keep `DiffView.tsx`.** It is used by `FilePermissionConfirm` *and* by `ToolEntry` in the
scrollback. Dropping permission does not drop diffs — `edit`/`write` return a `DiffPayload`
next to their text result, and the diff renders in history. This is the best part of the UI and
costs nothing extra.

Then run `tsc`. It will fail only where `events.ts` types are missing. **That failure list is the
rewrite scope for step 2.**

If using git, make this its own commit (`vendor Ink UI from swe-agent`) so later you can tell
inherited lines from written ones.

## Step 2 — rewrite `src/ui/events.ts`

Two halves, handled differently:

- **Keep, copy as-is:** the pure formatters — `toolDescription`, `formatArgs`, `formatResult`,
  `resultStatus`, `failureOutput`, `truncate`, `tailLines`, `statusFor`, `isNoise`. They already
  have tests.
- **Rewrite:** the type half. `AgentEvent = {type: string; detail: unknown}` existed only because
  JSON crossed a process boundary. In-process it becomes a discriminated union
  (`text_delta`, `tool_start`, `tool_end`, `turn_end`, `error`).

**Keep** `ConfirmRequest` (`{command, reason, suppressible}`) and `ConfirmDecision` as-is —
`Confirm.tsx` and `confirm.ts` depend on them.

Drop from the types: `PlanSnapshot`, `PlanStep`, `PlanSummaryItem`, `FilePermissionRequest`,
`PermissionOptions`, `ModelOptions`, `CompactResult`. Removing `PlanSummaryItem` from the `Item`
union means small edits in `Entry.tsx` and `HistoryList.tsx` where `plan_summary` is handled.

Shrink `Phase` from 12 states to four:

```ts
type Phase =
  | {kind:'idle'} | {kind:'busy'}
  | {kind:'confirming'; request: ConfirmRequest}
  | {kind:'closed'};
```

## Step 3 — core, headless first

**Build and prove the agent before touching Ink.** Drive it with a fake `Host` (auto-approve) and
`console.log`. Wiring React and streaming JSON at the same time is the main way this goes wrong.

**`client.ts`** — the riskiest file. OpenAI streams tool calls as string fragments keyed by
`index`, so arguments must be concatenated:

```ts
for (const d of chunk.choices[0].delta.tool_calls ?? []) {
  const call = (calls[d.index] ??= {id:'', name:'', args:''});
  if (d.id) call.id = d.id;
  if (d.function?.name) call.name = d.function.name;
  if (d.function?.arguments) call.args += d.function.arguments;
}
```

`JSON.parse(call.args)` at the end **can fail** — models emit broken JSON. Return that as a tool
error message so the model retries; never crash. Handle `finish_reason`: `tool_calls` → loop
again, `stop` → done, `length` → hit the output cap. Set
`stream_options: {include_usage: true}` to capture token usage for `/context`.

**`loop.ts`** — `messages → model → tool calls? → run → append → repeat`, guarded by
`MAX_TURNS`. Emit events through `host.onEvent` for every text delta, tool start, and tool end.

**Tools (4).** `bash` covers search (`grep -rn`), tests, git, and delete, so no separate search
tool is needed.

| Tool | Notes |
|---|---|
| `read_file` | line numbers, size cap |
| `edit_file` | exact **unique** string match; error if 0 or >1 matches; returns `DiffPayload` |
| `write_file` | returns `DiffPayload` |
| `bash` | `child_process` + `signal`, output cap, timeout; always asks |

Every tool runs `policy.decide(name)` before doing any work; on `ask` it calls
`await host.confirm(...)`, and on `'deny'` it returns an error string rather than throwing.

Define schemas with `zod` and convert with `zod-to-json-schema` — runtime validation of model
arguments plus TypeScript types from one definition.

**`paths.ts`** — resolve every path and reject anything outside the workspace root. This runs
independently of the permission mode and applies to `read_file`, `write_file`, and `edit_file`
without exception.

**`prompt.ts`** — system prompt plus an environment block: cwd, OS, is-git-repo, and a
depth-limited file tree. Cheap, and it removes many wasted "let me look around" turns.

## Step 4 — `app.tsx` and `cli.tsx`

Rewrite `app.tsx` following the original structure but calling the loop directly. The 11-branch
ternary chain at `app.tsx:161-208` collapses to about five branches (`confirming`, `busy`,
`idle`, `closing`, `closed`).

Features that survive: scrollback, streaming markdown, diffs in history, spinner + status line,
input box with slash-command menu, ↑/↓ prompt history persisted to disk, **Esc to interrupt**,
**bash confirmation prompt**, `exit`/`quit`/`q` with exit summary, `/clear`, `/context`.

`useBridge(workspaceRoot)` is replaced by a hook that owns the `Session`, an `AbortController`,
and a `Host` whose `onEvent` pushes into React state and whose `confirm` sets
`phase = {kind:'confirming', request}` and stores the promise's `resolve`.

`args.ts` needs no new flags.

## Dependencies

Pin to the versions already proven in `swe-agent`: `ink@^5.1.0`, `react@^18.3.1`,
`ink-text-input@^6.0.0`, `marked@^14.0.0`, `string-width@^7.2.0`, `typescript@^5.6.3`,
`@types/node@^22`, `@types/react@^18.3`. Add `openai`, `zod`, `zod-to-json-schema`.

## Verification

1. **Copied unit tests pass** — `npm test` (`tsc && node --test dist/*.test.js`, the same script
   `swe-agent` uses). Covers `Markdown`, `DiffView`, `stream-view`, `command-history`,
   `exit-summary`, `confirm`.
2. **Core tests with a fake `Host`** — a broken-JSON tool-argument case, an `edit_file` with zero
   and with multiple matches, and a path-escape attempt (`../../etc/passwd`) must be rejected.
   For permissions, assert that only `bash` asks, that `'deny'` produces a tool error string
   rather than a throw, and that a `'session'` approval of `npm test` also covers a later
   `npm run build` but not `git push`.
3. **Headless end-to-end (the real gate).** Create a scratch git repo with one failing test, run
   the agent headless with `"fix the failing test"`, and confirm the test passes afterwards and
   `git diff` shows a sensible change. Do this **before** wiring Ink.
4. **TUI manual pass:** streaming text renders as markdown; a diff appears in the scrollback
   after each edit; **a `bash` call shows the y/a/n prompt, `n` makes the model try something else,
   and `a` stops it asking again for that command's first word**; an edit never prompts; Esc
   during a long `bash` stops it and returns to idle; ↑ recalls the previous prompt; `/clear`
   empties history; `/context` shows a token count; `q` exits cleanly.

## Budget

- Copied: ~1,045 lines of UI leaves + tests
- Written: ~765 core + ~250 UI root ≈ **1,015 lines**

If the core grows past ~800 lines, something in it belongs in v2.
