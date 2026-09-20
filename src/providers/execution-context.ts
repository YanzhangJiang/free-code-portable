import { AsyncLocalStorage } from 'node:async_hooks'
import type { ResolvedProviderModel } from './runtime.js'

export type ProviderExecutionContext =
  | Readonly<{ kind: 'profile'; resolved: Readonly<ResolvedProviderModel> }>
  | Readonly<{ kind: 'legacy'; model: string | undefined }>

// Each owned query/request enters a scope at its I/O boundary. Async descendants
// inherit that immutable snapshot; changing the UI selection never changes it.
const executionContext = new AsyncLocalStorage<ProviderExecutionContext>()

export function getProviderExecutionContext(): ProviderExecutionContext | undefined {
  return executionContext.getStore()
}

export function runWithProviderExecutionContext<T>(
  context: ProviderExecutionContext,
  operation: () => T,
): T {
  return executionContext.run(context, operation)
}

/**
 * Owns the delegated generator, forwarding completion, throw, and cancellation.
 * Scope each iterator operation: creating an async generator inside run() alone
 * does not scope its body, because that body executes when next() is requested.
 * No work starts until the caller advances it; return()/asyncDispose closes it.
 */
export function bindProviderExecutionContext<T, TReturn, TNext>(
  context: ProviderExecutionContext,
  createGenerator: () => AsyncGenerator<T, TReturn, TNext>,
): AsyncGenerator<T, TReturn, TNext> {
  const generator = runWithProviderExecutionContext(context, createGenerator)
  const scoped: AsyncGenerator<T, TReturn, TNext> = {
    next: (...args: [] | [TNext]) =>
      runWithProviderExecutionContext(context, () => generator.next(...args)),
    return: value =>
      runWithProviderExecutionContext(context, () => generator.return(value)),
    throw: error =>
      runWithProviderExecutionContext(context, () => generator.throw(error)),
    [Symbol.asyncIterator]: () => scoped,
    async [Symbol.asyncDispose]() {
      await scoped.return(undefined as TReturn)
    },
  }
  return scoped
}
