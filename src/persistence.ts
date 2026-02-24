import { debug, swallow } from './helpers.js'

export function createPersistenceScheduler<TState>(deps: {
  statePath: string
  state: TState
  saveState: (
    statePath: string,
    state: TState,
    options: { dirtyDateKeys: string[] },
  ) => Promise<void>
}) {
  const dirtyDateKeys = new Set<string>()
  let stateDirty = false

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saveInFlight = Promise.resolve()

  /**
   * Capture and delete specific dirty keys instead of clearing the whole set.
   * Keys added between capture and write completion are preserved.
   */
  const persist = () => {
    const dirty = Array.from(dirtyDateKeys)
    if (dirty.length === 0 && !stateDirty) return saveInFlight
    for (const key of dirty) dirtyDateKeys.delete(key)
    stateDirty = false

    const write = saveInFlight
      .catch(swallow('persistState:wait'))
      .then(() =>
        deps.saveState(deps.statePath, deps.state, { dirtyDateKeys: dirty }),
      )
      .catch((error) => {
        for (const key of dirty) dirtyDateKeys.add(key)
        stateDirty = true
        debug(`persistState failed: ${String(error)}`)
        throw error
      })

    saveInFlight = write
    return write
  }

  const scheduleSave = () => {
    stateDirty = true
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void persist().catch(swallow('persistState:save'))
    }, 200)
  }

  const flushSave = async () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
    if (dirtyDateKeys.size > 0 || stateDirty) {
      await persist()
      return
    }
    await saveInFlight
  }

  const markDirty = (dateKey: string | undefined) => {
    if (!dateKey) return
    dirtyDateKeys.add(dateKey)
  }

  return {
    markDirty,
    scheduleSave,
    flushSave,
    persist,
    getDirtyCount: () => dirtyDateKeys.size,
  }
}
