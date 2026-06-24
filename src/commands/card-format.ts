// Shared card-formatting helpers for slash output rendered as Feishu notice
// cards (lark_md body). Each command renders as an inline `code` chip (Feishu
// shows it as a grey rounded pill) followed by a plain-text description. We
// deliberately do NOT column-align: Feishu card text is a proportional font, so
// the only way to truly align is a monospace code block — but Feishu renders
// ``` blocks with line numbers (ugly) and a full-width table is too wide. The
// inline-chip list is the clean middle.

/**
 * Render `rows` as a two-line-per-entry list: the command as an inline `code`
 * chip on its own line, then the description on the next line, indented with a
 * full-width space (regular leading spaces collapse / 4+ become a code block in
 * lark_md; U+3000 survives). Entries are separated by a blank line. This avoids
 * column alignment entirely — Feishu's proportional font + variable chip widths
 * make a real `cmd … desc` column impossible, so we stack instead of align.
 * A row with an empty description renders just the chip. Commands must not
 * contain backticks.
 */
const INDENT = '　' // ideographic space — a reliable lark_md indent
export function commandList(rows: ReadonlyArray<readonly [string, string]>): string {
  return rows
    .map(([cmd, desc]) => (desc ? `\`${cmd}\`\n${INDENT}${desc}` : `\`${cmd}\``))
    .join('\n\n')
}
