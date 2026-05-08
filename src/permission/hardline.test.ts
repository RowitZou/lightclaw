import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { findHardlineMatch } from './hardline.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import { evaluatePermission } from './policy.js'

function expectMatch(command: string, ruleId: string): void {
  const m = findHardlineMatch(command)
  assert.ok(m, `expected ${command!} to match hardline (${ruleId}); got null`)
  assert.equal(m.ruleId, ruleId, `expected ${ruleId}, got ${m.ruleId} for: ${command}`)
}

function expectNoMatch(command: string): void {
  const m = findHardlineMatch(command)
  assert.equal(m, null, `expected ${command} to be allowed by hardline; matched ${m?.ruleId}`)
}

describe('hardline rm -rf root', () => {
  it('matches rm -rf /', () => expectMatch('rm -rf /', 'rm-rf-root'))
  it('matches rm -fr /', () => expectMatch('rm -fr /', 'rm-rf-root'))
  it('matches rm -Rf /', () => expectMatch('rm -Rf /', 'rm-rf-root'))
  it('matches rm --recursive --force /', () =>
    expectMatch('rm --recursive --force /', 'rm-rf-root'))
  it('matches rm -rf /*', () => expectMatch('rm -rf /*', 'rm-rf-root'))
  it('matches rm -rf ~', () => expectMatch('rm -rf ~', 'rm-rf-root'))
  it('matches rm -r --no-preserve-root /home/foo (the flag bypasses GNU guard)', () =>
    expectMatch('rm -r --no-preserve-root /home/foo', 'rm-rf-root'))
  it('matches rm -rf "/" with quoted root', () =>
    expectMatch('rm -rf "/"', 'rm-rf-root'))

  it('does NOT match rm -rf inside a workspace path', () => {
    expectNoMatch('rm -rf /tmp/foo')
    expectNoMatch('rm -rf node_modules')
    expectNoMatch('rm -rf dist')
  })

  it('does NOT match rm without -r', () => {
    expectNoMatch('rm /foo')
    expectNoMatch('rm -f /foo')
  })

  it('matches rm -rf / inside a chained command (cd /tmp && rm -rf /)', () => {
    expectMatch('cd /tmp && rm -rf /', 'rm-rf-root')
  })
})

describe('hardline mkfs', () => {
  it('matches bare mkfs', () => expectMatch('mkfs /dev/sda1', 'mkfs'))
  it('matches mkfs.ext4', () => expectMatch('mkfs.ext4 /dev/sdb1', 'mkfs'))
  it('matches mkfs.xfs', () => expectMatch('mkfs.xfs /dev/nvme0n1', 'mkfs'))
  it('matches /sbin/mkfs.ext4 absolute path', () =>
    expectMatch('/sbin/mkfs.ext4 /dev/sdb', 'mkfs'))
  it('matches mkfs in a chain', () =>
    expectMatch('umount /mnt/data && mkfs.ext4 /dev/sdb1', 'mkfs'))
})

describe('hardline dd to disk', () => {
  it('matches dd of=/dev/sda', () =>
    expectMatch('dd if=/dev/zero of=/dev/sda bs=1M', 'dd-disk'))
  it('matches dd of=/dev/nvme0n1', () =>
    expectMatch('dd if=image.iso of=/dev/nvme0n1', 'dd-disk'))
  it('matches dd of=/dev/sdb1 (partition)', () =>
    expectMatch('dd if=/dev/zero of=/dev/sdb1', 'dd-disk'))

  it('does NOT match dd to a regular file', () => {
    expectNoMatch('dd if=/dev/zero of=/tmp/scratch bs=1M count=10')
    expectNoMatch('dd if=src.iso of=./image.iso')
  })
})

describe('hardline fork bomb', () => {
  it('matches the canonical fork bomb', () =>
    expectMatch(':(){ :|:& };:', 'fork-bomb'))
  it('matches the fork bomb with extra spaces', () =>
    expectMatch(': ( ) { : | : & } ; :', 'fork-bomb'))
  it('matches fork bomb wrapped in another command', () =>
    expectMatch('echo hi; :(){:|:&};:', 'fork-bomb'))
})

describe('hardline shutdown / reboot', () => {
  it('matches shutdown', () => expectMatch('shutdown -h now', 'shutdown'))
  it('matches reboot', () => expectMatch('reboot', 'shutdown'))
  it('matches halt', () => expectMatch('halt', 'shutdown'))
  it('matches poweroff', () => expectMatch('poweroff', 'shutdown'))
  it('matches /sbin/shutdown absolute path', () =>
    expectMatch('/sbin/shutdown -r now', 'shutdown'))
  it('matches sudo shutdown after the && (segment-aware)', () =>
    expectMatch('echo bye && shutdown -h now', 'shutdown'))
})

describe('hardline init runlevel', () => {
  it('matches init 0', () => expectMatch('init 0', 'init-runlevel'))
  it('matches init 6', () => expectMatch('init 6', 'init-runlevel'))
  it('does NOT match init 3', () => expectNoMatch('init 3'))
  it('does NOT match a project init script (npm init)', () => expectNoMatch('npm init'))
})

describe('hardline redirect to disk device', () => {
  it('matches > /dev/sda', () =>
    expectMatch('cat image.iso > /dev/sda', 'redirect-disk'))
  it('matches >> /dev/nvme0n1', () =>
    expectMatch('echo data >> /dev/nvme0n1', 'redirect-disk'))

  it('does NOT match > /dev/null', () =>
    expectNoMatch('command 2>&1 > /dev/null'))
  it('does NOT match > /dev/stdout', () =>
    expectNoMatch('echo hi > /dev/stdout'))
})

describe('hardline benign commands (negative cases)', () => {
  it('allows ordinary workspace commands', () => {
    expectNoMatch('npm install')
    expectNoMatch('git status')
    expectNoMatch('ls -la')
    expectNoMatch('echo "rm -rf /"  # shell history quote is fine')
    expectNoMatch('grep -r "shutdown" .')
    expectNoMatch('curl https://example.com')
  })
})

describe('evaluatePermission integrates hardline (bypass-mode override)', () => {
  it('rejects rm -rf / under mode=bypassPermissions despite a Bash:* allow rule', async () => {
    const ctx = createSessionContext({
      cwd: process.cwd(),
      model: 'test-model',
      sessionsDir: '/tmp/lightclaw-hardline-test-sessions',
      memoryDir: '/tmp/lightclaw-hardline-test-memory',
      sessionId: 'hardline-test',
    })
    const result = await runWithSessionContext(ctx, async () =>
      evaluatePermission({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        riskLevel: 'execute',
        mode: 'bypassPermissions',
        rules: [
          {
            source: 'identity',
            behavior: 'allow',
            value: { toolName: 'Bash', ruleContent: 'rm:*' },
          },
        ],
      }),
    )
    assert.equal(result.behavior, 'deny')
    if (result.behavior === 'deny') {
      assert.match(result.reason, /hardline blocklist \(rm-rf-root\)/)
      assert.match(result.reason, /unconditional/)
    }
  })

  it('lets unrelated commands through unchanged under bypass', async () => {
    const ctx = createSessionContext({
      cwd: process.cwd(),
      model: 'test-model',
      sessionsDir: '/tmp/lightclaw-hardline-test-sessions',
      memoryDir: '/tmp/lightclaw-hardline-test-memory',
      sessionId: 'hardline-test-2',
    })
    const result = await runWithSessionContext(ctx, async () =>
      evaluatePermission({
        toolName: 'Bash',
        input: { command: 'ls -la' },
        riskLevel: 'execute',
        mode: 'bypassPermissions',
        rules: [],
      }),
    )
    assert.equal(result.behavior, 'allow')
  })
})
