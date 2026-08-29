# `/work US-3` and `/work --board`

Batch modes. The protocol per task is the one in `SKILL.md`; this file says what changes when there is more than one.

## The rule that makes the rest work

**The orchestrator session never implements.** It does not edit a file, does not run the build, does not write a test. It reads, it delegates, it writes to DevManager, and it moves on.

That is not tidiness. The orchestrator's context has to survive the whole batch; a session that also implements has spent it by the third task and starts making the mistakes this skill exists to prevent.

## What the batch is

- **`/work US-3`** — every pending task of that story, in dependency order.
- **`/work --board [--limit N]`** — the top of `get_work_queue`. **Default limit: one story, or five tasks, whichever comes first.** `--limit N` sets it explicitly. There is no unlimited: a batch nobody bounded is a batch nobody is watching.

Say the batch out loud before starting it — the tasks, in order, with the limit that produced them — and let the human cut it down.

## 1. Context, once

`get_context` once for the batch. Rigor, languages, writing guide, conventions. It governs every task in it.

## 2. Plan the whole batch first

Read every task in the batch (`get_task`), and the story (`get_story`) with its acceptance criteria.

Then run the **planner**:

- **Story mode:** once for the story, when the tasks share its acceptance criteria — that is the case the mode exists for. Split into a per-task plan afterwards. Run it per task instead when the tasks turn out to be independent enough that one plan would be three plans stapled together.
- **Board mode:** once per task. Unrelated tasks have nothing to share.

Post each task's plan as a comment on that task, and propose estimates (`set_task_estimate`) for tasks that have none.

## 3. Ask everything, once

Collect the open questions from every plan in the batch **before implementing anything**. Group them by task, ask the human in one message, and wait.

This is the whole reason the planning pass comes first. A batch that asks its questions one at a time, hours apart, is worse than five separate sessions.

Then:

- **Answered** → that task proceeds.
- **Unanswered** → **that task is skipped.** Post the unanswered questions as a comment on it, leave it where it is, mark it `skipped` in the report, and go on. The batch does not stop, and you do not answer the question yourself to keep the pipeline moving.

## 4. Per task, in dependency order

Order comes from `get_work_queue` in board mode and from the story's blockers in story mode. **Re-fetch the queue between tasks** — a task you just finished may have unblocked another, and the order you computed at the start is already out of date.

For each task, with **fresh subagents every time** (a reviewer that already saw the diff is not reviewing it):

1. `start_task`, branch `task/<number>-<slug>`, write `.claude/state/current-task.json`.
2. **implementer** → the diff.
3. **reviewer** → findings. Blocking findings go back to the implementer once; still blocking after that, the task is **blocked**: post the findings, leave it in progress, go on to the next task.
4. **tester** at the batch's rigor level.
5. **You** verify this task's definition of done — the acceptance criteria, one by one, against what the reviewer reported. The orchestrator signs it off; a subagent saying "done" is evidence, not a verdict.
6. Close it: comment, `log_time`, `submit_for_review`, clear the state file.

**A failure in one task never aborts the batch.** It blocks that task, with findings, and the batch continues. The only thing that stops a batch is the human, or running out of tasks.

## 5. Time and tokens per task

Tokens come from `.claude/state/last-usage.json`, whose `bySource` breaks the total down per subagent transcript (`main`, `agent-*`).

- **Attributable** — the subagent transcripts for a task can be told apart from the rest of the batch. Log each task its own numbers.
- **Not attributable** — log the batch total **split proportionally by task**, weighted by whatever you actually measured (minutes is the usual choice), and **say so in the closing comment**: "tokens are this task's share of a batch total of N, split by time". A number whose provenance is not written down will be read as a measurement a year from now.

Minutes are per task: measured from that task's `startedAt`, or confirmed by the human. Never the batch's minutes copied onto each task.

## 6. End-of-batch report

One message, in `responseLanguage`. Per task:

| | task | outcome | branch | minutes | tokens |
|---|---|---|---|---|---|
| | `#12` | done → in review | `task/12-slug` | 34 | 1.2M (attributed) |
| | `#13` | blocked — 2 findings | `task/13-slug` | 21 | 0.8M (share) |
| | `#14` | skipped — 1 open question | — | — | — |

Then, below it:

- **Proposed decisions awaiting an ADMIN** — every `propose_decision` the batch produced, with its number and one line of what it settles. These are the batch's real output as often as the code is.
- **Open questions still unanswered**, with the task each belongs to.
- **What the tester did not cover**, across the batch.

Do not bury a blocked or skipped task in prose. A batch report whose failures are hard to find is a batch report nobody will trust twice.
