import { handlePlanModeTransition } from '../bootstrap/state.js'
import type { Command } from '../commands.js'
import { getActiveProviderProfile } from '../providers/runtime.js'
import type { AppState } from '../state/AppStateStore.js'
import type { LocalJSXCommandCall, LocalJSXCommandModule } from '../types/command.js'
import { applyPermissionUpdate } from '../utils/permissions/PermissionUpdate.js'
import { prepareContextForPlanMode } from '../utils/permissions/permissionSetup.js'

export const LOCAL_ULTRAPLAN_DESCRIPTION = 'Explore and refine an implementation plan on this machine using the selected model'

/** Uses the normal local plan/agent loop; never creates a hosted task. */
export function buildLocalUltraplanPrompt(blurb: string, seedPlan?: string): string {
  return [
    'Perform thorough implementation planning in this local session using the currently selected model and the existing workspace.',
    'Stay in plan mode. Inspect the code and existing conventions before proposing changes. Do not implement changes or run mutating commands.',
    'For independent questions, use the available Explore and Plan subagents. Give each a bounded task, compare their evidence, and resolve disagreements before composing the plan. If those agents are unavailable, perform the same read-only investigation yourself.',
    'Document concrete files and call paths, implementation steps, alternatives and trade-offs, validation steps, and unresolved assumptions. Ground recommendations in the repository rather than guessing.',
    'Write the final plan using the ordinary plan-mode workflow and request user approval with ExitPlanMode. Remain in plan mode if the user requests refinement. Normal local cancellation and tool permissions apply.',
    ...(seedPlan ? ['\nRefine this existing draft plan:', seedPlan] : []),
    ...(blurb.trim() ? ['\nPlanning request:', blurb.trim()] : []),
  ].join('\n\n')
}

export function prepareLocalUltraplan(options: {
  blurb: string
  seedPlan?: string
  getAppState: () => AppState
  setAppState: (update: (state: AppState) => AppState) => void
  signal: AbortSignal
}): { message: string; prompt?: string } {
  if (options.signal.aborted) return { message: 'Local planning cancelled.' }
  if (!options.blurb.trim() && !options.seedPlan?.trim()) {
    return { message: 'Usage: /ultraplan <request>\n\nExplore and refine a plan in this local workspace with the selected provider. Uses the normal Plan/Explore agents, tool permissions, plan approval, and Escape cancellation. No cloud session is created.' }
  }
  const previousMode = options.getAppState().toolPermissionContext.mode
  if (previousMode !== 'plan') {
    // Keep the same entry effects and pre-plan permission restoration as /plan.
    handlePlanModeTransition(previousMode, 'plan')
    options.setAppState(previous => ({
      ...previous,
      toolPermissionContext: applyPermissionUpdate(prepareContextForPlanMode(previous.toolPermissionContext), { type: 'setMode', mode: 'plan', destination: 'session' }),
    }))
  }
  return {
    message: 'Planning on this machine with the selected model. Review the plan here; press Escape to interrupt.',
    prompt: buildLocalUltraplanPrompt(options.blurb, options.seedPlan),
  }
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const result = prepareLocalUltraplan({ blurb: args, getAppState: context.getAppState, setAppState: context.setAppState, signal: context.abortController.signal })
  onDone(result.message, { display: 'system', shouldQuery: Boolean(result.prompt), ...(result.prompt ? { metaMessages: [result.prompt] } : {}) })
  return null
}

/** Resolve on every invocation: the command registry is memoized across provider switches. */
export function createUltraplanCommand(cloudCommand: { description: string; load: () => Promise<LocalJSXCommandModule> } | null): Command {
  return {
    type: 'local-jsx',
    name: 'ultraplan',
    get description() { return getActiveProviderProfile() ? LOCAL_ULTRAPLAN_DESCRIPTION : cloudCommand?.description ?? LOCAL_ULTRAPLAN_DESCRIPTION },
    argumentHint: '<request>',
    isEnabled: () => Boolean(getActiveProviderProfile() || cloudCommand),
    load: () => getActiveProviderProfile() || !cloudCommand ? Promise.resolve({ call }) : cloudCommand.load(),
  }
}
