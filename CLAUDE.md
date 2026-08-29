# claude-framework

This repo is the framework itself, not a project that uses it. Nothing here works DevManager tasks; `template/` is what does, once `init.mjs` copies it somewhere else.

- **English, everywhere.** This repo is read by developers of any organization. The runtime language rule lives inside the skills, which read it from `get_context`.
- **Node, never bash.** Every hook and script is `.mjs`, and paths are joined, never concatenated: this has to run on Windows and on Linux.
- **No dependencies.** Tests are `node --test` (`npm test`). Keep it that way — a project adopting the framework should not inherit a lockfile.
- **`template/` is copied verbatim** apart from `{{PROJECT_NAME}}` and `{{DEVMANAGER_PROJECT_ID}}`. A new placeholder means teaching `init.mjs` about it, and its test asserts that no unknown one survives.
- Specs live in `.claude/docs/specs/`.
