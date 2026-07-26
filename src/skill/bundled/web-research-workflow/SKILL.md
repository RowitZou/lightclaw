---
name: web-research-workflow
description: "Standard procedure when you operate as the webSearcher role: end-to-end web-retrieval workflow, output conventions, and memory-protocol rules to follow before any fetch."
when_to_use: "Use as your first action when dispatched as the webSearcher role — the body holds the full workflow you should follow before any search. The webSearcher role prompt is intentionally identity-only and depends on this skill for procedure."
allowed-tools:
  - WebFetch
  - WebSearch
  - Read
  - Grep
  - Glob
  - TodoWrite
  - MemoryRead
  - MemoryWrite
roles:
  - webSearcher
---

# Web Research Workflow

Procedure for taking a focused web-retrieval request from source discovery to a complete, source-cited answer.

## Workflow

1. Read the request. Identify the specific information needed and what "complete" looks like for it.
2. The framework injects relevant prior memory automatically — check it first; you may already have a hint to the answer (e.g. a previously-noted vendor docs URL) without searching. But memory is a hint, not a fact — see #3.
3. Verify memory-derived assumptions before relying on them. Web sources move, paywalls appear, docs get reorganized. If memory says "vendor X's docs live at <URL>", spend one fetch to confirm the URL still serves the expected content before quoting it as the answer. Memory shortens the lookup path; it does not skip verification.
4. Search broadly for candidate sources. Prefer primary sources (official docs, vendor sites, release notes, papers) over secondary commentary.
5. Fetch what you need to fully answer. Chase down prerequisites, follow-up references, and second sources for load-bearing facts — multi-hop is fine when it serves the SAME question.
6. Verify the facts the answer stands on. If a number, date, version, price, or official statement would materially change the conclusion if wrong, cross-check it against one independent source. Once one credible independent source confirms it, stop — unless the sources disagree, the stakes warrant more confidence (health, legal, financial, or similarly consequential claims), or the request itself asks for extra confirmation; further confirmations usually add cost faster than confidence. Non-load-bearing details supported by a credible primary source need no second fetch. If no second source surfaces after two targeted searches, report the claim as single-sourced and say so plainly. If the sole source is not strong enough to support the claim, report the claim as unverified instead. Cite every source you used.
7. Before returning, ask: would a thoughtful reader of your output obviously need to ask a near-identical follow-up to complete its task? If yes, go fetch the missing piece now. If no, return.

## Output conventions

- Format: prefer bulleted concrete facts with inline source URLs. Plain paragraphs only when the question genuinely needs flowing prose.
- Length: match completeness, not a fixed cap. Typical answers fit under 400 words; longer when the question genuinely needs detail.
- Source attribution: cite inline as `[<publisher or URL>]` next to each fact. When you cross-checked, list every source next to the fact (e.g. `[Anthropic blog 2026-05-10] [TechCrunch 2026-05-11]`). The reader infers confidence from citation density — you do not narrate that judgment.
- Time sensitivity: when a fact is dated (release versions, prices, statuses), include the source's published or updated date, or the date you fetched it.
- Downloaded files: whenever a binary (PDF, image, archive, office doc) materializes during retrieval into `.lightclaw/downloads/<file>`, include the local path in the return alongside the source URL (e.g. `File downloaded to .lightclaw/downloads/<file>.pdf`). The reader cannot guess the local filename — without this line it will not know the file is available.
- Disagreement between sources: report both versions with their sources; do not pick a winner.
- Stale-memory acknowledgement: if a memory-derived hint was wrong (URL 404'd, vendor reorganized docs, mirror moved), mention it in the report so the post-fact extraction updates the entry (e.g. "memory said vendor X docs at <old URL> but it now redirects to <new URL>").
- Negative result: if the answer is not findable within available budget, say so explicitly — e.g. "no usable source found for X within 4 queries" — do not invent.

## Do not

- Do not stop at a shallow first hit when one more fetch would complete the answer. Going one hop deeper on the SAME question is exactly what you are for.
- Do not trust memory blindly. Web sources change (URLs move, paywalls appear, docs reorganize); verify before quoting a memory-derived URL or fact.
