/**
 * Folder-name derivation for one session: a session title becomes a single,
 * portable directory name.
 *
 * The rules are deliberately filesystem-portable rather than OS-specific: the
 * same title must produce the same folder name on Windows, macOS, and Linux,
 * because a workspace can be reopened on another host. Names are therefore
 * sanitized against the union of the platforms' forbidden characters, and the
 * Windows reserved device names are avoided everywhere.
 *
 * @module dsh-plugin-session-workspaces/naming
 */

/** Characters no portable single path segment may contain, plus control characters. */
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F\u007F-\u009F]/gu

/** Directional and invisible controls that could make a folder name deceptive. */
const INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/**
 * Windows reserves these base names (case-insensitively, with or without an
 * extension) for devices; a directory named `con` cannot be created there.
 */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

/** Default cap on one folder name, in UTF-8 bytes. */
export const DEFAULT_MAX_NAME_BYTES = 64

/** Fallback stem used when a session has no usable title yet. */
export const UNTITLED_STEM = 'session'

/**
 * Truncate a string to a UTF-8 byte budget without splitting a code point.
 *
 * @param {string} input - text to truncate.
 * @param {number} maxBytes - positive byte budget.
 * @returns {string} the longest leading code-point prefix within the budget.
 */
export function truncateUtf8(input, maxBytes) {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/**
 * Turn one session title into a portable single path segment.
 *
 * The result never contains a path separator, never ends in a dot or space, and
 * is never empty: an unusable title falls back to {@link UNTITLED_STEM}. Byte
 * truncation can leave a trailing space or dot, so the trim is applied again
 * after truncation.
 *
 * @param {unknown} title - the session title, or any value when unknown.
 * @param {object} [options] - derivation options.
 * @param {number} [options.maxBytes] - UTF-8 byte budget for the name.
 * @param {string} [options.fallback] - stem used when the title yields nothing.
 * @returns {string} a portable folder name (without disambiguation suffixes).
 */
export function sanitizeFolderName(title, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_NAME_BYTES
  const fallback = options.fallback ?? UNTITLED_STEM
  if (typeof title !== 'string') return fallback

  let name = title
    .replace(FORBIDDEN, ' ')
    .replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ')
    .trim()
    // A trailing dot or space is stripped by Explorer and rejected on Windows.
    .replace(/[. ]+$/u, '')
    .trim()

  if (name.length === 0) return fallback

  name = truncateUtf8(name, maxBytes).trim().replace(/[. ]+$/u, '').trim()
  if (name.length === 0) return fallback

  // A reserved device name is unusable as the whole segment; anchoring it with a
  // trailing underscore keeps the title recognizable while staying creatable.
  if (RESERVED_DEVICE.test(name)) name = `${name}_`
  return name
}

/**
 * Append a stable, human-readable disambiguator to a taken folder name.
 *
 * @param {string} name - the preferred folder name.
 * @param {number} ordinal - 1-based attempt number; 1 means the name itself.
 * @returns {string} the candidate folder name for that attempt.
 */
export function disambiguate(name, ordinal) {
  return ordinal <= 1 ? name : `${name} (${ordinal})`
}

/**
 * Derive the fallback stem for a session that has no title yet, so an early
 * write still gets a recognizable, stable-per-session folder.
 *
 * @param {unknown} sessionId - the session identity.
 * @returns {string} the fallback folder stem.
 */
export function fallbackStem(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId : ''
  // Keep the trailing identity, which is what distinguishes sessions of the
  // same kind; a leading `session-` prefix carries no information.
  const trimmed = raw.replace(/^session-/iu, '')
  const tail = trimmed.slice(-8).replace(/[^0-9A-Za-z]+/gu, '')
  return tail.length > 0 ? `${UNTITLED_STEM}-${tail}` : UNTITLED_STEM
}
