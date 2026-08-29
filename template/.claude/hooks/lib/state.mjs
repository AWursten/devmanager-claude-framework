// .claude/state/*.json — the small amount of state a session carries between
// the skill that opens a task and the hook that refuses to let it end.
//
// The directory is gitignored. Nothing in here is shared, durable, or worth
// recovering: if a file is missing or corrupt the answer is always "act as if
// there is no state", never "throw inside a hook". A hook that crashes on a
// half-written JSON file would block every stop in the repo.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

export const CURRENT_TASK = "current-task.json";
export const LAST_USAGE = "last-usage.json";
export const STOP_GUARD = "stop-guard.json";

/**
 * The project root, from the hook environment. `CLAUDE_PROJECT_DIR` is what
 * Claude Code exports for hooks; `cwd` comes from the hook's input JSON and is
 * the fallback when a hook is run by hand or by a test.
 */
export function projectDir(input = {}, env = process.env) {
  return env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

export function stateDir(root) {
  return path.join(root, ".claude", "state");
}

export function statePath(root, name) {
  return path.join(stateDir(root), name);
}

/** The parsed file, or null — missing, unreadable and malformed are all null. */
export function readState(root, name) {
  try {
    const raw = readFileSync(statePath(root, name), "utf8");
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** Write the file, creating the directory. Returns false instead of throwing. */
export function writeState(root, name, value) {
  try {
    mkdirSync(stateDir(root), { recursive: true });
    writeFileSync(statePath(root, name), `${JSON.stringify(value, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Remove the file if it is there. Returns whether anything was removed. */
export function clearState(root, name) {
  try {
    const file = statePath(root, name);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
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
