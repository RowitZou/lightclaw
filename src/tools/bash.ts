import { z } from 'zod'

import { suggestBashRules } from '../permission/suggestions.js'
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
  whenToUse: `Shell command in the sandbox (git, package managers, build / test, system diagnostics, scripts not covered by a dedicated tool).`,
  alwaysLoad: true,
  description: `Execute a shell command in the sandbox runtime. The working directory persists between calls; shell state (env vars, functions, aliases) does not.

Quoting & paths: always quote paths with spaces (\`cd "path with spaces"\`); prefer absolute paths over \`cd\` unless the user asked to switch directories.

Shell-specific chaining: dependent commands chain with \`&&\` in a single call. Use \`;\` only when you don't care if earlier commands fail. Never split commands with newlines (newlines are fine inside quoted strings).

Git rules:
- Prefer new commits over \`--amend\`; never amend a commit you've already pushed.
- Stage by named file, not \`git add -A\` / \`git add .\` — risk of including secrets, build artifacts, or unrelated work.

Long-running work: schedule via Dispatch background mode, not via Bash + \`sleep\`. Do not use \`sleep\` to poll a condition — diagnose the root cause or restructure.`,
  domain: 'environment',
  riskLevel: 'execute',
  inputSchema: z.object({
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
  }),
  suggestPermissionRules(input) {
    return suggestBashRules(input.command)
  },
  async call(input, context) {
    const timeoutMs = Math.min(input.timeout ?? 30, MAX_TIMEOUT_SECONDS) * 1000

    const result = await context.runtime.exec({
      command: input.command,
      cwd: context.runtime.workspaceRoot,
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

    if (result.exitCode === 127) {
      // exit 127 = "command not found". Give a concrete next-step recipe so
      // the model doesn't retry the same shell-not-found path.
      const cmdGuess = input.command.trim().split(/\s+/)[0] ?? '<command>'
      const hint =
        `\n\n[Hint: exit 127 = command not found. If '${cmdGuess}' is missing:\n` +
        `  - apt-get install <pkg> (sudo + permission required)\n` +
        `  - pip install <pkg> (Python tools)\n` +
        `  - pnpm add -g <pkg> (Node tools)\n` +
        `Check availability via \`which <name>\` or \`ls /usr/bin /usr/local/bin\` before retrying.]`
      return {
        output: `${detail}\n\nexit_code: ${result.exitCode}${hint}`,
        isError: true,
      }
    }

    return {
      output: `${detail}\n\nexit_code: ${result.exitCode}`,
      isError: true,
    }
  },
})
