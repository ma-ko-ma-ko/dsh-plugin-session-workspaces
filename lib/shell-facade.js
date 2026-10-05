/**
 * The shell redirect.
 *
 * Shell tools do not go through `ctx.fs`, so the filesystem redirect cannot see
 * them. Every shell command the model does not give an explicit `workdir` runs
 * in the session workspace root, and a relative path inside such a command —
 * `python build.py`, `Set-Content out.txt`, `libreoffice --convert-to docx` —
 * would therefore scatter into the workspace root.
 *
 * The redirect narrows to the one case that is unambiguously defaulted: a
 * working directory that is exactly the workspace root. A workdir inside the
 * root (`<root>\project`) deliberately names a subdirectory and stays where the
 * model pointed it, and a workdir outside the root is not this session's
 * business.
 *
 * @module dsh-plugin-session-workspaces/shell-facade
 */

import { isWorkspaceRoot, normalizePath } from './paths.js'

/**
 * Install the redirect on one shell service instance.
 *
 * `ShellExecutor.resolve` is synchronous and fills in the default working
 * directory itself, so the folder has to be known before the shell tool calls
 * it: {@link ShellRedirect.noteSession} warms it in the tool pipeline, which
 * always runs before the tool body resolves a command.
 *
 * @param {object} input - installation input.
 * @param {object} input.shell - the mounted shell service.
 * @param {object} input.sessionPaths - the resolver from {@link createSessionPaths}.
 * @returns {{ noteSession: (session: object|undefined) => Promise<void> }} the hooks the tool pipeline calls.
 */
export function attachShellRedirect(input) {
  const { shell, sessionPaths } = input
  const original = shell.resolve.bind(shell)
  /** Workspace key → the session that most recently ran a command in it. */
  const sessions = new Map()
  /** Session → its warmed folder, so `resolve` itself stays synchronous. */
  const warmed = new Map()

  /**
   * @param {unknown} workspace - a workspace root or working directory.
   * @returns {string|undefined} the lookup key.
   */
  function keyOf(workspace) {
    return typeof workspace === 'string' && workspace.length > 0
      ? normalizePath(workspace).toLowerCase()
      : undefined
  }

  shell.resolve = function resolve(request, ...rest) {
    const spec = original(request, ...rest)
    const session = sessions.get(keyOf(spec?.workdir))
    const entry = session === undefined ? undefined : warmed.get(session)
    if (entry === undefined) return spec
    if (!isWorkspaceRoot({ workdir: spec.workdir, workspace: entry.workspace })) return spec
    return { ...spec, workdir: entry.folder }
  }

  return {
    /**
     * Record the session for one command and warm its folder.
     *
     * @param {object|undefined} session - the calling session.
     * @returns {Promise<void>} resolves once the folder is known.
     */
    async noteSession(session) {
      const key = keyOf(session?.header?.cwd)
      if (key === undefined) return
      sessions.set(key, session)
      const entry = await sessionPaths.ensureFor(session)
      if (entry !== undefined) warmed.set(session, { folder: entry.folder, workspace: entry.workspace })
    },
  }
}
