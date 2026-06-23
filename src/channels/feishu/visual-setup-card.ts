import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'

import {
  deleteUserCodexAuth,
  importUserCodexAuth,
  listUserCodexAuth,
  parseCodexAuthRef,
  readUserCodexAuth,
} from '../../auth/codex/user-store.js'
import { loadBackgroundTasks } from '../../background-task/store.js'
import { getConfig } from '../../config.js'
import {
  loadUserConfigOverride,
  resolveUserConfig,
  updateUserConfigOverride,
  type UserConfigOverride,
  type UserEndpointOverride,
  type UserModelOverride,
} from '../../config/user-override.js'
import { normalizeProxyUrl } from '../../config/proxy-url.js'
import { runModelCustomCommand } from '../../commands/model-custom.js'
import { runMountCommand } from '../../commands/mount.js'
import { restartRlaunchRuntimeForUser } from '../../commands/rlaunch-restart.js'
import {
  formatModelRequestParamHelp,
  formatModelRequestParamsForCard,
  normalizeModelRequestParams,
  parseModelRequestParamFlagValue,
  parseModelTuningParamsText,
  splitModelTuningParams,
  type ModelRequestParams,
  type ModelTuningParams,
} from '../../model-request-params.js'
import type { ReplContext } from '../../commands/registry.js'
import {
  userDataRoot,
  userHome,
  userSessionsRoot,
  userSkillsRoot,
  userWorkspaceOverride,
  workspaceFor,
} from '../../identity/paths.js'
import { validateUserWorkspacePath } from '../../identity/workspace.js'
import { getMemoryDir } from '../../memory/auto-memory.js'
import { requestDataRootChange, listDataRootRequests } from '../../identity/data-root-requests.js'
import { isAdmin } from '../../identity/store.js'
import { loadUserRlaunchMounts } from '../../runtime/rlaunch-mounts.js'
import { loadUserSecrets, validateSecretName } from '../../secrets/store.js'
import type { ReasoningEffort, Schema } from '../../provider/types.js'
import { clearProviderCacheForEndpoint } from '../../provider/index.js'
import { discoverSkillsForUser } from '../../skill/loader.js'
import { getBackgroundJobRegistry } from '../../background-exec/registry.js'
import { createSessionContext, runWithSessionContext } from '../../session-context.js'
import type { FeishuCardActionResponse } from './permission-card.js'
import { formatFeishuErrorForLog } from './resources/errors.js'
import { parseFeishuSessionId, type ParsedFeishuSessionId } from './routing.js'
import type { FeishuSender } from './sender.js'

const UI_TTL_MS = 30 * 60_000
const ALIAS_RE = /^[A-Za-z0-9_.-]{1,80}$/

const FIELD_ENDPOINT_CHOICE = 'endpoint_choice'
const FIELD_ENDPOINT_NAME = 'endpoint_name'
const FIELD_API_KEY_REF = 'api_key_ref'
const FIELD_AUTH_NAME = 'auth_name'
const FIELD_AUTH_REF = 'auth_ref'
const FIELD_AUTH_IMPORT_PATH = 'auth_import_path'
const FIELD_BASE_URL = 'base_url'
const FIELD_PROXY = 'proxy'
const FIELD_MODEL_ALIAS = 'model_alias'
const FIELD_SCHEMA = 'schema'
const FIELD_UPSTREAM_MODEL = 'upstream_model'
const FIELD_REASONING = 'reasoning'
const FIELD_MAX_OUTPUT_TOKENS = 'max_output_tokens'
const FIELD_REQUEST_PARAMS = 'request_params'
const FIELD_REQUEST_PARAM_KEY_PREFIX = 'request_param_key_'
const FIELD_REQUEST_PARAM_VALUE_PREFIX = 'request_param_value_'
const FIELD_SET_DEFAULT = 'set_default'
const FIELD_MODEL_TARGET = 'model_target'
const FIELD_ENDPOINT_KIND = 'endpoint_kind'
const FIELD_ENDPOINT_TARGET = 'endpoint_target'
const FIELD_ENDPOINT_DELETE_NAME = 'endpoint_delete_name'
const FIELD_AUTH_DELETE_NAME = 'auth_delete_name'
const FIELD_DATA_DIR = 'data_dir'
const FIELD_WORKSPACE = 'workspace'
const FIELD_MOUNT_PATHS = 'mount_paths'
const FIELD_MOUNT_SELECTED_PATH = 'mount_selected_path'
const FIELD_MOUNT_MODE = 'mount_mode'

export type VisualSetupCardAction = {
  kind: 'lightclaw_visual_setup'
  id: string
  action:
    | 'home'
    | 'model_home'
    | 'setup_model'
    | 'setup_model_existing'
    | 'setup_model_new_codex'
    | 'setup_model_new_key'
    | 'submit_model'
    | 'model_edit'
    | 'submit_model_edit'
    | 'model_set_default'
    | 'submit_model_set_default'
    | 'model_check'
    | 'submit_model_check'
    | 'model_delete'
    | 'submit_model_delete'
    | 'model_param_help'
    | 'model_param_add_row'
    | 'endpoint_home'
    | 'endpoint_add'
    | 'endpoint_edit'
    | 'endpoint_update'
    | 'endpoint_update_edit'
    | 'submit_endpoint'
    | 'submit_endpoint_add'
    | 'submit_endpoint_update'
    | 'endpoint_delete'
    | 'submit_endpoint_delete'
    | 'auth_home'
    | 'auth_edit'
    | 'submit_auth'
    | 'auth_delete'
    | 'submit_auth_delete'
    | 'directory_home'
    | 'workspace_edit'
    | 'submit_workspace'
    | 'data_dir_request'
    | 'submit_data_dir_request'
    | 'mount_add'
    | 'submit_mount_add'
    | 'mount_remove'
    | 'submit_mount_remove'
    | 'skill_home'
    | 'task_home'
    | 'admin_home'
    | 'cancel'
  operatorOpenId?: string
  formValue?: Record<string, unknown>
  openMessageId?: string
  endpointName?: string
  paramMode?: string
  paramRows?: number
}

type ModelParamMode = 'setup_existing' | 'setup_new_codex' | 'setup_new_key' | 'edit'

const DEFAULT_PARAM_ROWS = 2
const MAX_PARAM_ROWS = 8

type UiSession = {
  id: string
  sessionId: string
  userId: string
  parsed: ParsedFeishuSessionId
  requesterOpenId?: string
  cardMessageId?: string
  createdAt: number
}

type SubmitResult = {
  modelName: string
  endpointName: string
  endpointCreated: boolean
}

type EndpointSaveResult = {
  endpointName: string
  action: 'created' | 'updated'
}

type AuthSaveResult = {
  authName: string
  action: 'created' | 'updated'
}

let activeCoordinator: FeishuVisualSetupCoordinator | null = null

export function registerFeishuVisualSetupCoordinator(coord: FeishuVisualSetupCoordinator): void {
  activeCoordinator = coord
}

export function clearFeishuVisualSetupCoordinator(coord?: FeishuVisualSetupCoordinator): void {
  if (!coord || activeCoordinator === coord) {
    activeCoordinator = null
  }
}

export function getFeishuVisualSetupCoordinator(): FeishuVisualSetupCoordinator | null {
  return activeCoordinator
}

export class FeishuVisualSetupCoordinator {
  private readonly sessions = new Map<string, UiSession>()
  private readonly now: () => number
  private readonly checkModel: (input: {
    userId: string
    sessionId: string
    modelName: string
  }) => Promise<string>
  private readonly restartRlaunch: (input: {
    userId: string
  }) => Promise<string>

  constructor(
    private readonly sender: FeishuSender,
    options: {
      now?: () => number
      checkModel?: (input: { userId: string; sessionId: string; modelName: string }) => Promise<string>
      restartRlaunch?: (input: { userId: string }) => Promise<string>
    } = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.checkModel = options.checkModel ?? (input => defaultCheckModel(input))
    this.restartRlaunch = options.restartRlaunch ?? (input =>
      restartRlaunchRuntimeForUser({ userId: input.userId, config: getConfig() }))
  }

  async openHome(input: { sessionId: string; userId: string }): Promise<void> {
    const session = this.createSession(input)
    await this.sendToSession(session, buildHomeCard(session.id, input.userId))
  }

  async openModelSetup(input: { sessionId: string; userId: string }): Promise<void> {
    const session = this.createSession(input)
    await this.sendToSession(session, buildModelSetupCard(session.id, input.userId))
  }

  async handleCardAction(action: VisualSetupCardAction): Promise<FeishuCardActionResponse> {
    const session = this.sessions.get(action.id)
    if (!session || this.isExpired(session)) {
      process.stderr.write(
        `[visual-ui] stale action=${action.action} id=${action.id} session=${session?.sessionId ?? '-'}\n`,
      )
      if (session) this.sessions.delete(session.id)
      return {
        toast: { type: 'warning', content: '这个配置面板已过期，请重新发送 /ui。' },
      }
    }
    this.logAction(action, session)
    if (
      session.requesterOpenId &&
      action.operatorOpenId &&
      session.requesterOpenId !== action.operatorOpenId
    ) {
      process.stderr.write(
        `[visual-ui] rejected operator action=${action.action} id=${action.id} expected=${session.requesterOpenId} actual=${action.operatorOpenId}\n`,
      )
      return {
        toast: { type: 'warning', content: '只有打开这个面板的用户可以操作。' },
      }
    }

    try {
      const response = await this.routeCardAction(session, action)
      await this.patchNavigationCard(session, action, response)
      this.logActionResponse(action, response)
      return response
    } catch (error) {
      process.stderr.write(
        `[visual-ui] action failed action=${action.action} id=${action.id} error=${error instanceof Error ? error.message : String(error)}\n`,
      )
      return {
        toast: { type: 'error', content: '操作失败' },
        card: rawCard(buildFinalCard(
          '操作失败',
          error instanceof Error ? error.message : String(error),
          'red',
        )),
      }
    }
  }

  private logAction(action: VisualSetupCardAction, session: UiSession): void {
    const formKeys = Object.keys(action.formValue ?? {}).sort().join(',') || '-'
    process.stderr.write(
      `[visual-ui] action=${action.action} id=${action.id} user=${session.userId} session=${session.sessionId} openMessageId=${action.openMessageId ?? '-'} formKeys=${formKeys}\n`,
    )
  }

  private logActionResponse(action: VisualSetupCardAction, response: FeishuCardActionResponse): void {
    const cardData = responseCardDataForLog(response)
    process.stderr.write(
      [
        `[visual-ui] response action=${action.action}`,
        `toast=${responseToastType(response)}`,
        `cardTitle=${cardData ? visualCardTitle(cardData) ?? '(untitled)' : '-'}`,
        `forms=${cardData ? countTaggedElements(cardData, 'form') : 0}`,
        `buttons=${cardData ? countTaggedElements(cardData, 'button') : 0}`,
      ].join(' ') + '\n',
    )
  }

  private async patchNavigationCard(
    session: UiSession,
    action: VisualSetupCardAction,
    response: FeishuCardActionResponse,
  ): Promise<void> {
    if (!shouldPatchNavigationAction(action.action)) return
    const card = responseCardDataForLog(response)
    if (!card) return
    const title = visualCardTitle(card) ?? '(untitled)'
    if (session.cardMessageId) {
      try {
        await this.sender.patchInteractiveCard(session.cardMessageId, card)
        process.stderr.write(
          `[visual-ui] patched action=${action.action} messageId=${session.cardMessageId} cardTitle=${title}\n`,
        )
        return
      } catch (error) {
        process.stderr.write(
          `[visual-ui] patch failed action=${action.action} messageId=${session.cardMessageId} ${formatFeishuErrorForLog(error, 'visual.patchInteractiveCard')}\n`,
        )
      }
    }
    try {
      await this.sendToSession(session, card)
      process.stderr.write(
        `[visual-ui] sent fallback action=${action.action} messageId=${session.cardMessageId ?? '-'} cardTitle=${title}\n`,
      )
    } catch (error) {
      process.stderr.write(
        `[visual-ui] fallback send failed action=${action.action} ${formatFeishuErrorForLog(error, 'visual.sendInteractiveCardToChatId')}\n`,
      )
    }
  }

  private async routeCardAction(
    session: UiSession,
    action: VisualSetupCardAction,
  ): Promise<FeishuCardActionResponse> {
    switch (action.action) {
      case 'home':
        return openCard(buildHomeCard(session.id, session.userId))
      case 'model_home':
        return openCard(buildModelHomeCard(session.id, session.userId))
      case 'setup_model':
        return openCard(buildModelSetupCard(session.id, session.userId))
      case 'setup_model_existing':
        return openCard(buildModelSetupExistingCard(session.id, session.userId))
      case 'setup_model_new_codex':
        return openCard(buildModelSetupNewEndpointCard(session.id, session.userId, 'codex'))
      case 'setup_model_new_key':
        return openCard(buildModelSetupNewEndpointCard(session.id, session.userId, 'api-key'))
      case 'model_edit':
        return openCard(buildModelEditCard(session.id, session.userId))
      case 'model_set_default':
        return openCard(buildModelSetDefaultCard(session.id, session.userId))
      case 'model_check':
        return openCard(buildModelCheckCard(session.id, session.userId))
      case 'model_delete':
        return openCard(buildModelDeleteCard(session.id, session.userId))
      case 'model_param_help':
        return openCard(buildModelParamHelpCard(session.id))
      case 'model_param_add_row':
        return openCard(buildModelCardWithParamRows(
          session.id,
          session.userId,
          parseModelParamMode(action.paramMode),
          clampParamRows(action.paramRows ?? DEFAULT_PARAM_ROWS),
          action.formValue ?? {},
        ))
      case 'endpoint_home':
        return openCard(buildEndpointHomeCard(session.id, session.userId))
      case 'endpoint_add':
      case 'endpoint_edit':
        return openCard(buildEndpointAddCard(session.id))
      case 'endpoint_update':
        return openCard(buildEndpointUpdateSelectCard(session.id, session.userId))
      case 'endpoint_update_edit': {
        const endpointName = requiredExistingEndpointName(session.userId, action.formValue ?? {})
        return openCard(buildEndpointUpdateCard(session.id, session.userId, endpointName))
      }
      case 'endpoint_delete':
        return openCard(buildEndpointDeleteCard(session.id, session.userId))
      case 'auth_home':
        return openCard(buildAuthHomeCard(session.id, session.userId))
      case 'auth_edit':
        return openCard(buildAuthEditCard(session.id))
      case 'auth_delete':
        return openCard(buildAuthDeleteCard(session.id, session.userId))
      case 'directory_home':
        return openCard(buildDirectoryHomeCard(session.id, session.userId))
      case 'workspace_edit':
        return openCard(buildWorkspaceEditCard(session.id, session.userId))
      case 'data_dir_request':
        return openCard(buildDataDirRequestCard(session.id, session.userId))
      case 'mount_add':
        return openCard(buildMountAddCard(session.id))
      case 'mount_remove':
        return openCard(buildMountRemoveCard(session.id, session.userId))
      case 'skill_home':
        return openCard(await buildSkillHomeCard(session.id, session.userId))
      case 'task_home':
        return openCard(buildTaskHomeCard(session.id, session))
      case 'admin_home':
        return openCard(await buildAdminHomeCard(session.id, session.userId))
      case 'cancel':
        return {
          toast: { type: 'info', content: '已取消。' },
          card: rawCard(buildFinalCard('已取消', '没有修改当前用户配置。', 'grey')),
        }
      case 'submit_model': {
        const saved = applyModelSetupForm(session.userId, action.formValue ?? {})
        void this.runCheckAndNotify(session, saved.modelName)
        return {
          toast: { type: 'success', content: '模型配置已保存，正在检查连通性。' },
          card: rawCard(buildSavedCard(saved)),
        }
      }
      case 'submit_model_edit': {
        const saved = applyModelEditForm(session.userId, action.formValue ?? {})
        void this.runCheckAndNotify(session, saved.modelName)
        return {
          toast: { type: 'success', content: '模型配置已更新，正在检查连通性。' },
          card: rawCard(buildFinalWithHomeCard(
            session.id,
            '模型配置已更新',
            `模型：${saved.modelName}\nendpoint：${saved.endpointName}\n正在后台检查模型连通性。`,
            'green',
            'model_home',
            '返回模型管理',
          )),
        }
      }
      case 'submit_model_set_default': {
        const modelName = setDefaultModelFromForm(session.userId, action.formValue ?? {})
        return {
          toast: { type: 'success', content: '默认模型已更新。' },
          card: rawCard(buildFinalWithHomeCard(
            session.id,
            '默认模型已更新',
            `当前默认模型：${modelName}`,
            'green',
            'model_home',
            '返回模型管理',
          )),
        }
      }
      case 'submit_model_check': {
        const modelName = requiredExistingModel(session.userId, action.formValue ?? {})
        void this.runCheckAndNotify(session, modelName)
        return {
          toast: { type: 'info', content: '正在检查模型连通性。' },
          card: rawCard(buildFinalWithHomeCard(
            session.id,
            '模型检查已开始',
            `模型：${modelName}\n检查结果稍后会单独发送。`,
            'grey',
            'model_home',
            '返回模型管理',
          )),
        }
      }
      case 'submit_model_delete': {
        const modelName = deleteModelFromForm(session.userId, action.formValue ?? {})
        return {
          toast: { type: 'success', content: '模型已删除。' },
          card: rawCard(buildFinalWithHomeCard(
            session.id,
            '模型已删除',
            `已删除模型：${modelName}`,
            'green',
            'model_home',
            '返回模型管理',
          )),
        }
      }
      case 'submit_endpoint': {
        const saved = applyEndpointForm(session.userId, action.formValue ?? {})
        return {
          toast: { type: 'success', content: 'endpoint 已保存。' },
          card: rawCard(buildEndpointSavedCard(session.id, saved)),
        }
      }
      case 'submit_endpoint_add': {
        const saved = applyEndpointAddForm(session.userId, action.formValue ?? {})
        return {
          toast: { type: 'success', content: 'endpoint 已新增。' },
          card: rawCard(buildEndpointSavedCard(session.id, saved)),
        }
      }
      case 'submit_endpoint_update': {
        if (!action.endpointName) {
          throw new Error('endpoint update target is missing.')
        }
        const saved = applyEndpointUpdateForm(session.userId, action.endpointName, action.formValue ?? {})
        return {
          toast: { type: 'success', content: 'endpoint 已更新。' },
          card: rawCard(buildEndpointSavedCard(session.id, saved)),
        }
      }
      case 'submit_endpoint_delete': {
        const name = deleteEndpointFromForm(session.userId, action.formValue ?? {})
        return {
          toast: { type: 'success', content: 'endpoint 已删除。' },
          card: rawCard(buildFinalWithHomeCard(
            session.id,
            'Endpoint 已删除',
            `已删除 endpoint：${name}`,
            'green',
            'endpoint_home',
            '返回 endpoint 管理',
          )),
        }
      }
      case 'submit_auth': {
        const saved = applyAuthImportForm(session.userId, action.formValue ?? {})
        return {
          toast: { type: 'success', content: '凭据已保存。' },
          card: rawCard(buildAuthSavedCard(session.id, saved)),
        }
      }
      case 'submit_auth_delete': {
        const name = deleteAuthFromForm(session.userId, action.formValue ?? {})
        return {
          toast: { type: 'success', content: '凭据已删除。' },
          card: rawCard(buildFinalWithHomeCard(
            session.id,
            '凭据已删除',
            `已删除凭据：codex:${name}`,
            'green',
            'auth_home',
            '返回凭据管理',
          )),
        }
      }
      case 'submit_data_dir_request': {
        const result = await requestDataDirFromForm(session.userId, action.formValue ?? {})
        return {
          toast: { type: 'success', content: '用户数据目录请求已提交。' },
          card: rawCard(buildFinalWithHomeCard(
            session.id,
            '目录变更请求已提交',
            [
              `用户数据目录：${result.normalizedPath}`,
              '',
              `请 admin 执行：/user approve-home ${session.userId}`,
            ].join('\n'),
            'green',
            'directory_home',
            '返回目录管理',
          )),
        }
      }
      case 'submit_workspace': {
        const result = await applyWorkspaceForm(session.userId, action.formValue ?? {}, () =>
          this.restartRlaunch({ userId: session.userId }))
        return {
          toast: { type: 'success', content: 'workspace 已保存。' },
          card: rawCard(buildCommandResultCard(session.id, 'Workspace 已更新', result, 'directory_home')),
        }
      }
      case 'submit_mount_add': {
        const result = await applyMountForm(session.userId, action.formValue ?? {}, 'add', () =>
          this.restartRlaunch({ userId: session.userId }))
        return {
          toast: { type: 'success', content: 'rlaunch 挂载已更新。' },
          card: rawCard(buildCommandResultCard(session.id, '挂载已更新', result, 'directory_home')),
        }
      }
      case 'submit_mount_remove': {
        const result = await applyMountForm(session.userId, action.formValue ?? {}, 'remove', () =>
          this.restartRlaunch({ userId: session.userId }))
        return {
          toast: { type: 'success', content: 'rlaunch 挂载已更新。' },
          card: rawCard(buildCommandResultCard(session.id, '挂载已更新', result, 'directory_home')),
        }
      }
    }
  }

  private createSession(input: { sessionId: string; userId: string }): UiSession {
    const parsed = parseFeishuSessionId(input.sessionId)
    if (!parsed) {
      throw new Error('Visual UI is only available in Feishu channel sessions.')
    }
    const id = randomUUID()
    const session: UiSession = {
      id,
      sessionId: input.sessionId,
      userId: input.userId,
      parsed,
      ...(parsed.kind === 'group' ? { requesterOpenId: parsed.senderOpenId } : {}),
      createdAt: this.now(),
    }
    this.sessions.set(id, session)
    return session
  }

  private isExpired(session: UiSession): boolean {
    return this.now() - session.createdAt > UI_TTL_MS
  }

  private async sendToSession(session: UiSession, card: Record<string, unknown>): Promise<void> {
    const sent = await this.sender.sendInteractiveCardToChatId(
      session.parsed.chatId,
      card,
      { purpose: 'notice', canonicalUser: session.userId },
      session.parsed.kind === 'group' ? session.parsed.threadId : undefined,
    )
    if (sent.messageId) session.cardMessageId = sent.messageId
  }

  private async runCheckAndNotify(session: UiSession, modelName: string): Promise<void> {
    try {
      const result = await this.checkModel({
        userId: session.userId,
        sessionId: session.sessionId,
        modelName,
      })
      await this.sendToSession(session, buildCheckResultCard(modelName, result))
    } catch (error) {
      await this.sendToSession(session, buildFinalCard(
        '模型检查失败',
        error instanceof Error ? error.message : String(error),
        'red',
      ))
    }
  }
}

function applyModelSetupForm(userId: string, formValue: Record<string, unknown>): SubmitResult {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }

  const existingEndpoints = loaded.value.endpoints ?? {}
  const endpointChoice = normalizeEndpointChoice(
    stringField(formValue, FIELD_ENDPOINT_CHOICE),
    existingEndpoints,
    formValue,
  )
  const modelName = requiredAlias('model alias', stringField(formValue, FIELD_MODEL_ALIAS))
  const upstreamModel = requiredText('upstreamModel', stringField(formValue, FIELD_UPSTREAM_MODEL))
  const endpointInfo = resolveEndpointFromChoice(userId, loaded.value, endpointChoice, formValue)
  const schema = parseSchema(
    stringField(formValue, FIELD_SCHEMA)
      ?? (endpointInfo.endpoint.authRef ? 'openai-auth' : 'openai'),
  )
  assertSchemaMatchesEndpoint(schema, endpointInfo.endpoint)

  if (loaded.value.models?.[modelName]) {
    throw new Error(`custom model "${modelName}" already exists. Use /model custom set to modify it.`)
  }

  const reasoningInput = stringField(formValue, FIELD_REASONING)
  const maxOutputInput = stringField(formValue, FIELD_MAX_OUTPUT_TOKENS)
  const reasoningEffort = parseReasoningEffort(reasoningInput)
  const maxOutputTokens = parseOptionalPositiveInt(maxOutputInput)
  const tuning = parseVisualRequestParams(formValue, schema)
  const finalReasoningEffort = tuning.reasoningEffort ?? reasoningEffort
  const finalMaxOutputTokens = tuning.maxOutputTokens ?? maxOutputTokens
  const requestParams = tuning.params
  const setDefault = (stringField(formValue, FIELD_SET_DEFAULT) ?? 'yes') !== 'no'

  updateUserConfigOverride(userId, current => {
    const next = cloneOverride(current)
    if (endpointInfo.created) {
      next.endpoints = {
        ...(next.endpoints ?? {}),
        [endpointInfo.name]: endpointInfo.endpoint,
      }
    }
    const model: UserModelOverride = {
      endpoint: endpointInfo.name,
      schema,
      upstreamModel,
      ...(finalReasoningEffort ? { reasoningEffort: finalReasoningEffort } : {}),
      ...(finalMaxOutputTokens !== undefined ? { maxOutputTokens: finalMaxOutputTokens } : {}),
      ...(requestParams ? { requestParams } : {}),
    }
    next.models = {
      ...(next.models ?? {}),
      [modelName]: model,
    }
    if (setDefault) next.defaultModel = modelName
    return next
  })
  if (endpointInfo.created) {
    clearProviderCacheForEndpoint(endpointInfo.name)
  }

  return {
    modelName,
    endpointName: endpointInfo.name,
    endpointCreated: endpointInfo.created,
  }
}

function applyModelEditForm(userId: string, formValue: Record<string, unknown>): SubmitResult {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }
  const modelName = requiredExistingModel(userId, formValue, loaded.value)
  const currentModel = loaded.value.models?.[modelName]
  const endpointName = requiredAlias('endpoint alias', stringField(formValue, FIELD_ENDPOINT_CHOICE))
  const endpoint = loaded.value.endpoints?.[endpointName]
  if (!endpoint) {
    throw new Error(`endpoint "${endpointName}" does not exist for this user.`)
  }
  const schema = parseSchema(
    stringField(formValue, FIELD_SCHEMA)
      ?? (endpoint.authRef ? 'openai-auth' : 'openai'),
  )
  assertSchemaMatchesEndpoint(schema, endpoint)
  const upstreamModel = requiredText('upstreamModel', stringField(formValue, FIELD_UPSTREAM_MODEL))
  const reasoningInput = stringField(formValue, FIELD_REASONING)
  const maxOutputInput = stringField(formValue, FIELD_MAX_OUTPUT_TOKENS)
  const reasoningEffort = parseReasoningEffort(reasoningInput)
  const maxOutputTokens = parseOptionalPositiveInt(maxOutputInput)
  const requestParamsUpdate = parseVisualRequestParams(formValue, schema)
  const requestParams = !requestParamsUpdate.touched
    ? normalizeModelRequestParams(currentModel?.requestParams, schema, 'requestParams')
    : requestParamsUpdate.params
  const finalReasoningEffort = requestParamsUpdate.reasoningEffort
    ?? (reasoningInput !== undefined ? reasoningEffort : currentModel?.reasoningEffort)
  const finalMaxOutputTokens = requestParamsUpdate.maxOutputTokens
    ?? (maxOutputInput !== undefined ? maxOutputTokens : currentModel?.maxOutputTokens)
  const setDefault = (stringField(formValue, FIELD_SET_DEFAULT) ?? 'no') === 'yes'

  updateUserConfigOverride(userId, current => {
    const next = cloneOverride(current)
    next.models = {
      ...(next.models ?? {}),
      [modelName]: {
        endpoint: endpointName,
        schema,
        upstreamModel,
        ...(finalReasoningEffort ? { reasoningEffort: finalReasoningEffort } : {}),
        ...(finalMaxOutputTokens !== undefined ? { maxOutputTokens: finalMaxOutputTokens } : {}),
        ...(requestParams ? { requestParams } : {}),
      },
    }
    if (setDefault) next.defaultModel = modelName
    return next
  })

  return { modelName, endpointName, endpointCreated: false }
}

function setDefaultModelFromForm(userId: string, formValue: Record<string, unknown>): string {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }
  const modelName = requiredExistingModel(userId, formValue, loaded.value)
  updateUserConfigOverride(userId, current => ({
    ...cloneOverride(current),
    defaultModel: modelName,
  }))
  return modelName
}

function deleteModelFromForm(userId: string, formValue: Record<string, unknown>): string {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }
  const modelName = requiredExistingModel(userId, formValue, loaded.value)
  updateUserConfigOverride(userId, current => {
    const next = cloneOverride(current)
    if (!next.models?.[modelName]) {
      throw new Error(`model "${modelName}" does not exist.`)
    }
    delete next.models[modelName]
    if (next.defaultModel === modelName) delete next.defaultModel
    if (next.models && Object.keys(next.models).length === 0) delete next.models
    return next
  })
  return modelName
}

function requiredExistingModel(
  userId: string,
  formValue: Record<string, unknown>,
  current?: UserConfigOverride,
): string {
  const modelName = requiredAlias('model alias', stringField(formValue, FIELD_MODEL_TARGET))
  const loaded = current ? { ok: true as const, value: current } : loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }
  if (!loaded.value.models?.[modelName]) {
    throw new Error(`model "${modelName}" does not exist.`)
  }
  return modelName
}

function applyEndpointForm(
  userId: string,
  formValue: Record<string, unknown>,
): EndpointSaveResult {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }
  const endpointName = requiredAlias('endpoint alias', stringField(formValue, FIELD_ENDPOINT_NAME))
  const kind = normalizeEndpointKind(stringField(formValue, FIELD_ENDPOINT_KIND), formValue)
  const endpointCommon = optionalEndpointFields(formValue)
  let endpoint: UserEndpointOverride

  if (kind === 'api-key') {
    const secretName = validateSecretName(requiredText('apiKeyRef', stringField(formValue, FIELD_API_KEY_REF)))
    if (!loadUserSecrets(userId)[secretName]) {
      throw new Error(`apiKeyRef "${secretName}" is not stored. Use /secret set ${secretName} <VALUE> first.`)
    }
    endpoint = { ...endpointCommon, apiKeyRef: secretName }
  } else if (kind === 'codex') {
    const authName = parseVisualCodexAuthRef(
      userId,
      stringField(formValue, FIELD_AUTH_REF),
      stringField(formValue, FIELD_AUTH_IMPORT_PATH),
    )
    if (!readUserCodexAuth(userId, authName)) {
      throw new Error(`authRef codex:${authName} is not stored. Use /auth codex import --from <path> --name ${authName} first.`)
    }
    endpoint = { ...endpointCommon, authRef: `codex:${authName}` }
  } else {
    throw new Error('endpoint 类型必须是 Codex auth 或 API key。')
  }

  assertEndpointUpdateCompatible(loaded.value, endpointName, endpoint)
  const existed = Boolean(loaded.value.endpoints?.[endpointName])
  updateUserConfigOverride(userId, current => ({
    ...cloneOverride(current),
    endpoints: {
      ...(current.endpoints ?? {}),
      [endpointName]: endpoint,
    },
  }))
  clearProviderCacheForEndpoint(endpointName)
  return { endpointName, action: existed ? 'updated' : 'created' }
}

function applyEndpointAddForm(
  userId: string,
  formValue: Record<string, unknown>,
): EndpointSaveResult {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }
  const endpointName = requiredAlias('endpoint alias', stringField(formValue, FIELD_ENDPOINT_NAME))
  if (loaded.value.endpoints?.[endpointName]) {
    throw new Error(`endpoint "${endpointName}" already exists. Use 更新 endpoint to edit it.`)
  }
  return applyEndpointForm(userId, formValue)
}

function applyEndpointUpdateForm(
  userId: string,
  endpointName: string,
  formValue: Record<string, unknown>,
): EndpointSaveResult {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }
  const current = loaded.value.endpoints?.[endpointName]
  if (!current) {
    throw new Error(`endpoint "${endpointName}" does not exist.`)
  }
  const endpointCommon = endpointFieldsForUpdate(formValue, current)
  let endpoint: UserEndpointOverride

  if (current.apiKeyRef) {
    const secretName = validateSecretName(
      stringField(formValue, FIELD_API_KEY_REF) ?? current.apiKeyRef,
    )
    if (!loadUserSecrets(userId)[secretName]) {
      throw new Error(`apiKeyRef "${secretName}" is not stored. Use /secret set ${secretName} <VALUE> first.`)
    }
    endpoint = { ...endpointCommon, apiKeyRef: secretName }
  } else if (current.authRef) {
    const authName = parseVisualCodexAuthRefForUpdate(
      userId,
      current.authRef,
      stringField(formValue, FIELD_AUTH_REF),
      stringField(formValue, FIELD_AUTH_IMPORT_PATH),
    )
    if (!readUserCodexAuth(userId, authName)) {
      throw new Error(`authRef codex:${authName} is not stored. Use /auth codex import --from <path> --name ${authName} first.`)
    }
    endpoint = { ...endpointCommon, authRef: `codex:${authName}` }
  } else {
    throw new Error(`endpoint "${endpointName}" has no apiKeyRef or authRef.`)
  }

  assertEndpointUpdateCompatible(loaded.value, endpointName, endpoint)
  updateUserConfigOverride(userId, currentConfig => ({
    ...cloneOverride(currentConfig),
    endpoints: {
      ...(currentConfig.endpoints ?? {}),
      [endpointName]: endpoint,
    },
  }))
  clearProviderCacheForEndpoint(endpointName)
  return { endpointName, action: 'updated' }
}

function requiredExistingEndpointName(
  userId: string,
  formValue: Record<string, unknown>,
): string {
  const endpointName = requiredAlias('endpoint alias', stringField(formValue, FIELD_ENDPOINT_TARGET))
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }
  if (!loaded.value.endpoints?.[endpointName]) {
    throw new Error(`endpoint "${endpointName}" does not exist.`)
  }
  return endpointName
}

function deleteEndpointFromForm(
  userId: string,
  formValue: Record<string, unknown>,
): string {
  const name = requiredAlias('endpoint alias', stringField(formValue, FIELD_ENDPOINT_DELETE_NAME))
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }
  if (!loaded.value.endpoints?.[name]) {
    throw new Error(`endpoint "${name}" does not exist.`)
  }
  const users = Object.entries(loaded.value.models ?? {})
    .filter(([, model]) => model.endpoint === name)
    .map(([modelName]) => modelName)
  if (users.length > 0) {
    throw new Error(`endpoint "${name}" is used by model(s): ${users.join(', ')}. Delete or update those models first.`)
  }
  updateUserConfigOverride(userId, current => {
    const next = cloneOverride(current)
    if (next.endpoints) {
      delete next.endpoints[name]
      if (Object.keys(next.endpoints).length === 0) delete next.endpoints
    }
    return next
  })
  clearProviderCacheForEndpoint(name)
  return name
}

function applyAuthImportForm(
  userId: string,
  formValue: Record<string, unknown>,
): AuthSaveResult {
  const rawName = stringField(formValue, FIELD_AUTH_NAME) ?? 'default'
  const fromPath = requiredText('Codex auth.json 导入路径', stringField(formValue, FIELD_AUTH_IMPORT_PATH))
  const existed = Boolean(readUserCodexAuth(userId, rawName))
  const imported = importUserCodexAuth({
    canonicalUser: userId,
    name: rawName,
    fromPath,
  })
  process.stderr.write(
    `[visual-ui] imported credential user=${userId} name=${imported.name} fromPath=${fromPath}\n`,
  )
  return { authName: imported.name, action: existed ? 'updated' : 'created' }
}

function deleteAuthFromForm(
  userId: string,
  formValue: Record<string, unknown>,
): string {
  const rawName = requiredAlias('Codex auth name', stringField(formValue, FIELD_AUTH_DELETE_NAME))
  const authName = parseCodexAuthRef(rawName.startsWith('codex:') ? rawName : `codex:${rawName}`)
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    throw new Error(`当前用户配置无法读取：${loaded.error}`)
  }
  const ref = `codex:${authName}`
  const users = Object.entries(loaded.value.endpoints ?? {})
    .filter(([, endpoint]) => endpoint.authRef === ref)
    .map(([endpointName]) => endpointName)
  if (users.length > 0) {
    throw new Error(`auth ${ref} is used by endpoint(s): ${users.join(', ')}. Delete or update those endpoints first.`)
  }
  if (!deleteUserCodexAuth(userId, authName)) {
    throw new Error(`Codex auth "${authName}" does not exist.`)
  }
  return authName
}

async function requestDataDirFromForm(
  userId: string,
  formValue: Record<string, unknown>,
): Promise<{ normalizedPath: string }> {
  const rawPath = requiredText('用户数据目录', stringField(formValue, FIELD_DATA_DIR))
  const result = await requestDataRootChange({
    canonicalUser: userId,
    rawPath,
    config: getConfig(),
  })
  if (!result.ok) {
    throw new Error(result.reason.replaceAll('dataRoot', '用户数据目录'))
  }
  return { normalizedPath: result.request.normalizedPath }
}

async function applyWorkspaceForm(
  userId: string,
  formValue: Record<string, unknown>,
  restartRlaunch?: () => Promise<string>,
): Promise<string> {
  const rawPath = requiredText('workspace', stringField(formValue, FIELD_WORKSPACE))
  const config = getConfig()
  const previousWorkspace = workspaceFor(userId)
  const validation = await validateUserWorkspacePath(rawPath, config)
  if (!validation.ok) {
    throw new Error(validation.reason)
  }

  const lines = [
    `dataRoot：${userDataRoot(userId) ?? userHome(userId)}`,
    `原 workspace：${previousWorkspace}`,
    `新 workspace：${validation.path}`,
  ]
  const changed = previousWorkspace !== validation.path
  if (changed) {
    updateUserConfigOverride(userId, current => ({
      ...cloneOverride(current),
      workspace: validation.path,
    }))
    lines.push('用户配置已保存。')
  } else {
    lines.push('workspace 未变化。')
  }

  if (config.runtime.backend === 'cluster') {
    if (!changed) {
      lines.push('rlaunch worker 未重启：workspace 未变化。')
      return lines.join('\n')
    }
    if (!restartRlaunch) {
      lines.push('rlaunch worker 重启未执行：缺少 restart hook。')
      return lines.join('\n')
    }
    try {
      const worker = await restartRlaunch()
      lines.push(`已重启 rlaunch worker：${worker || '<unknown>'}`)
    } catch (error) {
      lines.push(`rlaunch worker 重启失败：${error instanceof Error ? error.message : String(error)}`)
    }
  } else {
    lines.push('当前不是 rlaunch runtime；后续 runtime 启动会使用新 workspace。')
  }
  return lines.join('\n')
}

async function applyMountForm(
  userId: string,
  formValue: Record<string, unknown>,
  action: 'add' | 'remove',
  restartRlaunch?: () => Promise<string>,
): Promise<string> {
  const selectedPath = action === 'remove'
    ? parseOptionalSelectedValue(stringField(formValue, FIELD_MOUNT_SELECTED_PATH))
    : undefined
  const rawPaths = stringField(formValue, FIELD_MOUNT_PATHS)
  const paths = action === 'remove'
    ? [...new Set([
      ...(selectedPath ? [selectedPath] : []),
      ...(rawPaths ? parsePathList(rawPaths) : []),
    ])]
    : parsePathList(requiredText('挂载路径', rawPaths))
  if (paths.length === 0) {
    throw new Error('至少填写一个挂载路径。')
  }
  const mode = (stringField(formValue, FIELD_MOUNT_MODE) ?? 'ro') === 'rw' ? 'rw' : 'ro'
  const rawArgs = action === 'add'
    ? `add ${paths.join(' ')} --${mode}`
    : `remove ${paths.join(' ')}`
  const output = await runMountCommand(rawArgs, {
    config: getConfig(),
    userId,
  }, restartRlaunch ? { restartRlaunch } : {})
  if (/^(Usage:|Error:|rlaunch mount|RlaunchRuntime requires|LightClaw rlaunch mount)/i.test(output.trim())) {
    throw new Error(output.trim())
  }
  return output.trim() || '完成。'
}

function assertEndpointUpdateCompatible(
  current: UserConfigOverride,
  endpointName: string,
  endpoint: UserEndpointOverride,
): void {
  for (const [modelName, model] of Object.entries(current.models ?? {})) {
    if (model.endpoint !== endpointName) continue
    try {
      assertSchemaMatchesEndpoint(model.schema as Schema, endpoint)
    } catch (error) {
      throw new Error(
        `endpoint "${endpointName}" is used by model "${modelName}", but the new credential type is incompatible: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

function normalizeEndpointChoice(
  rawChoice: string | undefined,
  endpoints: NonNullable<UserConfigOverride['endpoints']>,
  formValue: Record<string, unknown>,
): string {
  if (rawChoice) return rawChoice
  if (stringField(formValue, FIELD_ENDPOINT_NAME) && stringField(formValue, FIELD_SCHEMA) === 'openai-auth') return 'new:codex'
  if (stringField(formValue, FIELD_ENDPOINT_NAME) && stringField(formValue, FIELD_SCHEMA) && stringField(formValue, FIELD_SCHEMA) !== 'openai-auth') return 'new:key'
  if (stringField(formValue, FIELD_API_KEY_REF)) return 'new:key'
  if (stringField(formValue, FIELD_AUTH_IMPORT_PATH)) return 'new:codex'
  if (stringField(formValue, FIELD_AUTH_REF)) return 'new:codex'
  if (stringField(formValue, FIELD_ENDPOINT_NAME)) return 'new:codex'
  return defaultEndpointChoice(endpoints)
}

function normalizeEndpointKind(
  rawKind: string | undefined,
  formValue: Record<string, unknown>,
): string {
  if (rawKind) return rawKind
  if (stringField(formValue, FIELD_API_KEY_REF)) return 'api-key'
  return 'codex'
}

function parseVisualCodexAuthRef(
  userId: string,
  value: string | undefined,
  importPath: string | undefined,
): string {
  const rawPath = importPath?.trim()
  if (rawPath && rawPath !== '-') {
    return importVisualCodexAuth(userId, rawPath)
  }
  const raw = value?.trim()
  if (!raw || raw === '-') return parseCodexAuthRef('codex:default')
  if (looksLikePath(raw)) {
    return importVisualCodexAuth(userId, raw)
  }
  return parseCodexAuthRef(raw.startsWith('codex:') ? raw : `codex:${raw}`)
}

function parseVisualCodexAuthRefForUpdate(
  userId: string,
  currentAuthRef: string,
  value: string | undefined,
  importPath: string | undefined,
): string {
  if (importPath || value) {
    return parseVisualCodexAuthRef(userId, value, importPath)
  }
  return parseCodexAuthRef(currentAuthRef)
}

function importVisualCodexAuth(userId: string, fromPath: string): string {
  const imported = importUserCodexAuth({
    canonicalUser: userId,
    name: 'default',
    fromPath,
  })
  process.stderr.write(
    `[visual-ui] imported codex auth user=${userId} name=${imported.name} fromPath=${fromPath}\n`,
  )
  return imported.name
}

function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.endsWith('.json')
}

function resolveEndpointFromChoice(
  userId: string,
  current: UserConfigOverride,
  rawChoice: string | undefined,
  formValue: Record<string, unknown>,
): { name: string; endpoint: UserEndpointOverride; created: boolean } {
  const choice = rawChoice ?? 'new:codex'
  if (choice.startsWith('existing:')) {
    const name = choice.slice('existing:'.length)
    const endpoint = current.endpoints?.[name]
    if (!endpoint) {
      throw new Error(`endpoint "${name}" does not exist for this user.`)
    }
    return { name, endpoint, created: false }
  }

  const endpointName = requiredAlias('endpoint alias', stringField(formValue, FIELD_ENDPOINT_NAME))
  if (current.endpoints?.[endpointName]) {
    throw new Error(`custom endpoint "${endpointName}" already exists. Select it from the existing endpoint list instead.`)
  }
  const endpointCommon = optionalEndpointFields(formValue)

  if (choice === 'new:key') {
    const secretName = validateSecretName(requiredText('apiKeyRef', stringField(formValue, FIELD_API_KEY_REF)))
    if (!loadUserSecrets(userId)[secretName]) {
      throw new Error(`apiKeyRef "${secretName}" is not stored. Use /secret set ${secretName} <VALUE> first.`)
    }
    return {
      name: endpointName,
      endpoint: { ...endpointCommon, apiKeyRef: secretName },
      created: true,
    }
  }

  if (choice === 'new:codex') {
    const authName = parseVisualCodexAuthRef(
      userId,
      stringField(formValue, FIELD_AUTH_REF),
      stringField(formValue, FIELD_AUTH_IMPORT_PATH),
    )
    if (!readUserCodexAuth(userId, authName)) {
      throw new Error(`authRef codex:${authName} is not stored. Use /auth codex import --from <path> --name ${authName} first.`)
    }
    return {
      name: endpointName,
      endpoint: { ...endpointCommon, authRef: `codex:${authName}` },
      created: true,
    }
  }

  throw new Error('请选择一个已有 endpoint，或者选择新建 Codex/API Key endpoint。')
}

function optionalEndpointFields(
  formValue: Record<string, unknown>,
): Pick<UserEndpointOverride, 'baseUrl' | 'proxy'> {
  const baseUrl = stringField(formValue, FIELD_BASE_URL)
  const proxy = stringField(formValue, FIELD_PROXY)
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(proxy ? { proxy: normalizeProxyUrl(proxy) } : {}),
  }
}

function endpointFieldsForUpdate(
  formValue: Record<string, unknown>,
  current: UserEndpointOverride,
): Pick<UserEndpointOverride, 'baseUrl' | 'proxy'> {
  const baseUrl = stringField(formValue, FIELD_BASE_URL)
  const proxy = stringField(formValue, FIELD_PROXY)
  const next: Pick<UserEndpointOverride, 'baseUrl' | 'proxy'> = {}
  if (baseUrl === '-') {
    // Explicit clear.
  } else if (baseUrl !== undefined) {
    next.baseUrl = baseUrl
  } else if (current.baseUrl) {
    next.baseUrl = current.baseUrl
  }

  if (proxy === '-') {
    // Explicit clear.
  } else if (proxy !== undefined) {
    next.proxy = normalizeProxyUrl(proxy)
  } else if (current.proxy) {
    next.proxy = current.proxy
  }
  return next
}

function defaultEndpointChoice(endpoints: NonNullable<UserConfigOverride['endpoints']>): string {
  const first = Object.keys(endpoints).sort()[0]
  return first ? `existing:${first}` : 'new:codex'
}

function assertSchemaMatchesEndpoint(schema: Schema, endpoint: UserEndpointOverride): void {
  const isAuthEndpoint = Boolean(endpoint.authRef)
  if (schema === 'openai-auth' && !isAuthEndpoint) {
    throw new Error('schema=openai-auth requires a Codex auth endpoint. Select or create an authRef endpoint.')
  }
  if (schema !== 'openai-auth' && isAuthEndpoint) {
    throw new Error(`schema=${schema} requires an API-key endpoint. Select or create an apiKeyRef endpoint.`)
  }
}

async function defaultCheckModel(input: {
  userId: string
  sessionId: string
  modelName: string
}): Promise<string> {
  const output: string[] = []
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      output.push(String(chunk))
      callback()
    },
  })
  const config = resolveUserConfig(input.userId, getConfig())
  const sessionCtx = createSessionContext({
    config,
    sessionId: input.sessionId,
    currentUserId: input.userId,
    channel: 'feishu',
    cwd: workspaceFor(input.userId),
    model: input.modelName,
    sessionsDir: userSessionsRoot(input.userId),
    memoryDir: getMemoryDir(input.userId, config),
    permissionMode: config.permissionMode,
    permissionCeiling: config.permissionMode,
  })
  const ctx: ReplContext = {
    config,
    sessionId: input.sessionId,
    createdAt: Date.now(),
    messages: [],
    output: writable,
    userId: input.userId,
    isAdmin: false,
    isChannel: true,
    getActiveTools: () => [],
    setActiveTools() {},
    async persistMeta() {},
  }
  const returned = await runWithSessionContext(sessionCtx, () =>
    runModelCustomCommand(`check ${input.modelName}`, ctx)
  )
  return (output.join('') || returned).trim()
}

function buildHomeCard(id: string, userId: string): Record<string, unknown> {
  const config = resolveUserConfig(userId, getConfig())
  const endpoints = Object.keys(config.endpoints)
  const models = Object.keys(config.models)
  const current = config.defaultModel || '(none)'
  const mounts = loadUserRlaunchMounts(userId)
  const dataRoot = userDataRoot(userId)
  const lines = [
    `**${escapeLarkMd(userId)}**  ·  模型 ${models.length}  ·  endpoint ${endpoints.length}  ·  mount ${mounts.length}`,
    `当前模型：${escapeLarkMd(current)}`,
    `用户数据目录：${escapeLarkMd(compactPath(dataRoot ?? userHome(userId)))}${dataRoot ? '（自定义）' : '（默认）'}`,
    `Workspace：${escapeLarkMd(compactPath(workspaceFor(userId)))}`,
  ]
  return card({
    title: 'LightClaw 控制台',
    template: 'blue',
    elements: [
      markdown(lines.join('\n')),
      buttonGrid([
        navButton('模型设置向导', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'model_home' }),
        navButton('Endpoint 管理', 'default', { kind: 'lightclaw_visual_setup', id, action: 'endpoint_home' }),
        navButton('凭据管理', 'default', { kind: 'lightclaw_visual_setup', id, action: 'auth_home' }),
        navButton('目录管理', 'default', { kind: 'lightclaw_visual_setup', id, action: 'directory_home' }),
        navButton('Skill 管理', 'default', { kind: 'lightclaw_visual_setup', id, action: 'skill_home' }),
        navButton('Task / Background', 'default', { kind: 'lightclaw_visual_setup', id, action: 'task_home' }),
        navButton('Admin 审批', 'default', { kind: 'lightclaw_visual_setup', id, action: 'admin_home' }),
      ]),
    ],
  })
}

function buildModelHomeCard(id: string, userId: string): Record<string, unknown> {
  const config = resolveUserConfig(userId, getConfig())
  const modelRows = Object.entries(config.models)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, model]) => [
      `${name}${name === config.defaultModel ? '（默认）' : ''}`,
      model.schema,
      truncateText(model.upstreamModel, 34),
      model.endpoint,
      formatModelRequestParamsForCard(model.requestParams),
    ])
  return card({
    title: '模型管理',
    template: 'wathet',
    elements: [
      markdown([
        `**当前默认模型**：${escapeLarkMd(config.defaultModel || '(none)')}`,
      ].join('\n')),
      ...tableRows(
        ['模型', 'schema', 'upstream', 'endpoint', 'params'],
        modelRows,
        '当前用户还没有模型配置。',
      ),
      buttonGrid([
        navButton('添加模型', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'setup_model' }),
        navButton('修改模型', 'default', { kind: 'lightclaw_visual_setup', id, action: 'model_edit' }),
        navButton('设为默认', 'default', { kind: 'lightclaw_visual_setup', id, action: 'model_set_default' }),
        navButton('检查模型', 'default', { kind: 'lightclaw_visual_setup', id, action: 'model_check' }),
        navButton('删除模型', 'default', { kind: 'lightclaw_visual_setup', id, action: 'model_delete' }),
        navButton('参数帮助', 'default', { kind: 'lightclaw_visual_setup', id, action: 'model_param_help' }),
        navButton('返回首页', 'default', { kind: 'lightclaw_visual_setup', id, action: 'home' }),
      ]),
    ],
  })
}

function buildModelEditCard(
  id: string,
  userId: string,
  paramRows = DEFAULT_PARAM_ROWS,
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const loaded = loadUserConfigOverride(userId)
  const modelOptions = modelSelectOptions(loaded.ok ? loaded.value : {})
  const endpointOptions = endpointSelectOptions(loaded.ok ? loaded.value : {})
  return card({
    title: '修改模型',
    template: 'wathet',
    elements: [
      markdown('选择一个已有模型，重新填写 endpoint/schema/upstreamModel 等配置。保存后会后台检查连通性。'),
      {
        tag: 'form',
        name: 'visual_model_edit_form',
        elements: [
          select(FIELD_MODEL_TARGET, '模型', modelOptions, '选择模型'),
          select(FIELD_ENDPOINT_CHOICE, 'Endpoint', endpointOptions, '选择已有 endpoint'),
          select(FIELD_SCHEMA, 'schema', [
            { text: 'openai-auth (Codex OAuth)', value: 'openai-auth' },
            { text: 'openai', value: 'openai' },
            { text: 'anthropic', value: 'anthropic' },
          ], '留空时按 endpoint 类型自动选择'),
          input(FIELD_UPSTREAM_MODEL, 'upstreamModel', '真实模型 ID，例如 gpt-5.5 / claude-sonnet-4-6', stringField(defaults, FIELD_UPSTREAM_MODEL)),
          markdown('常用专用参数也在下面填写：`reasoningEffort=high`、`maxOutputTokens=64000`。'),
          input(FIELD_REQUEST_PARAMS, '自由文本参数', '可选；每行或分号分隔 key=value；JSON object 也可以；填 - 清空', stringField(defaults, FIELD_REQUEST_PARAMS)),
          ...modelParamRowElements(id, 'edit', paramRows, defaults),
          select(FIELD_SET_DEFAULT, '设为默认模型', [
            { text: '否', value: 'no' },
            { text: '是', value: 'yes' },
          ], '默认：否'),
          buttonRow([
            submitButton('保存并检查', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'submit_model_edit' }),
            formNavButton('参数帮助', 'default', { kind: 'lightclaw_visual_setup', id, action: 'model_param_help' }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'model_home' }),
          ]),
        ],
      },
    ],
  })
}

function buildModelSetDefaultCard(id: string, userId: string): Record<string, unknown> {
  return buildModelSelectionActionCard({
    id,
    userId,
    title: '设置默认模型',
    template: 'wathet',
    description: '选择当前用户后续对话默认使用的模型。',
    submitLabel: '设为默认',
    submitAction: 'submit_model_set_default',
  })
}

function buildModelCheckCard(id: string, userId: string): Record<string, unknown> {
  return buildModelSelectionActionCard({
    id,
    userId,
    title: '检查模型',
    template: 'wathet',
    description: '选择模型后会后台执行一次轻量连通性检查。',
    submitLabel: '开始检查',
    submitAction: 'submit_model_check',
  })
}

function buildModelDeleteCard(id: string, userId: string): Record<string, unknown> {
  return buildModelSelectionActionCard({
    id,
    userId,
    title: '删除模型',
    template: 'orange',
    description: '删除只会移除当前用户的模型配置，不会删除 endpoint、secret 或 Codex auth。',
    submitLabel: '删除',
    submitAction: 'submit_model_delete',
  })
}

function buildModelParamHelpCard(id: string): Record<string, unknown> {
  return card({
    title: '模型参数帮助',
    template: 'wathet',
    elements: [
      markdown(formatModelRequestParamHelp()),
      buttonGrid([
        navButton('返回模型管理', 'default', { kind: 'lightclaw_visual_setup', id, action: 'model_home' }),
        navButton('添加模型', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'setup_model' }),
      ]),
    ],
  })
}

function buildModelCardWithParamRows(
  id: string,
  userId: string,
  mode: ModelParamMode,
  paramRows: number,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  switch (mode) {
    case 'setup_existing':
      return buildModelSetupExistingCard(id, userId, paramRows, defaults)
    case 'setup_new_codex':
      return buildModelSetupNewEndpointCard(id, userId, 'codex', paramRows, defaults)
    case 'setup_new_key':
      return buildModelSetupNewEndpointCard(id, userId, 'api-key', paramRows, defaults)
    case 'edit':
      return buildModelEditCard(id, userId, paramRows, defaults)
  }
}

function buildModelSelectionActionCard(input: {
  id: string
  userId: string
  title: string
  template: 'blue' | 'wathet' | 'green' | 'orange' | 'red' | 'grey'
  description: string
  submitLabel: string
  submitAction: VisualSetupCardAction['action']
}): Record<string, unknown> {
  const loaded = loadUserConfigOverride(input.userId)
  const options = modelSelectOptions(loaded.ok ? loaded.value : {})
  return card({
    title: input.title,
    template: input.template,
    elements: [
      markdown(input.description),
      {
        tag: 'form',
        name: 'visual_model_action_form',
        elements: [
          select(FIELD_MODEL_TARGET, '模型', options, '选择模型'),
          buttonRow([
            submitButton(input.submitLabel, 'primary', {
              kind: 'lightclaw_visual_setup',
              id: input.id,
              action: input.submitAction,
            }),
            formNavButton('返回', 'default', {
              kind: 'lightclaw_visual_setup',
              id: input.id,
              action: 'model_home',
            }),
          ]),
        ],
      },
    ],
  })
}

function buildModelSetupCard(id: string, userId: string): Record<string, unknown> {
  const loaded = loadUserConfigOverride(userId)
  const endpoints = loaded.ok ? loaded.value.endpoints ?? {} : {}
  const endpointRows = endpointTableRows(endpoints)
  const hasEndpoints = endpointRows.length > 0
  return card({
    title: '添加模型',
    template: 'wathet',
    elements: [
      markdown([
        '**先选择 endpoint 来源。**',
        '使用已有 endpoint 时只会展示 endpoint 摘要，不允许在添加模型流程中修改 endpoint 参数。',
        '需要新凭据或新代理时，请选择新建 endpoint。',
        '',
        'API key / Codex token 本体不会写入模型配置；API key 仍使用 secret 引用，Codex 可导入 auth.json 后保存为凭据引用。',
      ].join('\n')),
      ...(loaded.ok
        ? tableRows(['endpoint', '类型', '凭据', 'baseUrl', 'proxy'], endpointRows, '当前还没有 endpoint。')
        : [markdown(`当前用户配置无法读取：${loaded.error}`)]),
      buttonGrid([
        ...(hasEndpoints
          ? [navButton('使用已有 endpoint', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'setup_model_existing' })]
          : []),
        navButton('新建 Codex endpoint', hasEndpoints ? 'default' : 'primary', { kind: 'lightclaw_visual_setup', id, action: 'setup_model_new_codex' }),
        navButton('新建 API-key endpoint', 'default', { kind: 'lightclaw_visual_setup', id, action: 'setup_model_new_key' }),
        navButton('返回模型管理', 'default', { kind: 'lightclaw_visual_setup', id, action: 'model_home' }),
      ]),
    ],
  })
}

function buildModelSetupExistingCard(
  id: string,
  userId: string,
  paramRows = DEFAULT_PARAM_ROWS,
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const loaded = loadUserConfigOverride(userId)
  const endpoints = loaded.ok ? loaded.value.endpoints ?? {} : {}
  return card({
    title: '添加模型 · 使用已有 endpoint',
    template: 'wathet',
    elements: [
      markdown('选择一个已有 endpoint。endpoint 参数只读展示；如果需要改 baseUrl/proxy/凭据，请回到 Endpoint 管理单独修改。'),
      ...(loaded.ok
        ? tableRows(['endpoint', '类型', '凭据', 'baseUrl', 'proxy'], endpointTableRows(endpoints), '当前还没有 endpoint。')
        : [markdown(`当前用户配置无法读取：${loaded.error}`)]),
      {
        tag: 'form',
        name: 'visual_model_existing_endpoint_form',
        elements: [
          select(
            FIELD_ENDPOINT_CHOICE,
            'Endpoint',
            existingEndpointChoiceOptions(loaded.ok ? loaded.value : {}),
            '选择已有 endpoint',
          ),
          ...modelSetupFormElements(id, 'model_home', undefined, {
            paramMode: 'setup_existing',
            paramRows,
            defaults,
          }),
        ],
      },
    ],
  })
}

function buildModelSetupNewEndpointCard(
  id: string,
  userId: string,
  kind: 'codex' | 'api-key',
  paramRows = DEFAULT_PARAM_ROWS,
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const isCodex = kind === 'codex'
  const auths = listUserCodexAuth(userId)
  return card({
    title: isCodex ? '添加模型 · 新建 Codex endpoint' : '添加模型 · 新建 API-key endpoint',
    template: 'wathet',
    elements: [
      markdown(isCodex
        ? '填写新 endpoint 参数和模型参数。可以选择已有 Codex 凭据，也可以直接填写 auth.json 路径导入。'
        : '填写新 endpoint 参数和模型参数。API key 本体请先用 `/secret set` 保存，这里只填写 secret 名称。'),
      ...(isCodex && auths.length > 0
        ? tableRows(
          ['凭据', 'account', 'expires'],
          auths.map(auth => [
            `codex:${auth.name}`,
            truncateText(auth.accountId || '(unknown)', 24),
            new Date(auth.expiresAt).toISOString().slice(0, 19),
          ]),
          '当前还没有 Codex 凭据。',
        )
        : []),
      {
        tag: 'form',
        name: isCodex ? 'visual_model_new_codex_endpoint_form' : 'visual_model_new_key_endpoint_form',
        elements: [
          input(FIELD_ENDPOINT_NAME, '新 endpoint 名称', isCodex ? '例如 codex-default' : '例如 openai-default', stringField(defaults, FIELD_ENDPOINT_NAME)),
          ...(isCodex
            ? [
              input(FIELD_AUTH_REF, '已有凭据引用', '可选，例如 codex:default 或 default', stringField(defaults, FIELD_AUTH_REF)),
              input(FIELD_AUTH_IMPORT_PATH, 'auth.json 导入路径', '可选，例如 /home/geqiming/.codex/auth.json；填写后导入为 codex:default', stringField(defaults, FIELD_AUTH_IMPORT_PATH)),
            ]
            : [
              input(FIELD_API_KEY_REF, 'apiKeyRef', '例如 OPENAI_KEY；先用 /secret set 保存', stringField(defaults, FIELD_API_KEY_REF)),
            ]),
          input(FIELD_BASE_URL, 'baseUrl', '可选，例如 https://api.openai.com/v1', stringField(defaults, FIELD_BASE_URL)),
          input(FIELD_PROXY, 'proxy', '可选，例如 http://100.103.165.100:1091', stringField(defaults, FIELD_PROXY)),
          markdown('---'),
          ...modelSetupFormElements(id, 'model_home', isCodex ? 'openai-auth' : 'openai', {
            paramMode: isCodex ? 'setup_new_codex' : 'setup_new_key',
            paramRows,
            defaults,
          }),
        ],
      },
    ],
  })
}

function buildEndpointHomeCard(id: string, userId: string): Record<string, unknown> {
  const loaded = loadUserConfigOverride(userId)
  const endpoints = loaded.ok ? Object.entries(loaded.value.endpoints ?? {}) : []
  const rows = loaded.ok
    ? endpoints
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, endpoint]) => [
        name,
        endpoint.authRef ? 'Codex' : 'API key',
        endpoint.authRef ?? endpoint.apiKeyRef ?? '?',
        endpoint.proxy ? compactUrl(endpoint.proxy) : '-',
      ])
    : []
  return card({
    title: 'Endpoint 管理',
    template: 'blue',
    elements: [
      ...(loaded.ok
        ? tableRows(['名称', '类型', '凭据引用', 'proxy'], rows, '当前用户还没有 endpoint。')
        : [markdown(`当前用户配置无法读取：${loaded.error}`)]),
      buttonGrid([
        navButton('新增 endpoint', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'endpoint_add' }),
        navButton('更新 endpoint', 'default', { kind: 'lightclaw_visual_setup', id, action: 'endpoint_update' }),
        navButton('删除 endpoint', 'default', { kind: 'lightclaw_visual_setup', id, action: 'endpoint_delete' }),
        navButton('返回首页', 'default', { kind: 'lightclaw_visual_setup', id, action: 'home' }),
      ]),
    ],
  })
}

function buildEndpointAddCard(id: string): Record<string, unknown> {
  return card({
    title: '新增 Endpoint',
    template: 'wathet',
    elements: [
      markdown([
        '新增 endpoint 需要填写 endpoint 名称和凭据引用。',
        'API key 本体仍用 `/secret set` 保存；Codex 凭据可先导入，也可在这里填写 auth.json 路径导入。',
      ].join('\n')),
      {
        tag: 'form',
        name: 'visual_endpoint_add_form',
        elements: [
          input(FIELD_ENDPOINT_NAME, 'endpoint 名称', '例如 codex-default / openai-default'),
          select(FIELD_ENDPOINT_KIND, '凭据类型', [
            { text: 'Codex auth', value: 'codex' },
            { text: 'API key', value: 'api-key' },
          ], '默认：Codex auth'),
          input(FIELD_AUTH_REF, '已有 Codex auth 引用', '可选，例如 codex:default 或 default'),
          input(FIELD_AUTH_IMPORT_PATH, 'Codex auth.json 导入路径', '可选，例如 /home/geqiming/.codex/auth.json；填写后会导入为 codex:default'),
          input(FIELD_API_KEY_REF, 'apiKeyRef', 'API key endpoint 才需要；先用 /secret set 保存'),
          input(FIELD_BASE_URL, 'baseUrl', '可选，例如 https://api.openai.com/v1'),
          input(FIELD_PROXY, 'proxy', '可选，例如 http://100.103.165.100:1091'),
          buttonRow([
            submitButton('新增 endpoint', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'submit_endpoint_add' }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'endpoint_home' }),
          ]),
        ],
      },
    ],
  })
}

function buildEndpointUpdateSelectCard(id: string, userId: string): Record<string, unknown> {
  const loaded = loadUserConfigOverride(userId)
  const options = loaded.ok ? endpointSelectOptions(loaded.value) : [{ text: '当前用户配置无法读取', value: '-' }]
  return card({
    title: '选择要更新的 Endpoint',
    template: 'wathet',
    elements: [
      markdown('先选择一个已有 endpoint，再进入编辑页加载当前参数。'),
      {
        tag: 'form',
        name: 'visual_endpoint_update_select_form',
        elements: [
          select(FIELD_ENDPOINT_TARGET, 'endpoint', options, '选择 endpoint'),
          buttonRow([
            submitButton('加载编辑表单', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'endpoint_update_edit' }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'endpoint_home' }),
          ]),
        ],
      },
    ],
  })
}

function buildEndpointUpdateCard(
  id: string,
  userId: string,
  endpointName: string,
): Record<string, unknown> {
  const loaded = loadUserConfigOverride(userId)
  if (!loaded.ok) {
    return buildFinalCard('Endpoint 读取失败', loaded.error, 'red')
  }
  const endpoint = loaded.value.endpoints?.[endpointName]
  if (!endpoint) {
    return buildFinalCard('Endpoint 不存在', `endpoint "${endpointName}" does not exist.`, 'red')
  }
  const isCodex = Boolean(endpoint.authRef)
  return card({
    title: `更新 Endpoint · ${endpointName}`,
    template: 'wathet',
    elements: [
      markdown([
        `endpoint：${escapeLarkMd(endpointName)}`,
        `类型：${isCodex ? 'Codex auth' : 'API key'}`,
        '名称和类型固定；空字段表示保留原值，baseUrl/proxy 填 `-` 表示清空。',
      ].join('\n')),
      {
        tag: 'form',
        name: 'visual_endpoint_update_form',
        elements: [
          ...(isCodex
            ? [
              input(FIELD_AUTH_REF, 'Codex auth 引用', '例如 codex:default', endpoint.authRef),
              input(FIELD_AUTH_IMPORT_PATH, 'Codex auth.json 导入路径', '可选；填写后会导入为 codex:default'),
            ]
            : [
              input(FIELD_API_KEY_REF, 'apiKeyRef', '例如 OPENAI_KEY', endpoint.apiKeyRef),
            ]),
          input(FIELD_BASE_URL, 'baseUrl', '可选；填 - 清空', endpoint.baseUrl),
          input(FIELD_PROXY, 'proxy', '可选；填 - 清空', endpoint.proxy),
          buttonRow([
            submitButton('更新 endpoint', 'primary', {
              kind: 'lightclaw_visual_setup',
              id,
              action: 'submit_endpoint_update',
              endpointName,
            }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'endpoint_home' }),
          ]),
        ],
      },
    ],
  })
}

function buildEndpointDeleteCard(id: string, userId: string): Record<string, unknown> {
  const loaded = loadUserConfigOverride(userId)
  const names = loaded.ok ? Object.keys(loaded.value.endpoints ?? {}).sort() : []
  const options = names.map(name => ({ text: name, value: name }))
  return card({
    title: '删除 Endpoint',
    template: 'orange',
    elements: [
      markdown('只能删除未被模型引用的 endpoint。'),
      {
        tag: 'form',
        name: 'visual_endpoint_delete_form',
        elements: [
          select(
            FIELD_ENDPOINT_DELETE_NAME,
            'endpoint',
            options.length > 0 ? options : [{ text: '无可删除 endpoint', value: '-' }],
            '选择 endpoint',
          ),
          buttonRow([
            submitButton('删除', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'submit_endpoint_delete' }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'endpoint_home' }),
          ]),
        ],
      },
    ],
  })
}

function buildAuthHomeCard(id: string, userId: string): Record<string, unknown> {
  const auths = listUserCodexAuth(userId)
  const rows = auths.map(auth => [
    'Codex OAuth',
    `codex:${auth.name}`,
    truncateText(auth.accountId || '(unknown)', 24),
    new Date(auth.expiresAt).toISOString().slice(0, 19),
  ])
  return card({
    title: '凭据管理',
    template: 'blue',
    elements: [
      markdown('当前支持 Codex OAuth auth.json 凭据；API key 使用 `/secret set` 保存为 secret 后由 endpoint 引用。'),
      ...tableRows(['类型', '引用', 'account', 'expires'], rows, '当前用户还没有凭据。'),
      buttonGrid([
        navButton('新增 / 更新凭据', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'auth_edit' }),
        navButton('删除凭据', 'default', { kind: 'lightclaw_visual_setup', id, action: 'auth_delete' }),
        navButton('返回首页', 'default', { kind: 'lightclaw_visual_setup', id, action: 'home' }),
      ]),
    ],
  })
}

function buildAuthEditCard(id: string): Record<string, unknown> {
  return card({
    title: '新增 / 更新凭据',
    template: 'wathet',
    elements: [
      markdown('导入 daemon 可读的 Codex `auth.json`。同名凭据会被更新；endpoint 和 model 只保存 `codex:<name>` 引用，不保存 token。'),
      {
        tag: 'form',
        name: 'visual_auth_edit_form',
        elements: [
          input(FIELD_AUTH_NAME, '凭据名称', '默认 default；只能用字母、数字、下划线或短横线'),
          input(FIELD_AUTH_IMPORT_PATH, 'auth.json 导入路径', '/home/geqiming/.codex/auth.json'),
          buttonRow([
            submitButton('保存凭据', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'submit_auth' }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'auth_home' }),
          ]),
        ],
      },
    ],
  })
}

function buildAuthDeleteCard(id: string, userId: string): Record<string, unknown> {
  const auths = listUserCodexAuth(userId)
  const options = auths.map(auth => ({ text: `codex:${auth.name}`, value: auth.name }))
  return card({
    title: '删除凭据',
    template: 'orange',
    elements: [
      markdown('只能删除未被 endpoint 引用的凭据。'),
      {
        tag: 'form',
        name: 'visual_auth_delete_form',
        elements: [
          select(
            FIELD_AUTH_DELETE_NAME,
            '凭据',
            options.length > 0 ? options : [{ text: '无可删除凭据', value: '-' }],
            '选择凭据',
          ),
          buttonRow([
            submitButton('删除', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'submit_auth_delete' }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'auth_home' }),
          ]),
        ],
      },
    ],
  })
}

function buildDirectoryHomeCard(id: string, userId: string): Record<string, unknown> {
  const dataRoot = userDataRoot(userId)
  const dataRootPath = dataRoot ?? userHome(userId)
  const workspace = workspaceFor(userId)
  const workspaceOverride = userWorkspaceOverride(userId)
  const mounts = loadUserRlaunchMounts(userId)
  const mountRows = mounts.map(mount => [
    mount.mode === 'rw' ? '读写' : '只读',
    mount.path,
  ])
  return card({
    title: '目录管理',
    template: 'blue',
    elements: [
      markdown([
        `**用户数据目录（dataRoot）**：${escapeLarkMd(dataRootPath)}${dataRoot ? '（自定义）' : '（默认）'}`,
        `**Workspace**：${escapeLarkMd(workspace)}${workspaceOverride ? '（自定义）' : '（默认）'}`,
        '',
        'dataRoot 保存当前用户的配置、凭据引用、权限、session、memory、skill、task 等持久数据；workspace 是 agent 实际运行目录，可由用户直接修改。',
        '',
        `**rlaunch 挂载**：${mounts.length}`,
      ].join('\n')),
      ...tableRows(['权限', '路径'], mountRows, '当前没有额外挂载目录。'),
      buttonGrid([
        navButton('修改 workspace', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'workspace_edit' }),
        navButton('添加挂载', 'default', { kind: 'lightclaw_visual_setup', id, action: 'mount_add' }),
        navButton('移除挂载', 'default', { kind: 'lightclaw_visual_setup', id, action: 'mount_remove' }),
        navButton('返回首页', 'default', { kind: 'lightclaw_visual_setup', id, action: 'home' }),
      ]),
    ],
  })
}

function buildWorkspaceEditCard(id: string, userId: string): Record<string, unknown> {
  const currentWorkspace = workspaceFor(userId)
  return card({
    title: '修改 Workspace',
    template: 'wathet',
    elements: [
      markdown([
        `当前 workspace：${escapeLarkMd(currentWorkspace)}`,
        '',
        'workspace 必须是 daemon 可见的已存在目录；cluster/rlaunch 后端还需要命中 `runtime.clusterSettings.gpfsMounts` 映射。保存后会直接重启当前用户的 rlaunch worker。',
      ].join('\n')),
      {
        tag: 'form',
        name: 'visual_workspace_form',
        elements: [
          input(FIELD_WORKSPACE, 'Workspace 路径', '/mnt/shared-storage-user/.../workspace', currentWorkspace),
          buttonRow([
            submitButton('保存 workspace', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'submit_workspace' }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'directory_home' }),
          ]),
        ],
      },
    ],
  })
}

function buildDataDirRequestCard(id: string, userId: string): Record<string, unknown> {
  return card({
    title: '申请修改用户数据目录',
    template: 'wathet',
    elements: [
      markdown([
        '用户数据目录必须是 daemon 可见的绝对目录；cluster 后端还需要命中 `runtime.clusterSettings.gpfsMounts` 映射。',
        '提交后会生成 admin 审批请求，审批通过后需要重启 sandbox/rlaunch worker 才能让挂载表完全生效。',
      ].join('\n')),
      {
        tag: 'form',
        name: 'visual_data_dir_form',
        elements: [
          input(FIELD_DATA_DIR, '用户数据目录', `/mnt/shared-storage-user/.../${userId}/lightclaw`),
          buttonRow([
            submitButton('提交申请', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'submit_data_dir_request' }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'directory_home' }),
          ]),
        ],
      },
    ],
  })
}

function buildMountAddCard(id: string): Record<string, unknown> {
  return card({
    title: '添加 rlaunch 挂载',
    template: 'wathet',
    elements: [
      markdown('每行或用空格/逗号填写一个目录；挂载到 worker 内时保持同名路径。'),
      {
        tag: 'form',
        name: 'visual_mount_add_form',
        elements: [
          input(FIELD_MOUNT_PATHS, '目录路径', '/mnt/shared-storage-user/... /mnt/shared-storage-gpfs2/...'),
          select(FIELD_MOUNT_MODE, '权限', [
            { text: '只读', value: 'ro' },
            { text: '读写', value: 'rw' },
          ], '默认：只读'),
          buttonRow([
            submitButton('添加 / 更新', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'submit_mount_add' }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'directory_home' }),
          ]),
        ],
      },
    ],
  })
}

function buildMountRemoveCard(id: string, userId: string): Record<string, unknown> {
  const mounts = loadUserRlaunchMounts(userId)
  const rows = mounts.map((mount, index) => [
    String(index + 1),
    mount.mode === 'rw' ? '读写' : '只读',
    mount.path,
  ])
  const options = mounts.map((mount, index) => ({
    text: `${index + 1}. ${mount.mode === 'rw' ? '读写' : '只读'} ${compactPath(mount.path, 72)}`,
    value: mount.path,
  }))
  return card({
    title: '移除 rlaunch 挂载',
    template: 'orange',
    elements: [
      ...tableRows(['#', '权限', '完整路径'], rows, '当前没有额外挂载目录。'),
      markdown('可以从已有挂载中选择一个；也可以手动填写一个或多个完整路径。'),
      {
        tag: 'form',
        name: 'visual_mount_remove_form',
        elements: [
          select(
            FIELD_MOUNT_SELECTED_PATH,
            '选择已有挂载',
            options.length > 0 ? options : [{ text: '当前没有额外挂载', value: '-' }],
            '可选',
          ),
          input(FIELD_MOUNT_PATHS, '手动输入路径', '可选；批量移除时每行或用空格/逗号填写一个完整路径'),
          buttonRow([
            submitButton('移除', 'primary', { kind: 'lightclaw_visual_setup', id, action: 'submit_mount_remove' }),
            formNavButton('返回', 'default', { kind: 'lightclaw_visual_setup', id, action: 'directory_home' }),
          ]),
        ],
      },
    ],
  })
}

async function buildSkillHomeCard(id: string, userId: string): Promise<Record<string, unknown>> {
  const skills = await discoverSkillsForUser(process.cwd(), userId)
  const userRoot = userSkillsRoot(userId)
  const userSkills = skills.filter(skill => skill.source === 'user')
  const builtinSkills = skills.filter(skill => skill.source === 'builtin')
  const userLines = userSkills
    .slice(0, 8)
    .map(skill => [
      skill.name,
      truncateText(skill.description, 64),
    ])
  const builtinNames = builtinSkills
    .slice(0, 12)
    .map(skill => [skill.name])
  return card({
    title: 'Skill 管理',
    template: 'blue',
    elements: [
      markdown([
        `**用户 skills**：${userSkills.length}  ·  **内置 skills**：${builtinSkills.length}`,
        `目录：${escapeLarkMd(compactPath(userRoot))}`,
      ].join('\n')),
      markdown('**用户自定义**'),
      ...tableRows(['名称', '说明'], userLines, '暂无用户自定义 skill。'),
      markdown('**内置预览**'),
      ...tableRows(['名称'], builtinNames, '暂无内置 skill。'),
      markdown([
        builtinSkills.length > builtinNames.length
          ? `还有 ${builtinSkills.length - builtinNames.length} 个内置 skill，可用 \`/skill list\` 查看完整列表。`
          : '',
        '查看/删除：`/skill list|view|delete`。沉淀新流程：`/skillify`。',
      ].join('\n')),
      buttonGrid([
        navButton('返回首页', 'default', { kind: 'lightclaw_visual_setup', id, action: 'home' }),
      ]),
    ],
  })
}

function buildTaskHomeCard(id: string, session: UiSession): Record<string, unknown> {
  const tasks = loadBackgroundTasks(session.userId)
  const jobs = getBackgroundJobRegistry().listForSession(session.sessionId)
  const taskLines = tasks.slice(0, 10).map(task =>
    [
      truncateText(task.label || task.id, 32),
      task.enabled ? '运行' : '暂停',
      task.role,
    ],
  )
  const jobLines = jobs.slice(0, 10).map(job =>
    [
      truncateText(job.meta.jobId, 32),
      job.status,
    ],
  )
  return card({
    title: 'Task / Background',
    template: 'blue',
    elements: [
      markdown([
        `**后台任务**：${tasks.length}`,
      ].join('\n')),
      ...tableRows(['任务', '状态', 'role'], taskLines, '当前用户没有持久后台任务。'),
      markdown(`**当前会话后台 Bash job**：${jobs.length}`),
      ...tableRows(['job', '状态'], jobLines, '当前会话没有后台 Bash job。'),
      markdown([
        '详细状态仍可用 `/status`，任务调整继续通过 TaskUpdate/相关工具完成。',
      ].join('\n')),
      buttonGrid([
        navButton('返回首页', 'default', { kind: 'lightclaw_visual_setup', id, action: 'home' }),
      ]),
    ],
  })
}

async function buildAdminHomeCard(id: string, userId: string): Promise<Record<string, unknown>> {
  if (!(await isAdmin(userId))) {
    return card({
      title: 'Admin 审批',
      template: 'grey',
      elements: [
        markdown('当前用户不是 admin。目录变更等系统级审批需要 admin 处理。'),
        buttonGrid([
          navButton('返回首页', 'default', { kind: 'lightclaw_visual_setup', id, action: 'home' }),
        ]),
      ],
    })
  }
  const requests = await listDataRootRequests()
  const rows = requests.map(request => [
    request.canonicalUser,
    compactPath(request.normalizedPath),
    request.updatedAt.slice(0, 19),
  ])
  return card({
    title: 'Admin 审批',
    template: 'blue',
    elements: [
      ...tableRows(['用户', '用户数据目录', 'updated'], rows, '当前没有待审批的用户数据目录请求。'),
      markdown('审批：`/user approve-home <name>` 或 `/user reject-home <name>`'),
      buttonGrid([
        navButton('返回首页', 'default', { kind: 'lightclaw_visual_setup', id, action: 'home' }),
      ]),
    ],
  })
}

function buildSavedCard(saved: SubmitResult): Record<string, unknown> {
  const lines = [
    '**配置已保存。**',
    '',
    `- endpoint：${escapeLarkMd(saved.endpointName)}${saved.endpointCreated ? '（新建）' : '（已有）'}`,
    `- model：${escapeLarkMd(saved.modelName)}`,
    '',
    '正在后台检查模型连通性，稍后会发送结果卡片。',
  ]
  return card({
    title: '模型配置已保存',
    template: 'green',
    elements: [markdown(lines.join('\n'))],
  })
}

function buildEndpointSavedCard(id: string, saved: EndpointSaveResult): Record<string, unknown> {
  return buildFinalWithHomeCard(
    id,
    'Endpoint 已保存',
    `endpoint：${saved.endpointName}\n状态：${saved.action === 'created' ? '新建' : '更新'}`,
    'green',
    'endpoint_home',
    '返回 endpoint 管理',
  )
}

function buildAuthSavedCard(id: string, saved: AuthSaveResult): Record<string, unknown> {
  return buildFinalWithHomeCard(
    id,
    '凭据已保存',
    `凭据：codex:${saved.authName}\n状态：${saved.action === 'created' ? '新建' : '更新'}`,
    'green',
    'auth_home',
    '返回凭据管理',
  )
}

function buildFinalWithHomeCard(
  id: string,
  title: string,
  body: string,
  template: 'green' | 'orange' | 'red' | 'grey',
  action: VisualSetupCardAction['action'],
  label: string,
): Record<string, unknown> {
  return card({
    title,
    template,
    elements: [
      markdown(escapeLarkMd(body)),
      buttonGrid([
        navButton(label, 'default', { kind: 'lightclaw_visual_setup', id, action }),
        navButton('返回首页', 'default', { kind: 'lightclaw_visual_setup', id, action: 'home' }),
      ]),
    ],
  })
}

function buildCommandResultCard(
  id: string,
  title: string,
  output: string,
  backAction: VisualSetupCardAction['action'],
): Record<string, unknown> {
  return card({
    title,
    template: 'green',
    elements: [
      markdown([
        '```',
        escapeCodeFence(output).slice(0, 1800),
        '```',
      ].join('\n')),
      buttonGrid([
        navButton('返回目录管理', 'default', { kind: 'lightclaw_visual_setup', id, action: backAction }),
        navButton('返回首页', 'default', { kind: 'lightclaw_visual_setup', id, action: 'home' }),
      ]),
    ],
  })
}

function buildCheckResultCard(modelName: string, result: string): Record<string, unknown> {
  const ok = /Model check:\s*ok/i.test(result)
  return card({
    title: ok ? '模型检查通过' : '模型检查失败',
    template: ok ? 'green' : 'orange',
    elements: [markdown([
      `**模型**：${escapeLarkMd(modelName)}`,
      '',
      '```',
      escapeCodeFence(result).slice(0, 1800),
      '```',
    ].join('\n'))],
  })
}

function buildFinalCard(
  title: string,
  body: string,
  template: 'green' | 'orange' | 'red' | 'grey',
): Record<string, unknown> {
  return card({
    title,
    template,
    elements: [markdown(escapeLarkMd(body))],
  })
}

function card(input: {
  title: string
  template: 'blue' | 'wathet' | 'green' | 'orange' | 'red' | 'grey'
  elements: Record<string, unknown>[]
}): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: input.template,
      title: { tag: 'plain_text', content: input.title },
    },
    body: { elements: input.elements },
  }
}

function markdown(content: string): Record<string, unknown> {
  return { tag: 'markdown', content }
}

function input(
  name: string,
  label: string,
  placeholder: string,
  defaultValue?: string,
): Record<string, unknown> {
  return {
    tag: 'input',
    name,
    label: { tag: 'plain_text', content: label },
    input_type: 'text',
    placeholder: { tag: 'plain_text', content: placeholder },
    ...(defaultValue ? { default_value: defaultValue } : {}),
  }
}

function select(
  name: string,
  label: string,
  options: Array<{ text: string; value: string }>,
  placeholder: string,
): Record<string, unknown> {
  return {
    tag: 'select_static',
    name,
    // Feishu V2 rejects `label` on select_static with 200621:
    // unknown property, path ... tag: select_static. Keep the label in the
    // placeholder instead; input components can still use their label field.
    placeholder: { tag: 'plain_text', content: `${label}：${placeholder}` },
    options: options.map(option => ({
      text: { tag: 'plain_text', content: option.text },
      value: option.value,
    })),
  }
}

function tableRows(
  headers: string[],
  rows: string[][],
  emptyText: string,
): Record<string, unknown>[] {
  if (rows.length === 0) {
    return [markdown(emptyText)]
  }
  const normalizedRows = rows.map(row => headers.map((_, index) => row[index] ?? ''))
  return [
    tableRow(headers, true),
    ...normalizedRows.map(row => tableRow(row, false)),
  ]
}

function tableRow(cells: string[], header: boolean): Record<string, unknown> {
  return {
    tag: 'column_set',
    columns: cells.map(cell => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [markdown(header ? `**${escapeLarkMd(cell)}**` : escapeLarkMd(cell))],
    })),
  }
}

function buttonGrid(buttons: Record<string, unknown>[]): Record<string, unknown> {
  const left: Record<string, unknown>[] = []
  const right: Record<string, unknown>[] = []
  buttons.forEach((button, index) => {
    ;(index % 2 === 0 ? left : right).push(button)
  })
  return {
    tag: 'column_set',
    columns: [
      { tag: 'column', width: 'auto', elements: left },
      ...(right.length > 0
        ? [{ tag: 'column', width: 'auto', elements: right }]
        : []),
    ],
  }
}

function buttonRow(buttons: Record<string, unknown>[]): Record<string, unknown> {
  return {
    tag: 'column_set',
    columns: buttons.map(item => ({
      tag: 'column',
      width: 'auto',
      elements: [item],
    })),
  }
}

function navButton(
  text: string,
  type: 'default' | 'primary',
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: 'button',
    name: buttonName(value, text),
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }],
  }
}

function formNavButton(
  text: string,
  type: 'default' | 'primary',
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...navButton(text, type, value),
    form_action_type: 'submit',
  }
}

function submitButton(
  text: string,
  type: 'default' | 'primary',
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    tag: 'button',
    name: buttonName(value, text),
    text: { tag: 'plain_text', content: text },
    type,
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value }],
  }
}

function buttonName(value: Record<string, unknown>, fallback: string): string {
  const action = typeof value.action === 'string' ? value.action : fallback
  return `visual_${action.replace(/[^A-Za-z0-9_]/g, '_')}`.slice(0, 64)
}

function modelSetupFormElements(
  id: string,
  backAction: VisualSetupCardAction['action'],
  recommendedSchema?: Schema,
  options: {
    paramMode?: ModelParamMode
    paramRows?: number
    defaults?: Record<string, unknown>
  } = {},
): Record<string, unknown>[] {
  const defaults = options.defaults ?? {}
  const paramMode = options.paramMode ?? 'setup_existing'
  const paramRows = options.paramRows ?? DEFAULT_PARAM_ROWS
  const schemaPlaceholder = recommendedSchema
    ? `推荐：${recommendedSchema}；留空时按 endpoint 类型自动选择`
    : '留空时按 endpoint 类型自动选择'
  return [
    input(FIELD_MODEL_ALIAS, '模型显示名', '例如 gpt-codex-high', stringField(defaults, FIELD_MODEL_ALIAS)),
    select(FIELD_SCHEMA, 'schema', [
      { text: 'openai-auth (Codex OAuth)', value: 'openai-auth' },
      { text: 'openai', value: 'openai' },
      { text: 'anthropic', value: 'anthropic' },
    ], schemaPlaceholder),
    input(FIELD_UPSTREAM_MODEL, 'upstreamModel', '真实模型 ID，例如 gpt-5.5 / claude-sonnet-4-6', stringField(defaults, FIELD_UPSTREAM_MODEL)),
    markdown('常用专用参数也在下面填写：`reasoningEffort=high`、`maxOutputTokens=64000`。'),
    input(FIELD_REQUEST_PARAMS, '自由文本参数', '可选；每行或分号分隔 key=value；JSON object 也可以', stringField(defaults, FIELD_REQUEST_PARAMS)),
    ...modelParamRowElements(id, paramMode, paramRows, defaults),
    select(FIELD_SET_DEFAULT, '设为默认模型', [
      { text: '是', value: 'yes' },
      { text: '否', value: 'no' },
    ], '默认：是'),
    buttonRow([
      submitButton('保存并检查', 'primary', {
        kind: 'lightclaw_visual_setup',
        id,
        action: 'submit_model',
      }),
      formNavButton('参数帮助', 'default', {
        kind: 'lightclaw_visual_setup',
        id,
        action: 'model_param_help',
      }),
      formNavButton('返回', 'default', {
        kind: 'lightclaw_visual_setup',
        id,
        action: backAction,
      }),
      formNavButton('取消', 'default', {
        kind: 'lightclaw_visual_setup',
        id,
        action: 'cancel',
      }),
    ]),
  ]
}

function modelParamRowElements(
  id: string,
  mode: ModelParamMode,
  rows: number,
  defaults: Record<string, unknown>,
): Record<string, unknown>[] {
  const count = clampParamRows(rows)
  const elements: Record<string, unknown>[] = [
    markdown('参数行会与上面的自由文本参数合并；重复 key 时参数行覆盖同名文本参数。常用 key：`reasoningEffort`、`maxOutputTokens`、`temperature`、`top_p`。'),
  ]
  for (let index = 1; index <= count; index += 1) {
    const keyName = paramKeyField(index)
    const valueName = paramValueField(index)
    elements.push(paramInputRow(
      keyName,
      valueName,
      `key ${index}`,
      `value ${index}`,
      stringField(defaults, keyName),
      stringField(defaults, valueName),
    ))
  }
  if (count < MAX_PARAM_ROWS) {
    elements.push(formNavButton('添加参数行', 'default', {
      kind: 'lightclaw_visual_setup',
      id,
      action: 'model_param_add_row',
      paramMode: mode,
      paramRows: count + 1,
    }))
  }
  return elements
}

function paramInputRow(
  keyName: string,
  valueName: string,
  keyLabel: string,
  valueLabel: string,
  keyDefault?: string,
  valueDefault?: string,
): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'stretch',
    background_style: 'default',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [
          input(keyName, keyLabel, 'reasoningEffort / maxOutputTokens / temperature', keyDefault),
        ],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [
          input(valueName, valueLabel, 'high / 64000 / 0.2 / {"type":"json_object"}', valueDefault),
        ],
      },
    ],
  }
}

function endpointTableRows(endpoints: NonNullable<UserConfigOverride['endpoints']>): string[][] {
  return Object.entries(endpoints)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, endpoint]) => [
      name,
      endpoint.authRef ? 'Codex' : 'API key',
      endpoint.authRef ?? endpoint.apiKeyRef ?? '?',
      endpoint.baseUrl ? compactUrl(endpoint.baseUrl, 42) : '-',
      endpoint.proxy ? compactUrl(endpoint.proxy) : '-',
    ])
}

function existingEndpointChoiceOptions(config: UserConfigOverride): Array<{ text: string; value: string }> {
  const endpoints = Object.entries(config.endpoints ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return endpoints.length > 0
    ? endpoints.map(([name, endpoint]) => ({
      text: `${name} (${endpoint.authRef ? endpoint.authRef : `apiKeyRef=${endpoint.apiKeyRef ?? '?'}`})`,
      value: `existing:${name}`,
    }))
    : [{ text: '当前没有 endpoint', value: '-' }]
}

function formatEndpointLine(name: string, endpoint: UserEndpointOverride): string {
  const credential = endpoint.authRef
    ? `authRef=${endpoint.authRef}`
    : `apiKeyRef=${endpoint.apiKeyRef ?? '?'}`
  return [
    `- ${escapeLarkMd(name)} (${escapeLarkMd(credential)})`,
    endpoint.baseUrl ? `  baseUrl=${escapeLarkMd(endpoint.baseUrl)}` : '',
    endpoint.proxy ? `  proxy=${escapeLarkMd(endpoint.proxy)}` : '',
  ].filter(Boolean).join('\n')
}

function formatSkillPreview(name: string, description: string, source: 'builtin' | 'user'): string {
  const badge = source === 'user' ? '用户' : '内置'
  return `- **${escapeLarkMd(name)}** · ${badge}\n  ${escapeLarkMd(truncateText(description, 86))}`
}

function compactPath(input: string, maxLen = 64): string {
  if (input.length <= maxLen) return input
  const parts = input.split('/').filter(Boolean)
  if (parts.length <= 2) return truncateText(input, maxLen)
  const tail = parts.slice(-3).join('/')
  const prefix = input.startsWith('/') ? '/' : ''
  const compact = `${prefix}.../${tail}`
  return compact.length <= maxLen ? compact : truncateText(input, maxLen)
}

function compactUrl(input: string, maxLen = 36): string {
  try {
    const parsed = new URL(input)
    const host = parsed.host
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''
    return truncateText(`${parsed.protocol}//${host}${path}`, maxLen)
  } catch {
    return truncateText(input, maxLen)
  }
}

function truncateText(input: string, maxLen: number): string {
  const text = input.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLen) return text
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`
}

function modelSelectOptions(config: UserConfigOverride): Array<{ text: string; value: string }> {
  const names = Object.keys(config.models ?? {}).sort()
  return names.length > 0
    ? names.map(name => ({ text: name, value: name }))
    : [{ text: '当前没有模型', value: '-' }]
}

function endpointSelectOptions(config: UserConfigOverride): Array<{ text: string; value: string }> {
  const endpoints = Object.entries(config.endpoints ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return endpoints.length > 0
    ? endpoints.map(([name, endpoint]) => ({
      text: `${name} (${endpoint.authRef ? endpoint.authRef : `apiKeyRef=${endpoint.apiKeyRef ?? '?'}`})`,
      value: name,
    }))
    : [{ text: '当前没有 endpoint', value: '-' }]
}

function rawCard(card: Record<string, unknown>): { type: 'raw'; data: Record<string, unknown> } {
  return { type: 'raw', data: card }
}

function openCard(card: Record<string, unknown>): FeishuCardActionResponse {
  return {
    toast: { type: 'info', content: '已打开' },
    card: rawCard(card),
  }
}

function shouldPatchNavigationAction(action: VisualSetupCardAction['action']): boolean {
  return !action.startsWith('submit_')
}

function responseCardDataForLog(response: FeishuCardActionResponse): Record<string, unknown> | null {
  const card = response.card
  if (!card || typeof card !== 'object') return null
  const record = card as Record<string, unknown>
  if (record.type !== 'raw' || !record.data || typeof record.data !== 'object') return null
  return record.data as Record<string, unknown>
}

function responseToastType(response: FeishuCardActionResponse): string {
  const toast = response.toast
  if (!toast || typeof toast !== 'object') return '-'
  const type = (toast as Record<string, unknown>).type
  return typeof type === 'string' ? type : '-'
}

function visualCardTitle(card: Record<string, unknown>): string | undefined {
  const header = card.header
  if (!header || typeof header !== 'object') return undefined
  const title = (header as Record<string, unknown>).title
  if (!title || typeof title !== 'object') return undefined
  const content = (title as Record<string, unknown>).content
  return typeof content === 'string' ? content : undefined
}

function countTaggedElements(value: unknown, tag: string): number {
  if (!value || typeof value !== 'object') return 0
  const record = value as Record<string, unknown>
  let count = record.tag === tag ? 1 : 0
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        count += countTaggedElements(item, tag)
      }
    } else {
      count += countTaggedElements(child, tag)
    }
  }
  return count
}

function parseSchema(value: string): Schema {
  if (value === 'anthropic' || value === 'openai' || value === 'openai-auth') return value
  throw new Error('schema must be one of anthropic, openai, openai-auth')
}

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value || value === '-') return undefined
  if (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh'
  ) {
    return value
  }
  throw new Error('reasoningEffort must be one of none, minimal, low, medium, high, xhigh')
}

function parseVisualRequestParams(
  formValue: Record<string, unknown>,
  schema: Schema,
): { touched: boolean; params?: ModelRequestParams } & Pick<ModelTuningParams, 'reasoningEffort' | 'maxOutputTokens'> {
  const textValue = stringField(formValue, FIELD_REQUEST_PARAMS)
  const textTuning = parseModelTuningParamsText(textValue, schema)
  const params: ModelRequestParams = { ...(textTuning.requestParams ?? {}) }
  let touched = textValue !== undefined
  let reasoningEffort = textTuning.reasoningEffort
  let maxOutputTokens = textTuning.maxOutputTokens

  for (let index = 1; index <= MAX_PARAM_ROWS; index += 1) {
    const key = stringField(formValue, paramKeyField(index))
    const rawValue = stringField(formValue, paramValueField(index))
    if (!key && !rawValue) continue
    touched = true
    if (!key) {
      throw new Error(`request param ${index} key is required when value is filled.`)
    }
    const [, parsedValue] = parseModelRequestParamFlagValue(`${key}=${rawValue ?? ''}`)
    params[key] = parsedValue
  }

  if (!touched) return { touched: false, params: undefined }
  const tuning = splitModelTuningParams(params, schema, 'requestParams')
  reasoningEffort = tuning.reasoningEffort ?? reasoningEffort
  maxOutputTokens = tuning.maxOutputTokens ?? maxOutputTokens
  return {
    touched: true,
    params: tuning.requestParams,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  }
}

function parseModelParamMode(value: string | undefined): ModelParamMode {
  if (
    value === 'setup_existing' ||
    value === 'setup_new_codex' ||
    value === 'setup_new_key' ||
    value === 'edit'
  ) {
    return value
  }
  return 'setup_existing'
}

function clampParamRows(value: number): number {
  if (!Number.isInteger(value)) return DEFAULT_PARAM_ROWS
  return Math.max(DEFAULT_PARAM_ROWS, Math.min(MAX_PARAM_ROWS, value))
}

function paramKeyField(index: number): string {
  return `${FIELD_REQUEST_PARAM_KEY_PREFIX}${index}`
}

function paramValueField(index: number): string {
  return `${FIELD_REQUEST_PARAM_VALUE_PREFIX}${index}`
}

function parsePathList(raw: string): string[] {
  return [...new Set(raw
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(Boolean))]
}

function parseOptionalSelectedValue(value: string | undefined): string | undefined {
  return value && value !== '-' ? value : undefined
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const n = Number.parseInt(value, 10)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('maxOutputTokens must be a positive integer')
  }
  return n
}

function requiredAlias(kind: string, value: string | undefined): string {
  const text = requiredText(kind, value)
  if (!ALIAS_RE.test(text)) {
    throw new Error(`${kind} must match /^[A-Za-z0-9_.-]{1,80}$/`)
  }
  return text
}

function requiredText(kind: string, value: string | undefined): string {
  const text = value?.trim()
  if (!text) {
    throw new Error(`${kind} is required.`)
  }
  return text
}

function stringField(formValue: Record<string, unknown>, name: string): string | undefined {
  const value = formValue[name]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || undefined
  }
  return undefined
}

function cloneOverride(current: UserConfigOverride): UserConfigOverride {
  return {
    ...current,
    ...(current.endpoints ? { endpoints: { ...current.endpoints } } : {}),
    ...(current.models ? { models: { ...current.models } } : {}),
  }
}

const LARK_MD_ESCAPE_RE = /([\\`*_~\[\]<>])/g

function escapeLarkMd(text: string): string {
  return text.replace(LARK_MD_ESCAPE_RE, '\\$1')
}

function escapeCodeFence(text: string): string {
  return text.replaceAll('```', '`\\`\\`')
}
