import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

function readSafeTextFile(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null
  }

  try {
    const stats = lstatSync(filePath)
    if (!stats.isFile()) {
      return null
    }

    const content = readFileSync(filePath, 'utf8').trim()
    return content.length > 0 ? content : null
  } catch {
    return null
  }
}

export function findGitRoot(startDir: string): string | null {
  let currentDir = path.resolve(startDir)
  const rootDir = path.parse(currentDir).root

  while (true) {
    const gitPath = path.join(currentDir, '.git')
    if (existsSync(gitPath)) {
      try {
        const stats = lstatSync(gitPath)
        if (stats.isDirectory() || stats.isFile()) {
          return currentDir
        }
      } catch {
        return currentDir
      }
    }

    if (currentDir === rootDir) {
      return null
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      return null
    }
    currentDir = parentDir
  }
}

export function findProjectMemoryFiles(cwd: string): string[] {
  const resolvedCwd = path.resolve(cwd)
  const gitRoot = findGitRoot(resolvedCwd)
  const stopDir = gitRoot ?? path.parse(resolvedCwd).root
  const directories: string[] = []

  let currentDir = resolvedCwd
  while (true) {
    directories.push(currentDir)
    if (currentDir === stopDir) {
      break
    }

    const parentDir = path.dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }

  return directories
    .reverse()
    .map(directory => path.join(directory, 'LIGHTCLAW.md'))
    .filter(filePath => readSafeTextFile(filePath) !== null)
}

export async function loadProjectMemory(cwd: string): Promise<string> {
  const sections: string[] = []
  const userMemoryPath = path.join(homedir(), '.lightclaw', 'LIGHTCLAW.md')
  const userMemory = readSafeTextFile(userMemoryPath)
  if (userMemory) {
    sections.push(`Source: ${userMemoryPath}\n${userMemory}`)
  }

  for (const filePath of findProjectMemoryFiles(cwd)) {
    const content = readSafeTextFile(filePath)
    if (content) {
      sections.push(`Source: ${filePath}\n${content}`)
    }
  }

  const localMemoryPath = path.join(path.resolve(cwd), 'LIGHTCLAW.local.md')
  const localMemory = readSafeTextFile(localMemoryPath)
  if (localMemory) {
    sections.push(`Source: ${localMemoryPath}\n${localMemory}`)
  }

  return sections.join('\n\n---\n\n')
}