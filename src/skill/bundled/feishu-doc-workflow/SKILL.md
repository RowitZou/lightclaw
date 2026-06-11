---
name: feishu-doc-workflow
description: "Standard procedure when you operate as the feishuSecretary role: end-to-end Feishu cloud-doc and cloud-space operations workflow, output conventions, permission/ancestry rules, and memory-protocol guidance to follow before any read / write / move / delete."
when_to_use: "Use as your first action when dispatched as the feishuSecretary role — the body holds the full workflow plus Feishu-specific facts (URL share intent, inbox file location, permission and ancestry rules) you should follow before any operation. The feishuSecretary role prompt is intentionally identity-only and depends on this skill for procedure."
allowed-tools:
  - Read
  - Grep
  - Glob
  - FeishuRead
  - FeishuWriteDoc
  - FeishuWriteSheet
  - FeishuCreateFile
  - FeishuList
  - FeishuCreateFolder
  - FeishuMove
  - FeishuDelete
  - TodoWrite
  - MemoryRead
  - MemoryWrite
roles:
  - feishuSecretary
---

# Feishu Cloud-Doc Workflow

Procedure for taking a focused Feishu workspace request from URL/token resolution through execution to a complete, citation-bearing result.

## Workflow

1. Read the request. Identify the target resource (URL, token, name, or path under the user workspace), the operation (read / write / create / list / move / delete), and what "done" looks like.
2. The framework injects relevant prior memory automatically — check it first; you may already have a hint (e.g. "user's 'PR review notes' folder is at `<token>`", "monthly logs go under `/<year>/<month>/`") that saves discovery. But memory is a hint, not a fact — see #3.
3. Verify memory-derived assumptions before relying on them. Feishu tokens can be moved or deleted, user preferences shift, folder structures evolve. If memory says "PR review notes folder is at `<token>`", a quick list-by-token confirms the token still resolves before you assume it. Memory shortens the lookup path; it does not skip verification.
4. For read operations: pull the URL or token, return the content with citations to the source location.
5. For write operations: confirm the target exists and is mutable; pick the right write path (editing existing docs / sheets vs creating new ones); execute. Permission grants are handled for you — if the result returns `permission_grants.errors`, report that the link needs manual sharing rather than asserting it is ready.
6. For workspace navigation: list folder children to discover; create subfolders inside the user workspace; relocate or rename via move; deletion is high-risk and approval-gated each time.
7. After every operation that mutates a resource, return the URL, token, and any new collaborator info so the reader can verify or share.

## Background on Feishu specifics

- Pasted Feishu URLs in the request are explicit user share intent and bypass workspace ancestry checks. Tokens obtained by walking down from the user workspace (via list) are ancestry-cleared automatically. Do not write to a token you cannot prove is inside the current user's workspace — such writes are rejected; surface that as a clean "out-of-workspace" reply instead of looping.
- When the user attached a file via the channel inbox, it lives at `<workspaceRoot>/.lightclaw/inbox/<chatId>/<fileName>`; read it before deciding what to upload to Feishu.
- Every mutating Feishu operation passes an approval gate outside your turn. Delete is high-risk by design — its approval has no "always allow"; when the task calls for a deletion, issue it, and the gate decides.

## Output conventions

- Format: list each affected resource on its own line as `name (token: <token>) <url>`. Plain paragraphs only for narrative summary at the top.
- Permission outcomes: when `permission_grants` contains `failed` or `skipped-no-binding`, state explicitly that the reader may need to share the doc manually and quote the error.
- Length: match the operation. A single read returns the doc body plus one citation line; a 10-file move returns one summary line plus per-file outcome.
- Stale-memory acknowledgement: if a memory-derived hint was wrong (folder token relocated, user changed naming convention, monthly folder structure shifted), mention it in the report so the post-fact extraction updates the entry (e.g. "memory said PR review folder was at `<old-token>` but it now lives at `<new-token>`").

## Do not

- Do not retry a deletion after a deny — a denial is a decision, not a retry cue.
- Do not collapse multi-file outcomes into "done"; list each one so the reader can audit.
- Do not trust memory blindly. Feishu workspace structures evolve (tokens move, folders reorganize, user preferences change); verify before relying on a memory-derived token or path.
