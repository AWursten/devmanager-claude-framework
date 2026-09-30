// session-start.mjs — the SessionStart hook. It leaves a launcher for the token
// counter where the `work` skill can find it.
//
// The skill measures a task's tokens at its close, mid-turn, by running
// capture-usage with `--since` the task's start. It cannot run the plugin's copy
// directly: where a plugin is installed is not something a session knows, and
// ${CLAUDE_PLUGIN_ROOT} only exists for hooks. So this hook writes
// `~/.claude/devmanager-state/capture-usage.mjs`, a two-line module that imports
// the plugin's and calls it, and rewrites it whenever the plugin moves (an
// update installs it somewhere else).
//
// Like the Stop hook it never fails a session: any error is swallowed, and it
// prints nothing.

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stateRoot } from "./lib/state.mjs";

export const LAUNCHER = "capture-usage.mjs";

/** The launcher's source, pointing at this plugin's capture-usage. */
export function launcherSource(captureUsagePath) {
  const url = pathToFileURL(captureUsagePath).href;
  return [
    "// Written by the devmanager plugin at session start. Do not edit: it is rewritten.",
    `import { main } from ${JSON.stringify(url)};`,
    "main();",
    "",
  ].join("\n");
}

/** Write the launcher if it is missing or points elsewhere. Returns its path, or null. */
export function ensureLauncher({ env = process.env, captureUsagePath } = {}) {
  try {
    const target =
      captureUsagePath ??
      realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "capture-usage.mjs"));
    const root = stateRoot(env);
    const file = path.join(root, LAUNCHER);
    const source = launcherSource(target);
    let current = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {}
    if (current !== source) {
      mkdirSync(root, { recursive: true });
      writeFileSync(file, source);
    }
    return file;
  } catch {
    return null;
  }
}

function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  ensureLauncher();
  process.exit(0);
}
