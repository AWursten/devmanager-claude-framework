// Tests for the Claude Code plugin under plugin/: its manifests, its agents, and
// the Stop hook with its state kept in the user's home instead of the repo.
//
// The hook tests run against a scratch DEVMANAGER_STATE_DIR. What they defend
// above all is that the guard blocks the session working in the task's repo and
// NO OTHER: a plugin hook runs for every project on the machine.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { decide, output, taskKey, MAX_BLOCKS, BLOCK_WINDOW_MS, run } from "../plugin/hooks/stop-guard.mjs";
import {
  CURRENT_TASK,
  LAST_USAGE,
  STOP_GUARD,
  stateRoot,
  readState,
  writeState,
  clearState,
  findOpenTask,
  isInside,
} from "../plugin/hooks/lib/state.mjs";
import {
  captureUsage,
  lastUsagePerMessage,
  summarize,
  findSessionTranscript,
  main as captureMain,
} from "../plugin/hooks/capture-usage.mjs";
import { ensureLauncher, launcherSource, LAUNCHER } from "../plugin/hooks/session-start.mjs";

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

/** The folder `work` writes a task's state to: one per project, one per task inside. */
const taskDir = (root, project, number) => path.join(root, project, number);

/** A state root, a repo, and a task open in that repo. */
function world() {
  const root = scratch("cf-state-");
  const repo = scratch("cf-repo-");
  // Before the task's first message, so the whole fixture counts as this task's.
  const task = { project: "proj1", task: "#12", startedAt: "2026-08-29T00:00:00.000Z", cwd: repo };
  const dir = taskDir(root, "proj1", "12");
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

  test("the Stop and SessionStart hooks run from the plugin root, and their files are there", () => {
    const hooks = json(path.join(PLUGIN, "hooks", "hooks.json"));
    for (const [event, file] of [
      ["Stop", "stop-guard.mjs"],
      ["SessionStart", "session-start.mjs"],
    ]) {
      const command = hooks.hooks[event][0].hooks[0].command;
      assert.equal(command, `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${file}"`);
      assert.ok(existsSync(path.join(PLUGIN, "hooks", file)));
    }
  });

  test("no hook reads CLAUDE_PROJECT_DIR: the session's directory comes from the hook input", () => {
    for (const file of ["stop-guard.mjs", "session-start.mjs", "capture-usage.mjs", path.join("lib", "state.mjs")]) {
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

  test("the planner has no tool that writes; the reviewer's only one is Bash", () => {
    assert.ok(!frontmatter("planner.md").tools.split(",").map((t) => t.trim()).includes("Bash"));
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

  test("round-trips, and treats missing or corrupt as absent", () => {
    const dir = path.join(scratch(), "p", "1");
    assert.equal(readState(dir, CURRENT_TASK), null);
    assert.equal(writeState(dir, CURRENT_TASK, { task: "#1" }), true);
    assert.deepEqual(readState(dir, CURRENT_TASK), { task: "#1" });
    writeFileSync(path.join(dir, CURRENT_TASK), "{not json");
    assert.equal(readState(dir, CURRENT_TASK), null, "a corrupt file must never throw in a hook");
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

  test("a task with no cwd, or one that is not a string, is ignored", () => {
    const root = scratch();
    writeState(taskDir(root, "p", "1"), CURRENT_TASK, { project: "p", task: "#1" });
    writeState(taskDir(root, "p", "2"), CURRENT_TASK, { project: "p", task: "#2", cwd: 42 });
    assert.equal(findOpenTask(root, process.cwd()), null);
  });

  test("two worktrees of the same project each find their own task", () => {
    const { root, repo, dir } = world();
    const other = scratch("cf-worktree-");
    const task13 = { project: "proj1", task: "#13", startedAt: "2026-09-30T12:00:00.000Z", cwd: other };
    writeState(taskDir(root, "proj1", "13"), CURRENT_TASK, task13);

    assert.equal(findOpenTask(root, repo).task.task, "#12");
    assert.equal(findOpenTask(root, repo).dir, dir);
    assert.equal(findOpenTask(root, other).task.task, "#13");
    // Closing one leaves the other open.
    clearState(dir, CURRENT_TASK);
    assert.equal(findOpenTask(root, repo), null);
    assert.equal(findOpenTask(root, other).task.task, "#13");
  });

  test("two tasks open in the same repo: the most recently started wins", () => {
    const { root, repo } = world();
    const newer = { project: "proj2", task: "#99", startedAt: "2026-09-30T12:00:00.000Z", cwd: repo };
    writeState(taskDir(root, "proj2", "99"), CURRENT_TASK, newer);
    assert.equal(findOpenTask(root, repo).task.task, "#99");
  });

  test("on Windows, drive-letter case and slash direction do not matter", { skip: process.platform !== "win32" }, () => {
    // `git rev-parse --show-toplevel` prints D:/x/app; Claude Code sends d:\\x\\app.
    assert.equal(isInside("d:\\x\\app\\src", "D:/x/app"), true);
    assert.equal(isInside("d:\\x\\app-2", "D:/x/app"), false);
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
    const spent = { taskKey: taskKey(TASK), blocks: MAX_BLOCKS, lastBlockedAt: new Date().toISOString() };
    assert.equal(decide({ currentTask: TASK, guard: spent }).block, false);
    assert.equal(decide({ currentTask: { ...TASK, task: "#13" }, guard: spent }).block, true);
  });

  test("a turn that ends in a question is waiting: it goes through and costs nothing", () => {
    for (const lastMessage of ["¿Avanzo con el plan?", "Should I go ahead?  ", "¿Sigo？"]) {
      const result = decide({ currentTask: TASK, guard: null, lastMessage });
      assert.equal(result.block, false, lastMessage);
      assert.equal(result.guard, null, "waiting must not burn a refusal");
    }
    assert.equal(decide({ currentTask: TASK, guard: null, lastMessage: "Listo, cerré." }).block, true);
  });

  test("two waits and then a real stop: the real stop is still blocked", () => {
    let guard = null;
    for (let i = 0; i < 2; i++) {
      guard = decide({ currentTask: TASK, guard, lastMessage: "¿Me confirmás el enfoque?" }).guard;
    }
    const real = decide({ currentTask: TASK, guard, lastMessage: "Terminé por hoy." });
    assert.equal(real.block, true);
  });

  test("refusals older than the window do not count: a later stretch of the work is guarded again", () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    const old = { taskKey: taskKey(TASK), blocks: MAX_BLOCKS, lastBlockedAt: new Date(now - BLOCK_WINDOW_MS - 1).toISOString() };
    const fresh = { ...old, lastBlockedAt: new Date(now - 60_000).toISOString() };
    assert.equal(decide({ currentTask: TASK, guard: old, now }).block, true);
    assert.equal(decide({ currentTask: TASK, guard: fresh, now }).block, false);
  });

  test("the reason carries the task's own start for the token counter", () => {
    const result = decide({ currentTask: TASK, guard: null });
    assert.match(result.reason, new RegExp(`--since ${TASK.startedAt.replace(/[.]/g, "\\.")}`));
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

  test("counts the task's tokens from its start, not the session's", async () => {
    const { root, repo, dir, task } = world();
    // The fixture's messages run from 12:00 on 2026-08-29; a task started after
    // the last one has spent nothing of it.
    writeState(dir, CURRENT_TASK, { ...task, startedAt: "2026-08-30T00:00:00.000Z" });

    await run({
      stdin: stdin({ cwd: repo, transcript_path: path.join(FIXTURES, "transcript-basic.jsonl") }),
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

describe("the hook as Claude Code runs it", () => {
  /** Run a hook file with node, the way hooks.json does, and return what it printed. */
  function spawnHook(file, input, env) {
    const result = spawnSync(process.execPath, [file], {
      input: JSON.stringify(input),
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    return { status: result.status, stdout: result.stdout.trim() };
  }

  test("blocks through the real entry point, and exits 0", () => {
    const { root, repo } = world();
    const out = spawnHook(path.join(PLUGIN, "hooks", "stop-guard.mjs"), { cwd: repo }, { DEVMANAGER_STATE_DIR: root });
    assert.equal(out.status, 0);
    assert.equal(JSON.parse(out.stdout).decision, "block");
  });

  test("still runs when the plugin is reached through a symlink", (t) => {
    const { root, repo } = world();
    const link = path.join(scratch("cf-link-"), "plugin");
    try {
      // A junction on Windows needs no privileges; elsewhere it is a plain symlink.
      symlinkSync(PLUGIN, link, "junction");
    } catch {
      t.skip("cannot create a symlink here");
      return;
    }
    const out = spawnHook(path.join(link, "hooks", "stop-guard.mjs"), { cwd: repo }, { DEVMANAGER_STATE_DIR: root });
    assert.equal(out.status, 0);
    assert.equal(JSON.parse(out.stdout).decision, "block", "a linked plugin must not go silent");
  });

  test("allows, printing nothing, from a repo with no open task", () => {
    const { root } = world();
    const out = spawnHook(
      path.join(PLUGIN, "hooks", "stop-guard.mjs"),
      { cwd: scratch("cf-other-") },
      { DEVMANAGER_STATE_DIR: root },
    );
    assert.equal(out.status, 0);
    assert.equal(out.stdout, "");
  });
});

describe("tokens since the task started", () => {
  test("captureUsage with since keeps only what came after", () => {
    const transcript = path.join(FIXTURES, "transcript-basic.jsonl");
    const all = captureUsage(transcript);
    assert.equal(captureUsage(transcript, { since: "2026-08-29T00:00:00.000Z" }).tokensOut, all.tokensOut);
    assert.equal(captureUsage(transcript, { since: "2026-08-30T00:00:00.000Z" }), null);
  });

  test("the command line takes --since and a transcript, and prints the log_time shape", () => {
    const logged = [];
    const original = console.log;
    console.log = (value) => logged.push(value);
    try {
      captureMain(["--since", "2026-08-29T00:00:00.000Z", path.join(FIXTURES, "transcript-basic.jsonl")]);
      captureMain(["--since", "2026-08-30T00:00:00.000Z", path.join(FIXTURES, "transcript-basic.jsonl")]);
    } finally {
      console.log = original;
    }
    const [some, none] = logged.map((l) => JSON.parse(l));
    assert.equal(some.logTime.tokensOut, 900);
    assert.equal(some.since, "2026-08-29T00:00:00.000Z");
    assert.equal(none, null, "nothing derivable is null: the cue to log time without tokens");
  });
});

describe("session-start: the launcher", () => {
  test("writes a launcher into the state root that imports this plugin's capture-usage", () => {
    const root = scratch("cf-state-");
    const file = ensureLauncher({ env: { DEVMANAGER_STATE_DIR: root } });
    assert.equal(file, path.join(root, LAUNCHER));
    const source = readFileSync(file, "utf8");
    assert.match(source, /capture-usage\.mjs"/);
    assert.match(source, /main\(\);/);
  });

  test("the launcher runs and prints the capture of the transcript it is given", () => {
    const root = scratch("cf-state-");
    const file = ensureLauncher({ env: { DEVMANAGER_STATE_DIR: root } });
    const result = spawnSync(process.execPath, [file, path.join(FIXTURES, "transcript-basic.jsonl")], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).logTime.tokensOut, 900);
  });

  test("rewrites the launcher when the plugin moves, and leaves it alone otherwise", () => {
    const root = scratch("cf-state-");
    const env = { DEVMANAGER_STATE_DIR: root };
    ensureLauncher({ env, captureUsagePath: path.join(scratch(), "old", "capture-usage.mjs") });
    const file = ensureLauncher({ env });
    assert.equal(readFileSync(file, "utf8"), launcherSource(path.join(PLUGIN, "hooks", "capture-usage.mjs")));
  });

  test("never throws: an unwritable root is null", () => {
    const blocker = path.join(scratch(), "a-file");
    writeFileSync(blocker, "x");
    assert.equal(ensureLauncher({ env: { DEVMANAGER_STATE_DIR: path.join(blocker, "sub") } }), null);
  });

  test("the launcher is a file in the root, so it is never mistaken for a project folder", () => {
    const { root, repo } = world();
    ensureLauncher({ env: { DEVMANAGER_STATE_DIR: root } });
    assert.equal(findOpenTask(root, repo).task.task, "#12");
    assert.ok(readdirSync(root).includes(LAUNCHER));
  });
});

describe("finding the session's transcript from where the shell is", () => {
  /** A fake home with one session filed under `sessionDir`, the way Claude Code files it. */
  function homeWithSession(sessionDir) {
    const home = scratch("cf-home-");
    const slug = sessionDir.replace(/[^a-zA-Z0-9]/g, "-");
    const dir = path.join(home, ".claude", "projects", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "sess.jsonl"), readFileSync(path.join(FIXTURES, "transcript-basic.jsonl")));
    return home;
  }

  test("from a subdirectory, it walks up to the directory the session started in", () => {
    const repo = scratch("cf-repo-");
    const home = homeWithSession(repo);
    const logged = [];
    const original = console.log;
    console.log = (value) => logged.push(value);
    try {
      captureMain(["--since", "2026-08-29T00:00:00.000Z"], { cwd: path.join(repo, "src", "deep"), home, env: {} });
    } finally {
      console.log = original;
    }
    assert.equal(JSON.parse(logged[0]).logTime.tokensOut, 900);
  });

  test("with no session anywhere above, it is null — never a guess", () => {
    const logged = [];
    const original = console.log;
    console.log = (value) => logged.push(value);
    try {
      captureMain([], { cwd: scratch("cf-nowhere-"), home: scratch("cf-home-"), env: {} });
    } finally {
      console.log = original;
    }
    assert.equal(JSON.parse(logged[0]), null);
  });
});

describe("a worktree inside its main checkout", () => {
  test("the session in the nested worktree gets the worktree's task, not the outer one's", () => {
    const { root, repo } = world();
    const nested = path.join(repo, ".claude", "worktrees", "feature");
    mkdirSync(nested, { recursive: true });
    // The outer task started later: depth, not recency, decides.
    writeState(path.join(root, "proj1", "12"), CURRENT_TASK, {
      project: "proj1",
      task: "#12",
      startedAt: "2026-09-30T15:00:00.000Z",
      cwd: repo,
    });
    writeState(path.join(root, "proj1", "13"), CURRENT_TASK, {
      project: "proj1",
      task: "#13",
      startedAt: "2026-09-30T09:00:00.000Z",
      cwd: nested,
    });

    assert.equal(findOpenTask(root, path.join(nested, "src")).task.task, "#13");
    assert.equal(findOpenTask(root, path.join(repo, "src")).task.task, "#12");
  });
});

describe("session-start as Claude Code runs it", () => {
  function spawnStart(file, root) {
    return spawnSync(process.execPath, [file], {
      input: "{}",
      env: { ...process.env, DEVMANAGER_STATE_DIR: root },
      encoding: "utf8",
    });
  }

  test("writes the launcher through the real entry point, printing nothing", () => {
    const root = scratch("cf-state-");
    const result = spawnStart(path.join(PLUGIN, "hooks", "session-start.mjs"), root);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.ok(existsSync(path.join(root, LAUNCHER)));
  });

  test("and through a symlinked plugin too", (t) => {
    const root = scratch("cf-state-");
    const link = path.join(scratch("cf-link-"), "plugin");
    try {
      symlinkSync(PLUGIN, link, "junction");
    } catch {
      t.skip("cannot create a symlink here");
      return;
    }
    const result = spawnStart(path.join(link, "hooks", "session-start.mjs"), root);
    assert.equal(result.status, 0);
    assert.ok(existsSync(path.join(root, LAUNCHER)), "a linked plugin must still leave the launcher");
  });
});

describe("the token counter stays inside the repository", () => {
  test("it does not climb past the repo root into another session's transcripts", () => {
    const parent = scratch("cf-parent-");
    const repo = path.join(parent, "app");
    mkdirSync(path.join(repo, ".git"), { recursive: true });
    const home = scratch("cf-home-");
    // A session filed under the PARENT of the repo: someone else's.
    const slug = parent.replace(/[^a-zA-Z0-9]/g, "-");
    mkdirSync(path.join(home, ".claude", "projects", slug), { recursive: true });
    writeFileSync(
      path.join(home, ".claude", "projects", slug, "other.jsonl"),
      readFileSync(path.join(FIXTURES, "transcript-basic.jsonl")),
    );

    const logged = [];
    const original = console.log;
    console.log = (value) => logged.push(value);
    try {
      captureMain([], { cwd: path.join(repo, "src"), home, env: {} });
    } finally {
      console.log = original;
    }
    assert.equal(JSON.parse(logged[0]), null);
  });
});

describe("each message counts its last line with usage", () => {
  const PARTIAL = path.join(FIXTURES, "transcript-partial-output.jsonl");

  /** One line of an assistant message, in the current format. */
  const line = (id, output, { model = "claude-opus-5", requestId, uuid, at } = {}) => ({
    type: "assistant",
    ...(uuid && { uuid }),
    ...(requestId && { requestId }),
    ...(at && { timestamp: at }),
    message: {
      ...(id && { id }),
      model,
      usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 },
    },
  });
  /** The same line with no usage on it, as a content block can come. */
  const bare = (id) => ({ type: "assistant", message: { id, model: "claude-opus-5", content: [] } });

  test("the first line's partial output is replaced by the last line's final one", () => {
    const usage = captureUsage(PARTIAL);
    assert.equal(usage.tokensOut, 3492 + 120);
    assert.equal(usage.messages, 2);
    // Input and cache are the same on every line, so they do not change.
    assert.equal(usage.tokensIn, 7);
    assert.equal(usage.tokensCacheRead, 30040);
    assert.equal(usage.tokensCacheWrite, 7010);
  });

  test("a last line without usage leaves the last one that has it", () => {
    const totals = summarize([line("m1", 8), line("m1", 3492), bare("m1")]);
    assert.equal(totals.tokensOut, 3492);
    assert.equal(totals.messages, 1);
  });

  test("a line without usage in the middle does not stop the count at it", () => {
    const totals = summarize([line("m1", 8), bare("m1"), line("m1", 3492)]);
    assert.equal(totals.tokensOut, 3492);
    assert.equal(totals.messages, 1);
  });

  test("without message.id, the requestId groups the lines, and the last still wins", () => {
    const totals = summarize([
      line(undefined, 8, { requestId: "req_1", uuid: "u1" }),
      line(undefined, 500, { requestId: "req_1", uuid: "u2" }),
    ]);
    assert.equal(totals.tokensOut, 500);
    assert.equal(totals.messages, 1);
  });

  test("lines with no key at all are summed one by one", () => {
    const totals = summarize([line(undefined, 8), line(undefined, 500)]);
    assert.equal(totals.tokensOut, 508);
    assert.equal(totals.messages, 2);
  });

  test("interleaved messages each keep their own last line, in the order they started", () => {
    const kept = lastUsagePerMessage([line("a", 8), line("b", 3), line("a", 300), line("b", 40)]);
    assert.deepEqual(
      kept.map((e) => [e.message.id, e.message.usage.output_tokens]),
      [
        ["a", 300],
        ["b", 40],
      ],
    );
    assert.equal(summarize([line("a", 8), line("b", 3), line("a", 300), line("b", 40)]).tokensOut, 340);
  });

  test("a later line with a smaller output still wins: the rule is the last line, not the highest", () => {
    assert.equal(summarize([line("m1", 3492), line("m1", 8)]).tokensOut, 8);
  });

  test("byModel carries each model's final output", () => {
    const { byModel } = captureUsage(PARTIAL);
    assert.equal(byModel["claude-opus-5"].tokensOut, 3492);
    assert.equal(byModel["claude-opus-5"].messages, 1);
    assert.equal(byModel["claude-haiku-4-5-20251001"].tokensOut, 120);
    assert.equal(byModel["claude-haiku-4-5-20251001"].messages, 1);
  });

  test("since: mid-message, between messages, and after everything", () => {
    // Between the first and second lines of p1: its later lines remain, the last among them.
    const mid = captureUsage(PARTIAL, { since: "2026-09-30T12:00:00.500Z" });
    assert.equal(mid.tokensOut, 3492 + 120);
    assert.equal(mid.messages, 2);
    // After p1 ended: only p2, with its final output.
    const between = captureUsage(PARTIAL, { since: "2026-09-30T12:00:30.000Z" });
    assert.equal(between.tokensOut, 120);
    assert.equal(between.messages, 1);
    assert.equal(captureUsage(PARTIAL, { since: "2026-09-30T13:00:00.000Z" }), null);
  });

  test("a subagent's long report counts in full, under its own source", () => {
    const usage = captureUsage(path.join(FIXTURES, "session-partial-output.jsonl"));
    assert.equal(usage.bySource.main.tokensOut, 60);
    assert.equal(usage.bySource["agent-reviewer"].tokensOut, 3492);
    assert.equal(usage.tokensOut, 3552);
    assert.equal(usage.messages, 2);
  });

  test("the command line prints the final output, in the capture and in logTime", () => {
    const result = spawnSync(process.execPath, [path.join(PLUGIN, "hooks", "capture-usage.mjs"), PARTIAL], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.tokensOut, 3612);
    assert.equal(out.logTime.tokensOut, 3612);
    assert.equal(out.logTime.usageJson.bySource.main.tokensOut, 3612);
  });
});

describe("the last-line rule on transcripts that are not clean", () => {
  /** A line of an assistant message; `usage` replaces the whole usage object when given. */
  const line = (id, output, { model = "claude-opus-5", ...given } = {}) => ({
    type: "assistant",
    requestId: `req_${id}`,
    uuid: `${id}-${output}-${model}`,
    timestamp: "2026-09-30T12:00:00.000Z",
    message: {
      id,
      model,
      usage: "usage" in given ? given.usage : {
        input_tokens: 2,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 10,
      },
    },
  });

  /** A transcript on disk; strings go in as raw lines, objects as JSON. */
  function transcript(lines, dir = scratch("cf-transcript-")) {
    const file = path.join(dir, "session.jsonl");
    writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));
    return file;
  }

  const COUNTERS = ["tokensIn", "tokensOut", "tokensCacheRead", "tokensCacheWrite", "messages"];

  test("a corrupt line in the middle of a message is skipped, and the final line still wins", () => {
    const usage = captureUsage(transcript([line("m1", 8), '{"type":"assistant","message":{"id":"m1","usa', line("m1", 3492)]));
    assert.equal(usage.tokensOut, 3492);
    assert.equal(usage.messages, 1);
  });

  test("a message whose final line is still half written counts what has arrived, and nothing is invented", () => {
    const usage = captureUsage(transcript([line("m1", 8), '{"type":"assistant","message":{"id":"m1","usage":{"output_tokens":34']));
    assert.equal(usage.tokensOut, 8);
    assert.equal(usage.messages, 1);
  });

  test("the plugin survives the older truncated fixture too", () => {
    const usage = captureUsage(path.join(FIXTURES, "transcript-truncated.jsonl"));
    assert.equal(usage.tokensOut, 70);
    assert.equal(usage.messages, 1);
  });

  test("a final line whose usage lacks some counters, or has them null or not numbers, sums as zero and never NaN", () => {
    const totals = summarize([
      line("m1", 8),
      line("m1", 0, { usage: { output_tokens: 3492 } }),
      line("m2", 0, { usage: { input_tokens: null, output_tokens: "40", cache_read_input_tokens: -3, cache_creation_input_tokens: NaN } }),
    ]);
    for (const key of COUNTERS) assert.ok(Number.isInteger(totals[key]), `${key} is ${totals[key]}`);
    assert.equal(totals.tokensOut, 3492);
    assert.equal(totals.tokensIn, 0);
    assert.equal(totals.tokensCacheRead, 0);
    assert.equal(totals.tokensCacheWrite, 0);
    assert.equal(totals.messages, 2);
  });

  test("a final line whose usage is null or not an object does not replace the one before it", () => {
    assert.equal(summarize([line("m1", 3492), line("m1", 0, { usage: null })]).tokensOut, 3492);
    assert.equal(summarize([line("m1", 3492), line("m1", 0, { usage: "3492" })]).tokensOut, 3492);
  });

  test("only assistant lines count, even when another line of the same message.id carries usage", () => {
    const totals = summarize([line("m1", 8), { ...line("m1", 99999), type: "user" }]);
    assert.equal(totals.tokensOut, 8);
    assert.equal(totals.messages, 1);
  });

  test("a null message.id falls back to requestId, and the last line still wins", () => {
    const totals = summarize([
      { ...line("x", 8), requestId: "req_1", message: { ...line("x", 8).message, id: null } },
      { ...line("x", 500), requestId: "req_1", message: { ...line("x", 500).message, id: null } },
    ]);
    assert.equal(totals.tokensOut, 500);
    assert.equal(totals.messages, 1);
  });

  test("an empty transcript, or one of blank lines, is null — on the API and on the command line", () => {
    const empty = transcript([]);
    assert.equal(captureUsage(empty), null);
    assert.equal(captureUsage(transcript(["", "   ", "\r"])), null);
    assert.equal(captureUsage(transcript(["not json", "{also not"])), null);

    const result = spawnSync(process.execPath, [path.join(PLUGIN, "hooks", "capture-usage.mjs"), empty], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), null);
  });

  test("an empty main transcript with a subagent that worked counts the subagent alone", () => {
    const dir = scratch("cf-transcript-");
    const main = transcript([], dir);
    mkdirSync(path.join(dir, "session", "subagents"), { recursive: true });
    writeFileSync(
      path.join(dir, "session", "subagents", "agent-reviewer.jsonl"),
      [line("r1", 8), line("r1", 3492)].map((l) => JSON.stringify(l)).join("\n"),
    );
    const usage = captureUsage(main);
    assert.equal(usage.tokensOut, 3492);
    assert.equal(usage.messages, 1);
    assert.deepEqual(Object.keys(usage.bySource), ["agent-reviewer"]);
  });

  test("one message.id under two models is one message, attributed to its last line, and byModel adds up to the total", () => {
    const totals = summarize([
      line("m1", 8, { model: "claude-opus-5" }),
      line("m1", 3492, { model: "claude-haiku-4-5-20251001" }),
      line("m2", 50, { model: "claude-opus-5" }),
    ]);
    assert.equal(totals.messages, 2);
    assert.equal(totals.tokensOut, 3542);
    assert.equal(totals.byModel["claude-haiku-4-5-20251001"].tokensOut, 3492);
    assert.equal(totals.byModel["claude-opus-5"].tokensOut, 50);
    assert.equal(totals.byModel["claude-opus-5"].messages, 1);
    for (const key of COUNTERS) {
      const sum = Object.values(totals.byModel).reduce((acc, m) => acc + m[key], 0);
      assert.equal(sum, totals[key], `byModel ${key} adds up to the total`);
    }
  });

  test("the old format — every line repeating the final usage — still counts each message once", () => {
    const totals = summarize([line("m1", 300), line("m1", 300), line("m1", 300), line("m2", 40), line("m2", 40)]);
    assert.equal(totals.tokensOut, 340);
    assert.equal(totals.messages, 2);
    assert.equal(totals.tokensIn, 4);
  });
});

describe("the token counter reads the session it runs in", () => {
  const OLDER = "11111111-aaaa-4bbb-8ccc-000000000001";
  const NEWER = "22222222-aaaa-4bbb-8ccc-000000000002";
  const SINCE = "2026-09-30T00:00:00.000Z";

  /** One assistant message with `out` output tokens, as a transcript line. */
  const message = (out) =>
    JSON.stringify({
      type: "assistant",
      requestId: `req_${out}`,
      uuid: `uuid_${out}`,
      timestamp: "2026-09-30T12:00:00.000Z",
      message: {
        id: `msg_${out}`,
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });

  /** A session filed under `startedIn` the way Claude Code files it, last written at `mtime`. */
  function session(home, startedIn, id, out, mtime) {
    const dir = path.join(home, ".claude", "projects", startedIn.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    writeFileSync(file, message(out) + "\n");
    if (mtime) utimesSync(file, mtime, mtime);
    return file;
  }

  /** A repo with two sessions open in it; the other one wrote last. */
  function twoSessions() {
    const repo = scratch("cf-repo-");
    mkdirSync(path.join(repo, ".git"));
    const home = scratch("cf-home-");
    const older = session(home, repo, OLDER, 111, new Date("2026-09-30T10:00:00.000Z"));
    const newer = session(home, repo, NEWER, 222, new Date("2026-09-30T11:00:00.000Z"));
    return { repo, home, older, newer };
  }

  function capture(argv, options) {
    const logged = [];
    const original = console.log;
    console.log = (value) => logged.push(value);
    try {
      captureMain(argv, options);
    } finally {
      console.log = original;
    }
    return JSON.parse(logged[0]);
  }

  test("two sessions in one repo: the id picks its own, even when the other wrote last", () => {
    const { repo, home, older } = twoSessions();
    const env = { CLAUDE_CODE_SESSION_ID: OLDER };
    assert.equal(findSessionTranscript({ env, home, cwd: repo }), older);
    const out = capture(["--since", SINCE], { env, home, cwd: repo });
    assert.equal(out.transcript, older);
    assert.equal(out.logTime.tokensOut, 111);
  });

  test("the same two sessions without the variable: the newest, as before", () => {
    const { repo, home, newer } = twoSessions();
    assert.equal(findSessionTranscript({ env: {}, home, cwd: repo }), newer);
    const out = capture(["--since", SINCE], { env: {}, home, cwd: repo });
    assert.equal(out.transcript, newer);
    assert.equal(out.logTime.tokensOut, 222);
  });

  test("an empty variable is the same as none", () => {
    const { repo, home, newer } = twoSessions();
    assert.equal(findSessionTranscript({ env: { CLAUDE_CODE_SESSION_ID: "" }, home, cwd: repo }), newer);
  });

  test("an id with no transcript is null, not the newest of the repo", () => {
    const { repo, home } = twoSessions();
    const env = { CLAUDE_CODE_SESSION_ID: "33333333-aaaa-4bbb-8ccc-000000000003" };
    assert.equal(findSessionTranscript({ env, home, cwd: repo }), null);
    assert.equal(capture([], { env, home, cwd: repo }), null);
  });

  test("an id found in two folders is null: neither says which session this is", () => {
    const { repo, home } = twoSessions();
    session(home, scratch("cf-elsewhere-"), OLDER, 999);
    const env = { CLAUDE_CODE_SESSION_ID: OLDER };
    assert.equal(findSessionTranscript({ env, home, cwd: repo }), null);
    assert.equal(capture([], { env, home, cwd: repo }), null);
  });

  test("an id that could walk a path is null, and nothing it points at is read", () => {
    const { repo, home } = twoSessions();
    const projects = path.join(home, ".claude", "projects");
    const folder = path.join(projects, repo.replace(/[^a-zA-Z0-9]/g, "-"));
    // What each id would reach if it were joined to a path unchecked.
    mkdirSync(path.join(folder, "a"), { recursive: true });
    const planted = [
      path.join(projects, "x.jsonl"), // ../x
      path.join(home, ".claude", "x.jsonl"), // ../../x
      path.join(folder, "a", "b.jsonl"), // a/b, and a\b on Windows
      path.join(folder, "a\\b.jsonl"), // a\b elsewhere
      path.join(folder, "..jsonl"), // .
      path.join(folder, "...jsonl"), // ..
      path.join(folder, "x.jsonl.jsonl"), // x.jsonl
      path.join(folder, "x.jsonl"), // x.jsonl with its extension stripped
    ];
    for (const file of planted) writeFileSync(file, message(777) + "\n");
    // The planting is real: a plain id reaches its file.
    assert.equal(findSessionTranscript({ env: { CLAUDE_CODE_SESSION_ID: "x" }, home, cwd: repo }), path.join(folder, "x.jsonl"));

    for (const id of ["../x", "../../x", "a/b", "a\\b", ".", "..", "x.jsonl", " ", `${OLDER}\n`]) {
      const env = { CLAUDE_CODE_SESSION_ID: id };
      assert.equal(findSessionTranscript({ env, home, cwd: repo }), null, JSON.stringify(id));
      assert.equal(capture([], { env, home, cwd: repo }), null, JSON.stringify(id));
    }
  });

  test("a session filed away from cwd: found by its id, and null without one", () => {
    const repo = scratch("cf-repo-");
    mkdirSync(path.join(repo, ".git"));
    const home = scratch("cf-home-");
    const file = session(home, scratch("cf-started-here-"), OLDER, 111);
    assert.equal(findSessionTranscript({ env: { CLAUDE_CODE_SESSION_ID: OLDER }, home, cwd: repo }), file);
    assert.equal(findSessionTranscript({ env: {}, home, cwd: repo }), null);
  });

  test("the id's subagents are summed in, from beside its transcript", () => {
    const { repo, home, older } = twoSessions();
    const subagents = path.join(path.dirname(older), OLDER, "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(path.join(subagents, "agent-reviewer.jsonl"), message(3492) + "\n");
    const out = capture(["--since", SINCE], { env: { CLAUDE_CODE_SESSION_ID: OLDER }, home, cwd: repo });
    assert.equal(out.transcript, older);
    assert.equal(out.tokensOut, 111 + 3492);
    assert.equal(out.bySource.main.tokensOut, 111);
    assert.equal(out.bySource["agent-reviewer"].tokensOut, 3492);
  });

  test("the launcher, as work runs it, counts the session named by the variable", () => {
    const { repo, home, older, newer } = twoSessions();
    const launcher = ensureLauncher({ env: { DEVMANAGER_STATE_DIR: scratch("cf-state-") } });
    const run = (extra) => {
      const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
      if (!("CLAUDE_CODE_SESSION_ID" in extra)) delete env.CLAUDE_CODE_SESSION_ID;
      const result = spawnSync(process.execPath, [launcher, "--since", SINCE], { cwd: repo, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };

    const named = run({ CLAUDE_CODE_SESSION_ID: OLDER });
    assert.equal(named.transcript, older);
    assert.equal(named.logTime.tokensOut, 111);

    const unnamed = run({});
    assert.equal(unnamed.transcript, newer);
    assert.equal(unnamed.logTime.tokensOut, 222);
  });

  test("an id with no projects folder to search is null, and so is a projects that is a file", () => {
    const repo = scratch("cf-repo-");
    mkdirSync(path.join(repo, ".git"));
    const env = { CLAUDE_CODE_SESSION_ID: OLDER };

    const bare = scratch("cf-home-");
    assert.equal(findSessionTranscript({ env, home: bare, cwd: repo }), null);
    assert.equal(capture([], { env, home: bare, cwd: repo }), null);

    const odd = scratch("cf-home-");
    mkdirSync(path.join(odd, ".claude"));
    writeFileSync(path.join(odd, ".claude", "projects"), "");
    assert.equal(findSessionTranscript({ env, home: odd, cwd: repo }), null);
    assert.equal(capture([], { env, home: odd, cwd: repo }), null);
  });

  test("without env, it reads the variable from process.env", () => {
    const { repo, home, older, newer } = twoSessions();
    const had = Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_CODE_SESSION_ID");
    const original = process.env.CLAUDE_CODE_SESSION_ID;
    try {
      process.env.CLAUDE_CODE_SESSION_ID = OLDER;
      assert.equal(findSessionTranscript({ home, cwd: repo }), older);
      delete process.env.CLAUDE_CODE_SESSION_ID;
      assert.equal(findSessionTranscript({ home, cwd: repo }), newer);
    } finally {
      if (had) process.env.CLAUDE_CODE_SESSION_ID = original;
      else delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });

  test("a transcript given on the command line wins over the variable", () => {
    const { repo, home, newer } = twoSessions();
    const named = capture(["--since", SINCE, newer], { env: { CLAUDE_CODE_SESSION_ID: OLDER }, home, cwd: repo });
    assert.equal(named.transcript, newer);
    assert.equal(named.logTime.tokensOut, 222);

    // Even an id that would resolve to null does not void the transcript it was given.
    const unresolved = { CLAUDE_CODE_SESSION_ID: "33333333-aaaa-4bbb-8ccc-000000000003" };
    const given = capture(["--since", SINCE, newer], { env: unresolved, home, cwd: repo });
    assert.equal(given.transcript, newer);
    assert.equal(given.logTime.tokensOut, 222);
  });

  test("a folder named <id>.jsonl is not a transcript, and not a second copy of one", () => {
    const { repo, home } = twoSessions();
    const projects = path.join(home, ".claude", "projects");
    const ID = "44444444-aaaa-4bbb-8ccc-000000000004";
    mkdirSync(path.join(projects, "cf-decoy", `${ID}.jsonl`), { recursive: true });
    const env = { CLAUDE_CODE_SESSION_ID: ID };
    assert.equal(findSessionTranscript({ env, home, cwd: repo }), null);
    assert.equal(capture([], { env, home, cwd: repo }), null);

    const real = session(home, scratch("cf-started-here-"), ID, 333);
    assert.equal(findSessionTranscript({ env, home, cwd: repo }), real);
  });

  test("a stray file at the top of projects/ does not stop the search", () => {
    const { repo, home, older } = twoSessions();
    writeFileSync(path.join(home, ".claude", "projects", "stray.txt"), "");
    assert.equal(findSessionTranscript({ env: { CLAUDE_CODE_SESSION_ID: OLDER }, home, cwd: repo }), older);
  });

  test("an id whose transcript has no usage is null, not the other session's tokens", () => {
    const { repo, home, older } = twoSessions();
    writeFileSync(older, "");
    // Still the older of the two, so a fallback to the newest would find 222 tokens.
    utimesSync(older, new Date("2026-09-30T10:00:00.000Z"), new Date("2026-09-30T10:00:00.000Z"));
    const env = { CLAUDE_CODE_SESSION_ID: OLDER };
    assert.equal(findSessionTranscript({ env, home, cwd: repo }), older);
    assert.equal(capture(["--since", SINCE], { env, home, cwd: repo }), null);
  });
});
