---
name: archive-workflow
description: "Standard procedure when you operate as the archivist role: end-to-end cross-domain organization workflow (local fs / runtime envs / Feishu structure), output conventions, and memory-protocol rules to follow before any move or delete."
when_to_use: "Use as your first action when dispatched as the archivist role — the body holds the full workflow you should follow before any organize / dedupe / remove action. The archivist role prompt is intentionally identity-only and depends on this skill for procedure."
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
  - FeishuRead
  - FeishuList
  - FeishuCreateFolder
  - FeishuMove
  - FeishuDelete
  - TodoWrite
  - MemoryRead
  - MemoryWrite
roles:
  - archivist
---

# Archive Workflow

Procedure for taking a cross-domain organization request from survey to a clean, navigable, indexed result.

## Workflow

1. Read the request. Identify the scope (which directory, which conda env / pip cache / virtualenv tree, which Feishu folder), the goal (deduplicate / classify / age out / index / migrate / clean up), and the acceptance signal (what does "organized" look like).
2. The framework injects relevant prior memory automatically — check it first; you may already have notes about user preferences ("user prefers per-project conda env naming `<project>-py311`", "user wants `.pdf` docs auto-moved to ~/refs/") or prior organization decisions. But memory is a hint, not a fact — see #3.
3. Verify memory-derived assumptions before relying on them. User preferences shift, project structures change, naming conventions evolve. If memory says "user wants `.pdf` docs auto-moved to ~/refs/", probe the target directory to confirm it still exists and matches the user's current pattern before mass-moving. Memory shortens the planning; it does not skip verification.
4. Survey before touching. Enumerate, list, and size the assets in scope — local files by name/size, conda envs and their contents, pip packages and caches, virtualenv trees, Feishu folder children. Build a mental map before moving or removing anything.
5. Classify. Decide categories based on the request — by topic, by date, by file type, by project, by size, by orphan status (envs for deleted projects, packages no one imports, caches with no recent hits). Choose target locations or removal candidates for each category.
6. Confirm before destruction. For removal candidates (orphan envs, unused packages, stale caches, deduplicated files, Feishu docs no longer needed), the framework prompts the user for high-risk operations. Never bulk-remove without first verifying "is this actually unused?" — search for active references (project files importing the package, recently-modified files inside the env, scripts referencing the env name, Feishu docs still link-shared with active collaborators).
7. Execute. Move / rename / remove local files and environment artifacts; create or update index files at scope roots. For Feishu, build classification folders (e.g. `2026-01/` for monthly logs, `_unsorted/` bin); relocate or delete docs according to the plan. If the organized result needs a new Feishu document or doc-content edit, delegate the content write via your Reachable Workers — you do not author Feishu doc content directly.
8. Index. Drop a short README / INDEX file at the root of the organized scope so the next reader can navigate without re-running the survey.
9. Report. Summarize what changed, what was deduplicated / removed, what remains uncategorized, and (for Feishu scope) a list of proposed moves or new-doc requests the requester should route.
10. When a finding is durable and reusable (user's naming convention for envs, location of a standard package cache, preferred organization scheme), persist it as a memory entry before returning so future cleanups follow the same pattern. Skip the save if memory already had this and you just confirmed it.

## Output conventions

- Format: top-line summary (what scope was organized, what shape it now has), then `Local changes:` (paths moved / renamed / created / removed, grouped by category), then `Env changes:` (envs / packages / caches removed or reorganized, with one-phrase reason per item), then `Feishu changes:` (folders created / files moved or renamed / files deleted, one line per change with token; if you delegated any content writes, list the delegate's outcome here too), then `Leftover:` (files / envs / docs you could not classify and why).
- Length: match the scope. Organizing 20 files is a one-screen report; organizing a thousand or sweeping conda envs is a multi-section report.
- Index files: keep them flat and short; readers should scan in seconds.
- Stale-memory acknowledgement: if a memory-derived hint was wrong (user changed preference, env naming convention shifted, target directory disappeared), mention it in the report so the post-fact extraction updates the entry.

## Do not

- Do not delete a file, env, or Feishu doc you cannot classify — leave local files in a `_unsorted/` bin, leave Feishu docs in a `_unsorted/` folder, annotate envs as "unknown — kept" in the report. The reader decides.
- Do not remove a conda env, pip package, cache, or Feishu doc without first confirming "is this actually unused?". Search for active references before destruction.
- Do not move files across user-owned boundaries (e.g. out of the user's workspace root into system paths) without an explicit request.
- Do not skip the index file. The reader's "find what they need without re-scanning" property depends on it.
- Do not trust memory blindly. User preferences and environment layouts drift; verify before applying memory-derived rules en masse.
