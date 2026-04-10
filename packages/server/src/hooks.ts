/**
 * Hook runner with hard time budget.
 *
 * `afterWriteInTransaction` is dangerous — it runs inside the sync
 * transaction, so slow hooks hold row locks and block other writes. This
 * wrapper enforces a 100ms default budget and converts timeouts into a
 * typed `HookTimeoutError` that rolls back the transaction.
 */

import { HookTimeoutError } from '@bettersync/core'

/** Default budget for `afterWriteInTransaction` hooks, in milliseconds. */
export const DEFAULT_HOOK_BUDGET_MS = 100

/**
 * Run `hook()` under a strict time budget. If it exceeds `budgetMs`, throws
 * `HookTimeoutError`. If the hook throws for any other reason, the original
 * error is re-thrown.
 */
export async function runHookWithTimeout<T>(
  hookName: string,
  hook: () => Promise<T>,
  budgetMs: number = DEFAULT_HOOK_BUDGET_MS,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new HookTimeoutError(hookName, budgetMs))
    }, budgetMs)
  })
  try {
    return await Promise.race([hook(), timeoutPromise])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}
