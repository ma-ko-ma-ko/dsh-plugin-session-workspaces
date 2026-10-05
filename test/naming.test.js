import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MAX_NAME_BYTES,
  disambiguate,
  fallbackStem,
  sanitizeFolderName,
  truncateUtf8,
} from '../lib/naming.js'

test('sanitizeFolderName keeps an ordinary title', () => {
  assert.equal(sanitizeFolderName('山东物理原题解析'), '山东物理原题解析')
  assert.equal(sanitizeFolderName('Sprite pipeline v2'), 'Sprite pipeline v2')
})

test('sanitizeFolderName removes every forbidden character', () => {
  assert.equal(sanitizeFolderName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j')
  assert.equal(sanitizeFolderName('tab\tand\nnewline'), 'tab and newline')
})

test('sanitizeFolderName strips trailing dots and spaces', () => {
  assert.equal(sanitizeFolderName('report... '), 'report')
  assert.equal(sanitizeFolderName('  spaced  '), 'spaced')
})

test('sanitizeFolderName falls back for an unusable title', () => {
  assert.equal(sanitizeFolderName('   '), 'session')
  assert.equal(sanitizeFolderName('...'), 'session')
  assert.equal(sanitizeFolderName(undefined), 'session')
  assert.equal(sanitizeFolderName('///'), 'session')
  assert.equal(sanitizeFolderName('', { fallback: 'session-abc12345' }), 'session-abc12345')
})

test('sanitizeFolderName avoids Windows reserved device names', () => {
  assert.equal(sanitizeFolderName('con'), 'con_')
  assert.equal(sanitizeFolderName('LPT1'), 'LPT1_')
  assert.equal(sanitizeFolderName('console'), 'console')
})

test('sanitizeFolderName truncates to a byte budget without splitting a code point', () => {
  const name = sanitizeFolderName('物理试卷'.repeat(20), { maxBytes: 12 })
  assert.ok(Buffer.byteLength(name, 'utf8') <= 12)
  assert.equal(name, '物理试卷')
})

test('truncateUtf8 never splits a multi-byte code point', () => {
  assert.equal(truncateUtf8('ab', 100), 'ab')
  assert.equal(truncateUtf8('鲸鱼', 3), '鲸')
  assert.equal(truncateUtf8('鲸鱼', 0), '')
})

test('disambiguate numbers only the alternatives', () => {
  assert.equal(disambiguate('report', 1), 'report')
  assert.equal(disambiguate('report', 2), 'report (2)')
})

test('fallbackStem keeps a recognizable tail of the session id', () => {
  assert.equal(fallbackStem('session-47174a23-8c1a-4e0a-af48-533b86771e28'), 'session-86771e28')
  assert.equal(fallbackStem(undefined), 'session')
  assert.equal(fallbackStem(''), 'session')
})

test('the default budget is the documented one', () => {
  assert.equal(DEFAULT_MAX_NAME_BYTES, 64)
})
