// Fold runtime startup-failure stderr (Docker / Rlaunch / image-readiness
// messages — `ECONNREFUSED`, `brainctl exec failed`, `manifest unknown`, etc.)
// into a small set of product-language categories before showing it to a
// non-admin user in the welcome card. The raw reason still goes to stderr +
// admin diagnostics; only the user-visible card text is folded.
//
// Match is by literal keyword on the lowercased reason. We deliberately do
// NOT import runtime modules — this keeps the i18n surface decoupled from
// runtime internals; if a backend renames or adds an error string, the worst
// outcome is falling through to the generic "unavailable" category rather
// than a build break.

import { t } from '../../i18n/index.js'

export function classifyStartupReason(raw: string): string {
  const r = raw.toLowerCase()
  if (/pull|image|registry|manifest|layer/.test(r)) {
    return t('channel.startup.reason.imagePulling')
  }
  if (/timeout|deadline|context deadline/.test(r)) {
    return t('channel.startup.reason.timeout')
  }
  if (/network|dns|econn|tls|handshake|socket/.test(r)) {
    return t('channel.startup.reason.network')
  }
  if (/permission|eacces|denied|forbidden/.test(r)) {
    return t('channel.startup.reason.permission')
  }
  if (/schedul|quota|capacity|unavailable/.test(r)) {
    return t('channel.startup.reason.scheduling')
  }
  return t('channel.startup.reason.generic')
}
