import type { Session } from '@opencode-ai/sdk'

import { mapConcurrent } from './helpers.js'

export type DescendantsOptions = {
  maxDepth: number
  maxSessions: number
  concurrency: number
}

export type DescendantsDeps = {
  listChildren: (sessionID: string) => Promise<Session[]>
  getParentID: (sessionID: string) => string | undefined
  onDiscover: (session: {
    id: string
    title: string
    createdAt: number
    parentID: string | undefined
  }) => void
  debug?: (message: string) => void
  now?: () => number
}

export function createDescendantsResolver(deps: DescendantsDeps) {
  const cache = new Map<string, { sessionIDs: string[]; expiresAt: number }>()
  const ttlMs = 5_000
  const now = deps.now || Date.now
  const debug = deps.debug || (() => {})

  const invalidateForAncestors = (sessionID: string | undefined) => {
    if (!sessionID) return
    const visited = new Set<string>()
    let current: string | undefined = sessionID
    for (let i = 0; i < 512 && current; i++) {
      if (visited.has(current)) return
      visited.add(current)
      cache.delete(current)
      current = deps.getParentID(current)
    }
  }

  const listDescendantSessionIDs = async (
    sessionID: string,
    opts: DescendantsOptions,
  ) => {
    if (opts.maxSessions <= 0) {
      cache.set(sessionID, { sessionIDs: [], expiresAt: now() + ttlMs })
      return [] as string[]
    }

    const cached = cache.get(sessionID)
    if (cached && cached.expiresAt > now()) {
      return cached.sessionIDs
    }

    const visited = new Set<string>([sessionID])
    const descendants: string[] = []
    let frontier = [sessionID]
    let depth = 0

    while (
      frontier.length > 0 &&
      depth < opts.maxDepth &&
      descendants.length < opts.maxSessions
    ) {
      const levels = await mapConcurrent(
        frontier,
        opts.concurrency,
        async (id) => {
          const children = await deps.listChildren(id).catch((error) => {
            debug(`listChildren failed for ${id}: ${String(error)}`)
            return [] as Session[]
          })
          return children
        },
      )

      const nextFrontier: string[] = []
      for (const children of levels) {
        for (const child of children) {
          if (visited.has(child.id)) continue
          visited.add(child.id)
          descendants.push(child.id)
          deps.onDiscover({
            id: child.id,
            title: child.title,
            createdAt: child.time.created,
            parentID: child.parentID,
          })
          nextFrontier.push(child.id)
          if (descendants.length >= opts.maxSessions) break
        }
        if (descendants.length >= opts.maxSessions) break
      }

      frontier = nextFrontier
      depth += 1
    }

    cache.set(sessionID, { sessionIDs: descendants, expiresAt: now() + ttlMs })

    const truncatedByDepth = depth >= opts.maxDepth && frontier.length > 0
    const truncatedByCount =
      descendants.length >= opts.maxSessions && frontier.length > 0
    if (truncatedByDepth || truncatedByCount) {
      debug(
        `descendants truncated for ${sessionID}: depth=${depth}/${opts.maxDepth}, sessions=${descendants.length}/${opts.maxSessions}`,
      )
    }

    return descendants
  }

  return {
    invalidateForAncestors,
    listDescendantSessionIDs,
  }
}
