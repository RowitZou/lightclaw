import test from 'node:test'
import assert from 'node:assert/strict'

import {
  brainppDockerImageProbe,
  isImageMissingError,
  isTransientPullError,
} from './image-readiness.js'

test('isTransientPullError matches GHCR auth-probe EOF', () => {
  assert.equal(
    isTransientPullError('Get "https://ghcr.io/v2/": EOF'),
    true,
  )
})

test('isTransientPullError matches TLS handshake timeout', () => {
  assert.equal(
    isTransientPullError('Get "https://ghcr.io/v2/": net/http: TLS handshake timeout'),
    true,
  )
})

test('isTransientPullError matches i/o timeout / connection reset', () => {
  assert.equal(
    isTransientPullError('Get "https://ghcr.io/v2/": dial tcp: i/o timeout'),
    true,
  )
  assert.equal(
    isTransientPullError('read tcp 1.2.3.4:443->5.6.7.8:443: connection reset by peer'),
    true,
  )
})

test('isTransientPullError rejects manifest unknown (permanent)', () => {
  assert.equal(
    isTransientPullError('Error response from daemon: manifest unknown'),
    false,
  )
})

test('isTransientPullError rejects unauthorized (permanent)', () => {
  assert.equal(
    isTransientPullError('unauthorized: authentication required'),
    false,
  )
  assert.equal(
    isTransientPullError('pull access denied for ghcr.io/x/y, repository does not exist or may require authorization'),
    false,
  )
})

test('isTransientPullError rejects clean / unrelated messages', () => {
  assert.equal(isTransientPullError('docker pull exited with code 1'), false)
  assert.equal(isTransientPullError(''), false)
})

test('isImageMissingError still catches the classic wording', () => {
  assert.equal(isImageMissingError('manifest unknown'), true)
  assert.equal(isImageMissingError('repository ghcr.io/x/y not found'), true)
  assert.equal(isImageMissingError('Get "https://ghcr.io/v2/": EOF'), false)
})

test('brainppDockerImageProbe checks rjob and keeps remediation local', () => {
  const probe = brainppDockerImageProbe()

  assert.equal(probe.key, 'brainpp-rjob')
  assert.match(probe.command, /command -v rjob/)
  assert.match(
    probe.failureMessage('lightclaw-sandbox:brainpp', 'missing'),
    /image has not been uploaded/i,
  )
})
