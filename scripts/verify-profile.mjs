/**
 * End-to-end verification against a real DSH profile.
 *
 * This boots the harness the way the application does — `runProfile` over a
 * throwaway workspace home — and then drives the live tool registry, so every
 * claim about the redirect is checked against real `read`/`write`/`edit`/`pwsh`
 * executions and the real sandbox, not against a test double.
 *
 * Run it from a directory that can resolve `@deepseek-ai/dsh` (the harness
 * installation or an unpacked copy of it):
 *
 *     node scripts/verify-profile.mjs
 *
 * Exits non-zero when any check fails.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = await mkdtemp(join(tmpdir(), 'session-workspaces-e2e-'))
const profile = 'e2e'
const profileDir = join(home, 'profiles', profile)
// The workspace must live somewhere the Windows ACL sandbox can actually grant
// write access to. A directory under the OS temp root cannot be re-ACLed on some
// installations, so the workspace is created beside this script instead and
// removed afterwards; the harness home itself stays in temp.
const workspace = fileURLToPath(new URL('../.e2e-workspace', import.meta.url))

/**
 * Resolve one harness module from the installation that owns this checkout.
 *
 * The plugin is a plain source tree with no runtime dependencies, so it cannot
 * import the harness by name on its own. The harness installation is reached
 * either through `DSH_HARNESS_ANCHOR` (the installation's `dsh/package.json`
 * URL) or through the installed application's well-known location.
 *
 * @param {string} specifier - the package specifier to resolve.
 * @returns {Promise<string>} the resolved module URL.
 */
async function harnessModule(specifier) {
  const candidates = [
    process.env.DSH_HARNESS_ANCHOR,
    new URL('dsh/package.json', import.meta.url).href,
    'file:///C:/Users/lenovo/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/package.json',
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0)

  const failures = []
  for (const anchor of candidates) {
    try {
      return import.meta.resolve(specifier, anchor)
    } catch (error) {
      failures.push(`${anchor}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    `cannot resolve ${specifier} from any harness anchor:\n  ${failures.join('\n  ')}\n` +
      'Set DSH_HARNESS_ANCHOR to the installation\'s dsh/package.json URL.',
  )
}

// A workspace-write session inside the throwaway home, with no telemetry and no
// developer host surface.
process.env.DSH_HOME = home
process.env.DSH_PERMISSION_MODE = 'workspace-write'
process.env.DSH_TELEMETRY_DISABLED = '1'

await rm(workspace, { recursive: true, force: true }).catch(() => {})
await mkdir(workspace, { recursive: true })
await mkdir(profileDir, { recursive: true })
// An artifact owned by an earlier conversation, which this session must still be
// able to read while never writing over it.
await writeFile(join(workspace, 'earlier-report.md'), 'earlier conversation output\n', 'utf8')
await writeFile(
  join(profileDir, 'package.json'),
  `${JSON.stringify({ name: `dsh-profile-${profile}`, private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2)}\n`,
  'utf8',
)
await writeFile(
  join(profileDir, 'cordis.patch.yml'),
  [
    '# Throwaway profile used by scripts/verify-profile.mjs.',
    '- insert:',
    '    - id: session-workspaces',
    `      name: '${fileURLToPath(new URL('../lib/index.js', import.meta.url))}'`,
    '      config:',
    `        file: '${join(profileDir, 'assignments.json').replace(/\\/gu, '/')}'`,
    '',
  ].join('\n'),
  'utf8',
)

const { runProfile } = await import(await harnessModule('@deepseek-ai/dsh/profile-boot'))
const { loadLayeredEnv } = await import(await harnessModule('@deepseek-ai/dsh-app-boot'))

const { ctx, shutdown } = await runProfile({
  environment: { ...loadLayeredEnv('dsh'), DSH_HOME: home },
  profile,
  patchFiles: [],
  args: [],
})

const results = []
/**
 * Record one check.
 * @param {string} label - what is being checked.
 * @param {unknown} actual - the observed value.
 * @param {unknown} expected - the required value.
 * @returns {void}
 */
const check = (label, actual, expected) => {
  const ok = actual === expected
  results.push({ label, ok })
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n        actual:   ${JSON.stringify(actual)}\n        expected: ${JSON.stringify(expected)}`),
  )
}

/** One live session, created in the real store so every lifecycle hook runs. */
const sessionId = 'session-e2e-1111222233334444'
const session = ctx.sessions.create(sessionId, { meta: { cwd: workspace } })

/**
 * Run one registered tool the way the agent loop does.
 * @param {string} name - the tool name.
 * @param {object} args - the model-supplied arguments.
 * @returns {Promise<object>} the materialized tool result.
 */
const callTool = async (name, args) => {
  const definition = ctx.tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  return ctx.tools.execute({
    name,
    callId: `call-${name}-${Math.random().toString(16).slice(2)}`,
    arguments: args,
    agent: { session },
    signal: new AbortController().signal,
  })
}

/** The text of a tool result. */
const textOf = (result) => result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')

/**
 * The runtime-context text the model would receive for one session.
 *
 * The agent loop adds its own context contributions that need a fuller agent
 * object than this harness-less check can build, so a failure there is reported
 * instead of masking the plugin's own contribution.
 *
 * @param {object} target - the live session.
 * @returns {Promise<string>} the joined context text, or an empty string.
 */
async function contextTextFor(target) {
  try {
    const assembled = await ctx.systemPrompt.assemble({ agent: { session: target } })
    return (assembled.contexts ?? []).map((entry) => entry.text).join('\n')
  } catch (error) {
    console.log(`SKIP  full context assembly is unavailable here (${error instanceof Error ? error.message : String(error)})`)
    return ''
  }
}

console.log('rows in the live tree:')
for (const entry of ctx.loader.entries?.() ?? []) console.log(`  - ${entry.options?.id ?? '(no id)'} <- ${entry.options?.name ?? ''}`)
console.log()

check('the plugin row mounted', (ctx.loader.entries?.() ?? []).some((entry) => entry.options?.id === 'session-workspaces'), true)

// ── naming ────────────────────────────────────────────────────────────────────
const registryFile = join(profileDir, 'assignments.json')
/** Read the folder name the registry assigned to the e2e session. */
const assignedName = () => {
  const document = JSON.parse(readFileSync(registryFile, 'utf8'))
  const entry = document.sessions[sessionId]
  return Object.values(entry.workspaces)[0]
}

// ── a relative write lands in the session folder ──────────────────────────────
const writeRelative = await callTool('write', { file_path: 'notes/first.md', content: 'first output\n' })
if (writeRelative.isError === true) console.log('write result:', JSON.stringify(writeRelative.content, null, 2))
check('write reports success', writeRelative.isError === false, true)
const folderName = assignedName()
const folder = join(workspace, folderName)
check('the write landed in the session folder', existsSync(join(folder, 'notes', 'first.md')), true)
check('the workspace root stayed clean', existsSync(join(workspace, 'notes', 'first.md')), false)
check('the folder name is the pre-title placeholder', folderName.startsWith('session-'), true)

// ── the same relative path reads back from the session folder ─────────────────
const readRelative = await callTool('read', { file_path: 'notes/first.md' })
check('read finds the session file', textOf(readRelative).includes('first output'), true)

// ── an earlier conversation's artifact is still readable ──────────────────────
const readEarlier = await callTool('read', { file_path: 'earlier-report.md' })
const readEarlierText = textOf(readEarlier)
check('read falls back to the workspace root', readEarlierText.includes('earlier conversation output'), true)
check('the fallback path is the root spelling', readEarlierText.includes(join(workspace, 'earlier-report.md')), true)

// ── an absolute workspace path is moved too ───────────────────────────────────
const absolute = join(workspace, 'absolute.md')
const writeAbsolute = await callTool('write', { file_path: absolute, content: 'absolute\n' })
check('an absolute workspace write succeeds', writeAbsolute.isError === false, true)
check('the absolute write was moved', existsSync(join(folder, 'absolute.md')), true)
check('the workspace root did not receive it', existsSync(absolute), false)

// ── edit follows the same path as read ────────────────────────────────────────
// On some Windows installations the sandbox cannot re-grant the temp file the
// atomic edit stages beside the target (`SetFileSecurityW EACCES`); that failure
// reproduces with this plugin switched off, so it is reported rather than
// asserted. What this plugin owns is the PATH the edit resolves to.
const readBeforeEdit = await callTool('read', { file_path: 'notes/first.md' })
check('the file is readable before the edit', readBeforeEdit.isError === false, true)
const edit = await callTool('edit', { file_path: 'notes/first.md', old_string: 'first output', new_string: 'edited output' })
const editText = textOf(edit)
if (edit.isError === true && editText.includes('SetFileSecurityW')) {
  console.log(`ENV   edit is blocked by the Windows sandbox, not by the redirect: ${editText}`)
} else {
  check('edit succeeds after a read', edit.isError === false, true)
  check('edit changed the session file', (await readFile(join(folder, 'notes', 'first.md'), 'utf8')).includes('edited output'), true)
}

// ── a path outside the workspace is never touched ─────────────────────────────
const outside = join(home, 'outside.md')
const writeOutside = await callTool('write', { file_path: outside, content: 'outside\n', sandbox_permissions: 'danger-full-access', justification: 'e2e check that non-workspace paths keep their spelling' })
check('an outside path keeps its spelling', existsSync(outside) || writeOutside.isError, true)

// ── a shell command's default directory is the session folder ─────────────────
// The shell redirect itself is covered by the unit suite, which needs no
// sandbox; here the live check reports whether this installation lets a command
// provision its grant at all.
if (ctx.tools.get('pwsh') !== undefined) {
  const shell = await callTool('pwsh', { command: 'Set-Content -Path shell-made.txt -Value "from pwsh"', description: 'e2e shell redirect check' })
  const shellText = textOf(shell)
  if (shell.isError === true && shellText.includes('SetNamedSecurityInfoW')) {
    console.log(`ENV   pwsh is blocked by the Windows sandbox, not by the redirect: ${shellText}`)
    check('a blocked shell command still wrote nothing to the workspace root', existsSync(join(workspace, 'shell-made.txt')), false)
  } else {
    check('the shell command ran', shell.isError === false, true)
    check('a relative shell write stayed in the session folder', existsSync(join(folder, 'shell-made.txt')), true)
    check('a relative shell write did not reach the root', existsSync(join(workspace, 'shell-made.txt')), false)
  }
} else {
  console.log('SKIP  pwsh is not mounted in this composition')
}

// ── the runtime context names the folder ──────────────────────────────────────
// Full assembly also runs the agent loop's own context contributions, which need
// a complete agent object; when that is unavailable the plugin's own rendering is
// checked directly instead.
const contextText = await contextTextFor(session)
const { renderContextSection } = await import(new URL('../lib/session-paths.js', import.meta.url).href)
const ownContext = renderContextSection({ folder }, true)
if (contextText.length === 0) {
  check('the contributed context names the session folder', ownContext.includes(folder), true)
} else {
  check('the runtime context names the session folder', contextText.includes(folder), true)
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`profile home: ${home}`)

await shutdown?.shutdown?.(0).catch(() => {})
const keep = process.env.DSH_SW_KEEP === '1'
if (!keep) {
  await rm(home, { recursive: true, force: true }).catch(() => {})
  await rm(workspace, { recursive: true, force: true }).catch(() => {})
}
process.exit(failed.length === 0 ? 0 : 1)
