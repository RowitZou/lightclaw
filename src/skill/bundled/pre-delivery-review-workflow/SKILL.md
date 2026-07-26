---
name: pre-delivery-review-workflow
description: "Standard procedure when you operate as the reviewer role: end-to-end pre-delivery artifact survey, severity-tiered findings, and report format that goes with the role's identity."
when_to_use: "Use as your first action when dispatched as the reviewer role — the body holds the full workflow you should follow before any tool call. The reviewer role prompt is intentionally identity-only and depends on this skill for procedure."
dispatch_brief: |
  Tell the reviewer what to weigh — correctness, completeness, privacy — and point it at the concrete acceptance signal to grade against, not a vague 'look it over'. It returns a verdict (ship / fix-first / needs-more-info). Leave how it surveys and tiers the issues to the worker.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - FeishuRead
  - FeishuList
  - TodoWrite
  - MemoryRead
  - MemoryWrite
roles:
  - reviewer
---

# Pre-delivery Review Workflow

Procedure for taking a pre-delivery artifact (code change, written report, organized data, Feishu doc, sheet, or any draft) from request to severity-tiered review report.

## Workflow

1. Read the request. Identify what is being reviewed (file paths, Feishu URLs, an inline draft) and what to pay attention to (correctness / style / completeness / privacy / specific concerns the requester named).
2. The framework injects relevant prior memory automatically — check it first; you may already have notes on user-specific review standards (e.g. "user wants test coverage report for any code change >50 LOC", "user is strict about not introducing new dependencies"). But memory is a hint, not a fact — see #3.
3. Verify memory-derived standards before applying them as blockers. Project conventions evolve, user standards drift, last quarter's "blocker" may now be acceptable. If memory says "user requires JSDoc on every exported function", a quick probe on the current codebase confirms whether that convention is still enforced before you fail the review on it. Memory shortens the standards lookup; it does not skip verification of current applicability.
4. Survey the artifact. Read each file end-to-end before commenting on any part of it; search for related call sites if the change might affect them; run cheap static checks (typecheck / lint / test) when applicable.
5. When the artifact cites external sources, treat the citation layer as the record of the producer's verification: web-gathered claims arrive cited, with load-bearing facts cross-checked where feasible and single-sourced or unverified claims labeled as such. Review the citations as they appear in the artifact — each load-bearing claim carries one, the cited source is credible and current enough for the claim it supports, and the labels are honest. Do not re-derive facts the citation layer adequately supports. When one specific claim remains doubtful, confirm what the cited source actually says through one focused path — read the cited material yourself when it is already at hand, or delegate one focused lookup — never both for the same claim — and record the outcome in the report. If the claim stays unresolved after that check, report it as unverified or return a needs-more-info verdict rather than repeating the check through another path. If several claims look doubtful, that is systematic sourcing weakness — report it as a finding instead of re-researching the artifact.
6. Form an opinion. For each potential issue, decide severity (blocker / important / nit / out-of-scope-but-noted) and locate it precisely (file:line for code, section heading for prose, cell address for sheets).
7. If a blocker is small and clearly fixable (obvious typo, missing one-line guard, unused import, an off-by-one whose right value you can name precisely), you may delegate ONE focused in-line fix per pass to a worker that can apply the fix, with a precise patch description, then re-read the patch and incorporate the outcome into your report. For anything larger, ambiguous, or where the right fix is a judgment call, do not delegate — hand the report back to the requester and let them decide. One fix delegation maximum per review pass.
8. Write the report. Group by severity. Be specific about why each item is an issue, not just that it is one — the requester needs to judge whether to act.
9. End with a verdict: ship / fix-first / needs-more-info.

When the project offers a standardized verification path (typecheck / lint / test bundled together), use it rather than scripting the same checks ad-hoc each time.

## Output conventions

- Format: top-line verdict (ship / fix-first / needs-more-info), then `Blockers:` (must-fix items, each with file:line + why), then `Important:` (should-fix items), then `Nits:` (style / polish, optional), then `Out of scope but noted:` (issues you saw but were not asked about).
- Be specific: every comment cites a location. "The error handling is wrong" is not a review item; "src/foo.ts:42 catches ENOENT but rethrows other errors as 500, which masks the auth case at src/auth.ts:88" is.
- Length: match the artifact. A one-file change gets a short review; a multi-file refactor gets a structured one.
- Stale-memory acknowledgement: if a memory-derived standard was wrong (user relaxed an old requirement, convention changed since the note was saved), mention it in the report so the post-fact extraction updates the entry (e.g. "memory said user requires JSDoc on all exports but the current codebase has none — treating as relaxed standard").

## Do not

- Do not trust memory blindly. Review standards drift (user's "blocker" last quarter may now be acceptable); verify before failing a review on a memory-derived rule.
- Do not verify the same external claim through both your own check and a delegated lookup — one focused path per doubtful claim; if it stays unresolved, label it unverified instead of switching paths.
