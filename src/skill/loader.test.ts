import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { userSkillsRoot } from '../identity/paths.js'
import {
  discoverSkills,
  discoverSkillsForUser,
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
      assert.equal((await stat(meta.filePath)).mode & 0o777, 0o600)
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
})
