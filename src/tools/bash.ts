import { z } from 'zod'

import { buildTool } from '../tool.js'

const MAX_OUTPUT_CHARS = 30000
const MAX_TIMEOUT_SECONDS = 300

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output
  }

  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[output truncated; narrow the command with head, tail, grep, or more specific paths]`
}

function formatCommandOutput(stdout: string, stderr: string): string {
  const parts: string[] = []
  if (stdout.trim().length > 0) {
    parts.push(`stdout:\n${stdout.trimEnd()}`)
  }
  if (stderr.trim().length > 0) {
    parts.push(`stderr:\n${stderr.trimEnd()}`)
  }

  return truncateOutput(parts.join('\n\n') || '[command completed with no output]')
}

export const bashTool = buildTool({
  name: 'Bash',
  description: 'Execute a shell command in the current working directory.',
  domain: 'environment',
  riskLevel: 'execute',
  inputSchema: z.object({
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
  }),
  async call(input, context) {
    const timeoutMs = Math.min(input.timeout ?? 30, MAX_TIMEOUT_SECONDS) * 1000

    const result = await context.runtime.exec({
      command: input.command,
      cwd: context.cwd,
      timeoutMs,
      maxBufferBytes: 1024 * 1024,
      abortSignal: context.abortSignal,
    })

    if (result.exitCode === 0) {
      return {
        output: formatCommandOutput(result.stdout, result.stderr),
      }
    }

    const detail = formatCommandOutput(result.stdout, result.stderr)
    return {
      output: `${detail}\n\nexit_code: ${result.exitCode}`,
      isError: true,
    }
  },
})
