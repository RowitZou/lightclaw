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
  assert.deepEqual(resolveGrantedMode('ro', 'ro', false), { status: 'ok', mode: 'ro' })
  assert.deepEqual(resolveGrantedMode('ro', 'rw', false), { status: 'ok', mode: 'ro' })
  assert.deepEqual(resolveGrantedMode('rw', 'rw', true), { status: 'ok', mode: 'rw' })
  // Unreachable double-gate assertion: config layer never sends unapproved rw.
  assert.throws(() => resolveGrantedMode('rw', 'rw', false), /admin approval/)
  // Approved rw but storage only ro: degrade to ro instead of failing.
  assert.deepEqual(resolveGrantedMode('rw', 'ro', true), { status: 'degraded-ro', mode: 'ro' })
  // Storage never mounted the path: report unmountable instead of failing.
  assert.deepEqual(resolveGrantedMode('ro', 'none', false), { status: 'unmountable' })
})

test('read-only downgrade uses a self-bind followed by a bind remount', () => {
  const command = buildReadOnlyRemountCommand('/datasets/team data')
  assert.match(command, /mount --bind/)
  assert.match(command, /mount -o remount,ro,bind/)
  assert.match(command, /'\/datasets\/team data'/)
})
