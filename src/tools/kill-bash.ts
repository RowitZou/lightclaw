import { z } from 'zod'

import { killBackgroundJob } from '../background-exec/kill.js'
import { getBackgroundJobRegistry } from '../background-exec/registry.js'
import { getSessionId } from '../state.js'
import { buildTool } from '../tool.js'

export const killBashTool = buildTool({
  name: 'KillBash',
  whenToUse: 'Stop a background Bash command (started with run_in_background) before it finishes.',
  shouldDefer: true,
  description: `- Stops a background command started with Bash's run_in_background, by its job id.
- Takes a job_id parameter identifying the job to stop.
- Returns the job's final status.
- Use this when a long-running background command is no longer needed, or is
  misbehaving and should be terminated early.`,
  domain: 'environment',
  riskLevel: 'execute',
  inputSchema: z.object({
    job_id: z.string().min(1),
  }),
  async call(input) {
    const registry = getBackgroundJobRegistry()
    const entry = registry.get(input.job_id)
    if (!entry) {
      return {
        output: `Unknown background Bash job: ${input.job_id}`,
        isError: true,
      }
    }

    const sessionId = getSessionId()
    if (entry.meta.sessionId !== sessionId) {
      return {
        output: `Background Bash job ${input.job_id} belongs to another session.`,
        isError: true,
      }
    }

    const snapshot = await killBackgroundJob(entry)
    registry.markTerminal(entry.meta.jobId, snapshot)
    return {
      output:
        `Background Bash job ${snapshot.jobId} status: ${snapshot.status}` +
        (snapshot.exitCode !== undefined ? `\nexit_code: ${snapshot.exitCode}` : '') +
        `\nstdout: ${snapshot.outFile}\nstderr: ${snapshot.errFile}`,
      isError: snapshot.status === 'lost',
    }
  },
})
