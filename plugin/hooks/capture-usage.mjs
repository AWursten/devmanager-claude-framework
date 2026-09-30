// capture-usage.mjs — how many tokens this session spent, from its transcript.
//
// Not a hook of its own: `stop-guard.mjs` calls it, writes the result to
// `~/.claude/devmanager-state/<project-id>/last-usage.json`, and the `work`
// skill logs those numbers with the task's time. It is also runnable by hand for
// debugging, from wherever the plugin is installed:
//
//     node <plugin>/hooks/capture-usage.mjs <transcript.jsonl>
//
// VERIFIED against a real transcript (Claude Code 2.x) rather than assumed:
//
//   - The transcript is JSONL. Usage lives on lines with `type: "assistant"`,
//     under `message.usage`, with the model at `message.model`.
//   - A single assistant message is written out ONCE PER CONTENT BLOCK — text,
//     thinking, each tool_use — and every one of those lines repeats the same
//     `message.id`, the same `requestId` and the same `usage` object. Summing
//     the lines therefore multiplies the real cost by two to four. Deduplicating
//     by `message.id` is not an optimisation here, it is the correctness of the
//     whole file.
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

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
 * Sum one transcript's entries. `source` labels where they came from, so a
 * caller can attribute a batch across the subagents that did the work.
 */
export function summarize(entries, source = "main") {
  const totals = EMPTY();
  const byModel = {};
  const seen = new Set();

  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    const message = entry.message;
    const usage = message?.usage;
    if (!usage || typeof usage !== "object") continue;

    // See the header: one message, many lines, identical usage on each.
    const id = message.id ?? entry.requestId ?? entry.uuid;
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }

    add(totals, usage);
    const model = message.model ?? "unknown";
    add((byModel[model] ??= EMPTY()), usage);
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
export function captureUsage(transcriptPath, { includeSubagents = true } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  let result = null;
  try {
    result = summarize(parseTranscript(readFileSync(transcriptPath, "utf8")), "main");
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
        part = summarize(parseTranscript(readFileSync(path.join(dir, file), "utf8")), label);
      } catch {
        continue;
      }
      if (!part) continue;
      result = result ? mergeInto(result, part) : part;
    }
  }

  if (!result) return null;
  return { ...result, transcript: transcriptPath, capturedAt: new Date().toISOString() };
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

/** The most recently modified session transcript for a working directory, or null. */
export function findLatestTranscript({ cwd = process.cwd(), home = os.homedir() } = {}) {
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

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const [given] = process.argv.slice(2);
  const usage = given ? captureUsage(given) : captureCurrentUsage();
  console.log(JSON.stringify(usage, null, 2));
}
