import { BlockList, isIP } from 'node:net'

import { Server, type PrepareRequestFunctionResult } from 'proxy-chain'

import type { NetworkBridgeSettings } from '../config.js'

export type NetworkBridgeStatus = {
  running: boolean
  bindHost: string
  port: number
  upstreamSource: 'direct' | 'explicit'
  /** Sanitized upstream — never includes credentials. */
  upstreamSanitized: string | null
  acl: string[]
  noProxy: string[]
  /** Total proxy requests served (HTTP + CONNECT). */
  requestCount: number
  /** Requests rejected by ACL. */
  aclRejectedCount: number
  /** Requests that bypassed the upstream proxy via noProxy. */
  noProxyHitCount: number
}

const SUPPORTED_PREFIXES = ['127.0.0.0/8', '::1/128']

export class NetworkBridge {
  private server: Server | null = null
  private readonly blockList: BlockList
  private readonly upstreamUrl: string | null
  private readonly upstreamSource: 'direct' | 'explicit'
  private readonly upstreamSanitized: string | null
  private readonly noProxyMatch: (host: string) => boolean
  private requestCount = 0
  private aclRejectedCount = 0
  private noProxyHitCount = 0

  constructor(private readonly settings: NetworkBridgeSettings) {
    const trimmed = settings.proxy ? settings.proxy.trim() : ''
    this.upstreamUrl = trimmed || null
    this.upstreamSource = this.upstreamUrl ? 'explicit' : 'direct'
    this.upstreamSanitized = this.upstreamUrl ? sanitizeUpstream(this.upstreamUrl) : null
    this.blockList = buildBlockList(settings.acl)
    this.noProxyMatch = compileNoProxy(settings.noProxy)
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }
    const server = new Server({
      port: this.settings.port,
      host: this.settings.bindHost,
      verbose: false,
      prepareRequestFunction: opts => this.handlePrepare(opts),
    })
    // proxy-chain emits 'requestFailed' for upstream / IO errors. Surface
    // them to stderr so admin can diagnose, but don't crash the process.
    server.on('requestFailed', ({ error }) => {
      process.stderr.write(`[network-bridge] request failed: ${error?.message ?? error}\n`)
    })
    await server.listen()
    this.server = server
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return
    }
    const server = this.server
    this.server = null
    await server.close(true).catch(() => undefined)
  }

  status(): NetworkBridgeStatus {
    return {
      running: this.server !== null,
      bindHost: this.settings.bindHost,
      port: this.settings.port,
      upstreamSource: this.upstreamSource,
      upstreamSanitized: this.upstreamSanitized,
      acl: [...this.settings.acl],
      noProxy: [...this.settings.noProxy],
      requestCount: this.requestCount,
      aclRejectedCount: this.aclRejectedCount,
      noProxyHitCount: this.noProxyHitCount,
    }
  }

  private handlePrepare(opts: {
    request: { socket?: { remoteAddress?: string | null } }
    hostname?: string
  }): PrepareRequestFunctionResult {
    const remote = normalizeAddress(opts.request.socket?.remoteAddress ?? '')
    if (!remote || !this.isAllowed(remote)) {
      this.aclRejectedCount += 1
      return {
        customResponseFunction: () => ({
          statusCode: 403,
          body: 'NetworkBridge: source not allowed by ACL.\n',
        }),
        failMsg: `Source ${remote || '<unknown>'} not in ACL`,
      }
    }
    this.requestCount += 1
    // noProxy is consulted only when an upstream is configured —
    // direct mode already bypasses everything, no decision to make.
    if (this.upstreamUrl) {
      const dest = stripBrackets(opts.hostname ?? '')
      if (dest && this.noProxyMatch(dest)) {
        this.noProxyHitCount += 1
        return {}
      }
      return { upstreamProxyUrl: this.upstreamUrl }
    }
    return {}
  }

  private isAllowed(remote: string): boolean {
    const family = remote.includes(':') ? 'ipv6' : 'ipv4'
    return this.blockList.check(remote, family)
  }
}

export function buildBlockList(acl: readonly string[]): BlockList {
  // BlockList.check with no rules accepts nothing, so the ACL drives the
  // entire allow surface. This is the safe default — admin must explicitly
  // list the source CIDRs.
  const list = new BlockList()
  for (const entry of acl) {
    addCidr(list, entry)
  }
  // Loopback is always implicit (LightClaw's own probes / docker --network host
  // that share the host loopback). ACL still controls cluster-side access.
  for (const fallback of SUPPORTED_PREFIXES) {
    addCidr(list, fallback)
  }
  return list
}

function addCidr(list: BlockList, entry: string): void {
  const trimmed = entry.trim()
  if (!trimmed) return
  const slash = trimmed.indexOf('/')
  const family = trimmed.includes(':') ? 'ipv6' : 'ipv4'
  if (slash < 0) {
    list.addAddress(trimmed, family)
    return
  }
  const address = trimmed.slice(0, slash)
  const prefix = Number(trimmed.slice(slash + 1))
  if (!Number.isFinite(prefix)) return
  list.addSubnet(address, prefix, family)
}

function normalizeAddress(remote: string): string {
  if (remote.startsWith('::ffff:')) {
    return remote.slice('::ffff:'.length)
  }
  return remote
}

/**
 * Compile a `no_proxy` pattern list into a fast destination matcher.
 * Patterns follow standard `no_proxy` conventions:
 *   - CIDR (`10.0.0.0/8`, `100.96.0.0/12`) — matched against IP literals
 *     only; never resolves DNS, by design (avoids `proxy-bypass via DNS`
 *     class of attacks where a hostile DNS resolves a public name to an
 *     internal IP).
 *   - leading-dot suffix (`.pjlab.org.cn`) — matches that domain and any
 *     subdomain.
 *   - exact hostname (`gpfs1.pjlab.org.cn`) — matches that string only.
 * Empty / whitespace entries are dropped silently.
 */
export function compileNoProxy(patterns: readonly string[]): (host: string) => boolean {
  const cidr = new BlockList()
  let hasCidr = false
  const exact = new Set<string>()
  const suffixes: string[] = []
  for (const raw of patterns) {
    const trimmed = raw.trim().toLowerCase()
    if (!trimmed) continue
    if (trimmed.includes('/')) {
      addCidr(cidr, trimmed)
      hasCidr = true
      continue
    }
    if (trimmed.startsWith('.')) {
      suffixes.push(trimmed)
      continue
    }
    exact.add(trimmed)
  }
  return (host: string): boolean => {
    if (!host) return false
    const lower = host.toLowerCase()
    if (exact.has(lower)) return true
    for (const sfx of suffixes) {
      // .pjlab.org.cn matches both pjlab.org.cn (the apex itself) and
      // x.pjlab.org.cn (subdomains).
      if (lower === sfx.slice(1) || lower.endsWith(sfx)) return true
    }
    if (hasCidr) {
      const family = isIP(lower)
      if (family === 4 && cidr.check(lower, 'ipv4')) return true
      if (family === 6 && cidr.check(lower, 'ipv6')) return true
    }
    return false
  }
}

function stripBrackets(host: string): string {
  // proxy-chain mostly hands us bare hostnames, but be defensive — IPv6
  // literals are conventionally bracketed in URLs.
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function sanitizeUpstream(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return '<invalid-url>'
  }
}
