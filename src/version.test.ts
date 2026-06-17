import assert from 'node:assert/strict'
import test from 'node:test'

import { VERSION, getBuildId } from './version.js'

test('VERSION is a non-empty semver-ish string', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/)
})

test('getBuildId returns a git short sha (optionally -dirty) or unknown', () => {
  const build = getBuildId()
  // Run from inside the repo checkout, so it should resolve a real sha; the
  // `unknown` alternative keeps the assertion honest in a git-less sandbox.
  assert.match(build, /^([0-9a-f]{7,40}(-dirty)?|unknown)$/)
})

test('getBuildId is cached — repeated calls return the identical value', () => {
  assert.equal(getBuildId(), getBuildId())
})
