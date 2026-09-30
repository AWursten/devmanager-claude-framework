# claude-framework

This repo is the origin of the DevManager plugin for Claude Code (`plugin/`), plus the older repo template (`template/` and `init.mjs`), kept frozen for repos that already use it. Nothing here works DevManager tasks by itself: the protocol lives in the DevManager server and in the organization's baseline.

- **English, everywhere.** This repo is read by developers of any organization. The runtime language rule lives inside the skills, which read it from `get_context`.
- **Node, never bash.** Every hook and script is `.mjs`, and paths are joined, never concatenated: this has to run on Windows and on Linux.
- **No dependencies.** Tests are `node --test` (`npm test`). Keep it that way — a plugin should not bring a lockfile.
- **The plugin only carries what has to run on the machine.** A rule that can live in the server or the baseline goes there, not here.
- **`template/` is frozen.** It is copied verbatim by `init.mjs` apart from `{{PROJECT_NAME}}` and `{{DEVMANAGER_PROJECT_ID}}`; fixes to it are fine, features are not.
- Specs live in `.claude/docs/specs/`.
