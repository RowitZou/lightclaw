#!/usr/bin/env node
import { constants as fsConstants, cpSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_GPFS_RULES = [
  { hostPrefix: '/mnt/shared-storage-user', mountPrefix: 'gpfs://gpfs1' },
  { hostPrefix: '/mnt/shared-storage-gpfs2', mountPrefix: 'gpfs://gpfs2' },
  {
    hostPrefix: '/mnt/shared-storage-gpfs2/gpfs2-shared-public',
    mountPrefix: 'gpfs://gpfs2/gpfs2-shared-public',
  },
]

const ADMIN_TOP_LEVEL_KEYS = [
  'endpoints',
  'models',
  'defaultModel',
  'roles',
  'subLLM',
  'tools',
  'runtime',
  'channels',
  'apiLogsEnabled',
  'permissionMode',
  'permissionCeiling',
  'contextWindow',
  'maxOutputTokens',
  'turns',
  'streamIdle',
  'mcp',
  'hooks',
  'memory',
  'compact',
  'taskrun',
  'dispatch',
  'attachments',
]

const ADMIN_PATH_KEYS = [
  'workspace',
  'apiLogs',
  'audit',
  'logs',
  'hooks',
  'mcpConfig',
  'permissionAudit',
  'permissionRules',
]

function usage() {
  return [
    'Usage:',
    '  node scripts/migrate-basic-config.mjs [--home <dir>] [--apply] [--fresh-home] [--print-redacted]',
    '',
    'Default mode is dry-run. With --apply, the script:',
    '  1. backs up the whole LightClaw home to a sibling timestamped backup',
    '  2. writes a minimized admin-level config.json atomically',
    '  3. sets config.json mode to 0600 because endpoints may contain API keys',
    '',
    'With --fresh-home, --apply renames the current home to the backup path',
    'and creates a brand-new home containing only config.json.',
    '',
    'The minimized config keeps admin/deployment sections and removes per-user',
    'path overrides paths.sessions and paths.memory. User sessions/memory now',
    'live under users/<canonical>/ by the user-first storage layout.',
  ].join('\n')
}

function parseArgs(argv) {
  const parsed = {
    home: process.env.LIGHTCLAW_HOME || path.join(os.homedir(), '.lightclaw'),
    apply: false,
    freshHome: false,
    printRedacted: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--home') {
      const value = argv[index + 1]
      if (!value) throw new Error('--home requires a directory')
      parsed.home = value
      index += 1
    } else if (arg === '--apply') {
      parsed.apply = true
    } else if (arg === '--fresh-home') {
      parsed.freshHome = true
    } else if (arg === '--print-redacted') {
      parsed.printRedacted = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  parsed.home = path.resolve(expandHome(parsed.home))
  return parsed
}

function expandHome(input) {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function buildMinimalConfig(input) {
  const next = {}
  const removed = []
  const warnings = []

  for (const key of ADMIN_TOP_LEVEL_KEYS) {
    if (input[key] !== undefined) {
      next[key] = input[key]
    }
  }

  const cleanedPaths = {}
  for (const key of ADMIN_PATH_KEYS) {
    if (input.paths?.[key] !== undefined) {
      cleanedPaths[key] = input.paths[key]
    }
  }
  for (const key of ['sessions', 'memory']) {
    if (input.paths?.[key] !== undefined) {
      removed.push(`paths.${key}`)
    }
  }
  if (Object.keys(cleanedPaths).length > 0) {
    next.paths = cleanedPaths
  }

  if (next.runtime?.backend === 'cluster') {
    const cluster = next.runtime.clusterSettings || {}
    next.runtime = {
      ...next.runtime,
      clusterSettings: normalizeClusterSettings(cluster, next.paths, warnings),
    }
  }

  validateMinimalConfig(next, warnings)
  return { config: next, removed, warnings }
}

function normalizeClusterSettings(cluster, pathsConfig, warnings) {
  const nextCluster = { ...cluster }

  if (!Array.isArray(nextCluster.gpfsMounts) || nextCluster.gpfsMounts.length === 0) {
    const legacyHost = nextCluster.gpfsHostPrefix
    const legacyMount = nextCluster.gpfsMountPrefix
    if (typeof legacyHost === 'string' && typeof legacyMount === 'string') {
      nextCluster.gpfsMounts = [{ hostPrefix: legacyHost, mountPrefix: legacyMount }]
      warnings.push('converted legacy runtime.clusterSettings.gpfsHostPrefix/gpfsMountPrefix to gpfsMounts')
    } else {
      nextCluster.gpfsMounts = inferGpfsRules(pathsConfig)
      warnings.push('runtime.clusterSettings.gpfsMounts was missing; inferred known shared-storage rules')
    }
  }

  delete nextCluster.gpfsHostPrefix
  delete nextCluster.gpfsMountPrefix
  nextCluster.gpfsMounts = dedupeRules(nextCluster.gpfsMounts)

  if (nextCluster.gpfsMounts.length === 0) {
    throw new Error('cluster runtime requires runtime.clusterSettings.gpfsMounts')
  }

  const workspace = pathsConfig?.workspace
  if (typeof workspace === 'string' && !isUnderAnyPrefix(workspace, nextCluster.gpfsMounts)) {
    warnings.push(`paths.workspace is not under any gpfsMounts hostPrefix: ${workspace}`)
  }

  return nextCluster
}

function inferGpfsRules(pathsConfig) {
  const candidates = new Set()
  for (const value of Object.values(pathsConfig || {})) {
    collectPathCandidates(value, candidates)
  }
  const inferred = DEFAULT_GPFS_RULES.filter(rule => {
    for (const candidate of candidates) {
      if (isPathUnder(candidate, rule.hostPrefix)) return true
    }
    return false
  })
  return inferred.length > 0 ? inferred : DEFAULT_GPFS_RULES.slice(0, 1)
}

function collectPathCandidates(value, out) {
  if (typeof value === 'string') {
    out.add(path.resolve(expandHome(value)))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathCandidates(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPathCandidates(item, out)
  }
}

function dedupeRules(rules) {
  const byHostPrefix = new Map()
  for (const rawRule of rules || []) {
    if (!rawRule || typeof rawRule !== 'object') continue
    const hostPrefix = typeof rawRule.hostPrefix === 'string'
      ? path.resolve(expandHome(rawRule.hostPrefix.trim()))
      : ''
    const mountPrefix = typeof rawRule.mountPrefix === 'string'
      ? rawRule.mountPrefix.trim().replace(/\/+$/, '')
      : ''
    if (!hostPrefix || !mountPrefix) continue
    byHostPrefix.set(hostPrefix, mountPrefix)
  }
  return [...byHostPrefix.entries()]
    .map(([hostPrefix, mountPrefix]) => ({ hostPrefix, mountPrefix }))
    .sort((a, b) => b.hostPrefix.length - a.hostPrefix.length)
}

function isUnderAnyPrefix(target, rules) {
  return rules.some(rule => isPathUnder(target, rule.hostPrefix))
}

function isPathUnder(targetInput, prefixInput) {
  const target = path.resolve(expandHome(targetInput))
  const prefix = path.resolve(expandHome(prefixInput))
  return target === prefix || target.startsWith(`${prefix}${path.sep}`)
}

function validateMinimalConfig(config, warnings) {
  if (config.defaultModel && config.models && !config.models[config.defaultModel]) {
    warnings.push(`defaultModel "${config.defaultModel}" is not present in models`)
  }

  for (const [modelName, model] of Object.entries(config.models || {})) {
    const endpoint = model && typeof model === 'object' ? model.endpoint : undefined
    if (typeof endpoint === 'string' && config.endpoints && !config.endpoints[endpoint]) {
      warnings.push(`model "${modelName}" references missing endpoint "${endpoint}"`)
    }
  }
}

function scrubSecrets(value, key = '') {
  if (/key|token|secret|password|authorization/i.test(key)) {
    return '<redacted>'
  }
  if (Array.isArray(value)) {
    return value.map(item => scrubSecrets(item))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, scrubSecrets(childValue, childKey)]),
    )
  }
  return value
}

function summarize(config) {
  return {
    topLevel: Object.keys(config),
    endpoints: Object.keys(config.endpoints || {}).length,
    models: Object.keys(config.models || {}).length,
    defaultModel: config.defaultModel,
    paths: config.paths || {},
    runtime: config.runtime
      ? {
          backend: config.runtime.backend,
          driver: config.runtime.driver,
          gpfsMounts: config.runtime.clusterSettings?.gpfsMounts || [],
        }
      : undefined,
  }
}

function timestamp() {
  const now = new Date()
  const pad = number => String(number).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('')
}

async function backupHome(home) {
  const parent = path.dirname(home)
  const base = `${path.basename(home)}.backup-${timestamp()}-`
  const backup = await mkdtemp(path.join(parent, base))
  await rm(backup, { recursive: true, force: true })
  cpSync(home, backup, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  })
  return backup
}

async function writeConfigAtomic(configPath, config) {
  const dir = path.dirname(configPath)
  const tmp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`)
  const body = `${JSON.stringify(config, null, 2)}\n`
  await writeFile(tmp, body, { mode: 0o600 })
  await chmod(tmp, 0o600)
  renameSync(tmp, configPath)
  await chmod(configPath, 0o600)
}

async function replaceHomeWithFreshConfig(home, config) {
  const parent = path.dirname(home)
  const backup = path.join(parent, `${path.basename(home)}.backup-${timestamp()}-fresh`)
  const staging = await mkdtemp(path.join(parent, `${path.basename(home)}.fresh-${timestamp()}-`))
  await chmod(staging, 0o700)

  try {
    await writeConfigAtomic(path.join(staging, 'config.json'), config)
    renameSync(home, backup)
    try {
      renameSync(staging, home)
    } catch (error) {
      try {
        renameSync(backup, home)
      } catch (restoreError) {
        throw new Error(
          `failed to install fresh home (${error instanceof Error ? error.message : String(error)}); ` +
          `also failed to restore backup (${restoreError instanceof Error ? restoreError.message : String(restoreError)})`,
        )
      }
      throw error
    }
    return backup
  } catch (error) {
    if (existsSync(staging)) {
      await rm(staging, { recursive: true, force: true })
    }
    throw error
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configPath = path.join(args.home, 'config.json')

  if (!existsSync(args.home) || !statSync(args.home).isDirectory()) {
    throw new Error(`LightClaw home does not exist or is not a directory: ${args.home}`)
  }
  await access(configPath, fsConstants.R_OK)

  const original = loadJson(configPath)
  const { config, removed, warnings } = buildMinimalConfig(original)

  console.log(JSON.stringify({
    mode: args.apply ? 'apply' : 'dry-run',
    home: args.home,
    configPath,
    removed,
    warnings,
    summary: summarize(config),
  }, null, 2))

  if (args.printRedacted) {
    console.log('\n--- redacted config preview ---')
    console.log(JSON.stringify(scrubSecrets(config), null, 2))
  }

  if (!args.apply) {
    console.log('\nDry-run only. Re-run with --apply to create backup and write config.json.')
    return
  }

  const backup = args.freshHome
    ? await replaceHomeWithFreshConfig(args.home, config)
    : await backupHome(args.home)
  if (!args.freshHome) {
    await writeConfigAtomic(configPath, config)
  }
  console.log(`\nBackup: ${backup}`)
  console.log(`Wrote:  ${configPath}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
