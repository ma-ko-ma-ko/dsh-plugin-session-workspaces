/**
 * Durable session→folder assignment registry.
 *
 * The mapping must survive a restart, because a session resumed tomorrow has to
 * find the folder it wrote into yesterday — and because the session's own log
 * does not record where its artifacts went. The registry is a hand-editable
 * JSON document under the harness home, keyed by session id, holding one
 * relative folder name per workspace.
 *
 * Names are allocated once and kept: a title that the model regenerates later
 * cannot silently move a session's existing outputs. The one exception is the
 * placeholder name a session gets before its title exists, which is migrated
 * once the real title arrives (and only while `titleIsReal` on the record
 * still says the name was provisional).
 *
 * @module dsh-plugin-session-workspaces/registry
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_MAX_NAME_BYTES, disambiguate, fallbackStem, sanitizeFolderName } from './naming.js'

/** Registry document schema version. */
const SCHEMA_VERSION = 1

/**
 * Normalize one workspace key for lookup. Paths are compared
 * case-insensitively because the workspace root arrives from the operating
 * system (which on Windows may be spelled either way) while the registry is
 * written by the harness.
 *
 * @param {unknown} workspace - the absolute workspace directory.
 * @returns {string} the lookup key, or an empty string when unusable.
 */
export function workspaceKey(workspace) {
  if (typeof workspace !== 'string') return ''
  return workspace.replace(/[\\/]+$/u, '').toLowerCase()
}

/** Whether a value is a plain record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve the one folder name for a session in a workspace, allocating it when
 * this is the first write.
 *
 * @param {object} input - resolution input.
 * @param {string} input.sessionId - the owning (root) session id.
 * @param {string} input.workspace - the absolute workspace directory.
 * @param {string|undefined} input.title - the current session title, when known.
 * @param {boolean} input.titleIsReal - whether `title` is final. A title that is
 *   not yet final leaves the folder name provisional, so the arrival of the real
 *   title may still rename an otherwise untouched folder.
 * @param {number} input.now - current epoch milliseconds.
 * @param {string[]} [input.protectedNames] - folder names that must not be
 *   handed to this session even though nothing else claims them (the names this
 *   session itself used before a migration).
 * @returns {{ name: string, created: boolean, migratedFrom?: string }} the assignment.
 */
export function executeResolution(input) {
  const { sessionId, workspace, title, titleIsReal, now } = input
  const protectedNames = input.protectedNames ?? []
  const key = workspaceKey(workspace)
  const existing = input.entries.get(sessionId)

  // Names already owned elsewhere in this workspace.
  const taken = new Map()
  for (const [id, entry] of input.entries) {
    if (id === sessionId) continue
    const folder = entry?.workspaces?.[key]
    if (typeof folder === 'string') taken.set(folder.toLowerCase(), id)
  }
  for (const name of protectedNames) taken.set(name.toLowerCase(), sessionId)

  const desired = sanitizeFolderName(title, {
    maxBytes: input.maxBytes ?? DEFAULT_MAX_NAME_BYTES,
    fallback: fallbackStem(sessionId),
  })

  if (existing !== undefined) {
    const current = existing.workspaces?.[key]
    const shouldMigrate = typeof current === 'string'
      && titleIsReal === true
      && existing.titleIsReal !== true
      && current !== desired
    if (typeof current === 'string' && !shouldMigrate) {
      existing.title = title
      existing.titleIsReal = titleIsReal
      existing.updatedAt = now
      return { name: current, created: false }
    }
    if (typeof current === 'string' && shouldMigrate && !taken.has(desired.toLowerCase())) {
      const migratedFrom = current
      existing.previousNames = [...new Set([...(existing.previousNames ?? []), current])]
      existing.workspaces[key] = desired
      existing.title = title
      existing.titleIsReal = titleIsReal
      existing.updatedAt = now
      return { name: desired, created: false, migratedFrom }
    }
  }

  // Allocate: the desired name when free, otherwise its numbered disambiguations.
  let name = desired
  for (let ordinal = 1; taken.has(name.toLowerCase()); ordinal += 1) {
    name = disambiguate(desired, ordinal + 1)
  }

  const entry = existing ?? {
    sessionId,
    workspaces: {},
    createdAt: now,
  }
  entry.workspaces = { ...entry.workspaces, [key]: name }
  entry.title = title
  entry.titleIsReal = titleIsReal
  entry.updatedAt = now
  input.entries.set(sessionId, entry)
  return { name, created: existing === undefined }
}

/**
 * Durable, lazily loaded session→folder registry.
 *
 * The in-memory snapshot is authoritative once loaded; mutations write through
 * atomically so a crash mid-session cannot leave a half-written mapping. A
 * malformed document is reported once and then treated as empty rather than
 * failing every tool call.
 */
export class FolderRegistry {
  /** @type {Map<string, object>} */
  entries = new Map()

  /** @type {Promise<void>|undefined} */
  #loading

  /** @type {Promise<void>} */
  #writes = Promise.resolve()

  /**
   * @param {string} file - absolute path of the registry document.
   * @param {(message: string) => void} [warn] - diagnostic sink.
   */
  constructor(file, warn) {
    this.file = file
    this.warn = warn ?? (() => {})
  }

  /**
   * Load the document once. Concurrent callers share one read.
   *
   * @returns {Promise<void>} resolves once the snapshot is usable.
   */
  async load() {
    if (this.#loading === undefined) this.#loading = this.#read()
    return this.#loading
  }

  async #read() {
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`session-workspaces: cannot read ${this.file}: ${message(error)}`)
      return
    }
    try {
      const parsed = JSON.parse(raw)
      if (!isRecord(parsed) || !isRecord(parsed.sessions)) return
      for (const [id, entry] of Object.entries(parsed.sessions)) {
        if (!isRecord(entry) || !isRecord(entry.workspaces)) continue
        this.entries.set(id, entry)
      }
    } catch (error) {
      this.warn(`session-workspaces: ignoring malformed ${this.file}: ${message(error)}`)
    }
  }

  /**
   * Resolve (and record) the folder for one session, loading and persisting as
   * needed.
   *
   * @param {object} input - see {@link executeResolution}.
   * @returns {Promise<{ name: string, created: boolean, migratedFrom?: string }>} the assignment.
   */
  async resolve(input) {
    await this.load()
    // Every name this registry has ever handed out in this workspace stays
    // reserved, even after its session moved to a better one: a folder that once
    // held one conversation's artifacts must not silently become another
    // conversation's folder. A different workspace is unaffected.
    const protectedNames = input.protectedNames ?? this.#historicalNames(workspaceKey(input.workspace))
    const result = executeResolution({ ...input, entries: this.entries, protectedNames })
    await this.#persist()
    return result
  }

  /**
   * Every folder name any session has used in one workspace.
   *
   * @param {string} key - the normalized workspace key.
   * @returns {string[]} the reserved names.
   */
  #historicalNames(key) {
    const names = new Set()
    for (const entry of this.entries.values()) {
      const current = entry?.workspaces?.[key]
      if (typeof current === 'string') names.add(current)
      for (const name of entry?.previousNames ?? []) {
        if (typeof name === 'string') names.add(name)
      }
    }
    return [...names]
  }

  /** Serialize the current snapshot to disk atomically. */
  #persist() {
    const document = JSON.stringify(
      { version: SCHEMA_VERSION, sessions: Object.fromEntries(this.entries) },
      null,
      2,
    )
    this.#writes = this.#writes.then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`
      try {
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(temporary, `${document}\n`, 'utf8')
        await rename(temporary, this.file)
      } catch (error) {
        this.warn(`session-workspaces: cannot write ${this.file}: ${message(error)}`)
      }
    })
    return this.#writes
  }
}

/** Extract a printable message from an unknown thrown value. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
