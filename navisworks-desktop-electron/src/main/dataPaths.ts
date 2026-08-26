import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const DATA_DIRECTORY_ARGUMENT = '--data-dir'
export const DATA_DIRECTORY_ENVIRONMENT_VARIABLE = 'NAVISWORKS_MCP_DESKTOP_DATA_DIR'

export type DesktopBuildConfiguration = 'Debug' | 'Production'

export interface DesktopDataPaths {
  rootDirectory: string
  sessionsFile: string
  sessionsBackupFile: string
  settingsFile: string
  startupLogFile: string
  buildConfiguration: DesktopBuildConfiguration
  sourceDescription: string
}

export interface ResolveDataPathsOptions {
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  isPackaged?: boolean
  localAppData?: string
}

export class DataPathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DataPathError'
  }
}

/**
 * Mirrors the WPF AppDataPathProvider override precedence while keeping an
 * Electron-specific default profile. Dev/test launches must never silently
 * consume the WPF Debug sessions that previously surfaced as stale UI data.
 */
export function resolveDesktopDataPaths(
  options: ResolveDataPathsOptions = {},
): DesktopDataPaths {
  const argv = options.argv ?? process.argv.slice(1)
  const env = options.env ?? process.env
  const buildConfiguration: DesktopBuildConfiguration = options.isPackaged
    ? 'Production'
    : 'Debug'

  const commandLineDirectory = readCommandLineDirectory(argv)
  if (commandLineDirectory !== undefined) {
    return buildPaths(
      normalizeDirectory(commandLineDirectory, env),
      buildConfiguration,
      `命令行 ${DATA_DIRECTORY_ARGUMENT}`,
    )
  }

  const environmentDirectory = env[DATA_DIRECTORY_ENVIRONMENT_VARIABLE]
  if (environmentDirectory?.trim()) {
    return buildPaths(
      normalizeDirectory(environmentDirectory, env),
      buildConfiguration,
      `环境变量 ${DATA_DIRECTORY_ENVIRONMENT_VARIABLE}`,
    )
  }

  const localAppData = options.localAppData?.trim()
    ? options.localAppData
    : env.LOCALAPPDATA?.trim()
      ? env.LOCALAPPDATA
      : path.join(homedir(), 'AppData', 'Local')
  const applicationDirectory = buildConfiguration === 'Debug'
    ? 'NavisworksMcpDesktop.Electron.Debug'
    : 'NavisworksMcpDesktop.Electron'

  return buildPaths(
    normalizeDirectory(path.join(localAppData, applicationDirectory), env),
    buildConfiguration,
    '构建配置默认值',
  )
}

/** Short composition-root alias. */
export const createDataPaths = resolveDesktopDataPaths

function readCommandLineDirectory(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) {
      continue
    }

    if (argument.localeCompare(DATA_DIRECTORY_ARGUMENT, undefined, {
      sensitivity: 'accent',
    }) === 0) {
      const value = argv[index + 1]
      if (!value?.trim()) {
        throw new DataPathError(`${DATA_DIRECTORY_ARGUMENT} 后必须提供目录路径。`)
      }
      return value
    }

    const prefix = `${DATA_DIRECTORY_ARGUMENT}=`
    if (argument.slice(0, prefix.length).toLocaleLowerCase() === prefix) {
      const value = argument.slice(prefix.length)
      if (!value.trim()) {
        throw new DataPathError(`${DATA_DIRECTORY_ARGUMENT} 后必须提供目录路径。`)
      }
      return value
    }
  }

  return undefined
}

function normalizeDirectory(directory: string, env: NodeJS.ProcessEnv): string {
  const trimmed = directory.trim()
  if (!trimmed) {
    throw new DataPathError('应用数据目录不能为空。')
  }

  const expanded = expandWindowsEnvironmentVariables(trimmed, env)
  const fullPath = path.resolve(expanded)

  try {
    if (existsSync(fullPath) && !statSync(fullPath).isDirectory()) {
      throw new DataPathError(`应用数据目录指向了文件：${fullPath}`)
    }
  } catch (error) {
    if (error instanceof DataPathError) {
      throw error
    }
    throw new DataPathError(`无法检查应用数据目录：${fullPath}`, {
      cause: error,
    })
  }

  const normalized = path.normalize(fullPath)
  return normalized === path.parse(normalized).root
    ? normalized
    : normalized.replace(/[\\/]+$/, '')
}

function expandWindowsEnvironmentVariables(
  value: string,
  env: NodeJS.ProcessEnv,
): string {
  const values = new Map(
    Object.entries(env).map(([key, entry]) => [key.toUpperCase(), entry]),
  )

  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const replacement = values.get(name.toUpperCase())
    return replacement === undefined ? match : replacement
  })
}

function buildPaths(
  rootDirectory: string,
  buildConfiguration: DesktopBuildConfiguration,
  sourceDescription: string,
): DesktopDataPaths {
  return {
    rootDirectory,
    sessionsFile: path.join(rootDirectory, 'sessions.json'),
    sessionsBackupFile: path.join(rootDirectory, 'sessions.backup.json'),
    settingsFile: path.join(rootDirectory, 'settings.json'),
    startupLogFile: path.join(rootDirectory, 'startup.log'),
    buildConfiguration,
    sourceDescription,
  }
}
