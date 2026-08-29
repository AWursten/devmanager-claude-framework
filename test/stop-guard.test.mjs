// Tests for stop-guard.mjs and the state library.
//
// `decide` is the whole hook; `run` is a thin wrapper that reads stdin, writes
// two state files and prints. Both are covered, but the interesting assertions
// are on `decide` — above all that it cannot block forever.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { decide, output, taskKey, MAX_BLOCKS, run } from "../template/.claude/hooks/stop-guard.mjs";
import {
  CURRENT_TASK,
  LAST_USAGE,
  STOP_GUARD,
  readState,
  writeState,
  clearState,
  statePath,
  projectDir,
  readHookInput,
} from "../template/.claude/hooks/lib/state.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "cf-guard-"));
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

const TASK = { project: "proj-1", task: "#12", startedAt: "2026-08-29T10:00:00.000Z" };

describe("decide", () => {
  test("allows the stop when no task is open", () => {
    const result = decide({ currentTask: null, guard: null });
    assert.equal(result.block, false);
    assert.equal(result.guard, null);
  });

  test("blocks the stop while a task is open", () => {
    const result = decide({ currentTask: TASK, guard: null });
    assert.equal(result.block, true);
    assert.match(result.reason, /#12/);
    assert.match(result.reason, /log_time/);
    assert.match(result.reason, /submit_for_review/);
    assert.equal(result.guard.blocks, 1);
    assert.equal(result.guard.taskKey, taskKey(TASK));
  });

  test("gives up after MAX_BLOCKS — it can never trap a session", () => {
    let guard = null;
    let blocked = 0;
    for (let i = 0; i < 10; i++) {
      const result = decide({ currentTask: TASK, guard });
      if (result.block) blocked++;
      guard = result.guard;
    }
    assert.equal(blocked, MAX_BLOCKS);
    assert.equal(decide({ currentTask: TASK, guard }).block, false);
  });

  test("honours stop_hook_active when the runtime supplies it", () => {
    const result = decide({ currentTask: TASK, guard: null, stopHookActive: true });
    assert.equal(result.block, false);
    assert.equal(result.guard.blocks, 0, "an honoured stop must not burn a block");
  });

  test("the counter resets when a different task opens", () => {
    const spent = { taskKey: taskKey(TASK), blocks: MAX_BLOCKS };
    const other = { ...TASK, task: "#13" };
    assert.equal(decide({ currentTask: TASK, guard: spent }).block, false);
    assert.equal(decide({ currentTask: other, guard: spent }).block, true);
  });

  test("the counter resets when the same task is started again", () => {
    const spent = { taskKey: taskKey(TASK), blocks: MAX_BLOCKS };
    const restarted = { ...TASK, startedAt: "2026-08-29T15:00:00.000Z" };
    assert.equal(decide({ currentTask: restarted, guard: spent }).block, true);
  });

  test("a corrupt guard file counts as no blocks yet", () => {
    assert.equal(decide({ currentTask: TASK, guard: { taskKey: taskKey(TASK), blocks: "many" } }).block, true);
  });
});

describe("output", () => {
  test("says block in both documented shapes", () => {
    const payload = output(decide({ currentTask: TASK, guard: null }));
    assert.equal(payload.decision, "block");
    assert.equal(payload.hookSpecificOutput.hookEventName, "Stop");
    assert.equal(payload.hookSpecificOutput.decision, "block");
    assert.equal(payload.reason, payload.hookSpecificOutput.reason);
  });

  test("prints nothing when the stop is allowed", () => {
    assert.equal(output(decide({ currentTask: null, guard: null })), null);
  });
});

describe("state library", () => {
  test("round-trips, and treats missing or corrupt as absent", () => {
    const root = scratch();
    assert.equal(readState(root, CURRENT_TASK), null);
    assert.equal(writeState(root, CURRENT_TASK, TASK), true);
    assert.deepEqual(readState(root, CURRENT_TASK), TASK);

    writeFileSync(statePath(root, CURRENT_TASK), "{not json");
    assert.equal(readState(root, CURRENT_TASK), null, "a corrupt file must never throw in a hook");

    assert.equal(clearState(root, CURRENT_TASK), true);
    assert.equal(clearState(root, CURRENT_TASK), false);
    assert.equal(existsSync(statePath(root, CURRENT_TASK)), false);
  });

  test("projectDir prefers CLAUDE_PROJECT_DIR, then the hook's cwd", () => {
    assert.equal(projectDir({ cwd: "/from-input" }, { CLAUDE_PROJECT_DIR: "/from-env" }), "/from-env");
    assert.equal(projectDir({ cwd: "/from-input" }, {}), "/from-input");
    assert.equal(projectDir({}, {}), process.cwd());
  });

  test("readHookInput tolerates empty and malformed stdin", async () => {
    assert.deepEqual(await readHookInput(Readable.from([""])), {});
    assert.deepEqual(await readHookInput(Readable.from(["not json"])), {});
    assert.deepEqual(await readHookInput(Readable.from(['{"session_id":"s1"}'])), { session_id: "s1" });
  });
});

describe("run", () => {
  function hookInput(root, extra = {}) {
    return Readable.from([JSON.stringify({ cwd: root, session_id: "sess-1", ...extra })]);
  }

  test("with a task open: captures usage, writes it, and blocks", async () => {
    const root = scratch();
    mkdirSync(path.join(root, ".claude", "state"), { recursive: true });
    writeState(root, CURRENT_TASK, TASK);

    const result = await run({
      stdin: hookInput(root, { transcript_path: path.join(FIXTURES, "transcript-basic.jsonl") }),
      env: { CLAUDE_PROJECT_DIR: root },
    });

    assert.equal(result.block, true);
    const usage = readState(root, LAST_USAGE);
    assert.equal(usage.tokensOut, 900);
    assert.equal(usage.sessionId, "sess-1");
    assert.equal(readState(root, STOP_GUARD).blocks, 1);
  });

  test("with no task open: allows, and writes no usage", async () => {
    const root = scratch();
    const result = await run({ stdin: hookInput(root), env: { CLAUDE_PROJECT_DIR: root } });
    assert.equal(result.block, false);
    assert.equal(readState(root, LAST_USAGE), null);
  });

  test("an underivable transcript leaves no usage file rather than a zeroed one", async () => {
    const root = scratch();
    writeState(root, CURRENT_TASK, TASK);
    await run({
      stdin: hookInput(root, { transcript_path: path.join(FIXTURES, "transcript-no-usage.jsonl") }),
      env: { CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(readState(root, LAST_USAGE), null);
  });

  test("the close clears the state and the next stop is allowed", async () => {
    const root = scratch();
    writeState(root, CURRENT_TASK, TASK);
    const env = { CLAUDE_PROJECT_DIR: root };

    assert.equal((await run({ stdin: hookInput(root), env })).block, true);
    clearState(root, CURRENT_TASK); // what step 8 of /work does last
    assert.equal((await run({ stdin: hookInput(root), env })).block, false);
  });
});
