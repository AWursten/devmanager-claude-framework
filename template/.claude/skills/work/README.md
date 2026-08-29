# `/work`, walked through dry

What actually happens when someone types `/work #12`, so you can recognise it going wrong. Nothing here is a second source of truth — `SKILL.md` is the protocol; this is a transcript of it.

## The happy path

```
you    /work #12

claude get_context(project)
       → rigor STANDARD · replies es · docs es · writing guide · conventions
       get_task(project, "#12")
       → "Validate the invoice CUIT before saving" · story US-2 · 3 criteria · no estimate

       [planner subagent]
       → approach · 4 files · 1 risk · 1 open question · estimate M / 25 ai / 15 human

       add_comment(project, "#12", "<the plan, in Spanish, per the writing guide>")
       set_task_estimate(project, "#12", size M, ai 25, human 15, confidence MEDIUM, assumptions…)

claude Antes de implementar: ¿el CUIT de un proveedor extranjero se guarda igual
       o se rechaza? La historia no lo dice.

you    Se guarda, marcado como extranjero.

       (that answer is now a fact about the project — step 9 will offer to
        put it in a document, not leave it in a comment)

claude ¿Avanzo con el plan?

you    dale
```

That "dale" is **the go**. Nothing before it may touch the board's state or the branch.

```
claude start_task(project, "#12")
       git switch -c task/12-validar-cuit
       write .claude/state/current-task.json   ← the guard is armed from here

       [implementer subagent] → diff, npm test green, npm run lint green
       [reviewer subagent]    → 3/3 criteria met · 0 blocking · 1 non-blocking
       [tester subagent]      → STANDARD: 4 tests added, permission path covered,
                                 the AFIP timeout path not covered (needs a stub)
```

Then the close, and this is the part with the interesting mechanism:

```
claude (tries to end the turn)

Stop hook → current-task.json exists
          → capture-usage over the transcript + the three subagent transcripts
          → writes .claude/state/last-usage.json
          → BLOCKS, with the four things closing requires

claude add_comment(project, "#12", "<closing summary>")
       log_time(project, "#12", minutes 34, source "AI",
                tool "claude-code/claude-opus-5",
                tokens { tokensIn, tokensOut, tokensCacheRead, tokensCacheWrite, usageJson })
       submit_for_review(project, "#12", summary_md)
       → "moved to In review"
       rm .claude/state/current-task.json

claude (ends)  → Stop hook: no open task → allowed
```

The blocked stop is not a failure mode. It is how the token numbers get captured at all: the hook is the only thing that is handed the transcript path, and it runs at exactly the moment the session thinks it is finished.

## Where it stops on purpose

| Situation | What `/work` does |
|---|---|
| Story has no acceptance criteria | Stops at step 2. Nothing to verify against. |
| The planner has an open question, nobody is in the session | Posts the questions as a comment and stops. No branch, no `start_task`. |
| No explicit go | Stops after the plan. A plan that looks right is not approval. |
| Reviewer still blocking after one round trip | Posts the findings, leaves the task in progress, stops. |
| `log_time` has no tokens to log | Logs the minutes without tokens, and says so. |
| Task cannot be finished | Comments why, logs the time spent, clears the state file. Never silence. |

## The two state files

Both under `.claude/state/`, both gitignored, neither worth recovering.

- **`current-task.json`** — `{ project, task, startedAt }`. Exists only between step 4 and step 8. Its presence is the entire input to the `Stop` hook's decision.
- **`last-usage.json`** — the token totals, per model and per source (`main`, `agent-*`). Written by the hook, read by step 8.

A third, `stop-guard.json`, is the guard's own block counter. It exists so the guard cannot hold a session forever: two refusals per task and it stands aside. If you ever need it gone, delete it.

## Checking the pieces without running a task

```bash
node .claude/hooks/capture-usage.mjs                 # this session's tokens, as JSON
node .claude/hooks/capture-usage.mjs <transcript>    # a specific transcript

# Provoke the guard deliberately:
mkdir -p .claude/state
echo '{"project":"p","task":"#0","startedAt":"2026-01-01T00:00:00Z"}' > .claude/state/current-task.json
# …then end a turn. It should refuse, twice, and then let go.
rm .claude/state/current-task.json .claude/state/stop-guard.json
```
