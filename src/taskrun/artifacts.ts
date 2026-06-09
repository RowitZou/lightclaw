export type TaskRunArtifactDeclaration = {
  path?: string
  token?: string
  kind?: string
  label?: string
}

const ARTIFACT_LINE_HINT =
  /\b(artifact|output|result|file|path|saved|wrote|created|uploaded|token)\b|产出|文件|路径|上传|保存/i

const ABSOLUTE_PATH_RE = /\/[A-Za-z0-9._~@%+=:,/-]+/g
const RELATIVE_PATH_RE = /(?:^|[\s("'`])((?:\.{1,2}\/)?[A-Za-z0-9._~@%+=:-]+(?:\/[A-Za-z0-9._~@%+=:-]+)+)/g
const FEISHU_TOKEN_RE = /\b(?:docx|doxcn|shtcn|fldcn|file|boxcn|wikcn|bitable)[A-Za-z0-9_-]{6,}\b/g

export function extractArtifactDeclarationsFromText(
  text: string,
  options: { limit?: number } = {},
): TaskRunArtifactDeclaration[] {
  const limit = options.limit ?? 5
  const out: TaskRunArtifactDeclaration[] = []
  const seen = new Set<string>()
  for (const rawLine of text.split('\n')) {
    if (out.length >= limit) break
    const line = rawLine.trim()
    if (!ARTIFACT_LINE_HINT.test(line)) continue
    for (const artifactPath of extractPaths(line)) {
      if (out.length >= limit) break
      if (seen.has(`path:${artifactPath}`)) continue
      seen.add(`path:${artifactPath}`)
      out.push({ path: artifactPath, kind: 'file' })
    }
    for (const token of line.match(FEISHU_TOKEN_RE) ?? []) {
      if (out.length >= limit) break
      if (seen.has(`token:${token}`)) continue
      seen.add(`token:${token}`)
      out.push({ token, kind: 'feishu' })
    }
  }
  return out
}

function extractPaths(line: string): string[] {
  const paths: string[] = []
  for (const match of line.match(ABSOLUTE_PATH_RE) ?? []) {
    paths.push(stripTrailingPunctuation(match))
  }
  for (const match of line.matchAll(RELATIVE_PATH_RE)) {
    const value = match[1]
    if (!value) continue
    if (!looksLikeFileHandle(value)) continue
    paths.push(stripTrailingPunctuation(value))
  }
  return paths
}

function looksLikeFileHandle(value: string): boolean {
  return value.includes('/.') || /\.[A-Za-z0-9]{1,12}(?:$|[?#])/.test(value)
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;\]"'`]+$/g, '')
}
