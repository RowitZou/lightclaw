import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { AddressInfo } from 'node:net'

import type { LightClawConfig, NetworkBridgeSettings } from '../config.js'
import {
  buildBlockList,
  NetworkBridge,
} from './network-bridge.js'
import {
  buildBridgeEnv,
  buildDockerRuntimeConfig,
  buildRlaunchRuntimeConfig,
  detectHostIp,
} from './pool.js'

describe('NetworkBridge proxy resolution', () => {
  function bridgeFor(proxy: string | null): NetworkBridge {
    return new NetworkBridge({
      mode: 'host',
      proxy,
      port: 0,
      bindHost: '127.0.0.1',
      acl: [],
    })
  }

  it('null proxy yields direct mode', () => {
    const status = bridgeFor(null).status()
    assert.equal(status.upstreamSource, 'direct')
    assert.equal(status.upstreamSanitized, null)
  })

  it('explicit URL is preserved (sanitized)', () => {
    const status = bridgeFor('http://upstream.example:3128').status()
    assert.equal(status.upstreamSource, 'explicit')
    assert.equal(status.upstreamSanitized, 'http://upstream.example:3128/')
  })

  it('credentials in proxy URL are stripped from sanitized status', () => {
    const status = bridgeFor('http://user:secret@upstream.example:3128').status()
    assert.equal(status.upstreamSource, 'explicit')
    assert.match(status.upstreamSanitized ?? '', /^http:\/\/upstream\.example:3128/)
    assert.doesNotMatch(status.upstreamSanitized ?? '', /secret/)
  })

  it('whitespace-only proxy degrades to direct', () => {
    const status = bridgeFor('   ').status()
    assert.equal(status.upstreamSource, 'direct')
  })
})

describe('buildBlockList', () => {
  it('accepts addresses inside the configured CIDRs', () => {
    const list = buildBlockList(['100.100.0.0/16', '172.17.0.0/16'])
    assert.equal(list.check('100.100.245.246', 'ipv4'), true)
    assert.equal(list.check('172.17.0.5', 'ipv4'), true)
    assert.equal(list.check('127.0.0.1', 'ipv4'), true)
  })

  it('rejects addresses outside the configured CIDRs', () => {
    const list = buildBlockList(['100.100.0.0/16'])
    assert.equal(list.check('8.8.8.8', 'ipv4'), false)
    assert.equal(list.check('192.168.1.1', 'ipv4'), false)
  })

  it('always allows loopback even with empty admin ACL', () => {
    const list = buildBlockList([])
    assert.equal(list.check('127.0.0.1', 'ipv4'), true)
  })
})

describe('buildBridgeEnv', () => {
  it('emits both lower and upper case proxy env keys', () => {
    const env = buildBridgeEnv('100.100.245.246', 18080)
    assert.equal(env.http_proxy, 'http://100.100.245.246:18080')
    assert.equal(env.HTTP_PROXY, 'http://100.100.245.246:18080')
    assert.equal(env.https_proxy, 'http://100.100.245.246:18080')
    assert.equal(env.HTTPS_PROXY, 'http://100.100.245.246:18080')
    assert.match(env.no_proxy, /127\.0\.0\.1/)
  })
})

describe('detectHostIp', () => {
  it('returns a non-internal IPv4 from the host', () => {
    const ip = detectHostIp()
    // We don't assert any specific subnet; just that it's a parseable IPv4
    // and not a loopback fallback (unless this dev box really has nothing).
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/)
  })
})

describe('pool config builders with network.mode=host', () => {
  const networkHost: NetworkBridgeSettings = {
    mode: 'host',
    proxy: 'http://corp-proxy:1091',
    port: 18080,
    bindHost: '0.0.0.0',
    acl: ['100.100.0.0/16'],
  }
  const networkIsolated: NetworkBridgeSettings = {
    ...networkHost,
    mode: 'isolated',
  }

  function makeConfig(network: NetworkBridgeSettings): LightClawConfig {
    return {
      runtime: {
        backend: 'docker',
        network,
        docker: {
          idleTimeoutMs: 1_800_000,
          memoryLimit: '4g',
          cpuLimit: 4,
          network: 'bridge',
          mounts: [],
          tmpfs: ['/tmp'],
          env: {},
          autoPull: true,
        },
        rlaunch: {
          image: 'registry/x:tag',
          chargedGroup: 'hs_cpu',
          namespace: 'ailab-hs',
          cpu: 8,
          memoryMb: 16000,
          gpu: 0,
          privateMachine: 'group',
          positiveTags: [],
          gpfsHostPrefix: '/mnt/shared-storage-user',
          gpfsMountPrefix: 'gpfs://gpfs1',
          imagePullPolicy: 'IfNotPresent',
          maxWaitDuration: '5m',
          workerGcTimeHours: 24,
          predictBeforeStart: true,
          healthCheckIntervalMs: 300_000,
          preheatOnStartup: true,
          preheatOnApproval: true,
          env: {},
        },
      },
    } as unknown as LightClawConfig
  }

  it('docker host mode flips --network and injects loopback proxy env', () => {
    const cfg = buildDockerRuntimeConfig('alice', '/tmp/ws', makeConfig(networkHost), 'deadbeef')
    assert.equal(cfg.network, 'host')
    assert.equal(cfg.env.http_proxy, 'http://127.0.0.1:18080')
    assert.equal(cfg.env.HTTPS_PROXY, 'http://127.0.0.1:18080')
  })

  it('docker isolated mode preserves bridge network and skips proxy env', () => {
    const cfg = buildDockerRuntimeConfig('alice', '/tmp/ws', makeConfig(networkIsolated), 'deadbeef')
    assert.equal(cfg.network, 'bridge')
    assert.equal(cfg.env.http_proxy, undefined)
  })

  it('admin docker.env wins over auto-injected bridge env', () => {
    const c = makeConfig(networkHost)
    c.runtime.docker.env = { http_proxy: 'http://override:1' }
    const cfg = buildDockerRuntimeConfig('alice', '/tmp/ws', c, 'deadbeef')
    assert.equal(cfg.env.http_proxy, 'http://override:1')
    assert.equal(cfg.env.HTTPS_PROXY, 'http://127.0.0.1:18080', 'other keys still default')
  })

  it('rlaunch host mode injects host eth0 IP, not loopback', () => {
    const cfg = buildRlaunchRuntimeConfig('alice', '/mnt/shared-storage-user/x', makeConfig(networkHost), 'deadbeef')
    assert.match(cfg.env.http_proxy, /^http:\/\/\d+\.\d+\.\d+\.\d+:18080$/)
    assert.notEqual(cfg.env.http_proxy, 'http://127.0.0.1:18080',
      'rlaunch worker is on a different node — must not use loopback')
  })
})

describe('NetworkBridge end-to-end (direct mode, no upstream)', () => {
  it('serves an HTTP request and counts it', async () => {
    // Origin server we will fetch through the bridge.
    const origin = http.createServer((_req, res) => {
      res.statusCode = 200
      res.end('hello-from-origin')
    })
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
    const originPort = (origin.address() as AddressInfo).port

    const bridge = new NetworkBridge({
      mode: 'host',
      proxy: null,
      port: 0,                 // ask OS for a free port
      bindHost: '127.0.0.1',
      acl: [],                 // loopback is always allowed
    })
    await bridge.start()
    const status = bridge.status()
    assert.equal(status.running, true)
    assert.equal(status.upstreamSource, 'direct')
    assert.equal(status.upstreamSanitized, null)

    const bridgePort = (bridge as unknown as { server: { port: number } }).server.port

    // Use the bridge as an HTTP forward proxy: client opens a TCP connection
    // to the bridge and sends an absolute-form request line.
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: bridgePort,
        method: 'GET',
        path: `http://127.0.0.1:${originPort}/`,
        headers: { Host: `127.0.0.1:${originPort}` },
      }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(body, 'hello-from-origin')
    assert.equal(bridge.status().requestCount, 1)

    await bridge.stop()
    origin.close()
  })
})
