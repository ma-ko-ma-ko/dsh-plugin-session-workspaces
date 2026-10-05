import assert from 'node:assert/strict'
import test from 'node:test'
import { join, resolve } from 'node:path'
import { attachShellRedirect } from '../lib/shell-facade.js'

/**
 * Build a shell fixture.
 * @param {object} [options] - fixture options.
 * @returns {Promise<object>} the fixture.
 */
async function fixture(options = {}) {
  const workspace = options.workspace ?? resolve('ws')
  const folder = options.folder ?? join(workspace, 'Report')
  const shell = {
    resolve(request) {
      return { command: request.command, workdir: request.workdir ?? workspace }
    },
    async execute(spec) {
      return spec
    },
  }
  const redirect = attachShellRedirect({
    shell,
    sessionPaths: {
      async ensureFor() {
        return options.missing === true ? undefined : { folder, workspace }
      },
    },
  })
  return { shell, redirect, workspace, folder }
}

/**
 * A session stand-in.
 * @param {string} cwd - the workspace root.
 * @returns {object} the session.
 */
function session(cwd) {
  return { id: 'session-1', header: { id: 'session-1', cwd } }
}

test('a command defaulted to the workspace root runs in the session folder', async () => {
  const sut = await fixture()
  await sut.redirect.noteSession(session(sut.workspace))

  const spec = sut.shell.resolve({ command: 'python build.py' })
  assert.equal(spec.workdir, sut.folder)
  assert.equal(spec.command, 'python build.py')
})

test('an explicit workdir inside the workspace is honored', async () => {
  const sut = await fixture()
  await sut.redirect.noteSession(session(sut.workspace))

  const sub = join(sut.workspace, 'project')
  assert.equal(sut.shell.resolve({ command: 'x', workdir: sub }).workdir, sub)
})

test('a workdir outside the workspace is honored', async () => {
  const sut = await fixture()
  await sut.redirect.noteSession(session(sut.workspace))

  const outside = resolve('elsewhere')
  assert.equal(sut.shell.resolve({ command: 'x', workdir: outside }).workdir, outside)
})

test('a command from an unregistered session is untouched', async () => {
  const sut = await fixture()
  assert.equal(sut.shell.resolve({ command: 'x' }).workdir, sut.workspace)
})

test('a session without a folder leaves the command untouched', async () => {
  const sut = await fixture({ missing: true })
  await sut.redirect.noteSession(session(sut.workspace))
  assert.equal(sut.shell.resolve({ command: 'x' }).workdir, sut.workspace)
})

test('the executor keeps its own methods', async () => {
  const sut = await fixture()
  await sut.redirect.noteSession(session(sut.workspace))
  const resolved = sut.shell.resolve({ command: 'x' })
  assert.deepEqual(await sut.shell.execute(resolved), resolved)
})
