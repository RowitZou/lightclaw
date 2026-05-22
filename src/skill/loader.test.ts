import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { discoverSkills } from './loader.js'

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

async function writeUserSkill(
  home: string,
  dirName: string,
  frontmatter: string,
): Promise<void> {
  const dir = path.join(home, 'skills', dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\nBody.\n`, 'utf8')
}

describe('discoverSkills — bundled/user collision guard', () => {
  it('keeps the bundled skill when a user skill reuses its name', async () => {
    await withTempHome(async home => {
      await writeUserSkill(
        home,
        'remember',
        'name: remember\ndescription: A user skill shadowing the bundled remember.',
      )
      const skills = await discoverSkills(process.cwd())
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
    await withTempHome(async home => {
      await writeUserSkill(
        home,
        'my-custom-skill',
        'name: my-custom-skill\ndescription: A uniquely named user skill.',
      )
      const skills = await discoverSkills(process.cwd())
      const custom = skills.find(s => s.name === 'my-custom-skill')
      assert.ok(custom, 'non-colliding user skill should load')
      assert.equal(custom.source, 'user')
    })
  })
})
