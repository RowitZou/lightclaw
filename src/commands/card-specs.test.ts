import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { setLang, t } from '../i18n/index.js'
import {
  adminBackendCardSpec,
  adminCeilingCardSpec,
  adminCostCardSpec,
  adminEndpointCardSpec,
  adminFeedbackCardSpec,
  adminFeishuDriveCardSpec,
  adminLaneCardSpec,
  adminPairingCardSpec,
  adminSandboxCardSpec,
  adminUserCardSpec,
  configBackendCardSpec,
  configEndpointCardSpec,
  configLaneCardSpec,
  configLangCardSpec,
  configModeCardSpec,
  configModelCardSpec,
  configRuleCardSpec,
  configWorkspaceCardSpec,
  systemDataCardSpec,
  systemKeyCardSpec,
  systemMountCardSpec,
} from './card-specs.js'
import type { CommandListCardSpec } from './registry.js'

// Find a section by its (resolved) heading text.
function section(spec: CommandListCardSpec, heading: string) {
  return spec.sections.find(s => s.heading === heading)
}
// Concatenate all rendered text in a spec (markdown + row cells + examples) so a
// test can assert a substring landed *somewhere* without pinning exact layout.
function allText(spec: CommandListCardSpec): string {
  const parts: string[] = []
  for (const s of spec.sections) {
    if (s.heading) parts.push(s.heading)
    if (s.markdown) parts.push(s.markdown)
    for (const [a, b] of s.rows ?? []) parts.push(a, b)
    for (const ex of s.codeExamples ?? []) parts.push(ex)
  }
  if (spec.footer) parts.push(spec.footer)
  return parts.join('\n')
}

beforeEach(() => setLang('cn'))
afterEach(() => setLang('cn'))

describe('card-specs batch 1: config model / mode / lang', () => {
  it('configModelCardSpec lists models with default + current markers', () => {
    const spec = configModelCardSpec([
      { name: 'a-model', isDefault: true, isCurrent: false },
      { name: 'b-model', isDefault: false, isCurrent: true },
    ])
    const show = section(spec, t('card.show.options'))
    assert.ok(show?.markdown?.includes('1. a-model'))
    assert.ok(show!.markdown!.includes(t('card.default')), 'default marker on a-model')
    assert.ok(show!.markdown!.includes(t('card.curMarker')), 'current marker on b-model')
    // sub-commands + examples present
    assert.ok(section(spec, t('card.subcommands'))?.rows?.length === 2)
    assert.ok(allText(spec).includes('/config model set'))
    assert.ok(spec.title?.includes('/config model'))
  })

  it('configModelCardSpec empty registry shows the two-step guidance', () => {
    const spec = configModelCardSpec([])
    const show = section(spec, t('card.show.options'))
    assert.equal(show?.markdown, t('card.config.model.empty'))
    assert.ok(show!.markdown!.includes('/config endpoint'))
    assert.ok(show!.markdown!.includes('/config backend'))
  })

  it('configModeCardSpec marks current + renders standalone ceiling note', () => {
    const spec = configModeCardSpec({ current: 'auto', ceiling: 'yolo' })
    const show = section(spec, t('card.show.options'))
    // four mode options, ask marked default, auto marked current
    assert.ok(show?.markdown?.includes(t('card.config.mode.opt.read')))
    assert.ok(show!.markdown!.includes(t('card.config.mode.opt.yolo')))
    // ceiling note is its own section (no heading), not folded into the list
    const noteText = t('card.config.mode.ceiling', { ceiling: 'yolo' })
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === noteText))
    assert.ok(allText(spec).includes('/config mode set auto'))
  })

  it('configLangCardSpec marks the current language', () => {
    const spec = configLangCardSpec('en')
    const show = section(spec, t('card.show.options'))
    assert.ok(show?.markdown?.includes(t('card.config.lang.opt.cn')))
    assert.ok(show!.markdown!.includes(t('card.config.lang.opt.en')))
    // cn is default, en is current → both markers appear once
    assert.ok(show!.markdown!.includes(t('card.curMarker')))
    assert.ok(allText(spec).includes('/config lang set en'))
  })
})

describe('card-specs batch 2: config rule / workspace / lane', () => {
  it('configRuleCardSpec numbers rules + has both standalone notes', () => {
    const spec = configRuleCardSpec([
      { behavior: 'deny', pattern: 'Edit(/etc/**)' },
      { behavior: 'ask', pattern: 'Bash(rm:*)' },
    ])
    const show = section(spec, t('card.show.configured'))
    assert.ok(show?.markdown?.includes('1. deny — `Edit(/etc/**)`'))
    assert.ok(show!.markdown!.includes('2. ask — `Bash(rm:*)`'))
    // two standalone notes (index + format), neither with a heading
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.config.rule.note.index')))
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.config.rule.note.format')))
    assert.equal(section(spec, t('card.subcommands'))?.rows?.length, 4)
  })

  it('configRuleCardSpec empty shows the empty-state label', () => {
    const spec = configRuleCardSpec([])
    assert.equal(section(spec, t('card.show.configured'))?.markdown, t('card.config.rule.empty'))
  })

  it('configWorkspaceCardSpec marks default + carries the path note', () => {
    const def = configWorkspaceCardSpec({ path: '/home/u/workspace', isDefault: true })
    assert.ok(section(def, t('card.show.current'))?.markdown?.includes('/home/u/workspace'))
    assert.ok(section(def, t('card.show.current'))!.markdown!.includes(t('card.default')))
    const custom = configWorkspaceCardSpec({ path: '/data/ws', isDefault: false })
    assert.ok(!section(custom, t('card.show.current'))!.markdown!.includes(t('card.default')))
    assert.ok(custom.sections.some(s => !s.heading && s.markdown === t('card.config.workspace.note')))
  })

  it('configLaneCardSpec renders per-use labels + default markers', () => {
    const spec = configLaneCardSpec([
      { bucket: 'worker', model: 'gpt-codex-mid', isDefault: true },
      { bucket: 'system', model: 'gpt-5-high', isDefault: false },
      { bucket: 'image', model: 'gpt-codex-mid', isDefault: true },
    ])
    const show = section(spec, t('card.show.current'))
    assert.ok(show?.markdown?.includes(t('card.config.lane.label.worker')))
    assert.ok(show!.markdown!.includes('gpt-5-high'))
    // worker + image are default → marker present; system is explicit
    assert.ok(show!.markdown!.includes(t('card.default')))
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.config.lane.note')))
    assert.ok(allText(spec).includes('/config lane set worker'))
  })
})

describe('card-specs batch 3: config endpoint / backend', () => {
  it('configEndpointCardSpec lists services with type, params, codex note', () => {
    const spec = configEndpointCardSpec([
      { name: 'my-ep', type: 'openai' },
      { name: 'codex-ep', type: 'codex' },
    ])
    const show = section(spec, t('card.show.configured'))
    assert.ok(show?.markdown?.includes('1. my-ep（openai）'))
    assert.ok(show!.markdown!.includes('2. codex-ep（codex）'))
    // params section carries all five flag bullets
    const params = section(spec, t('card.params'))
    assert.ok(params?.markdown?.includes('--type'))
    assert.ok(params!.markdown!.includes('--auth-path'))
    // codex note is a standalone section
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.endpoint.note.codexAuth')))
    assert.ok(allText(spec).includes('/config endpoint add'))
  })

  it('configEndpointCardSpec empty uses the shared none label', () => {
    const spec = configEndpointCardSpec([])
    assert.equal(section(spec, t('card.show.configured'))?.markdown, t('config.endpoint.none'))
  })

  it('configBackendCardSpec lists models, marks default, has check sub + params', () => {
    const spec = configBackendCardSpec([
      { name: 'gpt-codex-mid', isDefault: true },
      { name: 'claude-opus', isDefault: false },
    ])
    const show = section(spec, t('card.show.configured'))
    assert.ok(show?.markdown?.includes('1. gpt-codex-mid'))
    assert.ok(show!.markdown!.includes(t('card.default')))
    const subs = section(spec, t('card.subcommands'))?.rows ?? []
    assert.ok(subs.some(([cmd]) => cmd.startsWith('check')))
    const params = section(spec, t('card.params'))
    assert.ok(params?.markdown?.includes('--endpoint'))
    assert.ok(params!.markdown!.includes('--reasoning'))
    assert.ok(allText(spec).includes('/config backend add'))
  })

  it('configBackendCardSpec empty uses the shared none label', () => {
    const spec = configBackendCardSpec([])
    assert.equal(section(spec, t('card.show.configured'))?.markdown, t('config.backend.none'))
  })
})

describe('card-specs batches 4-6: admin nouns', () => {
  it('adminCostCardSpec embeds the live body, no sub-commands', () => {
    const spec = adminCostCardSpec('本月累计 1.2M')
    assert.ok(allText(spec).includes('本月累计 1.2M'))
    assert.equal(section(spec, t('card.subcommands')), undefined)
  })

  it('adminUserCardSpec embeds body + rm/unlink subs + examples', () => {
    const spec = adminUserCardSpec('alice — feishu:ou_abc')
    assert.ok(allText(spec).includes('alice — feishu:ou_abc'))
    const subs = section(spec, t('card.subcommands'))?.rows ?? []
    assert.ok(subs.some(([c]) => c.startsWith('rm')))
    assert.ok(subs.some(([c]) => c.startsWith('unlink')))
    assert.ok(allText(spec).includes('/admin user unlink feishu:ou_xxx'))
  })

  it('adminPairingCardSpec has approve / approve --as / reject', () => {
    const spec = adminPairingCardSpec('7F3K — alice')
    const subs = section(spec, t('card.subcommands'))?.rows ?? []
    assert.equal(subs.length, 3)
    assert.ok(allText(spec).includes('/admin pairing approve 7F3K --as alice'))
  })

  it('adminFeedbackCardSpec embeds body + --page param', () => {
    const spec = adminFeedbackCardSpec('2026-06-20 alice：hi')
    assert.ok(allText(spec).includes('2026-06-20 alice：hi'))
    assert.ok(section(spec, t('card.params'))?.markdown?.includes('--page'))
  })

  it('adminCeilingCardSpec has set sub + ordering note', () => {
    const spec = adminCeilingCardSpec('alice -> ask')
    assert.ok(section(spec, t('card.subcommands'))?.rows?.some(([c]) => c.startsWith('set')))
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.admin.ceiling.note')))
  })

  it('adminSandboxCardSpec has prefetch + reset subs', () => {
    const spec = adminSandboxCardSpec('状态：就绪')
    const subs = section(spec, t('card.subcommands'))?.rows ?? []
    assert.ok(subs.some(([c]) => c === 'prefetch'))
    assert.ok(subs.some(([c]) => c.startsWith('reset')))
  })

  it('adminFeishuDriveCardSpec has list/orphans/rm subs', () => {
    const spec = adminFeishuDriveCardSpec('状态：已就绪')
    const subs = section(spec, t('card.subcommands'))?.rows ?? []
    assert.equal(subs.length, 3)
  })

  it('adminEndpointCardSpec carries the public scope note + codex note', () => {
    const spec = adminEndpointCardSpec([{ name: 'pub-ep', type: 'openai' }])
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.admin.scopeNote')))
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.endpoint.note.codexAuth')))
    assert.ok(allText(spec).includes('/admin endpoint add'))
  })

  it('adminBackendCardSpec has scope note and NO check sub-command', () => {
    const spec = adminBackendCardSpec([{ name: 'm', isDefault: true }])
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.admin.scopeNote')))
    const subs = section(spec, t('card.subcommands'))?.rows ?? []
    assert.ok(!subs.some(([c]) => c.startsWith('check')), 'admin backend has no check')
    assert.ok(section(spec, t('card.params'))?.markdown?.includes('/admin endpoint'))
  })

  it('adminLaneCardSpec carries the public scope note + admin examples', () => {
    const spec = adminLaneCardSpec([{ bucket: 'worker', model: 'm', isDefault: true }])
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.admin.scopeNote')))
    assert.ok(allText(spec).includes('/admin lane set worker'))
  })
})

describe('card-specs batch 7: system key / mount / data', () => {
  it('systemKeyCardSpec renders enabled state + note, hides values', () => {
    const spec = systemKeyCardSpec([
      { name: 'GITHUB_TOKEN', enabled: true },
      { name: 'OPENAI_KEY', enabled: false },
    ])
    const show = section(spec, t('card.system.key.showHeading'))
    assert.ok(show?.markdown?.includes(`GITHUB_TOKEN（${t('secret.state.on')}）`))
    assert.ok(show!.markdown!.includes(`OPENAI_KEY（${t('secret.state.off')}）`))
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.system.key.note')))
    const subs = section(spec, t('card.subcommands'))?.rows ?? []
    assert.equal(subs.length, 4)
  })

  it('systemKeyCardSpec empty shows the empty-state label', () => {
    const spec = systemKeyCardSpec([])
    assert.equal(section(spec, t('card.system.key.showHeading'))?.markdown, t('card.system.key.empty'))
  })

  it('systemMountCardSpec renders ro/rw perms', () => {
    const spec = systemMountCardSpec([
      { path: '/shared/foo', mode: 'ro' },
      { path: '/shared/bar', mode: 'rw' },
    ])
    const show = section(spec, t('card.system.mount.showHeading'))
    assert.ok(show?.markdown?.includes(`/shared/foo（${t('mount.perm.ro')}）`))
    assert.ok(show!.markdown!.includes(`/shared/bar（${t('mount.perm.rw')}）`))
    assert.ok(allText(spec).includes('/system mount add'))
  })

  it('systemDataCardSpec is a pure-operation card: no show-段, two notes', () => {
    const spec = systemDataCardSpec()
    // no show heading (key/mount/configured/current/options all absent)
    for (const h of [
      t('card.system.key.showHeading'),
      t('card.show.configured'),
      t('card.show.current'),
      t('card.show.options'),
    ]) {
      assert.equal(section(spec, h), undefined)
    }
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.system.data.note.feishu')))
    assert.ok(spec.sections.some(s => !s.heading && s.markdown === t('card.system.data.note.scope')))
    assert.ok(section(spec, t('card.params'))?.markdown?.includes('--with-sessions'))
    assert.ok(allText(spec).includes('/system data import --feishu --y'))
  })
})
