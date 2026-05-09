import type { ArtifactRecord } from '../registry.js'

export function mediaReadableWith(record: ArtifactRecord): string[] {
  const mime = record.mimeType?.toLowerCase() ?? ''
  const title = record.title.toLowerCase()
  const path = record.workspacePath?.toLowerCase() ?? ''
  if (mime.startsWith('image/')) {
    return ['InspectImage']
  }
  if (mime === 'application/pdf' || title.endsWith('.pdf') || path.endsWith('.pdf')) {
    return ['RenderPdfPages']
  }
  // Audio / video: no reader tool wired in PR2. Channel-prompt should signal
  // to the LLM that these artifacts are present but cannot be read; returning
  // an empty array makes the model respond with a natural "can't process this
  // format" reply instead of hallucinating a tool call. TranscribeAudio /
  // InspectVideo will land in a follow-up PR once provider audio/video paths
  // are wired.
  return []
}
