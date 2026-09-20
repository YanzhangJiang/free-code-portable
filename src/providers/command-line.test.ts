import { describe, expect, test } from 'bun:test'
import { Command } from 'commander'
import { parseProviderCommandLine } from './command-line.js'

describe('early provider command-line parsing', () => {
  test('uses the final occurrence, matching the full CLI parser', () => {
    const args = [
      '--provider', 'first', '--model=first/Model', '--providers-file=initial.json',
      '--provider=second', '--model', 'second/Model', '--providers-file', '/tmp/final profile.json',
    ]
    const program = new Command()
      .option('--provider <name>')
      .option('--model <name>')
      .option('--providers-file <path>')
    program.parse(args, { from: 'user' })
    expect(parseProviderCommandLine(args)).toEqual({
      provider: program.opts().provider,
      model: program.opts().model,
      configPath: program.opts().providersFile,
    })
    expect(parseProviderCommandLine(args)).toEqual({
      provider: 'second', model: 'second/Model', configPath: '/tmp/final profile.json',
    })
  })

  test('preserves order when equals and separate-value options are interleaved', () => {
    expect(parseProviderCommandLine([
      '--model=first/Model', '--model', 'second/Model', '--model=third/Model',
      '--provider=first', '--provider', 'legacy',
    ])).toEqual({ model: 'third/Model', provider: 'legacy' })
  })

  test('never interprets prompt arguments after the end-of-options separator', () => {
    expect(parseProviderCommandLine([
      '--provider', 'first', '--', '--provider=second', '--model', 'second/Model', '--providers-file=other.json',
    ])).toEqual({ provider: 'first' })
    expect(parseProviderCommandLine(['--', '--model'])).toEqual({})
  })

  test('rejects absent and empty option values before initializing any provider', () => {
    for (const flag of ['--provider', '--model', '--providers-file', '--services-file']) {
      for (const args of [[flag], [flag, ''], [`${flag}=`], [flag, '--'], [flag, '--model=next'], [flag, '-p']]) {
        expect(() => parseProviderCommandLine(args)).toThrow(`${flag} requires a value`)
      }
    }
  })

  test('leaves arguments unchanged and preserves case, spaces, slashes, and equals in values', () => {
    const args = Object.freeze(['-p', '--providers-file', '/tmp/Profile Folder/config.json', '--model=Owner/Model=Case', '--provider=My_Profile'])
    expect(parseProviderCommandLine(args)).toEqual({
      configPath: '/tmp/Profile Folder/config.json', model: 'Owner/Model=Case', provider: 'My_Profile',
    })
    expect(parseProviderCommandLine(['--unrelated=value', 'prompt'])).toEqual({})
  })

  test('selects the final external services file without reading prompt arguments', () => {
    expect(parseProviderCommandLine([
      '--services-file=one.json', '--services-file', '/tmp/services file.json', '--', '--services-file=prompt.json',
    ])).toEqual({ servicesPath: '/tmp/services file.json' })
  })
})
