// Build a Feishu open URL for the given resource. Always uses feishu.cn
// (the global entry point); clicks redirect through accounts.feishu.cn
// to the user's actual tenant subdomain (e.g. aicarrier.feishu.cn). The
// extra SSO hop is fine for first-click and silent after the user is
// signed in, so we don't bother with per-tenant config. URL paths per
// Feishu open platform docs:
//   docx:   /docx/<documentId>
//   sheets: /sheets/<spreadsheetToken>[?sheet=<sheetId>]
//   wiki:   /wiki/<nodeToken>
//   base:   /base/<baseToken>
//   folder: /drive/folder/<folderToken>
//   file:   /file/<fileToken>   (drive uploads - PDFs / images / archives)
export function feishuShareUrl(
  kind: 'docx' | 'sheets' | 'wiki' | 'base' | 'folder' | 'file',
  token: string,
  opts: { sheetId?: string } = {},
): string {
  if (kind === 'folder') {
    return `https://feishu.cn/drive/folder/${token}`
  }
  const base = `https://feishu.cn/${kind}/${token}`
  if (kind === 'sheets' && opts.sheetId) {
    return `${base}?sheet=${opts.sheetId}`
  }
  return base
}
