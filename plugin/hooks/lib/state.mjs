// ~/.claude/devmanager-state/<project-id>/<task-number>/*.json — the small
// amount of state a session carries between the `work` skill that opens a task
// and the hook that refuses to let it end.
//
// It lives in the user's home and not in the repository, one folder per
// DevManager project, so installing the plugin touches nobody's `.gitignore`.
// Inside it, one folder per open task: two worktrees of the same project can each
// have a task open without overwriting each other's file. The price is that the
// hook no longer knows the folder up front: it finds the open task by the `cwd`
// the skill recorded in it (see `findOpenTask`).
//
// Nothing in here is shared, durable, or worth recovering: if a file is missing
// or corrupt the answer is always "act as if there is no state", never "throw
// inside a hook". A hook that crashes on a half-written JSON file would block
// every stop on the machine.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CURRENT_TASK = "current-task.json";
export const LAST_USAGE = "last-usage.json";
export const STOP_GUARD = "stop-guard.json";

/**
 * Where every project's folder lives. `DEVMANAGER_STATE_DIR` overrides it, which
 * is what the tests use; nothing else should need to.
 */
export function stateRoot(env = process.env, home = os.homedir()) {
  return env.DEVMANAGER_STATE_DIR || path.join(home, ".claude", "devmanager-state");
}

/** The parsed file, or null — missing, unreadable and malformed are all null. */
export function readState(dir, name) {
  try {
    const value = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** Write the file, creating the folder. Returns false instead of throwing. */
export function writeState(dir, name, value) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Remove the file if it is there. Returns whether anything was removed. */
export function clearState(dir, name) {
  try {
    const file = path.join(dir, name);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Case-insensitive on Windows, where the same folder has many spellings. */
function normalize(p) {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Whether `inner` is `outer` or somewhere below it. */
export function isInside(inner, outer) {
  const a = normalize(inner);
  const b = normalize(outer);
  if (a === b) return true;
  const rel = path.relative(b, a);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The subfolders of a folder, or none — a missing or unreadable one is empty. */
function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * The task this session has open, or null.
 *
 * A task belongs to the session whose working directory is inside the
 * repository the task was started in — the `cwd` that `work` writes into
 * `current-task.json`. A task with no `cwd` is ignored: without it there is no
 * way to tell it from one open in another repository on the same machine, and
 * blocking the wrong session is worse than not blocking.
 *
 * With more than one match (two tasks open in the same repository) the most
 * recently started wins, so the guard still names one task instead of none.
 */
export function findOpenTask(root, cwd) {
  if (!cwd) return null;

  let best = null;
  for (const projectDir of subdirs(root)) {
    for (const dir of subdirs(projectDir)) {
      const task = readState(dir, CURRENT_TASK);
      if (!task || typeof task.cwd !== "string" || !isInside(cwd, task.cwd)) continue;
      const started = Date.parse(task.startedAt) || 0;
      if (!best || started > best.started) best = { dir, task, started };
    }
  }
  return best ? { dir: best.dir, task: best.task } : null;
}

/** Read the hook's input JSON from stdin. Never rejects: an unparseable payload is {}. */
export async function readHookInput(stream = process.stdin) {
  try {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const raw = Buffer.concat(chunks.map(Buffer.from)).toString("utf8").trim();
    if (!raw) return {};
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
