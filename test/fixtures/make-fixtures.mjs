// Builds the transcript fixtures. Kept as a script so the shape they assert is
// written once and stays readable, instead of being a wall of pasted JSONL.
//
//     node test/fixtures/make-fixtures.mjs
//
// The shapes here were copied from a real Claude Code transcript — in
// particular the part that matters: one assistant message emitted as several
// lines carrying the same message.id and the same usage object.

import { writeFileSync } from "node:fs";
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

/** One assistant message, split across `blocks` lines exactly as Claude Code writes it. */
function assistant({ id, model, blocks = 1, ...rest }) {
  const shared = usage(rest);
  return Array.from({ length: blocks }, (_, i) => ({
    type: "assistant",
    uuid: `${id}-line-${i}`,
    requestId: `req_${id}`,
    timestamp: "2026-08-29T12:00:00.000Z",
    message: {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "…" }],
      usage: shared,
    },
  }));
}

function user(text) {
  return { type: "user", uuid: `u-${text}`, message: { role: "user", content: text } };
}

function write(name, entries) {
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

console.log("fixtures written");
