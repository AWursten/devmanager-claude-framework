// settings.json and settings.jsonc are the same file twice: one Claude Code
// reads, one a person reads. The only thing that keeps that honest is this test.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = path.join(REPO, "template");

/**
 * Strip // and /* *\/ comments from JSONC. String-aware on purpose: a naive
 * regex eats the // in a URL or a path and produces a file that still parses,
 * which is the worst possible failure for a test whose job is comparison.
 */
export function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let comment = null; // "line" | "block" | null

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (comment === "line") {
      if (char === "\n") {
        comment = null;
        out += char;
      }
      continue;
    }
    if (comment === "block") {
      if (char === "*" && next === "/") {
        comment = null;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      comment = "line";
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      comment = "block";
      i++;
      continue;
    }
    out += char;
  }

  return out;
}

describe("stripJsonComments", () => {
  test("leaves a // that lives inside a string alone", () => {
    const source = '{"url":"https://example.com","a":1}';
    assert.deepEqual(JSON.parse(stripJsonComments(source)), {
      url: "https://example.com",
      a: 1,
    });
  });

  test("handles an escaped quote before a comment", () => {
    const source = '{"cmd":"node \\"x\\""} // trailing';
    assert.deepEqual(JSON.parse(stripJsonComments(source)), { cmd: 'node "x"' });
  });

  test("strips line and block comments", () => {
    assert.deepEqual(JSON.parse(stripJsonComments("// head\n{/* mid */\"a\":1}\n")), { a: 1 });
  });
});

describe("the template's settings files", () => {
  const json = readFileSync(path.join(TEMPLATE, ".claude", "settings.json"), "utf8");
  const jsonc = readFileSync(path.join(TEMPLATE, ".claude", "settings.jsonc"), "utf8");

  test("settings.json is strict JSON — Claude Code accepts nothing else", () => {
    assert.doesNotThrow(() => JSON.parse(json));
    assert.equal(json.includes("//"), false, "a // anywhere in settings.json breaks it");
    assert.equal(/,\s*[}\]]/.test(json), false, "no trailing commas");
  });

  test("the annotated twin says exactly the same thing", () => {
    assert.deepEqual(JSON.parse(stripJsonComments(jsonc)), JSON.parse(json));
  });

  test("the twin is actually annotated, or it has no reason to exist", () => {
    assert.ok(jsonc.split("\n").filter((l) => l.trim().startsWith("//")).length > 20);
  });

  test("the Stop hook points at the guard that ships with it", () => {
    const command = JSON.parse(json).hooks.Stop[0].hooks[0].command;
    assert.match(command, /stop-guard\.mjs/);
    assert.match(command, /\$\{CLAUDE_PROJECT_DIR\}/);
  });

  test("no DevManager tool that writes is pre-approved", () => {
    const { allow } = JSON.parse(json).permissions;
    const writes = [
      "add_comment",
      "log_time",
      "start_task",
      "submit_for_review",
      "complete_task",
      "propose_decision",
      "upsert_document",
      "create_backlog",
      "create_task",
      "update_story",
      "accept_decision",
    ];
    for (const tool of writes) {
      assert.equal(
        allow.includes(`mcp__devmanager__${tool}`),
        false,
        `${tool} writes to the board; it must not be in allow`,
      );
    }
  });

  test("push and .env are held behind ask", () => {
    const { ask } = JSON.parse(json).permissions;
    assert.ok(ask.some((rule) => rule.startsWith("Bash(git push")));
    assert.ok(ask.some((rule) => rule.includes(".env")));
  });
});

describe("this repo's own settings files", () => {
  // The framework eats its own pattern: the same pair, the same guarantee.
  const json = readFileSync(path.join(REPO, ".claude", "settings.json"), "utf8");
  const jsonc = readFileSync(path.join(REPO, ".claude", "settings.jsonc"), "utf8");

  test("settings.json is strict JSON", () => {
    assert.doesNotThrow(() => JSON.parse(json));
    assert.equal(json.includes("//"), false);
  });

  test("the annotated twin says exactly the same thing", () => {
    assert.deepEqual(JSON.parse(stripJsonComments(jsonc)), JSON.parse(json));
  });
});
