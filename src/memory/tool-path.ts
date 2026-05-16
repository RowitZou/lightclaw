import path from 'node:path'

const MEMORY_INDEX_FILE = 'MEMORY.md'

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

/**
 * Reject any operation that targets a `MEMORY.md` index file. Index files are
 * framework-owned — every memory tool (write / move / delete) rebuilds them
 * from the surrounding directory contents after the operation completes, so an
 * agent-authored write would be silently overwritten and a delete would be
 * recreated on the next operation. Both are confusing failure modes; refuse at
 * the tool boundary instead.
 */
export function assertNotMemoryIndex(absolutePath: string): void {
  if (path.basename(absolutePath) === MEMORY_INDEX_FILE) {
    throw new MemoryToolPathError(
      'MEMORY.md is framework-managed; tools cannot write, move, or delete it directly',
    )
  }
}
