# About `settings.json`

<!-- DECISION: the spec asked for a commented settings file, JSONC "if supported".
     Current docs (code.claude.com/docs/en/settings) are explicit that settings
     files are strict JSON — a `//` comment or a trailing comma is a syntax error
     and the file is reported as a Settings Error at start. So the comments live
     here, in the sibling file the spec named as the fallback. -->

`settings.json` is strict JSON: no comments, no trailing commas. This file is where the reasoning goes.

## Permissions

**`allow`** — things a session should never have to ask about.

- *Read-only git.* `status`, `diff`, `log`, `show`, `branch`, `rev-parse`, `blame`, `remote -v`, `stash list`. They inspect; they change nothing.
- *Branch, stage, commit.* `git switch -c` / `checkout -b` / `add` / `commit`. `/work` opens a branch per task and commits on it; none of that leaves the machine. What leaves the machine is `git push`, and that asks.
- *Test, lint, typecheck, build.* **These four are placeholders.** They read `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` because something had to be written. Replace them with this project's real commands — `pytest`, `cargo test`, `mvn verify`, `make check`, whatever it is — or the reviewer and tester subagents will ask permission on every run.
- *Read-only DevManager tools.* Everything that only reads the board. The write tools (`add_comment`, `log_time`, `start_task`, `submit_for_review`, `propose_decision`, `upsert_document`, …) are deliberately **not** here: they change what the team sees, and the first time a session does that in a repo, somebody should watch it happen. Add them once you trust the loop.

**`ask`** — reversible only by a person.

- `git push` and `git merge`. Claude never merges (see `CLAUDE.md`), and pushing is the human's call.
- Package installs, in the five flavours a repo might use. A new dependency is a decision.
- Anything touching `.env*`, read or write. Secrets do not belong in a transcript.

**`deny`** — empty on purpose. The framework does not know what this project must protect; projects tighten. Note that `deny` and `ask` rules apply even before a teammate trusts the folder, while `allow` rules do not.

## Hooks

`Stop` runs `.claude/hooks/stop-guard.mjs`. If `.claude/state/current-task.json` exists, the session is in the middle of a DevManager task and stopping would leave the board lying: the guard blocks the stop and says what closing still requires. It also writes the session's token usage to `.claude/state/last-usage.json` on its way through, which is where `/work` reads the numbers it logs.

The guard limits its own blocks per task, so it can never trap a session in a loop. See the header comment in the hook.

## Where else settings can come from

Precedence, highest first: managed (organization) → `claude --settings` → `.claude/settings.local.json` (yours, this project, gitignored) → `.claude/settings.json` (this file, shared) → `~/.claude/settings.json` (yours, everywhere). Put anything personal in `settings.local.json`; it is already gitignored.
