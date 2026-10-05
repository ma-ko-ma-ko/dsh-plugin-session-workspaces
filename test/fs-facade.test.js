import assert from 'node:assert/strict'
import test from 'node:test'
import { join, resolve } from 'node:path'
import { attachFsRedirect } from '../lib/fs-facade.js'

/**
 * Build a filesystem fixture: one fake service and one attached redirect.
 * @param {object} [options] - fixture options.
 * @returns {object} the fixture.
 */
function fixture(options = {}) {
  const calls = []
  const existing = new Set(options.existing ?? [])
  const fs = {
    async resolve(path, opts) {
      calls.push({ kind: 'resolve', path, opts })
      return { targetKey: `key:${resolve(opts?.cwd ?? options.workspace ?? '.', path)}`, displayPath: path }
    },
    async lstat(path) {
      return existing.has(path) ? { type: 'file', size: 1, version: 'v1' } : undefined
    },
  }
  const sessionPaths = {
    async peekFor() {
      const folder = typeof options.folder === 'function' ? options.folder() : options.folder
      return folder === undefined ? undefined : { folder, workspace: options.workspace }
    },
  }
  const redirect = attachFsRedirect({ fs, sessionPaths, readFallback: options.readFallback !== false })
  return { fs, redirect, calls }
}

/**
 * A session stand-in.
 * @param {string} cwd - the workspace root.
 * @returns {object} the session.
 */
function session(cwd) {
  return { id: 'session-1', header: { id: 'session-1', cwd } }
}

test('a mutation resolves into the session folder', async () => {
  const workspace = resolve('ws')
  const folder = join(workspace, 'Report')
  const sut = fixture({ workspace, folder })
  sut.redirect.noteSession(session(workspace), 'write')

  await sut.fs.resolve('notes/a.md', { workspaceRoot: workspace })
  assert.equal(sut.calls.at(-1).path, join(folder, 'notes', 'a.md'))
})

test('a mutation that names an absolute workspace path also moves', async () => {
  const workspace = resolve('ws')
  const folder = join(workspace, 'Report')
  const sut = fixture({ workspace, folder })
  sut.redirect.noteSession(session(workspace), 'edit')

  await sut.fs.resolve(join(workspace, 'a.md'), { workspaceRoot: workspace })
  assert.equal(sut.calls.at(-1).path, join(folder, 'a.md'))
})

test('a mutation moves even when its resolution carries only the session cwd', async () => {
  const workspace = resolve('ws')
  const folder = join(workspace, 'Report')
  const sut = fixture({ workspace, folder })
  sut.redirect.noteSession(session(workspace), 'write')

  await sut.fs.resolve('a.md', { cwd: workspace })
  assert.equal(sut.calls.at(-1).path, join(folder, 'a.md'))
})

test('a read follows the session file when it exists there', async () => {
  const workspace = resolve('ws')
  const folder = join(workspace, 'Report')
  const moved = join(folder, 'a.md')
  const sut = fixture({ workspace, folder, existing: [moved] })
  sut.redirect.noteSession(session(workspace), 'read')

  await sut.fs.resolve('a.md', { cwd: workspace })
  assert.equal(sut.calls.at(-1).path, moved)
})

test('a read falls back to the workspace root when the folder has no such file', async () => {
  const workspace = resolve('ws')
  const folder = join(workspace, 'Report')
  const sut = fixture({ workspace, folder })
  sut.redirect.noteSession(session(workspace), 'read')

  await sut.fs.resolve('试卷.pdf', { cwd: workspace })
  assert.equal(sut.calls.at(-1).path, '试卷.pdf')
})

test('a read never falls back when readFallback is disabled', async () => {
  const workspace = resolve('ws')
  const folder = join(workspace, 'Report')
  const sut = fixture({ workspace, folder, readFallback: false })
  sut.redirect.noteSession(session(workspace), 'read')

  await sut.fs.resolve('试卷.pdf', { cwd: workspace })
  assert.equal(sut.calls.at(-1).path, join(folder, '试卷.pdf'))
})

test('a path already inside the folder and a path outside the workspace are untouched', async () => {
  const workspace = resolve('ws')
  const folder = join(workspace, 'Report')
  const outside = resolve('elsewhere', 'x.txt')
  const sut = fixture({ workspace, folder })
  sut.redirect.noteSession(session(workspace), 'write')

  await sut.fs.resolve(join(folder, 'a.md'), { workspaceRoot: workspace })
  assert.equal(sut.calls.at(-1).path, join(folder, 'a.md'))

  await sut.fs.resolve(outside, { workspaceRoot: workspace })
  assert.equal(sut.calls.at(-1).path, outside)
})

test('an unregistered workspace keeps the raw resolution', async () => {
  const workspace = resolve('ws')
  const folder = join(workspace, 'Report')
  const sut = fixture({ workspace, folder })

  await sut.fs.resolve('a.md', { cwd: workspace })
  assert.equal(sut.calls.at(-1).path, 'a.md')
})

test('a workspace whose session has no folder yet keeps the raw resolution', async () => {
  const workspace = resolve('ws')
  const sut = fixture({ workspace })
  sut.redirect.noteSession(session(workspace), 'write')

  await sut.fs.resolve('a.md', { cwd: workspace })
  assert.equal(sut.calls.at(-1).path, 'a.md')
})

test('the redirect is installed on the shared service, so every holder sees it', async () => {
  const workspace = resolve('ws')
  const folder = join(workspace, 'Report')
  const sut = fixture({ workspace, folder })
  const holder = sut.fs
  sut.redirect.noteSession(session(workspace), 'write')

  await holder.resolve('a.md', { workspaceRoot: workspace })
  assert.equal(sut.calls.at(-1).path, join(folder, 'a.md'))
})

test('every resolution re-reads the session folder, so a rename never nests a path', async () => {
  const workspace = resolve('ws')
  let folder = join(workspace, 'Report')
  let peeks = 0
  const fs = { async resolve(path) { return { targetKey: path, displayPath: path } }, async lstat() { return undefined } }
  const redirect = attachFsRedirect({
    fs,
    sessionPaths: {
      async peekFor() {
        peeks += 1
        return { folder, workspace }
      },
    },
    readFallback: true,
  })
  const root = session(workspace)
  // A write, because a mutation always moves into the folder.
  redirect.noteSession(root, 'write')

  const resolved = async (path) => (await fs.resolve(path, { workspaceRoot: workspace })).displayPath
  assert.equal(await resolved('a.md'), join(folder, 'a.md'))

  const renamed = join(workspace, '报告整理')
  folder = renamed
  assert.equal(await resolved('b.md'), join(renamed, 'b.md'))
  // A path that already names the new session folder must never be nested again.
  assert.equal(await resolved(join(renamed, 'c.md')), join(renamed, 'c.md'))
  // The renamed folder is read on every call, not remembered from the first one.
  assert.ok(peeks >= 3)
})