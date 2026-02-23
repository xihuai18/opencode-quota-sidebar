import os from 'node:os'
import path from 'node:path'

/**
 * Resolve the OpenCode data directory.
 *
 * OpenCode uses `xdg-basedir@5.1.0` which has NO platform-specific logic:
 *   xdgData = $XDG_DATA_HOME || $HOME/.local/share
 * This applies on all platforms including Windows and macOS.
 *
 * S4 fix: renamed env var from OPENCODE_TEST_HOME to OPENCODE_QUOTA_DATA_HOME.
 */
export function resolveOpencodeDataDir() {
  const home = process.env.OPENCODE_QUOTA_DATA_HOME || os.homedir()
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return path.join(xdg, 'opencode')
  return path.join(home, '.local', 'share', 'opencode')
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
  const [year, month, day] = dateKey.split('-')
  return path.join(rootPath, year, month, `${day}.json`)
}
