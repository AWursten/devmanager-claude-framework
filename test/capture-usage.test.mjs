// Tests for capture-usage.mjs, against fixture transcripts.
//
// The one that earns its keep is "counts a multi-block message once": that is
// the whole reason this module is not a three-line reduce.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureUsage,
  summarize,
  parseTranscript,
  subagentDir,
  toLogTimeTokens,
  primaryModel,
  projectSlug,
  findLatestTranscript,
  captureCurrentUsage,
} from "../template/.claude/hooks/capture-usage.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => path.join(FIXTURES, name);

describe("parseTranscript", () => {
  test("skips a half-written last line instead of throwing", () => {
    const entries = parseTranscript('{"type":"user"}\n{"type":"assist');
    assert.equal(entries.length, 1);
  });

  test("ignores blank lines and non-objects", () => {
    assert.deepEqual(parseTranscript('\n\n"a string"\n42\n{"type":"user"}\n'), [{ type: "user" }]);
  });
});

describe("summarize", () => {
  test("counts a multi-block message once", () => {
    // Same message.id on four lines, the same usage object on each: this is how
    // Claude Code writes one assistant turn that had text plus three tool calls.
    const line = (id) => ({
      type: "assistant",
      message: { id, model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 100 } },
    });
    const totals = summarize([line("m1"), line("m1"), line("m1"), line("m1")]);
    assert.equal(totals.messages, 1);
    assert.equal(totals.tokensOut, 100);
    assert.equal(totals.tokensIn, 10);
  });

  test("falls back to requestId, then uuid, when message.id is missing", () => {
    const byRequest = summarize([
      { type: "assistant", requestId: "r1", message: { usage: { output_tokens: 5 } } },
      { type: "assistant", requestId: "r1", message: { usage: { output_tokens: 5 } } },
    ]);
    assert.equal(byRequest.messages, 1);
    assert.equal(byRequest.tokensOut, 5);
  });

  test("ignores lines that are not assistant turns with usage", () => {
    assert.equal(
      summarize([
        { type: "user", message: { usage: { output_tokens: 999 } } },
        { type: "file-history-snapshot" },
        { type: "assistant", message: { id: "x" } },
      ]),
      null,
    );
  });

  test("treats missing and negative counters as zero", () => {
    const totals = summarize([
      { type: "assistant", message: { id: "m", usage: { output_tokens: -5, input_tokens: null } } },
    ]);
    assert.equal(totals.tokensOut, 0);
    assert.equal(totals.tokensIn, 0);
    assert.equal(totals.messages, 1);
  });
});

describe("captureUsage", () => {
  test("sums a real-shaped transcript, deduplicating the repeated lines", () => {
    const usage = captureUsage(fixture("transcript-basic.jsonl"));
    assert.equal(usage.messages, 3);
    assert.equal(usage.tokensIn, 6);
    assert.equal(usage.tokensOut, 900);
    assert.equal(usage.tokensCacheRead, 6000);
    assert.equal(usage.tokensCacheWrite, 1500);
    assert.deepEqual(Object.keys(usage.byModel), ["claude-opus-5"]);
  });

  test("breaks the total down per model", () => {
    const usage = captureUsage(fixture("transcript-multimodel.jsonl"));
    assert.equal(usage.tokensOut, 525);
    assert.equal(usage.byModel["claude-opus-5"].tokensOut, 500);
    assert.equal(usage.byModel["claude-haiku-4-5-20251001"].tokensOut, 25);
    assert.equal(primaryModel(usage), "claude-opus-5");
  });

  test("returns null when no usage is derivable — absent beats fabricated", () => {
    assert.equal(captureUsage(fixture("transcript-no-usage.jsonl")), null);
    assert.equal(captureUsage(fixture("does-not-exist.jsonl")), null);
    assert.equal(captureUsage(undefined), null);
    assert.equal(captureUsage(""), null);
  });

  test("survives a transcript that is still being written", () => {
    const usage = captureUsage(fixture("transcript-truncated.jsonl"));
    assert.equal(usage.messages, 1);
    assert.equal(usage.tokensOut, 70);
  });

  test("adds the subagent transcripts and keeps them attributable", () => {
    const usage = captureUsage(fixture("session-with-subagents.jsonl"));
    // main 60 + planner 150 + implementer 350
    assert.equal(usage.tokensOut, 560);
    assert.equal(usage.messages, 3);
    assert.deepEqual(Object.keys(usage.bySource).sort(), [
      "agent-implementer",
      "agent-planner",
      "main",
    ]);
    assert.equal(usage.bySource["agent-planner"].tokensOut, 150);
    assert.equal(usage.bySource.main.tokensOut, 60);
  });

  test("can be told to count the session only", () => {
    const usage = captureUsage(fixture("session-with-subagents.jsonl"), { includeSubagents: false });
    assert.equal(usage.tokensOut, 60);
  });

  test("subagentDir points beside the session transcript", () => {
    assert.equal(
      subagentDir(path.join("a", "b", "sess.jsonl")),
      path.join("a", "b", "sess", "subagents"),
    );
  });
});

describe("toLogTimeTokens", () => {
  test("produces exactly the field names log_time accepts", () => {
    const tokens = toLogTimeTokens(captureUsage(fixture("transcript-basic.jsonl")));
    assert.deepEqual(Object.keys(tokens).sort(), [
      "tokensCacheRead",
      "tokensCacheWrite",
      "tokensIn",
      "tokensOut",
      "usageJson",
    ]);
    assert.equal(tokens.tokensOut, 900);
    assert.ok(tokens.usageJson.byModel["claude-opus-5"]);
  });

  test("null in, null out", () => {
    assert.equal(toLogTimeTokens(null), null);
    assert.equal(primaryModel(null), null);
  });
});

describe("finding the transcript without a hook", () => {
  test("projectSlug matches how Claude Code names a project directory", () => {
    assert.equal(projectSlug("d:\\development\\claude-framework"), "d--development-claude-framework");
    assert.equal(projectSlug("/home/me/src/app"), "-home-me-src-app");
  });

  test("picks the most recently modified transcript for the cwd", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cf-home-"));
    const cwd = "/work/app";
    const dir = path.join(home, ".claude", "projects", projectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "old.jsonl"), "");
    writeFileSync(path.join(dir, "new.jsonl"), "");
    utimesSync(path.join(dir, "old.jsonl"), new Date(1), new Date(1));

    assert.equal(findLatestTranscript({ cwd, home }), path.join(dir, "new.jsonl"));
    rmSync(home, { recursive: true, force: true });
  });

  test("returns null when there is no project directory", () => {
    const home = mkdtempSync(path.join(tmpdir(), "cf-home-"));
    assert.equal(findLatestTranscript({ cwd: "/nothing/here", home }), null);
    assert.equal(captureCurrentUsage({ cwd: "/nothing/here", home }), null);
    rmSync(home, { recursive: true, force: true });
  });
});
