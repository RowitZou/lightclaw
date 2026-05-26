import path from 'node:path'

import type { BackgroundJobMeta } from './types.js'

export const BG_EXEC_DIR = '.lightclaw/bg-exec'
export const OUT_FILE = 'out'
export const ERR_FILE = 'err'
export const EXIT_FILE = 'exit'
export const EXIT_TMP_FILE = 'exit.tmp'
export const KILLED_FILE = 'killed'
export const LOST_FILE = 'lost'
export const META_FILE = 'meta.json'
export const PGID_FILE = 'pgid'

export function jobDirFor(workspaceRoot: string, jobId: string): string {
  return path.posix.join(workspaceRoot, BG_EXEC_DIR, jobId)
}

export function jobFile(jobDir: string, filename: string): string {
  return path.posix.join(jobDir, filename)
}

export function serializeMeta(meta: BackgroundJobMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`
}

export function buildLauncherScript(
  input: Pick<BackgroundJobMeta, 'command' | 'cwd'>,
  jobDir: string,
): string {
  const inner = [
    `echo $$ > "$1/${PGID_FILE}"`,
    'cd "$2" || exit 1',
    `bash -c "$3" > "$1/${OUT_FILE}" 2> "$1/${ERR_FILE}" < /dev/null`,
    'code=$?',
    `printf "%s" "$code" > "$1/${EXIT_TMP_FILE}" && mv "$1/${EXIT_TMP_FILE}" "$1/${EXIT_FILE}"`,
  ].join('\n')

  return [
    `setsid bash -c ${shellQuote(inner)} _ ${shellQuote(jobDir)} ${shellQuote(input.cwd)} ${shellQuote(input.command)} < /dev/null > /dev/null 2>&1 &`,
    'for _ in $(seq 1 50); do',
    `  [ -s ${shellQuote(jobFile(jobDir, PGID_FILE))} ] && break`,
    '  sleep 0.1',
    'done',
    `if [ ! -s ${shellQuote(jobFile(jobDir, PGID_FILE))} ]; then`,
    `  echo "background job failed to write ${PGID_FILE}" >&2`,
    '  exit 1',
    'fi',
    `printf "LIGHTCLAW_BG_PGID:%s\\n" "$(cat ${shellQuote(jobFile(jobDir, PGID_FILE))})"`,
  ].join('\n')
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
