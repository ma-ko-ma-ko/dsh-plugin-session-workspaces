import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { applyConfig, resolveHome, resolveRegistryFile } from '../lib/config.js'
import { CONTEXT_NAME, apply, inject, name } from '../lib/index.js'

test('the plugin declares the services it needs and a stable name', () => {
  assert.equal(name, 'session-workspaces')
  assert.deepEqual(inject, ['tools', 'fs', 'systemPrompt'])
  assert.equal(CONTEXT_NAME, 'session-workspaces:output-folder')
})

test('the default configuration enables every redirect', () => {
  const config = applyConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.readFallback, true)
  assert.equal(config.shellWorkdir, true)
  assert.equal(config.prompt, true)
  assert.equal(config.promptOrder, 111)
  assert.equal(config.maxNameBytes, 64)
})

test('an explicit false survives, while null and undefined take the default', () => {
  const config = applyConfig({ enabled: false, readFallback: false, shellWorkdir: null, prompt: undefined })
  assert.equal(config.enabled, false)
  assert.equal(config.readFallback, false)
  assert.equal(config.shellWorkdir, true)
  assert.equal(config.prompt, true)
})

test('an unknown or ill-typed field is rejected by name', () => {
  assert.throws(() => applyConfig({ nope: 1 }), /unknown config field "nope"/u)
  assert.throws(() => applyConfig({ enabled: 'yes' }), /config\.enabled must be a boolean/u)
  assert.throws(() => applyConfig({ maxNameBytes: 0 }), /config\.maxNameBytes must be a positive number/u)
  assert.throws(() => applyConfig([]), /config must be an object/u)
})

test('harness-owned entry keys are tolerated', () => {
  const config = applyConfig({ id: 'session-workspaces', name: 'dsh-plugin-session-workspaces', disabled: false })
  assert.equal(config.enabled, true)
})

test('the harness home follows the same precedence as the harness itself', () => {
  assert.equal(resolveHome(undefined, { DSH_HOME: 'C:\\dsh-home' }), resolve('C:\\dsh-home'))
  assert.equal(resolveHome('D:\\other', { DSH_HOME: 'C:\\dsh-home' }), resolve('D:\\other'))
  assert.equal(resolveHome(undefined, { DSH_HOME: '   ' }).endsWith('.dsh'), true)
})

test('the registry document is absolute and anchored to the profile when relative', () => {
  const fromHome = resolveRegistryFile(applyConfig(undefined), { dshHome: 'C:\\dsh-home', env: {} })
  assert.equal(fromHome, resolve('C:\\dsh-home', 'session-workspaces.json'))

  const fromProfile = resolveRegistryFile(applyConfig({ file: './assignments.json' }), {
    baseUrl: new URL('file:///C:/dsh-home/profiles/desktop/'),
  })
  assert.equal(fromProfile, resolve('C:/dsh-home/profiles/desktop/assignments.json'))

  const absolute = resolveRegistryFile(applyConfig({ file: 'C:\\explicit\\a.json' }))
  assert.equal(absolute, resolve('C:\\explicit\\a.json'))
})

test('apply() is a no-op when the plugin is disabled', () => {
  let touched = false
  const ctx = {
    logger: { warn() {} },
    get() {
      touched = true
      return undefined
    },
    effect() {
      touched = true
    },
    on() {
      touched = true
    },
  }
  apply(ctx, applyConfig({ enabled: false }))
  assert.equal(touched, false)
})
