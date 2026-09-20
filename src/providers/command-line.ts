export type ProviderCommandLineOptions = {
  configPath?: string
  servicesPath?: string
  provider?: string
  model?: string
}

/**
 * Read provider startup options before loading auth or settings modules.
 * Match Commander's last-option-wins order across both argument forms; arguments
 * following `--` are prompt text and must never select credentials or an endpoint.
 */
export function parseProviderCommandLine(args: readonly string[]): ProviderCommandLineOptions {
  const options: ProviderCommandLineOptions = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '--') break
    const separator = argument.indexOf('=')
    const flag = separator === -1 ? argument : argument.slice(0, separator)
    let key: keyof ProviderCommandLineOptions
    switch (flag) {
      case '--providers-file': key = 'configPath'; break
      case '--services-file': key = 'servicesPath'; break
      case '--provider': key = 'provider'; break
      case '--model': key = 'model'; break
      default: continue
    }
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1)
    if (!value || (separator === -1 && value.startsWith('-'))) {
      throw new Error(`${flag} requires a value`)
    }
    options[key] = value
  }
  return options
}
