import path from 'node:path'

import { z } from 'zod'

import { buildTool } from '../tool.js'
import type { Runtime } from '../runtime/index.js'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function resolveSearchDir(cwd: string, inputPath?: string): string {
  if (!inputPath) return cwd
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath)
}

async function runRg(
  args: string[],
  cwd: string,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const command = ['rg', ...args.map(shellQuote)].join(' ')
  const result = await runtime.exec({
    command,
    cwd,
    abortSignal: signal,
    maxBufferBytes: 1024 * 1024,
  })
  return {
    stdout: result.stdout.trimEnd(),
    stderr: result.stderr,
    exitCode: result.exitCode,
  }
}

function isCommandNotFound(result: { stderr: string; exitCode: number }): boolean {
  return result.exitCode === 127 && result.stderr.includes('command not found')
}

function formatResult(
  matches: string[],
  limit: number,
  pattern: string,
  searchDir: string,
): string {
  if (matches.length === 0) {
    return `No files matched "${pattern}" under ${searchDir}.`
  }
  const truncated = matches.length > limit
  const shown = truncated ? matches.slice(0, limit) : matches
  const body = shown.join('\n')
  const trailer = truncated
    ? `\n\n[showing first ${limit} of ${matches.length} matches; narrow the pattern or path]`
    : ''
  return `${body}${trailer}`
}

export const globTool = buildTool({
  name: 'Glob',
  alwaysLoad: true,
  description: `- Fast file pattern matching tool that works with any codebase size.
- Supports glob patterns like "**/*.js" or "src/**/test-*.py".
- Returns matching file paths sorted by modification time (oldest first; most recently changed files appear at the end of the list — handy for "what just changed?").
- Use this tool when you need to find files by name pattern. For content search use Grep; for open-ended exploration ("anything about authentication?") dispatch an AgentTool subagent instead.
- NEVER run \`find\` or \`ls\` via Bash for this — Glob is permission-scoped, sandbox-aware, and handles globstar consistently across LocalRuntime / DockerRuntime / RlaunchRuntime.`,
  domain: 'environment',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe('Glob pattern, e.g. "**/*.ts" or "src/**/test-*.py".'),
    path: z
      .string()
      .optional()
      .describe(
        'Directory to search in. Defaults to the workspace root. Omit this field (do NOT pass "undefined" or "null") to use the default. Relative paths resolve against the workspace root.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Max paths to return. Defaults to ${DEFAULT_LIMIT}; results beyond this are truncated with a hint to narrow the pattern.`,
      ),
  }),
  async call(input, context) {
    const searchDir = resolveSearchDir(context.runtime.workspaceRoot, input.path)
    const limit = input.limit ?? DEFAULT_LIMIT

    try {
      // Primary path: ripgrep `--files --glob <pattern> --sort=modified`.
      // Same architecture as Grep — runs as a runtime.exec command so the
      // search executes on whichever backend owns the workspace (Local on
      // host, Docker inside container, Rlaunch on cluster worker). rg is
      // installed in the sandbox image and on every dogfood host.
      // --sort=modified gives oldest-first ordering (ripgrep semantics);
      // mtime-sorted output is what makes Glob useful for "what changed"
      // queries and is the contract the description promises.
      // Positional `.` + cwd=searchDir lets rg emit relative paths under
      // searchDir directly (matches Claude Code's Glob output shape).
      const rgArgs = [
        '--files',
        '--glob', input.pattern,
        '--sort=modified',
        '--no-ignore',
        '--hidden',
        '.',
      ]
      const result = await runRg(rgArgs, searchDir, context.runtime, context.abortSignal)

      // `rg --files` exits 0 even when nothing matches. exit 1 is reserved
      // for the content-search "no matches" case, which doesn't apply
      // here; treat both as "no error" so an empty match returns the
      // friendly no-match message instead of an isError result.
      if (result.exitCode === 0 || result.exitCode === 1) {
        const matches = result.stdout
          .split('\n')
          .map(line => (line.startsWith('./') ? line.slice(2) : line))
          .filter(Boolean)
        return { output: formatResult(matches, limit, input.pattern, searchDir) }
      }

      if (isCommandNotFound(result)) {
        // Phase 35: no daemon-side fast-glob fallback (DataPlane.glob and
        // the sandbox glob.py helper were retired alongside this tool's
        // primary rg path). Return a self-healing message so the model
        // falls back to `Bash` (find / ls -R) on the same workspace.
        return {
          output:
            `rg not found in this runtime; Glob cannot operate. ` +
            `Use \`Bash\` with \`find\` or \`ls -R\` under ${searchDir} instead.`,
          isError: true,
        }
      }

      return {
        output: result.stderr.trim() || `rg --files exited with code ${result.exitCode}`,
        isError: true,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
