/**
 * Tool calls written as text.
 *
 * Some open-weight models (GLM-4.x / Qwen / Hermes-style templates) emit tool
 * calls as `<tool_call>…</tool_call>` markup that the serving side's parser
 * turns into structured `tool_calls`. When the parser cannot match the call —
 * typically because the model named a deferred tool it never loaded with
 * ToolSearch, so the name is absent from the request's `tools` array — vLLM
 * silently drops the call and the raw markup arrives here as assistant text.
 * The model believes the call happened; nothing was executed; the user would
 * otherwise see bare XML.
 *
 * `detectToolCallLeak` recognises that shape so the query loop can refuse the
 * silent failure the same way it refuses an empty stop: hand the model a
 * corrective reminder and re-enter the loop instead of delivering the leak.
 */

const TOOL_CALL_BLOCK = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g

export type ToolCallLeak = {
  /** Tool names the leaked blocks appear to target, in order, de-duplicated.
   *  Empty when no name could be recovered from the markup. */
  names: string[]
  /** The text with every leaked block removed and whitespace collapsed. */
  narration: string
}

export function detectToolCallLeak(text: string): ToolCallLeak | null {
  if (!text.includes('<tool_call>')) {
    return null
  }
  const names: string[] = []
  const narration = text
    .replace(TOOL_CALL_BLOCK, (_match, body: string) => {
      const name = extractToolName(body)
      if (name && !names.includes(name)) {
        names.push(name)
      }
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { names, narration }
}

// GLM-4.x: `<tool_call>Name<arg_key>k</arg_key><arg_value>v</arg_value>` or
// `<tool_call>Name\n<arg_key>…`. Qwen / Hermes: `<tool_call>\n{"name": "Name",
// "arguments": {…}}\n</tool_call>`.
function extractToolName(body: string): string | null {
  const glm = /^\s*([A-Za-z_][\w.-]*)\s*(?:<arg_key>|$)/.exec(body)
  if (glm) {
    return glm[1]!
  }
  const json = /"name"\s*:\s*"([^"]+)"/.exec(body)
  return json ? json[1]! : null
}

export type ToolCallLeakToolStatus = 'deferred' | 'loaded' | 'unknown'

/**
 * The reminder handed back to the model. Names the tool(s) and, for each,
 * says why the call could not land: a deferred tool has to be loaded first;
 * a loaded tool has to be called through the tool interface, not typed out;
 * an unknown name has no tool behind it at all.
 */
export function buildToolCallLeakReminder(
  leak: ToolCallLeak,
  statusOf: (name: string) => ToolCallLeakToolStatus,
): string {
  const lines = [
    '<system-reminder>',
    'Your last message contained a tool call written out as text (`<tool_call>…</tool_call>`). It was NOT executed — nothing was run, written, or saved — and that text was not shown to the user. Tool calls only take effect when issued through the tool-calling interface, never as message text.',
  ]
  for (const name of leak.names) {
    switch (statusOf(name)) {
      case 'deferred':
        lines.push(
          `- \`${name}\` is a deferred tool whose schema is not loaded. Call ToolSearch({query: "select:${name}"}) first, then call ${name} on the following turn.`,
        )
        break
      case 'loaded':
        lines.push(`- \`${name}\` is loaded and callable right now — call it through the tool interface.`)
        break
      default:
        lines.push(`- \`${name}\` is not a tool available in this session. Use ToolSearch to find the right one, or proceed without it.`)
    }
  }
  lines.push('Redo the call properly now, then continue with what you were doing.')
  lines.push('</system-reminder>')
  return lines.join('\n')
}
