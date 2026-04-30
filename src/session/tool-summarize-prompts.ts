/**
 * Per-tool summarization prompts. Each tool gets a custom prompt that
 * emphasises the SPECIFIC pieces of information the agent typically needs
 * from that tool's output. The model running these is `routing.extract`
 * (cheap router — Haiku 4.5 once routed).
 *
 * Design: keep what the AGENT will likely need next, drop everything else.
 * For Read we keep symbol names so the model can later refer to functions;
 * for Bash we keep exit code + stderr so failure recovery is possible; for
 * Grep we keep top files + sample matches; etc.
 */

const COMMON_PREFIX = `You are a tool-result summarizer. Your output replaces a verbose tool output in an
agent's conversation history. The agent will read your summary and may need to
make decisions based on it without re-running the tool.

Rules:
- Output the summary directly. Do NOT preface with "Here is" or "Summary:".
- Do NOT include markdown headers like # or ##. Use plain prose with bullet
  lists where natural.
- Do NOT invent facts. If the input is empty or trivial, output one short line.
- Stay under the token budget you are given.`

export const READ_SUMMARIZE_PROMPT = `${COMMON_PREFIX}

You are summarizing the output of a Read file tool. The agent needs to know
what's in this file in case it later needs to reference symbols, types, or
constants.

Preserve:
- File path (if visible in the input)
- Total line count (if visible)
- Top-level imports (top 10 by relevance — drop trivial std-lib unless they
  shape behavior)
- Top-level exports (function signatures, class signatures, type/interface
  names — keep names + arg types, drop bodies)
- Significant constants and configuration values (paths, URLs, limits, magic
  numbers explicitly named)
- Any TODO / FIXME / HACK comments verbatim
- Architecture-level structure (e.g. "this file defines the storage layer:
  appendMessage, loadTranscript, rewriteTranscript")

Drop:
- Function bodies (just signatures)
- Inline comments unless they are TODO/FIXME/HACK
- Style/formatting

Output a concise prose-with-bullets summary fitting in the budget. The agent
should be able to answer "does this file have a function called X?" or "what
does this file export?" from your summary alone.`

export const BASH_SUMMARIZE_PROMPT = `${COMMON_PREFIX}

You are summarizing the output of a Bash shell command. The agent needs to
know whether the command succeeded, what it produced, and any errors.

Preserve:
- Exit code if visible
- Whether the command succeeded or failed (your judgement)
- Any stderr lines verbatim or paraphrased (errors are critical)
- Key file paths, URLs, IDs, timestamps mentioned in stdout
- For long lists (e.g. ls, find): total count + a representative sample (top
  5-10) + structural patterns ("mostly .py files" / "split across 3
  directories")
- For build/test output: pass/fail counts, failing test names, error summary
- For git commands: branch state, key commit hashes, conflict files

Drop:
- Verbose progress output (build steps, percentages)
- Repetitive boilerplate

If the command clearly succeeded with no notable output, just say so in one
line ("Command succeeded with no output").`

export const GREP_SUMMARIZE_PROMPT = `${COMMON_PREFIX}

You are summarizing the output of a Grep search. The agent needs to know how
many matches there were and where the most important ones are.

Preserve:
- Total match count
- Top 10 matching files ranked by hit count or relevance
- For each top file: 1-2 representative match lines verbatim (with file:line
  prefix). Quote-trim long matched lines if needed.
- Patterns across hits ("most matches are in test files" / "all matches are in
  the same module")

Drop:
- Hits beyond top 10 (just give a tail count: "and 47 more matches in 12 other
  files")
- Repetitive identical matches across files

The agent should be able to decide "do I need to read any of these files?"
from your summary.`

export const GLOB_SUMMARIZE_PROMPT = `${COMMON_PREFIX}

You are summarizing the output of a Glob file-pattern search. The agent needs
to know what files matched and how they're organized.

Preserve:
- Total match count
- File extension distribution (top 5 extensions with counts)
- Directory grouping (top 5 directories with counts)
- Notable named files (config files, entry points, README, etc.)

Drop:
- Verbatim full file paths beyond a representative sample

The agent should be able to decide "is the pattern correct?" or "where should
I look next?" from your summary.`

export const WEB_FETCH_SUMMARIZE_PROMPT = `${COMMON_PREFIX}

You are summarizing the output of a WebFetch tool that retrieved a URL and
converted it to Markdown. The agent needs to know the page's content without
re-fetching.

Preserve:
- Page title (first H1 or <title> if visible)
- Content type (tutorial / API ref / news article / blog post / docs / etc. —
  your judgement)
- 5-10 key facts, claims, or takeaways from the body
- Important links / URLs mentioned in the body (max 5)
- For API/docs pages: function signatures, parameter names, code examples
  preserved verbatim if short
- For tutorials: ordered steps preserved as list

Drop:
- Navigation chrome
- Footers, "related articles" sections
- Verbatim long body paragraphs (paraphrase to bullets)

The agent should be able to answer factual questions about the page from your
summary.`

export const WEB_SEARCH_SUMMARIZE_PROMPT = `${COMMON_PREFIX}

You are summarizing the output of a WebSearch tool. The agent needs to know
what the top search results are without seeing the full list.

Preserve:
- Total result count if visible
- Top 5-8 results, each as: title — 1 line summary — URL
- Overall relevance assessment (your judgement: are results on-topic?)

Drop:
- Lower-ranked results
- Search engine metadata (timing, related searches)

The agent should be able to pick a result to WebFetch from your summary.`

export const PER_TOOL_PROMPTS: Record<string, string> = {
  Read: READ_SUMMARIZE_PROMPT,
  Bash: BASH_SUMMARIZE_PROMPT,
  Grep: GREP_SUMMARIZE_PROMPT,
  Glob: GLOB_SUMMARIZE_PROMPT,
  WebFetch: WEB_FETCH_SUMMARIZE_PROMPT,
  WebSearch: WEB_SEARCH_SUMMARIZE_PROMPT,
}

export function getPerToolPrompt(toolName: string): string | null {
  return PER_TOOL_PROMPTS[toolName] ?? null
}
