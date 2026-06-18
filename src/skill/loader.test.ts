import { promises as fs } from 'node:fs'
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { userSkillsRoot } from '../identity/paths.js'
import { createUserMessage } from '../messages.js'
import { createSessionContext, runWithSessionContext } from '../session-context.js'
import {
  discoverSkills,
  discoverSkillsForUser,
  recordSkillUsage,
  writeUserSkill,
} from './loader.js'
import {
  buildRegisteredSkillInvocation,
  refreshSkillRegistry,
} from './registry.js'

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'lightclaw-skill-loader-'))
  const prev = process.env.LIGHTCLAW_HOME
  process.env.LIGHTCLAW_HOME = home
  try {
    await fn(home)
  } finally {
    if (prev === undefined) {
      delete process.env.LIGHTCLAW_HOME
    } else {
      process.env.LIGHTCLAW_HOME = prev
    }
    await rm(home, { recursive: true, force: true })
  }
}

async function writeRawSkill(
  root: string,
  dirName: string,
  frontmatter: string,
  body = 'Body.',
): Promise<void> {
  const dir = path.join(root, dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8')
}

describe('discoverSkillsForUser', () => {
  it('loads per-user skills only when a user id is present', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'alice-skill',
        'name: alice-skill\ndescription: Alice only.',
      )

      const bundledOnly = await discoverSkills(process.cwd())
      assert.equal(bundledOnly.some(skill => skill.name === 'alice-skill'), false)

      const aliceSkills = await discoverSkillsForUser(process.cwd(), 'alice')
      const custom = aliceSkills.find(s => s.name === 'alice-skill')
      assert.ok(custom, 'per-user skill should load for its canonical user')
      assert.equal(custom.source, 'user')

      const bobSkills = await discoverSkillsForUser(process.cwd(), 'bob')
      assert.equal(bobSkills.some(skill => skill.name === 'alice-skill'), false)
    })
  })

  it('does not load skills archived under the _archive sink', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'active-skill',
        'name: active-skill\ndescription: Still active.',
      )
      // A well-formed SKILL.md sitting under _archive/ must stay invisible —
      // skill-aging moves retired skills here and the loader must not surface
      // them.
      await writeRawSkill(
        path.join(userSkillsRoot('alice'), '_archive'),
        'archived-skill',
        'name: archived-skill\ndescription: Was archived.',
      )
      const skills = await discoverSkillsForUser(process.cwd(), 'alice')
      const names = skills.map(skill => skill.name)
      assert.equal(names.includes('active-skill'), true)
      assert.equal(names.includes('archived-skill'), false)
    })
  })

  it('does not scan the retired global <home>/skills directory', async () => {
    await withTempHome(async home => {
      await writeRawSkill(
        path.join(home, 'skills'),
        'global-skill',
        'name: global-skill\ndescription: Old global skill.',
      )
      const skills = await discoverSkillsForUser(process.cwd(), 'alice')
      assert.equal(skills.some(skill => skill.name === 'global-skill'), false)
    })
  })

  it('keeps the bundled skill when a user skill reuses its name', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'remember',
        'name: remember\ndescription: A user skill shadowing the bundled remember.',
      )
      const skills = await discoverSkillsForUser(process.cwd(), 'alice')
      const remember = skills.find(s => s.name === 'remember')
      assert.ok(remember, 'remember skill should be present')
      assert.equal(
        remember.source,
        'builtin',
        'bundled remember must win over a same-name user skill',
      )
    })
  })

  it('still loads a user skill whose name does not collide', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'my-custom-skill',
        'name: my-custom-skill\ndescription: A uniquely named user skill.',
      )
      const skills = await discoverSkillsForUser(process.cwd(), 'alice')
      const custom = skills.find(s => s.name === 'my-custom-skill')
      assert.ok(custom, 'non-colliding user skill should load')
      assert.equal(custom.source, 'user')
    })
  })

  it('parses allowed-tools and rejects the retired allowed_tools key', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'kebab-tools',
        'name: kebab-tools\ndescription: Uses kebab key.\nallowed-tools:\n  - Read\n  - Grep',
      )
      const skills = await discoverSkillsForUser(process.cwd(), 'alice')
      assert.deepEqual(
        skills.find(skill => skill.name === 'kebab-tools')?.allowedTools,
        ['Read', 'Grep'],
      )

      await writeRawSkill(
        userSkillsRoot('alice'),
        'old-tools',
        'name: old-tools\ndescription: Uses old key.\nallowed_tools:\n  - Read',
      )
      await assert.rejects(
        discoverSkillsForUser(process.cwd(), 'alice'),
        /deprecated frontmatter key "allowed_tools"/,
      )
    })
  })

  it('parses roles and falls back old user skills to main', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'coder-flow',
        [
          'name: coder-flow',
          'description: A coder workflow.',
          'roles:',
          '  - coder',
          '  - reviewer',
        ].join('\n'),
      )
      await writeRawSkill(
        userSkillsRoot('alice'),
        'legacy-main-flow',
        'name: legacy-main-flow\ndescription: No roles yet.',
      )

      const skills = await discoverSkillsForUser(process.cwd(), 'alice')
      assert.deepEqual(skills.find(skill => skill.name === 'coder-flow')?.roles, [
        'coder',
        'reviewer',
      ])
      assert.deepEqual(skills.find(skill => skill.name === 'legacy-main-flow')?.roles, [
        'main',
      ])
    })
  })

  it('rejects invalid roles frontmatter', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'bad-scalar-role',
        'name: bad-scalar-role\ndescription: Bad.\nroles: coder',
      )
      await assert.rejects(
        discoverSkillsForUser(process.cwd(), 'alice'),
        /roles" must be a YAML list/,
      )
    })

    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'bad-empty-role',
        'name: bad-empty-role\ndescription: Bad.\nroles:\n  - ""',
      )
      await assert.rejects(
        discoverSkillsForUser(process.cwd(), 'alice'),
        /roles" must contain at least one role name/,
      )
    })

    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'bad-role-name',
        'name: bad-role-name\ndescription: Bad.\nroles:\n  - ../coder',
      )
      await assert.rejects(
        discoverSkillsForUser(process.cwd(), 'alice'),
        /invalid role name/,
      )
    })
  })

  it('parses last_used_at and exposes cached recency on SkillMeta', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'recent-flow',
        [
          'name: recent-flow',
          'description: Has timestamp.',
          'roles:',
          '  - main',
          'last_used_at: 2026-05-24T10:00:00.000Z',
        ].join('\n'),
      )
      await writeRawSkill(
        userSkillsRoot('alice'),
        'never-used-flow',
        [
          'name: never-used-flow',
          'description: No timestamp.',
          'roles:',
          '  - main',
        ].join('\n'),
      )

      const skills = await discoverSkillsForUser(process.cwd(), 'alice')
      const recent = skills.find(skill => skill.name === 'recent-flow')
      const neverUsed = skills.find(skill => skill.name === 'never-used-flow')
      const recentStat = await stat(recent!.filePath)
      assert.equal(
        recent?.lastUsedAt,
        '2026-05-24T10:00:00.000Z',
      )
      assert.equal(
        neverUsed?.lastUsedAt,
        undefined,
      )
      assert.ok(Number.isFinite(recent?.recencyMs))
      assert.ok(Number.isFinite(neverUsed?.recencyMs))
      assert.ok(recent!.recencyMs! >= Date.parse('2026-05-24T10:00:00.000Z'))
      assert.ok(recent!.recencyMs! >= recentStat.mtimeMs)
    })
  })

  it('parses dispatch_brief and exposes it on SkillMeta', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'handoff-contract',
        [
          'name: handoff-contract',
          'description: Carries manager-facing handoff requirements.',
          'roles:',
          '  - coder',
          'dispatch_brief: Ask the requester to pick the image before dispatch; do not script setup commands.',
        ].join('\n'),
      )

      const skills = await discoverSkillsForUser(process.cwd(), 'alice')
      assert.equal(
        skills.find(skill => skill.name === 'handoff-contract')?.dispatchBrief,
        'Ask the requester to pick the image before dispatch; do not script setup commands.',
      )
    })
  })

  it('parses requires-driver and rejects unknown drivers', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'brainpp-flow',
        [
          'name: brainpp-flow',
          'description: Needs Brain++.',
          'roles:',
          '  - main',
          'requires-driver: brainpp',
        ].join('\n'),
      )

      const skills = await discoverSkillsForUser(process.cwd(), 'alice')
      assert.equal(
        skills.find(skill => skill.name === 'brainpp-flow')?.requiresDriver,
        'brainpp',
      )
    })

    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'slurm-flow',
        [
          'name: slurm-flow',
          'description: Unknown driver.',
          'roles:',
          '  - main',
          'requires-driver: slurm',
        ].join('\n'),
      )
      await assert.rejects(
        discoverSkillsForUser(process.cwd(), 'alice'),
        /requires-driver" must be one of: brainpp/,
      )
    })
  })
})

describe('recordSkillUsage', () => {
  it('inserts last_used_at when missing and replaces it when present', async () => {
    await withTempHome(async () => {
      await writeRawSkill(
        userSkillsRoot('alice'),
        'flow-a',
        [
          'name: flow-a',
          'description: No stamp yet.',
          'roles:',
          '  - main',
        ].join('\n'),
      )
      const flowAPath = path.join(userSkillsRoot('alice'), 'flow-a', 'SKILL.md')
      await recordSkillUsage(flowAPath, '2026-05-24T12:00:00.000Z')
      const flowA = await discoverSkillsForUser(process.cwd(), 'alice')
      assert.equal(
        flowA.find(skill => skill.name === 'flow-a')?.lastUsedAt,
        '2026-05-24T12:00:00.000Z',
      )

      await writeRawSkill(
        userSkillsRoot('alice'),
        'flow-b',
        [
          'name: flow-b',
          'description: Has old stamp.',
          'roles:',
          '  - main',
          'last_used_at: 2025-01-01T00:00:00.000Z',
        ].join('\n'),
      )
      const flowBPath = path.join(userSkillsRoot('alice'), 'flow-b', 'SKILL.md')
      await recordSkillUsage(flowBPath, '2026-05-24T13:00:00.000Z')
      const flowB = await discoverSkillsForUser(process.cwd(), 'alice')
      assert.equal(
        flowB.find(skill => skill.name === 'flow-b')?.lastUsedAt,
        '2026-05-24T13:00:00.000Z',
      )
    })
  })

  it('silently no-ops when the file is missing or has no frontmatter', async () => {
    await withTempHome(async home => {
      // Missing file: no throw.
      await recordSkillUsage(path.join(home, 'nonexistent', 'SKILL.md'))

      // No frontmatter at all: leaves file untouched.
      const plainPath = path.join(home, 'plain.md')
      await writeFile(plainPath, 'Body only, no frontmatter.\n', 'utf8')
      await recordSkillUsage(plainPath)
      const plainAfter = await import('node:fs/promises').then(fs => fs.readFile(plainPath, 'utf8'))
      assert.equal(plainAfter, 'Body only, no frontmatter.\n')
    })
  })
})

describe('writeUserSkill', () => {
  it('writes a validated per-user SKILL.md with private file permissions', async () => {
    await withTempHome(async () => {
      const meta = await writeUserSkill({
        userId: 'alice',
        name: 'data-cleanup',
        markdown:
          '---\n' +
          'name: data-cleanup\n' +
          'description: Clean a dataset.\n' +
          'when_to_use: When a dataset needs normalization.\n' +
          'allowed-tools:\n' +
          '  - Read\n' +
          '  - Write\n' +
          '---\n\n' +
          'Steps here.\n',
      })

      assert.equal(meta.name, 'data-cleanup')
      assert.equal(meta.source, 'user')
      assert.deepEqual(meta.allowedTools, ['Read', 'Write'])
      assert.deepEqual(meta.roles, ['main'])
      assert.equal(meta.dispatchBrief, undefined)
      assert.equal((await stat(meta.filePath)).mode & 0o777, 0o600)
    })
  })

  it('preserves dispatch_brief when writing a user skill', async () => {
    await withTempHome(async () => {
      const meta = await writeUserSkill({
        userId: 'alice',
        name: 'cluster-handoff',
        markdown:
          '---\n' +
          'name: cluster-handoff\n' +
          'description: Prepare cluster handoffs.\n' +
          'dispatch_brief: Confirm image and GPU count before dispatch; leave job mechanics to the worker.\n' +
          '---\n\n' +
          'Steps here.\n',
      })

      assert.equal(
        meta.dispatchBrief,
        'Confirm image and GPU count before dispatch; leave job mechanics to the worker.',
      )
    })
  })

  it('preserves a multi-line dispatch_brief through role stamping (blank lines survive)', async () => {
    await withTempHome(async () => {
      // Role stamping rewrites the frontmatter to swap `roles:`. A multi-line
      // `dispatch_brief: |` with a paragraph break must come back byte-intact —
      // regression for the `\n{2,}` collapse that used to eat the blank line.
      const meta = await writeUserSkill({
        userId: 'alice',
        name: 'deploy-thing',
        stampRoles: ['coder'],
        markdown:
          '---\n' +
          'name: deploy-thing\n' +
          'description: Deploy a thing.\n' +
          'dispatch_brief: |\n' +
          '  Settle the target and the rollback plan before you delegate:\n' +
          '  - the cluster or namespace;\n' +
          '  - whether a rollback is pre-approved.\n' +
          '\n' +
          "  A deploy can be refused; if so, don't re-dispatch it.\n" +
          'roles:\n' +
          '  - main\n' +
          '---\n\n' +
          'Steps here.\n',
      })

      assert.deepEqual(meta.roles, ['coder'])
      assert.equal(
        meta.dispatchBrief,
        'Settle the target and the rollback plan before you delegate:\n' +
          '- the cluster or namespace;\n' +
          '- whether a rollback is pre-approved.\n' +
          '\n' +
          "A deploy can be refused; if so, don't re-dispatch it.",
      )
    })
  })

  it('writes supporting scripts and references with private file permissions', async () => {
    await withTempHome(async () => {
      const meta = await writeUserSkill({
        userId: 'alice',
        name: 'data-helper',
        markdown:
          '---\nname: data-helper\ndescription: Uses helper files.\n---\n\n' +
          'Run ${LIGHTCLAW_SKILL_DIR}/scripts/parse.py.\n',
        files: [
          { path: 'scripts/parse.py', content: 'print("ok")\n' },
          { path: 'references/schema.md', content: '# Schema\n' },
        ],
      })

      const skillDir = path.dirname(meta.filePath)
      const scriptPath = path.join(skillDir, 'scripts', 'parse.py')
      const referencePath = path.join(skillDir, 'references', 'schema.md')
      assert.equal(await readFile(scriptPath, 'utf8'), 'print("ok")\n')
      assert.equal(await readFile(referencePath, 'utf8'), '# Schema\n')
      assert.equal((await stat(scriptPath)).mode & 0o777, 0o600)
      assert.equal((await stat(referencePath)).mode & 0o777, 0o600)
    })
  })

  it('rejects invalid names, frontmatter mismatches, shell injection, and accidental overwrite', async () => {
    await withTempHome(async () => {
      await assert.rejects(
        writeUserSkill({
          userId: 'alice',
          name: '../escape',
          markdown: '---\nname: ../escape\ndescription: Bad.\n---\n\nBody.\n',
        }),
        /Skill name must be a kebab-case identifier/,
      )

      await assert.rejects(
        writeUserSkill({
          userId: 'alice',
          name: 'one-name',
          markdown: '---\nname: other-name\ndescription: Bad.\n---\n\nBody.\n',
        }),
        /must match requested name/,
      )

      await assert.rejects(
        writeUserSkill({
          userId: 'alice',
          name: 'shell-hint',
          markdown: '---\nname: shell-hint\ndescription: Bad.\n---\n\nRun !`rm -rf /`.\n',
        }),
        /shell-injection syntax/,
      )

      const markdown = '---\nname: repeatable\ndescription: First.\n---\n\nBody.\n'
      await writeUserSkill({ userId: 'alice', name: 'repeatable', markdown })
      await assert.rejects(
        writeUserSkill({ userId: 'alice', name: 'repeatable', markdown }),
        /already exists/,
      )
      await writeUserSkill({
        userId: 'alice',
        name: 'repeatable',
        markdown: '---\nname: repeatable\ndescription: Revised.\n---\n\nNew body.\n',
        overwrite: true,
      })
    })
  })

  it('rejects writing a bundled skill name (create or overwrite)', async () => {
    await withTempHome(async () => {
      const markdown = '---\nname: remember\ndescription: Shadow attempt.\n---\n\nBody.\n'
      await assert.rejects(
        writeUserSkill({ userId: 'alice', name: 'remember', markdown }),
        /bundled and cannot be overwritten/,
      )
      await assert.rejects(
        writeUserSkill({ userId: 'alice', name: 'remember', markdown, overwrite: true }),
        /bundled and cannot be overwritten/,
      )
    })
  })

  it('rejects supporting files outside scripts/ and references/', async () => {
    await withTempHome(async () => {
      const markdown = '---\nname: file-paths\ndescription: Path checks.\n---\n\nBody.\n'
      for (const filePath of ['../x', '/abs', 'assets/x', 'x.py']) {
        await assert.rejects(
          writeUserSkill({
            userId: 'alice',
            name: 'file-paths',
            markdown,
            files: [{ path: filePath, content: 'x' }],
          }),
          /scripts\/ or references\//,
          `expected ${filePath} to be rejected`,
        )
      }
    })
  })

  it('enforces supporting file count and size caps', async () => {
    await withTempHome(async () => {
      const markdown = '---\nname: capped-files\ndescription: Cap checks.\n---\n\nBody.\n'
      await assert.rejects(
        writeUserSkill({
          userId: 'alice',
          name: 'capped-files',
          markdown,
          files: [{ path: 'scripts/too-large.py', content: 'x'.repeat(64 * 1024 + 1) }],
        }),
        /byte limit/,
      )

      await assert.rejects(
        writeUserSkill({
          userId: 'alice',
          name: 'capped-files',
          markdown,
          files: Array.from({ length: 33 }, (_, index) => ({
            path: `references/${index}.md`,
            content: 'x',
          })),
        }),
        /32 file limit/,
      )

      await assert.rejects(
        writeUserSkill({
          userId: 'alice',
          name: 'capped-files',
          markdown,
          files: Array.from({ length: 5 }, (_, index) => ({
            path: `references/part-${index}.md`,
            content: 'x'.repeat(60 * 1024),
          })),
        }),
        /byte total limit/,
      )
    })
  })

  it('treats overwrite as a full replacement and drops omitted supporting files', async () => {
    await withTempHome(async () => {
      const firstMarkdown = '---\nname: replace-all\ndescription: First.\n---\n\nBody.\n'
      await writeUserSkill({
        userId: 'alice',
        name: 'replace-all',
        markdown: firstMarkdown,
        files: [
          { path: 'scripts/old.py', content: 'print("old")\n' },
          { path: 'references/keep.md', content: 'old docs\n' },
        ],
      })

      await writeUserSkill({
        userId: 'alice',
        name: 'replace-all',
        markdown: '---\nname: replace-all\ndescription: Second.\n---\n\nNew body.\n',
        overwrite: true,
        files: [{ path: 'scripts/new.py', content: 'print("new")\n' }],
      })

      const skillDir = path.join(userSkillsRoot('alice'), 'replace-all')
      await assert.rejects(readFile(path.join(skillDir, 'scripts', 'old.py'), 'utf8'), {
        code: 'ENOENT',
      })
      await assert.rejects(readFile(path.join(skillDir, 'references', 'keep.md'), 'utf8'), {
        code: 'ENOENT',
      })
      assert.equal(
        await readFile(path.join(skillDir, 'scripts', 'new.py'), 'utf8'),
        'print("new")\n',
      )
    })
  })

  it('preserves the prior skill directory when the staged swap fails', async () => {
    await withTempHome(async () => {
      await writeUserSkill({
        userId: 'alice',
        name: 'swap-safe',
        markdown: '---\nname: swap-safe\ndescription: First.\n---\n\nOld body.\n',
        files: [{ path: 'scripts/old.py', content: 'print("old")\n' }],
      })

      const originalRename = fs.rename.bind(fs)
      const renameMock = mock.method(fs, 'rename', async (
        oldPath: Parameters<typeof fs.rename>[0],
        newPath: Parameters<typeof fs.rename>[1],
      ) => {
        if (String(oldPath).includes('.tmp-')) {
          throw new Error('mock swap failure')
        }
        return originalRename(oldPath, newPath)
      })
      try {
        await assert.rejects(
          writeUserSkill({
            userId: 'alice',
            name: 'swap-safe',
            markdown: '---\nname: swap-safe\ndescription: Second.\n---\n\nNew body.\n',
            overwrite: true,
            files: [{ path: 'scripts/new.py', content: 'print("new")\n' }],
          }),
          /mock swap failure/,
        )
      } finally {
        renameMock.mock.restore()
      }

      const skillDir = path.join(userSkillsRoot('alice'), 'swap-safe')
      assert.match(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), /Old body/)
      assert.equal(
        await readFile(path.join(skillDir, 'scripts', 'old.py'), 'utf8'),
        'print("old")\n',
      )
      await assert.rejects(readFile(path.join(skillDir, 'scripts', 'new.py'), 'utf8'), {
        code: 'ENOENT',
      })
    })
  })

  it('replaces $ARGUMENTS when rendering a registered skill invocation', async () => {
    await withTempHome(async () => {
      await writeUserSkill({
        userId: 'alice',
        name: 'arg-skill',
        markdown:
          '---\nname: arg-skill\ndescription: Uses arguments.\n---\n\n' +
          'Handle: $ARGUMENTS\n',
      })

      await refreshSkillRegistry(process.cwd(), 'alice')
      const content = await buildRegisteredSkillInvocation('arg-skill', 'dataset.csv')
      assert.match(content ?? '', /Handle: dataset\.csv/)
      assert.doesNotMatch(content ?? '', /\$ARGUMENTS/)
    })
  })

  it('replaces ${LIGHTCLAW_SKILL_DIR} with the user skill directory at invocation time', async () => {
    await withTempHome(async () => {
      await writeUserSkill({
        userId: 'alice',
        name: 'asset-skill',
        markdown:
          '---\nname: asset-skill\ndescription: References asset directory.\n---\n\n' +
          'Run "${LIGHTCLAW_SKILL_DIR}/scripts/extract.py" to do the work.\n',
      })

      await refreshSkillRegistry(process.cwd(), 'alice')
      const content = await buildRegisteredSkillInvocation('asset-skill')
      const expectedDir = path.join(userSkillsRoot('alice'), 'asset-skill')
      assert.ok(
        content?.includes(`Run "${expectedDir}/scripts/extract.py"`),
        `invocation must inject user skill directory, got:\n${content}`,
      )
      assert.doesNotMatch(content ?? '', /\$\{LIGHTCLAW_SKILL_DIR\}/)
    })
  })

  it('leaves bundled invocations untouched when their body has no ${LIGHTCLAW_SKILL_DIR}', async () => {
    await withTempHome(async () => {
      await refreshSkillRegistry(process.cwd(), undefined)
      const content = await buildRegisteredSkillInvocation('remember')
      // remember body does not reference the placeholder; the invocation
      // must not contain the literal placeholder string either.
      assert.doesNotMatch(content ?? '', /\$\{LIGHTCLAW_SKILL_DIR\}/)
    })
  })

  it('replaces skillify session template variables when rendering the bundled invocation', async () => {
    await withTempHome(async home => {
      const sessionsDir = path.join(home, 'sessions')
      const sessionId = 'skillify-session'
      await mkdir(path.join(sessionsDir, sessionId), { recursive: true })
      await writeFile(
        path.join(sessionsDir, sessionId, 'session-memory.md'),
        '# Session Working Memory\n\nThe user established a release checklist.\n',
        'utf8',
      )
      await writeFile(
        path.join(sessionsDir, sessionId, 'transcript.jsonl'),
        `${JSON.stringify(createUserMessage('以后 release 都先跑 pnpm test，再开 PR。'))}\n`,
        'utf8',
      )
      const ctx = createSessionContext({
        cwd: process.cwd(),
        model: 'claude-sonnet-4-6',
        sessionsDir,
        memoryDir: path.join(home, 'memory', 'alice'),
        currentUserId: 'alice',
        sessionId,
      })

      await runWithSessionContext(ctx, async () => {
        await refreshSkillRegistry(process.cwd(), 'alice')
        const content = await buildRegisteredSkillInvocation('skillify')
        assert.match(content ?? '', /# Skillify for alice/)
        assert.match(content ?? '', /The user established a release checklist/)
        assert.match(content ?? '', /以后 release 都先跑 pnpm test/)
        assert.doesNotMatch(content ?? '', /\{\{sessionMemory\}\}/)
        assert.doesNotMatch(content ?? '', /\{\{userMessages\}\}/)
        assert.doesNotMatch(content ?? '', /\{\{userDescriptionBlock\}\}/)
      })
    })
  })
})
