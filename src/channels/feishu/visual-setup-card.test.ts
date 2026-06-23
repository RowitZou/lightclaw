import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createUser } from '../../identity/store.js'
import { setLightclawHomeOverride } from '../../paths.js'
import { setUserSecret } from '../../secrets/store.js'
import { readUserCodexAuth } from '../../auth/codex/user-store.js'
import {
  loadUserConfigOverride,
  writeUserConfigOverride,
} from '../../config/user-override.js'
import { loadUserRlaunchMounts } from '../../runtime/rlaunch-mounts.js'
import type { FeishuSender } from './sender.js'
import {
  FeishuVisualSetupCoordinator,
  type VisualSetupCardAction,
} from './visual-setup-card.js'

let home = ''

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lightclaw-visual-setup-'))
  setLightclawHomeOverride(home)
  mkdirSync(home, { recursive: true })
  writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      runtime: { backend: 'local' },
      endpoints: {},
      models: {},
    }),
  )
})

afterEach(() => {
  setLightclawHomeOverride(undefined)
  rmSync(home, { recursive: true, force: true })
})

describe('FeishuVisualSetupCoordinator', () => {
  it('opens a configuration center home card with stable callback navigation buttons', async () => {
    await createUser('alice')
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender)

    await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })

    const raw = JSON.stringify(sender.cards[0]!.card)
    assert.match(raw, /模型设置向导/)
    assert.match(raw, /Endpoint 管理/)
    assert.match(raw, /凭据管理/)
    assert.match(raw, /目录管理/)
    assert.match(raw, /Skill 管理/)
    assert.match(raw, /Task \/ Background/)
    assert.match(raw, /Admin 审批/)
    const modelHomeButton = extractVisualButton(sender.cards[0]!.card, 'model_home')
    assert.equal(modelHomeButton.form_action_type, undefined)
    assert.equal(modelHomeButton.name, 'visual_model_home')
    const body = (sender.cards[0]!.card.body as { elements?: Array<Record<string, unknown>> })
    assert.ok(!body.elements?.some(element => element.tag === 'form'), 'pure navigation buttons must not be inside a form')
  })

  it('opens the model management card and routes add-model navigation', async () => {
    await createUser('alice')
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender)

    await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const modelHome = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'model_home'))
    const modelHomeCard = (modelHome.card as { data: Record<string, unknown> }).data

    const raw = JSON.stringify(modelHomeCard)
    assert.match(raw, /模型管理/)
    assert.match(raw, /添加模型/)
    assert.match(raw, /修改模型/)
    assert.match(raw, /设为默认/)
    assert.match(raw, /检查模型/)
    assert.match(raw, /删除模型/)
    assert.doesNotMatch(raw, /Endpoint 管理/)
    const addButton = extractVisualButton(modelHomeCard, 'setup_model')
    assert.equal(addButton.form_action_type, undefined)
    const setup = await coord.handleCardAction(extractVisualAction(modelHomeCard, 'setup_model'))
    assert.equal((setup.toast as { type?: string } | undefined)?.type, 'info')
    assert.equal((setup.card as { type?: string } | undefined)?.type, 'raw')
    assert.match(JSON.stringify(setup), /添加模型/)
    assert.match(JSON.stringify(setup), /新建 Codex endpoint/)
    assert.match(JSON.stringify(setup), /新建 API-key endpoint/)
    assertFormButtonsUseSubmit(responseCardData(setup))
    assertSelectStaticHasNoLabel(responseCardData(setup))
    assert.equal(sender.patches.at(-1)?.messageId, 'msg-1')
    assert.equal(cardTitle(sender.patches.at(-1)?.card ?? {}), '添加模型')
  })

  it('routes the configuration center navigation matrix locally', async () => {
    await createUser('alice')
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender)

    await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const homeCard = sender.cards[0]!.card
    const homeCases: Array<[VisualSetupCardAction['action'], string]> = [
      ['model_home', '模型管理'],
      ['endpoint_home', 'Endpoint 管理'],
      ['auth_home', '凭据管理'],
      ['directory_home', '目录管理'],
      ['skill_home', 'Skill 管理'],
      ['task_home', 'Task / Background'],
      ['admin_home', 'Admin 审批'],
    ]

    for (const [action, title] of homeCases) {
      const response = await coord.handleCardAction(extractVisualAction(homeCard, action))
      assert.equal(cardTitle(responseCardData(response)), title, `home -> ${action}`)
    }

    const modelHome = await coord.handleCardAction(extractVisualAction(homeCard, 'model_home'))
    const modelHomeCard = responseCardData(modelHome)
    const modelCases: Array<[VisualSetupCardAction['action'], string]> = [
      ['setup_model', '添加模型'],
      ['model_edit', '修改模型'],
      ['model_set_default', '设置默认模型'],
      ['model_check', '检查模型'],
      ['model_delete', '删除模型'],
      ['model_param_help', '模型参数帮助'],
      ['home', 'LightClaw 控制台'],
    ]

    for (const [action, title] of modelCases) {
      const response = await coord.handleCardAction(extractVisualAction(modelHomeCard, action))
      assert.equal(cardTitle(responseCardData(response)), title, `model_home -> ${action}`)
    }

    const setupCard = responseCardData(await coord.handleCardAction(extractVisualAction(modelHomeCard, 'setup_model')))
    const setupCases: Array<[VisualSetupCardAction['action'], string]> = [
      ['setup_model_new_codex', '添加模型 · 新建 Codex endpoint'],
      ['setup_model_new_key', '添加模型 · 新建 API-key endpoint'],
      ['model_home', '模型管理'],
    ]

    for (const [action, title] of setupCases) {
      const response = await coord.handleCardAction(extractVisualAction(setupCard, action))
      assert.equal(cardTitle(responseCardData(response)), title, `setup_model -> ${action}`)
    }

    const directoryHome = await coord.handleCardAction(extractVisualAction(homeCard, 'directory_home'))
    const directoryCard = responseCardData(directoryHome)
    const directoryCases: Array<[VisualSetupCardAction['action'], string]> = [
      ['workspace_edit', '修改 Workspace'],
      ['mount_add', '添加 rlaunch 挂载'],
      ['mount_remove', '移除 rlaunch 挂载'],
      ['home', 'LightClaw 控制台'],
    ]

    for (const [action, title] of directoryCases) {
      const response = await coord.handleCardAction(extractVisualAction(directoryCard, action))
      assert.equal(cardTitle(responseCardData(response)), title, `directory_home -> ${action}`)
    }
  })

  it('adds a new endpoint and model from the visual setup form', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    const sender = new FakeSender()
    const checked: string[] = []
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender, {
      checkModel: async ({ modelName }) => {
        checked.push(modelName)
        return 'Model check: ok.'
      },
    })

    await coord.openModelSetup({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const newKey = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'setup_model_new_key'))
    const action = extractVisualAction(responseCardData(newKey), 'submit_model')
    const response = await coord.handleCardAction({
      ...action,
      formValue: {
        endpoint_name: 'openai-default',
        api_key_ref: 'OPENAI_KEY',
        base_url: 'https://api.example.test/v1',
        proxy: '[http://proxy.example:8080](http://proxy.example:8080/)',
        model_alias: 'gpt-ui',
        schema: 'openai',
        upstream_model: 'gpt-4.1',
        reasoning: 'high',
        max_output_tokens: '64000',
        request_params: 'temperature=0.2; response_format={"type":"json_object"}',
        set_default: 'yes',
      },
    })
    await tick()

    assert.match(JSON.stringify(response), /模型配置已保存/)
    assert.deepEqual(checked, ['gpt-ui'])
    assert.match(JSON.stringify(sender.cards.at(-1)?.card), /模型检查通过/)
    const loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok, true)
    assert.equal(loaded.ok ? loaded.value.endpoints?.['openai-default']?.apiKeyRef : undefined, 'OPENAI_KEY')
    assert.equal(loaded.ok ? loaded.value.endpoints?.['openai-default']?.proxy : undefined, 'http://proxy.example:8080')
    assert.equal(loaded.ok ? loaded.value.models?.['gpt-ui']?.endpoint : undefined, 'openai-default')
    assert.equal(loaded.ok ? loaded.value.models?.['gpt-ui']?.reasoningEffort : undefined, 'high')
    assert.equal(loaded.ok ? loaded.value.models?.['gpt-ui']?.maxOutputTokens : undefined, 64000)
    assert.deepEqual(loaded.ok ? loaded.value.models?.['gpt-ui']?.requestParams : undefined, {
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })
    assert.equal(loaded.ok ? loaded.value.defaultModel : undefined, 'gpt-ui')
    assert.doesNotMatch(JSON.stringify(response), /sk-user-secret/)
  })

  it('adds model request params through dynamic visual key/value rows', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender, {
      checkModel: async () => 'Model check: ok.',
    })

    await coord.openModelSetup({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const newKey = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'setup_model_new_key'))
    const expanded = await coord.handleCardAction({
      ...extractVisualAction(responseCardData(newKey), 'model_param_add_row'),
      formValue: {
        endpoint_name: 'openai-default',
        api_key_ref: 'OPENAI_KEY',
        model_alias: 'gpt-ui',
        upstream_model: 'gpt-4.1',
        request_param_key_1: 'reasoningEffort',
        request_param_value_1: 'high',
      },
    })
    const expandedCard = responseCardData(expanded)
    assertInputDefaultValue(expandedCard, 'endpoint_name', 'openai-default')
    assertInputDefaultValue(expandedCard, 'request_param_key_1', 'reasoningEffort')
    assert.ok(findTagged(expandedCard, 'input').some(input => input.name === 'request_param_key_3'))

    await coord.handleCardAction({
      ...extractVisualAction(expandedCard, 'submit_model'),
      formValue: {
        endpoint_name: 'openai-default',
        api_key_ref: 'OPENAI_KEY',
        model_alias: 'gpt-ui',
        schema: 'openai',
        upstream_model: 'gpt-4.1',
        request_param_key_1: 'reasoningEffort',
        request_param_value_1: 'high',
        request_param_key_2: 'maxOutputTokens',
        request_param_value_2: '64000',
        request_param_key_3: 'temperature',
        request_param_value_3: '0.2',
      },
    })

    const loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.models?.['gpt-ui']?.reasoningEffort : undefined, 'high')
    assert.equal(loaded.ok ? loaded.value.models?.['gpt-ui']?.maxOutputTokens : undefined, 64000)
    assert.deepEqual(loaded.ok ? loaded.value.models?.['gpt-ui']?.requestParams : undefined, {
      temperature: 0.2,
    })
  })

  it('adds a model using an existing endpoint selected in the visual setup form', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    writeUserConfigOverride('alice', {
      endpoints: {
        existing: {
          apiKeyRef: 'OPENAI_KEY',
          baseUrl: 'https://api.example.test/v1',
        },
      },
    })
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender, {
      checkModel: async () => 'Model check: ok.',
    })

    await coord.openModelSetup({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const existingCard = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'setup_model_existing'))
    const existingRaw = JSON.stringify(responseCardData(existingCard))
    assert.doesNotMatch(existingRaw, /"name":"api_key_ref"/)
    assert.doesNotMatch(existingRaw, /新 endpoint 名称/)
    assert.doesNotMatch(existingRaw, /auth\.json 导入路径/)
    const action = extractVisualAction(responseCardData(existingCard), 'submit_model')
    await coord.handleCardAction({
      ...action,
      formValue: {
        endpoint_choice: 'existing:existing',
        model_alias: 'gpt-existing',
        schema: 'openai',
        upstream_model: 'gpt-4.1',
        set_default: 'no',
      },
    })

    const loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok, true)
    assert.deepEqual(Object.keys(loaded.ok ? loaded.value.endpoints ?? {} : {}), ['existing'])
    assert.equal(loaded.ok ? loaded.value.models?.['gpt-existing']?.endpoint : undefined, 'existing')
    assert.equal(loaded.ok ? loaded.value.defaultModel : undefined, undefined)
  })

  it('accepts a bare Codex auth name in the visual setup form', async () => {
    await createUser('alice')
    writeCodexAuth('alice', 'default')
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender, {
      checkModel: async () => 'Model check: ok.',
    })

    await coord.openModelSetup({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const newCodex = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'setup_model_new_codex'))
    const action = extractVisualAction(responseCardData(newCodex), 'submit_model')
    await coord.handleCardAction({
      ...action,
      formValue: {
        endpoint_name: 'codex-default',
        auth_ref: 'default',
        model_alias: 'gpt-codex',
        schema: 'openai-auth',
        upstream_model: 'gpt-5.5',
      },
    })

    const loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok, true)
    assert.equal(loaded.ok ? loaded.value.endpoints?.['codex-default']?.authRef : undefined, 'codex:default')
    assert.equal(loaded.ok ? loaded.value.models?.['gpt-codex']?.endpoint : undefined, 'codex-default')
  })

  it('imports a Codex auth path entered in the visual setup form', async () => {
    await createUser('alice')
    const source = path.join(home, 'incoming-auth.json')
    writeCodexCliAuthSource(source)
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender, {
      checkModel: async () => 'Model check: ok.',
    })

    await coord.openModelSetup({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const newCodex = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'setup_model_new_codex'))
    const action = extractVisualAction(responseCardData(newCodex), 'submit_model')
    await coord.handleCardAction({
      ...action,
      formValue: {
        endpoint_name: 'codex-default',
        auth_import_path: source,
        model_alias: 'gpt-codex',
        schema: 'openai-auth',
        upstream_model: 'gpt-5.5',
      },
    })

    const imported = readUserCodexAuth('alice', 'default')
    assert.equal(imported?.account_id, 'account-1')
    const loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok, true)
    assert.equal(loaded.ok ? loaded.value.endpoints?.['codex-default']?.authRef : undefined, 'codex:default')
    assert.equal(loaded.ok ? loaded.value.models?.['gpt-codex']?.endpoint : undefined, 'codex-default')
  })

  it('infers API-key endpoint when Feishu omits the endpoint select but apiKeyRef is filled', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender, {
      checkModel: async () => 'Model check: ok.',
    })

    await coord.openModelSetup({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const newKey = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'setup_model_new_key'))
    const action = extractVisualAction(responseCardData(newKey), 'submit_model')
    await coord.handleCardAction({
      ...action,
      formValue: {
        endpoint_name: 'openai-default',
        api_key_ref: 'OPENAI_KEY',
        model_alias: 'gpt-openai',
        schema: 'openai',
        upstream_model: 'gpt-4.1',
      },
    })

    const loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok, true)
    assert.equal(loaded.ok ? loaded.value.endpoints?.['openai-default']?.apiKeyRef : undefined, 'OPENAI_KEY')
    assert.equal(loaded.ok ? loaded.value.models?.['gpt-openai']?.endpoint : undefined, 'openai-default')
  })

  it('manages existing models from the model management card', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    writeUserConfigOverride('alice', {
      endpoints: {
        existing: {
          apiKeyRef: 'OPENAI_KEY',
          baseUrl: 'https://api.example.test/v1',
        },
      },
      models: {
        old: {
          endpoint: 'existing',
          schema: 'openai',
          upstreamModel: 'gpt-old',
        },
        next: {
          endpoint: 'existing',
          schema: 'openai',
          upstreamModel: 'gpt-next',
        },
      },
      defaultModel: 'old',
    })
    const checked: string[] = []
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender, {
      checkModel: async ({ modelName }) => {
        checked.push(modelName)
        return 'Model check: ok.'
      },
    })

    await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const modelHome = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'model_home'))
    const modelHomeCard = (modelHome.card as { data: Record<string, unknown> }).data

    const editCard = await coord.handleCardAction(extractVisualAction(modelHomeCard, 'model_edit'))
    const submitEdit = extractVisualAction((editCard.card as { data: Record<string, unknown> }).data, 'submit_model_edit')
    await coord.handleCardAction({
      ...submitEdit,
      formValue: {
        model_target: 'old',
        endpoint_choice: 'existing',
        schema: 'openai',
        upstream_model: 'gpt-edited',
        reasoning: 'medium',
        max_output_tokens: '32000',
        request_params: 'top_p=0.9',
        set_default: 'yes',
      },
    })
    await tick()

    let loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.models?.old?.upstreamModel : undefined, 'gpt-edited')
    assert.equal(loaded.ok ? loaded.value.models?.old?.reasoningEffort : undefined, 'medium')
    assert.equal(loaded.ok ? loaded.value.models?.old?.maxOutputTokens : undefined, 32000)
    assert.deepEqual(loaded.ok ? loaded.value.models?.old?.requestParams : undefined, { top_p: 0.9 })
    assert.deepEqual(checked, ['old'])

    const setDefaultCard = await coord.handleCardAction(extractVisualAction(modelHomeCard, 'model_set_default'))
    const submitDefault = extractVisualAction((setDefaultCard.card as { data: Record<string, unknown> }).data, 'submit_model_set_default')
    await coord.handleCardAction({
      ...submitDefault,
      formValue: { model_target: 'next' },
    })
    loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.defaultModel : undefined, 'next')

    const deleteCard = await coord.handleCardAction(extractVisualAction(modelHomeCard, 'model_delete'))
    const submitDelete = extractVisualAction((deleteCard.card as { data: Record<string, unknown> }).data, 'submit_model_delete')
    await coord.handleCardAction({
      ...submitDelete,
      formValue: { model_target: 'next' },
    })
    loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.models?.next : undefined, undefined)
    assert.equal(loaded.ok ? loaded.value.defaultModel : undefined, undefined)
  })

  it('shows the returned model-check failure instead of an empty code block', async () => {
    await createUser('alice')
    writeUserConfigOverride('alice', {
      endpoints: {
        broken: {
          apiKeyRef: 'MISSING_KEY',
        },
      },
      models: {
        broken: {
          endpoint: 'broken',
          schema: 'openai',
          upstreamModel: 'gpt-broken',
        },
      },
      defaultModel: 'broken',
    })
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender)

    await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const modelHome = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'model_home'))
    const checkCard = await coord.handleCardAction(extractVisualAction(responseCardData(modelHome), 'model_check'))
    const submitCheck = extractVisualAction(responseCardData(checkCard), 'submit_model_check')
    await coord.handleCardAction({
      ...submitCheck,
      formValue: { model_target: 'broken' },
    })
    await tick()

    const resultCard = JSON.stringify(sender.cards.at(-1)?.card)
    assert.match(resultCard, /模型检查失败/)
    assert.match(resultCard, /Model check: failed/)
    assert.match(resultCard, /not selectable for this user/)
  })

  it('rejects apiKeyRef forms when the referenced secret is missing', async () => {
    await createUser('alice')
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender)

    await coord.openModelSetup({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const newKey = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'setup_model_new_key'))
    const action = extractVisualAction(responseCardData(newKey), 'submit_model')
    const response = await coord.handleCardAction({
      ...action,
      formValue: {
        endpoint_name: 'openai-default',
        api_key_ref: 'OPENAI_KEY',
        model_alias: 'gpt-ui',
        schema: 'openai',
        upstream_model: 'gpt-4.1',
      },
    })

    assert.match(JSON.stringify(response), /apiKeyRef/)
    const loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.models : undefined, undefined)
  })

  it('adds and deletes endpoints from the endpoint management cards', async () => {
    await createUser('alice')
    setUserSecret('alice', 'OPENAI_KEY', 'sk-user-secret')
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender)

    await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const endpointHome = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'endpoint_home'))
    const endpointHomeCard = (endpointHome.card as { data: Record<string, unknown> }).data
    assert.doesNotMatch(JSON.stringify(endpointHomeCard), /添加模型/)
    assert.doesNotMatch(JSON.stringify(endpointHomeCard), /新增 \/ 更新 endpoint/)
    const openEndpointButton = extractVisualButton(endpointHomeCard, 'endpoint_add')
    assert.equal(openEndpointButton.form_action_type, undefined)
    const openEndpoint = extractVisualAction(endpointHomeCard, 'endpoint_add')
    const edit = await coord.handleCardAction(openEndpoint)
    assert.match(JSON.stringify(edit), /新增 Endpoint/)
    assertFormButtonsUseSubmit(responseCardData(edit))
    assertSelectStaticHasNoLabel(responseCardData(edit))
    const saveEndpoint = extractVisualAction((edit.card as { data: Record<string, unknown> }).data, 'submit_endpoint_add')
    await coord.handleCardAction({
      ...saveEndpoint,
      formValue: {
        endpoint_name: 'openai-default',
        endpoint_kind: 'api-key',
        api_key_ref: 'OPENAI_KEY',
        base_url: 'https://api.example.test/v1',
      },
    })

    let loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.endpoints?.['openai-default']?.apiKeyRef : undefined, 'OPENAI_KEY')

    const endpointHomeAfterSave = await coord.handleCardAction(extractVisualAction((edit.card as { data: Record<string, unknown> }).data, 'endpoint_home'))
    const updateEndpoint = extractVisualAction((endpointHomeAfterSave.card as { data: Record<string, unknown> }).data, 'endpoint_update')
    const updateSelect = await coord.handleCardAction(updateEndpoint)
    const loadUpdateForm = extractVisualAction(responseCardData(updateSelect), 'endpoint_update_edit')
    const updateForm = await coord.handleCardAction({
      ...loadUpdateForm,
      formValue: { endpoint_target: 'openai-default' },
    })
    const updateFormCard = responseCardData(updateForm)
    assert.match(JSON.stringify(updateFormCard), /更新 Endpoint · openai-default/)
    assertInputDefaultValue(updateFormCard, 'api_key_ref', 'OPENAI_KEY')
    assertInputDefaultValue(updateFormCard, 'base_url', 'https://api.example.test/v1')
    const submitUpdate = extractVisualAction(updateFormCard, 'submit_endpoint_update')
    assert.equal(submitUpdate.endpointName, 'openai-default')
    await coord.handleCardAction({
      ...submitUpdate,
      formValue: {
        api_key_ref: 'OPENAI_KEY',
        base_url: 'https://api2.example.test/v1',
        proxy: 'http://proxy.example:8080',
      },
    })
    loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.endpoints?.['openai-default']?.baseUrl : undefined, 'https://api2.example.test/v1')
    assert.equal(loaded.ok ? loaded.value.endpoints?.['openai-default']?.proxy : undefined, 'http://proxy.example:8080')

    const refreshedEndpointHome = await coord.handleCardAction(extractVisualAction(responseCardData(updateForm), 'endpoint_home'))
    const deleteEndpoint = extractVisualAction((refreshedEndpointHome.card as { data: Record<string, unknown> }).data, 'endpoint_delete')
    const deleteCard = await coord.handleCardAction(deleteEndpoint)
    const submitDelete = extractVisualAction((deleteCard.card as { data: Record<string, unknown> }).data, 'submit_endpoint_delete')
    await coord.handleCardAction({
      ...submitDelete,
      formValue: { endpoint_delete_name: 'openai-default' },
    })
    loaded = loadUserConfigOverride('alice')
    assert.equal(loaded.ok ? loaded.value.endpoints : undefined, undefined)
  })

  it('adds and updates credentials from the credential management cards', async () => {
    await createUser('alice')
    const source = path.join(home, 'incoming-auth.json')
    writeCodexCliAuthSource(source)
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender)

    await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const authHome = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'auth_home'))
    assert.equal(cardTitle(responseCardData(authHome)), '凭据管理')
    const edit = await coord.handleCardAction(extractVisualAction(responseCardData(authHome), 'auth_edit'))
    assert.match(JSON.stringify(edit), /新增 \/ 更新凭据/)
    assertFormButtonsUseSubmit(responseCardData(edit))
    assertSelectStaticHasNoLabel(responseCardData(edit))

    const submit = extractVisualAction(responseCardData(edit), 'submit_auth')
    const saved = await coord.handleCardAction({
      ...submit,
      formValue: {
        auth_name: 'default',
        auth_import_path: source,
      },
    })

    assert.match(JSON.stringify(saved), /凭据已保存/)
    assert.equal(readUserCodexAuth('alice', 'default')?.account_id, 'account-1')
    const afterSave = await coord.handleCardAction(extractVisualAction(responseCardData(saved), 'auth_home'))
    assert.match(JSON.stringify(afterSave), /codex:default/)
    assert.match(JSON.stringify(afterSave), /Codex OAuth/)
  })

  it('does not delete credentials while an endpoint still references them', async () => {
    await createUser('alice')
    writeCodexAuth('alice', 'default')
    writeUserConfigOverride('alice', {
      endpoints: {
        codex: { authRef: 'codex:default' },
      },
    })
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender)

    await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const authHome = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'auth_home'))
    const authDelete = await coord.handleCardAction(extractVisualAction((authHome.card as { data: Record<string, unknown> }).data, 'auth_delete'))
    const submitDelete = extractVisualAction((authDelete.card as { data: Record<string, unknown> }).data, 'submit_auth_delete')
    const response = await coord.handleCardAction({
      ...submitDelete,
      formValue: { auth_delete_name: 'default' },
    })

    assert.match(JSON.stringify(response), /used by endpoint/)
  })

  it('updates workspace directly from the directory card and restarts the rlaunch worker', async () => {
    await createUser('alice')
    const gpfsRoot = path.join(home, 'gpfs')
    const workspaceRoot = path.join(gpfsRoot, 'workspaces')
    const initialWorkspace = path.join(workspaceRoot, 'alice')
    const nextWorkspace = path.join(gpfsRoot, 'custom-workspaces', 'alice')
    mkdirSync(initialWorkspace, { recursive: true })
    mkdirSync(nextWorkspace, { recursive: true })
    writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        runtime: {
          driver: 'brainpp',
          backend: 'cluster',
          clusterSettings: {
            image: 'lightclaw-test:latest',
            chargedGroup: 'test-group',
            namespace: 'test-namespace',
            gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
          },
        },
        endpoints: {},
        models: {},
      }),
    )
    const oldWorkspaceRoot = process.env.LIGHTCLAW_WORKSPACE_ROOT
    process.env.LIGHTCLAW_WORKSPACE_ROOT = workspaceRoot
    try {
      const sender = new FakeSender()
      const restarted: string[] = []
      const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender, {
        restartRlaunch: async ({ userId }) => {
          restarted.push(userId)
          return `worker-ui-${restarted.length}`
        },
      })

      await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
      const directoryHome = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'directory_home'))
      const directoryCard = responseCardData(directoryHome)
      const directoryRaw = JSON.stringify(directoryCard)
      assert.match(directoryRaw, new RegExp(escapeRegExp(path.join(home, 'users', 'alice'))))
      assert.match(directoryRaw, new RegExp(escapeRegExp(initialWorkspace)))
      assert.doesNotMatch(directoryRaw, /approve-home|申请修改用户数据目录/)

      const workspaceCard = await coord.handleCardAction(extractVisualAction(directoryCard, 'workspace_edit'))
      const workspaceEditCard = responseCardData(workspaceCard)
      assertInputDefaultValue(workspaceEditCard, 'workspace', initialWorkspace)
      const submit = extractVisualAction(workspaceEditCard, 'submit_workspace')
      const response = await coord.handleCardAction({
        ...submit,
        formValue: { workspace: nextWorkspace },
      })

      const raw = JSON.stringify(response)
      assert.deepEqual(restarted, ['alice'])
      assert.match(raw, new RegExp(escapeRegExp(nextWorkspace)))
      assert.match(raw, /worker-ui-1/)
      const loaded = loadUserConfigOverride('alice')
      assert.equal(loaded.ok ? loaded.value.workspace : undefined, nextWorkspace)
    } finally {
      if (oldWorkspaceRoot === undefined) {
        delete process.env.LIGHTCLAW_WORKSPACE_ROOT
      } else {
        process.env.LIGHTCLAW_WORKSPACE_ROOT = oldWorkspaceRoot
      }
    }
  })

  it('routes mount add navigation from the directory card with a stable callback button', async () => {
    await createUser('alice')
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender)

    await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const directoryHome = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'directory_home'))
    const directoryCard = (directoryHome.card as { data: Record<string, unknown> }).data
    const mountAddButton = extractVisualButton(directoryCard, 'mount_add')
    assert.equal(mountAddButton.form_action_type, undefined)
    assert.equal(mountAddButton.name, 'visual_mount_add')

    const mountCard = await coord.handleCardAction(extractVisualAction(directoryCard, 'mount_add'))
    assert.match(JSON.stringify(mountCard), /添加 rlaunch 挂载/)
  })

  it('submits rlaunch mount changes from the directory card and restarts the worker', async () => {
    await createUser('alice')
    const gpfsRoot = path.join(home, 'gpfs')
    const workspaceRoot = path.join(gpfsRoot, 'workspaces')
    const dataPath = path.join(gpfsRoot, 'agent-code-workspace', 'AgentCompass')
    mkdirSync(path.join(workspaceRoot, 'alice'), { recursive: true })
    mkdirSync(dataPath, { recursive: true })
    writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({
        runtime: {
          driver: 'brainpp',
          backend: 'cluster',
          clusterSettings: {
            image: 'lightclaw-test:latest',
            chargedGroup: 'test-group',
            namespace: 'test-namespace',
            gpfsMounts: [{ hostPrefix: gpfsRoot, mountPrefix: 'gpfs://gpfs1' }],
          },
        },
        endpoints: {},
        models: {},
      }),
    )
    const oldWorkspaceRoot = process.env.LIGHTCLAW_WORKSPACE_ROOT
    process.env.LIGHTCLAW_WORKSPACE_ROOT = workspaceRoot
    try {
      const sender = new FakeSender()
      const restarted: string[] = []
      const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender, {
        restartRlaunch: async ({ userId }) => {
          restarted.push(userId)
          return `worker-ui-${restarted.length}`
        },
      })

      await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
      const directoryHome = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'directory_home'))
      const mountAdd = await coord.handleCardAction(extractVisualAction(responseCardData(directoryHome), 'mount_add'))
      const submit = extractVisualAction(responseCardData(mountAdd), 'submit_mount_add')
      const response = await coord.handleCardAction({
        ...submit,
        formValue: {
          mount_paths: dataPath,
          mount_mode: 'ro',
        },
      })

      const raw = JSON.stringify(response)
      assert.deepEqual(restarted, ['alice'])
      assert.deepEqual(loadUserRlaunchMounts('alice'), [{ path: dataPath, mode: 'ro' }])
      assert.match(raw, /worker-ui-1/)
      assert.doesNotMatch(raw, /跳过 rlaunch worker 重启|restart skipped/i)

      const mountRemove = await coord.handleCardAction(extractVisualAction(responseCardData(directoryHome), 'mount_remove'))
      const removeCard = responseCardData(mountRemove)
      assert.match(JSON.stringify(removeCard), new RegExp(escapeRegExp(dataPath)))
      const mountSelect = findTagged(removeCard, 'select_static')
        .find(item => item.name === 'mount_selected_path')
      assert.ok(mountSelect)
      const options = mountSelect.options as Array<{ value?: string }>
      assert.ok(options.some(option => option.value === dataPath))

      const submitRemove = extractVisualAction(removeCard, 'submit_mount_remove')
      const removeResponse = await coord.handleCardAction({
        ...submitRemove,
        formValue: { mount_selected_path: dataPath },
      })

      assert.deepEqual(restarted, ['alice', 'alice'])
      assert.deepEqual(loadUserRlaunchMounts('alice'), [])
      assert.match(JSON.stringify(removeResponse), /worker-ui-2/)
    } finally {
      if (oldWorkspaceRoot === undefined) {
        delete process.env.LIGHTCLAW_WORKSPACE_ROOT
      } else {
        process.env.LIGHTCLAW_WORKSPACE_ROOT = oldWorkspaceRoot
      }
    }
  })

  it('renders the skill card as a concise summary instead of a long builtin wall', async () => {
    await createUser('alice')
    const sender = new FakeSender()
    const coord = new FeishuVisualSetupCoordinator(sender as unknown as FeishuSender)

    await coord.openHome({ sessionId: 'feishu:dm:oc_chat', userId: 'alice' })
    const skillHome = await coord.handleCardAction(extractVisualAction(sender.cards[0]!.card, 'skill_home'))
    const raw = JSON.stringify(skillHome)

    assert.match(raw, /用户 skills/)
    assert.match(raw, /内置预览/)
    assert.doesNotMatch(raw, /source=builtin/)
    assert.doesNotMatch(raw, /Standard procedure when you operate as the archivist role/)
  })
})

class FakeSender {
  cards: Array<{ chatId: string; card: Record<string, unknown>; threadId?: string }> = []
  patches: Array<{ messageId: string; card: Record<string, unknown> }> = []

  async sendInteractiveCardToChatId(
    chatId: string,
    card: Record<string, unknown>,
    _ctx?: unknown,
    threadId?: string,
  ): Promise<{ messageId?: string }> {
    this.cards.push({ chatId, card, ...(threadId ? { threadId } : {}) })
    return { messageId: `msg-${this.cards.length}` }
  }

  async patchInteractiveCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.patches.push({ messageId, card })
  }
}

function extractVisualAction(card: Record<string, unknown>, action: string): VisualSetupCardAction {
  const found = findAction(card, action)
  assert.ok(found)
  return found as VisualSetupCardAction
}

function extractVisualButton(card: Record<string, unknown>, action: string): Record<string, unknown> {
  const found = findButton(card, action)
  assert.ok(found)
  return found
}

function responseCardData(response: { card?: unknown }): Record<string, unknown> {
  const card = response.card as { data?: Record<string, unknown> } | undefined
  assert.ok(card?.data)
  return card.data
}

function cardTitle(card: Record<string, unknown>): string | undefined {
  const header = card.header as { title?: { content?: string } } | undefined
  return header?.title?.content
}

function assertFormButtonsUseSubmit(card: Record<string, unknown>): void {
  for (const form of findTagged(card, 'form')) {
    const buttons = findTagged(form, 'button')
    assert.ok(buttons.length > 0, 'form should expose at least one button')
    for (const button of buttons) {
      assert.equal(
        button.form_action_type,
        'submit',
        `button ${String(button.name ?? '(unnamed)')} inside a form must use form_action_type=submit`,
      )
    }
  }
}

function assertSelectStaticHasNoLabel(card: Record<string, unknown>): void {
  for (const select of findTagged(card, 'select_static')) {
    assert.equal(
      'label' in select,
      false,
      `select_static ${String(select.name ?? '(unnamed)')} must not carry Feishu-unsupported label`,
    )
  }
}

function assertInputDefaultValue(card: Record<string, unknown>, name: string, expected: string): void {
  const found = findTagged(card, 'input').find(item => item.name === name)
  assert.ok(found, `input ${name} should exist`)
  assert.equal(found.default_value, expected)
}

function findTagged(value: unknown, tag: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const matches = record.tag === tag ? [record] : []
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        matches.push(...findTagged(item, tag))
      }
    } else {
      matches.push(...findTagged(child, tag))
    }
  }
  return matches
}

function findAction(value: unknown, action: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind === 'lightclaw_visual_setup' && record.action === action) {
    return record
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findAction(item, action)
        if (found) return found
      }
    } else {
      const found = findAction(child, action)
      if (found) return found
    }
  }
  return null
}

function findButton(value: unknown, action: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const behaviors = record.behaviors
  if (Array.isArray(behaviors)) {
    for (const behavior of behaviors) {
      if (!behavior || typeof behavior !== 'object') continue
      const candidate = (behavior as Record<string, unknown>).value
      if (
        candidate &&
        typeof candidate === 'object' &&
        (candidate as Record<string, unknown>).kind === 'lightclaw_visual_setup' &&
        (candidate as Record<string, unknown>).action === action
      ) {
        return record
      }
    }
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findButton(item, action)
        if (found) return found
      }
    } else {
      const found = findButton(child, action)
      if (found) return found
    }
  }
  return null
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function writeCodexAuth(userId: string, name: string): void {
  const target = path.join(home, 'users', userId, 'auth', 'codex', `${name}.json`)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify({
    tokens: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 3600_000,
    },
    account_id: 'account-1',
    imported_at: new Date().toISOString(),
    source: 'test',
  }))
}

function writeCodexCliAuthSource(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: fakeJwt({
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': { account_id: 'account-1' },
      }),
      refresh_token: 'refresh-token',
      account_id: 'account-1',
    },
  }))
}

function fakeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.')
}

function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}
