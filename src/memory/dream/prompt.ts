export function buildDreamPrompt(params: {
  memoryDir: string
  transcriptDir: string
  sessionIds: string[]
}): string {
  const sessionList = params.sessionIds.length > 0
    ? params.sessionIds.map(sessionId => `- ${sessionId}`).join('\n')
    : '- [none]'

  return `# Dream: Memory Consolidation

You are performing a dream: a reflective pass over durable memory files. Synthesize recent learning into organized memories so future sessions can orient quickly.

Memory directory: \`${params.memoryDir}\`
Memory index file: \`MEMORY.md\` (entrypoint; keep under ~200 lines and ~25 KB; one-line entries only)
Session transcripts root: \`${params.transcriptDir}\` (large JSONL files; grep narrowly, do not read whole files)

Sessions touched since last consolidation (${params.sessionIds.length}):
${sessionList}

## Phase 1 - Orient

- List the memory directory to see what already exists.
- Read \`MEMORY.md\` to understand the current index.
- Skim existing topic files so you improve them instead of creating duplicates.

## Phase 2 - Gather Recent Signal

Look for information worth preserving. Use sources in this order:

1. Existing memories that drifted or contradict newer observations.
2. Narrow transcript search when you need specific context:
   \`grep -n "<narrow term>" ${params.transcriptDir}/<sessionId>/transcript.jsonl | tail -50\`

Do not exhaustively read transcripts. Search only for things you already suspect matter.

## Phase 3 - Consolidate

For each durable fact, write or update a memory file at the top level of the memory directory using the auto-memory format described in your system prompt.

Focus on:

- Merging new signal into existing topic files rather than creating near-duplicates.
- Converting relative dates like "yesterday" or "last week" into absolute dates.
- Fixing contradicted facts at the source when newer evidence clearly disproves them.

## Phase 4 - Prune And Index

Update \`MEMORY.md\` so it stays under 200 lines and under ~25 KB. It is an index, not a dump. Each entry should be one short line:

\`- [Title](file.md) - one-line hook\`

- Remove pointers to memories that are stale, wrong, or superseded.
- Shorten verbose index entries and move detail into topic files.
- Add pointers to newly important memories.
- Resolve contradictions by fixing the wrong file.

Tool constraints for this run: Bash is restricted to read-only commands such as \`ls\`, \`find\`, \`grep\`, \`cat\`, \`stat\`, \`wc\`, \`head\`, and \`tail\`. Anything that writes, redirects to a file, or modifies state will be denied.

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed, say so.`
}
