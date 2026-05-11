import path from 'node:path'

import { z } from 'zod'

import { getChannelFileSender } from '../state.js'
import { buildTool } from '../tool.js'

const MAX_CHANNEL_FILE_BYTES = 30 * 1024 * 1024

const inputSchema = z.object({
  file_path: z.string().min(1),
  name: z.string().min(1).optional(),
})

export const sendFileTool = buildTool({
  name: 'SendFile',
  shouldDefer: true,
  description: `Send a file from this workspace to the active channel conversation. Currently only Feishu channel.

Use when:
- The user explicitly asked for a file (a report, a generated artifact, a converted document, a screenshot they cannot see otherwise).
- You generated a file the user needs as a follow-up step.

Don't use:
- To show file contents the user can already read in your reply — paste the text.
- For intermediate scratch files. The user should ask for the final artifact.
- For media you received from this user (already in their chat history).
- In a terminal session (no channel — call will error).`,
  domain: 'host',
  riskLevel: 'write',
  // Phase 29 channel-aware catalog: SendFile depends on the runner-installed
  // `ChannelFileSender`, which only the Feishu channel populates. Without
  // narrowing the scope the terminal REPL would still see SendFile in its
  // tool catalog and the model would happily call it, producing the
  // self-defense error "SendFile is only available while handling a
  // supported channel message." That is wasted prompt tokens + a useless
  // tool_result round-trip. Future channel adapters that wire `sendFile`
  // into their `ChannelRunnerStrategy` should either inherit this scope
  // (`['feishu', '<new-channel>']`) or open a sibling tool.
  channelScope: ['feishu'],
  inputSchema,
  async call(input, context) {
    const sender = getChannelFileSender()
    if (!sender) {
      return {
        output: 'SendFile is only available while handling a supported channel message.',
        isError: true,
      }
    }

    try {
      // runtime.fs owns the workspace boundary: each backend's path
      // translation throws on out-of-sandbox paths. The 30 MB ceiling stays
      // here because it's a Feishu API constraint, not a runtime one.
      const info = await context.runtime.fs.stat(input.file_path)
      if (!info.isFile) {
        return { output: `SendFile expected a regular file: ${input.file_path}`, isError: true }
      }
      if (info.size <= 0) {
        return { output: `SendFile refused to send an empty file: ${input.file_path}`, isError: true }
      }
      if (info.size > MAX_CHANNEL_FILE_BYTES) {
        return {
          output: `SendFile refused to send a file larger than 30 MB: ${input.file_path}`,
          isError: true,
        }
      }

      const content = await context.runtime.fs.readFile(input.file_path)
      const displayName = input.name?.trim() || path.basename(input.file_path)
      await sender.sendFile({ content, name: displayName })
      return {
        output: `Sent ${displayName} to ${sender.channelId}.`,
      }
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  },
})
