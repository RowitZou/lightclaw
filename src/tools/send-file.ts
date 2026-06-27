import path from 'node:path'
import { Readable } from 'node:stream'

import { z } from 'zod'

import { getChannelFileSender } from '../state.js'
import { buildTool } from '../tool.js'

const inputSchema = z.object({
  file_path: z.string().min(1),
  name: z.string().min(1).optional(),
})

export const sendFileTool = buildTool({
  name: 'SendFile',
  whenToUse: `Deliver a workspace file to the user via the channel (generated report, converted document, screenshot).`,
  shouldDefer: true,
  description: `Send a file from this workspace to the active channel conversation. Currently only Feishu channel.

Delivery mode is picked automatically by file size:
- Up to 30 MB rides the native IM file attachment (renders inline in the chat).
- Larger files (typical arxiv PDFs, datasets, archives) are uploaded to the user's cloud workspace and a clickable share link is posted back to the same chat. SendFile returns the URL — repeat it in your reply text so the user can click through. Single-file cap is ~800 MB.

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
      // translation throws on out-of-sandbox paths. Size routing (IM vs
      // cloud) belongs to the channel adapter — the tool only filters
      // out non-regular and empty inputs.
      const info = await context.runtime.fs.stat(input.file_path)
      if (!info.isFile) {
        return { output: `SendFile expected a regular file: ${input.file_path}`, isError: true }
      }
      if (info.size <= 0) {
        return { output: `SendFile refused to send an empty file: ${input.file_path}`, isError: true }
      }

      const displayName = input.name?.trim() || path.basename(input.file_path)
      const result = await sender.sendFile({
        name: displayName,
        sizeBytes: info.size,
        read: () => context.runtime.fs.readFile(input.file_path),
        ...(context.runtime.fs.createReadStream
          ? {
              createReadStream: async () => {
                try {
                  return await context.runtime.fs.createReadStream!(input.file_path)
                } catch {
                  // Exec-relay has no stream accessor. Preserve the existing
                  // whole-read behavior as a transparent fallback.
                  return Readable.from(await context.runtime.fs.readFile(input.file_path))
                }
              },
            }
          : {}),
      })
      if (result.kind === 'cloud-link') {
        const sizeMB = (result.sizeBytes / (1024 * 1024)).toFixed(1)
        return {
          output: `Uploaded ${displayName} (${sizeMB} MB) to the user's cloud workspace and posted the share link to ${sender.channelId}. URL: ${result.url}`,
        }
      }
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
