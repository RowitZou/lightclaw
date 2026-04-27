import path from 'node:path'

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
  riskLevel: 'execute',
  inputSchema: z.object({
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
  }),
  async call(input, context) {
    const boundary = violatesWorkspaceBoundary(input.command, context.cwd)
    if (!boundary.ok) {
      return {
        output: `Permission denied: ${boundary.reason}`,
        isError: true,
      }
    }
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

function violatesWorkspaceBoundary(
  command: string,
  cwd: string,
): { ok: true } | { ok: false; reason: string } {
  const normalized = command.replace(/\\/g, '/')
  // Tilde rule must catch ~user (e.g. `ls ~root/`) and bare `~` followed by
  // whitespace, not just `~/...`. Bash performs tilde expansion at the start
  // of any word, so any `~` after a separator should be denied.
  if (/\$HOME|\$\{HOME\}|(^|[\s"'`=])~([\w/]|\s|$)/.test(normalized)) {
    return { ok: false, reason: 'Bash command references $HOME/~ outside the workspace.' }
  }

  if (/(^|[\s/'"`=])\.\.(\/|$|[\s'"`;|&])/.test(normalized)) {
    return { ok: false, reason: 'Bash command uses .., which can escape the workspace.' }
  }

  if (/\b(cd|pushd)\s*($|[;&|])/.test(normalized)) {
    return { ok: false, reason: 'Bash command changes directory without an explicit workspace path.' }
  }

  const root = path.resolve(cwd)
  // The leading character class must include redirection / pipe / subshell /
  // separator characters so paths like `cat </etc/x`, `>/etc/x`, `cmd|/etc/x`,
  // `(/etc/x)`, `cmd;/etc/x`, `cmd&/etc/x` are all flagged. Without `<` and
  // `>` here, IO redirection bypasses the boundary entirely.
  const absolutePathPattern = /(?:^|[\s"'`=<>|;&(])(\/[^\s"'`;&|)<>]*)/g
  for (const match of normalized.matchAll(absolutePathPattern)) {
    const token = match[1]
    if (!token || !token.startsWith('/')) {
      continue
    }
    const resolved = path.resolve(token)
    if (!isWithin(resolved, root)) {
      return {
        ok: false,
        reason: `Bash command references absolute path outside the workspace: ${token}`,
      }
    }
  }

  return { ok: true }
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
