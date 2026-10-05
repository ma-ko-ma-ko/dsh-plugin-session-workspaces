/**
 * Install this plugin into one DSH profile.
 *
 * The plugin has no dependencies and `cordis.patch.yml` accepts an absolute
 * entry `name`, so installation is one edited file — no package-manager round
 * trip and no writes into the profile's `node_modules`. Mounting by package name
 * is still available (`--by-name`) for a profile that manages its dependencies
 * itself; that path links the checkout into `node_modules` instead.
 *
 * Existing content is preserved: the row is appended only when the patch file
 * does not already mount `session-workspaces`.
 *
 *     node scripts/install-profile.mjs [--profile desktop] [--by-name] [--dry-run]
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHome } from '../lib/config.js'

const PACKAGE_NAME = 'dsh-plugin-session-workspaces'
const ROW_ID = 'session-workspaces'

const argv = process.argv.slice(2)
/**
 * Read one `--flag value` argument.
 * @param {string} name - the flag name without dashes.
 * @param {string} fallback - the value to use when the flag is absent.
 * @returns {string} the resolved value.
 */
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  const value = index >= 0 ? argv[index + 1] : undefined
  return value !== undefined && !value.startsWith('--') ? value : fallback
}
const profile = option('profile', process.env.DSH_PROFILE ?? 'desktop')
const byName = argv.includes('--by-name')
const dryRun = argv.includes('--dry-run')

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const entry = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const home = resolveHome(process.env.DSH_PLUGIN_HOME)
const profileDir = join(home, 'profiles', profile)
const patchFile = join(profileDir, 'cordis.patch.yml')

if (!existsSync(profileDir)) {
  throw new Error(`profile directory does not exist: ${profileDir}\nCreate the profile first (dsh plugin --profile ${profile} add <package>).`)
}

/**
 * Report one planned or applied action.
 * @param {string} message - what happened.
 * @returns {void}
 */
const say = (message) => console.log(`${dryRun ? '(dry run) ' : ''}${message}`)

const current = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
if (current.includes(`id: ${ROW_ID}`)) {
  say(`already installed: ${patchFile} mounts ${ROW_ID}`)
  process.exit(0)
}

if (byName) {
  const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)
  const existing = existsSync(linkPath) ? lstatSync(linkPath) : undefined
  say(`${existing === undefined ? 'creating' : 'keeping'} module link ${linkPath} -> ${pluginRoot}`)
  if (!dryRun && existing === undefined) {
    try {
      mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
      symlinkSync(pluginRoot, linkPath, 'junction')
    } catch (error) {
      console.warn(`could not create the link (${error.message}); retry without --by-name to mount the checkout by path`)
      process.exit(1)
    }
  }
}

const target = byName ? PACKAGE_NAME : `'${entry.replace(/\\/gu, '/')}'`
const row = [
  '',
  '# Per-session output folders: each conversation writes inside one folder named',
  '# after its session title instead of scattering files across the workspace root.',
  '- insert:',
  `    - id: ${ROW_ID}`,
  `      name: ${target}`,
  '',
].join('\n')

say(`appending the plugin row to ${patchFile} (${byName ? 'by package name' : 'by absolute entry path'})`)
if (!dryRun) {
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(patchFile, `${current.trimEnd()}\n${row}`, 'utf8')
  } catch (error) {
    console.error(
      `could not write ${patchFile}: ${error.message}\n` +
        'Add the row from cordis.patch.yml by hand (or run this script with wider file permissions).',
    )
    process.exit(1)
  }
}

say('done — restart DSH (or reload the profile) to mount the plugin')
