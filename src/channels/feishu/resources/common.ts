export function readNestedString(input: unknown, pathSegments: string[]): string | undefined {
  let cursor: unknown = input
  for (const segment of pathSegments) {
    if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
      return undefined
    }
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return typeof cursor === 'string' ? cursor : undefined
}

export function truncate(input: string, maxChars: number): { value: string; truncated: boolean } {
  if (input.length <= maxChars) {
    return { value: input, truncated: false }
  }
  return { value: input.slice(0, maxChars), truncated: true }
}
