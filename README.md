# claude-framework

The optional Claude Code plugin for working DevManager tasks, and the older repo template it replaces.

**You do not need anything from this repo to work with DevManager.** A session that has only the DevManager connector already works tasks with the full protocol: the server hands every session its working rules when it connects, each tool result says what comes next, the close is rejected unless it declares the documentation check, and the `work`, `sync-docs` and `adopt-lite` skills come from the organization's baseline as prompts of the connector. This repo adds the part that cannot live on a server because it has to run on the developer's machine.

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

- **Optional, once per machine — the plugin:**

  ```
  /plugin marketplace add <path to, or git URL of, this repo>
  /plugin install devmanager@claude-framework
  ```

  Nothing is added to any project repo, and no `.gitignore` needs a line.

Then, in any repo with a linked DevManager project, ask for a task (`trabajá la tarea #12`) or run the `work` prompt. The session finds the project from `git remote get-url origin`.

## What the plugin adds

```
plugin/
  .claude-plugin/plugin.json    the manifest — the plugin is named `devmanager`
  hooks/hooks.json              the Stop hook, run with node from the plugin root
  hooks/stop-guard.mjs          will not let a session end with a task open
  hooks/capture-usage.mjs       token accounting from the session transcript
  hooks/lib/state.mjs           ~/.claude/devmanager-state/<project-id>/*.json
  agents/                       planner · implementer · reviewer · tester
```

- **The Stop hook.** While the `work` skill has a task open it keeps `~/.claude/devmanager-state/<project-id>/current-task.json`, with the repository the task was started in. A session working inside that repository cannot end until the task is closed — documentation check, closing comment, time, `submit_for_review` — and the hook writes the session's token usage to `last-usage.json` next to it, which is where `work` reads the tokens it logs. It gives up after two refusals per task: a guard that can hold a session forever is worse than the state it guards. Sessions in other repositories are never blocked.
- **The four agents**, invoked as `devmanager:planner`, `devmanager:implementer`, `devmanager:reviewer` and `devmanager:tester`. The planner and the reviewer have their tools restricted by configuration — they can read the repo and DevManager and write nothing.

## What you lose without the plugin

The protocol is the same with or without it. Three things are not:

- **Tokens per task.** Without the hook nothing reads the session transcript, so time is logged without tokens. An absent count is honest; `work` never estimates one.
- **The block on ending a session with a task open.** The server makes up for part of it: `get_work_queue` and `list_my_tasks` flag a task left in progress with no activity for four hours, so the next session resumes it or closes it.
- **Hard tool restrictions on the planner and the reviewer.** Without the named agents, `work` launches generic subagents with the role text from the baseline document `work-roles`, and the restriction becomes an instruction the calling session has to verify.

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
