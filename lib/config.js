/**
 * Plugin configuration.
 *
 * The schema is hand-rolled rather than declared with `@deepseek-ai/schemastery`
 * on purpose: this package is installed into a host that already owns the
 * harness runtime, and `@deepseek-ai/*` packages are not on the public npm
 * registry. Depending on one would make `npm install` fail — or leave the module
 * missing — for anyone who installs from a plain clone, so the plugin has no
 * runtime dependencies at all.
 *
 * Applied values follow the harness schemas' rule: an explicit `null` or
 * `undefined` takes the default, while `false` and `0` are kept.
 *
 * @module dsh-plugin-session-workspaces/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MAX_NAME_BYTES } from './naming.js'

/** Default registry document name inside the harness home. */
export const DEFAULT_FILE_NAME = 'session-workspaces.json'

/**
 * Where the runtime-context entry sits relative to the harness's own contexts.
 *
 * The sandbox policy context is rendered at order 110 and names the workspace
 * the model may write in; this section explains where those writes actually go,
 * so it belongs immediately after it.
 */
export const DEFAULT_CONTEXT_ORDER = 111

/** The accepted configuration, as data the validator reads. */
export const CONFIG_FIELDS = Object.freeze({
  enabled: { kind: 'boolean', default: true, description: 'Mount the session-folder redirect and its runtime context.' },
  file: { kind: 'string', description: 'Assignment registry; a relative path resolves against the profile directory.' },
  maxNameBytes: { kind: 'number', default: DEFAULT_MAX_NAME_BYTES, description: 'UTF-8 byte budget for one folder name.' },
  readFallback: {
    kind: 'boolean',
    default: true,
    description: 'Let a read of a path absent from the session folder fall back to the workspace root.',
  },
  shellWorkdir: {
    kind: 'boolean',
    default: true,
    description: 'Run a shell command whose resolved working directory is the workspace root inside the session folder.',
  },
  prompt: {
    kind: 'boolean',
    default: true,
    description: 'Tell the model in the runtime context where this session writes.',
  },
  promptOrder: {
    kind: 'number',
    default: DEFAULT_CONTEXT_ORDER,
    description: 'Sort position of the contributed runtime-context entry.',
  },
})

/** Keys the harness itself may add to an entry; they are not ours to validate. */
const HARNESS_KEYS = new Set(['id', 'name', 'disabled', 'inject', 'group', 'isolate', 'intercept'])

/**
 * Throw a configuration error naming the offending field.
 *
 * @param {string} field - the field name.
 * @param {string} detail - what is wrong with it.
 * @returns {never} always throws.
 */
function reject(field, detail) {
  throw new TypeError(`session-workspaces: config.${field} ${detail}`)
}

/**
 * Parse and validate a configuration object.
 *
 * This is the configuration schema handed to the plugin loader, which calls it
 * with whatever the profile row declares; tests use it directly.
 *
 * @param {unknown} input - the raw configuration, as a host supplies it.
 * @returns {object} the applied configuration.
 */
export function applyConfig(input) {
  const raw = input === undefined || input === null ? {} : input
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('session-workspaces: config must be an object')
  }

  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(CONFIG_FIELDS, key) && !HARNESS_KEYS.has(key)) {
      throw new TypeError(`session-workspaces: unknown config field ${JSON.stringify(key)}`)
    }
  }

  /** @type {Record<string, unknown>} */
  const applied = {}
  for (const [field, spec] of Object.entries(CONFIG_FIELDS)) {
    const value = raw[field]
    if (value === undefined || value === null) {
      if ('default' in spec) applied[field] = spec.default
      continue
    }
    switch (spec.kind) {
      case 'boolean':
        if (typeof value !== 'boolean') reject(field, 'must be a boolean')
        applied[field] = value
        break
      case 'string':
        if (typeof value !== 'string') reject(field, 'must be a string')
        applied[field] = value
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) reject(field, 'must be a finite number')
        applied[field] = value
        break
      /* v8 ignore next -- CONFIG_FIELDS declares no other kind. */
      default:
        reject(field, `has an unsupported kind ${JSON.stringify(spec.kind)}`)
    }
  }

  if (applied.maxNameBytes <= 0) reject('maxNameBytes', 'must be a positive number')
  return applied
}

/**
 * The configuration schema bound by the plugin loader.
 *
 * Cordis validates a plugin's config through the Standard Schema interface when
 * the export provides one, and simply passes the raw value through when it does
 * not — so this export carries both halves: the callable validator `apply()`
 * uses, and the `~standard` entry Cordis looks for. A hand-rolled schema is used
 * instead of `@deepseek-ai/schemastery` because this package installs into a
 * host that already owns the harness runtime and `@deepseek-ai/*` packages are
 * not on the public registry; depending on one would make a plain clone fail to
 * install.
 *
 * @param {unknown} input - the raw configuration, as a host supplies it.
 * @returns {object} the applied configuration.
 */
export const Config = Object.assign(applyConfig, {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-session-workspaces',
    /**
     * @param {unknown} value - the raw configuration.
     * @returns {{value: object}|{issues: {message: string, path?: string[]}[]}} the result.
     */
    validate(value) {
      try {
        return { value: applyConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
})

/**
 * Expand a configured path, which may start with `~`, into an absolute path.
 *
 * @param {string} value - the configured path.
 * @returns {string} the expanded path.
 */
function expandTilde(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the harness home the way `@deepseek-ai/dsh-home-paths` does, so this
 * plugin needs no dependency on it.
 *
 * @param {string|undefined} configured - the configured override.
 * @param {Record<string, string|undefined>} [env] - the environment to read.
 * @returns {string} the absolute harness home.
 */
export function resolveHome(configured, env = process.env) {
  const fromEnvironment = env.DSH_HOME
  const chosen =
    configured ??
    (fromEnvironment !== undefined && fromEnvironment.trim().length > 0 ? fromEnvironment : join(homedir(), '.dsh'))
  return resolve(expandTilde(chosen))
}

/**
 * Convert an entry base URL into a directory path.
 *
 * @param {string|undefined} baseUrl - a `file:` URL, with or without a trailing slash.
 * @returns {string|undefined} the directory, or undefined when it is not a usable file URL.
 */
function directoryFromBaseUrl(baseUrl) {
  const text = typeof baseUrl === 'string' ? baseUrl : baseUrl instanceof URL ? baseUrl.href : undefined
  if (text === undefined || !text.startsWith('file:')) return undefined
  try {
    return fileURLToPath(text)
  } catch {
    return undefined
  }
}

/**
 * Resolve the registry document path.
 *
 * An absolute or `~`-prefixed value is used as written. A relative value is
 * anchored to `baseUrl` when the host supplies one — the profile directory under
 * a normal profile boot — and to the harness home otherwise, so the registry
 * travels with the profile that declares the plugin.
 *
 * The harness home always comes from the host: the `DSH_HOME` environment
 * variable, or the explicit `dshHome` option a caller passes (the harness reads
 * the same precedence). It is deliberately not a plugin config field, because a
 * second spelling of the harness home is a second thing to get wrong.
 *
 * @param {object} config - the parsed plugin configuration.
 * @param {object} [options] - resolution context.
 * @param {string|URL} [options.baseUrl] - the owning entry's base URL, usually `ctx.baseUrl`.
 * @param {string} [options.dshHome] - an explicit harness-home override.
 * @param {Record<string, string|undefined>} [options.env] - the environment to read.
 * @returns {string} the absolute registry path.
 */
export function resolveRegistryFile(config, options = {}) {
  const { baseUrl, dshHome, env = process.env } = options
  if (typeof config.file === 'string' && config.file.trim().length > 0) {
    const expanded = expandTilde(config.file.trim())
    if (isAbsolute(expanded)) return resolve(expanded)
    const anchor = directoryFromBaseUrl(baseUrl) ?? resolveHome(dshHome, env)
    return resolve(anchor, expanded)
  }
  return join(resolveHome(dshHome, env), DEFAULT_FILE_NAME)
}
