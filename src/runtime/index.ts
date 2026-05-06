import { DockerRuntime, type DockerRuntimeConfig } from './docker.js'
import type { ImageReadinessTracker } from './image-readiness.js'
import { LocalRuntime } from './local.js'
import { RlaunchRuntime, type RlaunchRuntimeConfig } from './rlaunch.js'
import type { WorkerReadinessTracker } from './worker-readiness.js'
import type { Runtime } from './types.js'

export type {
  ExecInput,
  ExecResult,
  GlobOptions,
  Runtime,
  RuntimeAvailability,
  RuntimeFs,
  RuntimeKind,
  RuntimeStat,
} from './types.js'
export { DockerRuntime, type DockerRuntimeConfig } from './docker.js'
export {
  RlaunchRuntime,
  type RlaunchRuntimeConfig,
  parseWorkerName,
} from './rlaunch.js'
export {
  ImageReadinessTracker,
  type ImageReadinessSnapshot,
  type ImageReadinessState,
  formatPullError,
  isImageMissingError,
} from './image-readiness.js'
export {
  WorkerReadinessTracker,
  type WorkerReadinessSnapshot,
  type WorkerReadinessState,
} from './worker-readiness.js'

export type CreateRuntimeOptions =
  | {
      kind: 'local'
      workspaceRoot: string
      proxy?: string | null
      noProxy?: readonly string[]
    }
  | { kind: 'docker'; config: DockerRuntimeConfig; tracker: ImageReadinessTracker }
  | { kind: 'rlaunch'; config: RlaunchRuntimeConfig; tracker: WorkerReadinessTracker }
  | { kind: 'rjob' }

export function createRuntime(options: CreateRuntimeOptions): Runtime {
  switch (options.kind) {
    case 'local':
      return new LocalRuntime(
        options.workspaceRoot,
        options.proxy ?? null,
        options.noProxy ?? [],
      )
    case 'docker':
      return new DockerRuntime(options.config, options.tracker)
    case 'rlaunch':
      return new RlaunchRuntime(options.config, options.tracker)
    case 'rjob':
      throw new Error(
        'Runtime backend "rjob" is not implemented. Use rlaunch for runtime sandbox; ' +
        'rjob is reserved for batch training jobs via the cluster-job skill.',
      )
  }
}
