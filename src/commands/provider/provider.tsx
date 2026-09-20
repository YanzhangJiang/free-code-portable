import * as React from 'react'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import { Text } from '../../ink.js'
import {
  getActiveProviderProfile,
  getProviderConfigPath,
  getProviderProfiles,
} from '../../providers/runtime.js'
import { useAppStateStore, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js'
import { selectSessionProvider } from './selection.js'

type Props = { onDone: LocalJSXCommandOnDone }

function useSelectProvider(onDone: LocalJSXCommandOnDone) {
  const setAppState = useSetAppState()
  const appStateStore = useAppStateStore()
  return React.useCallback((providerId: string): void => {
    const selection = selectSessionProvider(providerId === 'legacy' ? undefined : providerId, appStateStore.getState().tasks)
    setAppState(previous => ({
      ...previous,
      mainLoopModel: selection.model,
      mainLoopModelForSession: null,
      fastMode: false,
    }))
    onDone(`Set provider to ${selection.label}${selection.model ? ` · Model: ${selection.model}` : ''} (this session)`)
  }, [onDone, setAppState, appStateStore])
}

function ProviderPicker({ onDone }: Props): React.ReactNode {
  const selectProvider = useSelectProvider(onDone)
  const [error, setError] = React.useState<string>()
  const activeProvider = getActiveProviderProfile()
  const options = [
    ...getProviderProfiles().map(profile => ({
      value: profile.id,
      label: profile.name ? `${profile.name} (${profile.id})` : profile.id,
      description: `${profile.api} · ${profile.defaultModel}`,
    })),
    {
      value: 'legacy',
      label: 'Legacy environment configuration',
      description: 'Use the provider selected by environment variables and existing login',
    },
  ]
  const cancel = (): void => onDone('Provider unchanged', { display: 'system' })
  return (
    <Dialog title="Select provider" subtitle="Applies to this session. Use /model to select a model." onCancel={cancel}>
      {error && <Text color="error">{error}</Text>}
      <Select
        options={options}
        defaultValue={activeProvider?.id ?? 'legacy'}
        visibleOptionCount={Math.min(10, options.length)}
        onChange={providerId => {
          try {
            selectProvider(providerId)
          } catch (selectionError) {
            setError(selectionError instanceof Error ? selectionError.message : String(selectionError))
          }
        }}
        onCancel={cancel}
      />
    </Dialog>
  )
}

function SetProviderAndClose({ providerId, onDone }: Props & { providerId: string }): React.ReactNode {
  const selectProvider = useSelectProvider(onDone)
  React.useEffect(() => {
    try {
      selectProvider(providerId)
    } catch (error) {
      onDone(error instanceof Error ? error.message : String(error), { display: 'system' })
    }
  }, [providerId, onDone, selectProvider])
  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const argument = args?.trim() ?? ''
  try {
    if (COMMON_HELP_ARGS.includes(argument)) {
      onDone(`Run /provider to choose a provider, /provider <id> to switch, or /provider legacy to use your environment configuration. Changes apply to this session. Configure profiles in ${getProviderConfigPath()}.`, { display: 'system' })
      return
    }
    if (COMMON_INFO_ARGS.includes(argument)) {
      const activeProvider = getActiveProviderProfile()
      onDone(`Current provider: ${activeProvider?.name ?? activeProvider?.id ?? 'legacy environment configuration'}\nConfiguration: ${getProviderConfigPath()}`, { display: 'system' })
      return
    }
    if (argument) {
      return <SetProviderAndClose providerId={argument} onDone={onDone} />
    }
    if (getProviderProfiles().length === 0) {
      onDone(`No provider profiles configured. Add providers to ${getProviderConfigPath()}, then run /provider. Each profile defines its API protocol, base URL, credentials, and models.`, { display: 'system' })
      return
    }
    return <ProviderPicker onDone={onDone} />
  } catch (error) {
    onDone(error instanceof Error ? error.message : String(error), { display: 'system' })
    return
  }
}
