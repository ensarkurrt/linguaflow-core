import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  parseLocalizationDocument,
  serializeLocalizationDocument,
  type LocalizationDocumentEntry,
  type LocalizationFormat,
} from '../src/index.ts'

const singleLocaleFormats: LocalizationFormat[] = [
  'nested_json',
  'flat_json',
  'arb',
  'po',
  'xliff',
  'yaml',
  'android_xml',
  'apple_strings',
]

test('seeded localization corpus round-trips every supported format', () => {
  const random = mulberry32(0x1f10ca1e)
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const entries = generatedEntries(random, 1 + Math.floor(random() * 12))
    for (const format of singleLocaleFormats) {
      const document = serializeLocalizationDocument({
        format,
        locale: 'en',
        sourceLocale: 'en',
        locales: ['en', 'tr'],
        entries,
      })
      const parsed = parseLocalizationDocument({
        format,
        content: document.content,
        locale: 'en',
        sourceLocale: 'en',
        allowedLocales: ['en', 'tr'],
      })
      assert.deepEqual(
        sortedValues(parsed.map(({ key, value }) => ({ key, value }))),
        sortedValues(entries.map(({ key, values }) => ({ key, value: values.en! }))),
        `${format} failed at seed iteration ${iteration}`,
      )
    }

    for (const format of ['csv', 'string_catalog'] as const) {
      const document = serializeLocalizationDocument({
        format,
        sourceLocale: 'en',
        locales: ['en', 'tr'],
        entries,
      })
      const parsed = parseLocalizationDocument({
        format,
        content: document.content,
        sourceLocale: 'en',
        allowedLocales: ['en', 'tr'],
      })
      assert.equal(parsed.length, entries.length * 2)
    }
  }
})

test('security regression corpus rejects entity, alias, pollution and truncation payloads', async () => {
  const fixtures = new URL('./fixtures/security/', import.meta.url)
  const cases: Array<{ file: string; format: LocalizationFormat }> = [
    { file: 'yaml-alias-expansion.yaml', format: 'yaml' },
    { file: 'xml-external-entity.xml', format: 'android_xml' },
    { file: 'prototype-pollution.json', format: 'nested_json' },
    { file: 'apple-unclosed-comment.strings', format: 'apple_strings' },
  ]
  for (const fixture of cases) {
    const content = await readFile(new URL(fixture.file, fixtures), 'utf8')
    assert.throws(
      () =>
        parseLocalizationDocument({
          format: fixture.format,
          content,
          locale: 'en',
          sourceLocale: 'en',
          allowedLocales: ['en'],
        }),
      undefined,
      fixture.file,
    )
  }
})

function generatedEntries(random: () => number, count: number): LocalizationDocumentEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const key = `group_${index}.value_${Math.floor(random() * 1_000_000)}`
    const value = generatedValue(random, index)
    return { key, values: { en: value, tr: `tr-${value}` } }
  })
}

function generatedValue(random: () => number, index: number): string {
  const fragments = [
    'alpha',
    'space value',
    'quote "',
    "apostrophe '",
    'line\nbreak',
    'ışık',
    '日本語',
  ]
  return `${fragments[Math.floor(random() * fragments.length)]}-${index}-${Math.floor(random() * 1_000)}`
}

function sortedValues(values: Array<{ key: string; value: string }>) {
  return [...values].sort((left, right) => left.key.localeCompare(right.key))
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}
