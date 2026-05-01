import type { RlaunchRuntimeConfig } from './rlaunch.js'

export type RlaunchErrorTranslation = {
  user: string
  admin: string
  suggestion: string
}

type ErrorRule = {
  pattern: RegExp
  user: string
  admin: string
  suggestion: string
}

const RULES: ErrorRule[] = [
  {
    pattern: /insufficient group quota|quotaCheck|quota denied|quota.*insufficient/i,
    user: '集群配额暂时不足，当前不能准备工作环境。',
    admin: 'RlaunchRuntime quota denied',
    suggestion: '检查 chargedGroup 配额余量，降低 cpu/memory/gpu，或等待其他任务释放资源。',
  },
  {
    pattern: /no machine is available|资源不足|无可用机器|cannot.*scheduled/i,
    user: '集群暂时没有可调度节点。',
    admin: 'RlaunchRuntime no schedulable node',
    suggestion: '降低资源请求，或检查 privateMachine / positiveTags 是否过窄。',
  },
  {
    pattern: /has no right|forbidden|cannot get resource|operate\[use\]/i,
    user: '当前账号没有使用该集群资源组的权限。',
    admin: 'RlaunchRuntime permission denied',
    suggestion: '确认 namespace / chargedGroup 是否正确，并让集群管理员授权当前账号。',
  },
  {
    pattern: /OOMKilled|exit status 137|out of memory/i,
    user: '工作环境因内存不足被集群终止。',
    admin: 'RlaunchRuntime worker OOMKilled',
    suggestion: '调高 runtime.rlaunch.memoryMb，或减少工具执行的内存占用。',
  },
  {
    pattern: /ErrImagePull|ImagePullBackOff|image.*pull.*(failed|timeout|denied|backoff)/i,
    user: '集群拉取 sandbox 镜像失败。',
    admin: 'RlaunchRuntime image pull failed',
    suggestion: '确认 runtime.rlaunch.image 已推到集群可访问 registry，且 imagePullPolicy / 凭证正确。',
  },
  {
    pattern: /namespaces? .*not found|namespace.*not found/i,
    user: '集群 namespace 配置不存在。',
    admin: 'RlaunchRuntime namespace not found',
    suggestion: '检查 runtime.rlaunch.namespace 拼写和当前账号项目权限。',
  },
  {
    pattern: /mongo: no documents in result|quotagroups?.*not found|charged.*group.*not found/i,
    user: '集群配额组配置不存在。',
    admin: 'RlaunchRuntime chargedGroup not found',
    suggestion: '检查 runtime.rlaunch.chargedGroup 拼写，确认配额组在目标 namespace 下存在。',
  },
  {
    pattern: /mount nfs|nfs.*not ready|context deadline exceeded/i,
    user: '集群共享存储暂时不可用。',
    admin: 'RlaunchRuntime NFS/GPFS mount failed',
    suggestion: '稍后重试；持续失败时联系集群 oncall 并附上 worker 名称和完整日志。',
  },
  {
    pattern: /GPU is lost|nvml.*gpu is lost|GetPreferredAllocation/i,
    user: '集群节点 GPU 异常，工作环境未能启动。',
    admin: 'RlaunchRuntime node GPU lost',
    suggestion: '重试以避开故障节点；若反复出现，联系 support/oncall。',
  },
  {
    pattern: /cgroup.*cannot allocate memory|Failed to create pod sandbox/i,
    user: '集群节点系统资源异常，工作环境未能启动。',
    admin: 'RlaunchRuntime node cgroup memory failure',
    suggestion: '重试以换节点；持续失败时联系 support/oncall。',
  },
  {
    pattern: /lxcfs|mount through procfd|proc\/stat/i,
    user: '集群节点运行时组件异常，工作环境未能启动。',
    admin: 'RlaunchRuntime node lxcfs failure',
    suggestion: '重试以换节点；持续失败时联系 support/oncall。',
  },
  {
    pattern: /CNI|networkPlugin|failed to setup network/i,
    user: '集群网络组件异常，工作环境未能启动。',
    admin: 'RlaunchRuntime CNI/network failure',
    suggestion: '重试；持续失败时联系 support/oncall。',
  },
]

export function translateRlaunchError(
  raw: string,
  config?: Pick<RlaunchRuntimeConfig, 'canonicalUser' | 'namespace' | 'chargedGroup' | 'image'>,
): RlaunchErrorTranslation {
  const detail = raw.trim() || 'unknown error'
  const rule = RULES.find(candidate => candidate.pattern.test(detail))
  const suffix = config
    ? ` user=${config.canonicalUser} namespace=${config.namespace} chargedGroup=${config.chargedGroup} image=${config.image}`
    : ''
  if (rule) {
    return {
      user: rule.user,
      admin: `${rule.admin}.${suffix}\n${detail}`,
      suggestion: rule.suggestion,
    }
  }
  return {
    user: '集群工作环境启动失败。',
    admin: `RlaunchRuntime failed.${suffix}\n${detail}`,
    suggestion: '查看 rlaunch / brainctl 输出，确认 image、namespace、chargedGroup、gpfs mount 和资源配置。',
  }
}

export function formatRlaunchError(
  raw: string,
  config?: Pick<RlaunchRuntimeConfig, 'canonicalUser' | 'namespace' | 'chargedGroup' | 'image'>,
): string {
  const translated = translateRlaunchError(raw, config)
  return `${translated.admin}\nSuggestion: ${translated.suggestion}`
}
