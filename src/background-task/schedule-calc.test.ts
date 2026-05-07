import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeNextRunAt } from './schedule-calc.js'

describe('background-task schedule calculation', () => {
  it('returns a future oneshot time', () => {
    const next = computeNextRunAt(
      { kind: 'oneshot', at: '2026-05-08T10:00:00.000+08:00' },
      new Date('2026-05-07T10:00:00.000+08:00'),
    )
    assert.equal(next?.toISOString(), '2026-05-08T02:00:00.000Z')
  })

  it('drops expired oneshot schedules', () => {
    const next = computeNextRunAt(
      { kind: 'oneshot', at: '2026-05-07T09:00:00.000+08:00' },
      new Date('2026-05-07T10:00:00.000+08:00'),
    )
    assert.equal(next, null)
  })

  it('finds the next weekly recurring wall-clock time', () => {
    const next = computeNextRunAt(
      { kind: 'recurring', daysOfWeek: [1], hour: 9, minute: 30 },
      new Date('2026-05-04T09:30:00.000+08:00'),
    )
    assert.equal(next?.getDay(), 1)
    assert.equal(next?.getHours(), 9)
    assert.equal(next?.getMinutes(), 30)
    assert.ok(next!.getTime() > new Date('2026-05-04T09:30:00.000+08:00').getTime())
  })

  it('computes interval schedules from anchorAt', () => {
    const next = computeNextRunAt(
      {
        kind: 'interval',
        everyMinutes: 15,
        anchorAt: '2026-05-07T10:00:00.000+08:00',
      },
      new Date('2026-05-07T10:16:00.000+08:00'),
    )
    assert.equal(next?.toISOString(), '2026-05-07T02:30:00.000Z')
  })
})
