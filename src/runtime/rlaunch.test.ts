import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../paths.js'
import { workspaceToGpfsMount } from '../identity/paths.js'
import {
  buildLaunchArgs,
  composeExecScript,
  parseWorkerName,
  type RlaunchRuntimeConfig,
} from './rlaunch.js'
import {
  deleteWorkerRecord,
  lookupWorkerRecord,
  writeWorkerRecord,
} from './rlaunch-state.js'
import { translateRlaunchError } from './rlaunch-errors.js'
import { WorkerReadinessTracker } from './worker-readiness.js'

describe('parseWorkerName', () => {
  it('parses real rlaunch detached output', () => {
    const output = [
      'time="2026-05-01T15:20:09+08:00" level=info msg="Checking image..."',
      'Launching detach mode...',
      'create podgroup queue-name=ailab-hs-hs-gpu group-name=ws-6132b9cf57844a3a-task-t6fw6',
      '当前任务排队策略: 柔性资源优先',
      'ws-6132b9cf57844a3a-worker-c8hlj',
    ].join('\n')
    assert.equal(parseWorkerName(output), 'ws-6132b9cf57844a3a-worker-c8hlj')
  })

  it('ignores logs when no worker name exists', () => {
    assert.equal(parseWorkerName('Launching detach mode...\nfailed'), null)
  })
})

describe('workspaceToGpfsMount', () => {
  const savedWorkspaceRoot = process.env.LIGHTCLAW_WORKSPACE_ROOT

  afterEach(() => {
    if (savedWorkspaceRoot === undefined) {
      delete process.env.LIGHTCLAW_WORKSPACE_ROOT
    } else {
      process.env.LIGHTCLAW_WORKSPACE_ROOT = savedWorkspaceRoot
    }
  })

  it('maps a host gpfs workspace root to an rlaunch mount URL', () => {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = '/mnt/shared-storage-user/ailab-hs/zouyicheng/lightclaw-workspaces'
    assert.deepEqual(workspaceToGpfsMount('alice', {
      gpfsHostPrefix: '/mnt/shared-storage-user',
      gpfsMountPrefix: 'gpfs://gpfs1',
    }), {
      hostPath: '/mnt/shared-storage-user/ailab-hs/zouyicheng/lightclaw-workspaces/alice',
      mount: 'gpfs://gpfs1/ailab-hs/zouyicheng/lightclaw-workspaces/alice:/workspace',
    })
  })

  it('rejects non-gpfs workspace roots', () => {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = '/home/zouyicheng/lightclaw-workspaces'
    assert.throws(() => workspaceToGpfsMount('alice', {
      gpfsHostPrefix: '/mnt/shared-storage-user',
      gpfsMountPrefix: 'gpfs://gpfs1',
    }), /requires LIGHTCLAW_WORKSPACE_ROOT/)
  })
})

describe('Rlaunch worker state', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'lightclaw-rlaunch-test-'))
    setLightclawHomeOverride(home)
  })

  afterEach(() => {
    setLightclawHomeOverride(undefined)
    rmSync(home, { recursive: true, force: true })
  })

  it('writes, reads, and deletes worker records', async () => {
    await writeWorkerRecord('alice', {
      name: 'ws-x-worker-y',
      namespace: 'ailab-hs',
      chargedGroup: 'hs_gpu',
      image: 'registry/image:tag',
      deploymentHash: 'abc12345',
      createdAt: 123,
    })
    assert.equal(lookupWorkerRecord('alice')?.name, 'ws-x-worker-y')
    await deleteWorkerRecord('alice')
    assert.equal(lookupWorkerRecord('alice'), undefined)
  })

  it('preserves all entries under concurrent writes for different users', async () => {
    const users = ['alice', 'bob', 'carol', 'dave', 'eve']
    await Promise.all(users.map(user =>
      writeWorkerRecord(user, {
        name: `ws-${user}`,
        namespace: 'ailab-hs',
        chargedGroup: 'hs_gpu',
        image: 'registry/image:tag',
        deploymentHash: 'abc12345',
        createdAt: 1,
      }),
    ))
    for (const user of users) {
      assert.equal(lookupWorkerRecord(user)?.name, `ws-${user}`,
        `expected user ${user} to survive concurrent writes`)
    }
  })
})

describe('WorkerReadinessTracker', () => {
  it('tracks scheduling, ready, failed, and quota denied states', () => {
    const tracker = new WorkerReadinessTracker('alice')
    assert.equal(tracker.snapshot().state, 'not-attempted')
    tracker.startSchedule('image:tag')
    assert.equal(tracker.snapshot().state, 'scheduling')
    assert.equal(tracker.snapshot().image, 'image:tag')
    tracker.markReady()
    assert.equal(tracker.snapshot().state, 'ready')
    tracker.markFailed('boom')
    assert.equal(tracker.snapshot().state, 'failed')
    assert.equal(tracker.snapshot().lastError, 'boom')
    tracker.markQuotaDenied('quota')
    assert.equal(tracker.snapshot().state, 'quota-denied')
  })
})

describe('buildLaunchArgs', () => {
  const baseCfg: RlaunchRuntimeConfig = {
    canonicalUser: 'alice',
    deploymentHash: 'abc12345',
    image: 'registry/x:tag',
    chargedGroup: 'hs_cpu',
    namespace: 'ailab-hs',
    cpu: 8,
    memoryMb: 16000,
    gpu: 0,
    privateMachine: 'group',
    positiveTags: [],
    workerGcTimeHours: 24,
    imagePullPolicy: 'IfNotPresent',
    maxWaitDuration: '5m',
    predictBeforeStart: true,
    workspaceHostPath: '/mnt/host/alice',
    workspaceGpfsMount: 'gpfs://gpfs1/ns/u/alice:/workspace',
    workspaceContainerPath: '/workspace',
    helperContainerPath: '/opt/lightclaw/sandbox-helpers',
    env: {},
  }

  it('emits --set-env=KEY=VAL for every env entry on detached spawn', () => {
    const args = buildLaunchArgs(
      { ...baseCfg, env: { http_proxy: 'http://10.0.0.1:18080', no_proxy: 'localhost' } },
      { detach: true, predictOnly: false },
    )
    const setEnvFlags = args.filter(arg => arg.startsWith('--set-env=')).sort()
    assert.deepEqual(setEnvFlags, [
      '--set-env=http_proxy=http://10.0.0.1:18080',
      '--set-env=no_proxy=localhost',
    ])
    assert.equal(
      args.includes('-e'),
      false,
      'must not use -e; rlaunch silently drops it on detached spawn',
    )
    assert.equal(args[0], '-d', 'detach prepends -d')
  })

  it('emits env on predict-only and stops at -- bash', () => {
    const args = buildLaunchArgs(
      { ...baseCfg, env: { http_proxy: 'http://h:1' } },
      { detach: false, predictOnly: true },
    )
    const tail = args.slice(-3)
    assert.deepEqual(tail, ['--predict-only=true', '--', 'bash'])
    assert.ok(
      args.some(arg => arg.startsWith('--set-env=')),
      'predict still inherits env so failures fail-fast',
    )
  })

  it('omits --set-env when env is empty', () => {
    const args = buildLaunchArgs(baseCfg, { detach: true, predictOnly: false })
    assert.equal(args.some(arg => arg.startsWith('--set-env=')), false)
  })
})

describe('composeExecScript', () => {
  it('emits a plain `cd && cmd` script when no stdin / env are supplied', () => {
    const script = composeExecScript({ command: 'ls -la', cwd: '/workspace' })
    assert.equal(script, "cd '/workspace' && ls -la")
    // No -i flag is added by runBrainctlExec, but the script itself must also
    // not contain anything that depends on brainctl's broken stdin pipe.
    assert.equal(script.includes('base64 -d'), false)
    assert.equal(script.includes('printf'), false)
  })

  it('exports env vars before the cd, with shell-safe quoting', () => {
    const script = composeExecScript({
      command: 'python3 helper.py',
      env: { BRAVE_SEARCH_API_KEY: "abc'def", FOO: '$BAR' },
      cwd: '/workspace',
    })
    assert.match(script, /^export BRAVE_SEARCH_API_KEY='abc'\\''def'; /)
    assert.match(script, / export FOO='\$BAR'; /)
    assert.match(script, / cd '\/workspace' && python3 helper.py$/)
  })

  it('folds stdin into the command body via base64 inline + brace group', () => {
    const payload = '{"query":"hello","max_results":3}'
    const script = composeExecScript({
      command: 'python3 /opt/lightclaw/sandbox-helpers/websearch.py',
      cwd: '/workspace',
      stdin: payload,
    })
    const expectedB64 = Buffer.from(payload).toString('base64')
    assert.ok(
      script.includes(`{ printf %s '${expectedB64}' | base64 -d; }`),
      `script must inline base64 payload: ${script}`,
    )
    assert.ok(
      script.includes('| { python3 /opt/lightclaw/sandbox-helpers/websearch.py; }'),
      'command must be wrapped in `{ ...; }` so the pipe feeds the whole chain',
    )
    assert.equal(script.startsWith("cd '/workspace' && "), true)
  })

  it('round-trips binary payloads through base64 (no escaping needed)', () => {
    // bytes 0x00..0xff except newlines; covers null, quotes, dollar, backslash
    const buf = Buffer.from(
      Array.from({ length: 256 }, (_, i) => i).filter(b => b !== 0x0a),
    )
    const script = composeExecScript({
      command: 'cat > /tmp/bin',
      cwd: '/workspace',
      stdin: buf,
    })
    const b64 = buf.toString('base64')
    assert.ok(script.includes(`'${b64}'`), 'base64 must be single-quote enclosed')
    // base64 alphabet [A-Za-z0-9+/=] never contains `'`, so quoting is trivial.
    assert.equal(b64.includes("'"), false)
  })

  it('throws when stdin exceeds the 32 KB inline cap (brainctl ws-frame headroom)', () => {
    // Cap is sized for brainctl's ~56 KB ws-frame ceiling — empirically the
    // first failure on this cluster is around 43 KB raw / 57 KB b64. 32 KB
    // raw → 43 KB b64 → ~44 KB script with wrap + room for env exports and
    // long container paths. fs.writeFile chunks transparently above this;
    // direct exec callers must refactor to write-then-read for big payloads.
    const ok = Buffer.alloc(32 * 1024, 0x41)
    assert.doesNotThrow(() => composeExecScript({ command: 'cat', cwd: '/workspace', stdin: ok }))
    const oversized = Buffer.alloc(32 * 1024 + 1, 0x41)
    assert.throws(
      () => composeExecScript({ command: 'cat', cwd: '/workspace', stdin: oversized }),
      /exceeds inline limit/,
    )
  })

  it('treats empty stdin as an explicit empty pipe (caller asked for stdin)', () => {
    const script = composeExecScript({ command: 'cat', cwd: '/workspace', stdin: '' })
    // Empty payload still produces the pipeline; the helper sees EOF on first
    // read, same as if we had passed nothing — keeping the path uniform avoids
    // a surprise difference between `stdin: undefined` and `stdin: ''`.
    assert.ok(script.includes('base64 -d'))
    assert.ok(script.includes('| { cat; }'))
  })

  it('drops the env exports section entirely when env is an empty object', () => {
    const script = composeExecScript({ command: 'ls', cwd: '/workspace', env: {} })
    assert.equal(script.startsWith('export '), false)
    assert.equal(script, "cd '/workspace' && ls")
  })

  it('preserves complex commands inside the brace group when stdin is present', () => {
    // Mirrors fs.writeFile's command shape — the brace group must protect the
    // chain so `cat` (not `mkdir`) receives the piped bytes.
    const script = composeExecScript({
      command: 'mkdir -p "$(dirname \'/tmp/x\')" && cat > \'/tmp/x\' && stat -c %s \'/tmp/x\'',
      cwd: '/workspace',
      stdin: 'payload',
    })
    assert.ok(
      script.includes(
        '| { mkdir -p "$(dirname \'/tmp/x\')" && cat > \'/tmp/x\' && stat -c %s \'/tmp/x\'; }',
      ),
      'whole && chain must be inside the brace group',
    )
  })
})

describe('translateRlaunchError', () => {
  it('recognizes quota errors', () => {
    const translated = translateRlaunchError('insufficient group quota: GPU: 20/5')
    assert.match(translated.admin, /quota denied/i)
    assert.match(translated.suggestion, /配额/)
  })

  it('recognizes image pull failures', () => {
    const translated = translateRlaunchError('ImagePullBackOff')
    assert.match(translated.admin, /image pull failed/i)
    assert.match(translated.suggestion, /registry/)
  })

  it('falls back for unknown errors', () => {
    const translated = translateRlaunchError('something odd')
    assert.match(translated.admin, /RlaunchRuntime failed/)
  })
})
