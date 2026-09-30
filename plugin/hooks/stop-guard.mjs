// stop-guard.mjs — the Stop hook. It will not let a session end in the middle
// of a DevManager task.
//
// While the `work` skill has a task open it keeps
// `~/.claude/devmanager-state/<project-id>/<task-number>/current-task.json`, with the
// repository the task was started in. If a session working inside that
// repository tries to stop with the file still there, the board is about to
// start lying: a task sits in progress that nobody is working, with no
// documentation check, no closing comment and no time logged. So the guard
// blocks the stop with the list of what closing still requires, and writes the
// tokens spent since the task started next to it, in `last-usage.json` — a
// fallback record; the close itself measures them with the launcher. Both count
// by the task's number from `current-task.json` (`"task": "#12"`), as `--task`.
// When that file's number does not parse, or its `startedAt` is not an ISO
// instant, the hook counts without the number, as before: by the hour from a
// `startedAt` that `Date.parse` still reads, and the whole session without one.
//
// A Stop fires at the end of EVERY turn, not only when the session ends, and a
// turn that ends asking the person something is waiting, not leaving. So a last
// message that ends in a question goes through without being counted.
//
// DECISION — loop safety. The guard honours `stop_hook_active` when the runtime
// sends it, and on top of that limits itself: MAX_BLOCKS refusals in a row,
// counted in `stop-guard.json` next to the task and reset when the open task
// changes or when the last refusal is older than BLOCK_WINDOW_MS — a refusal
// half an hour ago belongs to another stretch of the work, and letting it count
// would leave the real end of the task unguarded. Within a window, after
// MAX_BLOCKS it gets out of the way: a guard that can hold a session forever is
// worse than the state it is guarding.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  LAST_USAGE,
  STOP_GUARD,
  stateRoot,
  findOpenTask,
  readState,
  writeState,
  readHookInput,
} from "./lib/state.mjs";
import { captureUsage, isIsoInstant, parseTaskNumber } from "./capture-usage.mjs";

export const MAX_BLOCKS = 2;
export const BLOCK_WINDOW_MS = 30 * 60 * 1000;

/** Whether the turn ended asking the person something: then it is waiting, not leaving. */
export function isWaiting(lastMessage) {
  return typeof lastMessage === "string" && /[?？]\s*$/.test(lastMessage.trim());
}

/** Identity of the open task, so the block counter resets when a new one opens. */
export function taskKey(currentTask) {
  if (!currentTask) return null;
  return [currentTask.project, currentTask.task, currentTask.startedAt].join("@");
}

/**
 * Step 3 of the close. It only offers the counter's command when the task's
 * start is one the counter accepts: a command that exits 1 is not advice.
 */
function logTimeStep(currentTask) {
  const number = parseTaskNumber(String(currentTask?.task));
  const task = number ?? "<n>";
  // Pasted as it is, `<n>` is a shell redirection: say what goes there.
  const placeholder = number === null ? ["     Replace <n> with the task's number before running it."] : [];
  const counter = "node ~/.claude/devmanager-state/capture-usage.mjs";
  if (isIsoInstant(currentTask?.startedAt)) {
    return [
      "  3. log_time — the minutes, and the tokens that",
      `     \`${counter} --since ${currentTask.startedAt} --task ${task}\``,
      '     prints under logTime (null or an error: log the time without tokens), source: "AI".',
      ...placeholder,
    ];
  }
  return [
    '  3. log_time — the minutes, source: "AI", and no tokens: the task\'s start (startedAt in the',
    "     file above) cannot be read, and without it the counter cannot tell this task's share.",
    "     Only if the person confirms when the task started, count from then instead:",
    `     \`${counter} --since <that start, as 2026-09-30T13:00:00.000Z> --task ${task}\`.`,
    ...placeholder,
  ];
}

export function blockReason(currentTask, dir) {
  const raw = currentTask?.task;
  const named = raw !== undefined && raw !== null && String(raw).trim() !== "";
  const file = dir ? path.join(dir, "current-task.json") : "current-task.json";
  return [
    `${named ? `Task ${raw}` : "A DevManager task"} is still open — ${file} exists, so this session has not closed it.`,
    "",
    "Finish step 8 of the `work` skill before stopping:",
    "  1. Documentation check — read the project's documents against what you built, fix what the",
    "     work made false (upsert_document), and keep the result for docs_check.",
    "  2. add_comment — what was done, decisions taken, deviations from the plan, what to verify.",
    ...logTimeStep(currentTask),
    "  4. submit_for_review with docs_check — the state transition. Never complete_task unless the",
    "     project has no review column and the human said to close fully.",
    `  5. Delete ${file}.`,
    "",
    "If the task cannot be finished, that is also a close: say why in a comment, log the time spent,",
    "leave the task where it belongs, and delete the state file. What is not allowed is silence.",
    "",
    "Waiting for the person's answer? End the message with the question: a turn that asks goes through.",
    `Not the session working that task? Say so and stop again: the guard steps aside after ${MAX_BLOCKS} refusals.`,
  ].join("\n");
}

/**
 * The whole decision, as a pure function. `guard` is the previous
 * stop-guard.json; the returned `guard` is what should replace it.
 */
export function decide({
  currentTask,
  dir = null,
  guard,
  stopHookActive = false,
  lastMessage = null,
  now = Date.now(),
  maxBlocks = MAX_BLOCKS,
}) {
  if (!currentTask) {
    return { block: false, reason: null, guard: null, why: "no open task" };
  }

  const key = taskKey(currentTask);
  const lastBlockedAt = Date.parse(guard?.lastBlockedAt);
  const recent = !Number.isNaN(lastBlockedAt) && now - lastBlockedAt < BLOCK_WINDOW_MS;
  const blocks = guard?.taskKey === key && recent ? Number(guard.blocks) || 0 : 0;

  if (isWaiting(lastMessage)) {
    return { block: false, reason: null, guard: guard ?? null, why: "waiting for the person's answer" };
  }

  // Honoured when the runtime provides it; the counter below is what actually
  // guarantees termination.
  if (stopHookActive) {
    return {
      block: false,
      reason: null,
      guard: { taskKey: key, blocks, lastBlockedAt: guard?.lastBlockedAt ?? null },
      why: "stop hook already active",
    };
  }

  if (blocks >= maxBlocks) {
    return {
      block: false,
      reason: null,
      guard: { taskKey: key, blocks, lastBlockedAt: guard?.lastBlockedAt ?? null },
      why: `already blocked ${blocks} time(s) for this task`,
    };
  }

  return {
    block: true,
    reason: blockReason(currentTask, dir),
    guard: { taskKey: key, blocks: blocks + 1, lastBlockedAt: new Date(now).toISOString() },
    why: "task still open",
  };
}

/** What the hook prints on stdout: the documented `decision: "block"` shape. */
export function output(decision) {
  if (!decision.block) return null;
  return {
    decision: "block",
    reason: decision.reason,
    systemMessage: "A DevManager task is still open. Close it before ending the session.",
  };
}

export async function run({ stdin = process.stdin, env = process.env } = {}) {
  const input = await readHookInput(stdin);
  // The session's directory comes from the hook's input, not from
  // CLAUDE_PROJECT_DIR: a plugin hook runs for every project on the machine,
  // and the input is what says which one this stop belongs to.
  const open = findOpenTask(stateRoot(env), input.cwd || process.cwd());

  // Capture usage even when the stop is allowed: the numbers are cheap to take
  // and the close may be happening in this very turn.
  if (open) {
    // From the task's start, not the session's: a session that worked two
    // tasks must not log the first one's tokens against the second.
    // And by its number, so its planner counts although it ran before the
    // start, and another task's subagents do not although they ran after it.
    // A task file whose number or start does not parse is counted as before:
    // by the hour, or the whole session.
    const started = isIsoInstant(open.task.startedAt);
    const task = (started && parseTaskNumber(String(open.task.task))) || undefined;
    const usage = captureUsage(input.transcript_path, { since: open.task.startedAt, task });
    if (usage) writeState(open.dir, LAST_USAGE, { ...usage, sessionId: input.session_id ?? null });
  }

  const decision = decide({
    currentTask: open?.task ?? null,
    dir: open?.dir ?? null,
    guard: open ? readState(open.dir, STOP_GUARD) : null,
    stopHookActive: input.stop_hook_active === true,
    lastMessage: input.last_assistant_message ?? null,
  });

  if (decision.guard && open) writeState(open.dir, STOP_GUARD, decision.guard);

  const payload = output(decision);
  if (payload) process.stdout.write(`${JSON.stringify(payload)}\n`);
  return decision;
}

/**
 * Whether this module is the script node was asked to run. Both sides go
 * through realpath: node resolves symlinks in `import.meta.url` and not in
 * `argv[1]`, so a plugin reached through a linked `~/.claude` would otherwise
 * never run — and a Stop hook that silently does nothing is the worst failure
 * it has.
 */
function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  // Exit 0 always: the block is carried by the JSON above, and a non-zero exit
  // from a crash here must never be read as "block the stop".
  run().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
