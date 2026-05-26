import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  renderSystemPrompt,
  renderSystemPromptSplit,
  type SystemPromptTemplate,
} from './prompt.js'
import type { Tool } from './tool.js'

describe('deferred tool system reminder', () => {
  const template: SystemPromptTemplate = {
    preTodos: 'pre',
    postTodos: 'Available tools:',
  }

  it('lists undiscovered deferred tools outside the main catalog', () => {
    const rendered = renderSystemPrompt(template, [], {
      tools: [fakeTool('Read')],
      deferredTools: [fakeTool('mcp__github__read_file')],
      discoveredTools: new Map(),
    })
    assert.match(rendered, /^- Read$/m)
    assert.match(rendered, /<system-reminder>/)
    assert.match(rendered, /mcp__github__read_file/)
  })

  it('omits already discovered deferred tools from the reminder', () => {
    const rendered = renderSystemPrompt(template, [], {
      tools: [fakeTool('Read'), fakeTool('mcp__github__read_file')],
      deferredTools: [fakeTool('mcp__github__read_file')],
      discoveredTools: new Map([['mcp__github__read_file', 1]]),
    })
    assert.doesNotMatch(rendered, /<system-reminder>/)
  })
})

describe('renderSystemPromptSplit — cache anchoring', () => {
  const template: SystemPromptTemplate = {
    preTodos: 'pre',
    postTodos: 'Available tools:',
  }

  it('keeps stable prefix byte-identical when only the TodoList changes', () => {
    const templateWithTodos = { ...template, includeTodos: true }
    const a = renderSystemPromptSplit(
      templateWithTodos,
      [{ content: 'task A', activeForm: 'doing A', status: 'in_progress' }],
      { tools: [fakeTool('Read')] },
    )
    const b = renderSystemPromptSplit(
      templateWithTodos,
      [{ content: 'task A', activeForm: 'doing A', status: 'completed' }],
      { tools: [fakeTool('Read')] },
    )
    assert.equal(a.stable, b.stable, 'stable prefix must not change with todo state')
    assert.notEqual(a.variable, b.variable, 'variable suffix must reflect todo state')
  })

  it('routes deferred-tools system-reminder into the variable suffix', () => {
    const { stable, variable } = renderSystemPromptSplit(template, [], {
      tools: [fakeTool('Read')],
      deferredTools: [fakeTool('mcp__github__read_file')],
      discoveredTools: new Map(),
    })
    assert.doesNotMatch(stable, /<system-reminder>/)
    assert.match(variable, /<system-reminder>/)
    assert.match(variable, /mcp__github__read_file/)
  })

  it('emits empty variable when no todos and no undiscovered deferred tools', () => {
    const { variable } = renderSystemPromptSplit(template, [], {
      tools: [fakeTool('Read')],
    })
    assert.equal(variable, '')
  })

  // Regression: 2026-05-26 dogfood §cache hit rate root-cause.
  // Even after fix/cache-suffix-relocate moved TodoList + deferred-reminder
  // out of `instructions`, the `## Tool Catalog` section still listed every
  // discovered tool. Each ToolSearch promotion grew that section a few bytes
  // and broke OpenAI's prefix-cache fingerprint anywhere after it. Result:
  // dogfood cache hit ~11% instead of the expected 60-80% — see usage.jsonl
  // 1,536-token-truncation pattern. The fix routes already-discovered tool
  // descriptions into the variable suffix so the stable prefix is invariant
  // under discoveredTools changes.
  describe('cache anchoring under discovered tool promotion', () => {
    it('keeps stable prefix byte-identical when discoveredTools grows', () => {
      const allTools = [
        fakeTool('Bash'),
        fakeTool('Read'),
        fakeTool('ToolSearch'),
        fakeTool('WebSearch'),
        fakeTool('Dispatch'),
      ]
      const inlineCatalogTools = [
        fakeTool('Bash'),
        fakeTool('Read'),
        fakeTool('ToolSearch'),
      ]

      // Turn N: only Bash / Read / ToolSearch are callable.
      const beforePromotion = renderSystemPromptSplit(template, [], {
        tools: inlineCatalogTools,
        inlineCatalogTools,
        discoveredCatalogTools: [],
        deferredTools: [fakeTool('WebSearch'), fakeTool('Dispatch')],
        discoveredTools: new Map(),
      })

      // Turn N+k: model called ToolSearch and promoted WebSearch + Dispatch.
      const afterPromotion = renderSystemPromptSplit(template, [], {
        tools: allTools,
        inlineCatalogTools,
        discoveredCatalogTools: [fakeTool('WebSearch'), fakeTool('Dispatch')],
        deferredTools: [fakeTool('WebSearch'), fakeTool('Dispatch')],
        discoveredTools: new Map([
          ['WebSearch', 5],
          ['Dispatch', 5],
        ]),
      })

      assert.equal(
        beforePromotion.stable,
        afterPromotion.stable,
        'stable prefix must not change when ToolSearch promotes deferred tools',
      )
      assert.notEqual(
        beforePromotion.variable,
        afterPromotion.variable,
        'variable suffix must carry the discovered tool descriptions',
      )
    })

    it('renders discovered tool descriptions in the variable suffix only', () => {
      const inlineCatalogTools = [fakeTool('Bash'), fakeTool('ToolSearch')]
      const { stable, variable } = renderSystemPromptSplit(template, [], {
        tools: [...inlineCatalogTools, fakeTool('WebSearch')],
        inlineCatalogTools,
        discoveredCatalogTools: [fakeTool('WebSearch')],
        deferredTools: [fakeTool('WebSearch')],
        discoveredTools: new Map([['WebSearch', 1]]),
      })
      assert.doesNotMatch(stable, /WebSearch/)
      assert.match(variable, /WebSearch/)
      // The discovered-tools reminder is its own <system-reminder> block,
      // distinct from the undiscovered-deferred reminder (no overlap with
      // the existing test above).
      assert.doesNotMatch(
        variable,
        /are now available via ToolSearch\. Their schemas are NOT loaded/,
      )
    })

    it('omits the discovered-tools section when nothing has been promoted yet', () => {
      const inlineCatalogTools = [fakeTool('Bash'), fakeTool('ToolSearch')]
      const { variable } = renderSystemPromptSplit(template, [], {
        tools: inlineCatalogTools,
        inlineCatalogTools,
        discoveredCatalogTools: [],
        deferredTools: [fakeTool('WebSearch')],
        discoveredTools: new Map(),
      })
      // Variable still carries the undiscovered-deferred reminder; only the
      // new discovered-tools block should be absent.
      assert.doesNotMatch(variable, /were loaded via ToolSearch earlier/)
    })

    it('falls back to rendering full tools[] when inlineCatalogTools is omitted', () => {
      // Backward-compat path: callers that haven't updated still get the
      // pre-fix behavior of rendering the entire tools array in the catalog.
      // This keeps unrelated callers (tests, future custom systemPrompt
      // shapes) from breaking at the type level.
      const { stable } = renderSystemPromptSplit(template, [], {
        tools: [fakeTool('Bash'), fakeTool('Read'), fakeTool('WebSearch')],
      })
      assert.match(stable, /^- Bash$/m)
      assert.match(stable, /^- Read$/m)
      assert.match(stable, /^- WebSearch$/m)
    })
  })
})

// Regression guard against the 2026-05-26 dogfood pattern: the per-turn
// variable suffix is injected into the last user message (b9e53d1). The
// TodoList block was a bare "## Current Todo List ..." prose ending with
// "Use TodoWrite to keep this list current" — placed in user-role content,
// the model read the trailing imperative as a fresh user instruction and
// silently ended its turn instead of continuing the in_progress item. Wrap
// the block in `<system-reminder>` and reword the trailing line so the
// frame is unmistakable.
describe('todo block — system-reminder framing in variable suffix', () => {
  const templateWithTodos: SystemPromptTemplate = {
    preTodos: 'pre',
    postTodos: 'Available tools:',
    includeTodos: true,
  }

  it('wraps the non-empty todo block in <system-reminder>', () => {
    const { variable } = renderSystemPromptSplit(
      templateWithTodos,
      [{ content: 'do A', activeForm: 'doing A', status: 'in_progress' }],
      { tools: [fakeTool('TodoWrite')] },
    )
    assert.match(variable, /<system-reminder>[\s\S]*## Current Todo List[\s\S]*<\/system-reminder>/)
  })

  it('wraps the empty-state todo block in <system-reminder>', () => {
    const { variable } = renderSystemPromptSplit(templateWithTodos, [], {
      tools: [fakeTool('TodoWrite')],
    })
    assert.match(variable, /<system-reminder>[\s\S]*## Current Todo List[\s\S]*\(no todos yet\)[\s\S]*<\/system-reminder>/)
  })

  it('drops the old imperative "Use TodoWrite to keep this list current" trailer', () => {
    const { variable } = renderSystemPromptSplit(
      templateWithTodos,
      [{ content: 'do A', activeForm: 'doing A', status: 'in_progress' }],
      { tools: [fakeTool('TodoWrite')] },
    )
    assert.doesNotMatch(variable, /Use TodoWrite to keep this list current/)
  })

  it('marks the block as framework state, not a fresh user instruction', () => {
    const { variable } = renderSystemPromptSplit(
      templateWithTodos,
      [{ content: 'do A', activeForm: 'doing A', status: 'in_progress' }],
      { tools: [fakeTool('TodoWrite')] },
    )
    assert.match(variable, /not a fresh user instruction/)
  })

  it('keeps the "advance the in_progress item" cue when todos exist', () => {
    const { variable } = renderSystemPromptSplit(
      templateWithTodos,
      [{ content: 'do A', activeForm: 'doing A', status: 'in_progress' }],
      { tools: [fakeTool('TodoWrite')] },
    )
    assert.match(variable, /Keep advancing the in_progress item/)
  })

  it('keeps the "at most one in_progress" invariant in both states', () => {
    const { variable: nonEmpty } = renderSystemPromptSplit(
      templateWithTodos,
      [{ content: 'do A', activeForm: 'doing A', status: 'in_progress' }],
      { tools: [fakeTool('TodoWrite')] },
    )
    const { variable: empty } = renderSystemPromptSplit(templateWithTodos, [], {
      tools: [fakeTool('TodoWrite')],
    })
    assert.match(nonEmpty, /At most one item in_progress/)
    assert.match(empty, /At most one item in_progress/)
  })
})

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    source: name.startsWith('mcp__') ? 'mcp' : 'builtin',
    domain: 'host',
    riskLevel: 'safe',
    async call() {
      return { output: 'ok' }
    },
    formatResult(output, toolUseId) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: String(output),
      }
    },
  }
}
