import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

/**
 * Atomically write a file. Writes to `<path>.<pid>.<ts>.tmp` then `renameSync`s
 * to the target. POSIX guarantees the rename is atomic, so a crash mid-write
 * never leaves a half-written target — either the old bytes or the new bytes
 * are present, never a corrupt mix.
 *
 * Parent directory is created with `mkdirSync({recursive:true})` first.
 *
 * Calls `fsync` on the tmp file before the rename so the bytes are durable on
 * disk by the time the rename publishes them. On a sudden power loss the
 * filesystem still has the new bytes (or it has the old bytes — the metadata
 * for the rename itself isn't flushed by fsync on the file, only by fsync on
 * the directory, which is typically overkill for app state files). Without
 * this fsync, a power loss could publish a rename pointing at an inode whose
 * contents are still in the page cache only.
 *
 * On any failure the tmp file is best-effort unlinked so disk doesn't fill
 * with stranded `.tmp` files. Errors are rethrown so the caller can log them
 * with the right module context.
 *
 * Use this for daemon-shared / multi-user JSON state files where a partial
 * write would corrupt the file and force the silent-rebuild path
 * (capability-cache, batch-size-cache, memory MEMORY_INDEX).
 *
 * The mode parameter is intentional: per-user permission files set 0o600 to
 * keep secrets readable only by the daemon user; cache files leave it
 * default (0o644 = umask-modified) so admins can inspect them.
 */
export function safeWriteFile(
  filePath: string,
  content: string | Buffer,
  options?: { mode?: number },
): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    const writeOpts = options?.mode !== undefined ? { mode: options.mode } : undefined
    writeFileSync(tmp, content, writeOpts)
    // fsync the data so bytes are durable before the rename publishes them.
    const fd = openSync(tmp, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, filePath)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      // tmp may not exist (writeFileSync failed before creating it) or may
      // already be renamed — best-effort cleanup, don't mask the real error.
    }
    throw error
  }
}

/**
 * JSON variant of `safeWriteFile`. Pretty-prints with 2-space indent and a
 * trailing newline so the file reads cleanly and matches the prior hand-rolled
 * `writeFileSync(file, JSON.stringify(x, null, 2), 'utf8')` style.
 */
export function safeWriteJson(
  filePath: string,
  data: unknown,
  options?: { mode?: number },
): void {
  safeWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`, options)
}
