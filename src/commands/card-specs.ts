// L2 detail-card spec builders. Each is a PURE function over the live data the
// handler gathers (model list, current values, …) so the handler stays thin and
// the builder is unit-testable / dogfood-renderable with sample data. The
// handler calls `ctx.setCommandListCard?.(spec)` on the channel and keeps its
// existing plain-text return value as the terminal fallback.
//
// Card structure (per the locked L2 spec): a show-段 section (heading chosen by
// noun type — 可选项 / 已配置 / 当前), then a 子命令 rows section, optional 参数
// markdown + standalone 备注 markdown sections, then a 示例 codeExamples section.
// Example strings are command literals (language-neutral), never i18n'd.

import { t } from '../i18n/index.js'
import type { CommandListCardSection, CommandListCardSpec } from './registry.js'

// ── Spec → terminal-native plain text ────────────────────────────────────────
//
// The terminal admin console has no card surface, so a slash handler that
// renders a `CommandListCardSpec` on the channel returns THIS textification for
// the terminal. Same content as the card (show-段 + 子命令 + 参数 + 备注 + 示例),
// rendered in terminal style: markdown styling (**bold** / `code`) stripped,
// section headings as plain `<heading>：` lines, sub-command rows as indented
// `cmd — desc`, examples indented. This keeps terminal output and the Feishu card
// aligned by construction — one spec, two renderers.
function stripCardMarkup(value: string): string {
  return value.replace(/\*\*/g, '').replace(/`/g, '')
}

export function formatCommandListSpecAsText(spec: CommandListCardSpec): string {
  const out: string[] = []
  if (spec.title) out.push(stripCardMarkup(spec.title), '')
  for (const section of spec.sections) {
    if (section.heading) out.push(`${stripCardMarkup(section.heading)}：`)
    if (section.markdown) out.push(stripCardMarkup(section.markdown))
    for (const [cmd, desc] of section.rows ?? []) {
      out.push(`  ${stripCardMarkup(cmd)} — ${stripCardMarkup(desc)}`)
    }
    for (const example of section.codeExamples ?? []) {
      out.push(`  ${example}`)
    }
    out.push('')
  }
  if (spec.footer) out.push(stripCardMarkup(spec.footer))
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/** A show-段 list item: its rendered label plus the two append-markers. */
export interface ShowItem {
  label: string
  isDefault?: boolean
  isCurrent?: boolean
}

/** Render show items as a 1-based numbered markdown list, appending the
 *  （默认）/ ← 当前 markers (current-marker gets a leading space). */
export function numberedShow(items: readonly ShowItem[]): string {
  return items
    .map((item, i) => {
      let line = `${i + 1}. ${item.label}`
      if (item.isDefault) line += t('card.default')
      if (item.isCurrent) line += ` ${t('card.curMarker')}`
      return line
    })
    .join('\n')
}

// ── /config model (selection) ────────────────────────────────────────────────

export interface ModelShowRow {
  name: string
  isDefault: boolean
  isCurrent: boolean
}

export function configModelCardSpec(models: readonly ModelShowRow[]): CommandListCardSpec {
  const sections: CommandListCardSection[] = []
  sections.push({
    heading: t('card.show.options'),
    markdown:
      models.length === 0
        ? t('card.config.model.empty')
        : numberedShow(models.map(m => ({ label: m.name, isDefault: m.isDefault, isCurrent: m.isCurrent }))),
  })
  sections.push({
    heading: t('card.subcommands'),
    rows: [
      [t('card.config.model.sub.set.cmd'), t('card.config.model.sub.set.desc')],
      [t('card.config.model.sub.reset.cmd'), t('card.config.model.sub.reset.desc')],
    ],
  })
  sections.push({
    heading: t('card.examples'),
    codeExamples: ['/config model set gpt-5.5-high', '/config model reset'],
  })
  return { title: t('card.cmdHelp.title', { cmd: '/config model' }), sections }
}

// ── /config mode (selection + ceiling note) ──────────────────────────────────

/** `current` / `default` / `ceiling` are mode aliases (read|ask|auto|yolo). */
export function configModeCardSpec(args: {
  current: string
  ceiling: string
}): CommandListCardSpec {
  const DEFAULT_MODE = 'ask'
  const opts: ReadonlyArray<readonly [string, string]> = [
    ['read', t('card.config.mode.opt.read')],
    ['ask', t('card.config.mode.opt.ask')],
    ['auto', t('card.config.mode.opt.auto')],
    ['yolo', t('card.config.mode.opt.yolo')],
  ]
  const sections: CommandListCardSection[] = []
  sections.push({
    heading: t('card.show.options'),
    markdown: numberedShow(
      opts.map(([alias, label]) => ({
        label,
        isDefault: alias === DEFAULT_MODE,
        isCurrent: alias === args.current,
      })),
    ),
  })
  // Ceiling is a standalone note element (not folded into the option list).
  sections.push({ markdown: t('card.config.mode.ceiling', { ceiling: args.ceiling }) })
  sections.push({
    heading: t('card.subcommands'),
    rows: [
      [t('card.config.mode.sub.set.cmd'), t('card.config.mode.sub.set.desc')],
      [t('card.config.mode.sub.reset.cmd'), t('card.config.mode.sub.reset.desc')],
    ],
  })
  sections.push({ heading: t('card.examples'), codeExamples: ['/config mode set auto'] })
  return { title: t('card.cmdHelp.title', { cmd: '/config mode' }), sections }
}

// ── /config lang (selection) ─────────────────────────────────────────────────

export function configLangCardSpec(current: 'cn' | 'en'): CommandListCardSpec {
  const DEFAULT_LANG = 'cn'
  const opts: ReadonlyArray<readonly ['cn' | 'en', string]> = [
    ['cn', t('card.config.lang.opt.cn')],
    ['en', t('card.config.lang.opt.en')],
  ]
  const sections: CommandListCardSection[] = []
  sections.push({
    heading: t('card.show.options'),
    markdown: numberedShow(
      opts.map(([code, label]) => ({
        label,
        isDefault: code === DEFAULT_LANG,
        isCurrent: code === current,
      })),
    ),
  })
  sections.push({
    heading: t('card.subcommands'),
    rows: [
      [t('card.config.lang.sub.set.cmd'), t('card.config.lang.sub.set.desc')],
      [t('card.config.lang.sub.reset.cmd'), t('card.config.lang.sub.reset.desc')],
    ],
  })
  sections.push({ heading: t('card.examples'), codeExamples: ['/config lang set en'] })
  return { title: t('card.cmdHelp.title', { cmd: '/config lang' }), sections }
}

// ── /config rule (collection + two notes) ────────────────────────────────────

export interface RuleShowRow {
  behavior: string
  // The pattern, already rendered via formatRule (e.g. "Bash(rm:*)").
  pattern: string
}

export function configRuleCardSpec(rules: readonly RuleShowRow[]): CommandListCardSpec {
  const sections: CommandListCardSection[] = []
  sections.push({
    heading: t('card.show.configured'),
    markdown:
      rules.length === 0
        ? t('card.config.rule.empty')
        : numberedShow(rules.map(r => ({ label: `${r.behavior} — \`${r.pattern}\`` }))),
  })
  // Note about the <n> index — placed before the sub-commands that use it.
  sections.push({ markdown: t('card.config.rule.note.index') })
  sections.push({
    heading: t('card.subcommands'),
    rows: [
      [t('card.config.rule.sub.add.cmd'), t('card.config.rule.sub.add.desc')],
      [t('card.config.rule.sub.addDeny.cmd'), t('card.config.rule.sub.addDeny.desc')],
      [t('card.config.rule.sub.rm.cmd'), t('card.config.rule.sub.rm.desc')],
      [t('card.config.rule.sub.rmAll.cmd'), t('card.config.rule.sub.rmAll.desc')],
    ],
  })
  // Note about the rule format — placed after the sub-commands.
  sections.push({ markdown: t('card.config.rule.note.format') })
  sections.push({
    heading: t('card.examples'),
    codeExamples: [
      '/config rule add Bash(rm:*)',
      '/config rule add Edit(/etc/**) --deny',
      '/config rule rm 1',
    ],
  })
  return { title: t('card.cmdHelp.title', { cmd: '/config rule' }), sections }
}

// ── /config workspace (single value + note) ──────────────────────────────────

export function configWorkspaceCardSpec(args: {
  path: string
  isDefault: boolean
}): CommandListCardSpec {
  const sections: CommandListCardSection[] = []
  sections.push({
    heading: t('card.show.current'),
    markdown: `${args.path}${args.isDefault ? t('card.default') : ''}`,
  })
  sections.push({
    heading: t('card.subcommands'),
    rows: [
      [t('card.config.workspace.sub.set.cmd'), t('card.config.workspace.sub.set.desc')],
      [t('card.config.workspace.sub.reset.cmd'), t('card.config.workspace.sub.reset.desc')],
    ],
  })
  sections.push({ markdown: t('card.config.workspace.note') })
  sections.push({
    heading: t('card.examples'),
    codeExamples: ['/config workspace set /path/to/workspace', '/config workspace reset'],
  })
  return { title: t('card.cmdHelp.title', { cmd: '/config workspace' }), sections }
}

// ── /config lane (per-use single values + note) ──────────────────────────────

export interface LaneShowRow {
  bucket: 'worker' | 'system' | 'image'
  model: string
  isDefault: boolean
}

/** Shared lane show-段 + note + examples builder (config vs admin differ only by
 *  title, an optional scope note, and the command prefix in examples). */
function laneSections(
  rows: readonly LaneShowRow[],
  prefix: string,
  scopeNote?: string,
): CommandListCardSection[] {
  const labelKey = {
    worker: 'card.config.lane.label.worker',
    system: 'card.config.lane.label.system',
    image: 'card.config.lane.label.image',
  } as const
  const lines = rows
    .map(r => `${t(labelKey[r.bucket])}：${r.model}${r.isDefault ? t('card.default') : ''}`)
    .join('\n')
  return [
    { heading: t('card.show.current'), markdown: lines },
    ...(scopeNote ? [{ markdown: scopeNote }] : []),
    {
      heading: t('card.subcommands'),
      rows: [
        [t('card.config.lane.sub.set.cmd'), t('card.config.lane.sub.set.desc')],
        [t('card.config.lane.sub.reset.cmd'), t('card.config.lane.sub.reset.desc')],
      ],
    },
    { markdown: t('card.config.lane.note') },
    { heading: t('card.examples'), codeExamples: [`${prefix} set worker gpt-5.5-high`, `${prefix} reset worker`] },
  ]
}

export function configLaneCardSpec(rows: readonly LaneShowRow[]): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/config lane' }),
    sections: laneSections(rows, '/config lane'),
  }
}

// ── /config endpoint (collection + params + codex note) ──────────────────────

export interface EndpointShowRow {
  name: string
  // 'openai' | 'anthropic' | 'codex'
  type: string
  // Optional non-secret config values rendered in parens, e.g.
  // "type=openai, baseUrl=…, proxy=…". When absent, falls back to `type`.
  details?: string
}

/** Render a params section's bullets: each value is already a `\`--flag\` — desc`
 *  string; the builder only adds the markdown `- ` bullet prefix. */
function paramBullets(values: readonly string[]): string {
  return values.map(v => `- ${v}`).join('\n')
}

export function configEndpointCardSpec(rows: readonly EndpointShowRow[]): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/config endpoint' }),
    sections: [
      {
        heading: t('card.show.configured'),
        markdown:
          rows.length === 0
            ? t('config.endpoint.none')
            : numberedShow(rows.map(r => ({ label: `${r.name}（${r.details ?? r.type}）` }))),
      },
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.config.endpoint.sub.add.cmd'), t('card.config.endpoint.sub.add.desc')],
          [t('card.config.endpoint.sub.set.cmd'), t('card.config.endpoint.sub.set.desc')],
          [t('card.config.endpoint.sub.rm.cmd'), t('card.config.endpoint.sub.rm.desc')],
        ],
      },
      {
        heading: t('card.params'),
        markdown: paramBullets([
          t('card.endpoint.param.type'),
          t('card.endpoint.param.key'),
          t('card.endpoint.param.baseUrl'),
          t('card.endpoint.param.proxy'),
          t('card.endpoint.param.authPath'),
        ]),
      },
      { markdown: t('card.endpoint.note.codexAuth') },
      {
        heading: t('card.examples'),
        codeExamples: [
          '/config endpoint add my-ep --type openai --key sk-xxx',
          '/config endpoint add codex-ep --type codex --auth-path /path/to/auth.json',
          '/config endpoint set my-ep --proxy http://127.0.0.1:1080',
          '/config endpoint rm my-ep',
        ],
      },
    ],
  }
}

// ── /config backend (collection + params) ────────────────────────────────────

export interface BackendShowRow {
  name: string
  isDefault: boolean
  // Optional non-secret config values rendered in parens, e.g.
  // "endpoint=…, upstream=…, schema=…, reasoning=…". Absent → name only.
  details?: string
}

export function configBackendCardSpec(rows: readonly BackendShowRow[]): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/config backend' }),
    sections: [
      {
        heading: t('card.show.configured'),
        markdown:
          rows.length === 0
            ? t('config.backend.none')
            : numberedShow(rows.map(r => ({
                label: r.details ? `${r.name}（${r.details}）` : r.name,
                isDefault: r.isDefault,
              }))),
      },
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.config.backend.sub.add.cmd'), t('card.config.backend.sub.add.desc')],
          [t('card.config.backend.sub.set.cmd'), t('card.config.backend.sub.set.desc')],
          [t('card.config.backend.sub.check.cmd'), t('card.config.backend.sub.check.desc')],
          [t('card.config.backend.sub.rm.cmd'), t('card.config.backend.sub.rm.desc')],
        ],
      },
      {
        heading: t('card.params'),
        markdown: paramBullets([
          t('card.config.backend.param.endpoint'),
          t('card.backend.param.upstream'),
          t('card.backend.param.reasoning'),
          t('card.backend.param.maxTokens'),
          t('card.backend.param.default'),
        ]),
      },
      {
        heading: t('card.examples'),
        codeExamples: [
          '/config backend add gpt-5.5-high --endpoint my-ep --upstream gpt-5.5 --reasoning high',
          '/config backend set gpt-5.5-high --reasoning xhigh --default',
          '/config backend rm gpt-5.5-high',
        ],
      },
    ],
  }
}

// ── /admin ops nouns (live handler text as show-段 + static teaching sections) ─
//
// The ops handlers (cost / user / pairing / feedback / ceiling / sandbox /
// feishu-drive) already produce the canonical formatted live output; embedding
// that text as the show-段 keeps a single source of truth (re-deriving
// structured rows here would duplicate each subsystem's logic and risk drift).
// The card adds the structured 子命令 / 参数 / 备注 / 示例 scaffold around it.

function opsShow(body: string): CommandListCardSection {
  return { markdown: body.trim() }
}

export function adminCostCardSpec(body: string): CommandListCardSpec {
  // Pure display, no sub-commands.
  return { title: t('card.cmdHelp.title', { cmd: '/admin cost' }), sections: [opsShow(body)] }
}

export function adminUserCardSpec(body: string): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin user' }),
    sections: [
      opsShow(body),
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.admin.user.sub.rm.cmd'), t('card.admin.user.sub.rm.desc')],
          [t('card.admin.user.sub.unlink.cmd'), t('card.admin.user.sub.unlink.desc')],
        ],
      },
      {
        heading: t('card.examples'),
        codeExamples: [
          '/admin user rm alice --y',
          '/admin user rm alice --purge --y',
          '/admin user unlink feishu:ou_xxx',
        ],
      },
    ],
  }
}

export function adminPairingCardSpec(body: string): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin pairing' }),
    sections: [
      opsShow(body),
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.admin.pairing.sub.approve.cmd'), t('card.admin.pairing.sub.approve.desc')],
          [t('card.admin.pairing.sub.approveAs.cmd'), t('card.admin.pairing.sub.approveAs.desc')],
          [t('card.admin.pairing.sub.reject.cmd'), t('card.admin.pairing.sub.reject.desc')],
        ],
      },
      {
        heading: t('card.examples'),
        codeExamples: [
          '/admin pairing approve 7F3K',
          '/admin pairing approve 7F3K --as alice',
          '/admin pairing reject 9Q2M',
        ],
      },
    ],
  }
}

export function adminFeedbackCardSpec(body: string): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin feedback' }),
    sections: [
      opsShow(body),
      { heading: t('card.params'), markdown: `- ${t('card.admin.feedback.param.page')}` },
      { heading: t('card.examples'), codeExamples: ['/admin feedback --page 2'] },
    ],
  }
}

export function adminCeilingCardSpec(body: string): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin ceiling' }),
    sections: [
      opsShow(body),
      {
        heading: t('card.subcommands'),
        rows: [[t('card.admin.ceiling.sub.set.cmd'), t('card.admin.ceiling.sub.set.desc')]],
      },
      { markdown: t('card.admin.ceiling.note') },
      { heading: t('card.examples'), codeExamples: ['/admin ceiling set alice ask'] },
    ],
  }
}

export function adminSandboxCardSpec(body: string): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin sandbox' }),
    sections: [
      opsShow(body),
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.admin.sandbox.sub.prefetch.cmd'), t('card.admin.sandbox.sub.prefetch.desc')],
          [t('card.admin.sandbox.sub.reset.cmd'), t('card.admin.sandbox.sub.reset.desc')],
        ],
      },
      { heading: t('card.examples'), codeExamples: ['/admin sandbox prefetch', '/admin sandbox reset --y'] },
    ],
  }
}

export function adminFeishuDriveCardSpec(body: string): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin feishu-drive' }),
    sections: [
      opsShow(body),
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.admin.drive.sub.list.cmd'), t('card.admin.drive.sub.list.desc')],
          [t('card.admin.drive.sub.orphans.cmd'), t('card.admin.drive.sub.orphans.desc')],
          [t('card.admin.drive.sub.rm.cmd'), t('card.admin.drive.sub.rm.desc')],
        ],
      },
      { heading: t('card.examples'), codeExamples: ['/admin feishu-drive list', '/admin feishu-drive rm alice --y'] },
    ],
  }
}

// ── /admin endpoint · backend · lane (structured, + 公共配置 scope note) ───────

export function adminEndpointCardSpec(rows: readonly EndpointShowRow[]): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin endpoint' }),
    sections: [
      {
        heading: t('card.show.configured'),
        markdown:
          rows.length === 0
            ? t('config.endpoint.none')
            : numberedShow(rows.map(r => ({ label: `${r.name}（${r.details ?? r.type}）` }))),
      },
      { markdown: t('card.admin.scopeNote') },
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.admin.endpoint.sub.add.cmd'), t('card.admin.endpoint.sub.add.desc')],
          [t('card.admin.endpoint.sub.set.cmd'), t('card.admin.endpoint.sub.set.desc')],
          [t('card.admin.endpoint.sub.rm.cmd'), t('card.admin.endpoint.sub.rm.desc')],
        ],
      },
      {
        heading: t('card.params'),
        markdown: paramBullets([
          t('card.endpoint.param.type'),
          t('card.endpoint.param.key'),
          t('card.endpoint.param.baseUrl'),
          t('card.endpoint.param.proxy'),
          t('card.endpoint.param.authPath'),
        ]),
      },
      { markdown: t('card.endpoint.note.codexAuth') },
      {
        heading: t('card.examples'),
        codeExamples: [
          '/admin endpoint add my-ep --type openai --key sk-xxx',
          '/admin endpoint add codex-ep --type codex --auth-path /path/to/auth.json',
          '/admin endpoint set my-ep --proxy http://127.0.0.1:1080',
          '/admin endpoint rm my-ep',
        ],
      },
    ],
  }
}

export function adminBackendCardSpec(rows: readonly BackendShowRow[]): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin backend' }),
    sections: [
      {
        heading: t('card.show.configured'),
        markdown:
          rows.length === 0
            ? t('config.backend.none')
            : numberedShow(rows.map(r => ({
                label: r.details ? `${r.name}（${r.details}）` : r.name,
                isDefault: r.isDefault,
              }))),
      },
      { markdown: t('card.admin.scopeNote') },
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.admin.backend.sub.add.cmd'), t('card.admin.backend.sub.add.desc')],
          [t('card.admin.backend.sub.set.cmd'), t('card.admin.backend.sub.set.desc')],
          [t('card.admin.backend.sub.check.cmd'), t('card.admin.backend.sub.check.desc')],
          [t('card.admin.backend.sub.rm.cmd'), t('card.admin.backend.sub.rm.desc')],
        ],
      },
      {
        heading: t('card.params'),
        markdown: paramBullets([
          t('card.admin.backend.param.endpoint'),
          t('card.backend.param.upstream'),
          t('card.backend.param.reasoning'),
          t('card.backend.param.maxTokens'),
          t('card.backend.param.default'),
        ]),
      },
      {
        heading: t('card.examples'),
        codeExamples: [
          '/admin backend add gpt-5.5-high --endpoint my-ep --upstream gpt-5.5 --reasoning high',
          '/admin backend set gpt-5.5-high --reasoning xhigh --default',
          '/admin backend rm gpt-5.5-high',
        ],
      },
    ],
  }
}

export function adminLaneCardSpec(rows: readonly LaneShowRow[]): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin lane' }),
    sections: laneSections(rows, '/admin lane', t('card.admin.scopeNote')),
  }
}

// ── /admin proxy (deployment public proxy fallback) ──────────────────────────

export function adminProxyCardSpec(current: string | undefined): CommandListCardSpec {
  const showLine = current
    ? t('card.admin.proxy.current', { proxy: current })
    : t('card.admin.proxy.none')
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin proxy' }),
    sections: [
      { heading: t('card.admin.proxy.showHeading'), markdown: showLine },
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.admin.proxy.sub.set.cmd'), t('card.admin.proxy.sub.set.desc')],
          [t('card.admin.proxy.sub.clear.cmd'), t('card.admin.proxy.sub.clear.desc')],
        ],
      },
      { markdown: t('card.admin.proxy.note') },
      {
        heading: t('card.examples'),
        codeExamples: ['/admin proxy set http://127.0.0.1:1080', '/admin proxy clear'],
      },
    ],
  }
}

export function adminVersionCardSpec(version: string, build: string): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/admin version' }),
    sections: [
      {
        heading: t('card.admin.version.showHeading'),
        markdown: t('card.admin.version.current', { version, build }),
      },
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.admin.version.sub.update.cmd'), t('card.admin.version.sub.update.desc')],
          [t('card.admin.version.sub.dryRun.cmd'), t('card.admin.version.sub.dryRun.desc')],
        ],
      },
      {
        heading: t('card.examples'),
        codeExamples: ['/admin version update', '/admin version update --dry-run'],
      },
    ],
  }
}

// ── /system key (collection + note) ──────────────────────────────────────────

export interface KeyShowRow {
  name: string
  enabled: boolean
}

export function systemKeyCardSpec(rows: readonly KeyShowRow[]): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/system key' }),
    sections: [
      {
        heading: t('card.system.key.showHeading'),
        markdown:
          rows.length === 0
            ? t('card.system.key.empty')
            : numberedShow(
                rows.map(r => ({
                  label: `${r.name}（${r.enabled ? t('secret.state.on') : t('secret.state.off')}）`,
                })),
              ),
      },
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.system.key.sub.set.cmd'), t('card.system.key.sub.set.desc')],
          [t('card.system.key.sub.enable.cmd'), t('card.system.key.sub.enable.desc')],
          [t('card.system.key.sub.disable.cmd'), t('card.system.key.sub.disable.desc')],
          [t('card.system.key.sub.rm.cmd'), t('card.system.key.sub.rm.desc')],
        ],
      },
      { markdown: t('card.system.key.note') },
      {
        heading: t('card.examples'),
        codeExamples: [
          '/system key set GITHUB_TOKEN ghp_xxx',
          '/system key enable GITHUB_TOKEN',
          '/system key rm GITHUB_TOKEN',
        ],
      },
    ],
  }
}

// ── /system mount (collection + note) ────────────────────────────────────────

export interface MountShowRow {
  path: string
  // 'ro' | 'rw'
  mode: string
}

export function systemMountCardSpec(rows: readonly MountShowRow[]): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/system mount' }),
    sections: [
      {
        heading: t('card.system.mount.showHeading'),
        markdown:
          rows.length === 0
            ? t('card.system.mount.empty')
            : numberedShow(
                rows.map(r => ({
                  label: `${r.path}（${r.mode === 'rw' ? t('mount.perm.rw') : t('mount.perm.ro')}）`,
                })),
              ),
      },
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.system.mount.sub.add.cmd'), t('card.system.mount.sub.add.desc')],
          [t('card.system.mount.sub.rm.cmd'), t('card.system.mount.sub.rm.desc')],
        ],
      },
      { markdown: t('card.system.mount.note') },
      {
        heading: t('card.examples'),
        codeExamples: [
          '/system mount add /shared/data/foo',
          '/system mount rm /shared/data/foo',
        ],
      },
    ],
  }
}

// ── /system data (pure operation: no show-段) ────────────────────────────────

export function systemDataCardSpec(): CommandListCardSpec {
  return {
    title: t('card.cmdHelp.title', { cmd: '/system data' }),
    sections: [
      {
        heading: t('card.subcommands'),
        rows: [
          [t('card.system.data.sub.export.cmd'), t('card.system.data.sub.export.desc')],
          [t('card.system.data.sub.import.cmd'), t('card.system.data.sub.import.desc')],
        ],
      },
      {
        heading: t('card.params'),
        markdown: paramBullets([
          t('card.system.data.param.path'),
          t('card.system.data.param.feishu'),
          t('card.system.data.param.withSessions'),
          t('card.system.data.param.replace'),
          t('card.system.data.param.y'),
        ]),
      },
      { markdown: t('card.system.data.note.feishu') },
      { markdown: t('card.system.data.note.scope') },
      {
        heading: t('card.examples'),
        codeExamples: [
          '/system data export --feishu',
          '/system data export --path ~/backup.zip --with-sessions',
          '/system data import --feishu --y',
        ],
      },
    ],
  }
}
