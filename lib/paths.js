/**
 * Path classification for the session-folder redirect.
 *
 * One rule decides whether a model-supplied path belongs to the session's own
 * output area: a path that resolves inside the session workspace (but outside
 * the session folder) is treated as *this session's* output even when the model
 * spelled it as an absolute path, because that is exactly the spelling that
 * scatters artifacts across a shared workspace. A path that resolves outside
 * the workspace — a system temp directory, a read-only fixture, another tool's
 * cache — is never touched.
 *
 * @module dsh-plugin-session-workspaces/paths
 */

import { relative, resolve, sep } from 'node:path'
/** Relative location of the session workspace marker written inside each folder. */
export const MARKER_FILE_NAME = '.dsh-session.json'

/**
 * Normalize a path for comparison: absolute, no trailing separators, and with
 * forward slashes so the same location compares equal on every platform.
 *
 * @param {string} path - an absolute or relative path.
 * @returns {string} the normalized path.
 */
export function normalizePath(path) {
  const absolute = resolve(path)
  const withoutTrailing = absolute.length > 1 ? absolute.replace(/[\\/]+$/u, '') : absolute
  return sep === '\\' ? withoutTrailing.replace(/\\/gu, '/') : withoutTrailing
}

/**
 * Whether `child` is `parent` itself or lives underneath it.
 *
 * A prefix comparison would accept `C:/work` for a child of `C:/wo`, so the
 * check is segment-anchored.
 *
 * @param {string} parent - the containing directory.
 * @param {string} child - the candidate descendant.
 * @returns {boolean} true when `child` is inside `parent`.
 */
export function containsPath(parent, child) {
  const from = normalizePath(parent)
  const to = normalizePath(child)
  if (to === from) return true
  const prefix = from.endsWith('/') ? from : `${from}/`
  return to.startsWith(prefix)
}

/**
 * Classify one path against the session folder.
 *
 * @param {object} input - classification input.
 * @param {string} input.path - the requested path, absolute or workspace-relative.
 * @param {string} input.workspace - the session workspace root.
 * @param {string} input.folder - the session folder (absolute).
 * @returns {'inside-folder'|'outside-workspace'|'workspace-output'} the class.
 */
export function classifyPath(input) {
  const { path, workspace, folder } = input
  const absolute = resolve(workspace, path)
  if (containsPath(folder, absolute)) return 'inside-folder'
  if (!containsPath(workspace, absolute)) return 'outside-workspace'
  return 'workspace-output'
}

/**
 * Map a workspace-internal path onto its session-folder spelling.
 *
 * Callers must have classified the path as `workspace-output` first; the
 * `inside-folder` and `outside-workspace` cases both return the input path.
 *
 * @param {object} input - classification input.
 * @param {string} input.path - the requested path.
 * @param {string} input.workspace - the session workspace root.
 * @param {string} input.folder - the session folder (absolute).
 * @returns {string} either the original path or its session-folder spelling.
 */
export function folderPathFor(input) {
  const { path, workspace, folder } = input
  if (classifyPath(input) !== 'workspace-output') return path
  const absolute = resolve(workspace, path)
  const tail = relative(workspace, absolute)
  return tail.length === 0 ? folder : resolve(folder, tail)
}

/**
 * Whether a shell working directory names the session workspace root itself.
 *
 * A workdir that merely starts at the root (`<root>\project`) deliberately
 * names a subdirectory, so it stays where the model pointed it; only the bare
 * root is ambiguous — it is what the tool layer substitutes when the model
 * omitted `workdir` altogether.
 *
 * @param {object} input - comparison input.
 * @param {string|undefined} input.workdir - the resolved shell working directory.
 * @param {string} input.workspace - the session workspace root.
 * @returns {boolean} true when the workdir is exactly the workspace root.
 */
export function isWorkspaceRoot(input) {
  const { workdir, workspace } = input
  if (typeof workdir !== 'string' || workdir.length === 0) return false
  return normalizePath(workdir) === normalizePath(workspace)
}

/**
 * Render the model-facing one-line notice for a redirected path.
 *
 * @param {string} from - the requested path.
 * @param {string} to - the path actually used.
 * @returns {string} the notice text.
 */
export function redirectNotice(from, to) {
  return `[session-workspaces] "${from}" resolved inside this session's output folder as "${to}".`
}
