import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import {
  canUserConfigureAdvisor,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from '../utils/advisor.js'
import {
  getDefaultMainLoopModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { validateModel } from '../utils/model/validateModel.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { getActiveProviderProfile, resolveProviderModel } from '../providers/runtime.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'

const call: LocalCommandCall = async (args, context) => {
  const arg = args.trim()
  const baseModel = parseUserSpecifiedModel(
    context.getAppState().mainLoopModel ?? getDefaultMainLoopModelSetting(),
  )

  if (resolveProviderModel(baseModel)) {
    if (arg.toLowerCase() === 'unset' || arg.toLowerCase() === 'off') {
      context.setAppState(state => ({ ...state, advisorModel: undefined }))
      return { type: 'text', value: 'Local reviewer disabled for this session.' }
    }
    if (!arg) {
      const current = context.getAppState().advisorModel
      return { type: 'text', value: `Local reviewer: ${current ?? 'not set'}. Use /advisor <provider/model> to select a reviewer using the Agent tool, or /advisor off. Normal tool permissions apply.` }
    }
    if (!context.options.tools.some(tool => tool.name === AGENT_TOOL_NAME)) {
      return { type: 'text', value: 'Local review requires the Agent tool. Enable it before selecting /advisor.' }
    }
    let reviewer: string
    try {
      const configuredReviewer = resolveProviderModel(arg)
      if (!configuredReviewer) return { type: 'text', value: 'Select a configured provider/model.' }
      reviewer = configuredReviewer.qualifiedModel
    } catch (error) {
      return { type: 'text', value: error instanceof Error ? error.message : 'Select a configured provider/model.' }
    }
    const validation = await validateModel(reviewer, context.abortController.signal)
    if (context.abortController.signal.aborted) return { type: 'skip' }
    if (!validation.valid) return { type: 'text', value: validation.error ?? 'This reviewer model is unavailable.' }
    context.setAppState(state => ({ ...state, advisorModel: reviewer }))
    return { type: 'text', value: `Local reviewer set to ${reviewer} for this session. Reviews use the Agent tool and its normal permissions; each review uses this provider's model API.` }
  }

  if (!arg) {
    const current = context.getAppState().advisorModel
    if (!current) {
      return {
        type: 'text',
        value:
          'Advisor: not set\nUse "/advisor <model>" to enable (e.g. "/advisor opus").',
      }
    }
    if (!modelSupportsAdvisor(baseModel)) {
      return {
        type: 'text',
        value: `Advisor: ${current} (inactive)\nThe current model (${baseModel}) does not support advisors.`,
      }
    }
    return {
      type: 'text',
      value: `Advisor: ${current}\nUse "/advisor unset" to disable or "/advisor <model>" to change.`,
    }
  }

  if (arg === 'unset' || arg === 'off') {
    const prev = context.getAppState().advisorModel
    context.setAppState(s => {
      if (s.advisorModel === undefined) return s
      return { ...s, advisorModel: undefined }
    })
    updateSettingsForSource('userSettings', { advisorModel: undefined })
    return {
      type: 'text',
      value: prev
        ? `Advisor disabled (was ${prev}).`
        : 'Advisor already unset.',
    }
  }

  const normalizedModel = normalizeModelStringForAPI(arg)
  const resolvedModel = parseUserSpecifiedModel(arg)
  const { valid, error } = await validateModel(resolvedModel)
  if (!valid) {
    return {
      type: 'text',
      value: error
        ? `Invalid advisor model: ${error}`
        : `Unknown model: ${arg} (${resolvedModel})`,
    }
  }

  if (!isValidAdvisorModel(resolvedModel)) {
    return {
      type: 'text',
      value: `The model ${arg} (${resolvedModel}) cannot be used as an advisor`,
    }
  }

  context.setAppState(s => {
    if (s.advisorModel === normalizedModel) return s
    return { ...s, advisorModel: normalizedModel }
  })
  updateSettingsForSource('userSettings', { advisorModel: normalizedModel })

  if (!modelSupportsAdvisor(baseModel)) {
    return {
      type: 'text',
      value: `Advisor set to ${normalizedModel}.\nNote: Your current model (${baseModel}) does not support advisors. Switch to a supported model to use the advisor.`,
    }
  }

  return {
    type: 'text',
    value: `Advisor set to ${normalizedModel}.`,
  }
}

const advisor = {
  type: 'local',
  name: 'advisor',
  description: 'Configure the advisor model',
  argumentHint: '[<model>|off]',
  isEnabled: () => !!getActiveProviderProfile() || canUserConfigureAdvisor(),
  get isHidden() {
    return !getActiveProviderProfile() && !canUserConfigureAdvisor()
  },
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default advisor
