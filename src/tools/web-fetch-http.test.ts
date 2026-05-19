import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { AxiosError } from 'axios'

import {
  CrossHostRedirectError,
  RedirectLimitError,
  SsrfRedirectError,
  _internalsForTests,
  _setHttpGetForTests,
  daemonFetchUrl,
} from './web-fetch-http.js'
import { _setWebRetryDelaysForTests } from './web-retry.js'

function buildResponse(opts: {
  status?: number
  data?: ArrayBuffer | Buffer
  contentType?: string
  location?: string
}): unknown {
  const dataBuf =
    opts.data ?? Buffer.from('')
  const data =
    dataBuf instanceof Buffer
      ? dataBuf.buffer.slice(
          dataBuf.byteOffset,
          dataBuf.byteOffset + dataBuf.byteLength,
        )
      : dataBuf
  // Build a minimal axios-shaped object — only fields daemonFetchUrl reads.
  // The new implementation reads `headers.location` for 3xx hops and
  // `headers.content-type` for 2xx terminations; finalUrl is now tracked
  // by daemonFetchUrl itself (no longer pulled from request.res.responseUrl).
  const headers: Record<string, string> = {
    'content-type': opts.contentType ?? 'text/html; charset=utf-8',
  }
  if (opts.location !== undefined) headers.location = opts.location
  return {
    status: opts.status ?? 200,
    statusText: opts.status === 200 || opts.status === undefined ? 'OK' : '',
    data,
    headers,
    config: {},
    request: {},
  }
}

describe('web-fetch-http (unit, stubbed axios)', () => {
  afterEach(() => {
    _setHttpGetForTests(null)
    _setWebRetryDelaysForTests(null)
  })

  it('200 OK → returns status / finalUrl / contentType / bytes / empty redirectChain', async () => {
    const payload = Buffer.from('<html><body>hi</body></html>', 'utf-8')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setHttpGetForTests((async () =>
      buildResponse({
        data: payload,
        contentType: 'text/html; charset=utf-8',
      })) as any)
    const ctrl = new AbortController()
    const result = await daemonFetchUrl('https://example.com/page', ctrl.signal)
    assert.equal(result.status, 200)
    assert.equal(result.finalUrl, 'https://example.com/page')
    assert.equal(result.contentType, 'text/html; charset=utf-8')
    assert.equal(result.bytes.toString('utf-8'), '<html><body>hi</body></html>')
    assert.deepEqual(result.redirectChain, [])
  })

  it('308 same-host redirect (trailing slash) → manual loop follows, finalUrl differs, chain captured', async () => {
    // Pre-fix axios maxRedirects:10 silently followed; post-fix daemonFetchUrl
    // walks the chain itself. Regression case for 5/11 Bug 11.
    const calls: string[] = []
    _setHttpGetForTests(async (url) => {
      calls.push(url)
      if (url === 'https://www.alphaxiv.org/feed') {
        return buildResponse({
          status: 308,
          location: 'https://www.alphaxiv.org/feed/',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      if (url === 'https://www.alphaxiv.org/feed/') {
        return buildResponse({
          data: Buffer.from('<html>final</html>'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      throw new Error(`unexpected url ${url}`)
    })
    const ctrl = new AbortController()
    const result = await daemonFetchUrl('https://www.alphaxiv.org/feed', ctrl.signal)
    assert.equal(result.finalUrl, 'https://www.alphaxiv.org/feed/')
    assert.deepEqual(calls, [
      'https://www.alphaxiv.org/feed',
      'https://www.alphaxiv.org/feed/',
    ])
    assert.deepEqual(result.redirectChain, ['https://www.alphaxiv.org/feed/'])
  })

  it('multi-hop same-host chain → all hops followed, chain captures every URL', async () => {
    _setHttpGetForTests(async (url) => {
      if (url === 'https://docs.example.com/v1/api') {
        return buildResponse({
          status: 301,
          location: 'https://docs.example.com/v2/api',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      if (url === 'https://docs.example.com/v2/api') {
        return buildResponse({
          status: 302,
          location: '/v2/api/',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      if (url === 'https://docs.example.com/v2/api/') {
        return buildResponse({
          data: Buffer.from('final'),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      throw new Error(`unexpected url ${url}`)
    })
    const ctrl = new AbortController()
    const result = await daemonFetchUrl(
      'https://docs.example.com/v1/api',
      ctrl.signal,
    )
    assert.equal(result.finalUrl, 'https://docs.example.com/v2/api/')
    assert.deepEqual(result.redirectChain, [
      'https://docs.example.com/v2/api',
      'https://docs.example.com/v2/api/',
    ])
  })

  it('cross-host redirect → throws CrossHostRedirectError without fetching the new host', async () => {
    const calls: string[] = []
    _setHttpGetForTests(async (url) => {
      calls.push(url)
      if (url === 'https://example.com/short') {
        return buildResponse({
          status: 302,
          location: 'https://different.com/long',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      throw new Error(`unexpected url ${url}`)
    })
    const ctrl = new AbortController()
    await assert.rejects(
      () => daemonFetchUrl('https://example.com/short', ctrl.signal),
      (err: unknown) => {
        assert.ok(err instanceof CrossHostRedirectError, 'expected CrossHostRedirectError')
        assert.equal(err.fromHost, 'example.com')
        assert.equal(err.toUrl, 'https://different.com/long')
        // Chain holds the ORIGIN + every accepted hop. The cross-host target
        // is NOT in the accepted chain (we threw before accepting it); the
        // error message body shows it via `.toUrl`.
        assert.deepEqual(err.redirectChain, ['https://example.com/short'])
        return true
      },
    )
    // Critical: only the origin URL was actually fetched. The would-be
    // cross-host target is NEVER requested — that's the whole defense.
    assert.deepEqual(calls, ['https://example.com/short'])
  })

  it('SSRF: redirect to AWS metadata IP literal (169.254.169.254) is blocked', async () => {
    const calls: string[] = []
    _setHttpGetForTests(async (url) => {
      calls.push(url)
      if (url === 'https://example.com/oauth') {
        return buildResponse({
          status: 302,
          location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      throw new Error(`unexpected url ${url}`)
    })
    const ctrl = new AbortController()
    await assert.rejects(
      () => daemonFetchUrl('https://example.com/oauth', ctrl.signal),
      (err: unknown) => {
        assert.ok(err instanceof SsrfRedirectError, 'expected SsrfRedirectError')
        assert.match(err.reason, /169\.254\.0\.0\/16|link-local|metadata/)
        assert.equal(
          err.blockedUrl,
          'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        )
        return true
      },
    )
    assert.deepEqual(calls, ['https://example.com/oauth'], 'metadata IP never reached')
  })

  it('SSRF: redirect to RFC1918 IP (10.0.0.1) is blocked', async () => {
    _setHttpGetForTests(async (url) => {
      if (url === 'https://example.com/redir') {
        return buildResponse({
          status: 302,
          location: 'http://10.0.0.1/admin',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      throw new Error(`unexpected url ${url}`)
    })
    const ctrl = new AbortController()
    await assert.rejects(
      () => daemonFetchUrl('https://example.com/redir', new AbortController().signal),
      (err: unknown) => {
        assert.ok(err instanceof SsrfRedirectError)
        assert.match(err.reason, /10\.0\.0\.0\/8|RFC1918/)
        return true
      },
    )
  })

  it('SSRF: redirect to loopback (127.0.0.1) is blocked', async () => {
    _setHttpGetForTests(async (url) => {
      if (url === 'https://example.com/redir') {
        return buildResponse({
          status: 302,
          location: 'http://127.0.0.1:8080/internal',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      throw new Error(`unexpected url ${url}`)
    })
    await assert.rejects(
      () =>
        daemonFetchUrl('https://example.com/redir', new AbortController().signal),
      (err: unknown) => {
        assert.ok(err instanceof SsrfRedirectError)
        assert.match(err.reason, /127\.0\.0\.0\/8|loopback/)
        return true
      },
    )
  })

  it('SSRF: redirect to literal "localhost" hostname is blocked', async () => {
    _setHttpGetForTests(async (url) => {
      if (url === 'https://example.com/redir') {
        return buildResponse({
          status: 302,
          location: 'http://localhost/admin',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      throw new Error(`unexpected url ${url}`)
    })
    await assert.rejects(
      () =>
        daemonFetchUrl('https://example.com/redir', new AbortController().signal),
      (err: unknown) => {
        assert.ok(err instanceof SsrfRedirectError)
        assert.match(err.reason, /localhost/)
        return true
      },
    )
  })

  it('SSRF: redirect to Alibaba Cloud metadata (100.100.100.200) is blocked', async () => {
    _setHttpGetForTests(async (url) => {
      if (url === 'https://example.com/redir') {
        return buildResponse({
          status: 302,
          location: 'http://100.100.100.200/latest/meta-data/',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      throw new Error(`unexpected url ${url}`)
    })
    await assert.rejects(
      () =>
        daemonFetchUrl('https://example.com/redir', new AbortController().signal),
      (err: unknown) => {
        assert.ok(err instanceof SsrfRedirectError)
        assert.match(err.reason, /Alibaba/)
        return true
      },
    )
  })

  it('SSRF: redirect to non-HTTP scheme (file://) is blocked', async () => {
    _setHttpGetForTests(async (url) => {
      if (url === 'https://example.com/redir') {
        return buildResponse({
          status: 302,
          location: 'file:///etc/passwd',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any
      }
      throw new Error(`unexpected url ${url}`)
    })
    await assert.rejects(
      () =>
        daemonFetchUrl('https://example.com/redir', new AbortController().signal),
      (err: unknown) => {
        assert.ok(err instanceof SsrfRedirectError)
        assert.match(err.reason, /non-HTTP/)
        return true
      },
    )
  })

  it('max-hops exceeded → throws RedirectLimitError', async () => {
    // Self-loop: each hop redirects to a different same-host path so we
    // never hit "cross-host" but we do march past MAX_REDIRECTS.
    _setHttpGetForTests(async (url) => {
      const next = url.match(/\/p(\d+)$/)
      const n = next ? Number.parseInt(next[1]!, 10) : 0
      return buildResponse({
        status: 302,
        location: `https://example.com/p${n + 1}`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    })
    await assert.rejects(
      () => daemonFetchUrl('https://example.com/p0', new AbortController().signal),
      (err: unknown) => {
        assert.ok(err instanceof RedirectLimitError, 'expected RedirectLimitError')
        assert.equal(
          err.redirectChain.length,
          _internalsForTests.MAX_REDIRECTS + 2,  // origin + MAX_REDIRECTS + 1 hops attempted
        )
        return true
      },
    )
  })

  it('3xx without Location header → AxiosError surfaced', async () => {
    _setHttpGetForTests(async () =>
      buildResponse({
        status: 302,
        // no location field
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    )
    await assert.rejects(
      () =>
        daemonFetchUrl('https://example.com/redir', new AbortController().signal),
      /missing Location header/,
    )
  })

  it('4xx response → AxiosError re-thrown unchanged (no redirect handling change)', async () => {
    _setHttpGetForTests(async () => {
      const err = new AxiosError('Request failed with status code 404')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      err.response = {
        status: 404,
        statusText: 'Not Found',
        data: '',
        headers: {},
        config: {},
      } as any
      throw err
    })
    await assert.rejects(
      () =>
        daemonFetchUrl('https://example.com/missing', new AbortController().signal),
      (err: Error) => {
        assert.ok(err.message.includes('404'))
        return true
      },
    )
  })

  it('timeout → axios surfaces "timeout of Xms exceeded"; rethrown unchanged', async () => {
    _setHttpGetForTests(async () => {
      const err = new AxiosError('timeout of 60000ms exceeded')
      err.code = 'ECONNABORTED'
      throw err
    })
    await assert.rejects(
      () => daemonFetchUrl('https://example.com/slow', new AbortController().signal),
      /timeout of 60000ms exceeded/,
    )
  })

  it('transient socket reset then 200 → withWebRetry recovers (pre-redirect path)', async () => {
    _setWebRetryDelaysForTests({ baseDelayMs: 1, maxDelayMs: 2 })
    let calls = 0
    _setHttpGetForTests((async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error(
          'Client network socket disconnected before secure TLS connection was established',
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(err as any).code = 'ECONNRESET'
        throw err
      }
      return buildResponse({ data: Buffer.from('<html>ok</html>') })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
    const result = await daemonFetchUrl(
      'https://example.com/page',
      new AbortController().signal,
    )
    assert.equal(calls, 2)
    assert.equal(result.bytes.toString('utf-8'), '<html>ok</html>')
  })

  it('503 then 200 → AxiosError.response.status retried (per-hop)', async () => {
    _setWebRetryDelaysForTests({ baseDelayMs: 1, maxDelayMs: 2 })
    let calls = 0
    _setHttpGetForTests((async () => {
      calls += 1
      if (calls < 3) {
        const err = new AxiosError('Request failed with status code 503')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        err.response = { status: 503, statusText: 'Service Unavailable' } as any
        throw err
      }
      return buildResponse({ data: Buffer.from('<html>up</html>') })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any)
    const result = await daemonFetchUrl(
      'https://example.com/',
      new AbortController().signal,
    )
    assert.equal(calls, 3)
    assert.equal(result.bytes.toString('utf-8'), '<html>up</html>')
  })

  it('4xx is NOT retried: fn called exactly once', async () => {
    _setWebRetryDelaysForTests({ baseDelayMs: 1, maxDelayMs: 2 })
    let calls = 0
    _setHttpGetForTests(async () => {
      calls += 1
      const err = new AxiosError('Request failed with status code 404')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      err.response = { status: 404, statusText: 'Not Found' } as any
      throw err
    })
    await assert.rejects(
      () =>
        daemonFetchUrl('https://example.com/missing', new AbortController().signal),
      /404/,
    )
    assert.equal(calls, 1)
  })
})

describe('classifyRedirectTarget (SSRF guard)', () => {
  const { classifyRedirectTarget } = _internalsForTests

  it('allows ordinary public-IP destinations', () => {
    assert.equal(classifyRedirectTarget('https://example.com/'), null)
    assert.equal(classifyRedirectTarget('https://93.184.216.34/'), null)  // example.com's IP
    assert.equal(classifyRedirectTarget('https://1.1.1.1/'), null)         // Cloudflare DNS
    assert.equal(classifyRedirectTarget('https://8.8.8.8/'), null)         // Google DNS
  })

  it('blocks cloud metadata IPv4 literals', () => {
    assert.match(classifyRedirectTarget('http://169.254.169.254/')!, /link-local|metadata/)
    assert.match(classifyRedirectTarget('http://169.254.169.254/latest/meta-data/')!, /link-local|metadata/)
    assert.match(classifyRedirectTarget('http://100.100.100.200/')!, /Alibaba/)
  })

  it('blocks all RFC1918 private ranges', () => {
    assert.match(classifyRedirectTarget('http://10.0.0.1/')!, /10\.0\.0\.0\/8/)
    assert.match(classifyRedirectTarget('http://10.255.255.255/')!, /10\.0\.0\.0\/8/)
    assert.match(classifyRedirectTarget('http://172.16.0.1/')!, /172\.16\.0\.0\/12/)
    assert.match(classifyRedirectTarget('http://172.31.255.255/')!, /172\.16\.0\.0\/12/)
    assert.match(classifyRedirectTarget('http://192.168.1.1/')!, /192\.168\.0\.0\/16/)
    assert.equal(classifyRedirectTarget('http://172.15.0.1/'), null, '172.15 is public')
    assert.equal(classifyRedirectTarget('http://172.32.0.1/'), null, '172.32 is public')
  })

  it('blocks loopback / wildcard / CGNAT / benchmarking ranges', () => {
    assert.match(classifyRedirectTarget('http://127.0.0.1/')!, /loopback/)
    assert.match(classifyRedirectTarget('http://127.255.255.255/')!, /loopback/)
    assert.match(classifyRedirectTarget('http://0.0.0.0/')!, /0\.0\.0\.0\/8/)
    assert.match(classifyRedirectTarget('http://100.64.0.1/')!, /CGNAT/)
    assert.match(classifyRedirectTarget('http://100.127.255.255/')!, /CGNAT/)
    assert.match(classifyRedirectTarget('http://198.18.0.1/')!, /benchmarking/)
  })

  it('blocks localhost / *.localhost hostname aliases', () => {
    assert.match(classifyRedirectTarget('http://localhost/')!, /localhost/)
    assert.match(classifyRedirectTarget('http://api.localhost/')!, /localhost/)
    assert.match(classifyRedirectTarget('http://LocalHost/')!, /localhost/, 'case-insensitive')
  })

  it('blocks IPv6 loopback / ULA / link-local', () => {
    assert.match(classifyRedirectTarget('http://[::1]/')!, /loopback/)
    assert.match(classifyRedirectTarget('http://[fc00::1]/')!, /ULA/)
    assert.match(classifyRedirectTarget('http://[fd00::1]/')!, /ULA/)
    assert.match(classifyRedirectTarget('http://[fe80::1]/')!, /link-local/)
  })

  it('blocks IPv4-mapped IPv6 → private IPv4', () => {
    assert.match(
      classifyRedirectTarget('http://[::ffff:169.254.169.254]/')!,
      /IPv4-mapped IPv6.*link-local|IPv4-mapped IPv6.*metadata/,
    )
    assert.match(
      classifyRedirectTarget('http://[::ffff:10.0.0.1]/')!,
      /IPv4-mapped IPv6.*RFC1918/,
    )
  })

  it('blocks non-HTTP(S) schemes', () => {
    assert.match(classifyRedirectTarget('file:///etc/passwd')!, /non-HTTP/)
    assert.match(classifyRedirectTarget('gopher://example.com/')!, /non-HTTP/)
    assert.match(classifyRedirectTarget('ftp://example.com/')!, /non-HTTP/)
  })

  it('rejects unparseable URLs', () => {
    assert.match(classifyRedirectTarget('not-a-url')!, /unparseable/)
    assert.match(classifyRedirectTarget('http://')!, /unparseable/)
  })

  it('passes IPv6 public addresses', () => {
    assert.equal(classifyRedirectTarget('http://[2001:db8::1]/'), null)
    assert.equal(classifyRedirectTarget('http://[2606:4700::1]/'), null)  // Cloudflare
  })
})
