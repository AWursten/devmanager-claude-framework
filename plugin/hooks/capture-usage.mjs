// capture-usage.mjs — how many tokens this session spent, from its transcript.
//
// Two callers. `stop-guard.mjs` imports it and writes the result next to the
// open task, in `~/.claude/devmanager-state/<project-id>/<task-number>/`. And the
// `work` skill runs it at a task's close, through the launcher that
// `session-start.mjs` leaves at `~/.claude/devmanager-state/capture-usage.mjs`:
//
//     node ~/.claude/devmanager-state/capture-usage.mjs --since <ISO> [<transcript.jsonl>]
//
// VERIFIED against a real transcript (Claude Code 2.x) rather than assumed:
//
//   - The transcript is JSONL. Usage lives on lines with `type: "assistant"`,
//     under `message.usage`, with the model at `message.model`.
//   - A single assistant message is written out ONCE PER CONTENT BLOCK — text,
//     thinking, each tool_use — and every one of those lines repeats the same
//     `message.id` and the same `requestId`. Summing the lines therefore
//     multiplies the real cost by two to four. Counting each message once is not
//     an optimisation here, it is the correctness of the whole file.
//   - Which of those lines to count matters too. Two formats live side by side.
//     In one, every line repeats the final usage: older versions wrote only
//     that, and it is still what a session's main transcript shows. In the
//     other, seen so far in subagent transcripts, the lines are written as the
//     message streams in: input and cache are the same on all of them, but the
//     output count grows, and only the LAST line carries the final one — 8 on
//     the first line against 3,492 on the last, in a reviewer's report.
//     Keeping the last line with usage is right for both.
//   - `usage.iterations[]` breaks a request into its internal steps and repeats
//     the same numbers; it is ignored for the same reason.
//   - Subagent transcripts are separate files, under
//     `<dir>/<session-id>/subagents/agent-*.jsonl`. `work` delegates almost
//     everything to subagents, so a total that ignored them would be a small
//     fraction of the truth. They are summed in, and kept separately per source
//     so a batch can attribute them.
//
// If usage cannot be derived, this returns null. `work` then logs time without
// tokens: an absent number is honest, an invented one is not.

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EMPTY = () => ({
  tokensIn: 0,
  tokensOut: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  messages: 0,
});

function add(into, usage) {
  into.tokensIn += int(usage.input_tokens);
  into.tokensOut += int(usage.output_tokens);
  into.tokensCacheRead += int(usage.cache_read_input_tokens);
  into.tokensCacheWrite += int(usage.cache_creation_input_tokens);
  into.messages += 1;
  return into;
}

function int(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** JSONL → parsed objects, skipping anything that does not parse. */
export function parseTranscript(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object") out.push(value);
    } catch {
      // A transcript being appended to while we read it ends in a partial line.
    }
  }
  return out;
}

/**
 * The usage lines of a transcript that count: one per message, the LAST line of
 * it that carries usage (see the header), in the order each message first
 * appeared. A line with no key at all cannot be matched to another, so it is
 * kept on its own.
 *
 * `since` (an ISO date) is applied line by line, before choosing: a message
 * that straddles the cut is counted from the lines after it, which include its
 * final one. That holds while a message's timestamps only move forward, as in
 * every transcript observed: if its final line fell before the cut and a
 * partial one after it, the partial would count and the total would fall short.
 */
export function lastUsagePerMessage(entries, { since } = {}) {
  const from = since ? Date.parse(since) : NaN;
  const lines = new Map();

  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const usage = entry.message?.usage;
    if (!usage || typeof usage !== "object") continue;
    if (!Number.isNaN(from)) {
      const at = Date.parse(entry.timestamp);
      if (Number.isNaN(at) || at < from) continue;
    }

    const id = entry.message.id ?? entry.requestId ?? entry.uuid;
    // A Map keeps the position of the first set, so overwriting keeps the order.
    lines.set(id === undefined ? Symbol() : id, entry);
  }

  return [...lines.values()];
}

/**
 * Sum one transcript's entries. `source` labels where they came from, so a
 * caller can attribute a batch across the subagents that did the work.
 *
 * `since` (an ISO date) keeps only what was spent from that moment on: it is
 * how a close counts the tokens of ITS task and not of the whole session. An
 * entry without a timestamp cannot be placed, so with `since` it is left out —
 * an undercount says so, an overcount does not.
 */
export function summarize(entries, source = "main", { since } = {}) {
  const totals = EMPTY();
  const byModel = {};

  for (const entry of lastUsagePerMessage(entries, { since })) {
    const { usage, model } = entry.message;
    add(totals, usage);
    add((byModel[model ?? "unknown"] ??= EMPTY()), usage);
  }

  return totals.messages === 0 ? null : { ...totals, byModel, bySource: { [source]: { ...totals } } };
}

/** Where a session's subagent transcripts live, given the session transcript. */
export function subagentDir(transcriptPath) {
  const dir = path.dirname(transcriptPath);
  const base = path.basename(transcriptPath, path.extname(transcriptPath));
  return path.join(dir, base, "subagents");
}

function mergeInto(target, other) {
  for (const key of ["tokensIn", "tokensOut", "tokensCacheRead", "tokensCacheWrite", "messages"]) {
    target[key] += other[key];
  }
  for (const [model, totals] of Object.entries(other.byModel)) {
    const into = (target.byModel[model] ??= EMPTY());
    for (const key of Object.keys(totals)) into[key] += totals[key];
  }
  Object.assign(target.bySource, other.bySource);
  return target;
}

/**
 * Total usage for a session: its own transcript plus, unless asked otherwise,
 * every subagent transcript beside it. Returns null when nothing is derivable.
 */
export function captureUsage(transcriptPath, { includeSubagents = true, since } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  let result = null;
  try {
    result = summarize(parseTranscript(readFileSync(transcriptPath, "utf8")), "main", { since });
  } catch {
    return null;
  }

  if (includeSubagents) {
    const dir = subagentDir(transcriptPath);
    let files = [];
    try {
      files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
    } catch {
      files = [];
    }
    for (const file of files) {
      let part = null;
      try {
        const label = path.basename(file, ".jsonl");
        part = summarize(parseTranscript(readFileSync(path.join(dir, file), "utf8")), label, { since });
      } catch {
        continue;
      }
      if (!part) continue;
      result = result ? mergeInto(result, part) : part;
    }
  }

  if (!result) return null;
  return { ...result, since: since ?? null, transcript: transcriptPath, capturedAt: new Date().toISOString() };
}

/**
 * The `tokens` argument of DevManager's `log_time`, straight from a capture.
 * `usageJson` carries the per-model and per-source breakdown, which is what
 * makes a number auditable months later.
 */
export function toLogTimeTokens(usage) {
  if (!usage) return null;
  return {
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    tokensCacheRead: usage.tokensCacheRead,
    tokensCacheWrite: usage.tokensCacheWrite,
    usageJson: {
      byModel: usage.byModel,
      bySource: usage.bySource,
      messages: usage.messages,
      capturedAt: usage.capturedAt,
    },
  };
}

/** "claude-code/<model>" for log_time's `tool`, from the model that did most of the output. */
export function primaryModel(usage) {
  if (!usage?.byModel) return null;
  const entries = Object.entries(usage.byModel).filter(([model]) => model !== "unknown");
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1].tokensOut - a[1].tokensOut);
  return entries[0][0];
}

// ─── Finding the transcript without a hook to hand you the path ─────────────
//
// The Stop hook is given `transcript_path`. `work` closing a task is not: it
// is still mid-session. Claude Code stores transcripts under
// `~/.claude/projects/<cwd with every non-alphanumeric run turned into ->/`,
// so the path is derivable — but derived, not documented, so every failure here
// returns null and the caller logs time without tokens.

export function projectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The most recently modified session transcript for a working directory, or
 * null. Claude Code files a session under the directory it STARTED in, and the
 * shell that runs this may have moved into a subdirectory since — so the search
 * walks up from `cwd` and stops at the nearest directory that has transcripts.
 *
 * It never climbs past the root of the repository it is in (the first directory
 * with a `.git`, which a worktree also has): above that the transcripts belong
 * to other sessions, and taking one would log someone else's tokens. Null is
 * the honest answer there.
 */
export function findLatestTranscript({ cwd = process.cwd(), home = os.homedir() } = {}) {
  let dir = path.resolve(cwd);
  for (;;) {
    const found = latestIn(dir, home);
    if (found) return found;
    if (existsSync(path.join(dir, ".git"))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The newest transcript filed under exactly this directory, or null. */
function latestIn(cwd, home) {
  const candidates = new Set([projectSlug(cwd), projectSlug(cwd.toLowerCase())]);
  let best = null;

  for (const slug of candidates) {
    const dir = path.join(home, ".claude", "projects", slug);
    let files = [];
    try {
      if (!existsSync(dir)) continue;
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const mtime = statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { path: full, mtime };
      } catch {
        // Raced with a delete; the next candidate is as good.
      }
    }
  }

  return best?.path ?? null;
}

/** captureUsage against the current session's transcript, located by convention. */
export function captureCurrentUsage(options = {}) {
  const transcript = findLatestTranscript(options);
  return transcript ? captureUsage(transcript, options) : null;
}

/**
 * The command line: `[--since <ISO>] [<transcript.jsonl>]`. Prints the capture
 * and, under `logTime`, the same numbers in the shape `log_time` takes — or
 * `null` when nothing is derivable, which is the cue to log time without tokens.
 *
 * Exported because the `work` skill does not run this file directly: it runs
 * the launcher the SessionStart hook leaves in the state folder, which imports
 * this and calls it. The plugin's install path is not something a session knows.
 */
export function main(argv = process.argv.slice(2), options = {}) {
  let since;
  let given;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since") since = argv[++i];
    else given = argv[i];
  }
  const usage = given ? captureUsage(given, { since }) : captureCurrentUsage({ ...options, since });
  const out = usage ? { ...usage, logTime: toLogTimeTokens(usage) } : null;
  console.log(JSON.stringify(out, null, 2));
  return out;
}

/** Whether this module is the script node was asked to run, symlinks resolved. */
function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) main();
