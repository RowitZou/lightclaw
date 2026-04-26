import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

import { z } from 'zod'

import { buildTool } from '../tool.js'

const execFileAsync = promisify(execFile)
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
  riskLevel: 'execute',
  inputSchema: z.object({
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
  }),
  async call(input, context) {
    if (touchesLightClawState(input.command)) {
      return {
        output: 'Permission denied: Bash command references ~/.lightclaw state.',
        isError: true,
      }
    }
    const timeoutMs = Math.min(input.timeout ?? 30, MAX_TIMEOUT_SECONDS) * 1000

    try {
      const result = await execFileAsync('/bin/bash', ['-c', input.command], {
        cwd: context.cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        signal: context.abortSignal,
      })

      return {
        output: formatCommandOutput(result.stdout, result.stderr),
      }
    } catch (error) {
      const execError = error as {
        stdout?: string
        stderr?: string
        message?: string
        code?: string | number
      }
      const detail = formatCommandOutput(
        execError.stdout ?? '',
        execError.stderr ?? execError.message ?? '',
      )
      const suffix = execError.code !== undefined ? `\n\nexit_code: ${execError.code}` : ''
      return {
        output: `${detail}${suffix}`,
        isError: true,
      }
    }
  },
})

function touchesLightClawState(command: string): boolean {
  const homeState = `${homedir().replace(/\\/g, '/')}/.lightclaw`
  const normalized = command.replace(/\\/g, '/')
  return normalized.includes('~/.lightclaw') ||
    normalized.includes('$HOME/.lightclaw') ||
    normalized.includes('${HOME}/.lightclaw') ||
    normalized.includes(homeState)
}
