# claude-framework

The optional Claude Code plugin for working DevManager tasks, and the older repo template it replaces.

**You do not need anything from this repo to work with DevManager.** A session that has only the DevManager connector already works tasks with the full protocol: the server hands every session its working rules when it connects, each tool result says what comes next, in STANDARD and PRODUCTION projects the close is rejected unless it declares the documentation check, and the `work`, `sync-docs` and `adopt-lite` skills come from the organization's baseline as prompts of the connector. This repo adds the part that cannot live on a server because it has to run on the developer's machine.

## Where each rule lives

Nothing that has to be always on depends on a file on the client side.

| Kind of rule | Where it lives |
|---|---|
| Holds in every session | The DevManager MCP server's `instructions` |
| Holds at one moment | The result of that moment's tool (`Next:` lines) |
| Cannot fail | The server's schema and validations (`docs_check` on close, implicit start) |
| Organization or project convention | The baseline, through `get_context` |
| An invocable flow | A baseline skill, served as an MCP prompt: `work`, `sync-docs`, `adopt-lite` |
| Has to run on the machine | **This plugin** |

## Installation

- **claude.ai:** an admin adds the DevManager connector to the organization. Nothing else.
- **Claude Code, once per machine:**

  ```bash
  claude mcp add --transport http --scope user devmanager https://devmanager.com.ar/api/mcp
  ```

  Name it `devmanager`: the plugin's read-only agents list their DevManager tools as `mcp__devmanager__*`, and a connector registered under another name leaves them without DevManager access.

- **Optional, once per machine — the plugin**, from a Claude Code session in any of its surfaces (terminal, VS Code, JetBrains):

  ```
  /plugin marketplace add AWursten/devmanager-claude-framework
  /plugin install devmanager@claude-framework
  ```

  or from a shell:

  ```bash
  claude plugin marketplace add AWursten/devmanager-claude-framework
  claude plugin install devmanager@claude-framework
  ```

  It lives in the user's Claude Code configuration, so the terminal and the editor extensions on that machine all get it. Nothing is added to any project repo, and no `.gitignore` needs a line. claude.ai chat has no plugin: nothing runs on the machine there, so it works with the connector alone.

Then, in any repo with a linked DevManager project, ask for a task (`trabajá la tarea #12`) or run the `work` prompt. The session finds the project from `git remote get-url origin`.

## What the plugin adds

```
plugin/
  .claude-plugin/plugin.json    the manifest — the plugin is named `devmanager`
  hooks/hooks.json              the Stop and SessionStart hooks, run with node from the plugin root
  hooks/stop-guard.mjs          will not let a session end with a task open
  hooks/session-start.mjs       leaves the token counter where the `work` skill can run it
  hooks/capture-usage.mjs       token accounting from the session transcript
  hooks/lib/state.mjs           ~/.claude/devmanager-state/<project-id>/<task-number>/*.json
  agents/                       planner · implementer · reviewer · tester
```

- **The Stop hook.** While the `work` skill has a task open it keeps `~/.claude/devmanager-state/<project-id>/<task-number>/current-task.json`, with the repository the task was started in — one folder per task, so two worktrees of the same project do not overwrite each other. A session working inside that repository cannot end until the task is closed — documentation check, closing comment, time, `submit_for_review` — and the hook leaves the tokens spent since the task started in `last-usage.json` next to it, as a fallback record. The Stop event fires at the end of every turn, so a turn that ends asking the person a question goes through: it is waiting, not leaving. Otherwise the guard gives up after two refusals in a row, and refusals older than half an hour stop counting: a guard that can hold a session forever is worse than the state it guards. Sessions in other repositories are never blocked.
- **Tokens per task.** At session start the plugin writes `~/.claude/devmanager-state/capture-usage.mjs`, a launcher for its token counter. At the close, `work` runs `node ~/.claude/devmanager-state/capture-usage.mjs --since <the task's start> --task <its number>` and logs what it prints, already in the shape `log_time` takes. The full contract is `capture-usage.mjs --since <ISO> [--task <n>] [<transcript>]`. The session's own transcript counts from `--since` on, and there is no end to the window: it runs to the moment of the count. With `--task` (`12` or `#12`), each subagent counts in full, at any hour, when the description it was launched with starts with `#<n>` and no further digit — `#6` is not `#67 planner` — or, for a subagent launched by another, when its nearest labelled ancestor's does. That is how a planner that ran before its task began is charged to it, and a reviewer of another task that ran inside the window is not. Subagents it cannot attribute — another task's, unlabelled, or with their `.meta.json` missing or corrupt — are left out, never counted by the hour, and listed under `excludedSources` with the reason; that list is printed and does not go into `log_time`. `--task` without `--since`, a value that is malformed or missing, or `--task` given twice exits 1 with the reason on stderr and nothing on stdout. Without `--task` the subagents are cut by `--since` like the session, and without either option the whole session counts. The Stop hook counts the same way, with the number and start from `current-task.json`. The counter reads the transcript named by `CLAUDE_CODE_SESSION_ID`, the session it runs in, so a second session open in the same repo is never counted. Only when that variable is missing or empty does it fall back to the newest transcript of the repo; when it carries an id that does not resolve (malformed, not found, or found in more than one folder), the counter prints `null` and time is logged without tokens.
- **The four agents**, invoked as `devmanager:planner`, `devmanager:implementer`, `devmanager:reviewer` and `devmanager:tester`. The planner has no tool that writes. The reviewer's only one is `Bash`, which it has to run git and the test commands; not writing with it is an instruction, not a restriction. Implementer and tester have every tool.

## What you lose without the plugin

The protocol is the same with or without it. Three things are not:

- **Tokens per task.** Without the hook nothing reads the session transcript, so time is logged without tokens. An absent count is honest; `work` never estimates one.
- **The block on ending a session with a task open.** The server makes up for part of it: `get_work_queue` and `list_my_tasks` flag a task left in progress with no activity for four hours, so the next session resumes it or closes it.
- **Tool restrictions on the planner and the reviewer.** Without the named agents, `work` launches generic subagents with the role text from the baseline document `work-roles`, and the restriction becomes an instruction the calling session has to verify.

## Language

This repository is written in English — it is read by developers of any organization. At **runtime** that is not the rule: a session replies to people in the organization's reply language and writes DevManager content in its documents language, both from `get_context`. Nothing here hardcodes a language.

## Working on the framework itself

```bash
npm test        # node --test, no framework, no dependencies
```

Hooks and scripts are Node (`.mjs`), never bash, and paths are joined, never concatenated: this has to run on Windows and on Linux.

## The legacy path: `init.mjs` and `template/`

Before the protocol moved into the server and the baseline, a repo got it by running `init.mjs`, which copies `template/` into it: a `CLAUDE.md` carrying the project id, `.mcp.json`, the `/work`, `/sync-docs` and `/adopt` skills, the four agents, the hooks with their state under the repo's own `.claude/state/`, and a settings file. **It still works and it is no longer required.** It is kept, frozen, for repos that already use it; new features land in the server, the baseline and the plugin, not here.

Two things to know if a repo still carries it:

- Its `/work` calls `submit_for_review` without `docs_check`. The server rejects that close in STANDARD and PRODUCTION projects, and the rejection says exactly what to add, so a session corrects it on the spot — but moving the repo to the baseline's `work` is the fix.
- Its hooks and the plugin's are separate copies. With both installed, the repo's `.claude/state/` guard and the plugin's home-directory guard do not see each other's files.

```
node init.mjs <target-dir> --project <devmanager-project-id> --name <project-name>

  --project   DevManager project id this repo works for
  --name      Human name of the project, as it reads in DevManager
  --force     Overwrite files that already exist in the target
  --dry-run   Print what would happen and write nothing
```

`/sync-docs` and `/adopt` are marked `disable-model-invocation: true` — the first because it commits, the second because it is a once-per-repo ceremony — and the baseline's `sync-docs` keeps the flag for the same reason. `work` deliberately does not carry it: its safety is the explicit go before `start_task` and the confirmation gate in front of `--phase` and `--epic`, not its invocability.
