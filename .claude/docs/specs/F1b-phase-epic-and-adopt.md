# Spec F1b — Work by phase/epic, and `/adopt`

**Status:** ready to implement · **Repo:** `claude-framework` · **Depends on:** F1 (merged). No DevManager changes: everything here composes existing MCP tools. Same execution mode as always; branch `f1b`; closing report.

Two additions: `/work` learns to take a whole phase or epic as its batch, and a new `/adopt` skill packages the protocol for bringing an existing, long-running codebase into the methodology.

---

## Part 1 — `/work --phase` / `--epic`

New invocations:

```
/work --phase "Sitio público"     /work --phase 1      (1-based position)
/work --epic "Admin"
```

- **Resolution:** `get_project` gives the tree. Match phase/epic by name (case- and accent-insensitive) or by 1-based position for phases (their board order). Ambiguous or no match → list the candidates and ask; never guess.
- **Scope:** all pending stories of that phase/epic **in position order**, plus tasks directly under the epic (or in the phase) that have no story — those run last, since they carry no acceptance criteria of their own beyond their description (they are TECHNICAL/BUG by nature; the skill treats their description as the done-definition and says so in the plan comment).
- **Confirmation gate:** before touching anything, print the resolved scope — "Fase 'Sitio público': 8 historias (US-2…US-9), 3 tareas sueltas, ~N tareas totales" — and require an explicit go. These modes are bounded by the phase/epic itself, so `--limit` is not required; if given, it still caps.
- **Execution:** the Phase-3 orchestrator loop, unchanged: planner pass over the *whole* scope first, questions batched once; then story mode per story (fresh subagents per task), re-fetching `get_work_queue` between tasks; a blocked story never aborts the batch. Dependency edge case: a story whose tasks depend on tasks outside the scope is worked as far as the queue allows and left partially blocked with a comment naming the external dependency.
- **Report:** the batch report gains a first line with the scope and, per story, its resulting status (DONE / partially blocked / skipped), so the human's morning read is by story, not by task.

## Part 2 — `/adopt`

`skills/adopt/SKILL.md` — run once, in an existing repo, after the human created the DevManager project and ran `init.mjs` (which refuses to overwrite; merging an existing `CLAUDE.md` stays a documented manual step in the README).

The protocol, in order, stated as literal steps:

1. `get_context` (writing guide, languages, rigor). Everything written to DevManager follows it, in `docsLanguage`.
2. **Read the codebase** and draft, *without writing yet*: stack and structure, entities and their relations, conventions **actually followed** (a pattern honoured in 90% of the code is a convention; one honoured in half is a finding, not a convention).
3. **Interview the human.** The code cannot supply the why, the scope, or the status of half-built things. Ask, in batches, questions like: is module X current scope or abandoned; which of these two coexisting patterns is the blessed one; who is this for and what must it do next. Hard rule: **docs state what is and what was decided — never what the code suggests someone once intended.** Unresolvable items go to Open Questions, not into prose.
4. **Write, showing first.** For each document (Brief, Domain, Architecture, Conventions — Phases only if the human wants a roadmap now): show the draft in the session, get the go, then `upsert_document`. Contradictions with org-baseline conventions are surfaced explicitly: project override (project Conventions doc) or alignment task — the human picks.
5. **Propose the founding decisions.** The 3–8 load-bearing choices mined from the interview (framework, auth approach, hosting, the blessed pattern) via `propose_decision`, so an ADMIN accepts them and the log starts true. Not every historical choice — the ones a newcomer would ask "why?" about.
6. **Backlog: forward only.** Current TODOs, known bugs, next features → `create_backlog` (dry-run, show, go). **Never** backfill finished work as done stories; fictitious history poisons calibration, which starts from zero for this project.
7. Finish: `/sync-docs`, then print the handover summary — docs written, decisions awaiting an ADMIN, open questions, backlog created — and the reminder that from here the project is worked like any other (`/work`).

## Part 3 — Docs

`docs/comandos.md` gains rows for `--phase` / `--epic` (with the confirmation-gate behaviour) and an "Adoptar un proyecto existente" section summarizing when to use `/adopt` and what it will and won't do (won't: rewrite history, decide alone, write without showing). README mentions both.

## Definition of done

Skills reviewed against this spec by the reviewer agent; `comandos.md` and README updated; dogfood: run `/adopt` on a small real repo (any of Alex's existing Bitbucket side projects cloned locally) against a scratch DevManager project, with the human present for the interview, and attach the resulting docs list + decisions to the closing report; then `/work --phase 1` on the backlog it created, one story minimum, end to end.
