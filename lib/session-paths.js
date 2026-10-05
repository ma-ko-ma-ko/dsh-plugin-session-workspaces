/**
 * Session-output path resolution.
 *
 * One mapping per (session, workspace) pair is cached: the absolute folder that
 * this session's outputs belong to. The mapping is resolved through the durable
 * registry, so a resumed session finds yesterday's folder, and the placeholder
 * name a session carries before its title exists is replaced by the real title
 * as soon as the title service has one.
 *
 * @module dsh-plugin-session-workspaces/session-paths
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MARKER_FILE_NAME, normalizePath } from './paths.js'

/**
 * Read the session id of one session object.
 *
 * @param {object|undefined} session - a live session.
 * @returns {string|undefined} the id when present.
 */
function sessionIdOf(session) {
  const id = session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Resolve the session whose title names the folder.
 *
 * A subagent, a fork, or any other delegated child shares its parent's output
 * folder: one delegated job is part of one piece of work, and splitting its
 * artifacts across per-child folders would defeat the point. The walk is
 * bounded so a malformed parent chain cannot loop forever.
 *
 * @param {object|undefined} session - the calling session.
 * @param {object|undefined} sessions - the session store, when mounted.
 * @param {number} [maxDepth] - maximum ancestor hops.
 * @returns {object|undefined} the root session, or the input when no chain applies.
 */
export function rootSessionOf(session, sessions, maxDepth = 16) {
  let current = session
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parentId = current?.header?.parentSession
    if (typeof parentId !== 'string' || parentId.length === 0) return current
    const parent = sessions?.get?.(parentId)
    if (parent === undefined || parent === null) return current
    current = parent
  }
  return current
}

/**
 * Read the current title of one session.
 *
 * @param {object|undefined} titleService - the `sessionTitle` service, when mounted.
 * @param {object|undefined} session - the session to read.
 * @returns {{ title: string|undefined, provisional: boolean }} the title, and
 *   whether it is still the deterministic pre-title fallback — which the
 *   generated title replaces moments later, and which therefore may rename an
 *   otherwise empty folder.
 */
export function titleOf(titleService, session) {
  if (titleService === undefined || session === undefined) return { title: undefined, provisional: true }
  try {
    const snapshot = titleService.get?.(session)
    const title = snapshot?.title
    if (typeof title !== 'string' || title.length === 0) return { title: undefined, provisional: true }
    const source = snapshot?.source?.kind
    return { title, provisional: source === 'fallback' }
  } catch {
    return { title: undefined, provisional: true }
  }
}

/**
 * Build the per-plugin session-path resolver.
 *
 * The cache key includes the title, so the transition from the provisional
 * pre-title name to the generated title is exactly a cache miss — and every
 * later call is a single map lookup.
 *
 * @param {object} deps - long-lived dependencies.
 * @param {import('./registry.js').FolderRegistry} deps.registry - durable assignments.
 * @param {() => object|undefined} deps.titleService - the optional `sessionTitle` service.
 * @param {() => object|undefined} deps.sessions - the optional session store.
 * @param {number} deps.maxNameBytes - folder-name byte budget.
 * @param {(message: string) => void} deps.warn - diagnostic sink.
 * @returns {object} the resolver API: `ensureFor`, `peekFor`, and `forget`.
 */
export function createSessionPaths(deps) {
  const cache = new Map()
  /** Session → its most recent resolution, for synchronous readers. */
  const resolved = new Map()

  /**
   * Resolve the folder for one session, allocating it on first use.
   *
   * @param {object|undefined} session - the calling session.
   * @param {boolean} create - whether a first resolution may create the folder on disk.
   * @returns {Promise<{name: string, folder: string, workspace: string, sessionId: string}|undefined>}
   *   the resolved folder, or undefined when the session has no workspace.
   */
  async function resolveFor(session, create) {
    const workspace = session?.header?.cwd
    if (typeof workspace !== 'string' || workspace.length === 0) return undefined
    const root = rootSessionOf(session, deps.sessions()) ?? session
    const sessionId = sessionIdOf(root) ?? sessionIdOf(session)
    if (sessionId === undefined) return undefined

    const { title, provisional } = titleOf(deps.titleService(), root)
    const cacheKey = `${sessionId}\u0000${normalizePath(workspace)}\u0000${provisional ? '' : title ?? ''}`
    const hit = cache.get(cacheKey)
    if (hit !== undefined) {
      resolved.set(session, hit)
      if (create) await createFolder({ ...hit, sessionId, title })
      return { ...hit, sessionId, workspace }
    }

    const resolution = await deps.registry.resolve({
      sessionId,
      workspace,
      title,
      titleIsReal: !provisional,
      now: Date.now(),
      maxBytes: deps.maxNameBytes,
    })
    const entry = {
      name: resolution.name,
      folder: join(workspace, resolution.name),
      workspace,
      sessionId,
      title,
      provisional,
    }
    cache.set(cacheKey, entry)
    // For a delegated child the folder belongs to the root session it shares, so
    // the synchronous reader must be able to look it up under both identities.
    resolved.set(session, entry)
    resolved.set(root, entry)
    if (create) await createFolder(entry)
    return entry
  }

  const created = new Set()

  /**
   * Create the folder and its provenance marker once per process.
   *
   * The marker is what lets a human tell which conversation produced a folder
   * whose name the model has since rewritten. Failures are diagnostics only:
   * writes into a not-yet-existing folder still succeed because every writer
   * creates missing parent directories.
   *
   * @param {object} entry - the resolved folder entry.
   * @returns {Promise<void>} resolves once the folder is usable.
   */
  async function createFolder(entry) {
    if (created.has(entry.folder)) return
    created.add(entry.folder)
    const marker = {
      plugin: 'dsh-plugin-session-workspaces',
      sessionId: entry.sessionId,
      title: entry.title ?? null,
      createdAt: new Date().toISOString(),
    }
    try {
      await mkdir(entry.folder, { recursive: true })
      await writeFile(join(entry.folder, MARKER_FILE_NAME), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    } catch (error) {
      deps.warn(`session-workspaces: cannot prepare "${entry.folder}": ${describe(error)}`)
    }
  }

  return {
    /**
     * Resolve the folder for a call that may create it (a mutation, or a shell).
     *
     * @param {object|undefined} session - the calling session.
     * @returns {Promise<object|undefined>} the folder entry.
     */
    ensureFor: (session) => resolveFor(session, true),
    /**
     * Resolve the folder for a call that must not create it (a read probe).
     *
     * @param {object|undefined} session - the calling session.
     * @returns {Promise<object|undefined>} the folder entry.
     */
    peekFor: (session) => resolveFor(session, false),
    /**
     * The folder already resolved for one session, without touching the disk.
     *
     * The runtime-context section is rendered synchronously, so it reads this
     * instead of waiting for a resolution.
     *
     * @param {object|undefined} session - the session to look up.
     * @returns {object|undefined} the last resolved folder entry.
     */
    lastKnown: (session) => (session === undefined ? undefined : resolved.get(session)),
    /**
     * Forget one session's folder (it was disposed).
     *
     * @param {object|undefined} session - the disposed session.
     * @returns {void}
     */
    forget(session) {
      if (session === undefined) {
        cache.clear()
        resolved.clear()
        return
      }
      resolved.delete(session)
      for (const [key, entry] of cache) {
        if (entry.sessionId === sessionIdOf(session)) cache.delete(key)
      }
    },
  }
}

/**
 * Render the runtime-context section that tells the model where its outputs go.
 *
 * @param {object} folder - a resolved folder entry.
 * @param {boolean} shellFolder - whether the shell's default directory is the folder.
 * @returns {string} the model-facing context text.
 */
export function renderContextSection(folder, shellFolder) {
  const lines = [
    `Session output folder: ${braceSafe(folder.folder)}`,
    'Every path inside the workspace that this session writes is stored there, not in the workspace root, and a relative path resolves there first.',
    'The workspace root still holds earlier conversations\' artifacts: reading a file that exists only in the root falls back to the root, so those stay readable, but never write there directly.',
  ]
  if (shellFolder) {
    lines.push('A shell command whose working directory is the workspace root runs in this folder instead, so relative paths inside it land here.')
  }
  return lines.join('\n')
}

/**
 * Defuse a prompt-variable reference inside a path.
 *
 * Runtime-context text is interpolated before it reaches the model, and a
 * folder name derived from a session title is model-influenced text. A `{{`
 * pair in it would otherwise be read as a variable reference and fail the whole
 * prompt assembly.
 *
 * @param {string} text - the rendered text.
 * @returns {string} text that contains no `{{` pair.
 */
function braceSafe(text) {
  return text.replace(/\{\{/gu, '{ {')
}

/** Extract a printable message from an unknown thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
