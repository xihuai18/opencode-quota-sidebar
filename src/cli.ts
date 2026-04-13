#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { createOpencodeClient } from '@opencode-ai/sdk/client'

import {
  cliCurrentLabel,
  renderCliDashboard,
  renderCliHistoryDashboard,
} from './cli_render.js'
import { createQuotaRuntime } from './quota.js'
import { createQuotaService } from './quota_service.js'
import { sinceFromLast, type HistoryPeriod } from './period.js'
import {
  authFilePath,
  loadConfig,
  loadState,
  // reused for CLI-local config layering
  quotaConfigPaths,
  resolveOpencodeDataDir,
  stateFilePath,
} from './storage.js'
import {
  filterHistoryProvidersForDisplay,
  filterUsageProvidersForDisplay,
  listCurrentProviderIDs,
} from './provider_catalog.js'
import { createUsageService } from './usage_service.js'

type CliCommand = {
  period: HistoryPeriod
  since?: string
  last?: number
}

const DEFAULT_OPENCODE_BASE_URL = 'http://localhost:4096'
const CLI_SERVER_TIMEOUT_MS = 10_000

type CliServerCommand = {
  command: string
  args: string[]
  shell?: boolean
}

type SpawnedCliServerProcess = ReturnType<typeof spawn>
type CliServerListener = (chunk: Buffer | string) => void
type CliServerErrorListener = (error: Error) => void
type CliServerExitListener = (code: number | null) => void

const HELP_TEXT = `opencode-quota

Usage:
  opencode-quota day
  opencode-quota day 7
  opencode-quota day --since 2026-04-01
  opencode-quota week
  opencode-quota week 8
  opencode-quota week --since 2026-04-01
  opencode-quota month
  opencode-quota month 6
  opencode-quota month --since 2026-01

Notes:
  day with no extra args means the current natural day
  week with no extra args means the current natural week starting Monday
  month with no extra args means the current natural month
  positional integers map to last=<N>
  --since accepts YYYY-MM-DD for day/week and YYYY-MM for month
`

function isPositiveInteger(value: string) {
  return /^\d+$/.test(value) && Number(value) > 0
}

function validSinceForPeriod(period: HistoryPeriod, value: string) {
  if (period === 'month') return /^\d{4}-\d{2}$/.test(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export function parseCliArgs(argv: string[]): CliCommand {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    throw new Error(HELP_TEXT)
  }

  const [periodArg, ...rest] = argv
  if (periodArg !== 'day' && periodArg !== 'week' && periodArg !== 'month') {
    throw new Error(`Unknown period: ${periodArg}\n\n${HELP_TEXT}`)
  }

  let since: string | undefined
  let last: number | undefined
  const positional: string[] = []

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (arg === '--since') {
      const value = rest[index + 1]
      if (!value) {
        throw new Error('Missing value for --since')
      }
      since = value.trim()
      index += 1
      continue
    }
    if (arg === '--last') {
      const value = rest[index + 1]
      if (!value || !isPositiveInteger(value)) {
        throw new Error('--last must be a positive integer')
      }
      last = Number(value)
      index += 1
      continue
    }
    positional.push(arg)
  }

  if (positional.length > 1) {
    throw new Error(`Too many positional arguments\n\n${HELP_TEXT}`)
  }

  if (positional.length === 1) {
    const value = positional[0].trim()
    if (isPositiveInteger(value)) {
      last = Number(value)
    } else if (validSinceForPeriod(periodArg, value)) {
      since = value
    } else {
      throw new Error(
        periodArg === 'month'
          ? 'Expected a positive integer or YYYY-MM'
          : 'Expected a positive integer or YYYY-MM-DD',
      )
    }
  }

  if (since && last !== undefined) {
    throw new Error('Cannot use both since and last')
  }

  if (since && !validSinceForPeriod(periodArg, since)) {
    throw new Error(
      periodArg === 'month'
        ? '--since must use YYYY-MM for month'
        : '--since must use YYYY-MM-DD for day/week',
    )
  }

  return {
    period: periodArg,
    ...(since ? { since } : {}),
    ...(last !== undefined ? { last } : {}),
  }
}

export function cliBaseUrl() {
  const override = process.env.OPENCODE_BASE_URL?.trim()
  return override || DEFAULT_OPENCODE_BASE_URL
}

function isDefaultBaseUrl() {
  return !process.env.OPENCODE_BASE_URL?.trim()
}

export function cliServerCommandCandidates(
  platform = process.platform,
): CliServerCommand[] {
  const directArgs = ['serve', '--hostname=127.0.0.1', '--port=4096']
  if (platform === 'win32') {
    return [
      { command: 'opencode.cmd', args: directArgs },
      {
        command: 'opencode serve --hostname=127.0.0.1 --port=4096',
        args: [],
        shell: true,
      },
      {
        command: 'bash',
        args: ['-lc', 'opencode serve --hostname=127.0.0.1 --port=4096'],
      },
    ]
  }
  return [{ command: 'opencode', args: directArgs }]
}

function releaseCliServerPipes(
  proc: SpawnedCliServerProcess,
  inspect?: CliServerListener,
  onError?: CliServerErrorListener,
  onExit?: CliServerExitListener,
) {
  if (inspect) {
    proc.stdout?.removeListener('data', inspect)
    proc.stderr?.removeListener('data', inspect)
  }
  if (onError) proc.removeListener('error', onError)
  if (onExit) proc.removeListener('exit', onExit)
  proc.stdout?.unpipe()
  proc.stderr?.unpipe()
  proc.stdout?.destroy()
  proc.stderr?.destroy()
}

export function closeCliServerProcess(
  proc: SpawnedCliServerProcess,
  platform = process.platform,
  killProcess: typeof process.kill = process.kill,
  spawnProcess: typeof spawn = spawn,
) {
  const pid = proc.pid
  if (typeof pid !== 'number' || pid <= 0) return

  if (platform === 'win32') {
    const killer = spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.unref()
    return
  }

  try {
    killProcess(-pid, 'SIGTERM')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ESRCH') throw error
  }
}

export async function tryStartCliOpencodeServer(
  candidate: CliServerCommand,
  spawnProcess: typeof spawn = spawn,
  closeProcess: typeof closeCliServerProcess = closeCliServerProcess,
) {
  let proc: SpawnedCliServerProcess
  try {
    proc = spawnProcess(candidate.command, candidate.args, {
      env: process.env,
      shell: candidate.shell ?? false,
      detached: true,
      windowsHide: true,
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw {
      error,
      output: '',
      recoverable: code === 'ENOENT' || code === 'EINVAL',
    }
  }

  const url = await new Promise<string>((resolve, reject) => {
    let inspect: CliServerListener | undefined
    let onError: CliServerErrorListener | undefined
    let onExit: CliServerExitListener | undefined
    const id = setTimeout(() => {
      if (settled) return
      settled = true
      releaseCliServerPipes(proc, inspect, onError, onExit)
      closeProcess(proc)
      reject(
        new Error(
          `Timeout waiting for OpenCode server to start after ${CLI_SERVER_TIMEOUT_MS}ms`,
        ),
      )
    }, CLI_SERVER_TIMEOUT_MS)
    let output = ''
    let settled = false

    inspect = (chunk: Buffer | string) => {
      output += chunk.toString()
      const lines = output.split('\n')
      for (const line of lines) {
        if (!line.startsWith('opencode server listening')) continue
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
        if (!match) continue
        clearTimeout(id)
        settled = true
        releaseCliServerPipes(proc, inspect, onError, onExit)
        // The CLI only needs the startup line; after that the detached server
        // must not keep the parent process alive.
        proc.unref()
        resolve(match[1])
        return
      }
    }

    proc.stdout?.on('data', inspect)
    proc.stderr?.on('data', inspect)
    onError = (error) => {
      if (settled) return
      settled = true
      clearTimeout(id)
      releaseCliServerPipes(proc, inspect, onError, onExit)
      const code = (error as NodeJS.ErrnoException).code
      reject({
        error,
        output,
        recoverable: code === 'ENOENT' || code === 'EINVAL',
      })
    }
    onExit = (code) => {
      if (settled) return
      settled = true
      clearTimeout(id)
      releaseCliServerPipes(proc, inspect, onError, onExit)
      let message = `OpenCode server exited with code ${code}`
      if (output.trim()) message += `\n${output}`
      const recoverable =
        /not recognized as an internal or external command/i.test(output) ||
        /command not found/i.test(output)
      reject({ error: new Error(message), output, recoverable })
    }
    proc.on('error', onError)
    proc.on('exit', onExit)
  })

  return {
    url,
    close: () => closeProcess(proc),
  }
}

async function startCliOpencodeServer() {
  const candidates = cliServerCommandCandidates()
  let lastError: unknown

  for (const candidate of candidates) {
    try {
      return await tryStartCliOpencodeServer(candidate)
    } catch (failure) {
      lastError = failure
      const recoverable =
        typeof failure === 'object' &&
        failure !== null &&
        'recoverable' in failure &&
        (failure as { recoverable?: unknown }).recoverable === true
      if (!recoverable) {
        const error =
          typeof failure === 'object' && failure !== null && 'error' in failure
            ? (failure as { error?: unknown }).error
            : failure
        throw error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  const error =
    typeof lastError === 'object' && lastError !== null && 'error' in lastError
      ? (lastError as { error?: unknown }).error
      : lastError
  throw error instanceof Error
    ? error
    : new Error('Failed to start OpenCode server')
}

async function resolvePathInfo(directory: string) {
  const connect = async (baseUrl: string) => {
    const client = createOpencodeClient({ directory, baseUrl })
    const response = await client.path.get({
      query: { directory },
      throwOnError: true,
    })
    const data = response.data as { worktree?: string; directory?: string }
    return {
      client,
      worktree: data.worktree || directory,
      directory: data.directory || directory,
      close: () => {},
    }
  }

  try {
    return await connect(cliBaseUrl())
  } catch (error) {
    if (!isDefaultBaseUrl()) {
      throw new Error(
        `Failed to connect to OpenCode API at ${cliBaseUrl()}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const server = await startCliOpencodeServer()
    const client = createOpencodeClient({
      directory,
      baseUrl: server.url,
    })
    const response = await client.path.get({
      query: { directory },
      throwOnError: true,
    })
    const data = response.data as { worktree?: string; directory?: string }
    return {
      client,
      worktree: data.worktree || directory,
      directory: data.directory || directory,
      close: () => server.close(),
    }
  }
}

export async function runCli(argv: string[]) {
  const command = parseCliArgs(argv)
  const cwd = process.cwd()
  const connection = await resolvePathInfo(cwd)
  try {
    const { client, worktree, directory } = connection
    const config = await loadConfig(quotaConfigPaths(worktree, directory))
    const dataDir = resolveOpencodeDataDir()
    const statePath = stateFilePath(dataDir)
    const authPath = authFilePath(dataDir)
    const state = await loadState(statePath)

    const quotaService = createQuotaService({
      quotaRuntime: createQuotaRuntime(),
      config,
      state,
      authPath,
      client: client as never,
      directory,
      scheduleSave: () => {},
    })

    const usageService = createUsageService({
      state,
      config,
      statePath,
      client: client as never,
      directory,
      persistence: {
        markDirty: () => {},
        scheduleSave: () => {},
        flushSave: async () => {},
      },
      descendantsResolver: {
        listDescendantSessionIDs: async () => [],
      },
    })

    const quotas = await quotaService.getQuotaSnapshots([], {
      allowDefault: true,
    })
    const allowedProviderIDs = await listCurrentProviderIDs({
      client,
      directory,
    }).catch(() => new Set<string>())

    if (command.since || command.last !== undefined) {
      const resolvedSince =
        command.since || sinceFromLast(command.period, command.last!)
      const historyRaw = await usageService.summarizeHistoryUsage(
        command.period,
        resolvedSince,
      )
      const history = filterHistoryProvidersForDisplay(
        historyRaw,
        allowedProviderIDs,
      )
      return renderCliHistoryDashboard({
        result: history,
        quotas,
        width: 80,
        showCost: config.sidebar.showCost,
      })
    }

    const usageRaw = await usageService.summarizeForTool(
      command.period,
      '',
      false,
    )
    const usage = filterUsageProvidersForDisplay(usageRaw, allowedProviderIDs)
    return renderCliDashboard({
      label: cliCurrentLabel(command.period),
      usage,
      quotas,
      width: 80,
      showCost: config.sidebar.showCost,
    })
  } finally {
    connection.close()
  }
}

export function cliExitCodeForError(message: string) {
  return message === HELP_TEXT ? 0 : 1
}

function resolveCliPath(filePath: string) {
  try {
    return realpathSync.native(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

export function cliShouldRunMain(
  argv1 = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
  resolvePath: (filePath: string) => string = resolveCliPath,
) {
  if (!argv1) return false
  return resolvePath(modulePath) === resolvePath(argv1)
}

async function main() {
  try {
    const output = await runCli(process.argv.slice(2))
    process.stdout.write(`${output}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const exitCode = cliExitCodeForError(message)
    const stream = exitCode === 0 ? process.stdout : process.stderr
    stream.write(`${message}\n`)
    process.exitCode = exitCode
  }
}

if (cliShouldRunMain()) {
  void main()
}
