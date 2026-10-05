/**
 * The filesystem redirect.
 *
 * The model-facing filesystem tools resolve every path through `ctx.fs.resolve`,
 * so wrapping that one method redirects reads, writes, edits, image reads, and
 * everything else built on the same service — including tools this plugin has
 * never heard of. The wrapper is installed on the mounted service instance, so
 * `ctx.fs` hands out the same patched object to every consumer.
 *
 * A resolution is classified from the tool that is currently executing, not from
 * the shape of its options: the tool pipeline reports its tool name before the
 * body runs, and `read`/`write`/`edit` then share one resolution path. The two
 * rules for a path that resolves inside the workspace are:
 *
 * - A mutation always lands in the session folder. That is the whole point of
 *   the plugin.
 * - A read lands in the session folder only when the file is already there, and
 *   otherwise falls back to the workspace root. Without the fallback a session
 *   could not read a single pre-existing workspace artifact; with it, the
 *   observation bookkeeping the edit tool depends on stays consistent, because
 *   `read` observes exactly the file the requested path resolves to.
 *
 * @module dsh-plugin-session-workspaces/fs-facade
 */

import { classifyPath, folderPathFor, normalizePath } from './paths.js'

/** Tools whose paths are outputs: they always resolve into the session folder. */
export const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/**
 * Install the redirect on one filesystem service instance.
 *
 * @param {object} input - installation input.
 * @param {object} input.fs - the mounted filesystem service.
 * @param {object} input.sessionPaths - the resolver from {@link createSessionPaths}.
 * @param {boolean} input.readFallback - whether a read may fall back to the workspace root.
 * @returns {object} the hooks the tool pipeline calls.
 */
export function attachFsRedirect(input) {
  const { fs, sessionPaths } = input
  const original = fs.resolve.bind(fs)
  /** Workspace key → the session that most recently asked for a path in it. */
  const sessions = new Map()
  /** Workspace key → the tool currently executing for that workspace. */
  const activeTools = new Map()
  /** Session → the folder currently in force for that session. */
  const activeFolders = new Map()

  /**
   * Normalize a workspace root for lookup. The sandbox policy and the session
   * header can spell the same directory with different casing on Windows.
   *
   * @param {unknown} workspace - the workspace root.
   * @returns {string|undefined} the lookup key.
   */
  function keyOf(workspace) {
    return typeof workspace === 'string' && workspace.length > 0
      ? normalizePath(workspace).toLowerCase()
      : undefined
  }

  /**
   * The workspace a resolution runs against.
   *
   * `write` and `edit` resolve through their sandbox policy, whose
   * `workspaceRoot` is the session's own cwd; `read` and `present` resolve
   * against the session `cwd` alone. Both name the same workspace.
   *
   * @param {object|undefined} options - the resolution options.
   * @returns {string|undefined} the workspace root.
   */
  function workspaceOf(options) {
    if (typeof options?.workspaceRoot === 'string' && options.workspaceRoot.length > 0) return options.workspaceRoot
    if (typeof options?.cwd === 'string' && options.cwd.length > 0) return options.cwd
    return undefined
  }

  /**
   * Resolve the session folder for a workspace.
   *
   * The name is re-read on every resolution rather than cached here: a session
   * whose placeholder name is replaced by its generated title must never be
   * redirected against a folder it no longer owns. The session-path resolver
   * already caches the underlying lookup by session and title, so the
   * steady-state cost is one map lookup.
   *
   * @param {string} workspace - the session workspace root.
   * @returns {Promise<string|undefined>} the folder path.
   */
  async function folderFor(workspace) {
    const session = sessions.get(keyOf(workspace))
    if (session === undefined) return undefined
    const entry = await sessionPaths.peekFor(session)
    return entry?.folder
  }

  /**
   * Whether a path exists, treating any failure as absence.
   *
   * @param {string|undefined} path - the candidate path.
   * @returns {Promise<boolean>} true when the path exists.
   */
  async function existsIn(path) {
    if (path === undefined || typeof fs.lstat !== 'function') return false
    try {
      const info = await fs.lstat(path, {})
      return info !== undefined && info !== null
    } catch {
      return false
    }
  }

  fs.resolve = async function resolve(path, options, ...rest) {
    const workspace = workspaceOf(options)
    const key = keyOf(workspace)
    // A caller with no registered session — a web file browser, a host route —
    // keeps the raw resolution it had before this plugin loaded.
    if (key === undefined || workspace === undefined || !sessions.has(key)) {
      return original(path, options, ...rest)
    }
    if (typeof path !== 'string' || path.trim().length === 0) return original(path, options, ...rest)

    const folder = await folderFor(workspace)
    if (folder === undefined) return original(path, options, ...rest)

    const classification = classifyPath({ path, workspace, folder })
    if (classification !== 'workspace-output') return original(path, options, ...rest)

    const redirected = folderPathFor({ path, workspace, folder })
    const mutation = MUTATING_TOOLS.has(activeTools.get(key))
    if (mutation || input.readFallback === false) return original(redirected, options, ...rest)
    // A read follows the session's own file when it exists, and otherwise reads
    // the workspace root.
    if (await existsIn(redirected)) return original(redirected, options, ...rest)
    return original(path, options, ...rest)
  }

  return {
    /**
     * Record that a tool call is running for one session, so the resolutions it
     * triggers can find that session's folder and its read/write class.
     *
     * @param {object|undefined} session - the calling session.
     * @param {string|undefined} toolName - the tool about to execute.
     * @returns {void}
     */
    noteSession(session, toolName) {
      const key = keyOf(session?.header?.cwd)
      if (key === undefined) return
      sessions.set(key, session)
      if (typeof toolName === 'string' && toolName.length > 0) activeTools.set(key, toolName)
    },
    /**
     * Drop one session's cached probe, so a folder renamed by a late title is
     * picked up by the next path resolution.
     *
     * @param {object|undefined} session - the session whose folder changed.
     * @returns {void}
     */
    invalidate(session) {
      if (session !== undefined) activeFolders.delete(session)
    },
    /**
     * Report the redirect's state for diagnostics.
     *
     * @returns {{workspaces: number, folders: number}} counters.
     */
    state() {
      return { workspaces: sessions.size, folders: activeFolders.size }
    },
  }
}
