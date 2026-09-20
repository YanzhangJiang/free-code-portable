declare module 'turndown' {
  class TurndownService {
    remove(tags: string | string[]): this
    turndown(html: string): string
  }
  export = TurndownService
}
