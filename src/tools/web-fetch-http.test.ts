import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { AxiosError } from 'axios'

import {
  _setHttpGetForTests,
  daemonFetchUrl,
} from './web-fetch-http.js'

function buildResponse(opts: {
  status?: number
  data: ArrayBuffer | Buffer
  contentType?: string
  finalUrl?: string
}): unknown {
  const data =
    opts.data instanceof Buffer
      ? opts.data.buffer.slice(
          opts.data.byteOffset,
          opts.data.byteOffset + opts.data.byteLength,
        )
      : opts.data
  // Build a minimal axios-shaped object — only fields daemonFetchUrl reads.
  // `request.res.responseUrl` is the Node http-adapter post-redirect URL.
  // Return as `unknown` so the test stub's generic doesn't have to match
  // axios's strict AxiosResponse<T> shape (which requires
  // InternalAxiosRequestConfig.headers to be AxiosHeaders, not undefined).
  return {
    status: opts.status ?? 200,
    statusText: 'OK',
    data,
    headers: { 'content-type': opts.contentType ?? 'text/html; charset=utf-8' },
    config: {},
    request: {
      res: { responseUrl: opts.finalUrl ?? 'https://example.com/' },
    },
  }
}

describe('web-fetch-http (unit, stubbed axios)', () => {
  afterEach(() => {
    _setHttpGetForTests(null)
  })

  it('200 OK → returns status / finalUrl / contentType / bytes correctly', async () => {
    const payload = Buffer.from('<html><body>hi</body></html>', 'utf-8')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setHttpGetForTests((async () =>
      buildResponse({
        data: payload,
        contentType: 'text/html; charset=utf-8',
        finalUrl: 'https://example.com/page',
      })) as any)
    const ctrl = new AbortController()
    const result = await daemonFetchUrl('https://example.com/page', ctrl.signal)
    assert.equal(result.status, 200)
    assert.equal(result.finalUrl, 'https://example.com/page')
    assert.equal(result.contentType, 'text/html; charset=utf-8')
    assert.equal(result.bytes.toString('utf-8'), '<html><body>hi</body></html>')
  })

  it('308 redirect chain handled by axios maxRedirects:10 → finalUrl differs from input', async () => {
    // We don't need to simulate the actual hop sequence; axios's internal
    // adapter does that and exposes the terminal URL on
    // request.res.responseUrl. The unit-test contract is: daemonFetchUrl
    // surfaces whatever final URL axios reports, NOT the initial input.
    // (This is the regression case for 5/11 Bug 11: pre-httpx urllib raised
    // HTTPError on 308 and finalUrl never moved; post-migration axios
    // follows 308 and finalUrl reflects the trailing-slash terminal.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _setHttpGetForTests((async () =>
      buildResponse({
        data: Buffer.from('<html>final</html>'),
        finalUrl: 'https://www.alphaxiv.org/feed/',  // 308 terminal after /feed
      })) as any)
    const ctrl = new AbortController()
    const result = await daemonFetchUrl('https://www.alphaxiv.org/feed', ctrl.signal)
    assert.equal(result.finalUrl, 'https://www.alphaxiv.org/feed/')
    assert.notEqual(result.finalUrl, 'https://www.alphaxiv.org/feed')
  })

  it('4xx response → axios throws AxiosError; daemonFetchUrl re-throws unchanged', async () => {
    // Axios's default validateStatus rejects 4xx/5xx — we keep that default
    // so the WebFetch tool's `WebFetch failed (exit 1): fetch failed: <msg>`
    // envelope wraps the AxiosError.message naturally. No custom error
    // shape; admin grep gets the standard `Request failed with status code 404`
    // or `HTTP 404 Not Found` line.
    _setHttpGetForTests(async () => {
      const err = new AxiosError('Request failed with status code 404')
      // Cast response through `unknown` — AxiosError.response is typed with
      // InternalAxiosRequestConfig which requires the full Axios headers
      // class; for unit-test purposes we only need .status visible to the
      // test assertion below.
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
    const ctrl = new AbortController()
    await assert.rejects(
      () => daemonFetchUrl('https://example.com/missing', ctrl.signal),
      (err: Error) => {
        assert.ok(
          err.message.includes('404'),
          `expected 404 in error message, got: ${err.message}`,
        )
        return true
      },
    )
  })

  it('timeout (ECONNABORTED) → axios surfaces "timeout of Xms exceeded"; rethrown unchanged', async () => {
    // The timeoutMs option arrives via axios config.timeout; when exceeded,
    // axios throws AxiosError with code ECONNABORTED and message "timeout
    // of <ms>ms exceeded". We don't customize this — admin sees the axios
    // standard string. This is also what Bug 7 (WebSearch 实时联网查询
    // 环境超时) wanted: a clear timeout signal in stderr.
    _setHttpGetForTests(async () => {
      const err = new AxiosError('timeout of 60000ms exceeded')
      err.code = 'ECONNABORTED'
      throw err
    })
    const ctrl = new AbortController()
    await assert.rejects(
      () => daemonFetchUrl('https://example.com/slow', ctrl.signal),
      /timeout of 60000ms exceeded/,
    )
  })
})
