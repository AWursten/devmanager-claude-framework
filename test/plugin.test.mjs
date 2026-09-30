// Tests for the Claude Code plugin under plugin/: its manifests, its agents, and
// the Stop hook with its state kept in the user's home instead of the repo.
//
// The hook tests run against a scratch DEVMANAGER_STATE_DIR. What they defend
// above all is that the guard blocks the session working in the task's repo and
// NO OTHER: a plugin hook runs for every project on the machine.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { decide, output, taskKey, MAX_BLOCKS, run } from "../plugin/hooks/stop-guard.mjs";
import {
  CURRENT_TASK,
  LAST_USAGE,
  STOP_GUARD,
  stateRoot,
  projectStateDir,
  readState,
  writeState,
  clearState,
  findOpenTask,
  isInside,
} from "../plugin/hooks/lib/state.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN = path.join(REPO, "plugin");
const FIXTURES = path.join(REPO, "test", "fixtures");

function scratch(prefix = "cf-plugin-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

/** A state root, a repo, and a task open in that repo. */
function world() {
  const root = scratch("cf-state-");
  const repo = scratch("cf-repo-");
  const task = { project: "proj1", task: "#12", startedAt: "2026-09-30T10:00:00.000Z", cwd: repo };
  const dir = projectStateDir(root, "proj1");
  writeState(dir, CURRENT_TASK, task);
  return { root, repo, task, dir };
}

const json = (file) => JSON.parse(readFileSync(file, "utf8"));

describe("manifests", () => {
  test("the repo is its own marketplace, and its plugin is ./plugin", () => {
    const market = json(path.join(REPO, ".claude-plugin", "marketplace.json"));
    const entry = market.plugins.find((p) => p.name === "devmanager");
    assert.ok(entry, "the marketplace lists the devmanager plugin");
    assert.equal(entry.source, "./plugin");
    assert.ok(existsSync(path.join(REPO, entry.source, ".claude-plugin", "plugin.json")));
  });

  test("the plugin is named devmanager — the agents are invoked as devmanager:<role>", () => {
    const manifest = json(path.join(PLUGIN, ".claude-plugin", "plugin.json"));
    assert.equal(manifest.name, "devmanager");
    assert.ok(manifest.description.length > 0);
  });

  test("the Stop hook runs the guard from the plugin root, and the file is there", () => {
    const hooks = json(path.join(PLUGIN, "hooks", "hooks.json"));
    const command = hooks.hooks.Stop[0].hooks[0].command;
    assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/stop-guard\.mjs/);
    assert.ok(existsSync(path.join(PLUGIN, "hooks", "stop-guard.mjs")));
  });

  test("no hook reads CLAUDE_PROJECT_DIR: the session's directory comes from the hook input", () => {
    for (const file of ["stop-guard.mjs", "capture-usage.mjs", path.join("lib", "state.mjs")]) {
      const source = readFileSync(path.join(PLUGIN, "hooks", file), "utf8");
      assert.doesNotMatch(source, /env\.CLAUDE_PROJECT_DIR|process\.env\.CLAUDE_PROJECT_DIR/, file);
    }
  });
});

describe("agents", () => {
  const agents = readdirSync(path.join(PLUGIN, "agents")).filter((f) => f.endsWith(".md"));
  const frontmatter = (file) => {
    const text = readFileSync(path.join(PLUGIN, "agents", file), "utf8").replace(/\r\n/g, "\n");
    const block = /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
    return Object.fromEntries(
      block.split("\n").map((line) => {
        const at = line.indexOf(":");
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
    );
  };

  test("the four roles, each named after its file", () => {
    assert.deepEqual(agents.sort(), ["implementer.md", "planner.md", "reviewer.md", "tester.md"]);
    for (const file of agents) {
      const fm = frontmatter(file);
      assert.equal(fm.name, file.replace(/\.md$/, ""));
      assert.ok(fm.description.length > 0);
    }
  });

  test("planner and reviewer are read-only by configuration", () => {
    for (const file of ["planner.md", "reviewer.md"]) {
      const tools = frontmatter(file).tools.split(",").map((t) => t.trim());
      for (const forbidden of ["Edit", "Write", "NotebookEdit"]) {
        assert.ok(!tools.includes(forbidden), `${file} must not have ${forbidden}`);
      }
      // They read DevManager, and never write to it.
      for (const tool of tools.filter((t) => t.startsWith("mcp__devmanager__"))) {
        assert.match(tool, /__(get|list|search)/, `${file}: ${tool} writes`);
      }
    }
  });

  test("no agent points at files the plugin no longer puts in the repo", () => {
    for (const file of agents) {
      const text = readFileSync(path.join(PLUGIN, "agents", file), "utf8");
      assert.doesNotMatch(text, /\.claude\/settings\.json|\.claude\/state/, file);
    }
  });
});

describe("state", () => {
  test("lives in the user's home, overridable for tests", () => {
    assert.equal(stateRoot({}, "/home/ana"), path.join("/home/ana", ".claude", "devmanager-state"));
    assert.equal(stateRoot({ DEVMANAGER_STATE_DIR: "/x" }, "/home/ana"), "/x");
  });

  test("a project folder is a plain segment: a crafted id never escapes the root", () => {
    assert.equal(projectStateDir("/r", "cmrnp63d500eh8bltsv2ceww4"), path.join("/r", "cmrnp63d500eh8bltsv2ceww4"));
    assert.equal(projectStateDir("/r", "../etc"), null);
    assert.equal(projectStateDir("/r", "a/b"), null);
    assert.equal(projectStateDir("/r", ""), null);
    assert.equal(projectStateDir("/r", undefined), null);
  });

  test("round-trips, and treats missing or corrupt as absent", () => {
    const dir = path.join(scratch(), "p");
    assert.equal(readState(dir, CURRENT_TASK), null);
    assert.equal(writeState(dir, CURRENT_TASK, { task: "#1" }), true);
    assert.deepEqual(readState(dir, CURRENT_TASK), { task: "#1" });
    assert.equal(clearState(dir, CURRENT_TASK), true);
    assert.equal(clearState(dir, CURRENT_TASK), false);
  });

  test("isInside: the repo itself and below it, nothing beside it", () => {
    const repo = path.resolve("/work/app");
    assert.equal(isInside(repo, repo), true);
    assert.equal(isInside(path.join(repo, "src"), repo), true);
    assert.equal(isInside(path.resolve("/work/app-2"), repo), false);
    assert.equal(isInside(path.resolve("/work"), repo), false);
  });

  test("findOpenTask finds the task from inside its repo, and only from there", () => {
    const { root, repo, task } = world();
    assert.deepEqual(findOpenTask(root, repo)?.task, task);
    assert.deepEqual(findOpenTask(root, path.join(repo, "src"))?.task, task);
    assert.equal(findOpenTask(root, scratch("cf-other-")), null);
    assert.equal(findOpenTask(root, undefined), null);
  });

  test("a task with no cwd is ignored: it cannot be told from one in another repo", () => {
    const root = scratch();
    writeState(projectStateDir(root, "p"), CURRENT_TASK, { project: "p", task: "#1" });
    assert.equal(findOpenTask(root, process.cwd()), null);
  });

  test("two tasks open in the same repo: the most recently started wins", () => {
    const { root, repo } = world();
    const newer = { project: "proj2", task: "#99", startedAt: "2026-09-30T12:00:00.000Z", cwd: repo };
    writeState(projectStateDir(root, "proj2"), CURRENT_TASK, newer);
    assert.equal(findOpenTask(root, repo).task.task, "#99");
  });

  test("a missing state root is no open task, not an error", () => {
    assert.equal(findOpenTask(path.join(scratch(), "nope"), process.cwd()), null);
  });
});

describe("decide", () => {
  const TASK = { project: "p", task: "#12", startedAt: "2026-09-30T10:00:00.000Z", cwd: "/r" };

  test("blocks while a task is open, and the close it asks for starts with the documentation check", () => {
    const result = decide({ currentTask: TASK, dir: "/state/p", guard: null });
    assert.equal(result.block, true);
    assert.match(result.reason, /#12/);
    const steps = ["Documentation check", "add_comment", "log_time", "submit_for_review with docs_check"];
    let last = -1;
    for (const step of steps) {
      const at = result.reason.indexOf(step);
      assert.ok(at > last, `${step} comes in order`);
      last = at;
    }
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
  });

  test("honours stop_hook_active without burning a block", () => {
    const result = decide({ currentTask: TASK, guard: null, stopHookActive: true });
    assert.equal(result.block, false);
    assert.equal(result.guard.blocks, 0);
  });

  test("the counter resets when a different task opens", () => {
    const spent = { taskKey: taskKey(TASK), blocks: MAX_BLOCKS };
    assert.equal(decide({ currentTask: TASK, guard: spent }).block, false);
    assert.equal(decide({ currentTask: { ...TASK, task: "#13" }, guard: spent }).block, true);
  });

  test("output uses the documented decision/reason shape", () => {
    const payload = output(decide({ currentTask: TASK, guard: null }));
    assert.equal(payload.decision, "block");
    assert.ok(payload.reason.length > 0);
    assert.equal(output(decide({ currentTask: null, guard: null })), null);
  });
});

describe("run", () => {
  const stdin = (input) => Readable.from([JSON.stringify(input)]);

  test("inside the task's repo: captures usage next to the task, and blocks", async () => {
    const { root, repo, dir } = world();

    const result = await run({
      stdin: stdin({
        cwd: path.join(repo, "src"),
        session_id: "sess-1",
        transcript_path: path.join(FIXTURES, "transcript-basic.jsonl"),
      }),
      env: { DEVMANAGER_STATE_DIR: root },
    });

    assert.equal(result.block, true);
    assert.equal(readState(dir, LAST_USAGE).tokensOut, 900);
    assert.equal(readState(dir, LAST_USAGE).sessionId, "sess-1");
    assert.equal(readState(dir, STOP_GUARD).blocks, 1);
    assert.match(result.reason, new RegExp(dir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  });

  test("in another repo: allows, and writes nothing anywhere", async () => {
    const { root, dir } = world();

    const result = await run({
      stdin: stdin({ cwd: scratch("cf-other-"), transcript_path: path.join(FIXTURES, "transcript-basic.jsonl") }),
      env: { DEVMANAGER_STATE_DIR: root },
    });

    assert.equal(result.block, false);
    assert.equal(readState(dir, LAST_USAGE), null);
    assert.equal(readState(dir, STOP_GUARD), null);
  });

  test("the close deletes the task file and the next stop is allowed", async () => {
    const { root, repo, dir } = world();
    const env = { DEVMANAGER_STATE_DIR: root };

    assert.equal((await run({ stdin: stdin({ cwd: repo }), env })).block, true);
    clearState(dir, CURRENT_TASK); // what step 8 of `work` does last
    assert.equal((await run({ stdin: stdin({ cwd: repo }), env })).block, false);
  });

  test("an underivable transcript leaves no usage file rather than a zeroed one", async () => {
    const { root, repo, dir } = world();
    await run({
      stdin: stdin({ cwd: repo, transcript_path: path.join(FIXTURES, "transcript-no-usage.jsonl") }),
      env: { DEVMANAGER_STATE_DIR: root },
    });
    assert.equal(readState(dir, LAST_USAGE), null);
  });

  test("malformed input never throws: no cwd means the process cwd, and nothing is open there", async () => {
    const root = scratch();
    mkdirSync(root, { recursive: true });
    const result = await run({ stdin: Readable.from(["not json"]), env: { DEVMANAGER_STATE_DIR: root } });
    assert.equal(result.block, false);
  });
});
