import type { BackgroundJobSnapshot } from './types.js'

export type BackgroundExecOutputTail = {
  stdoutTail?: string
  stderrTail?: string
}

export function formatBackgroundExecResultBlock(
  snapshot: BackgroundJobSnapshot,
  outputTail: BackgroundExecOutputTail = {},
): string {
  const attrs = [
    `job_id="${escapeAttr(snapshot.jobId)}"`,
    `status="${snapshot.status}"`,
  ]
  if (snapshot.exitCode !== undefined) {
    attrs.push(`exit_code="${snapshot.exitCode}"`)
  }

  const tailParts: string[] = []
  if (outputTail.stdoutTail?.trim()) {
    tailParts.push(`stdout:\n${outputTail.stdoutTail.trimEnd()}`)
  }
  if (outputTail.stderrTail?.trim()) {
    tailParts.push(`stderr:\n${outputTail.stderrTail.trimEnd()}`)
  }

  return `<background-exec-result ${attrs.join(' ')}>
A background command you started has finished.
Command: ${snapshot.command}
Output file: ${snapshot.outFile}
${snapshot.errFile !== snapshot.outFile ? `Error file: ${snapshot.errFile}\n` : ''}--- last output ---
${tailParts.join('\n\n') || '[no output captured]'}
</background-exec-result>

\`Read\` the output file for the full logs if you need more than the tail above.
Report the outcome to the user if they are waiting on it, or use it to continue
the next step. If the command failed — non-zero exit, killed, or interrupted —
diagnose it or tell the user.`
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}
