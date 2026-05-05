import { stat } from 'node:fs/promises'
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
  description:
    'Send a file from the current workspace to the active channel conversation. Only works in supported channel sessions such as Feishu.',
  domain: 'host',
  riskLevel: 'write',
  inputSchema,
  async call(input, context) {
    const sender = getChannelFileSender()
    if (!sender) {
      return {
        output: 'SendFile is only available while handling a supported channel message.',
        isError: true,
      }
    }

    const targetPath = resolveWorkspaceFilePath(
      context.cwd,
      context.runtime.workspaceRoot,
      input.file_path,
    )
    if (!isWithinWorkspace(context.cwd, targetPath)) {
      return {
        output: `SendFile refused to send a file outside the workspace: ${input.file_path}`,
        isError: true,
      }
    }

    try {
      const info = await stat(targetPath)
      if (!info.isFile()) {
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

      const displayName = input.name?.trim() || path.basename(targetPath)
      await sender.sendFile({ path: targetPath, name: displayName })
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

function resolveWorkspaceFilePath(
  hostWorkspaceRoot: string,
  runtimeWorkspaceRoot: string,
  inputPath: string,
): string {
  if (!path.isAbsolute(inputPath)) {
    return path.resolve(hostWorkspaceRoot, inputPath)
  }

  const absoluteInput = path.resolve(inputPath)
  const absoluteRuntimeRoot = path.resolve(runtimeWorkspaceRoot)
  if (
    absoluteInput === absoluteRuntimeRoot ||
    absoluteInput.startsWith(`${absoluteRuntimeRoot}${path.sep}`)
  ) {
    const relative = path.relative(absoluteRuntimeRoot, absoluteInput)
    return path.resolve(hostWorkspaceRoot, relative)
  }

  return absoluteInput
}

function isWithinWorkspace(hostWorkspaceRoot: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(hostWorkspaceRoot), path.resolve(targetPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
