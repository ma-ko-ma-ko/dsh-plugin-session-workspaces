import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FolderRegistry } from '../lib/registry.js'
import { createSessionPaths, renderContextSection, rootSessionOf, titleOf } from '../lib/session-paths.js'
import { MARKER_FILE_NAME } from '../lib/paths.js'

/**
 * Build a resolver fixture with a fake title service.
 * @param {object} [options] - fixture options.
 * @returns {Promise<object>} the fixture.
 */
async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'session-workspaces-'))
  const registry = new FolderRegistry(join(directory, 'registry.json'), () => {})
  const titles = new Map()
  const state = {
    directory,
    registry,
    titles,
    titleService: options.titleService ?? { get: (session) => titles.get(session.id) },
    sessions: options.sessions ?? { get: () => undefined },
  }
  state.paths = createSessionPaths({
    registry,
    titleService: () => state.titleService,
    sessions: () => state.sessions,
    maxNameBytes: 64,
    warn: () => {},
  })
  return state
}

/**
 * A minimal session stand-in.
 * @param {string} id - the session id.
 * @param {string} cwd - the workspace.
 * @param {string} [parentSession] - an optional parent id.
 * @returns {object} the session.
 */
function session(id, cwd, parentSession) {
  return { id, header: { id, cwd, ...(parentSession === undefined ? {} : { parentSession }) } }
}

test('a titled session resolves to a folder named after the title', async () => {
  const sut = await fixture()
  const workspace = resolve(sut.directory, 'ws')
  const root = session('session-1', workspace)
  sut.titles.set('session-1', { title: '报告整理', source: { kind: 'provider' } })

  const entry = await sut.paths.ensureFor(root)
  assert.equal(entry.name, '报告整理')
  assert.equal(entry.folder, join(workspace, '报告整理'))
  assert.equal((await stat(join(workspace, '报告整理'))).isDirectory(), true)
  const marker = JSON.parse(await readFile(join(workspace, '报告整理', MARKER_FILE_NAME), 'utf8'))
  assert.equal(marker.sessionId, 'session-1')
})

test('a session without a title gets a provisional, recognizable folder', async () => {
  const sut = await fixture()
  const workspace = resolve(sut.directory, 'ws')
  const root = session('session-47174a23-8c1a-4e0a-af48-533b86771e28', workspace)
  const entry = await sut.paths.ensureFor(root)
  assert.equal(entry.name, 'session-86771e28')
})

test('the provisional folder is renamed once the generated title arrives', async () => {
  const sut = await fixture()
  const workspace = resolve(sut.directory, 'ws')
  const root = session('session-47174a23-8c1a-4e0a-af48-533b86771e28', workspace)

  const provisional = await sut.paths.ensureFor(root)
  assert.equal(provisional.name, 'session-86771e28')

  sut.titles.set(root.id, { title: '鲸鱼答卷', source: { kind: 'fallback' } })
  const stillProvisional = await sut.paths.ensureFor(root)
  assert.equal(stillProvisional.name, 'session-86771e28')

  sut.titles.set(root.id, { title: '鲸鱼答卷', source: { kind: 'provider' } })
  const titled = await sut.paths.ensureFor(root)
  assert.equal(titled.name, '鲸鱼答卷')
})

test('peekFor resolves a name without creating the folder', async () => {
  const sut = await fixture()
  const workspace = resolve(sut.directory, 'ws')
  const root = session('session-1', workspace)
  sut.titles.set('session-1', { title: '报告', source: { kind: 'provider' } })

  const entry = await sut.paths.peekFor(root)
  assert.equal(entry.name, '报告')
  await assert.rejects(stat(join(workspace, '报告')))
})

test('a delegated child shares the folder of the session tree it belongs to', async () => {
  const sut = await fixture()
  const workspace = resolve(sut.directory, 'ws')
  const parent = session('session-parent', workspace)
  const child = session('session-child', workspace, 'session-parent')
  sut.titles.set('session-parent', { title: '父会话', source: { kind: 'provider' } })
  sut.sessions = { get: (id) => (id === 'session-parent' ? parent : undefined) }

  const entry = await sut.paths.ensureFor(child)
  assert.equal(entry.name, '父会话')
  assert.equal(entry.folder, join(workspace, '父会话'))
})

test('lastKnown answers synchronously after a resolution', async () => {
  const sut = await fixture()
  const workspace = resolve(sut.directory, 'ws')
  const root = session('session-1', workspace)
  assert.equal(sut.paths.lastKnown(root), undefined)
  const entry = await sut.paths.ensureFor(root)
  assert.equal(sut.paths.lastKnown(root).folder, entry.folder)
})

test('a session without a workspace resolves to nothing', async () => {
  const sut = await fixture()
  assert.equal(await sut.paths.ensureFor({ id: 'session-1', header: {} }), undefined)
})

test('titleOf treats a fallback title as provisional and a provider title as final', () => {
  const target = session('session-1', resolve('ws'))
  assert.deepEqual(titleOf({ get: () => ({ title: 'x', source: { kind: 'fallback' } }) }, target), { title: 'x', provisional: true })
  assert.deepEqual(titleOf({ get: () => ({ title: 'x', source: { kind: 'user' } }) }, target), { title: 'x', provisional: false })
  assert.deepEqual(titleOf(undefined, target), { title: undefined, provisional: true })
})

test('rootSessionOf walks to the top of the tree and survives a broken chain', () => {
  const root = session('root', resolve('ws'))
  const mid = session('mid', resolve('ws'), 'root')
  const leaf = session('leaf', resolve('ws'), 'mid')
  const store = { get: (id) => ({ root, mid })[id] }
  assert.equal(rootSessionOf(leaf, store), root)
  assert.equal(rootSessionOf(session('orphan', resolve('ws'), 'missing'), store).id, 'orphan')
})

test('the context section names the folder and refuses to leak a variable reference', () => {
  const text = renderContextSection({ folder: resolve('ws', 'a{{b') }, true)
  assert.match(text, /Session output folder:/u)
  assert.ok(!text.includes('{{'))
})

test('the context section explains the read fallback and the shell rule only when they apply', () => {
  const folder = resolve('ws', 'Report')
  const withShell = renderContextSection({ folder }, true)
  const withoutShell = renderContextSection({ folder }, false)
  assert.ok(withShell.includes(folder))
  assert.ok(withShell.includes('shell command'))
  assert.ok(withoutShell.includes(folder))
  assert.ok(!withoutShell.includes('shell command'))
})