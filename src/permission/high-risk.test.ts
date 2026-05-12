import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  commandContainsHighRiskBash,
  containsHighRiskRule,
  isHighRiskAsk,
  isHighRiskRule,
  isHighRiskRulePattern,
} from './high-risk.js'
import type {
  PermissionAskInput,
  PermissionRuleValue,
} from './types.js'

function ruleValue(toolName: string, ruleContent?: string): PermissionRuleValue {
  return ruleContent === undefined
    ? { toolName }
    : { toolName, ruleContent }
}

function ask(over: Partial<PermissionAskInput>): PermissionAskInput {
  return {
    toolName: 'Bash',
    riskLevel: 'execute',
    input: { command: 'echo hi' },
    inputPreview: 'Command: echo hi',
    mode: 'default',
    suggestedRules: [],
    ...over,
  }
}

describe('isHighRiskRule', () => {
  it('flags Bash(rm:*) — the headline case', () => {
    assert.equal(isHighRiskRule(ruleValue('Bash', 'rm:*')), true)
  })

  it('flags Bash(sudo:*) and Bash(su:*) (privilege escalation)', () => {
    assert.equal(isHighRiskRule(ruleValue('Bash', 'sudo:*')), true)
    assert.equal(isHighRiskRule(ruleValue('Bash', 'su:*')), true)
  })

  it('flags Bash(sh:*) / Bash(bash:*) (pipe-to-shell vector)', () => {
    assert.equal(isHighRiskRule(ruleValue('Bash', 'sh:*')), true)
    assert.equal(isHighRiskRule(ruleValue('Bash', 'bash:*')), true)
    assert.equal(isHighRiskRule(ruleValue('Bash', 'zsh:*')), true)
  })

  it('flags Bash(dd:*) and mkfs variants (disk-destroying)', () => {
    assert.equal(isHighRiskRule(ruleValue('Bash', 'dd:*')), true)
    assert.equal(isHighRiskRule(ruleValue('Bash', 'mkfs:*')), true)
    assert.equal(isHighRiskRule(ruleValue('Bash', 'mkfs.ext4:*')), true)
  })

  it('flags Bash(eval:*)', () => {
    assert.equal(isHighRiskRule(ruleValue('Bash', 'eval:*')), true)
  })

  it('does NOT flag common benign Bash heads (curl / git / npm / chmod)', () => {
    assert.equal(isHighRiskRule(ruleValue('Bash', 'curl:*')), false)
    assert.equal(isHighRiskRule(ruleValue('Bash', 'git push:*')), false)
    assert.equal(isHighRiskRule(ruleValue('Bash', 'npm install:*')), false)
    // chmod/chown are deliberately benign — common in workflows like
    // `chmod +x deploy.sh` and a permanent grant is reasonable.
    assert.equal(isHighRiskRule(ruleValue('Bash', 'chmod:*')), false)
    assert.equal(isHighRiskRule(ruleValue('Bash', 'chown:*')), false)
  })

  it('flags Edit/Write under /etc, /usr, /boot, /sys, /proc', () => {
    assert.equal(isHighRiskRule(ruleValue('Edit', '/etc/nginx/**')), true)
    assert.equal(isHighRiskRule(ruleValue('Write', '/usr/local/bin/**')), true)
    assert.equal(isHighRiskRule(ruleValue('Edit', '/boot/grub/**')), true)
    assert.equal(isHighRiskRule(ruleValue('Edit', '/sys/devices/**')), true)
    assert.equal(isHighRiskRule(ruleValue('Read', '/proc/sys/**')), true)
  })

  it('flags Edit/Write into ~/.ssh / .gnupg / .aws / .kube', () => {
    assert.equal(isHighRiskRule(ruleValue('Edit', '/home/alice/.ssh/**')), true)
    assert.equal(isHighRiskRule(ruleValue('Edit', '/Users/alice/.gnupg/**')), true)
    assert.equal(isHighRiskRule(ruleValue('Write', '/root/.aws/**')), true)
    assert.equal(isHighRiskRule(ruleValue('Edit', '/home/bob/.kube/**')), true)
  })

  it('does NOT flag Edit/Write under benign user paths', () => {
    assert.equal(isHighRiskRule(ruleValue('Edit', '/home/alice/code/**')), false)
    assert.equal(isHighRiskRule(ruleValue('Write', '/tmp/foo/**')), false)
    assert.equal(isHighRiskRule(ruleValue('Read', '/var/log/**')), false)
  })

  it('returns false for tool-wide fallbacks (no ruleContent)', () => {
    assert.equal(isHighRiskRule(ruleValue('Bash')), false)
    assert.equal(isHighRiskRule(ruleValue('Edit')), false)
  })

  it('returns false for unrelated tools (WebFetch / MCP / etc.)', () => {
    assert.equal(isHighRiskRule(ruleValue('WebFetch', 'example.com')), false)
    assert.equal(isHighRiskRule(ruleValue('MCP', 'server:tool')), false)
  })
})

describe('containsHighRiskRule (chained spec)', () => {
  it('TRUE when any rule in the group is high-risk — the headline spec', () => {
    // `cd /tmp && rm -rf foo` → suggester emits [Bash(cd:*), Bash(rm:*)]
    assert.equal(
      containsHighRiskRule([
        ruleValue('Bash', 'cd:*'),
        ruleValue('Bash', 'rm:*'),
      ]),
      true,
      'rm in a chain poisons the whole grant',
    )
  })

  it('FALSE when all rules in the group are benign', () => {
    assert.equal(
      containsHighRiskRule([
        ruleValue('Bash', 'curl:*'),
        ruleValue('Bash', 'git push:*'),
      ]),
      false,
    )
  })

  it('FALSE for an empty group', () => {
    assert.equal(containsHighRiskRule([]), false)
  })
})

describe('isHighRiskRulePattern', () => {
  it('parses and flags high-risk persisted rule patterns', () => {
    assert.equal(isHighRiskRulePattern('Bash(rm:*)'), true)
    assert.equal(isHighRiskRulePattern('Bash(sudo:*)'), true)
    assert.equal(isHighRiskRulePattern('Bash(mkfs.ext4:*)'), true)
    assert.equal(isHighRiskRulePattern('Edit(/etc/passwd)'), true)
  })

  it('returns false for benign or malformed patterns', () => {
    assert.equal(isHighRiskRulePattern('Bash(rsync:*)'), false)
    assert.equal(isHighRiskRulePattern('Read(/var/log/app.log)'), false)
    assert.equal(isHighRiskRulePattern('Edit(/tmp/foo)'), false)
    assert.equal(isHighRiskRulePattern('Bash[rm]'), false)
  })
})

describe('commandContainsHighRiskBash (raw-command fallback)', () => {
  it('catches `rm -rf foo` directly', () => {
    assert.equal(commandContainsHighRiskBash('rm -rf foo'), true)
  })

  it('catches `cd /tmp && rm -rf foo` (chained — the headline case)', () => {
    assert.equal(commandContainsHighRiskBash('cd /tmp && rm -rf foo'), true)
  })

  it('catches pipe-to-shell `curl example.com | sh`', () => {
    // splitter splits on `|` so `sh` is its own segment with head `sh`.
    assert.equal(commandContainsHighRiskBash('curl example.com | sh'), true)
  })

  it('catches `wget -O- url | bash`', () => {
    assert.equal(commandContainsHighRiskBash('wget -O- url | bash'), true)
  })

  it('catches `sudo apt-get update`', () => {
    assert.equal(commandContainsHighRiskBash('sudo apt-get update'), true)
  })

  it('catches `dd if=/dev/zero of=/dev/sda`', () => {
    assert.equal(commandContainsHighRiskBash('dd if=/dev/zero of=/dev/sda'), true)
  })

  it('catches env-prefixed `DEBUG=1 rm foo`', () => {
    assert.equal(commandContainsHighRiskBash('DEBUG=1 rm foo'), true)
  })

  it('does NOT flag benign chains (git / npm / curl alone)', () => {
    assert.equal(commandContainsHighRiskBash('git status && npm test'), false)
    assert.equal(commandContainsHighRiskBash('curl https://example.com'), false)
    assert.equal(commandContainsHighRiskBash('echo hello | grep ello'), false)
  })

  it('does NOT mistake a quoted "rm" inside another command', () => {
    // The token after `echo` is a quoted string; splitter keeps it inside
    // the segment, head extractor returns `echo`, not `rm`.
    assert.equal(commandContainsHighRiskBash('echo "rm -rf is dangerous"'), false)
  })
})

describe('isHighRiskAsk (top-level driver)', () => {
  it('TRUE for FeishuWriteConfirm virtual approval asks', () => {
    assert.equal(
      isHighRiskAsk(ask({
        toolName: 'FeishuWriteConfirm',
        riskLevel: 'write',
        input: {
          operation: 'append-doc',
          resource: { documentId: 'doc_123' },
          preview: 'Append 20 chars to a Feishu doc.',
        },
        inputPreview: 'Append 20 chars to a Feishu doc.',
      })),
      true,
    )
  })

  it('TRUE for FeishuDeleteConfirm virtual approval asks', () => {
    assert.equal(
      isHighRiskAsk(ask({
        toolName: 'FeishuDeleteConfirm',
        riskLevel: 'write',
        input: {
          operation: 'delete',
          resource: { token: 'doc_123' },
          preview: 'Delete doc.',
        },
        inputPreview: 'Delete doc.',
      })),
      true,
    )
  })

  it('TRUE when suggested rules contain a high-risk rule', () => {
    assert.equal(
      isHighRiskAsk(ask({
        suggestedRules: [
          ruleValue('Bash', 'cd:*'),
          ruleValue('Bash', 'rm:*'),
        ],
      })),
      true,
    )
  })

  it('TRUE via raw-command fallback when suggested rules are empty', () => {
    assert.equal(
      isHighRiskAsk(ask({
        suggestedRules: [],
        input: { command: 'cd /tmp && rm foo' },
      })),
      true,
    )
  })

  it('TRUE via raw-input fallback for Edit on a sensitive path', () => {
    assert.equal(
      isHighRiskAsk(ask({
        toolName: 'Edit',
        suggestedRules: [],
        input: { file_path: '/etc/nginx/nginx.conf' },
      })),
      true,
    )
  })

  it('FALSE when both suggested and raw input are benign', () => {
    assert.equal(
      isHighRiskAsk(ask({
        suggestedRules: [ruleValue('Bash', 'curl:*')],
        input: { command: 'curl https://example.com' },
      })),
      false,
    )
  })
})
