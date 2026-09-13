import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeIcuMessage,
  compileStructuredMessage,
  pseudoLocalizeIcu,
  pseudoLocalizeStructuredMessage,
  validateTranslations,
} from '../src/index.js'

test('extracts a contract from nested ICU messages', () => {
  assert.deepEqual(
    analyzeIcuMessage(
      '{gender, select, female {{count, plural, one {One file} other {# files}}} other {Hello {name}}}',
    ),
    { arguments: { count: 'number', gender: 'select', name: 'string' }, tags: [] },
  )
})

test('reports missing arguments and character limit as publish blockers', () => {
  const issues = validateTranslations({
    sourceLocale: 'en',
    locales: ['en', 'tr'],
    entries: [
      { key: 'home.files', characterLimit: 5, values: { en: '{count} files', tr: 'Dosyalar' } },
    ],
  })
  assert.ok(issues.some(({ code, locale }) => code === 'argument_missing' && locale === 'tr'))
  assert.ok(issues.some(({ code }) => code === 'character_limit'))
  assert.ok(issues.every(({ severity }) => severity === 'blocker'))
})

test('requires the fallback locale for every key', () => {
  const issues = validateTranslations({
    sourceLocale: 'tr',
    fallbackLocale: 'en',
    locales: ['tr', 'en', 'de'],
    entries: [{ key: 'home.title', values: { tr: 'Başlık', de: 'Titel' } }],
  })
  assert.ok(
    issues.some(
      ({ code, locale, severity }) =>
        code === 'fallback_translation_missing' && locale === 'en' && severity === 'blocker',
    ),
  )
})

test('pseudo localization preserves ICU selectors and variables', () => {
  const output = pseudoLocalizeIcu('{count, plural, one {One file} other {# files for {name}}}')
  assert.match(output, /\{count,plural,/)
  assert.match(output, /\{name\}/)
  assert.doesNotThrow(() => analyzeIcuMessage(output))
})

test('structured pseudo localization preserves visual-editor control blocks', () => {
  const message = pseudoLocalizeStructuredMessage({
    nodes: [
      { type: 'text', value: 'Hello ' },
      { type: 'argument', name: 'name' },
      {
        type: 'plural',
        argument: 'count',
        variants: {
          one: { nodes: [{ type: 'text', value: 'one file' }] },
          other: { nodes: [{ type: 'pound' }, { type: 'text', value: ' files' }] },
        },
      },
    ],
  })
  const compiled = compileStructuredMessage(message)
  assert.match(compiled.value, /^［Ħëľľô/)
  assert.match(compiled.value, /\{name\}/)
  assert.match(compiled.value, /one \{ôñë ƒïľë/)
  assert.match(compiled.value, /other \{# ƒïľëš/)
  assert.deepEqual(compiled.contract.arguments, { count: 'number', name: 'string' })
})

test('rejects ICU styles not portable to the current Flutter runtime', () => {
  assert.throws(() => analyzeIcuMessage('Total: {price, number}'), /not supported/)
  assert.throws(
    () => analyzeIcuMessage('{position, selectordinal, one {#st} other {#th}}'),
    /selectordinal/,
  )
})
