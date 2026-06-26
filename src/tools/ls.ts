import path from 'node:path'

import { z } from 'zod'

import { buildTool } from '../tool.js'
import type { Runtime } from '../runtime/index.js'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function resolveTargetDir(cwd: string, inputPath?: string): string {
  if (!inputPath) return cwd
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath)
}

async function runLs(
  targetDir: string,
  workspaceRoot: string,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // `ls -1Ap`: one entry per line, include dotfiles (but not . / ..), and
  // append `/` to directory names so dirs are distinguishable from files.
  // `--` guards against a dir name beginning with `-`. cwd is the workspace
  // root and the absolute target is passed as an argument so a bad path gives
  // a clean `ls: cannot access` stderr rather than a cwd-spawn failure.
  const command = `ls -1Ap -- ${shellQuote(targetDir)}`
  const result = await runtime.exec({
    command,
    cwd: workspaceRoot,
    abortSignal: signal,
    maxBufferBytes: 1024 * 1024,
  })
  return {
    stdout: result.stdout.trimEnd(),
    stderr: result.stderr,
    exitCode: result.exitCode,
  }
}

function formatResult(entries: string[], limit: number, targetDir: string): string {
  if (entries.length === 0) {
    return `${targetDir} is empty.`
  }
  // Group directories (trailing `/` from `ls -p`) before files so "what
  // subdirectories are here?" is answerable at a glance; alphabetical order
  // within each group is preserved from `ls`.
  const dirs = entries.filter(e => e.endsWith('/'))
  const files = entries.filter(e => !e.endsWith('/'))
  const ordered = [...dirs, ...files]

  const truncated = ordered.length > limit
  const shown = truncated ? ordered.slice(0, limit) : ordered
  const trailer = truncated
    ? `\n\n[showing first ${limit} of ${ordered.length} entries (${dirs.length} dirs, ${files.length} files); use Glob with a pattern to narrow]`
    : ''
  return `${shown.join('\n')}${trailer}`
}

export const lsTool = buildTool({
  name: 'LS',
  whenToUse: `List a directory's immediate entries (subdirectories + files, one level).`,
  alwaysLoad: true,
  description: `- Lists the immediate contents of a directory — one level, non-recursive: the subdirectories and files directly inside it.
- Directories are marked with a trailing slash (e.g. \`src/\`) and listed before files; hidden entries are included.
- For a recursive file search by name pattern use Glob; for content search use Grep.`,
  domain: 'environment',
  riskLevel: 'safe',
  concurrencySafe: true,
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe(
        'Directory to list. Defaults to the workspace root. Omit this field (do NOT pass "undefined" or "null") to use the default. Relative paths resolve against the workspace root.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Max entries to return. Defaults to ${DEFAULT_LIMIT}; results beyond this are truncated with a hint to narrow with Glob.`,
      ),
  }),
  async call(input, context) {
    const targetDir = resolveTargetDir(context.runtime.workspaceRoot, input.path)
    const limit = input.limit ?? DEFAULT_LIMIT

    try {
      const result = await runLs(
        targetDir,
        context.runtime.workspaceRoot,
        context.runtime,
        context.abortSignal,
      )

      if (result.exitCode === 0) {
        const entries = result.stdout.split('\n').filter(Boolean)
        return { output: formatResult(entries, limit, targetDir) }
      }

      // Non-zero exit: missing dir, permission denied, or a path that is a
      // file rather than a directory. Surface the ls stderr verbatim.
      return {
        output: result.stderr.trim() || `ls exited with code ${result.exitCode}`,
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
