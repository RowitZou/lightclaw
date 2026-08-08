import { z } from 'zod'

import { launchBackgroundJob } from '../background-exec/launcher.js'
import { suggestBashRules } from '../permission/suggestions.js'
import { getCurrentSessionContext } from '../session-context.js'
import {
  getCurrentEnabledSecrets,
  getCurrentRole,
  getCurrentUserId,
  getSessionId,
} from '../state.js'
import { buildTool } from '../tool.js'
import {
  buildCwdProbePath,
  collectCwdProbe,
  resolveTrackedCwd,
  updateTrackedCwd,
  wrapCommandWithCwdProbe,
} from './bash-cwd.js'

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

Long-running work: set \`run_in_background: true\` for a command that may run past the foreground time limit (large clones, long builds or test suites). It detaches, returns an output file path, and does not block the turn — you are notified when it finishes, so you do not need to poll. \`Read\` the output path to check progress before then, and stop a job you no longer need with \`KillBash\`. Do not use \`sleep\` to poll a condition.`,
  domain: 'environment',
  riskLevel: 'execute',
  inputSchema: z.object({
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional(),
    run_in_background: z.boolean().optional().describe(
      'Set to true to run this command in the background instead of waiting for it. The turn is not blocked; stdout/stderr stream to a file whose path is returned — use `Read` on that path to check progress. You are notified when the command finishes, so you don\'t need to poll. Stop a job you no longer need with `KillBash`. Do not append `&` to the command.',
    ),
  }),
  suggestPermissionRules(input) {
    return suggestBashRules(input.command)
  },
  async call(input, context) {
    const enabledSecrets = getCurrentEnabledSecrets()
    const env = enabledSecrets.size > 0
      ? Object.fromEntries(enabledSecrets)
      : undefined

    // Cwd persistence (see bash-cwd.ts): outside a session scope the tool
    // degrades to the historical stateless behavior.
    const sessionId = getCurrentSessionContext()?.sessionId
    const workspaceRoot = context.runtime.workspaceRoot
    const trackedCwd = sessionId
      ? await resolveTrackedCwd(sessionId, workspaceRoot)
      : workspaceRoot

    if (input.run_in_background) {
      const meta = await launchBackgroundJob({
        runtime: context.runtime,
        command: input.command,
        // Background jobs launch from the tracked cwd but never update it —
        // they finish asynchronously, so a writeback would race later calls.
        cwd: trackedCwd,
        canonicalUser: getCurrentUserId() ?? 'terminal',
        sessionId: getSessionId(),
        roleId: getCurrentRole()?.agentType,
        env,
      })
      return {
        output:
          `Started background Bash job ${meta.jobId}.\n` +
          `stdout: ${meta.outFile}\n` +
          `stderr: ${meta.errFile}\n\n` +
          `Use Read on the output files to check progress. Stop it with KillBash if it is no longer needed.`,
      }
    }

    const timeoutMs = Math.min(input.timeout ?? 30, MAX_TIMEOUT_SECONDS) * 1000

    const probeFile = sessionId
      ? buildCwdProbePath(workspaceRoot, getCurrentUserId())
      : null
    const command = probeFile
      ? wrapCommandWithCwdProbe({
          command: input.command,
          cwd: trackedCwd,
          workspaceRoot,
          probeFile,
        })
      : input.command

    const result = await context.runtime.exec({
      command,
      cwd: workspaceRoot,
      timeoutMs,
      maxBufferBytes: 1024 * 1024,
      abortSignal: context.abortSignal,
      env,
    })

    if (sessionId && probeFile) {
      const newCwd = await collectCwdProbe(context.runtime, probeFile)
      if (newCwd && newCwd !== trackedCwd) {
        await updateTrackedCwd(sessionId, newCwd)
      }
    }

    if (result.exitCode === 0) {
      return {
        output: `${formatCommandOutput(result.stdout, result.stderr)}\n\nexit_code: 0`,
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

    const timeoutHint =
      result.stderr.includes('command timed out after') ||
      result.stderr.includes('sandbox time limit')
        ? `\n\n[Hint: this command hit the foreground time limit. For work that genuinely needs longer — large clones, long builds — re-run it with run_in_background: true.]`
        : ''

    return {
      output: `${detail}\n\nexit_code: ${result.exitCode}${timeoutHint}`,
      isError: true,
    }
  },
})
