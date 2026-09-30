// Builds the transcript fixtures. Kept as a script so the shape they assert is
// written once and stays readable, instead of being a wall of pasted JSONL.
//
//     node test/fixtures/make-fixtures.mjs
//
// The shapes here were copied from a real Claude Code transcript — in
// particular the part that matters: one assistant message emitted as several
// lines carrying the same message.id. The older fixtures repeat the same usage
// on every line, as older Claude Code did, so that format stays covered. The
// "partial" ones are written the way current Claude Code writes them: the
// output count grows line by line and only the last line has the final one.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function usage({ input = 2, output = 100, cacheRead = 1000, cacheWrite = 500 }) {
  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    output_tokens_details: { thinking_tokens: 0 },
    service_tier: "standard",
    iterations: [
      {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        type: "message",
      },
    ],
  };
}

/**
 * One assistant message, split across `blocks` lines exactly as Claude Code
 * writes it. `partial` lists the output count of each line before the last,
 * which carries `output`; without it every line repeats the same usage.
 * `timestamps` gives each line its own time.
 */
function assistant({ id, model, blocks = 1, partial, timestamps, ...rest }) {
  const shared = usage(rest);
  return Array.from({ length: blocks }, (_, i) => ({
    type: "assistant",
    uuid: `${id}-line-${i}`,
    requestId: `req_${id}`,
    timestamp: timestamps?.[i] ?? "2026-08-29T12:00:00.000Z",
    message: {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "…" }],
      usage: partial && i < blocks - 1 ? usage({ ...rest, output: partial[i] }) : shared,
    },
  }));
}

function user(text) {
  return { type: "user", uuid: `u-${text}`, message: { role: "user", content: text } };
}

function write(name, entries) {
  mkdirSync(path.dirname(path.join(HERE, name)), { recursive: true });
  writeFileSync(path.join(HERE, name), entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

// One model, three messages, the middle one written across four content blocks.
// Truth: in 6, out 900, cacheRead 6000, cacheWrite 1500, 3 messages.
write("transcript-basic.jsonl", [
  user("do the thing"),
  ...assistant({ id: "a1", model: "claude-opus-5", output: 200, input: 2, cacheRead: 1000, cacheWrite: 500 }),
  ...assistant({ id: "a2", model: "claude-opus-5", blocks: 4, output: 300, input: 2, cacheRead: 2000, cacheWrite: 500 }),
  { type: "file-history-snapshot", uuid: "snap" },
  ...assistant({ id: "a3", model: "claude-opus-5", blocks: 2, output: 400, input: 2, cacheRead: 3000, cacheWrite: 500 }),
]);

// Two models in one session.
write("transcript-multimodel.jsonl", [
  user("start"),
  ...assistant({ id: "b1", model: "claude-opus-5", blocks: 2, output: 500, input: 10, cacheRead: 100, cacheWrite: 50 }),
  ...assistant({ id: "b2", model: "claude-haiku-4-5-20251001", output: 25, input: 5, cacheRead: 40, cacheWrite: 10 }),
]);

// A session that never got an assistant turn with usage.
write("transcript-no-usage.jsonl", [
  user("hello"),
  { type: "assistant", uuid: "c1", message: { id: "msg_c1", role: "assistant", model: "claude-opus-5", content: [] } },
]);

// A transcript being appended to as we read it: last line is half written.
writeFileSync(
  path.join(HERE, "transcript-truncated.jsonl"),
  [
    JSON.stringify(user("hi")),
    JSON.stringify(assistant({ id: "d1", model: "claude-opus-5", output: 70, input: 1, cacheRead: 10, cacheWrite: 5 })[0]),
    '{"type":"assistant","message":{"id":"msg_d2","usa',
  ].join("\n"),
);

// A subagent's own transcript, which lives beside the session's.
write("session-with-subagents/subagents/agent-planner.jsonl", [
  ...assistant({ id: "s1", model: "claude-opus-5", blocks: 3, output: 150, input: 1, cacheRead: 800, cacheWrite: 200 }),
]);
write("session-with-subagents/subagents/agent-implementer.jsonl", [
  ...assistant({ id: "s2", model: "claude-opus-5", output: 350, input: 1, cacheRead: 900, cacheWrite: 300 }),
]);
write("session-with-subagents.jsonl", [
  user("/work #12"),
  ...assistant({ id: "m1", model: "claude-opus-5", blocks: 2, output: 60, input: 2, cacheRead: 500, cacheWrite: 100 }),
]);

// The current format: two models, each message streamed across lines whose
// output grows, one second apart. The reviewer's report went 8 → 8 → 3,492.
// Truth: in 7, out 3612, cacheRead 30040, cacheWrite 7010, 2 messages.
write("transcript-partial-output.jsonl", [
  user("review #12"),
  ...assistant({
    id: "p1",
    model: "claude-opus-5",
    blocks: 3,
    partial: [8, 8],
    output: 3492,
    input: 2,
    cacheRead: 30000,
    cacheWrite: 7000,
    timestamps: ["2026-09-30T12:00:00.000Z", "2026-09-30T12:00:01.000Z", "2026-09-30T12:00:02.000Z"],
  }),
  ...assistant({
    id: "p2",
    model: "claude-haiku-4-5-20251001",
    blocks: 2,
    partial: [5],
    output: 120,
    input: 5,
    cacheRead: 40,
    cacheWrite: 10,
    timestamps: ["2026-09-30T12:01:00.000Z", "2026-09-30T12:01:01.000Z"],
  }),
]);

// A session in the current format whose subagent writes one long report.
// Truth: main out 60, agent-reviewer out 3492.
write("session-partial-output/subagents/agent-reviewer.jsonl", [
  ...assistant({ id: "r1", model: "claude-opus-5", blocks: 3, partial: [8, 8], output: 3492, input: 2, cacheRead: 900, cacheWrite: 300 }),
]);
write("session-partial-output.jsonl", [
  user("/work #12"),
  ...assistant({ id: "n1", model: "claude-opus-5", blocks: 2, partial: [10], output: 60, input: 2, cacheRead: 500, cacheWrite: 100 }),
]);

/** A subagent's `.meta.json`, in the shape Claude Code writes beside its transcript. */
function meta(name, fields) {
  mkdirSync(path.dirname(path.join(HERE, name)), { recursive: true });
  writeFileSync(path.join(HERE, name), JSON.stringify({ ...fields, requestShape: "background", requestNonInteractive: true }));
}

/** A subagent of the batch: its transcript in the current format, and its meta. */
function subagent(id, { description, agentType, at, output }) {
  write(`session-batch/subagents/agent-${id}.jsonl`, [
    ...assistant({ id, model: "claude-opus-5", blocks: 2, partial: [8], output, input: 1, cacheRead: 100, cacheWrite: 10, timestamps: [at, at] }),
  ]);
  meta(`session-batch/subagents/agent-${id}.meta.json`, { agentType, description, toolUseId: `toolu_${id}`, spawnDepth: 1 });
}

// A batch of #12 and #13, the way `work-batch` runs it: both planners first,
// then #12 starts at 13:00 and #13 at 14:00 — but #13's reviewer ran inside
// #12's window. Truth, `--task 12 --since 13:00`: main 60 (its 12:00 message is
// before the start), planner 300 and implementer 500 of #12, in full; #13's
// planner (310) and reviewer (700) left out.
subagent("a12plan", { description: "#12 planner", agentType: "devmanager:planner", at: "2026-09-30T12:01:00.000Z", output: 300 });
subagent("a13plan", { description: "#13 planner", agentType: "devmanager:planner", at: "2026-09-30T12:02:00.000Z", output: 310 });
subagent("a12impl", { description: "#12 implementer", agentType: "devmanager:implementer", at: "2026-09-30T13:10:00.000Z", output: 500 });
subagent("a13rev", { description: "#13 reviewer", agentType: "devmanager:reviewer", at: "2026-09-30T13:20:00.000Z", output: 700 });
write("session-batch.jsonl", [
  user("/work-batch #12 #13"),
  ...assistant({ id: "q1", model: "claude-opus-5", blocks: 2, partial: [4], output: 40, input: 2, cacheRead: 500, cacheWrite: 100, timestamps: ["2026-09-30T12:00:00.000Z", "2026-09-30T12:00:01.000Z"] }),
  ...assistant({ id: "q2", model: "claude-opus-5", blocks: 2, partial: [5], output: 60, input: 2, cacheRead: 500, cacheWrite: 100, timestamps: ["2026-09-30T13:05:00.000Z", "2026-09-30T13:05:01.000Z"] }),
]);

console.log("fixtures written");
