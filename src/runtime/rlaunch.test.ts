import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { setLightclawHomeOverride } from '../paths.js'
import { workspaceToGpfsMount } from '../identity/paths.js'
import {
  buildLaunchArgs,
  composeExecScript,
  parseWorkerName,
  readFileViaExec,
  READ_FILE_BUFFER_BYTES_FOR_TESTS,
  RlaunchRuntime,
  setWorkerLostRetryDelayMsForTests,
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

  it('maps a workspace root through secondary gpfsMounts rules', () => {
    process.env.LIGHTCLAW_WORKSPACE_ROOT = '/mnt/shared-storage-gpfs2/gpfs2-shared-public/lightclaw-workspaces'
    assert.deepEqual(workspaceToGpfsMount('alice', {
      gpfsHostPrefix: '/mnt/shared-storage-user',
      gpfsMountPrefix: 'gpfs://gpfs1',
      gpfsMounts: [
        { hostPrefix: '/mnt/shared-storage-user', mountPrefix: 'gpfs://gpfs1' },
        { hostPrefix: '/mnt/shared-storage-gpfs2', mountPrefix: 'gpfs://gpfs2' },
      ],
    }), {
      hostPath: '/mnt/shared-storage-gpfs2/gpfs2-shared-public/lightclaw-workspaces/alice',
      mount: 'gpfs://gpfs2/gpfs2-shared-public/lightclaw-workspaces/alice:/workspace',
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
    env: {},
    daemonUid: 1000,
    daemonGid: 1000,
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

  it('emits workspace and extra dynamic mount flags', () => {
    const args = buildLaunchArgs(
      {
        ...baseCfg,
        extraMounts: [{
          hostPath: '/mnt/gpfs/data',
          workerPath: '/mnt/gpfs/data',
          gpfsMount: 'gpfs://gpfs1/data:/mnt/gpfs/data',
          mode: 'ro',
        }],
      },
      { detach: true, predictOnly: false },
    )
    assert.deepEqual(
      args.filter(arg => arg.startsWith('--mount=')),
      [
        '--mount=gpfs://gpfs1/ns/u/alice:/workspace',
        '--mount=gpfs://gpfs1/data:/mnt/gpfs/data',
      ],
    )
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
      command: 'python3 /tmp/consume-stdin.py',
      cwd: '/workspace',
      stdin: payload,
    })
    const expectedB64 = Buffer.from(payload).toString('base64')
    assert.ok(
      script.includes(`{ printf %s '${expectedB64}' | base64 -d; }`),
      `script must inline base64 payload: ${script}`,
    )
    assert.ok(
      script.includes('| { python3 /tmp/consume-stdin.py; }'),
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

  it('wraps the body in `setpriv --reuid=<uid> --regid=<gid> -- bash -c …` when dropPrivileges is set', () => {
    const script = composeExecScript({
      command: 'whoami',
      cwd: '/workspace',
      dropPrivileges: { uid: 10250, gid: 10250 },
    })
    // env/cwd happen BEFORE setpriv (outer shell), then we re-enter bash via
    // setpriv with the original body shell-quoted. Container PID 1 is root
    // (rlaunch image USER directive), so the demote happens here at exec time.
    assert.match(
      script,
      /^cd '\/workspace' && setpriv --reuid=10250 --regid=10250 --clear-groups --inh-caps=-all -- bash -c 'whoami'$/,
    )
  })

  it('keeps body shell-safe when dropPrivileges + stdin are both used', () => {
    // The base64 pipe + brace group has single quotes inside; the outer
    // shellQuote must escape them so the inner `bash -c '...'` is valid.
    const script = composeExecScript({
      command: "cat > '/workspace/x'",
      cwd: '/workspace',
      stdin: 'payload',
      dropPrivileges: { uid: 10250, gid: 10250 },
    })
    assert.ok(script.startsWith("cd '/workspace' && setpriv --reuid=10250 --regid=10250 "),
      `must start with the setpriv prefix: ${script}`)
    assert.ok(script.includes('--inh-caps=-all -- bash -c '),
      'must drop inheritable caps and re-enter bash')
    // Inner body decodes to the expected base64 pipeline.
    const innerQuoted = script.slice(script.indexOf("-- bash -c '") + "-- bash -c '".length, -1)
    const inner = innerQuoted.replace(/'\\''/g, "'")
    assert.ok(inner.includes('base64 -d'),
      `inner bash body should still contain the base64 stdin trick: ${inner}`)
    assert.ok(inner.includes("| { cat > '/workspace/x'; }"),
      'inner bash body must keep the brace group around the user command')
  })

  it('omits setpriv when dropPrivileges is undefined (privileged path)', () => {
    // Bootstrap callers (chownWorkspaceOnce, stageHelpersOnce) need root inside
    // the container; they pass `privileged: true` which translates to no
    // dropPrivileges on the composeExecScript input.
    const script = composeExecScript({ command: 'apt-get update', cwd: '/workspace' })
    assert.equal(script, "cd '/workspace' && apt-get update")
    assert.equal(script.includes('setpriv'), false)
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

describe('readFileViaExec (rlaunch single-hop readFile)', () => {
  // Stub exec simulating `stat` and `base64 -w 0` against an in-memory
  // payload Buffer. Captures every exec command for assertion. The earlier
  // dd-chunked path is gone (see READ_FILE_BUFFER_BYTES rationale) — the
  // stub no longer needs to handle dd at all.
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
      if (cmd.startsWith('base64 -w 0 ')) {
        return { stdout: payload.toString('base64'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: `unknown command in stub: ${cmd}`, exitCode: 1 }
    }
    return { exec, commands }
  }

  it('reads small files in two hops (stat + base64)', async () => {
    const payload = Buffer.from('hello world', 'utf8')
    const { exec, commands } = makeStubExec(payload)
    const out = await readFileViaExec(exec, '/workspace/file.txt', '/workspace/file.txt')
    assert.deepEqual(out, payload)
    assert.equal(commands.length, 2)
    assert.match(commands[0], /^stat -c %s /)
    assert.match(commands[1], /^base64 -w 0 /)
    // The dd-chunked protocol is intentionally retired; if it ever comes
    // back via copy-paste, this assertion catches it.
    assert.equal(commands.some(c => c.includes('dd if=')), false)
  })

  it('round-trips a 30 MB binary payload byte-for-byte in a single base64 hop', async () => {
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
    // Always exactly 2 hops regardless of size: stat + base64.
    assert.equal(commands.length, 2)
  })

  it('passes the high stdout cap to the base64 hop so big files fit', async () => {
    const payload = Buffer.from('x', 'utf8')
    const captured: ExecInput[] = []
    const exec = async (input: ExecInput): Promise<ExecResult> => {
      captured.push(input)
      if (input.command.startsWith('stat -c %s ')) {
        return { stdout: `${payload.length}\n`, stderr: '', exitCode: 0 }
      }
      return { stdout: payload.toString('base64'), stderr: '', exitCode: 0 }
    }
    await readFileViaExec(exec, '/workspace/x', '/workspace/x')
    const base64Call = captured.find(c => c.command.startsWith('base64 -w 0 '))
    assert.ok(base64Call, 'expected a base64 -w 0 hop')
    assert.equal(base64Call.maxBufferBytes, READ_FILE_BUFFER_BYTES_FOR_TESTS)
    // Sanity: cap is at least 256 MB so a typical 100 MB raw file's base64
    // (~134 MB) fits with headroom.
    assert.ok(READ_FILE_BUFFER_BYTES_FOR_TESTS >= 256 * 1024 * 1024)
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

  it('throws on byte mismatch when base64 stdout is truncated', async () => {
    // Simulate the symptom that motivated this whole rewrite: stat says X,
    // base64 returns < X bytes (silent stdout drop). The single-hop guard
    // fires loudly instead of returning a corrupt buffer.
    const truncatedBase64 = Buffer.alloc(100, 0xab).toString('base64')
    const exec = async (input: ExecInput): Promise<ExecResult> => {
      if (input.command.startsWith('stat -c %s ')) {
        return { stdout: '4480407\n', stderr: '', exitCode: 0 }
      }
      return { stdout: truncatedBase64, stderr: '', exitCode: 0 }
    }
    await assert.rejects(
      readFileViaExec(exec, '/workspace/big.pdf', '/workspace/big.pdf'),
      /byte mismatch \(expected 4480407, got 100\)/,
    )
  })

  it('propagates exec failure on the base64 hop', async () => {
    const exec = async (input: ExecInput): Promise<ExecResult> => {
      if (input.command.startsWith('stat -c %s ')) {
        return { stdout: '512\n', stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'no space left on device', exitCode: 1 }
    }
    await assert.rejects(
      readFileViaExec(exec, '/workspace/y', '/workspace/y'),
      /no space left on device/,
    )
  })
})

describe('RlaunchRuntime three-plane data path', () => {
  let hostRoot: string
  let runtime: RlaunchRuntime

  beforeEach(() => {
    hostRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-plane-test-'))
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
        env: {},
        daemonUid: 1000,
        daemonGid: 1000,
    }
    runtime = new RlaunchRuntime(config, new WorkerReadinessTracker('alice'))
    ;(runtime as unknown as { ensureRunning: () => Promise<void> }).ensureRunning = async () => {}
  })

  afterEach(() => {
    rmSync(hostRoot, { recursive: true, force: true })
  })

  it('keeps the compatibility shim as the same object as runtime.data', () => {
    assert.equal(runtime.fs, runtime.data)
    assert.equal(runtime.control.kind, 'brainctl-exec')
    assert.equal(runtime.control.stdoutByteReliability, 'unreliable-large')
    assert.equal(runtime.paths.toHostPath('/workspace/a/b.txt'), path.join(hostRoot, 'a', 'b.txt'))
  })

  it('reads large in-mount files through shared-cluster-fs instead of brainctl exec', async () => {
    const payload = Buffer.alloc(6_177_650, 7)
    const hostFile = path.join(hostRoot, '.lightclaw', 'inbox', 'paper.pdf')
    mkdirSync(path.dirname(hostFile), { recursive: true })
    writeFileSync(hostFile, payload)

    let execCalled = false
    ;(runtime as unknown as { exec: (input: ExecInput) => Promise<ExecResult> }).exec = async () => {
      execCalled = true
      return { stdout: '', stderr: 'should not be called', exitCode: 1 }
    }

    const got = await runtime.fs.readFile('/workspace/.lightclaw/inbox/paper.pdf')
    assert.equal(got.length, payload.length)
    assert.equal(Buffer.compare(got, payload), 0)
    assert.equal(execCalled, false)
  })

  it('routes container-local absolute paths (/tmp, /etc, …) through exec-relay', async () => {
    // Workspace gate dropped: paths outside the gpfs mount are container-
    // local. shared-cluster-fs filters via PathPolicy.isShared, exec-relay
    // accepts everything. Container isolation + permission system are the
    // safety boundary, not a path-string guard.
    const captured: string[] = []
    ;(runtime as unknown as { exec: (input: ExecInput) => Promise<ExecResult> }).exec = async input => {
      captured.push(input.command)
      if (input.command.startsWith('stat -c %s ')) {
        return { stdout: '11\n', stderr: '', exitCode: 0 }
      }
      if (input.command.startsWith('base64 -w 0 ')) {
        return { stdout: Buffer.from('hello /tmp\n').toString('base64'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: `unexpected: ${input.command}`, exitCode: 1 }
    }

    const got = await runtime.fs.readFile('/tmp/lightclaw-test.log')
    assert.equal(got.toString('utf8'), 'hello /tmp\n')
    // Both hops landed at the literal `/tmp/...` container path — no rewrite.
    assert.ok(captured[0].endsWith("'/tmp/lightclaw-test.log'"),
      `stat hop should target /tmp directly: ${captured[0]}`)
    assert.ok(captured[1].endsWith("'/tmp/lightclaw-test.log'"),
      `base64 hop should target /tmp directly: ${captured[1]}`)
  })

  it('folds `..` traversal via normalize and lets the resulting path through', async () => {
    // path.posix.normalize('/workspace/../etc/passwd') === '/etc/passwd'.
    // After 18ff987's "trust runtime isolation" policy was extended to
    // toContainerPath, the resulting absolute path is no longer string-
    // guarded; the container reads its own /etc/passwd (image default
    // contents), not the host's. Permission system / high-risk classifier
    // still gate Edit/Write on sensitive paths separately.
    const captured: string[] = []
    ;(runtime as unknown as { exec: (input: ExecInput) => Promise<ExecResult> }).exec = async input => {
      captured.push(input.command)
      if (input.command.startsWith('stat -c %s ')) {
        return { stdout: '4\n', stderr: '', exitCode: 0 }
      }
      if (input.command.startsWith('base64 -w 0 ')) {
        return { stdout: Buffer.from('root').toString('base64'), stderr: '', exitCode: 0 }
      }
      return { stdout: '', stderr: 'unexpected', exitCode: 1 }
    }

    const got = await runtime.fs.readFile('/workspace/../etc/passwd')
    assert.equal(got.toString('utf8'), 'root')
    // After normalize, the hop targets /etc/passwd (no `..` left in the path).
    assert.ok(captured[0].includes("'/etc/passwd'"),
      `traversal should be normalized away: ${captured[0]}`)
  })

  it('rejects relative paths with a clear non-absolute error', async () => {
    // Tools normalize against workspaceRoot before calling runtime.fs, so the
    // backend only legitimately sees absolute paths. A relative leak past
    // that resolution is a real caller bug — surface it instead of silently
    // running it inside the container at an arbitrary cwd.
    let execCalled = false
    ;(runtime as unknown as { exec: (input: ExecInput) => Promise<ExecResult> }).exec = async () => {
      execCalled = true
      return { stdout: '', stderr: '', exitCode: 1 }
    }
    await assert.rejects(
      () => runtime.fs.readFile('relative/path.txt'),
      /Path is not absolute/,
    )
    assert.equal(execCalled, false)
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
        env: {},
        daemonUid: 1000,
        daemonGid: 1000,
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

  it('returns null for LightClaw read-only extra mounts so writeFile can enforce policy', async () => {
    const readOnlyHost = mkdtempSync(path.join(tmpdir(), 'lightclaw-extra-ro-'))
    try {
      const roRuntime = new RlaunchRuntime({
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
        extraMounts: [{
          hostPath: readOnlyHost,
          workerPath: '/mnt/readonly-data',
          gpfsMount: 'gpfs://gpfs1/ns/readonly-data:/mnt/readonly-data',
          mode: 'ro',
        }],
        env: {},
        daemonUid: process.getuid?.() ?? 0,
        daemonGid: process.getgid?.() ?? 0,
      }, new WorkerReadinessTracker('alice'))
      const fastWrite = roRuntime.fs.writeFileViaHostMount!
      const result = await fastWrite.call(
        roRuntime.fs,
        '/mnt/readonly-data/out.bin',
        Buffer.from('x'),
      )
      assert.equal(result, null)
      assert.throws(
        () => readFileSync(path.join(readOnlyHost, 'out.bin')),
        /ENOENT/,
      )
    } finally {
      rmSync(readOnlyHost, { recursive: true, force: true })
    }
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

describe('RlaunchRuntime.fs.readFileViaHostMount (host-side bind-mount fast path)', () => {
  let hostRoot: string
  let runtime: RlaunchRuntime

  beforeEach(() => {
    hostRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-fastread-test-'))
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
        env: {},
        daemonUid: 1000,
        daemonGid: 1000,
    }
    runtime = new RlaunchRuntime(config, new WorkerReadinessTracker('alice'))
  })

  afterEach(() => {
    rmSync(hostRoot, { recursive: true, force: true })
  })

  it('reads via host fs when the container path is inside the bind mount', async () => {
    const fastRead = runtime.fs.readFileViaHostMount
    assert.ok(fastRead, 'rlaunch fs must expose readFileViaHostMount')

    // Plant a file via host fs (simulating something the daemon wrote earlier
    // through writeFileViaHostMount, or any other harness-internal staging).
    const containerPath = '/workspace/.lightclaw/inbox/oc_chat/file.bin'
    const expectedHost = path.join(hostRoot, '.lightclaw', 'inbox', 'oc_chat', 'file.bin')
    const payload = Buffer.from('hello from host fast-read', 'utf8')
    mkdirSync(path.dirname(expectedHost), { recursive: true })
    writeFileSync(expectedHost, payload)

    const got = await fastRead.call(runtime.fs, containerPath)
    assert.ok(got, 'fast read should succeed for in-mount paths with extant files')
    assert.equal(Buffer.compare(got, payload), 0)
  })

  it('returns null when the path falls outside every mount entry', async () => {
    const fastRead = runtime.fs.readFileViaHostMount!
    const result = await fastRead.call(runtime.fs, '/etc/something/outside.bin')
    assert.equal(result, null)
  })

  it('sticky-disables itself after a host read failure and returns null thereafter', async () => {
    const fastRead = runtime.fs.readFileViaHostMount!
    // First attempt: file does not exist on host → ENOENT → sticky disable.
    const result1 = await fastRead.call(
      runtime.fs,
      '/workspace/.lightclaw/inbox/missing.bin',
    )
    assert.equal(result1, null)

    // Even with a real planted file afterwards, the second call short-circuits.
    const containerPath = '/workspace/.lightclaw/inbox/now-exists.bin'
    const expectedHost = path.join(hostRoot, '.lightclaw', 'inbox', 'now-exists.bin')
    mkdirSync(path.dirname(expectedHost), { recursive: true })
    writeFileSync(expectedHost, 'present')
    const result2 = await fastRead.call(runtime.fs, containerPath)
    assert.equal(result2, null,
      'sticky-disabled fast read must return null even when the path now resolves')
  })

  it('write/read flags are independent: a write failure does not disable read', async () => {
    const fastWrite = runtime.fs.writeFileViaHostMount!
    const fastRead = runtime.fs.readFileViaHostMount!

    // Plant a file the read can succeed on.
    const containerPath = '/workspace/.lightclaw/inbox/readable.bin'
    const expectedHost = path.join(hostRoot, '.lightclaw', 'inbox', 'readable.bin')
    mkdirSync(path.dirname(expectedHost), { recursive: true })
    writeFileSync(expectedHost, 'ok')

    // Force write to fail (ENOTDIR via colliding parent file).
    const collidingParent = path.join(hostRoot, 'wcollide')
    writeFileSync(collidingParent, 'file-not-dir')
    const wResult = await fastWrite.call(runtime.fs, '/workspace/wcollide/child.bin', Buffer.from('x'))
    assert.equal(wResult, null)

    // Read should still succeed — separate sticky flag.
    const rResult = await fastRead.call(runtime.fs, containerPath)
    assert.ok(rResult, 'read flag must be independent of write flag')
    assert.equal(rResult.toString('utf8'), 'ok')
  })
})

describe('RlaunchRuntime isAvailable retryable mapping', () => {
  // Bug 12 (2026-05-12 dogfood) invariant: every non-ok branch must carry a
  // boolean `retryable` so query.ts can decide is_error per branch instead of
  // surfacing every transient backoff as a tool failure.
  let hostRoot: string
  let runtime: RlaunchRuntime
  let tracker: WorkerReadinessTracker

  beforeEach(() => {
    hostRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-avail-test-'))
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
        env: {},
        daemonUid: 1000,
        daemonGid: 1000,
    }
    tracker = new WorkerReadinessTracker('alice')
    runtime = new RlaunchRuntime(config, tracker)
  })

  afterEach(() => {
    rmSync(hostRoot, { recursive: true, force: true })
  })

  it('worker-scheduling is retryable + body has no absolute-negation phrasing', async () => {
    tracker.startSchedule('registry/x:tag')
    const avail = await runtime.isAvailable()
    assert.equal(avail.ok, false)
    if (avail.ok) return
    assert.equal(avail.reason, 'worker-scheduling')
    assert.equal(avail.retryable, true)
    // Bug 12 phrasing regression guard: the old wording
    // "我现在不能执行命令、读写文件或抓取网页" reads to the model as a hard
    // capability claim and primes "I have no tools" behavior. The replacement
    // must not contain that absolute negation.
    assert.ok(!avail.userMessage.includes('不能执行命令'),
      `worker-scheduling userMessage must drop the "不能执行命令" phrasing, got: ${avail.userMessage}`)
    assert.ok(avail.userMessage.includes('准备'),
      'worker-scheduling userMessage should still describe "正在准备"')
  })

  it('not-attempted (initial state) is retryable', async () => {
    // tracker starts in 'not-attempted' — isAvailable() must treat it as
    // retryable scheduling. This is the path the very first turn hits before
    // any start() call has run.
    const avail = await runtime.isAvailable()
    assert.equal(avail.ok, false)
    if (avail.ok) return
    assert.equal(avail.reason, 'worker-scheduling')
    assert.equal(avail.retryable, true)
  })

  it('worker-quota-denied is NOT retryable', async () => {
    tracker.markQuotaDenied('quota exceeded for ailab-hs/hs_cpu')
    const avail = await runtime.isAvailable()
    assert.equal(avail.ok, false)
    if (avail.ok) return
    assert.equal(avail.reason, 'worker-quota-denied')
    assert.equal(avail.retryable, false)
  })

  it('worker-failed is NOT retryable', async () => {
    tracker.markFailed('rlaunch detached exited 1: image pull error')
    const avail = await runtime.isAvailable()
    assert.equal(avail.ok, false)
    if (avail.ok) return
    assert.equal(avail.reason, 'worker-failed')
    assert.equal(avail.retryable, false)
  })
})

describe('RlaunchRuntime worker-lost retry-before-respawn', () => {
  // 2026-05-12 dogfood follow-up: `isWorkerLostError` keyword set is broad
  // enough to match brainctl control-plane transients (websocket upgrade
  // failure, kubelet endpoint hiccup, …) as well as real worker death.
  // Add one 1s in-place retry so a transient blip never silently respawns
  // a living worker (which then leaks until the cluster GC window kicks in).
  let hostRoot: string
  let runtime: RlaunchRuntime

  type ExecMock = (input: ExecInput) => Promise<ExecResult>

  beforeEach(() => {
    hostRoot = mkdtempSync(path.join(tmpdir(), 'lightclaw-worker-lost-test-'))
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
        env: {},
        daemonUid: 1000,
        daemonGid: 1000,
    }
    runtime = new RlaunchRuntime(config, new WorkerReadinessTracker('alice'))
    // Stub out the heavy lifecycle calls that the retry path would otherwise
    // hit. ensureRunning short-circuits because we pre-set workerName.
    ;(runtime as unknown as { ensureRunning: () => Promise<void> }).ensureRunning = async () => {}
    ;(runtime as unknown as { waitUntilRunning: () => Promise<void> }).waitUntilRunning = async () => {}
    ;(runtime as unknown as { workerName: string | null }).workerName = 'ws-test-alpha'
    setWorkerLostRetryDelayMsForTests(1) // 1ms keeps the suite snappy
  })

  afterEach(() => {
    rmSync(hostRoot, { recursive: true, force: true })
    setWorkerLostRetryDelayMsForTests(1000)
  })

  function stubBrainctlExec(impls: ExecMock[]): { calls: number } {
    let call = 0
    const counter = { calls: 0 }
    const fn: ExecMock = async (input) => {
      const idx = call++
      counter.calls = call
      const impl = impls[idx] ?? impls[impls.length - 1]
      return impl(input)
    }
    ;(runtime as unknown as { runBrainctlExec: ExecMock }).runBrainctlExec = fn
    return counter
  }

  it('returns immediately when first brainctl exec succeeds', async () => {
    const counter = stubBrainctlExec([
      async () => ({ stdout: 'hello', stderr: '', exitCode: 0 }),
    ])
    const result = await runtime.exec({ command: 'echo hello' })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'hello')
    assert.equal(counter.calls, 1, 'no retry should happen on success')
  })

  it('retries once and returns the retry result when the first error is a transient', async () => {
    // First call hits `unable to upgrade connection` (control-plane websocket
    // blip, classic false positive in dogfood). Retry succeeds.
    const counter = stubBrainctlExec([
      async () => ({
        stdout: '',
        stderr: 'Error from server: unable to upgrade connection: container not found',
        exitCode: 1,
      }),
      async () => ({ stdout: 'ok after retry', stderr: '', exitCode: 0 }),
    ])
    let startCalls = 0
    ;(runtime as unknown as { start: (reason: string) => Promise<void> }).start = async () => {
      startCalls++
    }

    const result = await runtime.exec({ command: 'echo hi' })
    assert.equal(counter.calls, 2, 'first call + retry')
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'ok after retry')
    assert.equal(startCalls, 0, 'respawn must NOT happen when retry recovered')
    // Worker name preserved — the whole point of the retry layer.
    assert.equal(
      (runtime as unknown as { workerName: string | null }).workerName,
      'ws-test-alpha',
    )
  })

  it('respawns when the retry still sees worker-lost-like error (real death)', async () => {
    // Both first and retry hit the realistic brainctl NotFound envelope
    // (worker deleted on the cluster side). Treated as real worker death:
    // delete record, start new worker, run a third brainctl exec on the
    // new worker. `Error from server (NotFound): ...` is the exact line
    // shape brainctl emits — see the 2026-05-15 live-probe write-up.
    const notFoundStderr =
      'Error from server (NotFound): processes.workspace.brainpp.cn "ws-test-alpha" not found'
    const counter = stubBrainctlExec([
      async () => ({ stdout: '', stderr: notFoundStderr, exitCode: 1 }),
      async () => ({ stdout: '', stderr: notFoundStderr, exitCode: 1 }),
      async () => ({ stdout: 'ok on new worker', stderr: '', exitCode: 0 }),
    ])
    const startReasons: string[] = []
    ;(runtime as unknown as { start: (reason: string) => Promise<void> }).start = async (reason: string) => {
      startReasons.push(reason)
      ;(runtime as unknown as { workerName: string | null }).workerName = 'ws-test-beta'
    }

    const result = await runtime.exec({ command: 'echo hi' })
    assert.equal(counter.calls, 3, 'first + retry + post-respawn third call')
    assert.equal(result.exitCode, 0)
    assert.ok(result.stderr.startsWith('[runtime] worker restarted'),
      'respawn path prepends the legacy "worker restarted" stderr header')
    assert.equal(startReasons.length, 1, 'exactly one respawn after retry failure')
    assert.ok(startReasons[0]?.includes('worker-lost on exec after 1s retry'),
      `start reason should reflect the retry-then-respawn path, got: ${startReasons[0]}`)
  })

  it('does NOT respawn on exit 127 even when stderr says "command not found"', async () => {
    // 2026-05-13 dogfood: the rlaunch ml-base image ships without ripgrep,
    // so every Glob/Grep call returns `bash: line 1: rg: command not found`
    // exit 127. Pre-fix the substring 'not found' tripped isWorkerLostError
    // and the runtime respawned the worker once per Grep. Exit 127 is unique
    // to in-shell command resolution; brainctl control-plane / kubelet faults
    // surface as non-127 exits, so guarding on it is safe.
    const counter = stubBrainctlExec([
      async () => ({
        stdout: '',
        stderr: 'bash: line 1: rg: command not found',
        exitCode: 127,
      }),
      async () => ({ stdout: 'should NOT be called', stderr: '', exitCode: 0 }),
    ])
    let startCalls = 0
    ;(runtime as unknown as { start: (reason: string) => Promise<void> }).start = async () => {
      startCalls++
    }

    const result = await runtime.exec({ command: 'rg foo' })
    assert.equal(counter.calls, 1, 'exit 127 must short-circuit before retry')
    assert.equal(result.exitCode, 127, 'original exit code is propagated')
    assert.ok(result.stderr.includes('command not found'),
      'original stderr is propagated verbatim, not wrapped as "worker restarted"')
    assert.equal(startCalls, 0, 'respawn must NOT happen on exit 127')
    assert.equal(
      (runtime as unknown as { workerName: string | null }).workerName,
      'ws-test-alpha',
      'worker name is preserved — no leaked worker',
    )
  })

  it('still treats `Error from server (NotFound): ...` (exit 1) as worker-lost', async () => {
    // Regression guard: the exit-127 short-circuit must not weaken the
    // existing worker-lost detection. brainctl emits this exact envelope
    // when the cluster has deleted the process; the retry-then-recover
    // path must still trigger for it.
    const notFoundStderr =
      'Error from server (NotFound): processes.workspace.brainpp.cn "ws-test-alpha" not found'
    const counter = stubBrainctlExec([
      async () => ({ stdout: '', stderr: notFoundStderr, exitCode: 1 }),
      async () => ({ stdout: 'recovered', stderr: '', exitCode: 0 }),
    ])
    let startCalls = 0
    ;(runtime as unknown as { start: (reason: string) => Promise<void> }).start = async () => {
      startCalls++
    }

    const result = await runtime.exec({ command: 'echo hi' })
    assert.equal(counter.calls, 2, 'exit 1 + worker-lost stderr enters retry path')
    assert.equal(result.exitCode, 0)
    assert.equal(startCalls, 0, 'retry recovered, no respawn')
  })

  it('treats Stopped-worker envelope (`error: cannot exec ...`) as worker-lost', async () => {
    // 2026-05-15 live probe: a Stopped worker (cluster-evicted but not
    // deleted) returns `error: cannot exec into a container in an
    // unavailable process: Stopped` on exec. That stderr hits two of the
    // envelope substrings (`cannot exec into a container` +
    // `unavailable process`) so the line-anchored detector must still
    // surface it as worker-lost.
    const stoppedStderr =
      'error: cannot exec into a container in an unavailable process: Stopped'
    const counter = stubBrainctlExec([
      async () => ({ stdout: '', stderr: stoppedStderr, exitCode: 1 }),
      async () => ({ stdout: 'recovered', stderr: '', exitCode: 0 }),
    ])
    let startCalls = 0
    ;(runtime as unknown as { start: (reason: string) => Promise<void> }).start = async () => {
      startCalls++
    }

    const result = await runtime.exec({ command: 'echo hi' })
    assert.equal(counter.calls, 2, 'Stopped worker stderr enters retry path')
    assert.equal(result.exitCode, 0)
    assert.equal(startCalls, 0, 'retry recovered, no respawn')
  })

  it('does NOT respawn when a user program prints "not found" to stderr (regression)', async () => {
    // 2026-05-15 dogfood: a Python heredoc raised
    //   raise SystemExit('runner query block start not found')
    // then shell `&&`-fell through to `pnpm typecheck` which exited 2 with
    // real TypeScript errors. The combined stderr carried the substring
    // 'not found' but neither line started with `error:` or `Error from
    // server`, so it must NOT trip the detector. Pre-fix the worker was
    // respawned twice (retry also hit the same Python stderr) and the
    // running TS-checker session lost its container-local `/tmp`.
    const userStderr = [
      'runner query block start not found',
      'command terminated with exit code 2',
    ].join('\n')
    const counter = stubBrainctlExec([
      async () => ({ stdout: '', stderr: userStderr, exitCode: 2 }),
      async () => ({ stdout: 'should NOT be called', stderr: '', exitCode: 0 }),
    ])
    let startCalls = 0
    ;(runtime as unknown as { start: (reason: string) => Promise<void> }).start = async () => {
      startCalls++
    }

    const result = await runtime.exec({ command: 'python3 - <<PY\nraise SystemExit(...)\nPY' })
    assert.equal(counter.calls, 1, 'user "not found" must short-circuit before retry')
    assert.equal(result.exitCode, 2, 'original exit code is propagated')
    assert.ok(result.stderr.includes('runner query block start not found'),
      'original stderr is propagated verbatim, not wrapped as "worker restarted"')
    assert.equal(startCalls, 0, 'respawn must NOT happen for user-emitted "not found"')
    assert.equal(
      (runtime as unknown as { workerName: string | null }).workerName,
      'ws-test-alpha',
      'worker name is preserved — no leaked worker',
    )
  })

  it('does NOT respawn when user output mentions worker-lost substrings without brainctl prefix', async () => {
    // Belt-and-braces: a user program could plausibly print any of the 5
    // detector substrings as part of its own output. None of them should
    // trip the detector unless they appear on an `error:` / `Error from
    // server` stderr line.
    const samples = [
      'connection refused while curling localhost',
      'kubelet says: unable to upgrade connection (but the worker is fine)',
      'log: unavailable process detected upstream',
      'cannot exec into a container — debug message from my script',
    ]
    for (const stderr of samples) {
      const counter = stubBrainctlExec([
        async () => ({ stdout: '', stderr, exitCode: 1 }),
        async () => ({ stdout: 'should NOT be called', stderr: '', exitCode: 0 }),
      ])
      let startCalls = 0
      ;(runtime as unknown as { start: (reason: string) => Promise<void> }).start = async () => {
        startCalls++
      }

      const result = await runtime.exec({ command: 'echo hi' })
      assert.equal(counter.calls, 1, `no retry for non-envelope stderr: ${stderr}`)
      assert.equal(result.exitCode, 1, 'original exit code is propagated')
      assert.equal(startCalls, 0, `respawn must NOT happen for non-envelope stderr: ${stderr}`)
    }
  })

  it('does not retry when caller aborts during the retry delay', async () => {
    // Real brainctl `connection refused` arrives wrapped in the
    // `Error from server: error dialing backend: ...` envelope — that's
    // the envelope shape the line-anchored detector recognises. The
    // older "bare connection refused" stub would no longer trigger the
    // retry path, which is the correct new behaviour.
    const refusedStderr =
      'Error from server: error dialing backend: dial tcp 100.96.225.185:10250: connect: connection refused'
    const counter = stubBrainctlExec([
      async () => ({ stdout: '', stderr: refusedStderr, exitCode: 1 }),
      async () => ({ stdout: 'should NOT be called', stderr: '', exitCode: 0 }),
    ])
    let startCalls = 0
    ;(runtime as unknown as { start: (reason: string) => Promise<void> }).start = async () => {
      startCalls++
    }
    // Slow the retry down so the abort lands inside the sleep window.
    setWorkerLostRetryDelayMsForTests(50)

    const ac = new AbortController()
    const promise = runtime.exec({ command: 'echo hi', abortSignal: ac.signal })
    // Abort synchronously after exec() yields on the first await — the next
    // microtask will reach `delay(50)` and then re-check `abortSignal.aborted`.
    setTimeout(() => ac.abort(), 5)
    const result = await promise

    assert.equal(counter.calls, 1, 'aborted before retry could run')
    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes('connection refused'),
      'original failed result is returned verbatim on abort')
    assert.equal(startCalls, 0, 'respawn must NOT happen on abort')
  })
})

describe('RlaunchRuntime markRetired forwarder', () => {
  // The retire-forwarder is what makes /mount safe across same-user
  // concurrent sessions: when /mount swaps the pool entry, the old
  // RlaunchRuntime instance is still referenced by other sessions'
  // AsyncLocalStorage; we don't want those references to respawn a
  // worker with the stale mount config. Marking the old instance
  // retired with a resolver pointing at the new pool entry routes all
  // future calls on the old reference into the new runtime.
  let hostRootOld: string
  let hostRootNew: string
  let oldRuntime: RlaunchRuntime
  let newRuntime: RlaunchRuntime

  const makeConfig = (host: string, hash: string): RlaunchRuntimeConfig => ({
    canonicalUser: 'alice',
    deploymentHash: hash,
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
    workspaceHostPath: host,
    workspaceGpfsMount: `gpfs://gpfs1/ns/u/alice:/workspace`,
    workspaceContainerPath: '/workspace',
    env: {},
    daemonUid: 1000,
    daemonGid: 1000,
  })

  beforeEach(() => {
    hostRootOld = mkdtempSync(path.join(tmpdir(), 'lightclaw-retire-old-'))
    hostRootNew = mkdtempSync(path.join(tmpdir(), 'lightclaw-retire-new-'))
    oldRuntime = new RlaunchRuntime(makeConfig(hostRootOld, 'oldhash01'), new WorkerReadinessTracker('alice'))
    newRuntime = new RlaunchRuntime(makeConfig(hostRootNew, 'newhash02'), new WorkerReadinessTracker('alice'))
  })

  afterEach(() => {
    rmSync(hostRootOld, { recursive: true, force: true })
    rmSync(hostRootNew, { recursive: true, force: true })
  })

  it('forwards exec / start / isAvailable / isRunning to the successor when retired', async () => {
    // Stub the successor's methods. We deliberately do NOT stub oldRuntime
    // because the whole point is to exercise oldRuntime's real exec / start /
    // etc. and verify the guard at the top forwards before any local body runs.
    let newExecCalls = 0
    let newStartCalls = 0
    let newIsAvailableCalls = 0
    ;(newRuntime as unknown as { exec: (i: ExecInput) => Promise<ExecResult> }).exec = async () => {
      newExecCalls++
      return { stdout: 'from-new', stderr: '', exitCode: 0 }
    }
    ;(newRuntime as unknown as { start: () => Promise<void> }).start = async () => {
      newStartCalls++
    }
    ;(newRuntime as unknown as { isAvailable: () => Promise<{ ok: true }> }).isAvailable = async () => {
      newIsAvailableCalls++
      return { ok: true }
    }
    ;(newRuntime as unknown as { isRunning: () => boolean }).isRunning = () => true

    oldRuntime.markRetired(() => newRuntime)
    const result = await oldRuntime.exec({ command: 'echo hi' })
    assert.equal(result.stdout, 'from-new', 'exec forwards to successor')
    assert.equal(newExecCalls, 1)

    await oldRuntime.start()
    assert.equal(newStartCalls, 1, 'start forwards to successor')

    const avail = await oldRuntime.isAvailable()
    assert.deepEqual(avail, { ok: true })
    assert.equal(newIsAvailableCalls, 1)

    assert.equal(oldRuntime.isRunning(), true, 'isRunning forwards to successor')
  })

  it('forwards data / fs / paths getters to the successor', () => {
    const oldDataBefore = oldRuntime.data
    const oldFsBefore = oldRuntime.fs
    const oldPathsBefore = oldRuntime.paths
    // Pre-retire sanity: data getter returns the local instance.
    assert.notEqual(oldDataBefore, newRuntime.data, 'sanity: pre-retire data is local')

    oldRuntime.markRetired(() => newRuntime)
    assert.equal(oldRuntime.data, newRuntime.data, 'data getter returns successor data plane')
    assert.equal(oldRuntime.fs, newRuntime.fs, 'fs getter returns successor fs')
    assert.equal(oldRuntime.paths, newRuntime.paths, 'paths getter returns successor PathPolicy')

    // The local backing fields are unchanged; only the getter routing differs.
    // (Captured-before references still equal each other after retire; they
    // simply aren't what the getter now returns.)
    assert.equal(oldFsBefore, oldDataBefore, 'local fs/data alias preserved')
    assert.equal(oldPathsBefore, oldPathsBefore, 'local paths still exist (identity check)')
  })

  it('falls through to the local instance when the resolver returns no successor', () => {
    // Capture local references before retire.
    const localData = oldRuntime.data
    const localFs = oldRuntime.fs
    const localPaths = oldRuntime.paths

    oldRuntime.markRetired(() => undefined)
    // Resolver returned undefined → liveSuccessor() returns null → getters
    // fall through to the local _data / _fs / _paths.
    assert.equal(oldRuntime.data, localData, 'data falls through to local')
    assert.equal(oldRuntime.fs, localFs, 'fs falls through to local')
    assert.equal(oldRuntime.paths, localPaths, 'paths falls through to local')
  })

  it('refreshes successor lookup on every call so chained swaps follow forward', async () => {
    const thirdRuntime = new RlaunchRuntime(
      makeConfig(hostRootNew, 'thirdhas3'),
      new WorkerReadinessTracker('alice'),
    )
    let pointer: RlaunchRuntime = newRuntime
    let newCalls = 0
    let thirdCalls = 0
    ;(newRuntime as unknown as { exec: (i: ExecInput) => Promise<ExecResult> }).exec = async () => {
      newCalls++
      return { stdout: 'from-new', stderr: '', exitCode: 0 }
    }
    ;(thirdRuntime as unknown as { exec: (i: ExecInput) => Promise<ExecResult> }).exec = async () => {
      thirdCalls++
      return { stdout: 'from-third', stderr: '', exitCode: 0 }
    }
    oldRuntime.markRetired(() => pointer)

    const r1 = await oldRuntime.exec({ command: 'echo' })
    assert.equal(r1.stdout, 'from-new')

    // Simulate a second swap landing in the pool.
    pointer = thirdRuntime
    const r2 = await oldRuntime.exec({ command: 'echo' })
    assert.equal(r2.stdout, 'from-third', 'resolver is re-evaluated per call')
    assert.equal(newCalls, 1)
    assert.equal(thirdCalls, 1)
  })
})
