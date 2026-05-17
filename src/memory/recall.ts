import { streamChat } from '../api.js'
import type { Role } from '../agents/types.js'
import type { LightClawConfig } from '../config.js'
import { resolveToolModuleModel } from '../model-resolution.js'
import { loadMemoryIndex, scanMemoryFilesInDirs } from './auto-memory.js'
import { resolveReadableMemoryDirsForRole } from './scope.js'
import type { MemoryEntry } from './types.js'

export type RecallOptions = {
  topN: number
  signal?: AbortSignal
}

export function buildRecallPrompt(query: string, manifest: string, topN: number): string {
  return [
    '## User query',
    query,
    '',
    '## Memory manifest',
    manifest,
    '',
    '## Instructions',
    '- Pick the memory files most likely to inform the query.',
    '- Return only filenames that appear verbatim in the manifest.',
    '- Output ONE JSON object: {"filenames": ["a.md", "b.md"]}.',
    `- Return at most ${topN} filenames — fewer is fine if nothing fits.`,
    '- If nothing is relevant, return {"filenames": []}.',
  ].join('\n')
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1)
  }

  return text.trim()
}

export async function requestRecall(
  prompt: string,
  config: LightClawConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  let responseText = ''

  for await (const event of streamChat({
    config,
    model: resolveToolModuleModel('compact', config),
    messages: [{ role: 'user', content: prompt }],
    system:
      'You are a memory recall agent. Return only a JSON object {"filenames": [...]} listing the most relevant memory files for the query.',
    tools: [],
    maxTokens: 256,
    ...(signal ? { signal } : {}),
    apiLogContext: { kind: 'recall' },
  })) {
    if (event.type === 'text') {
      responseText += event.text
    }
  }

  if (!responseText.trim()) {
    return []
  }

  try {
    const parsed = JSON.parse(extractJsonObject(responseText)) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { filenames?: unknown }).filenames)) {
      const names = (parsed as { filenames: unknown[] }).filenames
      return names.filter((name): name is string => typeof name === 'string')
    }
  } catch {
    return []
  }

  return []
}

export async function selectRelevantMemories(
  query: string,
  memoryDir: string,
  config: LightClawConfig,
  options: RecallOptions,
  role?: Role,
): Promise<MemoryEntry[]> {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return []
  }

  // Recall is best-effort: any IO or LLM failure must degrade silently to "no
  // recalled memories" so the system prompt build (Promise.all in prompt.ts)
  // is not aborted by a transient permission error or model hiccup.
  try {
    if (role) {
      const resolved = await resolveReadableMemoryDirsForRole(role, memoryDir)
      if (resolved.readableDirs.length === 0) {
        return []
      }
    }

    const manifest = await loadMemoryIndex(memoryDir, role)
    if (manifest.trim().length === 0) {
      return []
    }

    const names = await requestRecall(
      buildRecallPrompt(trimmed, manifest, options.topN),
      config,
      options.signal,
    )

    if (names.length === 0) {
      return []
    }

    const entries = role
      ? await scanMemoryFilesInDirs(
          memoryDir,
          (await resolveReadableMemoryDirsForRole(role, memoryDir)).readableDirs,
        )
      : await scanMemoryFilesInDirs(memoryDir, [memoryDir])
    const byFilename = new Map(entries.map(entry => [entry.filename, entry]))
    const seen = new Set<string>()
    const result: MemoryEntry[] = []

    for (const name of names) {
      if (result.length >= options.topN) break
      if (seen.has(name)) continue
      const entry = byFilename.get(name)
      if (!entry) continue
      seen.add(name)
      result.push(entry)
    }

    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[memory] recall failed: ${msg}`)
    return []
  }
}
