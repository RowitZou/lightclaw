export function stripUtf8Bom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
}

export function truncate(input: string, maxChars: number): { value: string; truncated: boolean } {
  if (input.length <= maxChars) {
    return { value: input, truncated: false }
  }
  return { value: input.slice(0, maxChars), truncated: true }
}

