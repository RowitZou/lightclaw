import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildReadOnlyRemountCommand,
  observePuyuclawMode,
  resolveGrantedMode,
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

test('resolveGrantedMode makes ro automatic and gates rw on admin plus puyuclaw rw', () => {
  assert.equal(resolveGrantedMode('ro', 'ro', false), 'ro')
  assert.equal(resolveGrantedMode('ro', 'rw', false), 'ro')
  assert.equal(resolveGrantedMode('rw', 'rw', true), 'rw')
  assert.throws(() => resolveGrantedMode('rw', 'rw', false), /admin approval/)
  assert.throws(() => resolveGrantedMode('rw', 'ro', true), /read-only/)
  assert.throws(() => resolveGrantedMode('ro', 'none', false), /not mounted/)
})

test('read-only downgrade uses a self-bind followed by a bind remount', () => {
  const command = buildReadOnlyRemountCommand('/datasets/team data')
  assert.match(command, /mount --bind/)
  assert.match(command, /mount -o remount,ro,bind/)
  assert.match(command, /'\/datasets\/team data'/)
})
