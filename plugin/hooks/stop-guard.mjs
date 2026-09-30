// stop-guard.mjs — the Stop hook. It will not let a session end in the middle
// of a DevManager task.
//
// While the `work` skill has a task open it keeps
// `~/.claude/devmanager-state/<project-id>/<task-number>/current-task.json`, with the
// repository the task was started in. If a session working inside that
// repository tries to stop with the file still there, the board is about to
// start lying: a task sits in progress that nobody is working, with no
// documentation check, no closing comment and no time logged. So the guard
// captures the session's token usage (for the close to log), writes it next to
// the task, and blocks the stop with the list of what closing still requires.
//
// DECISION — loop safety. The guard honours `stop_hook_active` when the runtime
// sends it, and on top of that limits itself: MAX_BLOCKS refusals per task,
// counted in `stop-guard.json` next to the task and reset when the open task
// changes. After that it gets out of the way. A guard that can hold a session
// forever is worse than the state it is guarding.

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
import { captureUsage } from "./capture-usage.mjs";

export const MAX_BLOCKS = 2;

/** Identity of the open task, so the block counter resets when a new one opens. */
export function taskKey(currentTask) {
  if (!currentTask) return null;
  return [currentTask.project, currentTask.task, currentTask.startedAt].join("@");
}

export function blockReason(currentTask, dir) {
  const number = currentTask?.task ?? "the open task";
  const file = dir ? path.join(dir, "current-task.json") : "current-task.json";
  return [
    `Task ${number} is still open — ${file} exists, so this session has not closed it.`,
    "",
    "Finish step 8 of the `work` skill before stopping:",
    "  1. Documentation check — read the project's documents against what you built, fix what the",
    "     work made false (upsert_document), and keep the result for docs_check.",
    "  2. add_comment — what was done, decisions taken, deviations from the plan, what to verify.",
    '  3. log_time — the minutes, and the tokens that `node ~/.claude/devmanager-state/capture-usage.mjs --since <startedAt>`',
    '     prints under logTime (null or an error: log the time without tokens), source: "AI".',
    "  4. submit_for_review with docs_check — the state transition. Never complete_task unless the",
    "     project has no review column and the human said to close fully.",
    `  5. Delete ${file}.`,
    "",
    "If the task cannot be finished, that is also a close: say why in a comment, log the time spent,",
    "leave the task where it belongs, and delete the state file. What is not allowed is silence.",
    "",
    "If you are only waiting for the person's answer, or this session is not the one working that task,",
    `say so and stop again: the guard steps aside after ${MAX_BLOCKS} refusals.`,
  ].join("\n");
}

/**
 * The whole decision, as a pure function. `guard` is the previous
 * stop-guard.json; the returned `guard` is what should replace it.
 */
export function decide({ currentTask, dir = null, guard, stopHookActive = false, maxBlocks = MAX_BLOCKS }) {
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
    reason: blockReason(currentTask, dir),
    guard: { taskKey: key, blocks: blocks + 1, lastBlockedAt: new Date().toISOString() },
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
    const usage = captureUsage(input.transcript_path, { since: open.task.startedAt });
    if (usage) writeState(open.dir, LAST_USAGE, { ...usage, sessionId: input.session_id ?? null });
  }

  const decision = decide({
    currentTask: open?.task ?? null,
    dir: open?.dir ?? null,
    guard: open ? readState(open.dir, STOP_GUARD) : null,
    stopHookActive: input.stop_hook_active === true,
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
