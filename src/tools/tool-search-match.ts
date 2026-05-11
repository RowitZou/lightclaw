import type { Tool } from '../tool.js'

export function matchToolSearchQuery(
  query: string,
  pool: readonly Tool[],
  maxResults: number,
): { matches: string[] } {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return { matches: [] }
  }

  if (trimmed.toLowerCase().startsWith('select:')) {
    const selected = trimmed
      .slice('select:'.length)
      .split(',')
      .map(name => name.trim())
      .filter(Boolean)
    const selectedSet = new Set(selected)
    return {
      matches: pool
        .filter(tool => selectedSet.has(tool.name))
        .map(tool => tool.name),
    }
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  const required: string[] = []
  const optional: string[] = []
  for (const token of tokens) {
    if (token.startsWith('+')) {
      const stripped = token.slice(1).toLowerCase()
      if (stripped) required.push(stripped)
      continue
    }
    optional.push(token.toLowerCase())
  }

  const scored = pool
    .map((tool, index) => ({
      tool,
      index,
      score: scoreTool(tool, required, optional),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, maxResults))

  return { matches: scored.map(item => item.tool.name) }
}

function scoreTool(tool: Tool, required: readonly string[], optional: readonly string[]): number {
  const lowerName = tool.name.toLowerCase()
  const nameParts = splitNameParts(tool.name)
  const lowerDesc = tool.description.toLowerCase()
  const hintParts = splitHintParts(tool.searchHint)

  for (const token of required) {
    if (
      !lowerName.includes(token) &&
      !nameParts.some(part => part.includes(token)) &&
      !hintParts.includes(token)
    ) {
      return 0
    }
  }

  if (optional.length === 0) {
    return required.length > 0 ? required.length : 0
  }

  let total = 0
  for (const token of optional) {
    if (nameParts.includes(token)) total += 10
    else if (nameParts.some(part => part.startsWith(token))) total += 7
    else if (lowerName.includes(token)) total += 5
    else if (hintParts.includes(token)) total += 5
    else if (lowerDesc.includes(token)) total += 1
    else return 0
  }

  return total
}

export function splitNameParts(name: string): string[] {
  if (name.startsWith('mcp__')) {
    return name
      .replace(/^mcp__/, '')
      .split('__')
      .flatMap(part => part.split('_'))
      .map(part => part.toLowerCase())
      .filter(Boolean)
  }

  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/g)
    .map(part => part.toLowerCase())
    .filter(Boolean)
}

function splitHintParts(hint: string | undefined): string[] {
  if (!hint) return []
  return hint.toLowerCase().split(/\s+/g).filter(Boolean)
}
