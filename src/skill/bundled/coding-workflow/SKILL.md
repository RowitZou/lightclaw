---
name: coding-workflow
description: "Standard procedure when you operate as the coder role: the end-to-end workflow, output conventions, and memory-protocol rules to follow before any tool call."
when_to_use: "Use as your first action when dispatched as the coder role — the body holds the full workflow you should follow. The coder role prompt is intentionally identity-only and depends on this skill for procedure."
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - TodoWrite
  - MemoryRead
  - MemoryWrite
roles:
  - coder
---

# Coding Workflow

Procedure for taking a coding request from understanding to verified delivery.

## Workflow

1. Read the request. Identify the target file(s), the change to make, and the acceptance signal (test that should pass / behavior that should change).
2. The framework injects relevant prior memory automatically — check it first; you may already have a hint (e.g. "typecheck is `pnpm typecheck`", "this repo uses pnpm + tsdown", "test fixture lives at X/Y/Z") that saves discovery. But memory is a hint, not a fact — see #3.
3. Verify memory-derived assumptions before relying on them. Build tools change, package.json migrates, command names drift. If memory says "typecheck is `pnpm typecheck`", a quick probe (`pnpm typecheck --help` or running it) confirms before you depend on it. Memory shortens the lookup path; it does not skip verification.
4. Locate the relevant code: search for symbols, glob for file patterns, read what looks load-bearing. Skim before editing — wrong-file edits cost more than the extra read.
5. Plan the change before writing. If the change spans multiple files, list them in order; if it has a non-trivial control-flow change, sketch the new shape mentally before touching code.
6. Make the change. Prefer narrow edits over full-file rewrites — rewrites lose review signal. New files only when there is no existing file to extend.
7. Verify. Run the project's typecheck / lint / test commands. When the project offers a standardized verification path, use it rather than reinventing the same checks ad-hoc each time. If a test is missing for the change, add one. If the test fails, fix the cause; do not skip or mark as expected-failure.
8. Report. Name every file you touched, the verification you ran with its result, and any follow-up the reader should know about.
9. When you noticed a durable project fact during the work (a build command, a fixture location, a project convention not documented in LIGHTCLAW.md), persist it as a memory entry before returning so future coding sessions skip the re-discovery. Skip the save if memory already had this and you just confirmed it.

## Output conventions

- Format: a short top-line summary, then a `Files changed:` list with one line per file (path + one-phrase what), then a `Verification:` block with the commands you ran and their outcomes.
- Length: match the change. A one-file bug fix gets a short report; a multi-file feature gets a longer one. Do not pad.
- Follow-ups: if you noticed adjacent issues you did not fix (out of scope), call them out at the end so the reader can decide whether to address them.
- Stale-memory acknowledgement: if a memory-derived hint was wrong (build command changed, fixture moved, convention updated), mention it in the report so the post-fact extraction updates the entry (e.g. "memory said typecheck was `pnpm tc` but it's now `pnpm typecheck`").

## Do not

- Do not skip verification "because the change is small". Even a one-line fix may break the build; running typecheck once is cheap insurance.
- Do not trust memory blindly. Build tools and conventions drift; verify before depending on a memory-derived command or path.
