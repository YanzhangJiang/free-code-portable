/** Preserve the existing permission boundary: only the same host or its www alias. */
export function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const original = new URL(originalUrl)
    const redirected = new URL(redirectUrl)
    if (redirected.protocol !== original.protocol || redirected.port !== original.port ||
      redirected.username || redirected.password) return false
    const stripWww = (hostname: string) => hostname.replace(/^www\./, '')
    return stripWww(original.hostname) === stripWww(redirected.hostname)
  } catch {
    return false
  }
}
