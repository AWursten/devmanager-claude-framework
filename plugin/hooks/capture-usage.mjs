// capture-usage.mjs — how many tokens this session spent, from its transcript.
//
// Two callers. `stop-guard.mjs` imports it and writes the result next to the
// open task, in `~/.claude/devmanager-state/<project-id>/<task-number>/`. And the
// `work` skill runs it at a task's close, through the launcher that
// `session-start.mjs` leaves at `~/.claude/devmanager-state/capture-usage.mjs`:
//
//     node ~/.claude/devmanager-state/capture-usage.mjs --since <ISO> [--task <n>] [<transcript.jsonl>]
//
// `--since` is the task's start: the session's own transcript counts from then
// up to the moment of the count, there is no end to the window, and so, without
// `--task`, does every subagent's. `--task` (`12` or `#12`)
// changes how subagents are chosen, and only that: each one counts in full, at
// any hour, when the description it was launched with starts with `#<n>` — its
// own, or, for a subagent launched by another, the nearest ancestor's. The rest
// are left out and listed under `excludedSources`, never attributed by the
// hour. That is how a planner that ran before the task began is charged to it,
// and a reviewer of another task that ran inside its window is not. `--task`
// without `--since`, either of them malformed (`--since` is an ISO date with
// its time and zone), missing its value, or given twice, exits 1 with the
// reason on stderr and nothing on stdout. A subagent transcript that cannot be
// read is listed with `--task` as `unreadable`, and skipped without it, as
// before. Without either option the whole session counts, as before.
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
//   - Beside each `agent-<id>.jsonl` is an `agent-<id>.meta.json` with the
//     `agentType` and the `description` it was launched with. A subagent
//     launched by another one (`spawnDepth` 2) lands in the same flat folder,
//     with no `description` and a `parentAgentId` naming its parent's `<id>`.
//   - The session's transcript does not repeat what its subagents spent: it has
//     no sidechain lines and shares no `message.id` with them. Cutting it by
//     `--since` while counting a subagent in full counts nothing twice.
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

// ─── Which task a subagent worked for ────────────────────────────────────────

/** Date, `T`, time and zone: the shape of `startedAt`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether a value is an ISO 8601 instant that names a real moment. `Date.parse`
 * alone is not the test: V8 reads `"12"` as December 2001 and `"hello 5"` as
 * May 2001, and a cut there would charge a task the whole session. It also
 * rolls `02-30` over into March, so the day is checked against its month.
 */
export function isIsoInstant(value) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
}

/** A task number as the command line takes it: `12` or `#12`, a positive integer. */
export function parseTaskNumber(value) {
  if (typeof value !== "string") return null;
  const match = /^#?(\d+)$/.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * The task a description is labelled with, or null: `#<n>` at its start, with
 * no digit after it — so `#6` is not `#67 planner`, and `#12:` or `#12-x` is 12.
 */
export function taskOfDescription(description) {
  if (typeof description !== "string") return null;
  const match = /^#(\d+)(?!\d)/.exec(description.trim());
  return match ? Number(match[1]) : null;
}

/** An agent id as Claude Code writes it, checked before it becomes part of a path. */
const AGENT_ID = /^[A-Za-z0-9_-]+$/;

/** A subagent's `.meta.json`: `{ meta }`, or `{ error }` when it is missing or is not a JSON object. */
function readMeta(dir, source) {
  let text;
  try {
    text = readFileSync(path.join(dir, `${source}.meta.json`), "utf8");
  } catch {
    return { error: "meta-missing" };
  }
  try {
    const meta = JSON.parse(text);
    if (meta && typeof meta === "object" && !Array.isArray(meta)) return { meta };
  } catch {}
  return { error: "meta-corrupt" };
}

const stringOrNull = (value) => (typeof value === "string" ? value : null);

/**
 * The task a subagent's transcript belongs to, by its label alone and never by
 * the hour. Its own `description` decides when it carries `#<n>`; otherwise
 * the search climbs `parentAgentId` until one does. Returns `{ task }`, plus
 * `inheritedFrom` when an ancestor decided it, or `{ reason }`, plus `at` when
 * the chain broke at an ancestor. A chain that comes back to itself stops as
 * `cycle`. `description` and `agentType` are always the source's own.
 */
export function attributeSubagent(dir, source) {
  const own = readMeta(dir, source);
  const found = {
    description: stringOrNull(own.meta?.description),
    agentType: stringOrNull(own.meta?.agentType),
  };
  const seen = new Set();
  let current = source;
  let read = own;

  for (;;) {
    seen.add(current);
    const at = current === source ? {} : { at: current };
    if (read.error) return { ...found, reason: read.error, ...at };

    const task = taskOfDescription(read.meta.description);
    if (task !== null) return { ...found, task, ...(current === source ? {} : { inheritedFrom: current }) };

    const parent = read.meta.parentAgentId;
    if (parent === undefined || parent === null) return { ...found, reason: "unlabeled", ...at };
    if (typeof parent !== "string" || !AGENT_ID.test(parent)) return { ...found, reason: "meta-corrupt", ...at };

    current = `agent-${parent}`;
    if (seen.has(current)) return { ...found, reason: "cycle", at: current };
    read = readMeta(dir, current);
  }
}

/**
 * Total usage for a session: its own transcript plus, unless asked otherwise,
 * every subagent transcript beside it. Returns null when nothing is derivable.
 *
 * With `task` (a number), only the session's own transcript is cut by `since`;
 * a subagent counts in full when `attributeSubagent` gives it that task, and is
 * listed in `excludedSources` otherwise. `task` needs a `since` that is an ISO instant:
 * without one the session's share cannot be told apart, and the answer is null.
 */
export function captureUsage(transcriptPath, { includeSubagents = true, since, task } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  const byTask = task !== undefined && task !== null;
  if (byTask && (!Number.isSafeInteger(task) || task <= 0 || !isIsoInstant(since))) return null;

  let result = null;
  try {
    result = summarize(parseTranscript(readFileSync(transcriptPath, "utf8")), "main", { since });
  } catch {
    return null;
  }

  const excludedSources = [];
  if (includeSubagents) {
    const dir = subagentDir(transcriptPath);
    let files = [];
    try {
      files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
    } catch {
      files = [];
    }
    for (const file of files) {
      const label = path.basename(file, ".jsonl");
      let part = null;
      let unreadable = false;
      try {
        part = summarize(parseTranscript(readFileSync(path.join(dir, file), "utf8")), label, byTask ? {} : { since });
      } catch {
        // Without a task it is skipped, as before; with one it is listed, so a
        // subagent of the task that could not be read does not vanish unseen.
        if (!byTask) continue;
        unreadable = true;
      }

      if (byTask) {
        const { task: labelled, ...who } = attributeSubagent(dir, label);
        if (unreadable) {
          const { reason, at, inheritedFrom, ...described } = who;
          excludedSources.push({ source: label, ...described, reason: "unreadable", ...EMPTY() });
          continue;
        }
        if (labelled !== task) {
          const reason = labelled === undefined ? {} : { reason: "other-task", task: labelled };
          const totals = part ? part.bySource[label] : EMPTY();
          excludedSources.push({ source: label, ...who, ...reason, ...totals });
          continue;
        }
        if (part) Object.assign(part.bySource[label], who);
      }

      if (!part) continue;
      result = result ? mergeInto(result, part) : part;
    }
  }

  if (!result) return null;
  const extra = byTask ? { task, excludedSources } : {};
  return { ...result, since: since ?? null, ...extra, transcript: transcriptPath, capturedAt: new Date().toISOString() };
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
// one `<session-id>.jsonl` per session, so the path is derivable — but derived,
// not documented, so every failure here returns null and the caller logs time
// without tokens.
//
// Claude Code also sets `CLAUDE_CODE_SESSION_ID` in the shell of each session,
// and it matches the transcript's name. When it is there it names the file, and
// the search is by that name across every folder of `projects/`: with two
// sessions open in one repo, the newest transcript may be the other one's. Only
// when the variable is missing or empty does the search fall back to the newest
// transcript near `cwd`, which is a guess and so stays inside the repo. An id
// that is set but cannot be resolved is null, never a fallback to the guess.

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

/** A session id as Claude Code writes it: nothing that could be a separator or a dot. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The transcript of the session this runs in, or null.
 *
 * With `CLAUDE_CODE_SESSION_ID` set, the one `<id>.jsonl` under any folder of
 * `~/.claude/projects/`. An id that fails the pattern, is not found, or is found
 * in more than one folder is null: none of those says which session this is,
 * and the newest transcript would be the guess the id was there to avoid. The
 * pattern is checked before the id touches a path, so the id cannot climb out
 * of `projects/` or into a subfolder. A folder of `projects/` that is itself a
 * symlink or a junction is still followed, like any other folder there.
 *
 * Without it, or with it empty, `findLatestTranscript`.
 */
export function findSessionTranscript({ env = process.env, home = os.homedir(), cwd = process.cwd() } = {}) {
  const id = env.CLAUDE_CODE_SESSION_ID;
  if (id === undefined || id === "") return findLatestTranscript({ cwd, home });
  if (typeof id !== "string" || !SESSION_ID.test(id)) return null;

  const projects = path.join(home, ".claude", "projects");
  let folders = [];
  try {
    folders = readdirSync(projects);
  } catch {
    return null;
  }

  const found = [];
  for (const folder of folders) {
    const file = path.join(projects, folder, `${id}.jsonl`);
    try {
      if (statSync(file).isFile()) found.push(file);
    } catch {
      // Not in this folder, or not a folder at all.
    }
  }
  return found.length === 1 ? found[0] : null;
}

/** captureUsage against the current session's transcript, located by convention. */
export function captureCurrentUsage(options = {}) {
  const transcript = findSessionTranscript(options);
  return transcript ? captureUsage(transcript, options) : null;
}

/**
 * The command line's arguments: `{ since, task, given }`, or `{ error }` with
 * the reason it cannot run. A value that is missing or malformed, or an
 * option given twice, is an error, and so is `--task` without `--since`: a
 * count taken from a guess would be logged as if it were the task's.
 */
export function parseArgs(argv) {
  let since;
  let task;
  let given;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since") {
      if (i + 1 >= argv.length) return { error: "--since needs a value: the task's start, as an ISO date" };
      if (since !== undefined) return { error: "--since is given more than once" };
      since = argv[++i];
      if (!isIsoInstant(since)) {
        return { error: `--since ${JSON.stringify(since)} is not an ISO date with its time and zone, as 2026-09-30T13:00:00.000Z` };
      }
    } else if (arg === "--task") {
      if (task !== undefined) return { error: "--task is given more than once" };
      if (i + 1 >= argv.length) return { error: "--task needs a value: the task's number, as 12 or #12" };
      const value = argv[++i];
      task = parseTaskNumber(value);
      if (task === null) return { error: `--task ${JSON.stringify(value)} is not a task number: use 12 or #12` };
    } else {
      given = arg;
    }
  }
  if (task !== undefined && since === undefined) return { error: "--task needs --since: the task's start" };
  return { since, task, given };
}

/**
 * The command line: `--since <ISO> [--task <n>] [<transcript.jsonl>]`, where
 * `--since` may be left out only without `--task`, to count the whole session.
 * Prints the capture and, under `logTime`, the same numbers in the shape
 * `log_time` takes — or `null` when nothing is derivable, which is the cue to
 * log time without tokens. Arguments it cannot use print nothing on stdout,
 * the reason on stderr, and set the exit code to 1.
 *
 * Exported because the `work` skill does not run this file directly: it runs
 * the launcher the SessionStart hook leaves in the state folder, which imports
 * this and calls it. The plugin's install path is not something a session knows.
 * `options` takes `env` (by default `process.env`), `home`, `cwd` and `stderr`.
 */
export function main(argv = process.argv.slice(2), { env = process.env, stderr = process.stderr, ...options } = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    stderr.write(`capture-usage: ${args.error}\n`);
    process.exitCode = 1;
    return null;
  }
  const { since, task, given } = args;
  const usage = given ? captureUsage(given, { since, task }) : captureCurrentUsage({ ...options, env, since, task });
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
