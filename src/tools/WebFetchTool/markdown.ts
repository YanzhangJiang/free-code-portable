// Construct lazily: Turndown's DOM implementation is large and only needed for HTML.
type TurndownCtor = typeof import('turndown')
let service: Promise<InstanceType<TurndownCtor>> | undefined

export async function htmlToMarkdown(html: string): Promise<string> {
  service ??= import('turndown').then(module => {
    const Turndown = (module as unknown as { default: TurndownCtor }).default
    return new Turndown().remove(['script', 'style', 'noscript'])
  })
  return (await service).turndown(html)
}
