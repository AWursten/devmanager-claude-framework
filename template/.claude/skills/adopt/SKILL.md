---
name: adopt
description: Bring an existing codebase into the methodology — read the code, interview the human about what the code cannot tell you, write the project's documents and founding decisions into DevManager, and create a forward-looking backlog. Run once, in a repo that already has history, after init.mjs. Use when someone asks to adopt, onboard or document an existing project into DevManager.
disable-model-invocation: true
---

# /adopt

A project that already exists arrives here once. After this, it is worked like any other: `/work`.

This skill writes a lot to DevManager — documents, decisions, a backlog. **Every one of those writes is shown in the session and approved before it happens.** That is the whole discipline: an adoption that guesses is worse than no adoption, because from then on the guesses are the source of truth.

## Before you start

The human has already created the project in DevManager and run `init.mjs` in this repo. The project id is in `CLAUDE.md`; every DevManager call takes it as `project`.

If `CLAUDE.md` carries no project id, stop — the repo has not been initialised and this skill has nothing to write to.

If there is no human in the session, stop. Step 3 is an interview. There is no unattended version of this skill, and a run that skips the interview produces exactly the documents this framework exists to prevent.

---

## 1. Context

`get_context`. Rigor level, `responseLanguage`, `docsLanguage`, the writing guide, the conventions, the organization's baseline.

Everything this skill writes to DevManager is written **in `docsLanguage`, per the writing guide**. You talk to the human in `responseLanguage`. Those are two different languages as often as not.

## 2. Read the codebase — and write nothing yet

Read it properly: entry points, the build, the dependency manifest, the directory structure, the data model, the routes or commands, the tests, the CI config, the last few months of `git log`.

Draft, in your own notes and not in DevManager:

- **Stack and structure** — what it is built with, how it is laid out, how it runs.
- **Entities and their relations** — the domain, as the code actually models it. Table and model names are the vocabulary of the project; keep them.
- **Conventions actually followed.** The test that matters: **a pattern honoured in 90% of the code is a convention; one honoured in half of it is a finding, not a convention.** Count before you claim. A "convention" inferred from three files will be enforced by every future session against a codebase that never agreed to it.

Everything you cannot answer from the code — and there will be a lot — becomes a question for step 3, not a guess in step 4.

## 3. Interview the human

The code says what is. It does not say why, what is in scope, or what is half-built and abandoned. Only the human has that, and this is the step that decides whether the documents are true.

Ask **in batches**, not one at a time. Group the questions, send them in one message, wait. Typical shape:

- **Scope:** is module X current scope, or abandoned? Is that feature flag a rollout or a graveyard?
- **The blessed pattern:** these two approaches to the same thing coexist — which one is right, and is the other one debt or deliberate?
- **Purpose:** who is this for, what must it do next, what would count as it going badly?
- **The why behind the load-bearing choices:** why this framework, this database, this auth approach, this hosting.

**Hard rule: documents state what is and what was decided — never what the code suggests someone once intended.** "The project seems to be moving towards X" is not a fact about the project. If the human does not know either, it goes to **Open Questions** in the document, verbatim, as a question. Open Questions is a real section with real content; after an adoption, an empty one means the interview stopped asking.

## 4. Write, showing first

One document at a time. For each: **show the full draft in the session, get the go, then `upsert_document`.** Never write two and then show them — the human's correction to the first one usually changes the second.

The set is:

- **Brief** — what this is, who it is for, what it must do. Scope and non-scope.
- **Domain** — the entities, their relations, the vocabulary.
- **Architecture** — the stack, the structure, how it runs and deploys.
- **Conventions** — the ones counted in step 2, not the ones you would prefer.
- **Phases** — only if the human wants a roadmap now. An adoption does not require one, and an invented roadmap is worse than no roadmap.

**When the project contradicts the organization's baseline conventions** — the org says one thing, this codebase has always done another — surface it explicitly, in the session, and let the human choose one of exactly two outcomes:

- a **project override**, written into the project's Conventions document, saying what this project does instead and that it is deliberate; or
- an **alignment task**, in the backlog of step 6, to change the code.

Do not pick. Do not paper over it by writing the organization's version into a document the code disagrees with.

## 5. Propose the founding decisions

The **3 to 8** load-bearing choices this project rests on, mined from the interview: the framework, the auth approach, the hosting, the blessed pattern from step 3, the database. `propose_decision` for each, in the three sections — context, decision, consequences — with the *real* alternative it was chosen against, which is a thing only the human can give you.

Not every historical choice. **The ones a newcomer would ask "why?" about.** More than eight and you are logging history; fewer than three and the interview was too short.

They stay proposed until an ADMIN accepts them. Say so, and name them in the handover.

## 6. Backlog: forward only

`create_backlog` with **`dry_run: true` first**, show the result, get the go, then run it for real.

What goes in: current TODOs worth doing, known bugs, the next features the human named, any alignment task from step 4.

What never goes in: **finished work, backfilled as done stories.** Not one. It is tempting — it makes the board look inhabited on day one — and it poisons every estimate the organization makes afterwards, because calibration reads those entries as measurements. **Calibration for this project starts at zero, and that is correct.** A board with three real stories and an honest history is worth more than one with forty invented ones.

Stories carry acceptance criteria. A story without them cannot be worked — `/work` refuses it and the queue excludes it — so writing one here only creates work for later.

## 7. Hand over

1. Run **`/sync-docs`**, so the repo carries the generated copy of what was just written.
2. Print the handover, in `responseLanguage`:

   - **Documents written** — slug and title, one line each.
   - **Decisions awaiting an ADMIN** — number and what each settles.
   - **Open questions** — with the document each lives in, and who is expected to answer.
   - **Backlog created** — phases, epics, stories and tasks, by count and by name.
   - **What was deliberately not done** — no history was backfilled; plus anything the human deferred.

3. Then say the last thing plainly: **from here this project is worked like any other.** `/work` for a task, a story, an epic or a phase; `/sync-docs` after a decision is accepted. `/adopt` does not run again.

---

## What this skill will not do

- **Rewrite history.** No finished work becomes a done story, ever.
- **Decide alone.** Every contradiction, every ambiguity, every choice between two coexisting patterns goes to the human.
- **Write without showing.** No document, decision or backlog reaches DevManager before its draft has been shown in the session and approved.
- **Touch the code.** Adoption documents a codebase; it does not refactor one. The change you want to make is an alignment task in step 6.

## If something goes wrong

- **The human leaves mid-interview.** Stop where you are and say what is written and what is not. What is written is fine — the documents are separate — and a second `/adopt` resumes from the missing ones, with `expected_version` on anything already there.
- **`upsert_document` returns a version conflict.** Somebody wrote that document in the meantime. Show the current version, merge, ask again.
- **The codebase is too large to read in one session.** Say so, and adopt it by area: Brief and Architecture at the top level first, Domain and Conventions per area afterwards. Do not write a Domain document for a system you have read a fifth of.
