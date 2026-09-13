import assert from 'node:assert/strict'
import test from 'node:test'
import { compileStructuredMessage, parseStructuredMessage } from '../src/structured-message.ts'

test('portable ICU messages round-trip through visual editor blocks', () => {
  const icu =
    'Hello {name}, you have {count, plural, =0 {no messages} one {# message} other {# messages}}.'
  const structured = parseStructuredMessage(icu)
  assert.equal(compileStructuredMessage(structured).value, icu)
})

test('unsupported ICU formatters cannot enter visual editor documents', () => {
  assert.throws(() => parseStructuredMessage('{createdAt, date}'), /not supported/)
})
