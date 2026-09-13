import assert from 'node:assert/strict'
import test from 'node:test'
import { icuContractsEqual, materializeOverlays } from '../src/index.js'

test('materializes multi-layer overlays without mutating base translations', () => {
  const base = { 'home.title': { en: 'Welcome', tr: 'Hoş geldiniz' } }
  const resolved = materializeOverlays(base, [
    {
      id: 'brand',
      slug: 'acme',
      parentId: null,
      values: { 'home.title': { en: 'Welcome to Acme' } },
    },
    {
      id: 'tenant',
      slug: 'acme-eu',
      parentId: 'brand',
      values: { 'home.title': { tr: "Acme'ye hoş geldiniz" } },
    },
  ])
  assert.deepEqual(resolved[1]?.snapshot, {
    'home.title': { en: 'Welcome to Acme', tr: "Acme'ye hoş geldiniz" },
  })
  assert.equal(base['home.title'].en, 'Welcome')
})

test('rejects invalid overlay graphs', () => {
  assert.throws(
    () =>
      materializeOverlays({}, [
        { id: 'a', slug: 'a', parentId: 'b', values: {} },
        { id: 'b', slug: 'b', parentId: 'a', values: {} },
      ]),
    /cycle/,
  )
})

test('ICU contract equality is semantic and independent from JSON field order', () => {
  assert.equal(
    icuContractsEqual(
      { arguments: { name: 'string', count: 'number' }, tags: ['strong', 'link'] },
      { tags: ['link', 'strong'], arguments: { count: 'number', name: 'string' } },
    ),
    true,
  )
  assert.equal(
    icuContractsEqual(
      { arguments: { count: 'number' }, tags: [] },
      { arguments: { count: 'string' }, tags: [] },
    ),
    false,
  )
})
