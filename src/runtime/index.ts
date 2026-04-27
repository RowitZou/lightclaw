import { LocalRuntime } from './local.js'
import type { Runtime, RuntimeKind } from './types.js'

export type {
  ExecInput,
  ExecResult,
  Runtime,
  RuntimeFs,
  RuntimeKind,
} from './types.js'

export function createRuntime(
  kind: RuntimeKind,
  options: { workspace: string },
): Runtime {
  switch (kind) {
    case 'local':
      return new LocalRuntime(options.workspace)
    case 'docker':
      throw new Error('Runtime backend "docker" is not yet implemented (Phase 11.2).')
    case 'rjob':
      throw new Error('Runtime backend "rjob" is not yet implemented (Phase 11.3).')
  }
}
