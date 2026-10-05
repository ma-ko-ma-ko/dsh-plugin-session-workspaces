import assert from 'node:assert/strict'
import test from 'node:test'
import { join, resolve } from 'node:path'
import { classifyPath, containsPath, folderPathFor, isWorkspaceRoot, normalizePath } from '../lib/paths.js'

// The suite runs on the host, so the fixtures use host path semantics while the
// assertions stay true on both Windows and POSIX.
const workspace = resolve('work', 'ws')
const folder = join(workspace, 'Report')
const outside = resolve('elsewhere', 'scratch')

test('containsPath is segment-anchored', () => {
  assert.equal(containsPath(workspace, join(workspace, 'a', 'b')), true)
  assert.equal(containsPath(workspace, workspace), true)
  assert.equal(containsPath(workspace, `${workspace}2`), false)
  assert.equal(containsPath(workspace, resolve('work')), false)
})

test('normalizePath drops trailing separators and normalizes separators', () => {
  assert.equal(normalizePath(`${workspace}/`), normalizePath(workspace))
  assert.equal(normalizePath(join(workspace, 'a', '')), normalizePath(join(workspace, 'a')))
})

test('classifyPath separates the three cases', () => {
  assert.equal(classifyPath({ path: 'a.md', workspace, folder }), 'workspace-output')
  assert.equal(classifyPath({ path: join(workspace, 'a.md'), workspace, folder }), 'workspace-output')
  assert.equal(classifyPath({ path: join(folder, 'a.md'), workspace, folder }), 'inside-folder')
  assert.equal(classifyPath({ path: outside, workspace, folder }), 'outside-workspace')
})

test('folderPathFor preserves the tail and the identity cases', () => {
  assert.equal(folderPathFor({ path: join('sub', 'a.md'), workspace, folder }), join(folder, 'sub', 'a.md'))
  assert.equal(folderPathFor({ path: join(workspace, 'a.md'), workspace, folder }), join(folder, 'a.md'))
  assert.equal(folderPathFor({ path: folder, workspace, folder }), folder)
  assert.equal(folderPathFor({ path: outside, workspace, folder }), outside)
})

test('isWorkspaceRoot matches only the bare root', () => {
  assert.equal(isWorkspaceRoot({ workdir: workspace, workspace }), true)
  assert.equal(isWorkspaceRoot({ workdir: join(workspace, 'sub'), workspace }), false)
  assert.equal(isWorkspaceRoot({ workdir: undefined, workspace }), false)
  assert.equal(isWorkspaceRoot({ workdir: '', workspace }), false)
})
