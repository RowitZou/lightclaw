import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Role } from '../agents/types.js'
import {
  deleteMemoryFile,
  loadMemoryIndex,
  parseFrontmatter,
  scanMemoryFiles,
  scanMemoryFilesInDirs,
  serializeFrontmatter,
  withIndexRebuildLock,
  writeMemoryFile,
} from './auto-memory.js'
import { resolveReadableMemoryDirsForRole } from './scope.js'

let tmpRoot = ''
let memoryDir = ''

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'lightclaw-auto-memory-'))
  memoryDir = path.join(tmpRoot, 'memory', 'alice')
})

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

describe('role-scoped memory indexes', () => {
  it('treats missing role-private directories as empty', async () => {
    assert.deepEqual(
      await scanMemoryFilesInDirs(memoryDir, [path.join(memoryDir, 'webSearcher')]),
      [],
    )
  })

  it('prefixes shared and role-private index entries for orchestrator and worker views', async () => {
    await seed()

    const mainIndex = await loadMemoryIndex(memoryDir, mainRole())
    assert.match(mainIndex, /root-note\.md/)
    assert.match(mainIndex, /_shared\/shared-note\.md/)
    assert.doesNotMatch(mainIndex, /webSearcher\/webSearcher-note\.md/)

    const webIndex = await loadMemoryIndex(memoryDir, webRole())
    assert.match(webIndex, /webSearcher\/webSearcher-note\.md/)
    assert.match(webIndex, /_shared\/shared-note\.md/)
    assert.match(webIndex, /root-note\.md/)
  })

  it('returns three-layer readable memories for default worker roles', async () => {
    await seed()
    const resolved = await resolveReadableMemoryDirsForRole(workerRole('localExplorer'), memoryDir)

    assert.deepEqual(resolved.readableDirs, [
      memoryDir,
      path.join(memoryDir, '_shared'),
      path.join(memoryDir, 'localExplorer'),
    ])
    const index = await loadMemoryIndex(memoryDir, workerRole('localExplorer'))
    assert.match(index, /root-note\.md/)
    assert.match(index, /_shared\/shared-note\.md/)
    assert.doesNotMatch(index, /webSearcher\/webSearcher-note\.md/)
    assert.deepEqual(
      new Set((await scanMemoryFilesInDirs(memoryDir, resolved.readableDirs)).map(entry => entry.filename)),
      new Set(['root-note.md', '_shared/shared-note.md']),
    )
  })
})

// The lost-update B4 fixes is a scan→publish race inside rebuildMemoryIndex: two
// concurrent rebuilders on one tier dir can each scan, then publish so an older
// snapshot lands last and drops a committed entry from MEMORY.md. safeWriteFile
// only makes the *publish* atomic; the fix adds a per-dir lock that serializes
// the whole scan→publish. The race itself is timing-sensitive and does not
// reproduce deterministically on a fast disk (readFile never blocks long enough
// for an older scan to overtake), so these tests pin the serialization guarantee
// the fix provides — that guarantee is what makes the lost-update impossible.
describe('withIndexRebuildLock serialization', () => {
  it('runs same-dir critical sections one at a time, in call order', async () => {
    const events: string[] = []
    let active = 0
    let maxActive = 0
    const section = (id: string) => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      events.push(`enter:${id}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      events.push(`exit:${id}`)
      active -= 1
      return id
    }

    const results = await Promise.all([
      withIndexRebuildLock('/dir', section('a')),
      withIndexRebuildLock('/dir', section('b')),
      withIndexRebuildLock('/dir', section('c')),
    ])

    // Never two critical sections in flight at once → no interleaved scan/publish.
    assert.equal(maxActive, 1)
    // FIFO: each completes fully before the next begins.
    assert.deepEqual(events, ['enter:a', 'exit:a', 'enter:b', 'exit:b', 'enter:c', 'exit:c'])
    assert.deepEqual(results, ['a', 'b', 'c'])
  })

  it('does not serialize across different dirs', async () => {
    let active = 0
    let maxActive = 0
    const section = () => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
    }

    await Promise.all([
      withIndexRebuildLock('/dirA', section()),
      withIndexRebuildLock('/dirB', section()),
    ])

    // Different tier dirs (root / _shared / <role>) must run concurrently.
    assert.equal(maxActive, 2)
  })

  it('keys by resolved path so ./x and x/ contend', async () => {
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const section = (id: string) => async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(id)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
    }

    await Promise.all([
      withIndexRebuildLock('/tmp/mem', section('plain')),
      withIndexRebuildLock('/tmp/mem/', section('trailing-slash')),
      withIndexRebuildLock('/tmp/mem/../mem', section('dotdot')),
    ])

    assert.equal(maxActive, 1)
    assert.deepEqual(order, ['plain', 'trailing-slash', 'dotdot'])
  })

  it('a rejecting section does not wedge the chain', async () => {
    await assert.rejects(
      withIndexRebuildLock('/dir', async () => {
        throw new Error('boom')
      }),
      /boom/,
    )
    // The next op on the same key still runs.
    const out = await withIndexRebuildLock('/dir', async () => 'ok')
    assert.equal(out, 'ok')
  })
})

describe('rebuildMemoryIndex concurrent path', () => {
  // Integration smoke for the locked path: a storm of concurrent writes + delete
  // rebuilds must settle (no deadlock / unhandled rejection from the lock
  // wrapper) and leave MEMORY.md consistent with the files actually on disk.
  it('settles to an index matching on-disk files under a concurrent storm', async () => {
    const writes = 80
    await Promise.all([
      ...Array.from({ length: writes }, (_unused, index) =>
        writeMemoryFile(memoryDir, memory(`live-${index}`, `body ${index}`)),
      ),
      ...Array.from({ length: 40 }, (_unused, index) =>
        deleteMemoryFile(memoryDir, `ghost-${index}`),
      ),
    ])

    const onDisk = new Set((await scanMemoryFiles(memoryDir)).map(entry => entry.filename))
    const indexed = new Set(
      (await readFile(path.join(memoryDir, 'MEMORY.md'), 'utf8'))
        .split('\n')
        .map(line => line.match(/^- \[[^\]]+\] (\S+):/)?.[1])
        .filter((name): name is string => Boolean(name)),
    )
    assert.deepEqual([...indexed].sort(), [...onDisk].sort())
    assert.equal(indexed.size, writes)
  })
})

async function seed(): Promise<void> {
  await writeMemoryFile(memoryDir, memory('root-note', 'root detail'))
  await writeMemoryFile(path.join(memoryDir, '_shared'), memory('shared-note', 'shared detail'))
  await writeMemoryFile(path.join(memoryDir, 'webSearcher'), memory('webSearcher-note', 'webSearcher detail'))
}

function memory(filename: string, content: string) {
  return {
    filename,
    type: 'project' as const,
    description: `${filename} description`,
    content,
    mtimeMs: Date.now(),
  }
}

function mainRole(): Role {
  return {
    agentType: 'main',
    kind: 'orchestrator',
    whenToUse: 'main',
    tools: ['*'],
    systemPrompt: 'system',
  }
}

function workerRole(agentType: string): Role {
  return {
    agentType,
    kind: 'worker',
    whenToUse: 'worker',
    tools: ['MemoryRead'],
    systemPrompt: 'system',
  }
}

function webRole(): Role {
  return workerRole('webSearcher')
}

describe('parseFrontmatter', () => {
  it('parses block-style YAML list (regression guard)', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nname: foo\nroles:\n  - main\n  - web\n---\nbody\n',
    )
    assert.deepEqual(frontmatter.roles, ['main', 'web'])
  })

  it('parses single-element flow-style array: roles: [main]', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nname: foo\nroles: [main]\n---\nbody\n',
    )
    assert.deepEqual(frontmatter.roles, ['main'])
  })

  it('parses multi-element flow-style array: roles: [main, web]', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nname: foo\nroles: [main, web]\n---\nbody\n',
    )
    assert.deepEqual(frontmatter.roles, ['main', 'web'])
  })

  it('parses empty flow-style array: roles: []', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nname: foo\nroles: []\n---\nbody\n',
    )
    assert.deepEqual(frontmatter.roles, [])
  })

  it('trims whitespace in flow-style entries', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nname: foo\nroles: [ main , web ]\n---\nbody\n',
    )
    assert.deepEqual(frontmatter.roles, ['main', 'web'])
  })

  it('unquotes quoted entries inside flow-style array', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nname: foo\nroles: ["main", \'web\']\n---\nbody\n',
    )
    assert.deepEqual(frontmatter.roles, ['main', 'web'])
  })

  it('non-list scalar values remain strings', () => {
    const { frontmatter } = parseFrontmatter(
      '---\ndescription: hello world\nname: foo\n---\nbody\n',
    )
    assert.equal(frontmatter.description, 'hello world')
    assert.equal(frontmatter.name, 'foo')
  })

  it('parses literal block scalars for multiline skill frontmatter', () => {
    const { frontmatter } = parseFrontmatter(
      [
        '---',
        'name: cluster-flow',
        'dispatch_brief: |',
        '  First line.',
        '  Second line.',
        'roles:',
        '  - coder',
        '---',
        'body',
      ].join('\n'),
    )
    assert.equal(frontmatter.dispatch_brief, 'First line.\nSecond line.')
    assert.deepEqual(frontmatter.roles, ['coder'])
  })
})

describe('serializeFrontmatter frontmatter dedup', () => {
  const countDelimiters = (out: string): number =>
    out.split('\n').filter(line => line.trim() === '---').length

  it('does not stack a second frontmatter block when the body already carries one', () => {
    // Reproduces the MemoryWriteAt consolidation double-frontmatter: the caller
    // passes a body that already opens with its own type/description block.
    const body = '---\ntype: project\ndescription: existing one\n---\n\nThe real memory body.'
    const out = serializeFrontmatter({ type: 'project', description: 'canonical one' }, body)

    assert.equal(countDelimiters(out), 2, 'expected exactly one opening + one closing delimiter')
    assert.match(out, /description: canonical one/)
    assert.doesNotMatch(out, /description: existing one/)
    assert.match(out, /The real memory body\./)
  })

  it('leaves a body without frontmatter untouched', () => {
    const out = serializeFrontmatter({ type: 'project', description: 'x' }, 'Plain body, no frontmatter.')
    assert.equal(countDelimiters(out), 2)
    assert.match(out, /Plain body, no frontmatter\./)
  })

  it('does not strip a leading thematic-break that is not memory frontmatter', () => {
    // A body that opens with `---` but no type/description must be preserved —
    // only a genuine duplicated memory frontmatter block is stripped.
    const body = '---\nsome heading rule\n---\nkept body'
    const out = serializeFrontmatter({ type: 'project', description: 'x' }, body)
    assert.match(out, /some heading rule/)
  })
})
