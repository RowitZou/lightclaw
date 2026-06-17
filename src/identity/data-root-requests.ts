import path from 'node:path'

import type { LightClawConfig } from '../config.js'
import { validateUserDataRootPath } from './data-root.js'
import { identitiesPath } from './paths.js'
import { getIdentity, readJson, setUserDataRoot, writeJsonSecure } from './store.js'

export type DataRootRequest = {
  canonicalUser: string
  rawPath: string
  normalizedPath: string
  createdAt: string
  updatedAt: string
}

type DataRootRequestsFile = {
  requests?: Record<string, DataRootRequest>
}

function requestsPath(): string {
  return path.join(path.dirname(identitiesPath()), 'data-root-requests.json')
}

export async function listDataRootRequests(): Promise<DataRootRequest[]> {
  const file = await readJson<DataRootRequestsFile>(requestsPath(), { requests: {} })
  return Object.values(file.requests ?? {}).sort((a, b) => a.canonicalUser.localeCompare(b.canonicalUser))
}

export async function requestDataRootChange(input: {
  canonicalUser: string
  rawPath: string
  config: LightClawConfig
}): Promise<{ ok: true; request: DataRootRequest } | { ok: false; reason: string }> {
  if (!(await getIdentity(input.canonicalUser))) {
    return { ok: false, reason: `No such user: ${input.canonicalUser}` }
  }
  const validation = await validateUserDataRootPath(input.rawPath, input.config)
  if (!validation.ok) {
    return { ok: false, reason: validation.reason }
  }
  const now = new Date().toISOString()
  const file = await readJson<DataRootRequestsFile>(requestsPath(), { requests: {} })
  const prior = file.requests?.[input.canonicalUser]
  const request: DataRootRequest = {
    canonicalUser: input.canonicalUser,
    rawPath: input.rawPath,
    normalizedPath: validation.path,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  }
  await writeJsonSecure(requestsPath(), {
    requests: {
      ...(file.requests ?? {}),
      [input.canonicalUser]: request,
    },
  } satisfies DataRootRequestsFile)
  return { ok: true, request }
}

export async function approveDataRootRequest(input: {
  canonicalUser: string
  config: LightClawConfig
}): Promise<{ ok: true; request: DataRootRequest } | { ok: false; reason: string }> {
  const file = await readJson<DataRootRequestsFile>(requestsPath(), { requests: {} })
  const request = file.requests?.[input.canonicalUser]
  if (!request) {
    return { ok: false, reason: `No pending dataRoot request for ${input.canonicalUser}` }
  }
  const validation = await validateUserDataRootPath(request.normalizedPath, input.config)
  if (!validation.ok) {
    return { ok: false, reason: validation.reason }
  }
  const result = await setUserDataRoot(input.canonicalUser, validation.path)
  if (!result.ok) {
    return { ok: false, reason: `No such user: ${input.canonicalUser}` }
  }
  delete file.requests![input.canonicalUser]
  await writeJsonSecure(requestsPath(), file)
  return {
    ok: true,
    request: {
      ...request,
      normalizedPath: validation.path,
    },
  }
}

export async function rejectDataRootRequest(canonicalUser: string): Promise<boolean> {
  const file = await readJson<DataRootRequestsFile>(requestsPath(), { requests: {} })
  if (!file.requests?.[canonicalUser]) {
    return false
  }
  delete file.requests[canonicalUser]
  await writeJsonSecure(requestsPath(), file)
  return true
}
