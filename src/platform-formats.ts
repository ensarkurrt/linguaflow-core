import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  ExchangeEntry,
  ExchangeStatus,
  ExchangeTranslation,
} from './localization-exchange.types.js'
import { flattenLocalizationTree } from './localization-tree.js'

type RecordValue = Record<string, unknown>

export function parseYamlDocument(content: string, locale: string): ExchangeTranslation[] {
  let document: unknown
  try {
    document = parseYaml(content, { version: '1.2', maxAliasCount: 0 })
  } catch {
    throw new Error('The selected file is not valid YAML 1.2')
  }
  if (!isRecord(document)) throw new Error('Localization YAML must contain a map at its root')
  return Object.entries(flattenLocalizationTree(document, 'YAML')).map(([key, value]) => ({
    key,
    locale,
    value,
  }))
}

export function serializeYamlDocument(entries: ExchangeEntry[], locale: string): string {
  return stringifyYaml(nested(entries, locale), { version: '1.2', lineWidth: 0 })
}

export function parseAndroidXml(content: string, locale: string): ExchangeTranslation[] {
  assertSafeXml(content, 'Android XML')
  const document = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    parseTagValue: false,
    trimValues: false,
    alwaysCreateTextNode: true,
  }).parse(content) as RecordValue
  const root = document.resources
  if (!isRecord(root)) throw new Error('Android XML must contain a resources root element')
  const values =
    root.string === undefined ? [] : Array.isArray(root.string) ? root.string : [root.string]
  return values.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate['@_name'] !== 'string') {
      throw new Error('Every Android string requires a name attribute')
    }
    const text = candidate['#text']
    if (typeof text !== 'string') throw new Error('Android string values cannot contain child tags')
    return { key: decodeAndroidKey(candidate['@_name']), locale, value: decodeXmlText(text) }
  })
}

export function serializeAndroidXml(entries: ExchangeEntry[], locale: string): string {
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<resources>']
  for (const entry of sorted(entries)) {
    const value = entry.values[locale]
    if (value !== undefined) {
      lines.push(`  <string name="${encodeAndroidKey(entry.key)}">${xml(value)}</string>`)
    }
  }
  return `${lines.concat('</resources>').join('\n')}\n`
}

export function parseAppleStrings(content: string, locale: string): ExchangeTranslation[] {
  const translations: ExchangeTranslation[] = []
  const reader = new AppleStringsReader(content)
  while (!reader.done()) {
    const key = reader.string()
    reader.symbol('=')
    const value = reader.string()
    reader.symbol(';')
    translations.push({ key, locale, value })
  }
  return translations
}

export function serializeAppleStrings(entries: ExchangeEntry[], locale: string): string {
  return `${sorted(entries)
    .flatMap((entry) => {
      const value = entry.values[locale]
      if (value === undefined) return []
      const note = [entry.description, entry.context].filter(Boolean).join(' · ')
      return [
        ...(note ? [`/* ${note.replaceAll('*/', '* /')} */`] : []),
        `"${appleString(entry.key)}" = "${appleString(value)}";`,
        '',
      ]
    })
    .join('\n')}`
}

export function parseStringCatalog(
  content: string,
  allowedLocales: string[],
): ExchangeTranslation[] {
  let document: unknown
  try {
    document = JSON.parse(content)
  } catch {
    throw new Error('The selected file is not valid String Catalog JSON')
  }
  if (!isRecord(document) || document.version !== '1.0' || !isRecord(document.strings)) {
    throw new Error('String Catalog must use version 1.0 and contain a strings object')
  }
  const allowed = new Set(allowedLocales)
  return Object.entries(document.strings).flatMap(([key, definition]) => {
    if (!isRecord(definition) || !isRecord(definition.localizations)) return []
    return Object.entries(definition.localizations).map(([locale, localization]) => {
      if (!allowed.has(locale))
        throw new Error(`Locale "${locale}" is not enabled for this project`)
      if (!isRecord(localization) || !isRecord(localization.stringUnit)) {
        throw new Error(`String Catalog value for "${key}/${locale}" is invalid`)
      }
      const value = localization.stringUnit.value
      if (typeof value !== 'string')
        throw new Error(`String Catalog value for "${key}/${locale}" is invalid`)
      return {
        key,
        locale,
        value,
        status: catalogStatus(localization.stringUnit.state),
        description: typeof definition.comment === 'string' ? definition.comment : undefined,
      }
    })
  })
}

export function serializeStringCatalog(
  entries: ExchangeEntry[],
  locales: string[],
  sourceLocale: string,
): string {
  const strings = Object.fromEntries(
    sorted(entries).map((entry) => [
      entry.key,
      {
        ...(entry.description ? { comment: entry.description } : {}),
        extractionState: 'manual',
        localizations: Object.fromEntries(
          locales.flatMap((locale) => {
            const value = entry.values[locale]
            return value === undefined
              ? []
              : [[locale, { stringUnit: { state: catalogState(entry.statuses?.[locale]), value } }]]
          }),
        ),
      },
    ]),
  )
  return `${JSON.stringify({ sourceLanguage: sourceLocale, strings, version: '1.0' }, null, 2)}\n`
}

function assertSafeXml(content: string, format: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error(`${format} cannot contain a DOCTYPE`)
  const validation = XMLValidator.validate(content)
  if (validation !== true) throw new Error(`${format} is not well-formed XML`)
}

function encodeAndroidKey(key: string): string {
  return key.replaceAll('_', '_u').replaceAll('.', '__')
}

function decodeAndroidKey(key: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`Invalid Android resource name "${key}"`)
  return key.replaceAll('__', '.').replaceAll('_u', '_')
}

function appleString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
}

function decodeAppleString(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|[\\"nrt])/g, (escape) => {
    if (escape === '\\n') return '\n'
    if (escape === '\\r') return '\r'
    if (escape === '\\t') return '\t'
    if (escape.startsWith('\\u')) return String.fromCharCode(Number.parseInt(escape.slice(2), 16))
    return escape.slice(1)
  })
}

function catalogStatus(value: unknown): ExchangeStatus | undefined {
  if (value === 'translated') return 'translated'
  if (value === 'needs_review') return 'in_review'
  if (value === 'stale') return 'rejected'
  return undefined
}

function catalogState(status: string | undefined): string {
  if (status === 'in_review') return 'needs_review'
  if (status === 'rejected' || status === 'source_changed') return 'stale'
  return 'translated'
}

function nested(entries: ExchangeEntry[], locale: string): RecordValue {
  const root: RecordValue = Object.create(null) as RecordValue
  for (const entry of sorted(entries)) {
    const value = entry.values[locale]
    if (value === undefined) continue
    const segments = entry.key.split('.')
    let cursor = root
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        if (isRecord(cursor[segment])) {
          throw new Error(`YAML key "${entry.key}" conflicts with a parent key`)
        }
        cursor[segment] = value
      } else {
        if (typeof cursor[segment] === 'string') {
          throw new Error(`YAML key "${entry.key}" conflicts with a value key`)
        }
        if (!isRecord(cursor[segment])) cursor[segment] = Object.create(null) as RecordValue
        cursor = cursor[segment] as RecordValue
      }
    })
  }
  return root
}

function sorted(entries: ExchangeEntry[]): ExchangeEntry[] {
  return [...entries].sort((left, right) => left.key.localeCompare(right.key))
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(#(?:x[0-9a-fA-F]+|[0-9]+)|amp|lt|gt|quot|apos);/g,
    (_, entity: string) => {
      if (entity === 'amp') return '&'
      if (entity === 'lt') return '<'
      if (entity === 'gt') return '>'
      if (entity === 'quot') return '"'
      if (entity === 'apos') return "'"
      const codePoint = entity.startsWith('#x')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new Error('Android XML contains an invalid character reference')
      }
      return String.fromCodePoint(codePoint)
    },
  )
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class AppleStringsReader {
  private index = 0

  constructor(private readonly source: string) {}

  done(): boolean {
    this.skipTrivia()
    return this.index === this.source.length
  }

  string(): string {
    this.skipTrivia()
    if (this.source[this.index] !== '"') this.invalid()
    this.index += 1
    let encoded = ''
    while (this.index < this.source.length) {
      const character = this.source[this.index++]!
      if (character === '"') return decodeAppleString(encoded)
      if (character === '\n' || character === '\r') this.invalid()
      if (character !== '\\') {
        encoded += character
        continue
      }
      if (this.index >= this.source.length) this.invalid()
      const escaped = this.source[this.index++]!
      encoded += `\\${escaped}`
      if (escaped === 'u') {
        const digits = this.source.slice(this.index, this.index + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.invalid()
        encoded += digits
        this.index += 4
      } else if (!'\\"nrt'.includes(escaped)) {
        this.invalid()
      }
    }
    return this.invalid()
  }

  symbol(expected: '=' | ';'): void {
    this.skipTrivia()
    if (this.source[this.index] !== expected) this.invalid()
    this.index += 1
  }

  private skipTrivia(): void {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index]!)) {
        this.index += 1
        continue
      }
      if (this.source.startsWith('/*', this.index)) {
        const end = this.source.indexOf('*/', this.index + 2)
        if (end < 0) this.invalid()
        this.index = end + 2
        continue
      }
      if (this.source.startsWith('//', this.index)) {
        const end = this.source.indexOf('\n', this.index + 2)
        this.index = end < 0 ? this.source.length : end + 1
        continue
      }
      break
    }
  }

  private invalid(): never {
    throw new Error(`The selected file is not valid Apple Strings syntax near offset ${this.index}`)
  }
}
