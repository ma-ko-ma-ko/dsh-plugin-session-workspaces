import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FolderRegistry, workspaceKey } from '../lib/registry.js'

/**
 * Create a registry backed by a fresh temporary document.
 * @returns {Promise<{registry: FolderRegistry, file: string, warnings: string[]}>} the fixture.
 */
async function freshRegistry() {
  const directory = await mkdtemp(join(tmpdir(), 'session-workspaces-'))
  const file = join(directory, 'registry.json')
  const warnings = []
  return { registry: new FolderRegistry(file, (message) => warnings.push(message)), file, warnings }
}

const workspace = resolve('work', 'ws')

test('a first resolution allocates the folder derived from the title', async () => {
  const { registry } = await freshRegistry()
  const result = await registry.resolve({
    sessionId: 'session-1',
    workspace,
    title: '报告整理',
    titleIsReal: true,
    now: 1,
  })
  assert.equal(result.name, '报告整理')
  assert.equal(result.created, true)
})

test('a repeated resolution is stable and creates nothing', async () => {
  const { registry } = await freshRegistry()
  const first = await registry.resolve({ sessionId: 'session-1', workspace, title: 'Report', titleIsReal: true, now: 1 })
  const second = await registry.resolve({ sessionId: 'session-1', workspace, title: 'Report', titleIsReal: true, now: 2 })
  assert.equal(first.name, 'Report')
  assert.equal(second.name, 'Report')
  assert.equal(second.created, false)
})

test('the assignment survives a reload from disk', async () => {
  const { registry, file } = await freshRegistry()
  await registry.resolve({ sessionId: 'session-1', workspace, title: 'Report', titleIsReal: true, now: 1 })

  const reloaded = new FolderRegistry(file, () => {})
  const result = await reloaded.resolve({ sessionId: 'session-1', workspace, title: 'Report', titleIsReal: true, now: 9 })
  assert.equal(result.name, 'Report')
  assert.equal(result.created, false)
})

test('two sessions with the same title are never given the same folder', async () => {
  const { registry } = await freshRegistry()
  const first = await registry.resolve({ sessionId: 'session-1', workspace, title: 'Report', titleIsReal: true, now: 1 })
  const second = await registry.resolve({ sessionId: 'session-2', workspace, title: 'Report', titleIsReal: true, now: 1 })
  const third = await registry.resolve({ sessionId: 'session-3', workspace, title: 'Report', titleIsReal: true, now: 1 })
  assert.deepEqual([first.name, second.name, third.name], ['Report', 'Report (2)', 'Report (3)'])
})

test('a provisional name is replaced once the real title exists', async () => {
  const { registry } = await freshRegistry()
  const provisional = await registry.resolve({
    sessionId: 'session-abc12345',
    workspace,
    title: undefined,
    titleIsReal: false,
    now: 1,
  })
  assert.equal(provisional.name, 'session-abc12345')

  const migrated = await registry.resolve({
    sessionId: 'session-abc12345',
    workspace,
    title: '山东卷解析',
    titleIsReal: true,
    now: 2,
  })
  assert.equal(migrated.name, '山东卷解析')
  assert.equal(migrated.migratedFrom, 'session-abc12345')
})

test('a final name is never migrated, even when the title is rewritten', async () => {
  const { registry } = await freshRegistry()
  await registry.resolve({ sessionId: 'session-1', workspace, title: 'First title', titleIsReal: true, now: 1 })
  const later = await registry.resolve({ sessionId: 'session-1', workspace, title: 'Second title', titleIsReal: true, now: 2 })
  assert.equal(later.name, 'First title')
})

test('a migration keeps an old name protected from other sessions', async () => {
  const { registry } = await freshRegistry()
  await registry.resolve({ sessionId: 'session-a', workspace, title: undefined, titleIsReal: false, now: 1 })
  await registry.resolve({ sessionId: 'session-a', workspace, title: 'Report', titleIsReal: true, now: 2 })
  // A different session that later acquires the vacated provisional name must
  // not be handed the folder session-a used to own.
  const other = await registry.resolve({
    sessionId: 'session-b',
    workspace,
    title: 'session-a',
    titleIsReal: true,
    now: 3,
  })
  assert.notEqual(other.name, 'session-a')
})

test('folders are tracked per workspace', async () => {
  const { registry } = await freshRegistry()
  const other = resolve('work', 'other')
  const first = await registry.resolve({ sessionId: 'session-1', workspace, title: '报告', titleIsReal: true, now: 1 })
  const second = await registry.resolve({ sessionId: 'session-1', workspace: other, title: '报告', titleIsReal: true, now: 1 })
  assert.equal(first.name, '报告')
  assert.equal(second.name, '报告')
})

test('workspace keys ignore trailing separators and case', () => {
  assert.equal(workspaceKey(`${workspace}/`), workspaceKey(workspace))
  assert.equal(workspaceKey(workspace.toUpperCase()), workspaceKey(workspace))
})

test('a malformed document is reported once and then treated as empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'session-workspaces-'))
  const file = join(directory, 'registry.json')
  await writeFile(file, '{ not json', 'utf8')
  const warnings = []
  const registry = new FolderRegistry(file, (message) => warnings.push(message))
  const result = await registry.resolve({ sessionId: 'session-1', workspace, title: 'Report', titleIsReal: true, now: 1 })
  assert.equal(result.name, 'Report')
  assert.equal(warnings.length, 1)
})

test('the persisted document is a readable assignment table', async () => {
  const { registry, file } = await freshRegistry()
  await registry.resolve({ sessionId: 'session-1', workspace, title: '报告', titleIsReal: true, now: 5 })
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(document.version, 1)
  assert.equal(document.sessions['session-1'].workspaces[workspaceKey(workspace)], '报告')
})
