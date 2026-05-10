import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../paths.js'
import { workspaceToGpfsMount } from '../identity/paths.js'
import {
  buildLaunchArgs,
  composeExecScript,
  parseWorkerName,
  readFileViaExec,
  READ_FILE_CHUNK_BYTES_FOR_TESTS,
  RlaunchRuntime,
  type RlaunchRuntimeConfig,
} from './rlaunch.js'
import type { ExecInput, ExecResult } from './types.js'
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

describe('readFileViaExec (rlaunch chunked readFile)', () => {
  // Builds a stub exec that simulates `stat` and `dd | base64 -w 0` /
  // `base64 -w 0` against an in-memory `payload` Buffer. Captures every
  // exec command for assertion.
  function makeStubExec(payload: Buffer): {
    exec: (input: ExecInput) => Promise<ExecResult>
    commands: string[]
  } {
    const commands: string[] = []
    const exec = async (input: ExecInput): Promise<ExecResult> => {
      commands.push(input.command)
      const cmd = input.command
      if (cmd.startsWith('stat -c %s ')) {
        return { stdout: `${payload.length}\n`, stderr: '', exitCode: 0 }
      }
      const ddMatch = cmd.match(/bs=(\d+) skip=(\d+) count=1/)
      if (ddMatch) {
        const bs = Number(ddMatch[1])
        const skip = Number(ddMatch[2])
        const start = bs * skip
        const end = Math.min(start + bs, payload.length)
        const slice = payload.subarray(start, end)
        return { stdout: slice.toString('base64'), stderr: '', exitCode: 0 }
      }
      if (cmd.startsWith('base64 -w 0 ')) {
        return { stdout: payload.toString('base64'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: `unknown command in stub: ${cmd}`, exitCode: 1 }
    }
    return { exec, commands }
  }

  it('takes the single-hop fast path for small files', async () => {
    const payload = Buffer.from('hello world', 'utf8')
    const { exec, commands } = makeStubExec(payload)
    const out = await readFileViaExec(exec, '/workspace/file.txt', '/workspace/file.txt')
    assert.deepEqual(out, payload)
    // Expect: stat + base64 (NOT dd) — i.e. exactly 2 hops.
    assert.equal(commands.length, 2)
    assert.match(commands[0], /^stat -c %s /)
    assert.match(commands[1], /^base64 -w 0 /)
    assert.equal(commands.some(c => c.includes('dd if=')), false)
  })

  it('chunks large files via dd skip=K count=1', async () => {
    // Just over one chunk so we exercise the chunked branch with minimal data.
    const totalBytes = READ_FILE_CHUNK_BYTES_FOR_TESTS + 100
    const payload = Buffer.alloc(totalBytes)
    for (let i = 0; i < totalBytes; i += 1) payload[i] = i % 256
    const { exec, commands } = makeStubExec(payload)
    const out = await readFileViaExec(exec, '/workspace/big.bin', '/workspace/big.bin')
    assert.equal(out.length, totalBytes)
    assert.deepEqual(out, payload)
    // 1 stat + 2 dd hops (chunk 0 covers full chunk, chunk 1 covers 100 bytes).
    assert.equal(commands.length, 3)
    assert.match(commands[0], /^stat -c %s /)
    assert.match(commands[1], /dd if=.* bs=\d+ skip=0 count=1 status=none/)
    assert.match(commands[2], /dd if=.* bs=\d+ skip=1 count=1 status=none/)
  })

  it('round-trips a 30 MB binary payload byte-for-byte', async () => {
    const totalBytes = 30 * 1024 * 1024
    const payload = Buffer.alloc(totalBytes)
    // Pseudo-random fill that makes byte mismatches obvious. xorshift32 keeps
    // the test fast vs. crypto.randomBytes on a 30 MB buffer.
    let seed = 0x9e3779b9
    for (let i = 0; i < totalBytes; i += 1) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      payload[i] = seed & 0xff
    }
    const { exec, commands } = makeStubExec(payload)
    const out = await readFileViaExec(exec, '/workspace/30mb.bin', '/workspace/30mb.bin')
    assert.equal(out.length, totalBytes)
    assert.equal(Buffer.compare(out, payload), 0)
    // 30 MB / 512 KB chunk = 60 dd hops + 1 stat.
    const expectedChunkCount = Math.ceil(totalBytes / READ_FILE_CHUNK_BYTES_FOR_TESTS)
    assert.equal(commands.length, expectedChunkCount + 1)
  })

  it('throws when stat reports a non-numeric size', async () => {
    const exec = async (): Promise<ExecResult> => ({
      stdout: 'not-a-number\n',
      stderr: '',
      exitCode: 0,
    })
    await assert.rejects(
      readFileViaExec(exec, '/workspace/x', '/workspace/x'),
      /invalid stat size/,
    )
  })

  it('throws on byte mismatch after assembly', async () => {
    // stat says 1000 bytes, but the chunk hops only return 100. The mismatch
    // guard is a tripwire for partial reads (truncated container output, dd
    // count desync) — without it large files would silently corrupt.
    const exec = async (input: ExecInput): Promise<ExecResult> => {
      if (input.command.startsWith('stat -c %s ')) {
        return { stdout: '1000\n', stderr: '', exitCode: 0 }
      }
      // dd hops: return exactly 100 bytes total (truncate after first chunk).
      if (input.command.includes('skip=0')) {
        return { stdout: Buffer.alloc(100, 0xab).toString('base64'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: '', exitCode: 0 }
    }
    // Force chunked path: total > READ_FILE_CHUNK_BYTES would normally chunk,
    // but here total=1000 is below the threshold so stat-says-1000 actually
    // goes single-hop. We exercise the mismatch branch by returning 100-byte
    // single-hop instead of the full 1000.
    await assert.rejects(
      readFileViaExec(
        async input => {
          if (input.command.startsWith('stat -c %s ')) {
            return { stdout: `${READ_FILE_CHUNK_BYTES_FOR_TESTS + 50}\n`, stderr: '', exitCode: 0 }
          }
          // Both dd hops return only 50 bytes each, so assembled = 100 bytes
          // but stat said chunkSize+50 — guard fires.
          return { stdout: Buffer.alloc(50, 0xcd).toString('base64'), stderr: '', exitCode: 0 }
        },
        '/workspace/short.bin',
        '/workspace/short.bin',
      ),
      /byte mismatch/,
    )
  })

  it('propagates exec failure with chunk index in the error', async () => {
    const exec = async (input: ExecInput): Promise<ExecResult> => {
      if (input.command.startsWith('stat -c %s ')) {
        return { stdout: `${READ_FILE_CHUNK_BYTES_FOR_TESTS * 3}\n`, stderr: '', exitCode: 0 }
      }
      if (input.command.includes('skip=2')) {
        return { stdout: '', stderr: 'no space left on device', exitCode: 1 }
      }
      return { stdout: Buffer.alloc(READ_FILE_CHUNK_BYTES_FOR_TESTS).toString('base64'), stderr: '', exitCode: 0 }
    }
    await assert.rejects(
      readFileViaExec(exec, '/workspace/y', '/workspace/y'),
      /chunk 2\/3.*no space left/,
    )
  })
})

describe('RlaunchRuntime.fs.writeFileViaHostMount (host-side bind-mount fast path)', () => {
  let hostRoot: string
  let runtime: RlaunchRuntime

  beforeEach(() => {
    hostRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-fastwrite-test-'))
    const config: RlaunchRuntimeConfig = {
      canonicalUser: 'alice',
      deploymentHash: 'abc12345',
      image: 'registry/x:tag',
      chargedGroup: 'hs_cpu',
      namespace: 'ailab-hs',
      cpu: 1,
      memoryMb: 1024,
      gpu: 0,
      privateMachine: 'group',
      positiveTags: [],
      workerGcTimeHours: 1,
      imagePullPolicy: 'IfNotPresent',
      maxWaitDuration: '5m',
      predictBeforeStart: false,
      workspaceHostPath: hostRoot,
      workspaceGpfsMount: 'gpfs://gpfs1/ns/u/alice:/workspace',
      workspaceContainerPath: '/workspace',
      helperContainerPath: '/opt/lightclaw/sandbox-helpers',
      env: {},
    }
    runtime = new RlaunchRuntime(config, new WorkerReadinessTracker('alice'))
  })

  afterEach(() => {
    rmSync(hostRoot, { recursive: true, force: true })
  })

  it('writes via host fs when the container path is inside the bind mount', async () => {
    const fastWrite = runtime.fs.writeFileViaHostMount
    assert.ok(fastWrite, 'rlaunch fs must expose writeFileViaHostMount')

    const payload = Buffer.from('hello fastpath', 'utf8')
    const result = await fastWrite.call(
      runtime.fs,
      '/workspace/.lightclaw/inbox/oc_chat/photo.jpg',
      payload,
    )
    assert.deepEqual(result, { ok: true })

    // The reverse mapping must land the file under the host root, mirroring
    // the worker-side container path. The bind mount will then make it
    // visible at /workspace/... inside the worker without any further work.
    const expectedHost = path.join(hostRoot, '.lightclaw', 'inbox', 'oc_chat', 'photo.jpg')
    const onDisk = readFileSync(expectedHost)
    assert.equal(Buffer.compare(onDisk, payload), 0)
  })

  it('accepts a host-rooted path as input as well', async () => {
    const fastWrite = runtime.fs.writeFileViaHostMount!
    const payload = Buffer.from('host-rooted', 'utf8')
    const hostInput = path.join(hostRoot, 'a', 'b.txt')
    const result = await fastWrite.call(runtime.fs, hostInput, payload)
    assert.deepEqual(result, { ok: true })
    assert.equal(readFileSync(hostInput, 'utf8'), 'host-rooted')
  })

  it('returns null without writing when the path falls outside every mount entry', async () => {
    const fastWrite = runtime.fs.writeFileViaHostMount!
    // /opt is neither the container prefix (/workspace) nor under the host
    // workspace root we configured. Caller should fall back to writeFile().
    const result = await fastWrite.call(
      runtime.fs,
      '/opt/something/outside.bin',
      Buffer.from('x'),
    )
    assert.equal(result, null)
  })

  it('sticky-disables itself after a host fs failure and returns null thereafter', async () => {
    const fastWrite = runtime.fs.writeFileViaHostMount!
    // Plant a regular file where mkdir-recursive expects a directory; the
    // first writeFileViaHostMount call will fail with ENOTDIR, flip the
    // sticky-disabled flag, and return null. We rely on stderr noise being
    // acceptable in tests (matches the channels.materialize test posture).
    const collidingParent = path.join(hostRoot, 'collide')
    writeFileSync(collidingParent, 'i am a file, not a directory')

    const result1 = await fastWrite.call(
      runtime.fs,
      '/workspace/collide/child.bin',
      Buffer.from('x'),
    )
    assert.equal(result1, null)

    // Subsequent calls must short-circuit even if a different (otherwise
    // valid) path is requested. This avoids paying another round-trip on a
    // worker whose host-side mount is permanently inaccessible to the daemon.
    const result2 = await fastWrite.call(
      runtime.fs,
      '/workspace/.lightclaw/inbox/other.bin',
      Buffer.from('y'),
    )
    assert.equal(result2, null)
    // And nothing was written at the still-valid path either.
    const stillValid = path.join(hostRoot, '.lightclaw', 'inbox', 'other.bin')
    assert.throws(() => readFileSync(stillValid), /ENOENT/)
  })
})
