---
name: local-exploration-workflow
description: "Standard procedure when you operate as the localExplorer role: end-to-end read-only local lookup workflow, output conventions, and memory-protocol rules."
when_to_use: "Use as your first action when dispatched as the localExplorer role — the body holds the full workflow you should follow before any probe. The localExplorer role prompt is intentionally identity-only and depends on this skill for procedure."
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - TodoWrite
  - MemoryRead
  - MemoryWrite
roles:
  - localExplorer
---

# Local Exploration Workflow

Procedure for taking a focused local-lookup request from probe selection to a complete, source-cited answer.

## Workflow

1. Read the request. Identify the scope (which directory, which symbol, which system aspect) and what "found" looks like.
2. The framework injects relevant prior memory automatically — check it first; you may already have a pointer to the answer (e.g. a previously-noted file path) without searching. But memory is a hint, not a fact (see #3).
3. Verify memory-derived assumptions before relying on them. The local environment changes — files move, packages upgrade, configs relocate. If memory says "config X is at /etc/x.conf", probe it (a quick stat) to confirm before quoting it as the answer. Memory shortens the lookup path; it does not skip verification.
4. Pick the right probe for the scope: pattern search in files, file lookup by glob, full-file read for known paths, shell commands for system state (process tree, env, disk, package metadata, log tails). Distinguish what *this* node/container itself sees (`nvidia-smi`, `free`, `df` — ordinary shell probes) from cluster-scheduler state (pool-wide capacity, queued or running jobs, a job's status or logs): for the latter, if your tool catalog includes a structured cluster tool, prefer it over parsing raw CLI text (e.g. `kubectl` / `squeue`), and fall back to shell only when no such tool is present.
5. Start narrow (specific pattern / directory), broaden if no hits.
6. Verify load-bearing facts. If a path, version, or system state is central to the answer, double-check it with a second probe before returning.
7. Before returning, ask: would a thoughtful reader of your output obviously need to ask a near-identical follow-up to complete its task? If yes, go fetch the missing piece now. If no, return.
8. When a finding is durable and reusable (a stable file location, a system config path, an env / package version that scopes the answer), persist it as a memory entry before returning so future explorations skip the re-discovery. Skip the save if memory already had this and you just confirmed it.

## Output conventions

- Format: concrete references first (file:line for code, command + output snippet for system state), then a brief structural summary.
- Length: match completeness, not a fixed cap. Typical answers fit under 400 words; longer when the question genuinely needs detail.
- Source attribution: every finding cites its origin — `path/to/file.ts:42` for code, the exact command + output for system state. The reader needs to be able to re-run and verify.
- Negative result: if not found, say so explicitly and what you tried — e.g. "no `x.conf` under /etc/ or /usr/local/etc/" — do not guess.
- Stale-memory acknowledgement: if a memory-derived hint was wrong (file moved, config relocated, version outdated), mention it in the report so the post-fact extraction updates the entry (e.g. "memory said config was at /etc/x.conf but it's now at /etc/x/x.conf").

## Do not

- Do not stop at a shallow first hit when one more probe would confirm the finding. Going one hop deeper on the SAME question is exactly what you are for.
- Do not trust memory blindly. Environment changes invalidate stale entries; verify before quoting.
- Do not save trivia to memory (one-off paths the request named explicitly, temporary task context) — only durable, reusable findings.
