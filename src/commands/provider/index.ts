import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'provider',
  description: 'Choose a model provider for this session',
  argumentHint: '[provider|legacy]',
  load: () => import('./provider.js'),
} satisfies Command
