import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type {
  ExchangeEntry,
  ExchangeStatus,
  ExchangeTranslation,
} from './localization-exchange.types.js'

type OrderedNode = Record<string, unknown>

const exchangeStatuses = new Set<ExchangeStatus>([
  'machine_translated',
  'translated',
  'in_review',
  'approved',
  'rejected',
])
const keyPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/
const maximumXmlNodes = 100_000
const maximumXmlDepth = 256

export function parseXliff(input: {
  content: string
  locale?: string
  sourceLocale?: string
}): ExchangeTranslation[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(input.content)) {
    throw new Error('XLIFF document declarations and custom entities are not allowed')
  }
  const validation = XMLValidator.validate(input.content)
  if (validation !== true)
    throw new Error(`The selected file is not valid XLIFF: ${validation.err.msg}`)
  let document: OrderedNode[]
  try {
    document = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      attributeNamePrefix: '',
      trimValues: false,
      parseTagValue: false,
      parseAttributeValue: false,
      processEntities: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
    }).parse(input.content) as OrderedNode[]
  } catch {
    throw new Error('The selected file is not valid XLIFF')
  }
  assertXmlComplexity(document)
  const root = elements(document, 'xliff')[0]
  if (!root) throw new Error('XLIFF root element is missing')
  const version = attribute(root, 'version')
  if (version === '2.0' || version === '2.1') {
    assertNamespace(root, 'urn:oasis:names:tc:xliff:document:2.0')
    return parseXliff2(root, input.locale, input.sourceLocale)
  }
  if (version === '1.2') {
    assertNamespace(root, 'urn:oasis:names:tc:xliff:document:1.2')
    return parseXliff12(root, input.locale, input.sourceLocale)
  }
  throw new Error(`Unsupported XLIFF version "${version ?? 'unknown'}"`)
}

export function serializeXliff(input: {
  locale: string
  sourceLocale: string
  entries: ExchangeEntry[]
}): string {
  const units = [...input.entries]
    .sort((left, right) => left.key.localeCompare(right.key))
    .flatMap((entry) => {
      const target = entry.values[input.locale]
      if (target === undefined) return []
      const notes = [
        entry.description
          ? `        <note category="description">${xml(entry.description)}</note>`
          : undefined,
        entry.context ? `        <note category="context">${xml(entry.context)}</note>` : undefined,
      ].filter(Boolean)
      const status = xliffState(entry.statuses?.[input.locale])
      return [
        `    <unit id="${xml(entry.key)}" name="${xml(entry.key)}"${entry.characterLimit ? ` slr:sizeRestriction="${entry.characterLimit}"` : ''}>`,
        ...(notes.length ? ['      <notes>', ...notes, '      </notes>'] : []),
        `      <segment state="${status.state}" subState="linguaflow:${status.subState}">`,
        `        <source>${xml(entry.values[input.sourceLocale] ?? entry.key)}</source>`,
        `        <target>${xml(target)}</target>`,
        '      </segment>',
        '    </unit>',
      ]
    })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" xmlns:slr="urn:oasis:names:tc:xliff:sizerestriction:2.0" version="2.1" srcLang="${xml(input.sourceLocale)}" trgLang="${xml(input.locale)}">`,
    '  <file id="linguaflow">',
    ...units,
    '  </file>',
    '</xliff>',
    '',
  ].join('\n')
}

function parseXliff2(
  root: OrderedNode,
  requestedLocale?: string,
  sourceLocale?: string,
): ExchangeTranslation[] {
  const embeddedSourceLocale = requiredEmbeddedLocale(attribute(root, 'srcLang'), 'source')
  const embeddedTargetLocale = normalizedLocale(attribute(root, 'trgLang'))
  if (descendants(root, 'target').length && !embeddedTargetLocale) {
    throw new Error('XLIFF target locale is missing')
  }
  assertSourceLocale(sourceLocale, embeddedSourceLocale, 'XLIFF')
  const locale = resolveDocumentLocale(requestedLocale, embeddedTargetLocale, 'XLIFF')
  return descendants(root, 'unit').flatMap((unit) => {
    if (attribute(unit, 'translate') === 'no') return []
    const key = validKey(attribute(unit, 'name') ?? attribute(unit, 'id'), 'XLIFF unit')
    const notes = elements(childNodes(unit), 'notes').flatMap((node) =>
      elements(childNodes(node), 'note'),
    )
    const metadata = xliffNotes(notes)
    const limit = positiveAttribute(
      attribute(unit, 'slr:sizeRestriction') ?? attribute(unit, 'sizeRestriction'),
    )
    const originalData = xliffOriginalData(unit)
    const segments = childNodes(unit).filter((node) =>
      ['segment', 'ignorable'].includes(nodeName(node) ?? ''),
    )
    const values = segments.flatMap((segment) => {
      const target = elements(childNodes(segment), 'target')[0]
      if (!target) return []
      const value = inlineContent(target, originalData)
      return value ? [value] : []
    })
    if (!values.length) return []
    return [
      {
        key,
        locale,
        value: values.join(''),
        status: leastAdvancedStatus(
          segments.map((segment) =>
            xliffStatus(attribute(segment, 'state'), attribute(segment, 'subState')),
          ),
        ),
        description: metadata.description,
        context: metadata.context,
        characterLimit: limit,
      },
    ]
  })
}

function parseXliff12(
  root: OrderedNode,
  requestedLocale?: string,
  sourceLocale?: string,
): ExchangeTranslation[] {
  const files = descendants(root, 'file')
  return files.flatMap((file) => {
    const embeddedSourceLocale = requiredEmbeddedLocale(
      attribute(file, 'source-language'),
      'source',
    )
    const embeddedTargetLocale = normalizedLocale(attribute(file, 'target-language'))
    if (descendants(file, 'target').length && !embeddedTargetLocale) {
      throw new Error('XLIFF target locale is missing')
    }
    assertSourceLocale(sourceLocale, embeddedSourceLocale, 'XLIFF')
    const locale = resolveDocumentLocale(requestedLocale, embeddedTargetLocale, 'XLIFF')
    return descendants(file, 'trans-unit').flatMap((unit) => {
      if (attribute(unit, 'translate') === 'no') return []
      const key = validKey(attribute(unit, 'resname') ?? attribute(unit, 'id'), 'XLIFF trans-unit')
      const target = elements(childNodes(unit), 'target')[0]
      if (!target) return []
      const value = inlineContent(target)
      if (!value) return []
      const notes = elements(childNodes(unit), 'note')
      const metadata = xliffNotes(notes)
      return [
        {
          key,
          locale,
          value,
          status:
            attribute(unit, 'approved') === 'yes'
              ? 'approved'
              : xliffStatus(attribute(target, 'state'), attribute(target, 'state-qualifier')),
          description: metadata.description,
          context: metadata.context,
          characterLimit: positiveAttribute(attribute(unit, 'characterLimit')),
        },
      ]
    })
  })
}

function inlineContent(
  element: OrderedNode,
  originalData: Map<string, string> = new Map(),
): string {
  return childNodes(element)
    .map((node) => {
      if (typeof node['#text'] === 'string') return decodeXmlEntities(node['#text'])
      const name = nodeName(node)
      if (!name) return ''
      const equivalent = attribute(node, 'equiv') ?? attribute(node, 'equiv-text')
      if (equivalent) return equivalent
      if (name === 'pc') {
        const start =
          attribute(node, 'equivStart') ?? originalData.get(attribute(node, 'dataRefStart') ?? '')
        const end =
          attribute(node, 'equivEnd') ?? originalData.get(attribute(node, 'dataRefEnd') ?? '')
        if (!start || !end) throw new Error('XLIFF paired code is missing equivalent content')
        return `${start}${inlineContent(node, originalData)}${end}`
      }
      if (
        name === 'ph' ||
        name === 'x' ||
        name === 'bx' ||
        name === 'ex' ||
        name === 'sc' ||
        name === 'ec'
      ) {
        const data =
          originalData.get(attribute(node, 'dataRef') ?? '') ??
          originalData.get(attribute(node, 'dataRefStart') ?? '')
        const content = inlineContent(node, originalData)
        if (!data && !content)
          throw new Error(`XLIFF inline code "${name}" is missing equivalent content`)
        return data ?? content
      }
      if (name === 'bpt' || name === 'ept' || name === 'it') {
        const content = inlineContent(node, originalData)
        if (!content) throw new Error(`XLIFF inline code "${name}" is empty`)
        return content
      }
      if (name === 'mrk' || name === 'sm' || name === 'em' || name === 'sub') {
        return inlineContent(node, originalData)
      }
      if (name === 'g') {
        throw new Error('XLIFF g inline codes require equiv-text for lossless import')
      }
      return inlineContent(node, originalData)
    })
    .join('')
}

function xliffOriginalData(unit: OrderedNode): Map<string, string> {
  const result = new Map<string, string>()
  for (const container of elements(childNodes(unit), 'originalData')) {
    for (const data of elements(childNodes(container), 'data')) {
      const id = attribute(data, 'id')
      if (id) result.set(id, inlineContent(data))
    }
  }
  return result
}

function elements(nodes: OrderedNode[], name: string): OrderedNode[] {
  return nodes.filter((node) => nodeName(node) === name)
}

function descendants(node: OrderedNode, name: string): OrderedNode[] {
  const result: OrderedNode[] = []
  const pending = [...childNodes(node)].reverse()
  while (pending.length) {
    const child = pending.pop()!
    if (nodeName(child) === name) result.push(child)
    pending.push(...[...childNodes(child)].reverse())
  }
  return result
}

function childNodes(node: OrderedNode): OrderedNode[] {
  for (const [key, value] of Object.entries(node)) {
    if (key !== ':@' && Array.isArray(value)) return value as OrderedNode[]
  }
  return []
}

function attribute(node: OrderedNode, name: string): string | undefined {
  const attributes = node[':@']
  if (!attributes || typeof attributes !== 'object') return undefined
  const entries = Object.entries(attributes as Record<string, unknown>)
  const value = entries.find(([key]) => key === name || key.endsWith(`:${name}`))?.[1]
  return typeof value === 'string' ? decodeXmlEntities(value) : undefined
}

function assertNamespace(root: OrderedNode, expected: string): void {
  const attributes = root[':@']
  const namespaces =
    attributes && typeof attributes === 'object'
      ? Object.entries(attributes as Record<string, unknown>)
          .filter(([name]) => name === 'xmlns' || name.startsWith('xmlns:'))
          .map(([, value]) => value)
      : []
  if (!namespaces.includes(expected)) throw new Error(`XLIFF namespace must be "${expected}"`)
}

function nodeName(node: OrderedNode): string | undefined {
  const name = Object.keys(node).find((key) => key !== ':@' && key !== '#text')
  return name?.split(':').at(-1)
}

function assertXmlComplexity(document: OrderedNode[]): void {
  const pending = document.map((node) => ({ node, depth: 1 }))
  let count = 0
  while (pending.length) {
    const { node, depth } = pending.pop()!
    count += 1
    if (count > maximumXmlNodes || depth > maximumXmlDepth) {
      throw new Error('XLIFF document is too complex')
    }
    for (const child of childNodes(node)) pending.push({ node: child, depth: depth + 1 })
  }
}

function xliffNotes(notes: OrderedNode[]): { description?: string; context?: string } {
  const values = notes.map((note) => ({
    category: attribute(note, 'category'),
    value: inlineContent(note),
  }))
  return {
    description:
      values.find(({ category }) => category === 'description')?.value ??
      values.find(({ category }) => category !== 'context')?.value,
    context: values.find(({ category }) => category === 'context')?.value,
  }
}

function xliffStatus(state?: string, subState?: string): ExchangeStatus | undefined {
  const custom = subState?.replace(/^(?:linguaflow|x-linguaflow):/, '')
  if (custom && exchangeStatuses.has(custom as ExchangeStatus)) return custom as ExchangeStatus
  if (state === 'final' || state === 'signed-off') return 'approved'
  if (state === 'reviewed' || state === 'needs-review-translation') return 'in_review'
  if (state === 'translated') return 'translated'
  if (state === 'rejected') return 'rejected'
  return undefined
}

function leastAdvancedStatus(
  statuses: Array<ExchangeStatus | undefined>,
): ExchangeStatus | undefined {
  const order: ExchangeStatus[] = [
    'rejected',
    'machine_translated',
    'translated',
    'in_review',
    'approved',
  ]
  return statuses
    .filter((status): status is ExchangeStatus => Boolean(status))
    .sort((left, right) => order.indexOf(left) - order.indexOf(right))[0]
}

function xliffState(status?: string): { state: string; subState: string } {
  if (status === 'approved') return { state: 'final', subState: 'approved' }
  if (status === 'in_review') return { state: 'reviewed', subState: 'in_review' }
  return {
    state: 'translated',
    subState: exchangeStatuses.has(status as ExchangeStatus) ? status! : 'translated',
  }
}

function resolveDocumentLocale(
  requested: string | undefined,
  embedded: string | undefined,
  format: string,
): string {
  const normalizedRequested = normalizedLocale(requested)
  if (
    normalizedRequested &&
    embedded &&
    normalizedRequested.toLowerCase() !== embedded.toLowerCase()
  ) {
    throw new Error(`${format} locale "${embedded}" does not match requested locale "${requested}"`)
  }
  const locale = normalizedRequested ?? embedded
  if (!locale) throw new Error(`A target locale is required for ${format}`)
  return locale
}

function assertSourceLocale(
  expected: string | undefined,
  embedded: string | undefined,
  format: string,
): void {
  if (
    expected &&
    embedded &&
    normalizedLocale(expected)?.toLowerCase() !== embedded.toLowerCase()
  ) {
    throw new Error(
      `${format} source locale "${embedded}" does not match project source locale "${expected}"`,
    )
  }
}

function normalizedLocale(value?: string): string | undefined {
  return value?.trim().replaceAll('_', '-') || undefined
}

function requiredEmbeddedLocale(value: string | undefined, role: 'source' | 'target'): string {
  const locale = normalizedLocale(value)
  if (!locale) throw new Error(`XLIFF ${role} locale is missing`)
  return locale
}

function validKey(value: string | undefined, subject: string): string {
  if (!value || !keyPattern.test(value)) throw new Error(`${subject} has an invalid LinguaFlow key`)
  return value
}

function positiveAttribute(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`Invalid XLIFF character limit "${value}"`)
  return parsed
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g,
    (entity, name: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
      }
      if (named[name]) return named[name]
      const codePoint = Number.parseInt(
        name.slice(name[1] === 'x' ? 2 : 1),
        name[1] === 'x' ? 16 : 10,
      )
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        throw new Error(`Invalid XML character entity "${entity}"`)
      }
    },
  )
}
