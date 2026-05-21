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
      note(FEISHU_SETUP_NOTE, 'Feishu bot setup')
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
  outro(`Config written to ${configPath}. Use /auth import codex later for Codex OAuth.`)
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

const FEISHU_SETUP_NOTE = `配置飞书机器人 —— 在「飞书开放平台」开发者后台完成以下 5 步：

【1】创建应用
  open.feishu.cn/app → 创建「企业自建应用」
  「添加应用能力」→ 启用「机器人」
  「凭证与基础信息」记下 App ID、App Secret

【2】开通权限（「权限管理」按描述搜索勾选）
  核心（必开）：
    im:message
    im:message:send_as_bot
    im:message.p2p_msg:readonly
    im:message.group_at_msg:readonly
    im:resource
    contact:user.base:readonly
  选配（仅在要用飞书云文档工具时）：
    drive:drive   docx:document   sheets:spreadsheet   wiki:wiki:readonly

【3】配置事件与回调（「事件与回调」页，两个标签都设为长连接）
  「事件配置」标签：订阅方式选「使用长连接」，添加事件：
    im.message.receive_v1
    im.message.recalled_v1
  「回调配置」标签：订阅方式选「使用长连接」，启用：
    卡片回传交互（card.action.trigger）
  注：Encrypt Key / Verification Token 留空；若长连接选项不亮，
      先启动 LightClaw 把长连接建上再回控制台刷新。

【4】发布（「版本管理与发布」）
  创建版本 → 可用范围含自己（或全员）→ 发布
  权限 / 事件 / 回调的改动都必须发布后才生效。

【5】开始使用
  单聊：在飞书里主动给机器人发一条消息
  群聊：把机器人拉进群

下面把 App ID / App Secret 填进来：`
