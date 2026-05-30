import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseArgs } from './cli.js'

describe('cli parseArgs', () => {
  it('detects direct CLI entrypoint without running on import', async () => {
    const { isCliEntrypoint } = await import('./cli.js')

    assert.equal(isCliEntrypoint('file:///tmp/lightclaw/dist/cli.js', '/tmp/lightclaw/dist/cli.js'), true)
    assert.equal(isCliEntrypoint('file:///tmp/lightclaw/dist/cli.js', '/tmp/lightclaw/test.js'), false)
  })

  it('parses daemon defaults', () => {
    assert.deepEqual(parseArgs([]), {
      help: false,
      command: { kind: 'daemon' },
    })
  })

  it('parses run prompt from argv', () => {
    assert.deepEqual(parseArgs(['--home', '/tmp/lc', 'run', 'do', 'the', 'thing']), {
      help: false,
      home: '/tmp/lc',
      command: { kind: 'run', promptParts: ['do', 'the', 'thing'], stdin: false },
    })
  })

  it('parses run --stdin with optional argv prefix', () => {
    assert.deepEqual(parseArgs(['run', '--stdin', 'summarize']), {
      help: false,
      command: { kind: 'run', promptParts: ['summarize'], stdin: true },
    })
  })

  it('rejects run without prompt source', () => {
    assert.match(parseArgs(['run']).error ?? '', /requires a prompt or --stdin/)
  })

  it('rejects unknown run flags', () => {
    assert.equal(parseArgs(['run', '--wat']).error, 'unknown run flag: --wat')
  })
})
