// One-shot owner notification for a confirmed-revoked Codex credential.
//
// Trigger: the wire caller (`provider/openai-auth.ts`) got a 401 on a
// locally-valid access token, force-refreshed, and the refresh grant came back
// `invalid_grant` — the refresh-token family was rotated by another client or
// revoked server-side. From that moment every codex call on this credential
// fails until a human re-logins, so the CREDENTIAL OWNER (the BYO user, or
// admin for the deployment-global credential) gets one Feishu DM warning card
// with the recovery command, instead of discovering the outage from logs hours
// later (the 2026-06-30 incident: 13h of user-visible 401s before recovery).
//
// Dedup is per-process per credential: one card per outage. The marker clears
// when the credential resolves successfully again (re-login or a late refresh
// success), so a future outage on the same credential notifies again. Delivery
// is best-effort — no sender / no binding / send failure only logs stderr and
// (on send failure) re-arms the marker for a retry on the next 401.

export type CodexRevocationNoticeInput = {
  /** BYO endpoint owner (canonical user). Undefined = the admin-global
   *  `<home>/auth/codex.json` credential — resolved to admin at send time. */
  credentialOwner?: string
  /** BYO authRef (`codex:<name>`); undefined on the admin-global path. */
  authRef?: string
  /** Provider error message — carries the exact recovery command. */
  detail: string
}

const notifiedKeys = new Set<string>()

type DeliveryFn = (input: CodexRevocationNoticeInput) => Promise<void>
let deliveryOverride: DeliveryFn | null = null

/** Test seam: replace the Feishu delivery path. Pass null to restore. */
export function _setCodexRevocationNoticeDeliveryForTests(fn: DeliveryFn | null): void {
  deliveryOverride = fn
  notifiedKeys.clear()
}

function keyFor(input: Pick<CodexRevocationNoticeInput, 'credentialOwner' | 'authRef'>): string {
  return `${input.credentialOwner ?? '<global>'}|${input.authRef ?? 'codex'}`
}

/** Called on every successful codex credential resolve: a re-login (or a late
 *  refresh success) ends the outage, so the next revocation notifies again. */
export function clearCodexRevocationNotice(
  input: Pick<CodexRevocationNoticeInput, 'credentialOwner' | 'authRef'>,
): void {
  notifiedKeys.delete(keyFor(input))
}

/** Fire-and-forget: push one warning card to the credential owner's DM.
 *  Never throws — the caller is on a wire error path that must surface the
 *  original AuthError, not a notification failure. */
export function reportCodexCredentialRevoked(input: CodexRevocationNoticeInput): void {
  const key = keyFor(input)
  if (notifiedKeys.has(key)) return
  notifiedKeys.add(key)
  void (deliveryOverride ?? deliverViaFeishu)(input).catch(error => {
    // Send failure re-arms the marker so the next 401 retries the card.
    notifiedKeys.delete(key)
    process.stderr.write(
      `[codex-auth] revocation notice delivery failed for ${key}: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    )
  })
}

async function deliverViaFeishu(input: CodexRevocationNoticeInput): Promise<void> {
  // Dynamic imports keep this low-level auth module out of any static
  // module-load cycle with the channel layer (mirrors watchdog.ts's
  // session-resolve dynamic import pattern).
  const [{ getFeishuSender }, { getAdmin, getIdentity }, { buildSystemNoticeCard }, { t }] =
    await Promise.all([
      import('../../channels/feishu/sender-registry.js'),
      import('../../identity/store.js'),
      import('../../channels/feishu/system-notice.js'),
      import('../../i18n/index.js'),
    ])
  const owner = input.credentialOwner ?? (await getAdmin())
  if (!owner) {
    throw new Error('no credential owner resolvable (no admin configured)')
  }
  const identity = await getIdentity(owner).catch(() => null)
  const openId = identity?.channels.feishu[0]
  if (!openId) {
    throw new Error(`owner ${owner} has no feishu binding`)
  }
  const sender = getFeishuSender()
  if (!sender) {
    throw new Error('no active feishu sender')
  }
  await sender.sendInteractiveCardToOpenId(
    openId,
    buildSystemNoticeCard({
      kind: 'warning',
      bodyFormat: 'plain_text',
      content: t('auth.codex.revokedNotice', {
        ref: input.authRef ?? 'codex',
        detail: input.detail,
      }),
    }),
  )
}
