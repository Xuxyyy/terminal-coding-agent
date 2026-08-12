---
name: tui-e2e
description: How to end-to-end test an interactive terminal app — drive it in a tmux session, read the rendered screen, and judge it against oracles instead of vibes. Use when testing a TUI or REPL by hand would mean typing keys and watching output, when a unit test cannot reach the behaviour because it only exists on a real terminal, or when a run costs real API tokens and needs a budget. Covers the method only; the app's own facts belong in the caller.
---

# End-to-end testing a terminal app

A unit test calls a function. This is for the part no unit test can reach: an
app that stays open, redraws itself, and only misbehaves in front of a real
terminal.

You have no hands and no eyes. tmux gives you both — `send-keys` types,
`capture-pane` photographs the screen. Everything here is built on that.

This skill is the method. The app's own facts — how to launch it, what its
screens say, what it writes to disk — come from whoever loaded this skill.

## The shape of a run

1. **Free gate.** Build or compile first. If it fails, stop and report. You have
   spent nothing.
2. **Throwaway workspace.** Never test an app inside its own source tree.
3. **Free scenarios.** Everything that costs nothing, run without asking.
4. **Ask.** Show the plan and the estimate. Wait for a yes.
5. **Paid scenarios.** Count the cost as you go.
6. **Clean up.** Then report.

Never reorder these. The free block existing to run first is what makes a broken
build cost nothing.

## Isolation

Two things must be true before the first keystroke:

- The app runs in a **temporary directory**, seeded with whatever files the
  scenarios need. An agent under test that can edit its own source will.
- Its **state directory is redirected** into that temp directory, usually with
  an environment variable. This keeps test runs out of the user's real config,
  makes "the list starts empty" a fact you can rely on, and turns cleanup into
  a single `rm -rf`.

Check whether the app reads its API keys from that same redirected directory. If
it does, the keys will not load and every paid scenario fails for the wrong
reason.

## Driving

Start detached, with a fixed size so wrapping is predictable:

```
tmux kill-session -t app 2>/dev/null
tmux new-session -d -s app -x 100 -y 30 -c "$W" '<launch command>'
```

Type text and send keys in **separate calls**:

```
tmux send-keys -t app -l 'some text'     # -l sends it literally
tmux send-keys -t app Enter              # a key name, no -l
```

`-l` matters. Without it, a prompt containing the word `Enter`, or starting with
`-`, is read as a key name instead of text.

Real keys: `Enter`, `Escape`, `Up`, `Down`, `Tab`, `Space`, `C-c`, and plain
letters for menu answers.

Read the screen:

```
tmux capture-pane -t app -p              # visible screen
tmux capture-pane -t app -p -S -300      # plus 300 lines of scrollback
```

Use the scrollback form whenever the thing you are checking may have scrolled
away — long output, a diff, an earlier reply. A check that fails only because
the text moved up is a false failure.

## Never judge on a fixed sleep

`sleep 5` is the main source of flaky terminal tests. Poll instead, and treat
running out of time as evidence:

```
waitfor() {   # waitfor <text> <seconds>
  for i in $(seq 1 "$2"); do
    tmux capture-pane -t app -p -S -300 | grep -qF "$1" && return 0
    sleep 1
  done
  return 1
}
```

When it times out, report the number of seconds you waited. "Nothing appeared in
30s" is a finding. "It didn't work" is not.

There is one case where a fixed wait is correct: proving something **does not**
happen. To show no prompt appeared, you must wait a stated time and then look.
Say how long you waited.

**Never poll for a string that appears in what you just typed.** The terminal
echoes your own input, so the match fires before the app has done anything, and
the wait measures nothing. Poll for something only the app can produce: a marker
it renders, a count it prints, a row it draws. If the obvious string is also in
your prompt, that is a sign to pick a different one — or to lean on a disk
oracle, which cannot be fooled this way at all.

## Oracles

Every scenario needs a pass condition another person could check without you.
Two kinds, and the second is stronger:

- **Screen** — exact text that must appear, or must not appear. Use it only for
  what exists nowhere else: a prompt, a menu, a rendered diff, a status line.
- **Disk** — files the app wrote, and the records inside them. Prefer this
  whenever it is available. It survives a redraw, a resize, and a scroll.

Pull expected strings **out of the source**. Grep for the literal the app
prints and cite it as `file:line`. Never invent expected text and never
paraphrase it — if you cannot find the real string, say so and mark the
scenario untested.

The strongest oracle is often a **negative** one: a box that must not appear, a
row that must not be offered, a directory that must not be created. Those catch
the bugs that matter, because a feature quietly doing more than it should looks
exactly like success on screen.

## When a model is in the loop

If the app calls an LLM, its wording changes every run. That is not the thing
under test.

- Judge the **shape**, not the words: a tool ran, a box appeared, a file
  changed, a record was written.
- Write prompts that **force** the path you want. "Use bash to run `ls`" beats
  "what files are here", which the model may answer from memory.
- Use the **cheapest** model the app supports. You are testing the app, not the
  model's intelligence.
- Track spend per scenario, report the total, and stop at the budget you were
  given.

## Three outcomes, not two

- `PASS` — you saw the oracle satisfied.
- `FAIL` — you saw it violated. Quote the screen or the record.
- `UNTESTED` — you could not reach the state the scenario needed. Say why.

`UNTESTED` is the one that keeps this honest. A model that never called the tool,
a timeout, a scenario skipped for budget — none of those are passes, and
collapsing them into one is how a green report starts hiding things.

## Never fix anything

Report and stop. An agent that can edit the code will eventually edit the code
until its own test goes green, and you will not be able to tell that it did.
Point at the `file:line` you suspect; write no patch.

## The report

Whoever asked for this run did not watch it happen. They cannot see the keys you
sent or the screens you read. So the report has to do two jobs: answer the
question, and show enough of the work that they could repeat it themselves.

Four sections, in this order.

**1. Verdict.** One line, first thing. Does the thing work — `PASS`, `FAIL`, or
`UNTESTED` — and the one-sentence reason. If a reader stops after this line,
they should still have their answer.

**2. The results table.** One row per scenario, always a table, even for a
single scenario:

| # | Check | Result | Evidence |
|---|---|---|---|
| S1 | what it checks, in a few words | PASS / FAIL / UNTESTED | the one fact that decided it |

Anything you planned but did not run still gets a row, marked `UNTESTED`, with
the reason in the evidence column. A scenario missing from the table reads as a
scenario that passed.

**3. How it ran.** A summary of the flow, not a transcript. Five verbs, one step
per line:

- `sent` — keys you typed into the app
- `got` — the **shape** of what came back: text, which tools were called by
  name, whether a tool result succeeded. Never the prose
- `waited` — you polled for a string. Give the limit and when it actually
  appeared
- `watched` — you waited a fixed time for something that must **not** appear.
  Give the duration
- `read` — what you inspected afterwards: the screen, a file, a record stream

A simple scenario is three or four lines. One that drives the app's own tools is
longer, because each approval and each wait is a real step:

```
setup  fresh workspace, seeded notes.txt / code.ts, state directory
       redirected inside it, app launched in tmux at 100x30

S1     sent    "use bash to run: ls notes.txt"
       got     text + 1 tool call: bash
       waited  for "allow for this session"      max 30s, appeared at 6s
       sent    a
       got     tool result, exit 0
       waited  for "notes.txt" in the output     appeared at 3s
       sent    the command under test → Enter
       waited  for its confirmation notice
       sent    "use bash to run: ls code.ts"
       watched 25s for an approval box           NEGATIVE — none expected
       read    screen + the transcript file
```

Two reasons `got` earns its line. It is the half of the exchange the other verbs
miss — without it the reader sees only what you typed. And it catches a scenario
that passed for the wrong reason: if the row above had said
`got  text only, 0 tool calls`, then no command ever ran, and "no approval box
appeared" proves nothing. That row is `UNTESTED`, not `PASS`.

`waited` prints the real timing for the same reason. A check that passed at 28
seconds of a 30 second limit is fragile, and the number is the only way anyone
would know.

Do not paste screen captures here. They belong in the evidence section, and only
for rows that failed.

**4. Evidence.** Quote the screen for every `FAIL`, and the record or file
contents for every disk check that decided a row. A claim with no evidence is
not a finding. Name the file you suspect as `file:line`, and write no patch.

**5. Cost and cleanup.** What was spent, and whether the number under-reports.
Say that cleanup ran and name anything you could not remove.

Then stop. No praise, no next steps, no restating the verdict a second time.
