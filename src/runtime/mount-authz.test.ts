import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  filesetKeyFromGpfsMount,
  observePuyuclawMode,
} from './mount-authz.js'

test('observePuyuclawMode reads the effective ro/rw flag from /proc/mounts', () => {
  const mounts = [
    'kataShared /datasets/ro virtiofs ro,relatime 0 0',
    'kataShared /datasets/rw virtiofs rw,relatime 0 0',
  ].join('\n')
  assert.equal(observePuyuclawMode(mounts, '/datasets/ro'), 'ro')
  assert.equal(observePuyuclawMode(mounts, '/datasets/rw'), 'rw')
  assert.equal(observePuyuclawMode(mounts, '/datasets/missing'), 'none')
})

test('filesetKeyFromGpfsMount extracts the gpfs fileset prefix', () => {
  assert.equal(
    filesetKeyFromGpfsMount('gpfs://cluster/fileset/some/path:/some/path'),
    'gpfs://cluster/fileset',
  )
})
