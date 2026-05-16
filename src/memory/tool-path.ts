import path from 'node:path'

export class MemoryToolPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryToolPathError'
  }
}

export class MemoryToolNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryToolNotFoundError'
  }
}

export class MemoryToolConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryToolConflictError'
  }
}

export function joinAndAssertWithinMemoryDir(
  memoryDir: string,
  relativePath: string,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new MemoryToolPathError('path resolves outside memoryDir')
  }

  const root = path.resolve(memoryDir)
  const target = path.resolve(root, relativePath)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new MemoryToolPathError('path resolves outside memoryDir')
  }

  return target
}
