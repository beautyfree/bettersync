/**
 * Find and load the user's sync config file.
 *
 * Searches common paths (sync.ts, lib/sync.ts, src/lib/sync.ts, ...),
 * loads via c12 (which uses jiti for TypeScript transpilation), resolves
 * tsconfig path aliases.
 *
 * Inspired by better-auth's get-config.ts.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadConfig } from 'c12'
import { getTsconfig } from 'get-tsconfig'

// Search paths for the sync config file, ordered by likelihood
const BASE_PATHS = [
  'sync.ts',
  'sync.js',
  'lib/sync.ts',
  'lib/sync.js',
  'utils/sync.ts',
  'server/sync.ts',
]

const SEARCH_PATHS = [
  ...BASE_PATHS,
  ...BASE_PATHS.map((p) => `src/${p}`),
  ...BASE_PATHS.map((p) => `app/${p}`),
]

function getPathAliases(cwd: string): Record<string, string> {
  const configName = existsSync(path.join(cwd, 'tsconfig.json'))
    ? 'tsconfig.json'
    : 'jsconfig.json'

  const tsconfig = getTsconfig(cwd, configName)
  if (!tsconfig) return {}

  const { paths = {}, baseUrl } = tsconfig.config.compilerOptions ?? {}
  const configDir = path.dirname(tsconfig.path)
  const resolvedBaseUrl = baseUrl ? path.resolve(configDir, baseUrl) : configDir
  const result: Record<string, string> = {}

  for (const [alias, aliasPaths = []] of Object.entries(paths)) {
    for (const aliasedPath of aliasPaths) {
      const finalAlias = alias.endsWith('*') ? alias.slice(0, -1) : alias
      const finalPath = aliasedPath.endsWith('*') ? aliasedPath.slice(0, -1) : aliasedPath
      result[finalAlias || ''] = path.join(resolvedBaseUrl, finalPath)
    }
  }
  return result
}

export interface SyncConfig {
  schema: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Find and load the user's sync config.
 *
 * Returns the config object (with `schema`, `models`, `options`, etc.)
 * or null if no config file is found.
 */
export async function getConfig(opts: {
  cwd: string
  configPath?: string
}): Promise<SyncConfig | null> {
  const { cwd, configPath } = opts
  const alias = getPathAliases(cwd)

  // If explicit path provided, load it directly
  if (configPath) {
    const resolvedPath = path.isAbsolute(configPath)
      ? configPath
      : path.join(cwd, configPath)

    if (!existsSync(resolvedPath)) {
      return null
    }

    return loadConfigFile(resolvedPath, cwd, alias)
  }

  // Search common paths
  for (const searchPath of SEARCH_PATHS) {
    const fullPath = path.join(cwd, searchPath)
    if (existsSync(fullPath)) {
      const config = await loadConfigFile(searchPath, cwd, alias)
      if (config) return config
    }
  }

  return null
}

async function loadConfigFile(
  configFile: string,
  cwd: string,
  alias: Record<string, string>,
): Promise<SyncConfig | null> {
  try {
    const { config } = await loadConfig<Record<string, unknown>>({
      configFile,
      dotenv: { fileName: ['.env', '.env.local'] },
      jitiOptions: {
        extensions: ['.ts', '.tsx', '.js', '.jsx'],
        alias,
      },
      cwd,
    })

    if (!config || Object.keys(config).length === 0) return null

    // The config file exports `sync` (from betterSync()) which has `.schema` and `.options`
    // Or it might export the schema directly
    const syncObj = (config as Record<string, unknown>).sync ??
      (config as Record<string, unknown>).default ??
      config

    // Extract schema from the sync server instance or raw config
    if (syncObj && typeof syncObj === 'object' && 'schema' in syncObj) {
      return syncObj as SyncConfig
    }

    // Maybe it's a raw schema export
    if (syncObj && typeof syncObj === 'object' && 'models' in syncObj) {
      return { schema: (syncObj as Record<string, unknown>).models as Record<string, unknown>, ...syncObj as Record<string, unknown> }
    }

    return null
  } catch (err) {
    // Config file exists but couldn't be loaded
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('server-only') || message.includes('Client Component')) {
      console.error(
        `Remove 'server-only' import from your sync config temporarily. ` +
        `The CLI cannot resolve it. Re-add after running the CLI.`,
      )
      return null
    }
    throw err
  }
}
