import assert from 'node:assert/strict'
import test from 'node:test'
import { compileStructuredMessage } from '../src/structured-message.ts'

test('structured messages compile nested plural and select controls to portable ICU', () => {
  const result = compileStructuredMessage({
    nodes: [
      { type: 'text', value: 'Hello ' },
      { type: 'argument', name: 'name' },
      { type: 'text', value: ', ' },
      {
        type: 'plural',
        argument: 'count',
        variants: {
          one: { nodes: [{ type: 'text', value: 'one item' }] },
          other: { nodes: [{ type: 'pound' }, { type: 'text', value: ' items' }] },
        },
      },
    ],
  })
  assert.equal(result.value, 'Hello {name}, {count, plural, one {one item} other {# items}}')
  assert.deepEqual(result.contract, { arguments: { count: 'number', name: 'string' }, tags: [] })
})

test('structured messages escape literal ICU control characters', () => {
  const result = compileStructuredMessage({
    nodes: [{ type: 'text', value: "You've saved {money}" }],
  })
  assert.deepEqual(result.contract, { arguments: {}, tags: [] })
})

test('structured messages require other and reject pound outside a plural', () => {
  assert.throws(
    () =>
      compileStructuredMessage({
        nodes: [{ type: 'select', argument: 'gender', variants: {} }],
      }),
    /require an other variant/,
  )
  assert.throws(() => compileStructuredMessage({ nodes: [{ type: 'pound' }] }), /inside plural/)
})
