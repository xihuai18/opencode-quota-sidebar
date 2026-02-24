import os from 'node:os'
import path from 'node:path'

import { isDateKey } from './storage_dates.js'

/**
 * Resolve the OpenCode data directory.
 *
 * OpenCode uses `xdg-basedir@5.1.0` which has NO platform-specific logic:
 *   xdgData = $XDG_DATA_HOME || $HOME/.local/share
 * This applies on all platforms including Windows and macOS.
 *
 * S4 fix: renamed env var from OPENCODE_TEST_HOME to OPENCODE_QUOTA_DATA_HOME.
 * OPENCODE_QUOTA_DATA_HOME overrides the full data directory path.
 */
export function resolveOpencodeDataDir() {
  const override = process.env.OPENCODE_QUOTA_DATA_HOME?.trim()
  if (override) return path.resolve(override)

  const xdg = process.env.XDG_DATA_HOME?.trim()
  if (xdg) return path.join(path.resolve(xdg), 'opencode')

  return path.join(os.homedir(), '.local', 'share', 'opencode')
}

export function stateFilePath(dataDir: string) {
  return path.join(dataDir, 'quota-sidebar.state.json')
}

export function authFilePath(dataDir: string) {
  return path.join(dataDir, 'auth.json')
}

export function chunkRootPathFromStateFile(statePath: string) {
  return path.join(path.dirname(statePath), 'quota-sidebar-sessions')
}

export function chunkFilePath(rootPath: string, dateKey: string) {
  // Defense-in-depth: ensure we never build paths from untrusted inputs.
  if (!isDateKey(dateKey)) {
    throw new Error(`invalid dateKey: ${dateKey}`)
  }
  const [year, month, day] = dateKey.split('-')
  return path.join(rootPath, year, month, `${day}.json`)
}
