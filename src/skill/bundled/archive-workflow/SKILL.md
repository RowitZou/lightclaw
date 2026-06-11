---
name: archive-workflow
description: "Standard procedure when you operate as the archivist role: a structured methodology for organizing the user's accumulated work — separate project from project, index from detail, durable artifacts from one-off scratch — across local files, runtime environments, and Feishu workspace structure, with the memory and confirmation rules to follow before any move or delete."
when_to_use: "Use as your first action when dispatched as the archivist role — the body holds the full archiving methodology you follow before any organize / dedupe / remove action. The archivist role prompt is intentionally identity-only and depends on this skill for procedure."
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

A methodology for turning an accumulated, cluttered workspace into a structured, navigable archive. The clutter is real: tasks pile up, one-off scripts and intermediate files scatter, and projects bleed into each other until nobody can find the actual deliverable. Your job is to impose a repeatable structure, not to do a one-time tidy.

## Principles (every organized scope ends up satisfying these)

1. **One project, one home.** Every artifact belongs to exactly one project / task directory. Loose files and cross-project clutter in a shared root is the disease — give each project its own boundary.
2. **Index is separate from detail.** Every scope carries a navigable index — a top-level catalog plus a per-project README — so a reader finds what they need without scanning the tree. The index is the finding aid; the detail lives in subdirs.
3. **Sort by lifecycle role, not by file type.** Where an artifact lives is decided by what it IS in the task's lifecycle — a durable deliverable, a reusable tool, a raw input, or one-off scratch — not by its extension. This is what tames scattered temp scripts.
4. **Raw inputs are immutable.** Original data, downloads, and references are read-only; transformations write new files rather than overwriting the source, so a result can always be traced back.
5. **Scratch is quarantined and ages out.** One-off temp scripts and intermediate outputs live in a scratch area with a time-to-live; durable things never sit in scratch, and scratch never sits in the project root.

## Target shape

Converge each scope toward this shape. The lifecycle *roles* are the invariant; the exact folder names adapt to the project (a code project may call kept code `src/`, a report project `analysis/`).

```
<workspace-root>/
  INDEX.md                catalog — one line per project: what it is, where, status, last touched
  <project>/
    README.md             finding aid — what this is, what's inside, how to run / navigate
    deliverables/         the durable outputs the task actually produced
    scripts/              code kept because it is reusable, named by function
    data/                 inputs / sources / downloads (raw = read-only)
    scratch/              one-off temp scripts + intermediate outputs (TTL, purge candidate)
    _archive/             superseded but kept, not deleted
  _unsorted/              cannot attribute yet — never deleted
```

## Classifying an artifact

For each file, decide its role, then route it:

- **Deliverable** — the thing the task was for → `deliverables/`, named clearly, listed in the README.
- **Reusable** — a script or tool that will be useful again → `scripts/`, named by what it does, with a one-line header saying what it is. This is how a temp script earns its keep — it gets promoted, named, and indexed.
- **Raw input** — data, downloads, references → `data/`, treated read-only.
- **Scratch** — a one-off temp script, debug output, or intermediate file → `scratch/`, under the aging policy. Purge only after confirming no deliverable or kept script depends on it.
- **Unknown** — you cannot tell → `_unsorted/`, never deleted.

The temp-script rule that fixes the mess: a temp script is either promoted (reusable → `scripts/`, named + indexed) or quarantined (one-off → `scratch/`, ages out). It never stays loose in a project root or the workspace root.

## Workflow

1. **Survey and attribute.** Enumerate the scope (`find` / `du` / mtime); for each artifact infer which project it belongs to and its lifecycle role, from its path, content, references, and age. Check injected memory for the user's established conventions (where projects live, naming schemes, preferred buckets) — but verify a convention still holds before applying it en masse.
2. **Draw project boundaries.** Group artifacts by project and give each its own directory; pull cross-project clutter out of the shared root into the project it belongs to.
3. **Route by role.** Move each artifact into its lifecycle bucket per the classification above. Keep raw inputs read-only.
4. **Promote or quarantine scratch.** Reusable temp scripts → `scripts/`, named with a one-line header and a README entry. True one-offs → `scratch/` with a TTL. Before purging anything, search for active references (a deliverable or script that imports / calls it); the framework will prompt you on the destructive step.
5. **Index.** Write the top-level `INDEX.md` (one line per project) and each project's `README.md` (what it is, what's inside, how to navigate, the aging policy for its scratch). "A reader finds it without re-scanning" is the acceptance signal.
6. **Report.** See Output conventions.
7. **Persist durable findings.** When you learn a reusable convention (the user's project-root location, a naming scheme, a preferred layout), save it as a memory entry before returning — unless memory already had it and you just confirmed it.

## Runtime environments (conda / pip / virtualenv)

Same principles, applied to environments. **Survey**: `conda env list`; `du -sh` per env; `pip cache dir` + size; stray virtualenvs (`find . -name pyvenv.cfg`). **One project, one env**: an env serves a project; an env for a deleted / abandoned project is the env-equivalent of orphan scratch. **Reference check before removal**: never remove an env / package / cache without confirming nothing live uses it — recent activity inside the env, scripts naming it, active imports. **Reproducibility is the index**: keep the project's `environment.yml` / `requirements.txt` so the env can be rebuilt; that file is the env's finding aid. Removal (`conda env remove`, `pip cache purge`) is high-risk; the framework prompts.

## Feishu workspace structure

Same principles, applied to the cloud workspace. **Survey** with `FeishuList` to walk the user's workspace folder tree. **One project, one folder** plus an index doc at the workspace root; build classification folders with `FeishuCreateFolder` (e.g. `2026-01/` for monthly logs, `_unsorted/` bin), relocate with `FeishuMove`. **Prune** stale docs with `FeishuDelete` (native trash) — high-risk and approval-gated each time; check a doc is not still link-shared with active collaborators. **Content is out of scope**: you restructure and prune; you do not author or edit doc content. When the organized result needs a new doc or a content edit, delegate the write via your Reachable Workers and keep structure ops in your own hand.

## Output conventions

- Format: top-line summary (what scope was organized, what shape it now has), then `Structure:` (project boundaries drawn, buckets created), then `Local changes:` (artifacts moved / promoted / quarantined / removed, grouped by project then role), then `Env changes:` (envs / packages / caches reorganized or removed, one-phrase reason each), then `Feishu changes:` (folders created / files moved / deleted, one line + token each), then `Leftover:` (what landed in `_unsorted/` and why).
- Length matches the scope: a single project is a one-screen report; a whole-workspace sweep is multi-section.
- Index files stay flat and short — readers scan in seconds.
- Stale-memory acknowledgement: if a memory-derived convention was wrong (project moved, naming changed), say so in the report so post-fact extraction updates the entry.

## Do not

- Do not leave one-off scratch loose in a project root or the workspace root — it goes in `scratch/` or it is purged after a reference check. Loose scratch is the exact mess you exist to prevent.
- Do not delete anything you cannot classify — local files to `_unsorted/`, Feishu docs to an `_unsorted/` folder, envs annotated "unknown — kept" in the report. The reader decides.
- Do not remove a file, env, package, cache, or Feishu doc without first confirming nothing live depends on it.
- Do not overwrite raw inputs — transformations produce new files so results stay traceable.
- Do not touch the framework-managed `.lightclaw/` directory in the workspace — its inbox / downloads / scratch are aged by the framework, not by you.
- Do not move artifacts across user-owned boundaries (out of the workspace root into system paths) without an explicit request.
- Do not author or edit Feishu doc content — propose it in the report or delegate the write.
- Do not skip the index. The "find it without re-scanning" property depends on it.
- Do not trust memory blindly — conventions drift; verify before applying en masse.
