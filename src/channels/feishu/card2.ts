export type Card2HeaderTemplate =
  | 'blue'
  | 'green'
  | 'grey'
  | 'orange'
  | 'purple'
  | 'red'
  | 'turquoise'
  | 'wathet'
  | 'yellow'
  | (string & {})

export type Card2ButtonType = 'default' | 'primary' | 'danger'

export type Card2Element = Record<string, unknown>

export function card2(input: {
  template?: Card2HeaderTemplate
  title?: string
  subtitle?: string
  elements: Card2Element[]
  config?: Record<string, unknown>
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schema: '2.0',
    config: {
      update_multi: true,
      ...(input.config ?? {}),
    },
    body: {
      elements: input.elements,
    },
  }
  if (input.title || input.template || input.subtitle) {
    out.header = header({
      template: input.template ?? 'blue',
      title: input.title ?? '',
      subtitle: input.subtitle,
    })
  }
  return out
}

export function header(input: {
  template: Card2HeaderTemplate
  title: string
  subtitle?: string
}): Record<string, unknown> {
  return {
    template: input.template,
    title: { tag: 'plain_text', content: input.title },
    ...(input.subtitle
      ? { subtitle: { tag: 'plain_text', content: input.subtitle } }
      : {}),
  }
}

export function markdown(content: string): Card2Element {
  return { tag: 'markdown', content }
}

/** Small grey caption text (Feishu `note` block). Renders one size smaller and
 *  de-emphasised vs markdown — the canonical "secondary / supporting" element.
 *  Plain text only (no markdown parse), exactly what a status / teaser line
 *  wants. */
export function note(content: string): Card2Element {
  return { tag: 'note', elements: [{ tag: 'plain_text', content }] }
}

export function hr(): Card2Element {
  return { tag: 'hr' }
}

export function collapsible(input: {
  title: string
  elements: Card2Element[]
  expanded?: boolean
  icon?: Record<string, unknown>
}): Card2Element {
  return {
    tag: 'collapsible_panel',
    expanded: input.expanded ?? false,
    header: {
      title: { tag: 'markdown', content: input.title },
      ...(input.icon ? { icon: input.icon } : {}),
    },
    elements: input.elements,
  }
}

export function action(buttons: Card2Element[]): Card2Element {
  return {
    tag: 'column_set',
    columns: buttons.map(btn => ({
      tag: 'column',
      width: 'auto',
      elements: [btn],
    })),
  }
}

export function button(input: {
  text: string
  type: Card2ButtonType
  value: Record<string, unknown>
}): Card2Element {
  return {
    tag: 'button',
    type: input.type,
    text: { tag: 'plain_text', content: input.text },
    behaviors: [
      {
        type: 'callback',
        value: input.value,
      },
    ],
  }
}
