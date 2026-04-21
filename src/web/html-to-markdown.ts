import TurndownService from 'turndown'

const service = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

service.remove(['script', 'style', 'noscript', 'nav', 'footer', 'aside'])

export function htmlToMarkdown(html: string): string {
  return service.turndown(html).trim()
}
