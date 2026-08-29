// Tests for init.mjs. Node's test runner, no framework.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  render,
  listTemplateFiles,
  plan,
  apply,
  mergeGitignore,
  main,
  GITIGNORE_APPEND,
} from "../init.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = path.join(REPO, "template");

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "cf-init-"));
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

/** A tiny template of our own, so these tests do not depend on the real one's contents. */
function fakeTemplate() {
  const dir = scratch();
  mkdirSync(path.join(dir, ".claude", "hooks"), { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# {{PROJECT_NAME}}\nid: {{DEVMANAGER_PROJECT_ID}}\n");
  writeFileSync(path.join(dir, ".claude", "hooks", "hook.mjs"), "// {{UNKNOWN}}\n");
  writeFileSync(path.join(dir, GITIGNORE_APPEND), "\n# --- framework ---\n.claude/state/\nCLAUDE.local.md\n");
  return dir;
}

const VALUES = { project: "proj-123", name: "Acme Web" };

describe("parseArgs", () => {
  test("reads the target, the project and the name", () => {
    const args = parseArgs(["../acme", "--project", "p1", "--name", "Acme"]);
    assert.equal(args.target, "../acme");
    assert.equal(args.project, "p1");
    assert.equal(args.name, "Acme");
    assert.equal(args.force, false);
    assert.equal(args.dryRun, false);
  });

  test("accepts --key=value", () => {
    const args = parseArgs(["out", "--project=p1", "--name=Acme Web"]);
    assert.equal(args.project, "p1");
    assert.equal(args.name, "Acme Web");
  });

  test("reads the flags", () => {
    const args = parseArgs(["out", "--project", "p", "--name", "n", "--force", "--dry-run"]);
    assert.equal(args.force, true);
    assert.equal(args.dryRun, true);
  });

  test("--help short-circuits every other requirement", () => {
    assert.deepEqual(parseArgs(["--help"]), { help: true });
  });

  test("refuses an incomplete invocation", () => {
    assert.throws(() => parseArgs([]), /target directory/);
    assert.throws(() => parseArgs(["out", "--name", "n"]), /--project/);
    assert.throws(() => parseArgs(["out", "--project", "p"]), /--name/);
    assert.throws(() => parseArgs(["out", "extra", "--project", "p", "--name", "n"]), /Unexpected/);
    assert.throws(() => parseArgs(["out", "--project"]), /needs a value/);
  });
});

describe("render", () => {
  test("substitutes the known placeholders", () => {
    assert.equal(render("# {{PROJECT_NAME}} / {{DEVMANAGER_PROJECT_ID}}", VALUES), "# Acme Web / proj-123");
  });

  test("leaves unknown placeholders alone", () => {
    assert.equal(render("{{SOMETHING_ELSE}}", VALUES), "{{SOMETHING_ELSE}}");
  });

  test("substitutes every occurrence", () => {
    assert.equal(render("{{PROJECT_NAME}} {{PROJECT_NAME}}", VALUES), "Acme Web Acme Web");
  });
});

describe("listTemplateFiles", () => {
  test("walks into subdirectories and returns forward-slashed relative paths", () => {
    const files = listTemplateFiles(fakeTemplate());
    assert.deepEqual(files.sort(), [".claude/hooks/hook.mjs", ".gitignore.append", "CLAUDE.md"].sort());
  });
});

describe("mergeGitignore", () => {
  const ADDITION = "\n# --- framework ---\n.claude/state/\nCLAUDE.local.md\n";

  test("appends everything to an empty file", () => {
    const result = mergeGitignore("", ADDITION);
    assert.equal(result.changed, true);
    assert.deepEqual(result.added, [".claude/state/", "CLAUDE.local.md"]);
    assert.match(result.content, /# --- framework ---/);
  });

  test("is a no-op when every line is already ignored", () => {
    const current = "node_modules/\n.claude/state/\nCLAUDE.local.md\n";
    const result = mergeGitignore(current, ADDITION);
    assert.equal(result.changed, false);
    assert.equal(result.content, current);
    assert.deepEqual(result.added, []);
  });

  test("appends only the missing lines", () => {
    const result = mergeGitignore(".claude/state/\n", ADDITION);
    assert.deepEqual(result.added, ["CLAUDE.local.md"]);
    assert.equal(result.content.match(/\.claude\/state\//g).length, 1);
  });

  test("does not glue the block onto a file with no trailing newline", () => {
    const result = mergeGitignore("node_modules/", ADDITION);
    assert.match(result.content, /node_modules\/\n/);
  });
});

describe("plan and apply", () => {
  test("copies the tree, substitutes, and skips .gitignore.append", () => {
    const templateDir = fakeTemplate();
    const targetDir = scratch();

    const planned = plan({ templateDir, targetDir, values: VALUES });
    assert.deepEqual(planned.conflicts, []);
    assert.equal(planned.files.some((f) => f.rel === GITIGNORE_APPEND), false);

    apply(planned);

    assert.equal(
      readFileSync(path.join(targetDir, "CLAUDE.md"), "utf8"),
      "# Acme Web\nid: proj-123\n",
    );
    assert.equal(existsSync(path.join(targetDir, ".claude", "hooks", "hook.mjs")), true);
    assert.equal(existsSync(path.join(targetDir, GITIGNORE_APPEND)), false);
    assert.match(readFileSync(path.join(targetDir, ".gitignore"), "utf8"), /\.claude\/state\//);
  });

  test("reports conflicts and writes nothing when the target already has the files", () => {
    const templateDir = fakeTemplate();
    const targetDir = scratch();
    apply(plan({ templateDir, targetDir, values: VALUES }));

    const second = plan({ templateDir, targetDir, values: VALUES });
    assert.deepEqual(second.conflicts.sort(), [".claude/hooks/hook.mjs", "CLAUDE.md"].sort());
  });

  test("--force plans the overwrite instead of a conflict", () => {
    const templateDir = fakeTemplate();
    const targetDir = scratch();
    apply(plan({ templateDir, targetDir, values: VALUES }));
    writeFileSync(path.join(targetDir, "CLAUDE.md"), "hand-edited");

    const forced = plan({ templateDir, targetDir, values: VALUES, force: true });
    assert.deepEqual(forced.conflicts, []);
    apply(forced);
    assert.equal(readFileSync(path.join(targetDir, "CLAUDE.md"), "utf8"), "# Acme Web\nid: proj-123\n");
  });

  test("--dry-run writes nothing", () => {
    const templateDir = fakeTemplate();
    const targetDir = scratch();
    const planned = plan({ templateDir, targetDir, values: VALUES });
    const result = apply(planned, { dryRun: true });
    assert.equal(result.written.length, 2);
    assert.equal(existsSync(path.join(targetDir, "CLAUDE.md")), false);
    assert.equal(existsSync(path.join(targetDir, ".gitignore")), false);
  });
});

describe("main against the real template", () => {
  test("instantiates it and is idempotent by refusing the second run", () => {
    const targetDir = scratch();
    const lines = [];
    const log = (...args) => lines.push(args.join(" "));

    assert.equal(main([targetDir, "--project", "proj-123", "--name", "Acme Web"], { log, error: log }), 0);

    const claudeMd = readFileSync(path.join(targetDir, "CLAUDE.md"), "utf8");
    assert.match(claudeMd, /Acme Web/);
    assert.match(claudeMd, /proj-123/);
    assert.equal(claudeMd.includes("{{"), false, "no placeholder should survive");

    // .mcp.json and settings.json must still parse after substitution.
    JSON.parse(readFileSync(path.join(targetDir, ".mcp.json"), "utf8"));
    JSON.parse(readFileSync(path.join(targetDir, ".claude", "settings.json"), "utf8"));

    assert.match(lines.join("\n"), /Three things left to do by hand/);

    const second = main([targetDir, "--project", "proj-123", "--name", "Acme Web"], { log, error: log });
    assert.equal(second, 1);
    assert.match(lines.join("\n"), /Refusing to overwrite/);
  });

  test("the shipped template has no placeholder this tool cannot fill", () => {
    const unknown = new Set();
    for (const rel of listTemplateFiles(TEMPLATE)) {
      const body = readFileSync(path.join(TEMPLATE, ...rel.split("/")), "utf8");
      for (const [, key] of body.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) {
        if (!["PROJECT_NAME", "DEVMANAGER_PROJECT_ID"].includes(key)) unknown.add(`${rel}: ${key}`);
      }
    }
    assert.deepEqual([...unknown], []);
  });
});
