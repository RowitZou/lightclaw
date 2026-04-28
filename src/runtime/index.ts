import { DockerRuntime, type DockerRuntimeConfig } from './docker.js'
import { LocalRuntime } from './local.js'
import type { Runtime } from './types.js'

export type {
  ExecInput,
  ExecResult,
  GlobOptions,
  Runtime,
  RuntimeFs,
  RuntimeKind,
  RuntimeStat,
} from './types.js'
export { DockerRuntime, type DockerRuntimeConfig } from './docker.js'

export type CreateRuntimeOptions =
  | { kind: 'local'; workspaceRoot: string }
  | { kind: 'docker'; config: DockerRuntimeConfig }
  | { kind: 'rjob' }

export function createRuntime(options: CreateRuntimeOptions): Runtime {
  switch (options.kind) {
    case 'local':
      return new LocalRuntime(options.workspaceRoot)
    case 'docker':
      return new DockerRuntime(options.config)
    case 'rjob':
      throw new Error('Runtime backend "rjob" is not yet implemented (Phase 11.3).')
  }
}
