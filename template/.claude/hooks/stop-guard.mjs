// stop-guard.mjs — the Stop hook. It will not let a session end in the middle
// of a DevManager task.
//
// While `/work` has a task open it keeps `.claude/state/current-task.json`.
// If the session tries to stop with that file still there, the board is about
// to start lying: a task sits in progress that nobody is working, with no
// closing comment and no time logged. So the guard captures the session's token
// usage (for the close to log), writes it to `.claude/state/last-usage.json`,
// and blocks the stop with the list of what closing still requires.
//
// DECISION — loop safety. The spec said to respect "the docs' mechanism" for a
// blocked stop that re-runs. The current hooks documentation does not list
// `stop_hook_active` among the input fields, so the guard cannot rely on it
// being there. It reads the field anyway when present, and on top of that
// limits itself: MAX_BLOCKS refusals per task, counted in
// `.claude/state/stop-guard.json` and reset when the open task changes. After
// that it gets out of the way. A guard that can hold a session forever is worse
// than the state it is guarding.

import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  CURRENT_TASK,
  LAST_USAGE,
  STOP_GUARD,
  projectDir,
  readState,
  writeState,
  readHookInput,
} from "./lib/state.mjs";
import { captureUsage } from "./capture-usage.mjs";

export const MAX_BLOCKS = 2;

/** Identity of the open task, so the block counter resets when a new one opens. */
export function taskKey(currentTask) {
  if (!currentTask) return null;
  return [currentTask.project, currentTask.task, currentTask.startedAt].join("@");
}

export function blockReason(currentTask) {
  const number = currentTask?.task ?? "the open task";
  return [
    `Task ${number} is still open — .claude/state/current-task.json exists, so this session has not closed it.`,
    "",
    "Finish step 8 of /work before stopping:",
    "  1. add_comment — what was done, decisions taken, deviations from the plan, what to verify.",
    "  2. log_time — the minutes, plus the tokens from .claude/state/last-usage.json, source: \"AI\".",
    "  3. submit_for_review — the state transition. Never complete_task unless the project has no",
    "     review column and the human said to close fully.",
    "  4. Clear .claude/state/current-task.json.",
    "",
    "If the task cannot be finished, that is also a close: say why in a comment, log the time spent,",
    "leave the task where it belongs, and clear the state file. What is not allowed is silence.",
  ].join("\n");
}

/**
 * The whole decision, as a pure function. `guard` is the previous
 * stop-guard.json; the returned `guard` is what should replace it.
 */
export function decide({ currentTask, guard, stopHookActive = false, maxBlocks = MAX_BLOCKS }) {
  if (!currentTask) {
    return { block: false, reason: null, guard: null, why: "no open task" };
  }

  const key = taskKey(currentTask);
  const blocks = guard?.taskKey === key ? Number(guard.blocks) || 0 : 0;

  // Honoured when the runtime provides it; the counter below is what actually
  // guarantees termination.
  if (stopHookActive) {
    return { block: false, reason: null, guard: { taskKey: key, blocks }, why: "stop hook already active" };
  }

  if (blocks >= maxBlocks) {
    return {
      block: false,
      reason: null,
      guard: { taskKey: key, blocks },
      why: `already blocked ${blocks} time(s) for this task`,
    };
  }

  return {
    block: true,
    reason: blockReason(currentTask),
    guard: { taskKey: key, blocks: blocks + 1, lastBlockedAt: new Date().toISOString() },
    why: "task still open",
  };
}

/** What the hook prints on stdout. Both shapes, because both are documented. */
export function output(decision) {
  if (!decision.block) return null;
  return {
    decision: "block",
    reason: decision.reason,
    hookSpecificOutput: {
      hookEventName: "Stop",
      decision: "block",
      reason: decision.reason,
    },
    systemMessage: "A DevManager task is still open. Close it before ending the session.",
  };
}

export async function run({ stdin = process.stdin, env = process.env } = {}) {
  const input = await readHookInput(stdin);
  const root = projectDir(input, env);

  const currentTask = readState(root, CURRENT_TASK);

  // Capture usage even when the stop is allowed: the numbers are cheap to take
  // and the close may be happening in this very turn.
  if (currentTask) {
    const usage = captureUsage(input.transcript_path);
    if (usage) writeState(root, LAST_USAGE, { ...usage, sessionId: input.session_id ?? null });
  }

  const decision = decide({
    currentTask,
    guard: readState(root, STOP_GUARD),
    stopHookActive: input.stop_hook_active === true,
  });

  if (decision.guard) writeState(root, STOP_GUARD, decision.guard);

  const payload = output(decision);
  if (payload) process.stdout.write(`${JSON.stringify(payload)}\n`);
  return decision;
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  // Exit 0 always: the block is carried by the JSON above, and a non-zero exit
  // from a crash here must never be read as "block the stop".
  run().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
