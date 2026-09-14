import type { ExchangeStatus } from './localization-exchange.types.js'
import { parsePo, serializePo } from './po-format.js'
import { parseXliff, serializeXliff } from './xliff-format.js'
import {
  parseAndroidXml,
  parseAppleStrings,
  parseStringCatalog,
  parseYamlDocument,
  serializeAndroidXml,
  serializeAppleStrings,
  serializeStringCatalog,
  serializeYamlDocument,
} from './platform-formats.js'
import { assertLocalizationDocumentSize, flattenLocalizationTree } from './localization-tree.js'

export const LOCALIZATION_FORMATS = [
  'nested_json',
  'flat_json',
  'arb',
  'csv',
  'po',
  'xliff',
  'yaml',
  'android_xml',
  'apple_strings',
  'string_catalog',
] as const

export type LocalizationFormat = (typeof LOCALIZATION_FORMATS)[number]

export type LocalizationDocumentEntry = {
  key: string
  values: Record<string, string>
  description?: string
  context?: string
  characterLimit?: number | null
  statuses?: Record<string, string>
}

export type ImportedTranslation = {
  key: string
  locale: string
  value: string
  description?: string
  context?: string
  characterLimit?: number | null
  status?: ExchangeStatus
}

export type SerializedLocalizationDocument = {
  content: string
  contentType: string
  extension: string
}

const keyPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/
const unsafeKeySegments = new Set(['__proto__', 'prototype', 'constructor'])
const metadataHeaders = new Set(['key', 'description', 'context', 'characterLimit'])
const maxEntries = 10_000

export class LocalizationFormatError extends Error {
  readonly name = 'LocalizationFormatError'
  readonly code = 'invalid_localization_document'

  constructor(
    readonly operation: 'parse' | 'serialize',
    readonly format: LocalizationFormat,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'Localization document operation failed')
  }
}

export function parseLocalizationDocument(input: {
  format: LocalizationFormat
  content: string
  locale?: string
  sourceLocale?: string
  allowedLocales: string[]
}): ImportedTranslation[] {
  try {
    return parseLocalizationDocumentUnchecked(input)
  } catch (error) {
    if (error instanceof LocalizationFormatError) throw error
    throw new LocalizationFormatError('parse', input.format, error)
  }
}

function parseLocalizationDocumentUnchecked(input: {
  format: LocalizationFormat
  content: string
  locale?: string
  sourceLocale?: string
  allowedLocales: string[]
}): ImportedTranslation[] {
  assertLocalizationDocumentSize(input.content)
  const parsed = parseDocument(input)
  if (parsed.length > maxEntries) throw new Error(`Import cannot exceed ${maxEntries} values`)
  const allowed = new Set(input.allowedLocales)
  const identities = new Set<string>()
  for (const translation of parsed) {
    assertTranslationKey(translation.key)
    if (!allowed.has(translation.locale)) {
      throw new Error(`Locale "${translation.locale}" is not enabled for this project`)
    }
    if (translation.value.length > 20_000) {
      throw new Error(`Value for ${translation.key}/${translation.locale} exceeds 20000 characters`)
    }
    if ((translation.description?.length ?? 0) > 500) {
      throw new Error(`Description for ${translation.key} exceeds 500 characters`)
    }
    if ((translation.context?.length ?? 0) > 2_000) {
      throw new Error(`Context for ${translation.key} exceeds 2000 characters`)
    }
    if ((translation.characterLimit ?? 0) > 20_000) {
      throw new Error(`Character limit for ${translation.key} exceeds 20000`)
    }
    const identity = `${translation.key}\0${translation.locale}`
    if (identities.has(identity)) {
      throw new Error(`Duplicate value for ${translation.key}/${translation.locale}`)
    }
    identities.add(identity)
  }
  return parsed
}

export function serializeLocalizationDocument(input: {
  format: LocalizationFormat
  locale?: string
  sourceLocale?: string
  locales: string[]
  entries: LocalizationDocumentEntry[]
}): SerializedLocalizationDocument {
  try {
    return serializeLocalizationDocumentUnchecked(input)
  } catch (error) {
    if (error instanceof LocalizationFormatError) throw error
    throw new LocalizationFormatError('serialize', input.format, error)
  }
}

function serializeLocalizationDocumentUnchecked(input: {
  format: LocalizationFormat
  locale?: string
  sourceLocale?: string
  locales: string[]
  entries: LocalizationDocumentEntry[]
}): SerializedLocalizationDocument {
  if (input.format === 'csv') {
    return {
      content: serializeCsv(input.entries, input.locales),
      contentType: 'text/csv; charset=utf-8',
      extension: 'csv',
    }
  }
  if (input.format === 'string_catalog') {
    const sourceLocale = input.sourceLocale ?? input.locales[0]
    if (!sourceLocale || !input.locales.includes(sourceLocale)) {
      throw new Error('An enabled source locale is required for this format')
    }
    return {
      content: serializeStringCatalog(input.entries, input.locales, sourceLocale),
      contentType: 'application/json; charset=utf-8',
      extension: 'xcstrings',
    }
  }
  const locale = requiredLocale(input.locale)
  if (!input.locales.includes(locale)) throw new Error(`Locale "${locale}" is not enabled`)
  const sourceLocale = input.sourceLocale ?? input.locales[0]
  if (!sourceLocale || !input.locales.includes(sourceLocale)) {
    throw new Error('An enabled source locale is required for this format')
  }
  if (input.format === 'po') {
    return {
      content: serializePo({ locale, sourceLocale, entries: input.entries }),
      contentType: 'text/x-gettext-translation; charset=utf-8',
      extension: 'po',
    }
  }
  if (input.format === 'xliff') {
    return {
      content: serializeXliff({ locale, sourceLocale, entries: input.entries }),
      contentType: 'application/xliff+xml; charset=utf-8',
      extension: 'xlf',
    }
  }
  if (input.format === 'yaml') {
    return {
      content: serializeYamlDocument(input.entries, locale),
      contentType: 'application/yaml; charset=utf-8',
      extension: 'yaml',
    }
  }
  if (input.format === 'android_xml') {
    return {
      content: serializeAndroidXml(input.entries, locale),
      contentType: 'application/xml; charset=utf-8',
      extension: 'xml',
    }
  }
  if (input.format === 'apple_strings') {
    return {
      content: serializeAppleStrings(input.entries, locale),
      contentType: 'text/plain; charset=utf-8',
      extension: 'strings',
    }
  }
  const content =
    input.format === 'arb'
      ? serializeArb(input.entries, locale)
      : JSON.stringify(
          input.format === 'nested_json'
            ? nestedValues(input.entries, locale)
            : flatValues(input.entries, locale),
          null,
          2,
        )
  return {
    content: `${content}\n`,
    contentType: 'application/json; charset=utf-8',
    extension: input.format === 'arb' ? 'arb' : 'json',
  }
}

function parseDocument(input: {
  format: LocalizationFormat
  content: string
  locale?: string
  sourceLocale?: string
  allowedLocales: string[]
}): ImportedTranslation[] {
  if (input.format === 'csv') return parseCsvDocument(input.content, input.allowedLocales)
  if (input.format === 'po') return parsePo(input)
  if (input.format === 'xliff') return parseXliff(input)
  if (input.format === 'yaml') return parseYamlDocument(input.content, requiredLocale(input.locale))
  if (input.format === 'android_xml')
    return parseAndroidXml(input.content, requiredLocale(input.locale))
  if (input.format === 'apple_strings')
    return parseAppleStrings(input.content, requiredLocale(input.locale))
  if (input.format === 'string_catalog')
    return parseStringCatalog(input.content, input.allowedLocales)
  return parseJsonDocument(input.format, input.content, requiredLocale(input.locale))
}

function parseJsonDocument(
  format: Exclude<
    LocalizationFormat,
    'csv' | 'po' | 'xliff' | 'yaml' | 'android_xml' | 'apple_strings' | 'string_catalog'
  >,
  content: string,
  locale: string,
): ImportedTranslation[] {
  let document: unknown
  try {
    document = JSON.parse(content)
  } catch {
    throw new Error('The selected file is not valid JSON')
  }
  if (!isRecord(document)) throw new Error('Localization JSON must contain an object at its root')
  if (format === 'arb') return parseArb(document, locale)
  const values =
    format === 'nested_json' ? flattenLocalizationTree(document, 'Nested JSON') : document
  return Object.entries(values).map(([key, value]) => {
    if (typeof value !== 'string') throw new Error(`Value for "${key}" must be a string`)
    return { key, locale, value }
  })
}

function parseArb(
  document: Record<string, unknown>,
  fallbackLocale: string,
): ImportedTranslation[] {
  const locale = typeof document['@@locale'] === 'string' ? document['@@locale'] : fallbackLocale
  return Object.entries(document).flatMap(([key, value]) => {
    if (key.startsWith('@')) return []
    if (typeof value !== 'string') throw new Error(`ARB value for "${key}" must be a string`)
    const metadata = document[`@${key}`]
    if (metadata !== undefined && !isRecord(metadata)) {
      throw new Error(`ARB metadata for "${key}" must be an object`)
    }
    const characterLimit = metadata?.['x-linguaflow-character-limit']
    if (
      characterLimit !== undefined &&
      (typeof characterLimit !== 'number' ||
        !Number.isInteger(characterLimit) ||
        characterLimit <= 0)
    ) {
      throw new Error(`ARB character limit for "${key}" must be a positive integer`)
    }
    return [
      {
        key,
        locale,
        value,
        description: stringMetadata(metadata, 'description'),
        context: stringMetadata(metadata, 'x-linguaflow-context'),
        characterLimit: characterLimit as number | undefined,
      },
    ]
  })
}

function parseCsvDocument(content: string, allowedLocales: string[]): ImportedTranslation[] {
  const rows = parseCsv(content)
  if (!rows.length) throw new Error('CSV file is empty')
  const headers = rows[0]!.map((value) => value.trim())
  if (headers[0] !== 'key') throw new Error('CSV must start with a "key" column')
  if (new Set(headers).size !== headers.length) throw new Error('CSV column names must be unique')
  const localeColumns = headers
    .map((header, index) => ({ locale: header, index }))
    .filter(({ locale }) => !metadataHeaders.has(locale))
  if (!localeColumns.length) throw new Error('CSV must include at least one locale column')
  const allowed = new Set(allowedLocales)
  const unknownLocale = localeColumns.find(({ locale }) => !allowed.has(locale))
  if (unknownLocale)
    throw new Error(`Locale "${unknownLocale.locale}" is not enabled for this project`)

  return rows.slice(1).flatMap((row, rowIndex) => {
    if (row.length > headers.length) throw new Error(`CSV row ${rowIndex + 2} has too many columns`)
    const key = row[0]?.trim()
    if (!key && row.every((value) => !value.trim())) return []
    if (!key) throw new Error(`CSV row ${rowIndex + 2} is missing a key`)
    const description = column(row, headers, 'description')
    const context = column(row, headers, 'context')
    const limitText = column(row, headers, 'characterLimit')
    const characterLimit = limitText ? Number(limitText) : undefined
    if (limitText && (!Number.isInteger(characterLimit) || characterLimit! <= 0)) {
      throw new Error(`CSV row ${rowIndex + 2} has an invalid characterLimit`)
    }
    return localeColumns.flatMap(({ locale, index }) => {
      const value = row[index] ?? ''
      return value ? [{ key, locale, value, description, context, characterLimit }] : []
    })
  })
}

function serializeCsv(entries: LocalizationDocumentEntry[], locales: string[]): string {
  const rows = [
    ['key', 'description', 'context', 'characterLimit', ...locales],
    ...[...entries]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => [
        entry.key,
        entry.description ?? '',
        entry.context ?? '',
        entry.characterLimit?.toString() ?? '',
        ...locales.map((locale) => entry.values[locale] ?? ''),
      ]),
  ]
  return `\uFEFF${rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')}\r\n`
}

function serializeArb(entries: LocalizationDocumentEntry[], locale: string): string {
  const document: Record<string, unknown> = { '@@locale': locale }
  for (const entry of [...entries].sort((left, right) => left.key.localeCompare(right.key))) {
    const value = entry.values[locale]
    if (value === undefined) continue
    document[entry.key] = value
    const metadata = Object.fromEntries(
      [
        ['description', entry.description],
        ['x-linguaflow-context', entry.context],
        ['x-linguaflow-character-limit', entry.characterLimit],
      ].filter(
        (pair): pair is [string, string | number] =>
          pair[1] !== undefined && pair[1] !== '' && pair[1] !== null,
      ),
    )
    if (Object.keys(metadata).length) document[`@${entry.key}`] = metadata
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

function flatValues(entries: LocalizationDocumentEntry[], locale: string): Record<string, string> {
  return Object.fromEntries(
    [...entries]
      .sort((left, right) => left.key.localeCompare(right.key))
      .flatMap((entry) =>
        entry.values[locale] === undefined ? [] : [[entry.key, entry.values[locale]!]],
      ),
  )
}

function nestedValues(
  entries: LocalizationDocumentEntry[],
  locale: string,
): Record<string, unknown> {
  const root: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(flatValues(entries, locale))) {
    const segments = key.split('.')
    let cursor = root
    for (const [index, segment] of segments.entries()) {
      if (index === segments.length - 1) {
        if (isRecord(cursor[segment])) {
          throw new Error(`Nested JSON cannot represent both "${key}" and a child key`)
        }
        cursor[segment] = value
      } else {
        if (typeof cursor[segment] === 'string') {
          throw new Error(
            `Nested JSON cannot represent both "${segments.slice(0, index + 1).join('.')}" and "${key}"`,
          )
        }
        if (!isRecord(cursor[segment])) {
          cursor[segment] = Object.create(null) as Record<string, unknown>
        }
        cursor = cursor[segment] as Record<string, unknown>
      }
    }
  }
  return root
}

function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const text = content.replace(/^\uFEFF/, '')
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') quoted = false
      else field += character
    } else if (character === '"' && field === '') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += character
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field')
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((candidate) => candidate.some((value) => value !== ''))
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

function column(row: string[], headers: string[], name: string): string | undefined {
  const index = headers.indexOf(name)
  return index === -1 ? undefined : row[index] || undefined
}

function requiredLocale(locale: string | undefined): string {
  if (!locale) throw new Error('A locale is required for this format')
  return locale
}

function assertTranslationKey(key: string): void {
  if (
    key.length > 180 ||
    !keyPattern.test(key) ||
    key.split('.').some((segment) => unsafeKeySegments.has(segment))
  )
    throw new Error(`Invalid localization key "${key}"`)
}

function stringMetadata(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`ARB metadata "${key}" must be a string`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
