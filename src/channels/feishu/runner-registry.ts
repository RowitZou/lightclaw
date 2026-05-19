// Module-level handle to the active ChannelRunner instance, registered
// by feishu-channel.start() and cleared on stop(). Read by paths outside
// the runner that need to inject synthetic inbound messages — currently
// only the post-approval replay (identity/post-approve.ts) which feeds
// the applicant's pre-approval text back through the normal pipeline so
// it gets answered as the first turn after pairing.
//
// Single-channel design like sender-registry: at most one feishu channel
// per process. Switch to a Map<channelId, ChannelRunner> if we ever fan
// out to multiple tenants.

import type { ChannelRunner } from '../runner.js'
import type { PermissionApprover } from '../../permission/types.js'

let activeRunner: ChannelRunner | null = null

export function registerChannelRunner(runner: ChannelRunner): void {
  activeRunner = runner
}

export function clearChannelRunner(runner: ChannelRunner): void {
  if (activeRunner === runner) {
    activeRunner = null
  }
}

export function getChannelRunner(): ChannelRunner | null {
  return activeRunner
}

export async function getChannelApproverFor(
  canonicalUser: string,
  sessionId: string,
): Promise<PermissionApprover | null> {
  return await activeRunner?.createPermissionApproverFor({
    canonicalUser,
    sessionId,
  }) ?? null
}
