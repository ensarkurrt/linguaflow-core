import gettextParser from 'gettext-parser'
import type {
  ExchangeEntry,
  ExchangeStatus,
  ExchangeTranslation,
} from './localization-exchange.types.js'

type PoTranslation = {
  msgctxt?: string
  msgid: string
  msgid_plural?: string
  msgstr: string[]
  comments?: Record<'translator' | 'reference' | 'extracted' | 'flag' | 'previous', string>
}

const exchangeStatuses = new Set<ExchangeStatus>([
  'machine_translated',
  'translated',
  'in_review',
  'approved',
  'rejected',
])
const keyPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/

export function parsePo(input: {
  content: string
  locale?: string
  sourceLocale?: string
}): ExchangeTranslation[] {
  let catalog: ReturnType<typeof gettextParser.po.parse>
  try {
    catalog = gettextParser.po.parse(input.content)
  } catch {
    throw new Error('The selected file is not valid GNU PO')
  }
  const headerLocale = normalizedLocale(catalog.headers.Language)
  const locale = resolveDocumentLocale(input.locale, headerLocale)
  assertSourceLocale(
    input.sourceLocale,
    normalizedLocale(catalog.headers['X-LinguaFlow-Source-Language']),
  )
  const translations: ExchangeTranslation[] = []
  for (const context of Object.values(catalog.translations)) {
    for (const candidate of Object.values(context) as PoTranslation[]) {
      if (!candidate.msgid) continue
      const key = poKey(candidate)
      const values = candidate.msgstr.filter((value) => value !== '')
      if (!values.length) continue
      const extracted = commentLines(candidate.comments?.extracted)
      translations.push({
        key,
        locale,
        value:
          candidate.msgid_plural && candidate.msgstr.length > 1
            ? gettextPluralToIcu(candidate.msgstr, locale)
            : candidate.msgstr[0]!,
        status: statusFromTokens(commentTokens(candidate.comments?.flag, ',')),
        description: plainExtractedComment(extracted),
        context: prefixedComment(extracted, 'LinguaFlow-Context:'),
        characterLimit: positiveIntegerComment(extracted, 'LinguaFlow-Character-Limit:'),
      })
    }
  }
  return translations
}

export function serializePo(input: {
  locale: string
  sourceLocale: string
  entries: ExchangeEntry[]
}): string {
  const translations: Record<string, Record<string, PoTranslation>> = { '': {} }
  for (const entry of [...input.entries].sort((left, right) => left.key.localeCompare(right.key))) {
    const target = entry.values[input.locale]
    if (target === undefined) continue
    const source = entry.values[input.sourceLocale] ?? entry.key
    const extracted = [
      entry.description,
      entry.context ? `LinguaFlow-Context: ${singleLine(entry.context)}` : undefined,
      entry.characterLimit ? `LinguaFlow-Character-Limit: ${entry.characterLimit}` : undefined,
    ].filter((value): value is string => Boolean(value))
    translations[entry.key] = {
      [source]: {
        msgctxt: entry.key,
        msgid: source,
        msgstr: [target],
        comments: {
          translator: '',
          extracted: extracted.join('\n'),
          reference: `linguaflow:${entry.key}`,
          flag: ['icu-message-format', statusFlag(entry.statuses?.[input.locale])]
            .filter(Boolean)
            .join(', '),
          previous: '',
        },
      },
    }
  }
  return gettextParser.po
    .compile({
      charset: 'utf-8',
      headers: {
        'Project-Id-Version': 'LinguaFlow',
        'Content-Type': 'text/plain; charset=UTF-8',
        'Content-Transfer-Encoding': '8bit',
        Language: input.locale,
        'X-LinguaFlow-Source-Language': input.sourceLocale,
        'Plural-Forms': gettextPluralHeader(input.locale),
      },
      translations,
    })
    .toString('utf8')
}

function poKey(translation: PoTranslation): string {
  if (translation.msgctxt && keyPattern.test(translation.msgctxt)) return translation.msgctxt
  const reference = commentTokens(translation.comments?.reference, /\s+/)
    .map((value) => value.replace(/^linguaflow:/, ''))
    .find((value) => keyPattern.test(value))
  if (reference) return reference
  if (keyPattern.test(translation.msgid)) return translation.msgid
  throw new Error(`PO entry "${translation.msgid.slice(0, 80)}" has no LinguaFlow key in msgctxt`)
}

function gettextPluralToIcu(values: string[], locale: string): string {
  const categories = gettextCategories(locale, values.length)
  const branches = values.map(
    (value, index) => `${categories[index] ?? `=${index}`} {${poPluralBranch(value)}}`,
  )
  if (!categories.includes('other')) branches.push(`other {${poPluralBranch(values.at(-1)!)}}`)
  return `{count, plural, ${branches.join(' ')}}`
}

function poPluralBranch(value: string): string {
  const count = '\u0000LINGUAFLOW_COUNT\u0000'
  return value
    .replace(/%(?:\d+\$)?d/g, count)
    .replaceAll("'", "''")
    .replaceAll('{', "'{'")
    .replaceAll('}', "'}'")
    .replaceAll('#', "'#'")
    .replaceAll(count, '#')
}

function gettextCategories(locale: string, count: number): string[] {
  const language = locale.toLowerCase().split(/[-_]/)[0]
  const known: Record<string, string[]> = {
    ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
    be: ['one', 'few', 'many'],
    bs: ['one', 'few', 'other'],
    cs: ['one', 'few', 'other'],
    cy: ['zero', 'one', 'two', 'few', 'many', 'other'],
    ga: ['one', 'two', 'few', 'many', 'other'],
    gd: ['one', 'two', 'few', 'other'],
    he: ['one', 'two', 'many', 'other'],
    hr: ['one', 'few', 'other'],
    lt: ['one', 'few', 'other'],
    lv: ['zero', 'one', 'other'],
    mt: ['one', 'few', 'many', 'other'],
    pl: ['one', 'few', 'many'],
    ro: ['one', 'few', 'other'],
    ru: ['one', 'few', 'many'],
    sr: ['one', 'few', 'other'],
    sk: ['one', 'few', 'other'],
    sl: ['one', 'two', 'few', 'other'],
    uk: ['one', 'few', 'many'],
  }
  if (count === 1) return ['other']
  if (count === 2) return ['one', 'other']
  const categories = known[language ?? '']
  if (!categories || categories.length !== count) {
    throw new Error(
      `GNU PO plural mapping for locale "${locale}" with ${count} forms is not supported`,
    )
  }
  return categories
}

function gettextPluralHeader(locale: string): string {
  const language = locale.toLowerCase().split(/[-_]/)[0]
  const headers: Record<string, string> = {
    ar: 'nplurals=6; plural=(n==0?0:n==1?1:n==2?2:n%100>=3&&n%100<=10?3:n%100>=11&&n%100<=99?4:5);',
    fr: 'nplurals=2; plural=(n > 1);',
    ja: 'nplurals=1; plural=0;',
    ko: 'nplurals=1; plural=0;',
    pl: 'nplurals=3; plural=(n==1?0:n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?1:2);',
    ru: 'nplurals=3; plural=(n%10==1&&n%100!=11?0:n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?1:2);',
    tr: 'nplurals=1; plural=0;',
    uk: 'nplurals=3; plural=(n%10==1&&n%100!=11?0:n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?1:2);',
    zh: 'nplurals=1; plural=0;',
  }
  return headers[language ?? ''] ?? 'nplurals=2; plural=(n != 1);'
}

function statusFlag(status?: string): string | undefined {
  return exchangeStatuses.has(status as ExchangeStatus) ? `linguaflow-status-${status}` : undefined
}

function statusFromTokens(tokens: string[]): ExchangeStatus | undefined {
  const status = tokens.find((value) => value.startsWith('linguaflow-status-'))?.slice(18)
  if (status && exchangeStatuses.has(status as ExchangeStatus)) return status as ExchangeStatus
  return tokens.includes('fuzzy') ? 'in_review' : undefined
}

function resolveDocumentLocale(requested?: string, embedded?: string): string {
  const normalizedRequested = normalizedLocale(requested)
  if (
    normalizedRequested &&
    embedded &&
    normalizedRequested.toLowerCase() !== embedded.toLowerCase()
  ) {
    throw new Error(`PO locale "${embedded}" does not match requested locale "${requested}"`)
  }
  const locale = normalizedRequested ?? embedded
  if (!locale) throw new Error('A target locale is required for PO')
  return locale
}

function assertSourceLocale(expected?: string, embedded?: string): void {
  if (
    expected &&
    embedded &&
    normalizedLocale(expected)?.toLowerCase() !== embedded.toLowerCase()
  ) {
    throw new Error(
      `PO source locale "${embedded}" does not match project source locale "${expected}"`,
    )
  }
}

function normalizedLocale(value?: string): string | undefined {
  return value?.trim().replaceAll('_', '-') || undefined
}

function commentLines(value?: string): string[] {
  return (
    value
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean) ?? []
  )
}

function commentTokens(value: string | undefined, separator: string | RegExp): string[] {
  return (
    value
      ?.split(separator)
      .map((token) => token.trim())
      .filter(Boolean) ?? []
  )
}

function prefixedComment(lines: string[], prefix: string): string | undefined {
  return (
    lines
      .find((line) => line.startsWith(prefix))
      ?.slice(prefix.length)
      .trim() || undefined
  )
}

function positiveIntegerComment(lines: string[], prefix: string): number | undefined {
  const value = prefixedComment(lines, prefix)
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`Invalid PO character limit "${value}"`)
  return parsed
}

function plainExtractedComment(lines: string[]): string | undefined {
  return lines.filter((line) => !line.startsWith('LinguaFlow-')).join('\n') || undefined
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
