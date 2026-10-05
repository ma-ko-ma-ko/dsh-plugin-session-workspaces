/**
 * Per-session output folders for DeepSeek Harness.
 *
 * Several conversations can share one workspace. By default they all write into
 * its root, so their artifacts interleave and overwrite each other. This plugin
 * gives every conversation one folder inside the workspace, named after the
 * session title, and moves the conversation's writes into it:
 *
 * - Every filesystem path that resolves inside the workspace is resolved into
 *   the session folder instead, so `read`, `write`, `edit`, `read_image`, and
 *   any other tool built on `ctx.fs` land there.
 * - A read whose file exists only in the workspace root still reads the root, so
 *   the artifacts of earlier conversations stay usable.
 * - A shell command whose working directory is the workspace root runs in the
 *   session folder, so relative paths inside the command stay there too.
 * - The assignment is durable and keyed by session id, so a resumed session
 *   keeps writing into the folder it created yesterday.
 *
 * @module dsh-plugin-session-workspaces
 */

import { Config, resolveRegistryFile } from './config.js'
import { attachFsRedirect } from './fs-facade.js'
import { FolderRegistry } from './registry.js'
import { createSessionPaths, renderContextSection } from './session-paths.js'
import { attachShellRedirect } from './shell-facade.js'

/** Stable plugin name used by loader diagnostics. */
export const name = 'session-workspaces'

/**
 * Services the plugin requires: the tool pipeline it hangs its per-call hook on,
 * the filesystem it redirects, and the prompt registry it contributes to. The
 * shell and session-title services are optional — a headless composition may
 * mount no shell — so they are looked up rather than injected.
 */
export const inject = ['tools', 'fs', 'systemPrompt']

export { Config }

/** Runtime-context entry name contributed by this plugin. */
export const CONTEXT_NAME = 'session-workspaces:output-folder'

/**
 * Apply the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} config - parsed configuration (see {@link Config}).
 * @returns {void}
 */
export function apply(ctx, config) {
  if (config.enabled === false) return
  const warn = (message) => ctx.logger?.warn?.(message)

  const file = resolveRegistryFile(config, { baseUrl: ctx.baseUrl })
  const registry = new FolderRegistry(file, warn)
  const sessionPaths = createSessionPaths({
    registry,
    titleService: () => ctx.get('sessionTitle'),
    sessions: () => ctx.get('sessions'),
    maxNameBytes: config.maxNameBytes,
    warn,
  })

  // The runtime context is rendered synchronously during prompt assembly while
  // the folder is resolved asynchronously; these two bridges carry the answer
  // across: `snapshot` is written by the tool hook, and `sessionPaths.lastKnown`
  // answers once a resolution (or the session-created hook below) has run.
  const snapshot = new Map()

  ctx.effect(() => {
    let cancelled = false
    // Load once at mount so a malformed registry is reported at startup, where
    // an operator can act on it, rather than on the first write of a session.
    registry.load().catch((error) => {
      if (!cancelled) warn(`session-workspaces: registry load failed: ${describe(error)}`)
    })
    return () => {
      cancelled = true
      sessionPaths.forget()
      snapshot.clear()
    }
  }, 'session-workspaces: registry')

  const fsRedirect = attachFsRedirect({ fs: ctx.fs, sessionPaths, readFallback: config.readFallback })
  const shellRedirect = config.shellWorkdir ? attachOptionalShell(ctx, sessionPaths, warn) : undefined

  // Warm the folder as soon as a session exists, so the runtime context of the
  // very first prompt already names it. A session created outside the store
  // (a directly constructed agent) is picked up by the tool hook instead.
  ctx.on('session/created', (session) => {
    if (session === undefined) return
    fsRedirect.noteSession(session)
    void sessionPaths.peekFor(session).then((entry) => {
      if (entry !== undefined) snapshot.set(session, entry)
    }).catch(() => {})
  })
  ctx.on('session/disposed', (session) => {
    sessionPaths.forget(session)
    snapshot.delete(session)
    fsRedirect.invalidate(session)
  })

  // The tool hook runs before every tool body. `ctx.fs` reports a workspace, not
  // a session, so this is where the session that owns each workspace becomes
  // known to the redirects; it also warms the shell's folder, because
  // `ShellExecutor.resolve` is synchronous.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec?.agent?.session
    if (session !== undefined) {
      fsRedirect.noteSession(session, exec?.name)
      snapshot.set(session, sessionPaths.lastKnown(session))
      if (shellRedirect !== undefined) await shellRedirect.noteSession(session)
    }
    return next()
  })

  if (config.prompt !== false) {
    ctx.systemPrompt.context({
      name: CONTEXT_NAME,
      order: config.promptOrder,
      text: (context) => {
        const session = context?.agent?.session
        if (session === undefined) return ''
        const folder = snapshot.get(session) ?? sessionPaths.lastKnown(session)
        return folder === undefined ? '' : renderContextSection(folder, shellRedirect !== undefined)
      },
    })
  }

  ctx.logger?.debug?.(`session-workspaces: assignment registry ${file}`)
}

/**
 * Attach the shell redirect when a shell service is mounted.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} sessionPaths - the session-folder resolver.
 * @param {(message: string) => void} warn - diagnostic sink.
 * @returns {object|undefined} the shell hooks, when a shell is available.
 */
function attachOptionalShell(ctx, sessionPaths, warn) {
  const shell = ctx.get('shell')
  if (shell === undefined || typeof shell.resolve !== 'function') return undefined
  try {
    return attachShellRedirect({ shell, sessionPaths })
  } catch (error) {
    warn(`session-workspaces: shell redirect unavailable: ${describe(error)}`)
    return undefined
  }
}

/** Extract a printable message from an unknown thrown value. */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
