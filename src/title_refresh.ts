export function createTitleRefreshScheduler(options: {
  apply: (sessionID: string) => Promise<void>
  onError?: (error: unknown) => void
}) {
  const refreshTimer = new Map<string, ReturnType<typeof setTimeout>>()
  const applyLocks = new Map<string, Promise<void>>()
  const onError = options.onError || (() => {})

  const applyLocked = async (sessionID: string) => {
    const previous = applyLocks.get(sessionID) ?? Promise.resolve()
    const promise = previous
      .then(() => options.apply(sessionID))
      .catch(onError)
      .finally(() => {
        if (applyLocks.get(sessionID) === promise) {
          applyLocks.delete(sessionID)
        }
      })
    applyLocks.set(sessionID, promise)
    await promise
  }

  const schedule = (sessionID: string, delay = 250) => {
    const previous = refreshTimer.get(sessionID)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      refreshTimer.delete(sessionID)
      void applyLocked(sessionID)
    }, delay)
    refreshTimer.set(sessionID, timer)
  }

  const cancel = (sessionID: string) => {
    const timer = refreshTimer.get(sessionID)
    if (timer) clearTimeout(timer)
    refreshTimer.delete(sessionID)
  }

  const cancelAll = () => {
    for (const timer of refreshTimer.values()) clearTimeout(timer)
    refreshTimer.clear()
  }

  const flushScheduled = async () => {
    const pending = Array.from(refreshTimer.keys())
    cancelAll()
    await Promise.allSettled(pending.map((sessionID) => applyLocked(sessionID)))
  }

  const waitForIdle = async () => {
    const inflight = Array.from(applyLocks.values())
    if (inflight.length === 0) return
    await Promise.allSettled(inflight)
  }

  const dispose = () => {
    cancelAll()
    applyLocks.clear()
  }

  return {
    schedule,
    apply: applyLocked,
    cancel,
    cancelAll,
    flushScheduled,
    waitForIdle,
    dispose,
  }
}
