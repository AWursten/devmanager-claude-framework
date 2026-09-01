---
name: adopt
description: Bring an existing codebase into the methodology — run the organization's canonical adoption protocol (the adopt-lite baseline skill), then the two steps this framework adds on top. Run once, in a repo that already has history, after init.mjs. Use when someone asks to adopt, onboard or document an existing project into DevManager.
disable-model-invocation: true
---

# /adopt

A project that already exists arrives here once. After this, it is worked like any other: `/work`.

**The protocol is not in this file.** It is `adopt-lite`, a skill of the organization's baseline, and the DevManager connector serves it as a prompt — Claude Code draws it as a slash command, so a skill stored in DevManager is used exactly like one stored in the repo. That is where adoption is defined, for every project of the organization and every tool that reads the baseline. This file is a wrapper: it points at the canonical protocol and adds the two steps that only make sense in a repo that carries this framework.

## 1. Load the canonical protocol

Invoke the connector's **`adopt-lite`** prompt and follow it **as written**, start to finish.

If it is not offered as a prompt in this session, read it instead: `list_baseline_documents` for the organization, then `get_baseline_document` with the slug of that skill, and follow the body you get back. It is a `SKILL.md`, frontmatter and all.

Do not paraphrase it, do not reorder it, and do not run a shortened version of it from memory. If the organization's baseline has no adoption skill, **stop and say so** — this repo does not carry a copy to fall back on, and inventing the protocol here is exactly the fork this wrapper exists to prevent.

## 2. Then, the two steps this framework adds

Once `adopt-lite` is done — its documents written, its decisions proposed, its backlog created — do these, in this order, and report them in the handover:

1. **Run `/sync-docs`.** The repo needs the generated copy of what was just written to DevManager: `.claude/docs/` and the managed section of `CLAUDE.md`. Without it every later session pays five MCP calls for what should be a file read.

2. **Verify the template is actually applied.** Adoption assumes `init.mjs` has run here; check it rather than assuming:

   - `CLAUDE.md` carries the project id, and the `/sync-docs` managed section is filled.
   - `.mcp.json` exists and points at DevManager.
   - `.claude/settings.json` wires the `Stop` hook to `.claude/hooks/stop-guard.mjs`, and the test, lint, typecheck and build commands in its permissions are **this project's**, not the template's placeholders for some other stack.
   - `.claude/skills/` has `work`, `sync-docs` and this skill; `.claude/agents/` has the four agents; `.claude/hooks/` has `stop-guard.mjs`, `capture-usage.mjs` and `lib/state.mjs`.
   - `.gitignore` carries the framework block — `.claude/state/`, `.claude/settings.local.json`, `CLAUDE.local.md`.

   Anything missing goes in the handover as a named gap, with what to run to fix it (`init.mjs` for a missing file, an edit for a placeholder command). Do not silently patch a half-installed template while adopting: the human needs to know the install was incomplete.

Then close as `adopt-lite` says to close, plus the line that matters here: **from now on this project is worked like any other.** `/work` for a task, a story, an epic or a phase; `/sync-docs` after a decision is accepted. `/adopt` does not run again.
