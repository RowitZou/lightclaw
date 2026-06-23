import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  outro,
  password,
  select,
  text,
} from '@clack/prompts'

import { atomicWriteJson } from './config-io.js'
import type { ConfigFileShape } from './config-file.js'
import { resolveStartupHome } from './config-bootstrap.js'
import { t } from './i18n/index.js'
import { expandHomePath, setLightclawHomeOverride } from './paths.js'

export type WizardAnswers = {
  home: string
  provider: 'anthropic' | 'openai-compatible'
  apiKey: string
  baseUrl?: string
  modelId?: string
  runtime: 'docker' | 'local'
  feishu?: {
    appId: string
    appSecret: string
  }
}

export function buildWizardConfig(answers: WizardAnswers): ConfigFileShape {
  const base: ConfigFileShape = {
    home: answers.home,
    runtime: { backend: answers.runtime },
    channels: {
      feishu: answers.feishu
        ? {
            enabled: true,
            transport: 'ws',
            appId: answers.feishu.appId,
            appSecret: answers.feishu.appSecret,
          }
        : { enabled: false },
    },
  }

  if (answers.provider === 'anthropic') {
    return {
      ...base,
      endpoints: {
        anthropic: {
          apiKey: answers.apiKey,
          ...(answers.baseUrl ? { baseUrl: answers.baseUrl } : {}),
        },
      },
      models: {
        sonnet: {
          endpoint: 'anthropic',
          schema: 'anthropic',
          upstreamModel: 'claude-sonnet-4-6',
        },
      },
      defaultModel: 'sonnet',
    }
  }

  const modelId = answers.modelId?.trim()
  if (!modelId) {
    throw new Error('OpenAI-compatible wizard config requires modelId.')
  }
  if (!answers.baseUrl?.trim()) {
    throw new Error('OpenAI-compatible wizard config requires baseUrl.')
  }
  return {
    ...base,
    endpoints: {
      default: {
        apiKey: answers.apiKey,
        baseUrl: answers.baseUrl.trim(),
      },
    },
    models: {
      [modelId]: {
        endpoint: 'default',
        schema: 'openai',
        upstreamModel: modelId,
      },
    },
    defaultModel: modelId,
  }
}

export async function runConfigWizard(input: {
  homeFlag?: string
} = {}): Promise<{ home: string }> {
  intro('LightClaw first-run setup')

  const provider = await promptValue(
    select<'anthropic' | 'openai-compatible'>({
      message: 'Choose a model provider',
      options: [
        { label: 'Anthropic API', value: 'anthropic' },
        { label: 'OpenAI-compatible API', value: 'openai-compatible' },
      ],
    }),
  )
  const apiKey = await promptNonEmptyPassword('API key')

  let baseUrl: string | undefined
  let modelId: string | undefined
  if (provider === 'openai-compatible') {
    baseUrl = await promptNonEmptyText('Base URL')
    modelId = await promptNonEmptyText('Model id')
  } else {
    const value = await text({
      message: 'Anthropic base URL (optional)',
      placeholder: 'Leave blank for the official endpoint',
    })
    if (isCancel(value)) {
      cancel('Setup cancelled.')
      process.exit(0)
    }
    baseUrl = value.trim() || undefined
  }

  const useDefaults = await promptValue(
    confirm({
      message: 'Use defaults for home, runtime, and Feishu?',
      initialValue: true,
    }),
  )

  let home = resolveStartupHome({ homeFlag: input.homeFlag })
  let runtime: 'docker' | 'local' = 'docker'
  let feishu: WizardAnswers['feishu']
  if (!useDefaults) {
    if (!input.homeFlag) {
      const homeText = await text({
        message: 'LightClaw home directory',
        placeholder: '~/.lightclaw',
        defaultValue: '~/.lightclaw',
      })
      if (isCancel(homeText)) {
        cancel('Setup cancelled.')
        process.exit(0)
      }
      home = path.resolve(expandHomePath(homeText.trim() || '~/.lightclaw'))
    }
    runtime = await promptValue(
      select<'docker' | 'local'>({
        message: 'Runtime backend',
        options: [
          { label: 'docker (recommended)', value: 'docker' },
          { label: 'local (single-user/admin only)', value: 'local' },
        ],
      }),
    )
    const configureFeishu = await promptValue(
      confirm({
        message: 'Configure a Feishu bot now?',
        initialValue: false,
      }),
    )
    if (configureFeishu) {
      note(t('wizard.feishu.setupNote'), 'Feishu bot setup')
      feishu = {
        appId: await promptNonEmptyText('App ID'),
        appSecret: await promptNonEmptyPassword('App Secret'),
      }
    }
  }

  setLightclawHomeOverride(home)
  const configPath = path.join(home, 'config.json')
  if (existsSync(configPath)) {
    note(`Config already exists at ${configPath}; leaving it unchanged.`, 'Config exists')
    outro('Using the existing config.')
    return { home }
  }

  mkdirSync(home, { recursive: true })
  atomicWriteJson(
    configPath,
    buildWizardConfig({ home, provider, apiKey, baseUrl, modelId, runtime, feishu }),
  )
  outro(`Config written to ${configPath}. Use /admin endpoint add codex --type codex --auth-path <auth.json> later for Codex OAuth.`)
  return { home }
}

async function promptNonEmptyText(message: string): Promise<string> {
  return promptValue(
    text({
      message,
      validate(value) {
        return value?.trim() ? undefined : 'Required.'
      },
    }),
  )
}

async function promptNonEmptyPassword(message: string): Promise<string> {
  return promptValue(
    password({
      message,
      validate(value) {
        return value?.trim() ? undefined : 'Required.'
      },
    }),
  )
}

async function promptValue<T>(promise: Promise<T | symbol>): Promise<T> {
  const value = await promise
  if (isCancel(value)) {
    cancel('Setup cancelled.')
    process.exit(0)
  }
  return value
}

// Body content lives in src/i18n/locales.ts under `wizard.feishu.setupNote`.
// Resolved at call time (not module-load) so the active locale picked by
// `setLang(config.lang)` in initializeApp() takes effect.
