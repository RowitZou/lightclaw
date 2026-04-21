import { bashTool } from './tools/bash.js'
import { fileEditTool } from './tools/file-edit.js'
import { fileReadTool } from './tools/file-read.js'
import { fileWriteTool } from './tools/file-write.js'
import { globTool } from './tools/glob.js'
import { grepTool } from './tools/grep.js'
import { memoryReadTool } from './tools/memory-read.js'
import { memoryWriteTool } from './tools/memory-write.js'
import { useSkillTool } from './tools/use-skill.js'

export const allTools = [
  bashTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
  memoryReadTool,
  memoryWriteTool,
  useSkillTool,
]